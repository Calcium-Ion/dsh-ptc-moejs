// Runs the same programs on this provider and on dsh's Node runtime
// (per-call mode) through the PtcRuntime service API, and reports where
// their logs, values and failures differ. Both runtimes run under
// workspace-write over a workspace that holds a few helper modules.
//
//   DSH_REPO=/path/to/deepseek-harness node e2e/compare.mjs [filter]
//
// The report is Markdown on stdout: a summary table, then each case that
// differs with both outcomes. A case "differs in the stack" when only the
// stack frames of an error differ.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = process.env.DSH_REPO
if (!repo) throw new Error('set DSH_REPO to a built deepseek-harness checkout')
const filter = process.argv[2]

const work = await mkdtemp(join(tmpdir(), 'ptc-compare-'))
await mkdir(join(work, 'lib'))
await writeFile(join(work, 'helper.ts'), `import { twice } from "./lib/twice.ts"
export interface Named { name: string }
export const greet = (who: Named): string => "hi " + who.name
export { twice }
console.log("helper loaded")
export const meta = { url: import.meta.url, filename: import.meta.filename, dirname: import.meta.dirname }
export const later = (ms: number): Promise<string> => new Promise(resolve => setTimeout(resolve, ms, "waited"))
export const hasTools = typeof (globalThis as any).tools
`)
await writeFile(join(work, 'lib', 'twice.ts'), 'export const twice = (n: number): number => n * 2\n')
await writeFile(join(work, 'plain.mjs'), 'export default "plain module"\n')
await writeFile(join(work, 'data.json'), '{ "a": 1 }\n')
const helperUrl = pathToFileURL(join(work, 'helper.ts')).href

const tools = () => [{
  global: 'tools',
  functions: {
    echo: args => Promise.resolve(args),
    fail: () => Promise.reject(new Error('permission denied')),
    slow: args => new Promise(resolve => setTimeout(resolve, 20, args)),
  },
  errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
}]

/** One console.log case per value. */
const shown = {
  'nested object': '{ a: 1, b: "two", c: [1, 2, 3], d: { e: { f: { g: { h: { i: 1 } } } } } }',
  'long array': 'Array.from({ length: 120 }, (_, i) => i)',
  'long string in an array': '["x".repeat(10050)]',
  'Map': 'new Map([[1, { a: 1 }], ["k", [1, 2]]])',
  'Set': 'new Set([1, "a", { b: 2 }])',
  'class instance': '(() => { class Point { constructor(x, y) { this.x = x; this.y = y } } return new Point(1, 2) })()',
  'null-prototype object': 'Object.assign(Object.create(null), { a: 1 })',
  'Error': 'new RangeError("out of range")',
  'Error in an object': '{ error: new TypeError("bad") }',
  'symbol': 'Symbol("s")',
  'functions': '[() => 1, async function named() {}, class Foo {}, function* gen() {}]',
  'Date': 'new Date(0)',
  'RegExp': '/re+/gi',
  'typed array': 'new Uint8Array([1, 2, 3])',
  'ArrayBuffer': 'new ArrayBuffer(4)',
  'boxed primitives': '[new Number(3), new String("s"), new Boolean(false)]',
  'getter and setter': '{ get g() { return 1 }, set s(v) {}, get both() { return 2 }, set both(v) {} }',
  'circular': '(() => { const o = { name: "o" }; o.self = o; return o })()',
  'numbers': '[-0, 0, 1.5, NaN, Infinity, 10n]',
  'undefined and null': '[undefined, null]',
  'keys that need quotes': '{ "key with space": 1, valid_id: 2, "1abc": 3, 42: 4 }',
  'quotes in strings': `["it's", 'say "hi"', \`both ' and "\`, "tab\\tnew\\nline"]`,
  'sparse array': '[1, , 3]',
  'WeakMap': 'new WeakMap()',
  'Promise': 'Promise.resolve(1)',
  'symbol keys': '{ [Symbol("k")]: 1, plain: 2 }',
  'wide object': '{ alpha: "aaaaaaaaaa", beta: "bbbbbbbbbb", gamma: "cccccccccc", delta: "dddddddddd", epsilon: 1 }',
  'several arguments': '"label", { a: 1 }, [2], 3, "text"',
  'format specifiers': '"%s is %d", "x", 5',
}

