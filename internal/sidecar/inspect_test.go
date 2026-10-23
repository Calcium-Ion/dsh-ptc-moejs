package sidecar

import (
	"strings"
	"testing"
)

// consoleCases are rendered by Node v22.23.1's util.inspect with the options
// of dsh's Node runtime: { depth: 4, maxArrayLength: 100, maxStringLength: 10000 }.
var consoleCases = []struct{ expr, want string }{
	{"Array.from({ length: 26 }, (_, i) => i * 37)", "[\n    0,  37,  74, 111, 148, 185,\n  222, 259, 296, 333, 370, 407,\n  444, 481, 518, 555, 592, 629,\n  666, 703, 740, 777, 814, 851,\n  888, 925\n]"},
	{"Array.from({ length: 30 }, (_, i) => \"item\" + i)", "[\n  'item0',  'item1',  'item2',\n  'item3',  'item4',  'item5',\n  'item6',  'item7',  'item8',\n  'item9',  'item10', 'item11',\n  'item12', 'item13', 'item14',\n  'item15', 'item16', 'item17',\n  'item18', 'item19', 'item20',\n  'item21', 'item22', 'item23',\n  'item24', 'item25', 'item26',\n  'item27', 'item28', 'item29'\n]"},
	{"[\"apple\", \"banana\", \"cherry\", \"date\", \"elderberry\", \"fig\", \"grape\", \"honeydew\"]", "[\n  'apple',\n  'banana',\n  'cherry',\n  'date',\n  'elderberry',\n  'fig',\n  'grape',\n  'honeydew'\n]"},
	{"[\"中文\", \"字符串\", \"测试\", \"数据\", \"列表\", \"分组\", \"对齐\"]", "[\n  '中文', '字符串',\n  '测试', '数据',\n  '列表', '分组',\n  '对齐'\n]"},
	{"Array.from({ length: 120 }, (_, i) => i)", "[\n   0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11,\n  12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,\n  24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,\n  36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,\n  48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,\n  60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71,\n  72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83,\n  84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95,\n  96, 97, 98, 99,\n  ... 20 more items\n]"},
	{"{ a: 1, b: \"two\", c: [1, 2, 3], d: { e: { f: { g: { h: { i: 1 } } } } } }", "{\n  a: 1,\n  b: 'two',\n  c: [ 1, 2, 3 ],\n  d: {\n    e: { f: { g: { h: [Object] } } }\n  }\n}"},
	{"{ alpha: \"aaaaaaaaaa\", beta: \"bbbbbbbbbb\", gamma: \"cccccccccc\", delta: \"dddddddddd\", epsilon: 1 }", "{\n  alpha: 'aaaaaaaaaa',\n  beta: 'bbbbbbbbbb',\n  gamma: 'cccccccccc',\n  delta: 'dddddddddd',\n  epsilon: 1\n}"},
	{"{ a: { b: { c: 1 } }, list: [1, 2, 3, 4, 5, 6, 7], x: \"y\" }", "{\n  a: { b: { c: 1 } },\n  list: [\n    1, 2, 3, 4,\n    5, 6, 7\n  ],\n  x: 'y'\n}"},
	{"{ \"key with space\": 1, valid_id: 2, \"1abc\": 3, 42: 4, $dollar: 5 }", "{ '42': 4, 'key with space': 1, valid_id: 2, '1abc': 3, '$dollar': 5 }"},
	{"[1, , 3, , , 6]", "[ 1, <1 empty item>, 3, <2 empty items>, 6 ]"},
	{"(() => { const o = { name: \"o\" }; o.self = o; return o })()", "<ref *1> { name: 'o', self: [Circular *1] }"},
	{"(() => { const a = { n: \"a\" }; const b = { n: \"b\", a }; a.b = b; return [a, b] })()", "[\n  <ref *1> { n: 'a', b: { n: 'b', a: [Circular *1] } },\n  <ref *2> { n: 'b', a: <ref *1> { n: 'a', b: [Circular *2] } }\n]"},
	{"new Map([[1, { a: 1 }], [\"k\", [1, 2]]])", "Map(2) { 1 => { a: 1 }, 'k' => [ 1, 2 ] }"},
	{"new Set([1, \"a\", { b: 2 }])", "Set(3) { 1, 'a', { b: 2 } }"},
	{"(() => { class Point { constructor(x, y) { this.x = x; this.y = y } } return new Point(1, 2) })()", "Point { x: 1, y: 2 }"},
	{"Object.assign(Object.create(null), { a: 1 })", "[Object: null prototype] { a: 1 }"},
	{"[() => 1, async function named() {}, class Foo {}, function* gen() {}]", "[\n  [Function (anonymous)],\n  [AsyncFunction: named],\n  [class Foo],\n  [GeneratorFunction: gen]\n]"},
	{"[new Number(3), new String(\"s\"), new Boolean(false)]", "[ [Number: 3], [String: 's'], [Boolean: false] ]"},
	{"{ get g() { return 1 }, set s(v) {}, get both() { return 2 }, set both(v) {} }", "{ g: [Getter], s: [Setter], both: [Getter/Setter] }"},
	{"[\"it's\", 'say \"hi\"', `both ' and \"`, \"tab\\tnew\\nline\", \"\\u0001\\u007f\"]", "[ \"it's\", 'say \"hi\"', `both ' and \"`, 'tab\\tnew\\nline', '\\x01\\x7F' ]"},
	{"{ text: \"first line of a long text\\nsecond line of the long text\\nthird line\" }", "{\n  text: 'first line of a long text\\nsecond line of the long text\\nthird line'\n}"},
	{"new ArrayBuffer(4)", "ArrayBuffer { [Uint8Contents]: <00 00 00 00>, [byteLength]: 4 }"},
	{"new DataView(new ArrayBuffer(2))", "DataView {\n  [byteLength]: 2,\n  [byteOffset]: 0,\n  [buffer]: ArrayBuffer { [Uint8Contents]: <00 00>, [byteLength]: 2 }\n}"},
	{"new Uint8Array([1, 2, 3])", "Uint8Array(3) [ 1, 2, 3 ]"},
	{"Promise.resolve({ a: 1 })", "Promise { { a: 1 } }"},
	{"new Promise(() => {})", "Promise { <pending> }"},
	{"(() => { const p = Promise.reject(3); p.catch(() => {}); return p })()", "Promise { <rejected> 3 }"},
	{"{ [Symbol.for(\"nodejs.util.inspect.custom\")]() { return \"custom!\" } }", "custom!"},
	{"{ [Symbol.toStringTag]: \"Tagged\", a: 1 }", "{ a: 1, [Symbol(Symbol.toStringTag)]: 'Tagged' }"},
	{"[new Date(0), /re+/gi, Symbol(\"s\"), 10n, -0, null, undefined]", "[\n  1970-01-01T00:00:00.000Z,\n  /re+/gi,\n  Symbol(s),\n  10n,\n  -0,\n  null,\n  undefined\n]"},
}

