package sidecar

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// evalIn runs a program whose working directory is dir, on this host.
func (h *harness) evalIn(dir, program string) outcome {
	h.t.Helper()
	h.runs++
	h.send(map[string]any{"type": "run", "run": 1000 + h.runs, "program": program, "namespaces": toolsNS, "cwd": dir, "moduleRoot": dir})
	return h.finish(1000 + h.runs)
}

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestImportsTypeScriptFilesOfTheWorkingDirectory(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"helpers.ts": `import { scale } from "./lib/scale.ts"
import { label } from "./lib/label.mjs"
export interface Point { x: number; y: number }
export function double(p: Point): Point { return { x: scale(p.x), y: scale(p.y) } }
export { label }
console.log("helpers loaded")`,
		"lib/scale.ts":  "export const scale = (n: number): number => n * 2\n",
		"lib/label.mjs": "\uFEFFexport const label = (s) => `[${s}]`\n",
	})
	h := start(t, testConfig)
	o := h.evalIn(dir, `
const { double, label } = await import("./helpers.ts")
const again = await import("./helpers.ts")
return [double({ x: 1, y: 2 }), label("a"), again.double === double]`)
	expectValue(t, o, `[{"x":2,"y":4},"[a]",true]`)
	if len(o.logs) != 1 || o.logs[0] != "helpers loaded" {
		t.Fatalf("logs = %q", o.logs)
	}
}

func TestImportedModulesShareOneInstanceAndSeeImportMeta(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"counter.js": `let n = 0
export const inc = () => ++n
export const meta = { url: import.meta.url, filename: import.meta.filename, dirname: import.meta.dirname }
export const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms, ms))`,
	})
	h := start(t, testConfig)
	o := h.evalIn(dir, `
const a = await import("./counter.js")
const b = await import("`+filepath.ToSlash(filepath.Join(dir, "counter.js"))+`")
a.inc()
return [b.inc(), a.meta, await a.wait(5)]`)
	path := filepath.Join(dir, "counter.js")
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	if runtime.GOOS == "windows" {
		u.Path = "/" + u.Path
	}
	expectValue(t, o, mustJSON(t, []any{2, map[string]any{"url": u.String(), "filename": path, "dirname": dir}, 5}))
}

func TestImportsByFileURL(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"answer.ts": "export default 42 as number\n"})
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(filepath.Join(dir, "answer.ts"))}
	if runtime.GOOS == "windows" {
		u.Path = "/" + u.Path
	}
	h := start(t, testConfig)
	expectValue(t, h.evalIn(dir, `return (await import("`+u.String()+`")).default`), `42`)
}

func TestImportFailuresSayWhy(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "work")
	writeFiles(t, parent, map[string]string{
		"outside.ts":       "export const secret = 1\n",
		"work/data.json":   "{}",
		"work/notes.txt":   "hi",
		"work/lib/util.ts": "export const u = 1\n",
		"work/bad.ts":      "export const x = \n\nlet let = 1\n",
		"work/big.js":      "// " + strings.Repeat("x", maxModuleBytes) + "\n",
		"work/deep.ts":     `export { y } from "./missing.ts"`,
	})
	h := start(t, testConfig)
	for program, want := range map[string]string{
		`await import("./nope.ts")`:          `Cannot import "./nope.ts": ` + filepath.Join(dir, "nope.ts") + ` does not exist`,
		`await import("../outside.ts")`:      `is outside the working directory ` + dir,
		`await import("./data.json")`:        `JSON modules are not supported; read the file with a tool and parse it with JSON.parse`,
		`await import("./notes.txt")`:        `only .ts, .mts, .js and .mjs files can be imported, with their extension in the specifier`,
		`await import("./lib/util.js")`:      filepath.Join(dir, "lib", "util.js") + ` does not exist; import "./util.ts" by its own name`,
		`await import("./bad.ts")`:           `SyntaxError: ` + filepath.Join(dir, "bad.ts") + `:3:`,
		`await import("./big.js")`:           `is larger than 1048576 bytes`,
		`await import("./deep.ts")`:          `cannot resolve module "./missing.ts"`,
		`await import("lodash")`:             `Cannot import "lodash": packages are not available`,
		`await import("node:fs")`:            `Cannot import "node:fs": this runtime has no node:fs; the program reaches files, commands and the network through its tools`,
		`await import("data:text/plain,hi")`: `only data: URLs of text/javascript can be imported`,
	} {
		expectFailure(t, h.evalIn(dir, program), kindException, want)
	}
	// A run whose working directory is on another host imports no files.
	expectFailure(t, h.eval(`await import("./helpers.ts")`), kindException, "this run cannot import files, because its working directory is on another host")
}