const cases = [
  // Values the program returns.
  ['values', 'plain object', 'return { a: 1, b: [1, "x", null, true] }'],
  ['values', 'no value', 'console.log("no return")'],
  ['values', 'BigInt', 'return { items: [{ size: 1n }] }'],
  ['values', 'undefined member', 'return { a: undefined }'],
  ['values', 'NaN', 'return [NaN]'],
  ['values', '-0', 'return -0'],
  ['values', 'Date', 'return new Date(0)'],
  ['values', 'Map', 'return new Map()'],
  ['values', 'cycle', 'const o = {}; o.o = o; return o'],
  ['values', 'class instance', 'class A { x = 1 }\nreturn new A()'],
  ['values', 'deep nesting', 'let v = []\nfor (let i = 0; i < 5000; i++) v = [v]\nreturn v.length'],
  // What console prints.
  ...Object.entries(shown).map(([name, args]) => ['console', name, `console.log(${args})`]),
  ['console', 'levels', 'console.info("info"); console.warn("warn"); console.error("error"); console.debug("debug")'],
  ['console', 'process.stdout.write', 'process.stdout.write("raw\\n")'],
  // Failures.
  ['errors', 'throw Error', 'throw new Error("boom")'],
  ['errors', 'throw string', 'throw "plain string"'],
  ['errors', 'throw object', 'throw { code: 42 }'],
  ['errors', 'ReferenceError', 'return missingName + 1'],
  ['errors', 'syntax error', 'let let = 1'],
  ['errors', 'syntax error position', 'const a = 1\nconst b = (\nreturn a'],
  ['errors', 'enum', 'enum Color { Red }\nreturn Color.Red'],
  ['errors', 'parameter property', 'class P { constructor(private x: number) {} }\nreturn 1'],
  ['errors', 'static import in the program', 'import { join } from "node:path"\nreturn join("a", "b")'],
  ['errors', 'import type in the program', 'import type { Named } from "./helper.ts"\nconst n: Named = { name: "x" }\nreturn n.name'],
  ['errors', 'require', 'return require("node:fs")'],
  ['errors', 'endless loop', 'for (;;) {}', { timeoutMs: 300 }],
  ['errors', 'memory', 'const keep = []\nfor (;;) keep.push(new Array(1e6).fill(1))', { timeoutMs: 30_000 }],
  ['errors', 'unhandled rejection', 'Promise.reject(new Error("nobody listens"))\nawait new Promise(resolve => setTimeout(resolve, 20))\nreturn "finished"'],
  ['errors', 'waiting for nothing', 'await new Promise(() => {})', { timeoutMs: 1500 }],
  // Tools.
  ['tools', 'round trip', 'return await tools.echo({ a: [1, { b: "c" }] })'],
  ['tools', 'caught rejection', 'try { await tools.fail({}) } catch (e) { return [e.name, e.message, e.toolName, e instanceof ToolCallError, Object.keys(e)] }'],
  ['tools', 'uncaught rejection', 'await tools.fail({})'],
  ['tools', 'lossy arguments', 'try { await tools.echo({ a: undefined }) } catch (e) { return e.message }'],
  ['tools', 'no arguments', 'try { await tools.echo() } catch (e) { return e.message }'],
  ['tools', 'concurrent calls', 'return await Promise.all([tools.slow({ n: 1 }), tools.echo({ n: 2 }), tools.slow({ n: 3 })])'],
  // Timers.
  ['timers', 'order', `const order = []
setTimeout(() => order.push("t20"), 20)
setTimeout(() => {
  order.push("t1a")
  Promise.resolve().then(() => order.push("job"))
  setTimeout(() => order.push("t0"), 0)
  setImmediate(() => order.push("immediate"))
}, 1)
setTimeout(() => order.push("t1b"), 1)
await new Promise(resolve => setTimeout(resolve, 40))
return order`],
  ['timers', 'interval', 'let n = 0\nawait new Promise(resolve => { const id = setInterval(() => { if (++n === 3) { clearInterval(id); resolve() } }, 2) })\nreturn n'],
  ['timers', 'arguments and this', 'return await new Promise(resolve => { const t = setTimeout(function (a, b) { resolve([a, b, this === t]) }, 1, "x", 2) })'],
  ['timers', 'Timeout methods', 'const t = setTimeout(() => {}, 1)\nconst facts = [typeof t, t.hasRef(), t.unref() === t, t.hasRef(), t.ref() === t, typeof +t, typeof t[Symbol.toPrimitive]]\nclearTimeout(t)\nreturn facts'],
  ['timers', 'Timeout keys', 'const t = setTimeout(() => {}, 1)\nclearTimeout(t)\nreturn Object.keys(t)'],
  ['timers', 'console.log of a Timeout', 'const t = setTimeout(() => {}, 1)\nclearTimeout(t)\nconsole.log(t)'],
  ['timers', 'clear by id', 'const ran = []\nconst t = setTimeout(() => ran.push(1), 1)\nclearTimeout(+t)\nawait new Promise(r => setTimeout(r, 10))\nreturn ran'],
  ['timers', 'pending at return', 'setTimeout(() => console.log("late"), 1)\nsetInterval(() => console.log("tick"), 1)\nreturn "returned"'],
  ['timers', 'callback throws', 'setTimeout(() => { throw new Error("from a timer") }, 1)\nawait new Promise(resolve => setTimeout(resolve, 50))\nreturn "survived"'],
  ['timers', 'async callback throws', 'setTimeout(async () => { throw new Error("from an async timer") }, 1)\nawait new Promise(resolve => setTimeout(resolve, 50))\nreturn "survived"'],
  ['timers', 'unref keeps nothing alive', 'setTimeout(() => {}, 60_000).unref()\nawait new Promise(() => {})', { timeoutMs: 1500 }],
  ['timers', 'string callback', 'try { setTimeout("code", 1) } catch (e) { return [e.name, e.code, e.message] }'],
  ['timers', 'delay above 2^31-1', 'const started = Date.now()\nawait new Promise(resolve => setTimeout(resolve, 2 ** 31))\nreturn Date.now() - started < 1000'],
  ['timers', '2000 pending timers', 'const ids = []\nfor (let i = 0; i < 2000; i++) ids.push(setTimeout(() => {}, 60_000))\nids.forEach(clearTimeout)\nreturn ids.length'],
  ['timers', 'timers/promises', `const { setTimeout: sleep, setImmediate: tick, setInterval: every, scheduler } = await import("node:timers/promises")
const ticks = []
for await (const v of every(2, "i")) { ticks.push(v); if (ticks.length === 3) break }
return [await sleep(2, "slept"), await tick("ticked"), ticks, (await scheduler.wait(1)) ?? null]`],
  ['timers', 'promisify(setTimeout)', 'const util = await import("node:util")\nreturn await util.promisify(setTimeout)(2, "value")'],
  // Modules.
  ['modules', 'relative file', 'const h = await import("./helper.ts")\nreturn [h.greet({ name: "a" }), h.twice(21)]'],
  ['modules', 'file URL', `const h = await import(${JSON.stringify(helperUrl)})\nreturn [h.greet({ name: "a" }), h.twice(21), h.hasTools, await h.later(1)]`],
  ['modules', 'absolute path', `const h = await import(${JSON.stringify(join(work, 'helper.ts'))})\nreturn h.twice(2)`],
  ['modules', 'import.meta of a module', `const h = await import(${JSON.stringify(helperUrl)})\nreturn h.meta`],
  ['modules', '.mjs file', `return (await import(${JSON.stringify(pathToFileURL(join(work, 'plain.mjs')).href)})).default`],
  ['modules', 'JSON with an attribute', `return (await import(${JSON.stringify(pathToFileURL(join(work, 'data.json')).href)}, { with: { type: "json" } })).default`],
  ['modules', 'missing file', `await import(${JSON.stringify(pathToFileURL(join(work, 'missing.ts')).href)})`],
  ['modules', 'package', 'await import("left-pad-not-installed")'],
  ['modules', 'node:fs', 'const fs = await import("node:fs")\nreturn typeof fs.readFileSync'],
  ['modules', 'data: URL', 'return (await import("data:text/javascript,export default 6 * 7")).default'],
  ['modules', 'bare builtin name', 'const path = await import("path")\nreturn path.default === (await import("node:path")).default'],
  ['modules', 'import.meta in the program', 'return typeof import.meta'],
  // node:path.
  ['node:path', 'posix', `const { posix } = await import("node:path")
return [posix.join("/a/b", "../c", "./d.ts"), posix.relative("/a/b/c", "/a/d"), posix.basename("/x/y.tar.gz", ".gz"), posix.extname("index.d.ts"),
  posix.parse("/home/u/f.txt"), posix.format({ dir: "/x", name: "f", ext: "md" }), posix.normalize("a//b/../c/"), posix.isAbsolute("./x"), posix.sep, posix.delimiter]`],
  ['node:path', 'win32', `const { win32 } = await import("node:path")
return [win32.join("C:\\\\a", "..\\\\b"), win32.resolve("C:\\\\a", "b"), win32.parse("C:\\\\x\\\\y.txt"), win32.normalize("C:/a//b/"), win32.isAbsolute("\\\\\\\\server\\\\share"), win32.toNamespacedPath("C:\\\\x")]`],
  ['node:path', 'resolve against cwd', 'const path = await import("node:path")\nreturn [path.resolve("x") === path.join(path.resolve(), "x"), path.isAbsolute(path.resolve())]'],
  ['node:path', 'bad argument', 'const path = await import("node:path")\ntry { path.join(1) } catch (e) { return [e.name, e.code, e.message] }'],
  // node:util.
  ['node:util', 'format', `const util = await import("node:util")
return [util.format("%s=%d %i %f %j %O %%", "x", 42.5, "7.9", "1.5", { a: [1] }, { b: [2] }), util.format("%s:%s", "only"), util.format(1, "a", { c: 2 }),
  util.format("%d %s %s", -0, 12n, Symbol("s")), util.format("%o", [1, "a"]), util.format("%c%s", "css", "x")]`],
  ['node:util', 'inspect defaults', 'const util = await import("node:util")\nreturn util.inspect({ a: { b: { c: { d: { e: 1 } } } }, list: Array.from({ length: 120 }, (_, i) => i) })'],
  ['node:util', 'inspect options', 'const util = await import("node:util")\nreturn [util.inspect({ a: { b: { c: {} } } }, { depth: 0 }), util.inspect("s", { colors: true }), util.inspect([1, 2], { compact: false })]'],
  ['node:util', 'isDeepStrictEqual', `const { isDeepStrictEqual: eq } = await import("node:util")
return [eq({ a: [1, { b: new Set([1, 2]) }] }, { a: [1, { b: new Set([2, 1]) }] }), eq([1], ["1"]), eq(0, -0), eq(NaN, NaN), eq(new Date(1), new Date(1)),
  eq(new Map([[{ k: 1 }, 1]]), new Map([[{ k: 1 }, 1]])), eq(Object.create(null), {}), eq([1, , 3], [1, undefined, 3])]`],
  ['node:util', 'types', `const { types } = await import("node:util")
return [types.isDate(new Date()), types.isRegExp(/x/), types.isPromise(Promise.resolve()), types.isMap(new Map()), types.isSet({}),
  types.isUint8Array(new Uint8Array()), types.isAsyncFunction(async () => {}), types.isGeneratorFunction(function* () {}), types.isNativeError(new TypeError()), types.isBoxedPrimitive(new Number(1))]`],
  ['node:util', 'promisify and callbackify', `const util = await import("node:util")
const add = util.promisify((a, b, cb) => cb(null, a + b))
const back = util.callbackify(async (x) => x * 2)
const viaCallback = await new Promise(resolve => back(21, (err, v) => resolve([err, v])))
return [await add(1, 2), viaCallback]`],
  ['node:util', 'exports', 'const util = await import("node:util")\nreturn Object.keys(util).filter(k => k !== "default").sort()'],
  // node:vm.
  ['node:vm', 'script in a context', `const vm = await import("node:vm")
const context = vm.createContext({ base: 10 })
const result = new vm.Script("base * 2 + (typeof console)").runInContext(context)
return [result, vm.isContext(context), vm.runInNewContext("x + 1", { x: 1 })]`],
  ['node:vm', 'globals of a context', `const vm = await import("node:vm")
return vm.runInNewContext("[typeof setTimeout, typeof console, typeof Array, this.x]", { x: 7 })`],
  ['node:vm', 'var in a context', `const vm = await import("node:vm")
const context = vm.createContext({})
vm.runInContext("var declared = 1; assigned = 2", context)
return [context.declared, context.assigned, typeof globalThis.assigned]`],
  ['node:vm', 'timeout option', `const vm = await import("node:vm")
try { vm.runInNewContext("for (;;) {}", {}, { timeout: 50 }) } catch (e) { return e.message }`, { timeoutMs: 3000 }],
  // The globals a program sees.
  ['globals', 'typeof', `return Object.fromEntries(["process", "require", "Buffer", "fetch", "setTimeout", "setImmediate", "queueMicrotask", "structuredClone", "TextEncoder",
  "URL", "URLSearchParams", "AbortController", "Event", "performance", "crypto", "atob", "Intl", "WebAssembly", "WeakRef", "FinalizationRegistry", "SharedArrayBuffer"].map(n => [n, typeof globalThis[n]]))`],
  ['globals', 'process.env', 'return Object.keys(process.env)'],
  ['globals', 'own globals', 'return Object.keys(globalThis).sort()'],
  ['globals', 'console is global', 'return [globalThis.console === console, Object.keys(globalThis).includes("console")]'],
  ['globals', 'time zone', 'return [new Date(0).getTimezoneOffset(), new Date(0).toString()]'],
  ['globals', 'language features', `const r = {}
const t = (name, f) => { try { r[name] = f() } catch (e) { r[name] = e.name } }
t("toSorted", () => [3, 1, 2].toSorted())
t("groupBy", () => Object.keys(Object.groupBy([1, 2, 3], x => x % 2 ? "odd" : "even")))
t("withResolvers", () => typeof Promise.withResolvers)
t("Set union", () => [...new Set([1]).union(new Set([2]))])
t("Iterator.from", () => typeof Iterator.from)
t("RegExp.escape", () => RegExp.escape("a.b"))
t("lookbehind", () => "a1b2".match(/(?<=b)\\d/)[0])
t("v flag", () => /[\\p{L}--[a-z]]/v.test("A"))
t("localeCompare", () => ["b", "a", "ä"].sort((a, b) => a.localeCompare(b)))
t("toLocaleString", () => (1234567.891).toLocaleString())
t("Intl.NumberFormat", () => new Intl.NumberFormat("en-US").format(1234.5))
t("structuredClone Map", () => structuredClone(new Map([[1, 2]])).get(1))
t("Error.captureStackTrace", () => typeof Error.captureStackTrace)
t("Array.fromAsync", () => typeof Array.fromAsync)
return r`],
  ['globals', 'error stack', 'function inner() { return new Error("where").stack }\nreturn inner().split("\\n").slice(0, 2)'],
  // TypeScript the programs use.
  ['typescript', 'erasable syntax', `type Pair<T> = [T, T]
interface Box { v: number }
const p: Pair<number> = [1, 2]
const b = { v: 3 } satisfies Box
const c = <const>["x"]
const d = (p as unknown as number[]).length
function f<T extends Box>(x: T): number { return x.v! }
abstract class Shape { abstract area(): number }
class Sq extends Shape { area() { return 4 } }
return [p, b.v, c, d, f(b), new Sq().area()]`],
  ['typescript', 'erasable syntax without parameter properties', `type Pair<T> = [T, T]
const p: Pair<number> = [1, 2]
const b = { v: 3 } satisfies { v: number }
abstract class Shape { abstract area(): number; declare tag: string }
class Sq extends Shape { private n: number; constructor(n = 2) { super(); this.n = n } override area() { return this.n * this.n } }
let maybe: string | undefined
return [p, b.v, new Sq().area(), maybe?.length ?? 0]`],
  ['typescript', 'decorator', 'function dec(_: unknown) {}\n@dec class A {}\nreturn 1'],
]

