package sidecar

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/engine"
)

// Failure kinds a run reports. Deadlines and aborts are the host's. A memory
// budget hit is a timeout, the kind dsh gives an implementation-owned budget.
const (
	kindException     = "exception"
	kindInvalidOutput = "invalid-output"
	kindOutputLimit   = "output-limit"
	kindTimeout       = "timeout"
	kindProtocol      = "protocol"
	kindWorkerExit    = "worker-exit"
)

var (
	errCancelled    = errors.New("run cancelled")
	errTooManyCalls = errors.New("too many pending binding calls")
	identifier      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

type reply struct {
	id      uint64
	ok      bool
	value   json.RawMessage
	message string
}

type settlers struct {
	resolve, reject func(moejs.Value) error
}

type run struct {
	s          *server
	id         uint64
	program    string
	namespaces []Namespace

	rt        atomic.Pointer[moejs.Runtime]
	cancelled atomic.Bool

	mu     sync.Mutex
	queue  []reply
	notify chan struct{}

	// Owned by the run's goroutine.
	pending             map[uint64]settlers
	bindingErrorClasses map[*engine.Object]Namespace
	nextCall            uint64
	logLeft             int
	logCut              bool
}

func newRun(s *server, id uint64, program string, namespaces []Namespace) *run {
	return &run{
		s: s, id: id, program: program, namespaces: namespaces,
		notify:  make(chan struct{}, 1),
		pending: map[uint64]settlers{},
		// Each entry pays for its JSON string and the "[" or "," before it, so
		// the budget keeps one byte for the closing "]".
		logLeft: s.cfg.MaxLogBytes - 1,
	}
}

// deliver queues a reply for the run's goroutine.
func (r *run) deliver(rep reply) {
	r.mu.Lock()
	r.queue = append(r.queue, rep)
	r.mu.Unlock()
	r.wake()
}

// cancel stops the run at once, even inside an endless loop.
func (r *run) cancel() {
	r.cancelled.Store(true)
	if rt := r.rt.Load(); rt != nil {
		rt.Interrupt(errCancelled)
	}
	r.wake()
}

func (r *run) wake() {
	select {
	case r.notify <- struct{}{}:
	default:
	}
}

// next waits for the next reply. It returns false once the run is cancelled.
func (r *run) next() (reply, bool) {
	for {
		if r.cancelled.Load() {
			return reply{}, false
		}
		r.mu.Lock()
		if len(r.queue) > 0 {
			rep := r.queue[0]
			r.queue = r.queue[1:]
			r.mu.Unlock()
			return rep, true
		}
		r.mu.Unlock()
		<-r.notify
	}
}

// params lists the program's parameters: the namespace globals, then their
// error classes, then console. The names were validated by the host and are
// checked again here, since they become source text.
func (r *run) params() ([]string, error) {
	var globals, classes []string
	for _, ns := range r.namespaces {
		globals = append(globals, ns.Global)
		if ns.ErrorClass != nil {
			classes = append(classes, ns.ErrorClass.Name)
		}
	}
	params := append(append(globals, classes...), "console")
	seen := map[string]bool{}
	for _, p := range params {
		if !identifier.MatchString(p) || seen[p] {
			return nil, fmt.Errorf("binding name %q is not an identifier or appears twice", p)
		}
		seen[p] = true
	}
	return params, nil
}

func (r *run) execute() {
	params, err := r.params()
	if err != nil {
		r.fail(kindProtocol, err.Error())
		return
	}
	// The program starts on the header's line, so its line numbers stay its own.
	header := "export default async function (" + strings.Join(params, ", ") + ") {"
	mod, err := moejs.CompileTS("program.ts", header+r.program+"\n}")
	if err != nil {
		r.fail(kindException, syntaxMessage(err, len(header)))
		return
	}
	if r.cancelled.Load() {
		return
	}
	rt := moejs.NewRuntime(moejs.Options{MemoryLimit: r.s.cfg.MemoryLimitBytes})
	r.rt.Store(rt)
	if r.cancelled.Load() {
		return
	}
	args, err := r.setup(rt)
	if err != nil {
		r.finishError(rt, err)
		return
	}
	// Load starts a new memory budget, so the setup above is not counted.
	if err := rt.Load(mod); err != nil && !errors.Is(err, moejs.ErrModulePending) {
		r.finishError(rt, err)
		return
	}
	hook, err := mod.Hook("default")
	if err != nil {
		r.fail(kindException, err.Error())
		return
	}
	promise, err := rt.Call(hook, args...)
	for {
		if err != nil {
			r.finishError(rt, err)
			return
		}
		state, result, _ := moejs.PromiseResult(promise)
		switch state {
		case moejs.PromiseFulfilled:
			r.finishValue(rt, result)
			return
		case moejs.PromiseRejected:
			r.fail(kindException, r.thrownMessage(rt, result))
			return
		}
		if len(r.pending) == 0 {
			r.fail(kindException, "the program is waiting for a promise that nothing can settle: no tool call is pending, and this runtime has no timers")
			return
		}
		rep, ok := r.next()
		if !ok {
			return
		}
		err = r.settle(rt, rep)
	}
}

// setup runs the prelude and returns the program's arguments.
func (r *run) setup(rt *moejs.Runtime) ([]moejs.Value, error) {
	fn, err := rt.RunScript(r.s.prelude)
	if err != nil {
		return nil, err
	}
	namespaces, err := json.Marshal(r.namespaces)
	if err != nil {
		return nil, err
	}
	nsValue, err := rt.ParseJSON(namespaces)
	if err != nil {
		return nil, err
	}
	list, err := rt.CallFunction(fn, moejs.Undefined(), nsValue, rt.Function("call", 3, r.call), rt.Function("log", 1, r.log))
	if err != nil {
		return nil, err
	}
	args := slices.Clone(list.AsObject().Elements())
	// The prelude places error constructors after all namespace objects.
	r.bindingErrorClasses = make(map[*engine.Object]Namespace)
	classIndex := len(r.namespaces)
	for _, ns := range r.namespaces {
		if ns.ErrorClass == nil {
			continue
		}
		prototype, err := rt.Get(args[classIndex], "prototype")
		if err != nil {
			return nil, err
		}
		r.bindingErrorClasses[prototype.AsObject()] = ns
		classIndex++
	}
	return args, nil
}

// call is the host side of every binding: it checks the argument, sends a
// call frame and returns a promise that the host's reply settles. A rejection
// carries the message, and the prelude turns it into the namespace's error
// class.
func (r *run) call(realm *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	rt := r.rt.Load()
	global := moejs.Arg(args, 0).String()
	name := moejs.Arg(args, 1).String()
	arg := moejs.Arg(args, 2)
	promise, resolve, reject := rt.NewPromise()
	if arg.IsUndefined() {
		_ = reject(moejs.String("binding arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)"))
		return promise, nil
	}
	if err := checkLossless(realm, arg); err != nil {
		_ = reject(moejs.String("binding arguments must be lossless JSON: " + err.Error()))
		return promise, nil
	}
	if len(r.pending) >= r.s.cfg.MaxPendingCalls {
		return moejs.Undefined(), &moejs.InterruptedError{Value: errTooManyCalls}
	}
	var text json.RawMessage
	limit := r.s.cfg.MaxFrameBytes - frameEnvelope - len(global) - len(name)
	if err := rt.UnmarshalWith(arg, &text, moejs.DecodeOptions{MaxBytes: limit}); err != nil {
		if errors.Is(err, moejs.ErrTooLarge) {
			_ = reject(moejs.String(fmt.Sprintf("binding arguments exceed %d bytes of JSON", limit)))
			return promise, nil
		}
		return moejs.Undefined(), err
	}
	r.nextCall++
	r.pending[r.nextCall] = settlers{resolve, reject}
	frame := frameStart(make([]byte, 0, len(text)+128), "call", r.id)
	frame = append(frame, `,"id":`...)
	frame = strconv.AppendUint(frame, r.nextCall, 10)
	frame = append(frame, `,"global":`...)
	frame = appendJSONString(frame, global)
	frame = append(frame, `,"name":`...)
	frame = appendJSONString(frame, name)
	frame = append(frame, `,"args":`...)
	frame = append(frame, text...)
	r.s.out.write(append(frame, "}\n"...))
	return promise, nil
}

// log admits one console line against the log budget. The line that crosses
// the budget keeps the part that fits, and a marker frame follows it.
func (r *run) log(realm *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	if r.logCut || r.cancelled.Load() {
		return moejs.Undefined(), nil
	}
	text := moejs.Arg(args, 0)
	if !text.IsString() {
		return moejs.Undefined(), nil
	}
	rt := r.rt.Load()
	// Each entry costs its JSON string and a separator. A string longer than
	// the budget in UTF-16 units cannot fit, so only a prefix is encoded.
	str := text.AsString()
	if str.Len() > r.logLeft {
		text = engine.StringValue(str.Substring(0, r.logLeft))
	}
	var encoded json.RawMessage
	if err := rt.Unmarshal(text, &encoded); err != nil {
		return moejs.Undefined(), err
	}
	cost := len(encoded) + 1
	if cost <= r.logLeft && text.AsString().Len() == str.Len() {
		r.logLeft -= cost
		r.sendLog(encoded, false)
		return moejs.Undefined(), nil
	}
	r.logCut = true
	if prefix := truncateJSONString(encoded, r.logLeft-1); len(prefix) > 2 {
		r.sendLog(prefix, false)
	}
	r.sendLog([]byte(`""`), true)
	return moejs.Undefined(), nil
}

func (r *run) sendLog(text []byte, truncated bool) {
	frame := frameStart(make([]byte, 0, len(text)+64), "log", r.id)
	frame = append(frame, `,"text":`...)
	frame = append(frame, text...)
	if truncated {
		frame = append(frame, `,"truncated":true`...)
	}
	r.s.out.write(append(frame, "}\n"...))
}

// settle hands one reply to the program; the promise jobs it queues run here.
func (r *run) settle(rt *moejs.Runtime, rep reply) error {
	p, ok := r.pending[rep.id]
	if !ok {
		return nil
	}
	delete(r.pending, rep.id)
	if !rep.ok {
		return p.reject(moejs.String(rep.message))
	}
	// The reply's bytes are this run's own copy and never change, so the
	// parsed strings may share them.
	v, err := rt.ParseJSONString(unsafe.String(unsafe.SliceData(rep.value), len(rep.value)))
	if err != nil {
		if errors.As(err, new(*moejs.InterruptedError)) {
			return err
		}
		return p.reject(moejs.String("binding resolution could not be read: " + err.Error()))
	}
	return p.resolve(v)
}

func (r *run) finishValue(rt *moejs.Runtime, v moejs.Value) {
	if v.IsUndefined() {
		r.done(nil)
		return
	}
	if err := checkLossless(rt.Realm(), v); err != nil {
		r.fail(kindInvalidOutput, "program completion must be lossless JSON: "+err.Error())
		return
	}
	var text json.RawMessage
	if err := rt.UnmarshalWith(v, &text, moejs.DecodeOptions{MaxBytes: r.s.cfg.MaxValueBytes}); err != nil {
		if errors.Is(err, moejs.ErrTooLarge) {
			r.fail(kindOutputLimit, fmt.Sprintf("completion value exceeded %d bytes", r.s.cfg.MaxValueBytes))
			return
		}
		r.finishError(rt, err)
		return
	}
	r.done(text)
}

func (r *run) finishError(rt *moejs.Runtime, err error) {
	var exc *moejs.Exception
	var internal *moejs.InternalError
	switch {
	case r.cancelled.Load() || errors.Is(err, errCancelled):
	case errors.Is(err, moejs.ErrMemoryLimit):
		r.fail(kindTimeout, fmt.Sprintf("memory budget exceeded: the program allocated more than %d MiB (memoryLimitMb)", r.s.cfg.MemoryLimitBytes>>20))
	case errors.Is(err, errTooManyCalls):
		r.fail(kindProtocol, fmt.Sprintf("the program had more than %d tool calls pending at once (maxPendingCalls)", r.s.cfg.MaxPendingCalls))
	case errors.As(err, &exc):
		r.fail(kindException, r.thrownMessage(rt, exc.Value))
	case errors.As(err, &internal):
		r.fail(kindWorkerExit, "internal error in the moejs runtime: "+internal.Error())
	default:
		r.fail(kindException, err.Error())
	}
}

func (r *run) done(value json.RawMessage) {
	r.s.forget(r.id)
	if r.cancelled.Load() {
		return
	}
	frame := frameStart(make([]byte, 0, len(value)+64), "done", r.id)
	if value != nil {
		frame = append(frame, `,"value":`...)
		frame = append(frame, value...)
	}
	r.s.out.write(append(frame, "}\n"...))
}

func (r *run) fail(kind, message string) {
	r.s.forget(r.id)
	if r.cancelled.Load() {
		return
	}
	frame := frameStart(nil, "done", r.id)
	frame = append(frame, `,"error":{"kind":"`...)
	frame = append(frame, kind...)
	frame = append(frame, `","message":`...)
	frame = append(frame, capMessage(message, r.s.cfg.MaxValueBytes)...)
	r.s.out.write(append(frame, "}}\n"...))
}

// thrownMessage adds the binding's qualified name to an uncaught namespace error.
func (r *run) thrownMessage(rt *moejs.Runtime, v moejs.Value) string {
	message := thrownMessage(rt, v)
	if !v.IsObject() || v.AsObject().Class() != engine.ClassError {
		return message
	}
	ns, ok := r.bindingErrorClasses[v.AsObject().Proto()]
	if !ok {
		return message
	}
	member, ok := v.AsObject().GetOwnDataValue(rt.Realm().KeyFromGoString(ns.ErrorClass.MemberNameProperty))
	if !ok || !member.IsString() {
		return message
	}
	name := member.String()
	qualified := ns.Global + "." + name
	if !identifier.MatchString(name) {
		qualified = ns.Global + "[" + strconv.Quote(name) + "]"
	}
	label := ns.ErrorClass.Name + " (" + qualified + ")"
	if tail, ok := strings.CutPrefix(message, ns.ErrorClass.Name); ok &&
		(tail == "" || strings.HasPrefix(tail, ":") || strings.HasPrefix(tail, "\n")) {
		return label + tail
	}
	return label + ": " + message
}

// thrownMessage renders an Error's stack or the string form of another thrown value.
func thrownMessage(rt *moejs.Runtime, v moejs.Value) string {
	if v.IsObject() {
		if stack, err := rt.Get(v, "stack"); err == nil && stack.IsString() && stack.String() != "" {
			return stack.String()
		}
	}
	if v.IsSymbol() {
		return "program threw a symbol"
	}
	s, err := rt.Realm().ToString(v)
	if err != nil {
		return "program threw an unrenderable value"
	}
	return s.GoString()
}

// syntaxMessage reports a compile error at the program's own positions: the
// header shares the program's first line.
func syntaxMessage(err error, headerLen int) string {
	var se *moejs.SyntaxError
	if !errors.As(err, &se) {
		return err.Error()
	}
	col := se.Column
	if se.Line == 1 {
		col -= headerLen
	}
	msg := strings.TrimSuffix(se.Message, " (see TODO.md)")
	return fmt.Sprintf("SyntaxError: %s (program.ts:%d:%d)", msg, se.Line, max(col, 1))
}
