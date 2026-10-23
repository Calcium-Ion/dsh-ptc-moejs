package sidecar

import (
	"container/heap"
	"fmt"
	"math"
	"slices"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/Calcium-Ion/moejs"
	"github.com/Calcium-Ion/moejs/engine"
)

// maxDelay is Node's TIMEOUT_MAX in milliseconds: a longer delay, NaN or one
// below 1 is 1.
const maxDelay = 1<<31 - 1

// loop holds the timers and immediates of one run. The functions follow
// Node's: setTimeout and setInterval return a Timeout with ref, unref,
// hasRef, refresh, close and Symbol.toPrimitive, setImmediate an Immediate
// with ref, unref and hasRef. The run's goroutine owns the loop, and its
// callbacks count against the run's memory budget, as the program does.
type loop struct {
	epoch time.Time
	limit int // maxPendingTimers
	// timers are the scheduled timers, by expiry, then by scheduling.
	timers     timerHeap
	ids        map[int64]*timer // timers whose id was read, while active
	immediates []*immediate     // set and not yet run, in order
	refs       int              // active timers and pending immediates that are ref'd
	active     int              // active timers and pending immediates
	seq        uint64
	lastID     int64
	// The prototypes of Timeout and Immediate, created on first use.
	timeoutProto, immediateProto *engine.Object
	// natives are the timer functions, by name, for node:timers.
	natives map[string]moejs.Value
	// warn logs a warning of the timer functions, as Node's process does.
	warn func(text string)
}

// timer is the state of a Timeout, of setTimeout or setInterval.
type timer struct {
	loop   *loop
	id     int64
	fn     moejs.Value // undefined once cleared
	this   moejs.Value // the Timeout
	args   []moejs.Value
	delay  time.Duration
	repeat bool
	when   time.Duration // the loop's clock when due
	seq    uint64
	index  int  // in the heap, or -1
	ref    bool // hasRef
	// active is true while the timer is scheduled or its callback runs.
	active     bool
	cleared    bool
	registered bool // in ids: Symbol.toPrimitive returned its id
}

// immediate is the state of an Immediate.
type immediate struct {
	loop    *loop
	fn      moejs.Value
	this    moejs.Value // the Immediate
	args    []moejs.Value
	pending bool // neither run nor cleared
	ref     bool
}

type timerHeap []*timer

func (h timerHeap) Len() int { return len(h) }
func (h timerHeap) Less(i, j int) bool {
	if h[i].when != h[j].when {
		return h[i].when < h[j].when
	}
	return h[i].seq < h[j].seq
}
func (h timerHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index, h[j].index = i, j
}
func (h *timerHeap) Push(x any) {
	t := x.(*timer)
	t.index = len(*h)
	*h = append(*h, t)
}
func (h *timerHeap) Pop() any {
	old := *h
	t := old[len(old)-1]
	old[len(old)-1] = nil
	*h = old[:len(old)-1]
	t.index = -1
	return t
}

func newLoop(limit int) *loop {
	return &loop{epoch: time.Now(), limit: limit}
}

func (l *loop) now() time.Duration { return time.Since(l.epoch) }

// due removes and returns the first timer when it is due at now, the time
// its timers phase started. A timer set meanwhile is due 1 ms later at the
// earliest, so it waits for the next phase.
func (l *loop) due(now time.Duration) *timer {
	if len(l.timers) == 0 || l.timers[0].when > now {
		return nil
	}
	return heap.Pop(&l.timers).(*timer)
}

// next returns how long until the first timer is due, or -1 with none.
func (l *loop) next() time.Duration {
	if len(l.timers) == 0 {
		return -1
	}
	return max(l.timers[0].when-l.now(), 0)
}

// alive reports whether a timer or an immediate keeps the run waiting.
func (l *loop) alive() bool { return l.refs > 0 }

// fire runs the callback of t, which due returned. Node reschedules an
// interval from the time its callback started.
func (l *loop) fire(rt *moejs.Runtime, t *timer) error {
	start := l.now()
	_, err := rt.CallFunction(t.fn, t.this, t.args...)
	switch {
	case !t.active:
		// Cleared by its callback.
	case t.repeat:
		if t.index >= 0 {
			// Refreshed by its callback: the interval wins, as in Node.
			heap.Remove(&l.timers, t.index)
		}
		t.when = start + t.delay
		l.push(t)
	case t.index < 0:
		// A timeout its callback did not refresh. clearTimeout found it by
		// its id until now.
		l.deactivate(t)
	}
	return err
}