async function mount(runtimeName) {
  const moejs = runtimeName === 'moejs'
  const base = moejs ? pluginDir : join(repo, 'packages/ptc-runtime/ptc-runtime-node')
  const runtimeEntry = join(base, 'lib/index.js')
  const require = createRequire(join(base, 'package.json'))
  const load = async name => (await import(pathToFileURL(require.resolve(name)).href))
  const { Context } = await load('@deepseek-ai/cordis')
  const { default: Runtime } = await import(pathToFileURL(runtimeEntry).href)
  const ctx = new Context()
  await ctx.plugin((await load('@deepseek-ai/dsh-session')).default)
  await ctx.plugin((await load('@deepseek-ai/dsh-fs-local')).default)
  if (!moejs) await ctx.plugin((await load('@deepseek-ai/dsh-subprocess-local')).default)
  await ctx.plugin((await load('@deepseek-ai/dsh-sandbox-local')).default, {})
  await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default)
  await ctx.plugin((await load('@deepseek-ai/dsh-sandbox-policy')).default, { mode: 'workspace-write', workspaceRoot: work })
  await ctx.plugin(Runtime, {})
  return ctx
}

const normalize = text => text.replaceAll(pathToFileURL(work).href, 'file://<work>').replaceAll(work, '<work>')
const withoutStack = text => text.split('\n').filter(line => !/^\s+at /.test(line)).join('\n')

