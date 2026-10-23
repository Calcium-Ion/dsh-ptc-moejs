package sidecar

import (
	"strings"
	"testing"
	"time"
)

func TestTimersResolveAfterTheirDelay(t *testing.T) {
	h := start(t, testConfig)
	began := time.Now()
	o := h.eval(`
const started = Date.now()
const value = await new Promise(resolve => setTimeout(resolve, 30, "slept"))
return [value, Date.now() - started >= 29]`)
	expectValue(t, o, `["slept",true]`)
	if elapsed := time.Since(began); elapsed < 30*time.Millisecond {
		t.Fatalf("the run took %v, shorter than its timer", elapsed)
	}
}

func TestTimersRunInNodeOrder(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const order = []
setTimeout(() => order.push("t20"), 20)
setTimeout(() => {
  order.push("t1a")
  Promise.resolve().then(() => order.push("job"))
  // Inside a timer, an immediate runs before a new timer of 0 ms.
  setTimeout(() => order.push("t0"), 0)
  setImmediate(() => order.push("immediate"))
}, 1)
setTimeout(() => order.push("t1b"), 1)
await new Promise(resolve => setTimeout(resolve, 40))
return order`)
	expectValue(t, o, `["t1a","job","t1b","immediate","t0","t20"]`)
}

func TestTimerCallbacksGetTheirArgumentsAndTimeout(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const timer = await new Promise(resolve => {
  const t = setTimeout(function (a, b) { resolve([a, b, this === t]) }, 1, "x", 2)
})
const immediate = await new Promise(resolve => {
  const i = setImmediate(function (a) { resolve([a, this === i]) }, "y")
})
return [timer, immediate]`)
	expectValue(t, o, `[["x",2,true],["y",true]]`)
}

func TestIntervalsRepeatUntilCleared(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
let ticks = 0
await new Promise(resolve => {
  const id = setInterval(() => {
    ticks++
    if (ticks === 3) { clearInterval(id); resolve() }
  }, 2)
})
await new Promise(resolve => setTimeout(resolve, 10))
return ticks`)
	expectValue(t, o, `3`)
}

func TestClearedTimersNeverRun(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const ran = []
const a = setTimeout(() => ran.push("a"), 1)
clearTimeout(a)
const b = setTimeout(() => ran.push("b"), 1)
clearTimeout(+b)
const c = setTimeout(() => ran.push("c"), 1)
clearTimeout(String(c[Symbol.toPrimitive]()))
const d = setImmediate(() => ran.push("d"))
clearImmediate(d)
const e = setTimeout(() => ran.push("e"), 1)
e.close()
clearTimeout(12345)
clearTimeout(undefined)
clearTimeout({})
await new Promise(resolve => setTimeout(resolve, 10))
return ran`)
	expectValue(t, o, `[]`)
}

func TestTimeoutMethods(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const t = setTimeout(() => {}, 1)
const facts = [t.hasRef(), t.unref() === t, t.hasRef(), t.ref() === t, t.hasRef(), typeof +t]
const i = setImmediate(() => {})
facts.push(i.hasRef(), i.unref() === i, i.hasRef())
console.log(t, i)
let refreshed = 0
const r = setTimeout(() => { refreshed++ }, 1)
await new Promise(resolve => setTimeout(resolve, 10))
r.refresh()
await new Promise(resolve => setTimeout(resolve, 10))
facts.push(refreshed)
try { Object.getPrototypeOf(t).ref.call({}) } catch (e) { facts.push(e.name) }
try { t.constructor() } catch (e) { facts.push(e.message) }
facts.push(t.constructor.name, i.constructor.name)
return facts`)
	expectValue(t, o, `[true,true,false,true,true,"number",true,true,false,2,"TypeError","Illegal constructor","Timeout","Immediate"]`)
	if len(o.logs) != 1 || o.logs[0] != "Timeout {} Immediate {}" {
		t.Fatalf("logs = %q", o.logs)
	}
}

func TestUnrefTimersDoNotKeepTheProgramWaiting(t *testing.T) {
	h := start(t, testConfig)
	began := time.Now()
	expectFailure(t, h.eval(`
setTimeout(() => {}, 5000).unref()
await new Promise(() => {})`), kindException, "nothing can settle")
	if elapsed := time.Since(began); elapsed > 2*time.Second {
		t.Fatalf("the run waited %v for an unref'd timer", elapsed)
	}
	// An unref'd timer still runs while a tool call keeps the run going.
	h.run(1, `
const fired = []
setTimeout(() => fired.push("unref'd"), 1).unref()
await tools.echo({})
return fired`, toolsNS)
	call := h.recv()
	time.Sleep(30 * time.Millisecond)
	h.send(map[string]any{"type": "reply", "run": 1, "id": call["id"], "ok": true, "value": map[string]any{}})
	expectValue(t, h.finish(1), `["unref'd"]`)
}

func TestTimerCallbackExceptionsFailTheRun(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
setTimeout(() => { throw new Error("from a timer") }, 1)
await new Promise(resolve => setTimeout(resolve, 1000))`)
	expectFailure(t, o, kindException, "Error: from a timer\n    at ")
	expectFailure(t, h.eval(`setTimeout("code", 1)`), kindException, `The "callback" argument must be of type function. Received type string ('code')`)
	expectValue(t, h.eval(`try { setInterval(null) } catch (e) { return [e.name, e.code] }`), `["TypeError","ERR_INVALID_ARG_TYPE"]`)
}

func TestTimersAreLimited(t *testing.T) {
	cfg := testConfig
	cfg.MaxPendingTimers = 3
	h := start(t, cfg)
	o := h.eval(`
const timers = [setTimeout(() => {}, 1), setInterval(() => {}, 1), setImmediate(() => {})]
let error
try { setTimeout(() => {}, 1) } catch (e) { error = e.name + ": " + e.message }
clearTimeout(timers[0])
setTimeout(() => {}, 1)
clearInterval(timers[1])
return error`)
	expectValue(t, o, `"RangeError: more than 3 timers and immediates pending at once (maxPendingTimers)"`)
}

func TestPendingTimersEndWithTheProgram(t *testing.T) {
	h := start(t, testConfig)
	h.run(1, `setInterval(() => console.log("tick"), 1); setTimeout(() => console.log("late"), 5); return "done"`, nil)
	expectValue(t, h.finish(1), `"done"`)
	h.quiet(30 * time.Millisecond)
}

func TestCancelStopsARunWaitingForATimer(t *testing.T) {
	h := start(t, testConfig)
	h.run(1, `await new Promise(resolve => setTimeout(resolve, 60000))`, nil)
	time.Sleep(20 * time.Millisecond)
	h.send(map[string]any{"type": "cancel", "run": 1})
	h.quiet(50 * time.Millisecond)
	expectValue(t, h.eval(`return 1`), `1`)
}

func TestTimerCallbacksShareTheRunsMemoryBudget(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const kept = []
for (let i = 0; i < 64; i++) {
  kept.push(new Array(1 << 18).fill(i))
  await new Promise(resolve => setTimeout(resolve, 0))
}
return kept.length`)
	kind, msg := o.failure()
	if kind != kindTimeout || !strings.Contains(msg, "memory budget exceeded") {
		t.Fatalf("failure = (%s) %q, want the memory budget", kind, msg)
	}
}