func TestARunImportsALimitedNumberOfFiles(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{}
	for i := 0; i <= maxRunModules; i++ {
		files[fmt.Sprintf("m%d.js", i)] = fmt.Sprintf("export default %d\n", i)
	}
	writeFiles(t, dir, files)
	h := start(t, testConfig)
	o := h.evalIn(dir, fmt.Sprintf(`
let sum = 0
for (let i = 0; i < %d; i++) sum += (await import("./m" + i + ".js")).default
try { await import("./m%d.js") } catch (e) { return [sum, e.message] }`, maxRunModules, maxRunModules))
	expectValue(t, o, mustJSON(t, []any{maxRunModules * (maxRunModules - 1) / 2, fmt.Sprintf(`Cannot import "./m%d.js": a run may import at most %d files`, maxRunModules, maxRunModules)}))
}

func TestEachRunReadsTheFileAgain(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"v.ts": "export const v = 1\n"})
	h := start(t, testConfig)
	expectValue(t, h.evalIn(dir, `return (await import("./v.ts")).v`), `1`)
	writeFiles(t, dir, map[string]string{"v.ts": "export const v = 2\n"})
	expectValue(t, h.evalIn(dir, `return (await import("./v.ts")).v`), `2`)
	writeFiles(t, dir, map[string]string{"v.ts": "export const v = 1\n"})
	expectValue(t, h.evalIn(dir, `return (await import("./v.ts")).v`), `1`)
}

func TestModuleCacheEvictsTheLeastRecentlyUsed(t *testing.T) {
	var c moduleCache
	key := func(i int) moduleKey { return moduleKey{path: fmt.Sprint(i)} }
	for i := 0; i < 5; i++ {
		c.put(key(i), nil, moduleCacheBytes/4)
	}
	if len(c.entries) != 4 || c.bytes != moduleCacheBytes {
		t.Fatalf("entries = %d, bytes = %d", len(c.entries), c.bytes)
	}
	if _, ok := c.entries[key(0)]; ok {
		t.Fatal("the oldest entry was kept")
	}
}

func TestStaticImportInTheProgramPointsToImport(t *testing.T) {
	h := start(t, testConfig)
	expectFailure(t, h.eval(`import { join } from "node:path"
return join("a", "b")`), kindException, "SyntaxError: 'import' and 'export' may only appear at the top level; the program is the body of an async function: it loads modules with `await import(...)` and returns its result (program.ts:1:1)")
}

func TestDataURLModules(t *testing.T) {
	h := start(t, testConfig)
	source := `import { basename } from "node:path"; export default basename("/a/b.txt")`
	o := h.eval(`
const plain = await import("data:text/javascript,` + url.PathEscape(source) + `")
const encoded = await import("data:text/javascript;base64,` + base64.StdEncoding.EncodeToString([]byte("export const n = 7")) + `")
let refused
try { await import("data:text/javascript,import './x.ts'") } catch (e) { refused = e.message }
return [plain.default, encoded.n, refused.endsWith('cannot resolve module "./x.ts": Cannot import "./x.ts": a module of data:text/javascript cannot import files')]`)
	expectValue(t, o, `["b.txt",7,true]`)
}

func TestNodePath(t *testing.T) {
	h := start(t, testConfig)
	dir := t.TempDir()
	o := h.evalIn(dir, `
const path = await import("node:path")
const { posix, win32 } = path
const bare = await import("path")
const viaPosix = await import("node:path/posix")
return [
  posix.join("/a/b", "../c", "./d.ts"), posix.relative("/a/b/c", "/a/d"), posix.basename("/x/y.tar.gz", ".gz"),
  posix.extname("index.d.ts"), posix.parse("/home/u/f.txt"), posix.format({ dir: "/x", name: "f", ext: "md" }),
  posix.normalize("a//b/../c/"), posix.isAbsolute("./x"), win32.join("C:\\a", "..\\b"), win32.resolve("C:\\a", "b"),
  path.resolve("rel") === path.join(path.resolve(), "rel"), path.default === path.posix || path.default === path.win32,
  bare.default === path.default, viaPosix.join === posix.join, typeof path.sep,
]`)
	expectValue(t, o, `["/a/c/d.ts","../../d","y.tar",".ts",{"base":"f.txt","dir":"/home/u","ext":".txt","name":"f","root":"/"},"/x/f.md","a/c/",false,"C:\\b","C:\\a\\b",true,true,true,true,"string"]`)
	o = h.evalIn(dir, `const { resolve } = await import("node:path"); return resolve("x")`)
	expectValue(t, o, mustJSON(t, filepath.Join(dir, "x")))
	expectValue(t, h.eval(`try { (await import("node:path")).join(1) } catch (e) { return [e.code, e.message] }`),
		`["ERR_INVALID_ARG_TYPE","The \"path\" argument must be of type string. Received type number (1)"]`)
}