// takeImmediates returns the immediates set so far, for the check phase.
func (l *loop) takeImmediates() []*immediate {
	batch := l.immediates
	l.immediates = nil
	return batch
}

// runImmediate runs im unless it was cleared.
func (l *loop) runImmediate(rt *moejs.Runtime, im *immediate) (bool, error) {
	if !im.pending {
		return false, nil
	}
	fn, this, args := im.fn, im.this, im.args
	l.settleImmediate(im)
	_, err := rt.CallFunction(fn, this, args...)
	return true, err
}

// push schedules t at t.when, after the timers scheduled before it for the
// same time.
func (l *loop) push(t *timer) {
	l.seq++
	t.seq = l.seq
	heap.Push(&l.timers, t)
	if !t.active {
		t.active = true
		l.active++
		if t.ref {
			l.refs++
		}
	}
}

// deactivate ends t's active period: it fired as a timeout, or was cleared.
func (l *loop) deactivate(t *timer) {
	if t.active {
		t.active = false
		l.active--
		if t.ref {
			l.refs--
		}
	}
	if t.registered {
		t.registered = false
		delete(l.ids, t.id)
	}
}

func (l *loop) clearTimer(t *timer) {
	if t.cleared {
		return
	}
	t.cleared = true
	if t.index >= 0 {
		heap.Remove(&l.timers, t.index)
	}
	l.deactivate(t)
	t.fn, t.args = moejs.Undefined(), nil
}

func (l *loop) settleImmediate(im *immediate) {
	im.pending = false
	l.active--
	if im.ref {
		im.ref = false
		l.refs--
	}
	im.fn, im.args = moejs.Undefined(), nil
}

// install sets the timer functions as globals of rt, writable, enumerable
// and configurable as in Node. It runs before the program, on a fresh
// global object, so no JavaScript runs.
func (l *loop) install(rt *moejs.Runtime) error {
	r := rt.Realm()
	l.natives = make(map[string]moejs.Value, 6)
	for _, g := range []struct {
		name   string
		length int
		fn     moejs.NativeFunc
	}{
		{"setTimeout", 5, l.setTimeout},
		{"clearTimeout", 1, l.clearTimeout},
		{"setInterval", 5, l.setInterval},
		{"clearInterval", 1, l.clearTimeout},
		{"setImmediate", 4, l.setImmediate},
		{"clearImmediate", 1, l.clearImmediate},
	} {
		fn := rt.Function(g.name, g.length, g.fn)
		if _, err := r.Global.CreateDataProperty(r, r.KeyFromGoString(g.name), fn); err != nil {
			return err
		}
		l.natives[g.name] = fn
	}
	return nil
}

func (l *loop) setTimeout(r *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	return l.setTimer(r, args, false)
}

func (l *loop) setInterval(r *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	return l.setTimer(r, args, true)
}

// setTimer creates and schedules a Timeout. The delay goes through ToNumber
// and is truncated to whole milliseconds, as Node's is.
func (l *loop) setTimer(r *moejs.Realm, args []moejs.Value, repeat bool) (moejs.Value, error) {
	fn := moejs.Arg(args, 0)
	if !engine.IsCallable(fn) {
		return moejs.Undefined(), callbackError(r, fn)
	}
	ms, err := r.ToNumber(moejs.Arg(args, 1))
	if err != nil {
		return moejs.Undefined(), err
	}
	if !(ms >= 1 && ms <= maxDelay) {
		if ms > maxDelay && l.warn != nil {
			l.warn(fmt.Sprintf("TimeoutOverflowWarning: %s does not fit into a 32-bit signed integer.\nTimeout duration was set to 1.", engine.NumberValue(ms).String()))
		}
		ms = 1
	}
	if err := l.admit(r); err != nil {
		return moejs.Undefined(), err
	}
	t := &timer{loop: l, fn: fn, delay: time.Duration(ms) * time.Millisecond, repeat: repeat, index: -1, ref: true}
	if len(args) > 2 {
		t.args = slices.Clone(args[2:])
	}
	o := r.NewObjectWithProto(l.timeoutPrototype(r))
	o.SetInternal(t)
	t.this = engine.ObjectValue(o)
	l.lastID++
	t.id = l.lastID
	t.when = l.now() + t.delay
	l.push(t)
	return t.this, nil
}

// admit checks maxPendingTimers before a timer or an immediate is set.
func (l *loop) admit(r *moejs.Realm) error {
	if l.active >= l.limit {
		return r.RangeError("more than %d timers and immediates pending at once (maxPendingTimers)", l.limit)
	}
	return nil
}