func TestConsoleRendersValuesAsNodeDoes(t *testing.T) {
	h := start(t, testConfig)
	for _, c := range consoleCases {
		o := h.eval("console.log(" + c.expr + ")")
		if kind, msg := o.failure(); kind != "" {
			t.Errorf("%s: run failed (%s): %s", c.expr, kind, msg)
			continue
		}
		if len(o.logs) != 1 || o.logs[0] != c.want {
			t.Errorf("%s:\n got %q\nwant %q", c.expr, o.logs, c.want)
		}
	}
}

func TestUtilInspectTakesNodesOptions(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const util = await import("node:util")
const nested = { a: { b: { c: { d: { e: 1 } } } } }
return [
  util.inspect(nested), util.inspect(nested, { depth: 0 }), util.inspect(nested, false, 1),
  util.inspect([1, 2], { compact: false }), util.inspect({ c: 1, a: 2, b: 3 }, { sorted: true }),
  util.inspect([1, 2, 3], { showHidden: true }), util.inspect("s", { colors: true }),
  util.inspect(1234567.891, { numericSeparator: true }), util.inspect({ get g() { return 2 } }, { getters: true }),
  util.format("%s %o", { a: { b: { c: 1 } } }, [1, "a"]), util.inspect.custom === Symbol.for("nodejs.util.inspect.custom"),
]`)
	expectValue(t, o, mustJSON(t, []any{
		"{ a: { b: { c: [Object] } } }", "{ a: [Object] }", "{ a: { b: [Object] } }",
		"[\n  1,\n  2\n]", "{ a: 2, b: 3, c: 1 }", "[ 1, 2, 3, [length]: 3 ]", "\u001b[32m's'\u001b[39m",
		"1_234_567.891", "{ g: [Getter: 2] }", "{ a: [Object] } [ 1, 'a', [length]: 2 ]", true,
	}))
}

func TestStackColumnsOnTheFirstLineAreTheProgramsOwn(t *testing.T) {
	h := start(t, testConfig)
	expectFailure(t, h.eval(`throw new Error("boom")`), kindException, "Error: boom\n    at default (program.ts:1:7)")
	o := h.eval(`console.log(new RangeError("first")); console.log({ e: new Error("nested") })
console.log(new Error("second line"))`)
	want := []string{
		"RangeError: first\n    at default (program.ts:1:13)",
		"{\n  e: Error: nested\n      at default (program.ts:1:56)\n}",
		"Error: second line\n    at default (program.ts:2:13)",
	}
	if strings.Join(o.logs, "|") != strings.Join(want, "|") {
		t.Fatalf("logs = %q, want %q", o.logs, want)
	}
	if got := fixColumns("    at f (/work/program.ts:1:70)\n    at program.ts:1:5", 63); got != "    at f (/work/program.ts:1:70)\n    at program.ts:1:1" {
		t.Fatalf("fixColumns = %q", got)
	}
}

func TestUnhandledRejectionsEndTheRun(t *testing.T) {
	h := start(t, testConfig)
	expectFailure(t, h.eval(`Promise.reject(new Error("nobody listens"))
await new Promise(resolve => setTimeout(resolve, 5))
return "finished"`), kindException, "Uncaught (in promise) Error: nobody listens\n    at default (program.ts:1:16)")
	expectFailure(t, h.eval(`tools.fail({})
await tools.echo({})
return "finished"`), kindException, "Uncaught (in promise) ToolCallError (tools.fail): it failed")
	expectFailure(t, h.eval(`setTimeout(async () => { throw new Error("from an async timer") }, 1)
await new Promise(resolve => setTimeout(resolve, 20))`), kindException, "Uncaught (in promise) Error: from an async timer")
	expectFailure(t, h.eval(`Promise.reject(42)
await tools.echo({})`), kindException, "Uncaught (in promise) 42")
	// A handler added before the callback's jobs run out handles it.
	expectValue(t, h.eval(`const p = Promise.reject(new Error("later"))
await null
try { await p } catch (e) { return e.message }`), `"later"`)
	expectValue(t, h.eval(`const p = tools.fail({})
p.catch(() => {})
await tools.echo({})
return "handled"`), `"handled"`)
	// The program's own result comes first, as Node's runtime reports it before the process ends.
	expectValue(t, h.eval(`Promise.reject(new Error("late")); return 1`), `1`)
}

func TestTimersWarnAboutOverflowingDelays(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`await new Promise(resolve => setTimeout(resolve, 2 ** 31)); setTimeout(() => {}, NaN); return "done"`)
	expectValue(t, o, `"done"`)
	if len(o.logs) != 1 || o.logs[0] != "TimeoutOverflowWarning: 2147483648 does not fit into a 32-bit signed integer.\nTimeout duration was set to 1." {
		t.Fatalf("logs = %q", o.logs)
	}
}

func TestImportAttributesSayHowToReadJSON(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"config.ts": `import data from "./data.json" with { type: "json" }
export default data`})
	h := start(t, testConfig)
	hint := "this runtime has no JSON modules: read the file with a tool and parse it with JSON.parse"
	expectFailure(t, h.evalIn(dir, `return (await import("./data.json", { with: { type: "json" } })).default`), kindException, "SyntaxError: import attribute syntax is not supported yet; "+hint+" (program.ts:1:")
	expectFailure(t, h.evalIn(dir, `return (await import("./config.ts")).default`), kindException, hint)
}