func TestNodeUtil(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const util = await import("node:util")
const sleep = util.promisify(setTimeout)
const started = Date.now()
const slept = await sleep(5, "ok")
const legacy = util.promisify((a, cb) => cb(null, a + 1))
return [
  util.format("%s=%d %i %f %j %O %%", "x", 42.5, "7.9", "1.5", { a: [1] }, [1, "a"], "extra", { b: 1 }),
  util.format("%s:%s", "only"), util.format(1, "a", { c: 2 }), util.format("%d", -0), util.format("%s", 12n),
  util.inspect({ a: { b: { c: {} } }, s: "q" }), util.inspect(new Map([[1, 2]])),
  util.isDeepStrictEqual({ a: [1, { b: new Set([1, 2]) }], d: new Date(5) }, { a: [1, { b: new Set([2, 1]) }], d: new Date(5) }),
  util.isDeepStrictEqual([1, 2], [1, "2"]), util.isDeepStrictEqual(new Map([[{ k: 1 }, "v"]]), new Map([[{ k: 1 }, "v"]])),
  util.isDeepStrictEqual(0, -0), util.isDeepStrictEqual(NaN, NaN),
  slept, Date.now() - started >= 4, await legacy(1),
  util.types.isDate(new Date()), util.types.isRegExp(/x/), util.types.isPromise(Promise.resolve()), util.types.isMap({}),
  util.types.isUint8Array(new Uint8Array(1)), util.types.isAsyncFunction(async () => {}),
  util.stripVTControlCharacters("\u001b[31mred\u001b[0m"), typeof util.TextEncoder, typeof util.default.format,
]`)
	expectValue(t, o, `["x=42.5 7 1.5 {\"a\":[1]} [ 1, 'a' ] % extra { b: 1 }","only:%s","1 a { c: 2 }","-0","12n","{ a: { b: { c: {} } }, s: 'q' }","Map(1) { 1 =\u003e 2 }",true,false,true,false,true,"ok",true,2,true,true,true,false,true,true,"red","function","function"]`)
}

func TestNodeTimers(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const timers = await import("node:timers")
const { setTimeout: sleep, setImmediate: tick, setInterval: every, scheduler } = await import("node:timers/promises")
const order = []
const ticks = []
for await (const v of every(2, "i")) { ticks.push(v); if (ticks.length === 3) break }
await Promise.all([sleep(4, "late").then(v => order.push(v)), tick("now").then(v => order.push(v)), scheduler.wait(1)])
let refused
try { await sleep(1, null, { signal: {} }) } catch (e) { refused = e.message }
return [timers.setTimeout === setTimeout, timers.promises.setTimeout === sleep, order, ticks, refused]`)
	expectValue(t, o, `[true,true,["now","late"],["i","i","i"],"The \"signal\" option is not available in this runtime, which has no AbortSignal"]`)
}

func TestNodeVM(t *testing.T) {
	h := start(t, testConfig)
	o := h.eval(`
const vm = await import("node:vm")
const context = vm.createContext({ base: 10 })
context.add = (n) => context.base + n
const script = new vm.Script("(async () => { base = base + 1; return [add(1), this === globalThis, typeof console] })()", { filename: "s.js" })
const result = await script.runInContext(context, { timeout: 100 })
let syntax
try { new vm.Script("let let = 1") } catch (e) { syntax = e.name }
let notContext
try { script.runInContext({}) } catch (e) { notContext = e.code }
return [
  result, context.base, syntax, notContext, vm.isContext(context), vm.isContext({}),
  vm.runInNewContext("x * 2", { x: 21 }), vm.runInThisContext("typeof setTimeout"),
  vm.compileFunction("return a + b", ["a", "b"])(2, 3), vm.runInContext("base", context),
]`)
	expectValue(t, o, `[[12,false,"object"],11,"SyntaxError","ERR_INVALID_ARG_TYPE",true,false,42,"function",5,11]`)
}