// clearTimeout implements clearTimeout and clearInterval: the argument is a
// Timeout, or the id its Symbol.toPrimitive returned, as a number or a
// string. Anything else is ignored.
func (l *loop) clearTimeout(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	v := moejs.Arg(args, 0)
	var t *timer
	switch {
	case v.IsObject():
		t = l.timerOf(v)
	case v.IsNumber():
		if f := v.AsNumber(); f == math.Trunc(f) && f >= 1 && f <= float64(l.lastID) {
			t = l.ids[int64(f)]
		}
	case v.IsString():
		s := v.AsString().GoString()
		if id, err := strconv.ParseInt(s, 10, 64); err == nil && strconv.FormatInt(id, 10) == s {
			t = l.ids[id]
		}
	}
	if t != nil {
		l.clearTimer(t)
	}
	return moejs.Undefined(), nil
}

func (l *loop) setImmediate(r *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	fn := moejs.Arg(args, 0)
	if !engine.IsCallable(fn) {
		return moejs.Undefined(), callbackError(r, fn)
	}
	if err := l.admit(r); err != nil {
		return moejs.Undefined(), err
	}
	im := &immediate{loop: l, fn: fn, pending: true, ref: true}
	if len(args) > 1 {
		im.args = slices.Clone(args[1:])
	}
	o := r.NewObjectWithProto(l.immediatePrototype(r))
	o.SetInternal(im)
	im.this = engine.ObjectValue(o)
	l.immediates = append(l.immediates, im)
	l.active++
	l.refs++
	return im.this, nil
}

func (l *loop) clearImmediate(_ *moejs.Realm, _ moejs.Value, args []moejs.Value) (moejs.Value, error) {
	if im := l.immediateOf(moejs.Arg(args, 0)); im != nil && im.pending {
		l.settleImmediate(im)
	}
	return moejs.Undefined(), nil
}

func (l *loop) timerOf(v moejs.Value) *timer {
	if !v.IsObject() {
		return nil
	}
	t, _ := v.AsObject().Internal().(*timer)
	if t == nil || t.loop != l {
		return nil
	}
	return t
}

func (l *loop) immediateOf(v moejs.Value) *immediate {
	if !v.IsObject() {
		return nil
	}
	im, _ := v.AsObject().Internal().(*immediate)
	if im == nil || im.loop != l {
		return nil
	}
	return im
}

// timeoutPrototype returns the prototype of the Timeout objects. Its
// constructor is named Timeout, so console shows one as Node does.
func (l *loop) timeoutPrototype(r *moejs.Realm) *engine.Object {
	if l.timeoutProto != nil {
		return l.timeoutProto
	}
	p := r.NewObject()
	method := func(key engine.PropertyKey, name string, fn func(t *timer) moejs.Value) {
		defineMethod(r, p, key, name, func(r *moejs.Realm, this moejs.Value, _ []moejs.Value) (moejs.Value, error) {
			t := l.timerOf(this)
			if t == nil {
				return moejs.Undefined(), r.TypeError("Timeout.prototype.%s called on an object that is not a Timeout", name)
			}
			return fn(t), nil
		})
	}
	method(r.KeyFromGoString("ref"), "ref", func(t *timer) moejs.Value {
		if !t.ref {
			t.ref = true
			if t.active {
				l.refs++
			}
		}
		return t.this
	})
	method(r.KeyFromGoString("unref"), "unref", func(t *timer) moejs.Value {
		if t.ref {
			t.ref = false
			if t.active {
				l.refs--
			}
		}
		return t.this
	})
	method(r.KeyFromGoString("hasRef"), "hasRef", func(t *timer) moejs.Value {
		return moejs.Bool(t.ref)
	})
	method(r.KeyFromGoString("refresh"), "refresh", func(t *timer) moejs.Value {
		// A timeout that fired runs again; a cleared one does not.
		if t.cleared {
			return t.this
		}
		if !t.active && l.admit(r) != nil {
			return t.this
		}
		t.when = l.now() + t.delay
		if t.index >= 0 {
			heap.Remove(&l.timers, t.index)
		}
		l.push(t)
		return t.this
	})
	method(r.KeyFromGoString("close"), "close", func(t *timer) moejs.Value {
		l.clearTimer(t)
		return t.this
	})
	method(engine.SymbolKey(engine.SymToPrimitive), "[Symbol.toPrimitive]", func(t *timer) moejs.Value {
		// clearTimeout finds an active timer by the id this returns.
		if t.active && !t.registered {
			if l.ids == nil {
				l.ids = make(map[int64]*timer)
			}
			l.ids[t.id] = t
			t.registered = true
		}
		return moejs.Int(t.id)
	})
	defineConstructor(r, p, "Timeout")
	l.timeoutProto = p
	return p
}

