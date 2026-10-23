package sidecar

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
	"time"
)

// harness runs Serve in-process and speaks its protocol.
type harness struct {
	t      *testing.T
	runs   int
	in     *io.PipeWriter
	frames chan map[string]any
	served chan error
}

var testConfig = Config{
	MemoryLimitBytes: 64 << 20,
	MaxLogBytes:      1 << 16,
	MaxValueBytes:    1 << 16,
	MaxPendingCalls:  16,
	MaxFrameBytes:    1 << 20,
}

func start(t *testing.T, cfg Config) *harness {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	h := &harness{t: t, in: inW, frames: make(chan map[string]any, 1024), served: make(chan error, 1)}
	go func() {
		err := Serve(inR, outW)
		outW.Close()
		h.served <- err
	}()
	go func() {
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(nil, 64<<20)
		for scanner.Scan() {
			var f map[string]any
			var raw struct{ Args json.RawMessage }
			if err := json.Unmarshal(scanner.Bytes(), &f); err != nil || json.Unmarshal(scanner.Bytes(), &raw) != nil {
				panic(fmt.Sprintf("sidecar wrote invalid JSON %q: %v", scanner.Text(), err))
			}
			// Go's JSON decoder replaces lone surrogates, so echo replies
			// send the arguments' own bytes back.
			f["rawArgs"] = raw.Args
			h.frames <- f
		}
		close(h.frames)
	}()
	h.send(map[string]any{
		"type": "boot", "protocol": Protocol,
		"memoryLimitBytes": cfg.MemoryLimitBytes, "maxLogBytes": cfg.MaxLogBytes, "maxValueBytes": cfg.MaxValueBytes,
		"maxPendingCalls": cfg.MaxPendingCalls, "maxFrameBytes": cfg.MaxFrameBytes,
	})
	if f := h.recv(); f["type"] != "boot-ack" {
		t.Fatalf("expected boot-ack, got %v", f)
	}
	t.Cleanup(func() {
		h.in.Close()
		select {
		case err := <-h.served:
			if err != nil {
				t.Errorf("Serve: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Errorf("Serve did not return after stdin closed")
		}
	})
	return h
}

func (h *harness) send(frame map[string]any) {
	h.t.Helper()
	b, err := json.Marshal(frame)
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.in.Write(append(b, '\n')); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) recv() map[string]any {
	h.t.Helper()
	select {
	case f, ok := <-h.frames:
		if !ok {
			h.t.Fatal("sidecar output ended")
		}
		return f
	case <-time.After(10 * time.Second):
		h.t.Fatal("no frame within 10s")
	}
	return nil
}

// quiet asserts that no frame arrives for a while.
func (h *harness) quiet(d time.Duration) {
	h.t.Helper()
	select {
	case f := <-h.frames:
		h.t.Fatalf("unexpected frame %v", f)
	case <-time.After(d):
	}
}

var toolsNS = []Namespace{{
	Global: "tools", Names: []string{"echo", "fail", "__proto__", "constructor", "toString"},
	ErrorClass: &ErrorClass{Name: "ToolCallError", MemberNameProperty: "toolName"},
}}

func (h *harness) run(id int, program string, namespaces []Namespace) {
	h.t.Helper()
	if namespaces == nil {
		namespaces = []Namespace{}
	}
	h.send(map[string]any{"type": "run", "run": id, "program": program, "namespaces": namespaces})
}

// outcome is what a run sent, with calls answered by echo and fail.
type outcome struct {
	logs  []string
	cut   bool
	calls []map[string]any
	done  map[string]any
}

func (o outcome) value() any { return o.done["value"] }

func (o outcome) failure() (string, string) {
	e, _ := o.done["error"].(map[string]any)
	if e == nil {
		return "", ""
	}
	return e["kind"].(string), e["message"].(string)
}

// finish answers calls until the run is done: echo returns its arguments,
// fail rejects with a message, the other names return their own name.
func (h *harness) finish(id int) outcome {
	h.t.Helper()
	var o outcome
	for {
		f := h.recv()
		if f["run"] != float64(id) {
			h.t.Fatalf("frame for another run: %v", f)
		}
		switch f["type"] {
		case "log":
			if f["truncated"] == true {
				o.cut = true
			} else {
				o.logs = append(o.logs, f["text"].(string))
			}
		case "call":
			o.calls = append(o.calls, f)
			reply := map[string]any{"type": "reply", "run": id, "id": f["id"], "ok": true}
			switch f["name"] {
			case "echo":
				reply["value"] = f["rawArgs"]
			case "fail":
				reply["ok"], reply["message"] = false, "it failed"
			default:
				reply["value"] = f["name"]
			}
			h.send(reply)
		case "done":
			o.done = f
			return o
		default:
			h.t.Fatalf("unexpected frame %v", f)
		}
	}
}

func (h *harness) eval(program string) outcome {
	h.t.Helper()
	h.runs++
	h.run(1000+h.runs, program, toolsNS)
	return h.finish(1000 + h.runs)
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func expectValue(t *testing.T, o outcome, want string) {
	t.Helper()
	if kind, msg := o.failure(); kind != "" {
		t.Fatalf("run failed (%s): %s", kind, msg)
	}
	if got := mustJSON(t, o.value()); got != want {
		t.Fatalf("value = %s, want %s", got, want)
	}
}

func expectFailure(t *testing.T, o outcome, kind, contains string) {
	t.Helper()
	gotKind, msg := o.failure()
	if gotKind != kind || !strings.Contains(msg, contains) {
		t.Fatalf("failure = (%s) %q, want (%s) containing %q", gotKind, msg, kind, contains)
	}
}

func TestCompilesAndRunsTypeScript(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
interface Point { x: number; y: number }
const p: Point = { x: 3, y: 4 }
const norm = (q: Point): number => Math.sqrt(q.x ** 2 + q.y ** 2)
return { norm: norm(p), type: typeof p satisfies string, strict: (function () { return this === undefined })() }`)
	expectValue(t, o, `{"norm":5,"strict":true,"type":"object"}`)
}

func TestProgramWithoutReturnHasNoValue(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`console.log("only output")`)
	if _, ok := o.done["value"]; ok || o.done["error"] != nil {
		t.Fatalf("done = %v, want no value and no error", o.done)
	}
	if o.logs[0] != "only output" {
		t.Fatalf("logs = %q", o.logs)
	}
}

func TestReportsSyntaxErrorsAtProgramPositions(t *testing.T) {
	h := start(t, testConfig)
	expectFailure(t, h.eval("const x: = 1"), kindException, "SyntaxError: Unexpected token '=' (program.ts:1:10)")
	o := h.eval("const a = 1\nenum Color { Red }")
	expectFailure(t, o, kindException, "(program.ts:2:1)")
	if _, msg := o.failure(); strings.Contains(msg, "TODO") {
		t.Fatalf("message points into moejs: %q", msg)
	}
}

func TestBindingsAreHostFunctionsReturningPromises(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const pending = tools.echo({ a: 1 })
const isPromise = pending instanceof Promise
const [a, b] = await Promise.all([pending, tools.echo([2, "two"])])
return { isPromise, a, b }`)
	expectValue(t, o, `{"a":{"a":1},"b":[2,"two"],"isPromise":true}`)
	if len(o.calls) != 2 || o.calls[0]["id"] != float64(1) || o.calls[1]["id"] != float64(2) {
		t.Fatalf("calls = %v", o.calls)
	}
	if o.calls[0]["global"] != "tools" || o.calls[0]["name"] != "echo" {
		t.Fatalf("call frame = %v", o.calls[0])
	}
}

func TestRejectionsUseTheNamespaceErrorClass(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
try {
  await tools.fail({})
} catch (e) {
  return { cls: e instanceof ToolCallError, err: e instanceof Error, name: e.name, member: e.toolName,
    message: e.message, own: Object.keys(e), className: ToolCallError.name }
}`)
	expectValue(t, o, `{"className":"ToolCallError","cls":true,"err":true,"member":"fail","message":"it failed","name":"ToolCallError","own":["name","toolName"]}`)
	o = h.eval(`await tools.fail({})`)
	expectFailure(t, o, kindException, "ToolCallError (tools.fail): it failed")
}

func TestUncaughtBindingErrorDiagnostics(t *testing.T) {
	namespaces := append(slices.Clone(toolsNS),
		Namespace{Global: "plain", Names: []string{"fail"}},
		Namespace{Global: "api", Names: []string{"fail", "run.command"},
			ErrorClass: &ErrorClass{Name: "ApiError", MemberNameProperty: "operation-name"}},
	)
	for _, tt := range []struct {
		name    string
		program string
		prefix  string
		log     string
	}{
		{"custom namespace", `await api.fail({})`, "ApiError (api.fail): it failed\n", ""},
		{"quoted member", `await api["run.command"]()`, "ApiError (api[\"run.command\"]): binding arguments must be lossless JSON", ""},
		{"caught then rethrown", `try { await tools.fail({}) } catch (e) { console.log(e); throw e }`,
			"ToolCallError (tools.fail): it failed\n", "ToolCallError: it failed\n"},
		{"rethrow in a microtask", `try { await tools.fail({}) } catch (e) { queueMicrotask(() => { throw e }); await tools.echo({}) }`,
			"ToolCallError (tools.fail): it failed\n", ""},
		{"custom stack", `try { await tools.fail({}) } catch (e) { e.stack = "custom trace"; throw e }`,
			"ToolCallError (tools.fail): custom trace", ""},
		{"ordinary error", `throw new Error("ordinary")`, "Error: ordinary\n", ""},
		{"lookalike error", `const e = new Error("ordinary"); e.name = "ToolCallError"; e.toolName = "fail"; throw e`,
			"ToolCallError: ordinary\n", ""},
		{"untyped binding", `await plain.fail({})`, "Error: it failed\n", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h := start(t, testConfig)
			h.run(1, tt.program, namespaces)
			o := h.finish(1)
			kind, message := o.failure()
			if kind != kindException || !strings.HasPrefix(message, tt.prefix) {
				t.Fatalf("failure = (%s) %q, want prefix %q", kind, message, tt.prefix)
			}
			if tt.log != "" && (len(o.logs) != 1 || !strings.HasPrefix(o.logs[0], tt.log)) {
				t.Fatalf("logs = %v, want prefix %q", o.logs, tt.log)
			}
		})
	}
}

func TestBindingNamesAreOrdinaryOwnProperties(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
return {
  proto: Object.getPrototypeOf(tools) === null,
  keys: Object.keys(tools),
  dunder: await tools.__proto__({}),
  ctor: await tools.constructor({}),
  str: await tools.toString({}),
  missing: typeof tools.hasOwnProperty,
}`)
	expectValue(t, o, `{"ctor":"constructor","dunder":"__proto__","keys":["echo","fail","__proto__","constructor","toString"],"missing":"undefined","proto":true,"str":"toString"}`)
}

func TestArgumentsMustBeLosslessJSON(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const out = []
for (const arg of [undefined, NaN, { n: -0 }, { f() {} }, [1, , 3], new Map(), 10n]) {
  try { await tools.echo(arg); out.push("sent") } catch (e) { out.push(e.toolName + ": " + e.message) }
}
return out`)
	if kind, msg := o.failure(); kind != "" {
		t.Fatalf("run failed (%s): %s", kind, msg)
	}
	got := o.value().([]any)
	want := []string{
		"echo: binding arguments must be lossless JSON (call the tool with an arguments object",
		"echo: binding arguments must be lossless JSON: NaN at $",
		"echo: binding arguments must be lossless JSON: -0 at $.n",
		"echo: binding arguments must be lossless JSON: a function at $.f",
		"echo: binding arguments must be lossless JSON: an array with holes at $",
		"echo: binding arguments must be lossless JSON: a Map at $",
		"echo: binding arguments must be lossless JSON: a BigInt at $",
	}
	for i, w := range want {
		if !strings.HasPrefix(got[i].(string), w) {
			t.Errorf("argument %d: got %q, want prefix %q", i, got[i], w)
		}
	}
	if len(o.calls) != 0 {
		t.Fatalf("invalid arguments reached the host: %v", o.calls)
	}
}

func TestValuesCrossLosslessly(t *testing.T) {
	h := start(t, testConfig)
	// Exact doubles, a large integer, non-ASCII text, a lone surrogate and an
	// escaped control character go to the host and come back unchanged.
	o := h.eval(`
const sent = { big: 2 ** 60, tiny: 5e-324, frac: 0.1 + 0.2, neg: -1.5e300, text: "naïve ✓ 😀", lone: "\ud800", ctl: "\u0001\n" }
const back = await tools.echo(sent)
return { same: JSON.stringify(back) === JSON.stringify(sent), back, nullProto: Object.assign(Object.create(null), { k: 1 }) }`)
	if kind, msg := o.failure(); kind != "" {
		t.Fatalf("run failed (%s): %s", kind, msg)
	}
	v := o.value().(map[string]any)
	if v["same"] != true {
		t.Fatalf("values changed on the round trip: %v", v["back"])
	}
	back := v["back"].(map[string]any)
	if back["big"] != float64(1<<60) || back["tiny"] != 5e-324 || back["text"] != "naïve ✓ 😀" {
		t.Fatalf("back = %v", back)
	}
}

func TestRepliesArriveAsJSONValues(t *testing.T) {
	h := start(t, testConfig)
	h.run(1, `const v = await tools.echo({}); return [typeof v.n, v.n === 9007199254740991, v.s.length, v.nested[0].deep]`, toolsNS)
	call := h.recv()
	h.send(map[string]any{"type": "reply", "run": 1, "id": call["id"], "ok": true,
		"value": json.RawMessage(`{"n":9007199254740991,"s":"😀","nested":[{"deep":true}]}`)})
	o := h.finish(1)
	expectValue(t, o, `["number",true,2,true]`)
}

func TestCompletionsMustBeLosslessJSON(t *testing.T) {
	h := start(t, testConfig)
	cases := map[string]string{
		`return { a: undefined }`:                             "undefined at $.a",
		`return [() => 1]`:                                    "a function at $[0]",
		`return { n: 1n }`:                                    "a BigInt at $.n",
		`const a: any = {}; a.self = a; return a`:             "a cycle at $.self",
		`return { x: [NaN] }`:                                 "NaN at $.x[0]",
		`return Infinity`:                                     "an infinite number at $",
		`return -0`:                                           "-0 at $",
		`return new Date(0)`:                                  "a Date at $",
		`return { m: new Map() }`:                             "a Map at $.m",
		`class P { x = 1 }; return new P()`:                   "an object with a class prototype at $",
		`return [1, , 2]`:                                     "an array with holes at $",
		`return { [Symbol("s")]: 1 }`:                         "a symbol-keyed property at $",
		`return { get g() { return 1 } }`:                     "a getter or setter at $.g",
		`return Object.defineProperty({}, "h", { value: 1 })`: "a non-enumerable property at $.h",
		`return { "not ident": [Symbol()] }`:                  `a symbol at $["not ident"][0]`,
		`return new Error("x")`:                               "an Error at $",
	}
	for program, want := range cases {
		expectFailure(t, h.eval(program), kindInvalidOutput, "program completion must be lossless JSON: "+want)
	}
	expectValue(t, h.eval(`return Object.assign(Object.create(null), { ok: [null, true, "s", 1.25, { a: [] }] })`), `{"ok":[null,true,"s",1.25,{"a":[]}]}`)
	expectValue(t, h.eval(`const shared = { k: 1 }; return [shared, shared]`), `[{"k":1},{"k":1}]`)
	expectValue(t, h.eval(`return null`), `null`)
}

func TestDeepCompletionsStopAtTheEngineDepth(t *testing.T) {
	h := start(t, testConfig)
	expectValue(t, h.eval(`let v: any = 0; for (let i = 0; i < 1000; i++) v = [v]; return JSON.stringify(v).length`), `2001`)
	expectFailure(t, h.eval(`let v: any = 0; for (let i = 0; i < 20000; i++) v = [v]; return v`), kindInvalidOutput, "nesting deeper than 10000 levels")
}

func TestConsoleCapture(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
console.log("plain", 1, true, null, undefined)
console.info({ a: 1, b: "two", c: [1, 2, { d: null }] })
console.warn([1, 2, 3], new Map([["k", 1]]), new Set([1]))
console.error(new TypeError("bad"))
console.debug(Object.create(null), 10n, -0, Symbol("s"), function named() {}, class K {})
console.log("a'b", ["x'y"], { "key with space": 1 })
return Object.keys(console)`)
	expectValue(t, o, `["log","info","warn","error","debug"]`)
	want := []string{
		"plain 1 true null undefined",
		"{ a: 1, b: 'two', c: [ 1, 2, { d: null } ] }",
		"[ 1, 2, 3 ] Map(1) { 'k' => 1 } Set(1) { 1 }",
		"TypeError: bad\n    at default (program.ts:5:15)",
		"[Object: null prototype] {} 10n -0 Symbol(s) [Function: named] [class K]",
		`a'b [ "x'y" ] { 'key with space': 1 }`,
	}
	if len(o.logs) != len(want) {
		t.Fatalf("logs = %q", o.logs)
	}
	for i := range want {
		if o.logs[i] != want[i] {
			t.Errorf("log %d = %q, want %q", i, o.logs[i], want[i])
		}
	}
}

