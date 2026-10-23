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
	"time"
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
	imports    *imports

	rt        atomic.Pointer[moejs.Runtime]
	cancelled atomic.Bool

	mu     sync.Mutex
	queue  []reply
	notify chan struct{}

	// Owned by the run's goroutine.
	loop                *loop
	values              runtimeValues
	headerLen           int
	unhandled           []*engine.Object // rejected promises no handler took yet, in order
	pending             map[uint64]settlers
	bindingErrorClasses map[*engine.Object]Namespace
	nextCall            uint64
	logLeft             int
	logCut              bool
}

func newRun(s *server, f inFrame) *run {
	r := &run{
		s: s, id: f.Run, program: f.Program, namespaces: f.Namespaces,
		notify:  make(chan struct{}, 1),
		loop:    newLoop(s.cfg.MaxPendingTimers),
		pending: map[uint64]settlers{},
		// Each entry pays for its JSON string and the "[" or "," before it, so
		// the budget keeps one byte for the closing "]".
		logLeft: s.cfg.MaxLogBytes - 1,
	}
	r.imports = newImports(&s.modules, f.Cwd, f.ModuleRoot, func() *runtimeValues { return &r.values })
	r.loop.warn = r.logLine
	return r
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

// take returns the replies that have arrived.
func (r *run) take() []reply {
	r.mu.Lock()
	defer r.mu.Unlock()
	batch := r.queue
	r.queue = nil
	return batch
}

// wait sleeps until the next timer is due or a frame for the run arrives.
// It reports false once the run is over: cancelled, or failed because
// nothing can settle the program's promise.
func (r *run) wait(sleep *time.Timer) bool {
	for {
		if r.cancelled.Load() {
			return false
		}
		r.mu.Lock()
		queued := len(r.queue) > 0
		r.mu.Unlock()
		if queued {
			return true
		}
		if len(r.pending) == 0 && !r.loop.alive() {
			r.fail(kindException, "the program is waiting for a promise that nothing can settle: no tool call is pending, and no timer or immediate keeps the program running")
			return false
		}
		if len(r.loop.immediates) > 0 {
			return true
		}
		switch d := r.loop.next(); {
		case d == 0:
			return true
		case d < 0:
			<-r.notify
		default:
			sleep.Reset(d)
			select {
			case <-r.notify:
				sleep.Stop()
			case <-sleep.C:
				return true
			}
		}
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
	r.headerLen = len(header)
	mod, err := moejs.CompileTS("program.ts", header+r.program+"\n}")
	if err != nil {
		r.fail(kindException, syntaxMessage(err, len(header)))
		return
	}
	if r.cancelled.Load() {
		return
	}
	rt := moejs.NewRuntime(moejs.Options{MemoryLimit: r.s.cfg.MemoryLimitBytes, Importer: r.imports.importer()})
	defer r.imports.close()
	rt.SetPromiseRejectionTracker(r.trackRejection)
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
	if !r.over(rt, promise, err) {
		r.drive(rt, promise)
	}
}

// drive runs the program's callbacks until its promise settles, in the
// phases of Node's event loop: the timers due when the phase starts, then
// the replies that have arrived, then the immediates set so far. The
// promise jobs of each callback run when it returns. Timers that are still
// pending when the promise settles never run, as the Node runtime's
// process ends with the program.
func (r *run) drive(rt *moejs.Runtime, promise moejs.Value) {
	sleep := time.NewTimer(time.Hour)
	sleep.Stop()
	defer sleep.Stop()
	for {
		ran := false
		now := r.loop.now()
		for t := r.loop.due(now); t != nil; t = r.loop.due(now) {
			ran = true
			if r.over(rt, promise, r.loop.fire(rt, t)) {
				return
			}
		}
		for _, rep := range r.take() {
			ran = true
			if r.over(rt, promise, r.settle(rt, rep)) {
				return
			}
		}
		for _, im := range r.loop.takeImmediates() {
			called, err := r.loop.runImmediate(rt, im)
			ran = ran || called
			if called && r.over(rt, promise, err) {
				return
			}
		}
		if !ran && !r.wait(sleep) {
			return
		}
	}
}

// over reports whether the run is over after a callback returned err: the
// callback failed, the program's promise settled, a promise rejected with no
// handler, or the run was cancelled. It sends the run's outcome. As in Node,
// a rejection is unhandled when no handler took it by the time the
// callback's promise jobs ran out, and it ends the program.
func (r *run) over(rt *moejs.Runtime, promise moejs.Value, err error) bool {
	if err != nil {
		r.finishError(rt, err)
		return true
	}
	state, result, _ := moejs.PromiseResult(promise)
	switch state {
	case moejs.PromiseFulfilled:
		r.finishValue(rt, result)
		return true
	case moejs.PromiseRejected:
		r.fail(kindException, r.thrownMessage(rt, result))
		return true
	}
	if len(r.unhandled) > 0 {
		_, reason, _ := moejs.PromiseResult(engine.ObjectValue(r.unhandled[0]))
		r.fail(kindException, "Uncaught (in promise) "+r.thrownMessage(rt, reason))
		return true
	}
	return r.cancelled.Load()
}

// trackRejection keeps the rejected promises that have no handler.
func (r *run) trackRejection(p moejs.Value, op moejs.PromiseRejectionOperation) {
	o := p.AsObject()
	switch op {
	case moejs.PromiseRejectionReject:
		r.unhandled = append(r.unhandled, o)
	case moejs.PromiseRejectionHandle:
		if i := slices.Index(r.unhandled, o); i >= 0 {
			r.unhandled = slices.Delete(r.unhandled, i, i+1)
		}
	}
}

// loadInspect runs inspect.js in the run's runtime and returns its
// makeInspect, for the prelude to build console's renderer on first use.
func (r *run) loadInspect(_ *moejs.Realm, _ moejs.Value, _ []moejs.Value) (moejs.Value, error) {
	script, err := r.s.inspectScript()
	if err != nil {
		return moejs.Undefined(), err
	}
	return r.rt.Load().RunScript(script)
}

// promiseDetails gives the prelude's inspect the state of a promise: [0]
// pending, [1, value] fulfilled, [2, reason] rejected, undefined for an
// object that is not a promise.
func (r *run) promiseDetails(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	state, result, ok := moejs.PromiseResult(moejs.Arg(args, 0))
	if !ok {
		return moejs.Undefined(), nil
	}
	code := 0
	switch state {
	case moejs.PromiseFulfilled:
		code = 1
	case moejs.PromiseRejected:
		code = 2
	}
	return r.rt.Load().FromGo([]any{code, result})
}

// setup installs the timers, runs the prelude and returns the program's
// arguments.
func (r *run) setup(rt *moejs.Runtime) ([]moejs.Value, error) {
	if err := r.loop.install(rt); err != nil {
		return nil, err
	}
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
	result, err := rt.CallFunction(fn, moejs.Undefined(), nsValue, rt.Function("call", 3, r.call), rt.Function("log", 1, r.log),
		rt.Function("loadInspect", 0, r.loadInspect), rt.Function("promiseDetails", 1, r.promiseDetails), moejs.Int(int64(r.headerLen)))
	if err != nil {
		return nil, err
	}
	parts := result.AsObject().Elements()
	args := slices.Clone(parts[0].AsObject().Elements())
	r.values = runtimeValues{inspector: parts[1], timers: r.loop.natives}
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

// logLine logs text as a console line of the program.
func (r *run) logLine(text string) {
	_, _ = r.log(nil, moejs.Undefined(), []moejs.Value{moejs.String(text)})
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

// thrownMessage adds the binding's qualified name to an uncaught namespace
// error, and gives the frames on the program's first line its own columns.
func (r *run) thrownMessage(rt *moejs.Runtime, v moejs.Value) string {
	message := fixColumns(thrownMessage(rt, v), r.headerLen)
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
	msg := syntaxHint(se.Message)
	if strings.HasPrefix(msg, "'import' and 'export' may only appear at the top level") {
		msg += "; the program is the body of an async function: it loads modules with `await import(...)` and returns its result"
	}
	return fmt.Sprintf("SyntaxError: %s (program.ts:%d:%d)", msg, se.Line, max(col, 1))
}

// syntaxHint drops moejs's pointer to its own TODO list from a syntax error
// and says what to do instead of an import attribute.
func syntaxHint(msg string) string {
	msg = strings.TrimSuffix(msg, " (see TODO.md)")
	if strings.HasPrefix(msg, "import attribute syntax is not supported") {
		msg += "; this runtime has no JSON modules: read the file with a tool and parse it with JSON.parse"
	}
	return msg
}

// fixColumns gives the frames of a stack on the program's first line the
// program's own columns: the program shares that line with the header of
// the function it is the body of.
func fixColumns(stack string, headerLen int) string {
	const marker = "program.ts:1:"
	var b strings.Builder
	for {
		i := strings.Index(stack, marker)
		if i < 0 {
			if b.Len() == 0 {
				return stack
			}
			b.WriteString(stack)
			return b.String()
		}
		start := i + len(marker)
		end := start
		for end < len(stack) && stack[end] >= '0' && stack[end] <= '9' {
			end++
		}
		col, err := strconv.Atoi(stack[start:end])
		if err != nil || (i > 0 && stack[i-1] != '(' && stack[i-1] != ' ') {
			b.WriteString(stack[:end])
		} else {
			b.WriteString(stack[:start])
			b.WriteString(strconv.Itoa(max(col-headerLen, 1)))
		}
		stack = stack[end:]
	}
}