// immediatePrototype returns the prototype of the Immediate objects.
func (l *loop) immediatePrototype(r *moejs.Realm) *engine.Object {
	if l.immediateProto != nil {
		return l.immediateProto
	}
	p := r.NewObject()
	method := func(name string, fn func(im *immediate) moejs.Value) {
		defineMethod(r, p, r.KeyFromGoString(name), name, func(r *moejs.Realm, this moejs.Value, _ []moejs.Value) (moejs.Value, error) {
			im := l.immediateOf(this)
			if im == nil {
				return moejs.Undefined(), r.TypeError("Immediate.prototype.%s called on an object that is not an Immediate", name)
			}
			return fn(im), nil
		})
	}
	// An Immediate that ran or was cleared has no ref to change.
	method("ref", func(im *immediate) moejs.Value {
		if im.pending && !im.ref {
			im.ref = true
			l.refs++
		}
		return im.this
	})
	method("unref", func(im *immediate) moejs.Value {
		if im.pending && im.ref {
			im.ref = false
			l.refs--
		}
		return im.this
	})
	method("hasRef", func(im *immediate) moejs.Value {
		return moejs.Bool(im.ref)
	})
	defineConstructor(r, p, "Immediate")
	l.immediateProto = p
	return p
}

// defineMethod defines a method as a class does: writable, configurable and
// not enumerable.
func defineMethod(r *moejs.Realm, o *engine.Object, key engine.PropertyKey, name string, fn moejs.NativeFunc) {
	var d engine.PropertyDescriptor
	d.SetValue(engine.ObjectValue(r.NewNativeFunction(engine.FromGoString(name), 0, fn)))
	d.SetWritable(true)
	d.SetEnumerable(false)
	d.SetConfigurable(true)
	// A fresh ordinary object accepts any property.
	_, _ = o.DefineOwnProperty(r, key, d)
}

// defineConstructor gives prototype p a constructor named name, which
// throws: the objects come only from the timer functions.
func defineConstructor(r *moejs.Realm, p *engine.Object, name string) {
	ctor := r.NewNativeFunction(engine.FromGoString(name), 0, func(r *moejs.Realm, _ moejs.Value, _ []moejs.Value) (moejs.Value, error) {
		return moejs.Undefined(), r.TypeError("Illegal constructor")
	})
	var d engine.PropertyDescriptor
	d.SetValue(engine.ObjectValue(ctor))
	d.SetWritable(true)
	d.SetEnumerable(false)
	d.SetConfigurable(true)
	_, _ = p.DefineOwnProperty(r, r.KeyFromGoString("constructor"), d)
	// As a class's, so that instanceof and inspect find the objects' type.
	var proto engine.PropertyDescriptor
	proto.SetValue(engine.ObjectValue(p))
	proto.SetWritable(false)
	proto.SetEnumerable(false)
	proto.SetConfigurable(false)
	_, _ = ctor.DefineOwnProperty(r, r.KeyFromGoString("prototype"), proto)
}

// callbackError is Node's TypeError for a callback that is not a function.
func callbackError(r *moejs.Realm, v moejs.Value) error {
	err := r.TypeError("The \"callback\" argument must be of type function. Received %s", received(v))
	if exc, ok := err.(*moejs.Exception); ok && exc.Value.IsObject() {
		_, _ = exc.Value.AsObject().CreateDataProperty(r, r.KeyFromGoString("code"), moejs.String("ERR_INVALID_ARG_TYPE"))
	}
	return err
}

// received describes v as Node's ERR_INVALID_ARG_TYPE message does, without
// running JavaScript.
func received(v moejs.Value) string {
	var typ string
	switch v.Type() {
	case engine.TypeUndefined, engine.TypeNull:
		return v.String()
	case engine.TypeObject:
		return "an instance of " + v.AsObject().ClassName()
	case engine.TypeString:
		s := v.String()
		if utf8.RuneCountInString(s) > 25 {
			s = string([]rune(s)[:25]) + "..."
		}
		return "type string ('" + s + "')"
	case engine.TypeBoolean:
		typ = "boolean"
	case engine.TypeNumber:
		typ = "number"
	case engine.TypeSymbol:
		typ = "symbol"
	case engine.TypeBigInt:
		return "type bigint (" + v.String() + "n)"
	}
	return "type " + typ + " (" + v.String() + ")"
}