func TestLogsAreTruncatedAtTheBudget(t *testing.T) {
	cfg := testConfig
	cfg.MaxLogBytes = 100
	h := start(t, cfg)
	o := h.eval(`
for (let i = 0; i < 10; i++) console.log("line " + i)
console.log("x".repeat(1000))
console.log("after the cut")
return "finished"`)
	expectValue(t, o, `"finished"`)
	if !o.cut {
		t.Fatal("no truncation marker frame")
	}
	// The array's brackets and ten entries of 8 bytes and a comma take 92
	// bytes, which leaves the long line an 8-byte JSON string.
	if len(o.logs) != 11 || o.logs[9] != "line 9" || o.logs[10] != "xxxxxx" {
		t.Fatalf("logs = %q", o.logs)
	}
	if total := len(mustJSON(t, o.logs)); total != cfg.MaxLogBytes {
		t.Fatalf("serialized logs take %d bytes, budget %d", total, cfg.MaxLogBytes)
	}
}

func TestCompletionOverTheValueBudgetIsAnOutputLimit(t *testing.T) {
	cfg := testConfig
	cfg.MaxValueBytes = 1000
	h := start(t, cfg)
	expectValue(t, h.eval(`return "x".repeat(998)`), mustJSON(t, strings.Repeat("x", 998)))
	expectFailure(t, h.eval(`return "x".repeat(999)`), kindOutputLimit, "completion value exceeded 1000 bytes")
	o := h.eval(`throw new Error("y".repeat(5000))`)
	if _, msg := o.failure(); len(mustJSON(t, msg)) > 1000 || !strings.HasSuffix(msg, truncationMarker) {
		t.Fatalf("diagnostic of %d bytes, suffix %q", len(mustJSON(t, msg)), msg[max(0, len(msg)-20):])
	}
}