function outcome(result) {
  const out = {}
  if (result.logs.length > 0) out.logs = result.logs.map(normalize)
  if (result.value !== undefined) out.value = JSON.parse(normalize(JSON.stringify(result.value)))
  if (result.error !== undefined) out.error = { kind: result.error.kind, message: normalize(result.error.message) }
  return out
}

const runtimes = { moejs: await mount('moejs'), node: await mount('node') }
const rows = []
for (const [category, name, program, options = {}] of cases) {
  if (filter !== undefined && !`${category} ${name}`.includes(filter)) continue
  const results = {}
  for (const [runtimeName, ctx] of Object.entries(runtimes)) {
    const runtime = ctx.ptcRuntime
    const started = performance.now()
    const result = await runtime.run(runtime.resolve({ program, bindings: tools(), cwd: work, timeoutMs: options.timeoutMs ?? 10_000 }))
    results[runtimeName] = { ...outcome(result), ms: Math.round(performance.now() - started) }
  }
  const strip = ({ ms: _ms, ...rest }) => rest
  const a = JSON.stringify(strip(results.moejs))
  const b = JSON.stringify(strip(results.node))
  const verdict = a === b ? 'same' : withoutStack(a) === withoutStack(b) ? 'differs in the stack' : 'differs'
  rows.push({ category, name, program, verdict, results })
  console.error(`${verdict.padEnd(21)} ${category} / ${name}`)
}
for (const ctx of Object.values(runtimes)) await ctx.fiber.dispose()
await rm(work, { recursive: true, force: true })

const counts = rows.reduce((acc, row) => ({ ...acc, [row.verdict]: (acc[row.verdict] ?? 0) + 1 }), {})
console.log(`# moejs and Node PTC compared\n\n${rows.length} programs: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.\n`)
console.log('| category | program | result |\n|---|---|---|')
for (const row of rows) console.log(`| ${row.category} | ${row.name} | ${row.verdict} |`)
for (const row of rows.filter(r => r.verdict !== 'same')) {
  console.log(`\n## ${row.category} / ${row.name} (${row.verdict})\n\n\`\`\`ts\n${row.program}\n\`\`\``)
  for (const [runtimeName, result] of Object.entries(row.results)) {
    console.log(`\n${runtimeName} (${result.ms} ms):\n\n\`\`\`json\n${JSON.stringify((({ ms, ...rest }) => rest)(result), null, 1).slice(0, 3000)}\n\`\`\``)
  }
}