func TestTooManyPendingCallsIsAProtocolFailure(t *testing.T) {
	cfg := testConfig
	cfg.MaxPendingCalls = 3
	h := start(t, cfg)
	h.run(1, `try { await Promise.all([1, 2, 3, 4].map(n => tools.echo({ n }))) } catch (e) { return "caught" }`, toolsNS)
	for i := 0; i < 3; i++ {
		if f := h.recv(); f["type"] != "call" {
			t.Fatalf("frame %v, want call", f)
		}
	}
	o := h.finish(1)
	expectFailure(t, o, kindProtocol, "more than 3 tool calls pending at once")
}

func TestCancelStopsAnEndlessLoop(t *testing.T) {
	h := start(t, testConfig)
	h.run(1, `for (;;) {}`, nil)
	time.Sleep(50 * time.Millisecond)
	h.send(map[string]any{"type": "cancel", "run": 1})
	h.quiet(200 * time.Millisecond)
	// A cancelled run's late replies are dropped and the sidecar carries on.
	h.send(map[string]any{"type": "reply", "run": 1, "id": 1, "ok": true, "value": 1})
	expectValue(t, h.eval(`return 1`), `1`)
}

func TestCancelStopsARunWaitingForATool(t *testing.T) {
	h := start(t, testConfig)
	h.run(1, `await tools.echo({}); for (;;) {}`, toolsNS)
	call := h.recv()
	h.send(map[string]any{"type": "cancel", "run": 1})
	h.quiet(100 * time.Millisecond)
	h.send(map[string]any{"type": "reply", "run": 1, "id": call["id"], "ok": true, "value": 1})
	h.quiet(100 * time.Millisecond)
	expectValue(t, h.eval(`return 2`), `2`)
}

func TestMemoryLimitStopsTheRun(t *testing.T) {
	cfg := testConfig
	cfg.MemoryLimitBytes = 16 << 20
	h := start(t, cfg)
	o := h.eval(`
const keep: unknown[] = []
try { for (;;) keep.push({ i: keep.length, s: "x" + keep.length }) } catch (e) { return "caught" }`)
	expectFailure(t, o, kindTimeout, "memory budget exceeded: the program allocated more than 16 MiB")
	// The budget covers the whole run, across tool calls.
	o = h.eval(`
const keep: string[] = []
for (let i = 0; i < 64; i++) { await tools.echo({}); for (let j = 0; j < 4000; j++) keep.push({ i, j, s: "y" + j }) }
return keep.length`)
	expectFailure(t, o, kindTimeout, "memory budget exceeded")
	expectValue(t, h.eval(`return "fresh runtime"`), `"fresh runtime"`)
}

func TestConcurrentRuns(t *testing.T) {
	h := start(t, testConfig)
	h.run(1, `const v = await tools.echo({ run: 1 }); return v`, toolsNS)
	h.run(2, `return 2`, nil)
	h.run(3, `for (;;) {}`, nil)
	var call1 map[string]any
	seen := map[float64]map[string]any{}
	for len(seen) < 2 || call1 == nil {
		f := h.recv()
		switch f["type"] {
		case "call":
			call1 = f
		case "done":
			seen[f["run"].(float64)] = f
		}
		if call1 != nil && seen[1] == nil {
			h.send(map[string]any{"type": "reply", "run": 1, "id": call1["id"], "ok": true, "value": call1["rawArgs"]})
		}
	}
	if mustJSON(t, seen[1]["value"]) != `{"run":1}` || mustJSON(t, seen[2]["value"]) != `2` {
		t.Fatalf("results = %v", seen)
	}
	h.send(map[string]any{"type": "cancel", "run": 3})
}

func TestProgramsHaveNoHostAPIs(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
let imported = "resolved"
try { await import("node:fs") } catch (e) { imported = e.name }
return [typeof process, typeof require, typeof setTimeout, typeof fetch, typeof globalThis.console, typeof globalThis.tools, imported]`)
	expectValue(t, o, `["undefined","undefined","undefined","undefined","undefined","undefined","TypeError"]`)
}

func TestProgramWaitingForNothingFails(t *testing.T) {
	h := start(t, testConfig)
	expectFailure(t, h.eval(`await new Promise(() => {})`), kindException, "nothing can settle")
}

func TestThrownValues(t *testing.T) {
	h := start(t, testConfig)
	expectFailure(t, h.eval(`throw "plain string"`), kindException, "plain string")
	expectFailure(t, h.eval(`throw { toString() { return "custom" } }`), kindException, "custom")
	expectFailure(t, h.eval(`queueMicrotask(() => { throw new SyntaxError("in a job") }); await tools.echo({})`), kindException, "SyntaxError: in a job")
}

func TestShutdownStopsRunningPrograms(t *testing.T) {
	h := start(t, testConfig)
	h.run(1, `for (;;) {}`, nil)
	time.Sleep(20 * time.Millisecond)
	// Cleanup closes stdin and requires Serve to return within 5s.
}

func TestRejectsBadFrames(t *testing.T) {
	for name, input := range map[string]string{
		"not a boot frame": `{"type":"run","run":1}` + "\n",
		"other protocol":   `{"type":"boot","protocol":99}` + "\n",
		"bad budgets":      `{"type":"boot","protocol":1}` + "\n",
		"malformed frame": `{"type":"boot","protocol":1,"memoryLimitBytes":1048576,"maxLogBytes":1024,"maxValueBytes":1024,"maxPendingCalls":1,"maxFrameBytes":4096}` + "\n" +
			"{not json\n",
		"oversized frame": `{"type":"boot","protocol":1,"memoryLimitBytes":1048576,"maxLogBytes":1024,"maxValueBytes":1024,"maxPendingCalls":1,"maxFrameBytes":4096}` + "\n" +
			`{"type":"run","run":1,"program":"` + strings.Repeat("x", 5000) + `"}` + "\n",
		"duplicate run id": `{"type":"boot","protocol":1,"memoryLimitBytes":1048576,"maxLogBytes":1024,"maxValueBytes":1024,"maxPendingCalls":1,"maxFrameBytes":4096}` + "\n" +
			`{"type":"run","run":1,"program":"for (;;) {}","namespaces":[]}` + "\n" + `{"type":"run","run":1,"program":"","namespaces":[]}` + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			if err := Serve(strings.NewReader(input), io.Discard); err == nil {
				t.Fatal("Serve accepted the input")
			}
		})
	}
}

func TestRejectsNamesThatAreNotIdentifiers(t *testing.T) {
	h := start(t, testConfig)
	h.run(1, `return 1`, []Namespace{{Global: "x) { evil() } function f(", Names: []string{"a"}}})
	expectFailure(t, h.finish(1), kindProtocol, "is not an identifier or appears twice")
}
