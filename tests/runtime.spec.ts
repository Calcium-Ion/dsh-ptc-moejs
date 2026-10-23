/**
 * The runtime against the real sidecar, following the checks of dsh's Python
 * provider: budgets, deadlines and aborts, disposal, lossless JSON in both
 * directions, binding names and a crashed sidecar.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import type { PtcBindingFunction, PtcBindingNamespace, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Config } from '../src/index.ts'
import { LogLedger } from '../src/protocol.ts'
import { internals, mountRuntime, sidecarProcess } from './setup.ts'

async function setup(config: Config = {}) {
  const { ctx, fiber, runtime } = await mountRuntime(config)
  // The sandbox facts of a result have their own suite.
  const run = async (request: PtcRunRequest) => {
    const { sandbox: _sandbox, ...result } = await runtime.run(runtime.resolve(request))
    return result
  }
  const sidecar = () => sidecarProcess(runtime)
  return { ctx, fiber, runtime, run, sidecar }
}

/** Whether a process has exited within a short wait. */
async function exited(handle: { done: Promise<unknown> }): Promise<boolean> {
  const timeout = new Promise<false>((resolve) => { setTimeout(() => { resolve(false) }, 1_000) })
  return await Promise.race([handle.done.then(() => true, () => true), timeout])
}

function tools(functions: Record<string, PtcBindingFunction>, errorClass = true): PtcBindingNamespace[] {
  return [{ global: 'tools', functions, ...errorClass ? { errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } } : {} }]
}

const echo: PtcBindingFunction = args => Promise.resolve(args as never)
const never: PtcBindingFunction = () => new Promise(() => {})

describe('programs and bindings', () => {
  it('runs erasable TypeScript that calls tools and returns an object', async () => {
    const { run } = await setup()
    const calls: unknown[] = []
    const record = (name: string): PtcBindingFunction => (args) => { calls.push([name, args]); return Promise.resolve({ ok: name }) }
    const result = await run({
      program: `
type Hit = { ok: string }
const a: Hit = await tools.read({ path: "a.txt" })
const [b, c] = await Promise.all([tools.grep({ pattern: "x" }), tools.bash({ command: "ls" })])
console.log("three calls done")
return { a: a.ok, b: b.ok, c: c.ok, n: 3 }`,
      bindings: tools({ read: record('read'), grep: record('grep'), bash: record('bash') }),
    })
    expect(result).toEqual({ logs: ['three calls done'], value: { a: 'read', b: 'grep', c: 'bash', n: 3 } })
    expect(calls).toEqual([['read', { path: 'a.txt' }], ['grep', { pattern: 'x' }], ['bash', { command: 'ls' }]])
  })

  it('settles a run without a return value with no value', async () => {
    const { run } = await setup()
    expect(await run({ program: 'console.log("hi")', bindings: [] })).toEqual({ logs: ['hi'] })
    expect(await run({ program: 'return null', bindings: [] })).toEqual({ logs: [], value: null })
  })

  it('raises the namespace error class for a rejected call', async () => {
    const { run } = await setup()
    const fail: PtcBindingFunction = () => Promise.reject(new Error('permission denied'))
    const caught = await run({
      program: `try { await tools.write({}) } catch (e) {
  console.log(e)
  return { isClass: e instanceof ToolCallError, isError: e instanceof Error, name: e.name, tool: e.toolName,
    message: e.message, text: String(e), stack: e.stack.split("\\n")[0], keys: Object.keys(e) }
}`,
      bindings: tools({ write: fail }),
    })
    expect(caught.value).toEqual({
      isClass: true, isError: true, name: 'ToolCallError', tool: 'write', message: 'permission denied',
      text: 'ToolCallError: permission denied', stack: 'ToolCallError: permission denied', keys: ['name', 'toolName'],
    })
    expect(caught.logs[0]).toMatch(/^ToolCallError: permission denied\n/)
    const uncaught = await run({ program: 'await tools.write({})', bindings: tools({ write: fail }) })
    expect(uncaught.error?.kind).toBe('exception')
    expect(uncaught.error?.message).toMatch(/^ToolCallError \(tools\.write\): permission denied\n\s+at /)
    const plain = await run({ program: 'try { await tools.write({}) } catch (e) { return [e.name, e.message, typeof ToolCallError] }', bindings: tools({ write: fail }, false) })
    expect(plain.value).toEqual(['Error', 'permission denied', 'undefined'])
  })

  it('passes description requirements through to the tool', async () => {
    const { run } = await setup()
    const calls: unknown[] = []
    const bash: PtcBindingFunction = async (args) => {
      calls.push(args)
      if (!Object.hasOwn(args as object, 'description')) {
        throw new Error('invalid arguments: missing required property "description"')
      }
      return null
    }
    const missing = await run({ program: 'await tools.bash({ command: "pwd" })', bindings: tools({ bash }) })
    expect(missing.error?.message).toMatch(/^ToolCallError \(tools\.bash\): invalid arguments: missing required property "description"/)
    expect(calls).toEqual([{ command: 'pwd' }])
    const supplied = await run({
      program: 'return await tools.bash({ command: "pwd", description: "Show current directory" })',
      bindings: tools({ bash }),
    })
    expect(supplied).toEqual({ logs: [], value: null })
    expect(calls).toEqual([{ command: 'pwd' }, { command: 'pwd', description: 'Show current directory' }])
  })

  it('names a custom binding when its caught error is rethrown', async () => {
    const { run } = await setup()
    const result = await run({
      program: `try { await api["run.command"]({}) } catch (e) {
  console.log(e instanceof ApiError, e["operation-name"], e.message)
  throw e
}`,
      bindings: [{
        global: 'api',
        functions: { 'run.command': () => Promise.reject(new Error('command failed')) },
        errorClass: { name: 'ApiError', memberNameProperty: 'operation-name' },
      }],
    })
    expect(result.logs).toEqual(['true run.command command failed'])
    expect(result.error?.message).toMatch(/^ApiError \(api\["run\.command"\]\): command failed\n\s+at /)
  })

  it('reports a thrown non-Error and a lossy resolution as rejections', async () => {
    const { run } = await setup()
    const result = await run({
      program: `const out = []
for (const name of ["throwsString", "nan", "fn", "missing"]) {
  try { await tools[name]({}); out.push("resolved") } catch (e) { out.push(e.message) }
}
return out`,
      bindings: tools({
        throwsString: () => Promise.reject('plain reason'),
        nan: () => Promise.resolve(Number.NaN),
        fn: () => Promise.resolve((() => 1) as never),
        missing: () => Promise.resolve(undefined as never),
      }),
    })
    expect(result.value).toEqual(['plain reason', 'binding resolution must be lossless JSON', 'binding resolution must be lossless JSON', 'binding resolution must be lossless JSON'])
  })

  it('keeps names such as __proto__ and constructor as ordinary own properties', async () => {
    const { run } = await setup()
    const named = (name: string): PtcBindingFunction => () => Promise.resolve(name)
    const result = await run({
      program: `return {
  proto: Object.getPrototypeOf(tools),
  keys: Object.keys(tools),
  values: [await tools.__proto__({}), await tools.constructor({}), await tools.toString({}), await tools.hasOwnProperty({})],
}`,
      bindings: tools({ ['__proto__']: named('__proto__'), constructor: named('constructor'), toString: named('toString'), hasOwnProperty: named('hasOwnProperty') } as Record<string, PtcBindingFunction>),
    })
    expect(result.value).toEqual({ proto: null, keys: ['__proto__', 'constructor', 'toString', 'hasOwnProperty'], values: ['__proto__', 'constructor', 'toString', 'hasOwnProperty'] })
  })

  it.each(['console', '__dsh_main__', '__builtins__', '__name__', '__debug__'])('refuses the reserved global %s', async (global) => {
    const { run } = await setup()
    await expect(run({ program: 'return 1', bindings: [{ global, functions: {} }] })).rejects.toThrow('reserved binding global')
    await expect(run({ program: 'return 1', bindings: [{ global: 'tools', functions: {}, errorClass: { name: global, memberNameProperty: 'toolName' } }] })).rejects.toThrow('reserved binding global')
  })

  it('rejects arguments that are not lossless JSON before they reach the tool', async () => {
    const { run } = await setup()
    let calls = 0
    const counted: PtcBindingFunction = () => { calls += 1; return Promise.resolve(null) }
    const result = await run({
      program: `const out = []
for (const arg of [undefined, { x: NaN }, { f() {} }, new Date(0)]) {
  try { await tools.count(arg) } catch (e) { out.push(e.toolName + ": " + e.message) }
}
return out`,
      bindings: tools({ count: counted }),
    })
    expect(calls).toBe(0)
    expect(result.value).toEqual([
      'count: binding arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)',
      'count: binding arguments must be lossless JSON: NaN at $.x',
      'count: binding arguments must be lossless JSON: a function at $.f',
      'count: binding arguments must be lossless JSON: a Date at $',
    ])
  })

  it('carries values that round-trip exactly in both directions', async () => {
    const { run } = await setup()
    const value = { big: 2 ** 60, tiny: 5e-324, sum: 0.1 + 0.2, text: 'naïve ✓ 😀', lone: '\ud800', ctl: '\u0001\n', deep: [[[[{ k: [] }]]]] }
    const result = await run({ program: 'const v = await tools.echo(await tools.source({})); return { v, same: JSON.stringify(v) }', bindings: tools({ echo, source: () => Promise.resolve(value) }) })
    expect(result.value).toEqual({ v: value, same: JSON.stringify(value) })
  })

  it('passes a large tool result and refuses one over the frame budget', async () => {
    const { run } = await setup({ maxFrameBytes: 1024 * 1024, maxLogBytes: 1024, maxValueBytes: 1024 })
    const sized = (n: number): PtcBindingFunction => () => Promise.resolve('z'.repeat(n))
    const result = await run({
      program: 'const ok = (await tools.fits({})).length; try { await tools.huge({}) } catch (e) { return [ok, e.message] }',
      bindings: tools({ fits: sized(900_000), huge: sized(2_000_000) }),
    })
    expect(result.value).toEqual([900_000, `binding resolution exceeds ${1024 * 1024 - 256} bytes of JSON`])
  })

  it('caps a huge rejection message so the reply fits in one frame', async () => {
    const { run } = await setup({ maxFrameBytes: 1024 * 1024, maxLogBytes: 1024, maxValueBytes: 1024 })
    const huge: PtcBindingFunction = () => Promise.reject(new Error('e'.repeat(3_000_000)))
    const result = await run({ program: 'try { await tools.huge({}) } catch (e) { return [e.message.length, e.message.endsWith("… [truncated]")] }', bindings: tools({ huge }) })
    expect(result.error).toBeUndefined()
    const [length, marked] = result.value as [number, boolean]
    expect(length).toBeLessThanOrEqual(1024)
    expect(marked).toBe(true)
    expect((await run({ program: 'return "still serving"', bindings: [] })).value).toBe('still serving')
  })

  it('reports syntax errors and non-erasable TypeScript at the program position', async () => {
    const { run } = await setup()
    expect((await run({ program: 'const x: = 1', bindings: [] })).error).toEqual({ kind: 'exception', message: "SyntaxError: Unexpected token '=' (program.ts:1:10)" })
    const enumResult = await run({ program: 'const a = 1\nenum E { A }\nreturn a', bindings: [] })
    expect(enumResult.error?.kind).toBe('exception')
    expect(enumResult.error?.message).toContain('enum is not supported')
    expect(enumResult.error?.message).toContain('(program.ts:2:1)')
  })

  it('exposes no Node APIs beyond the timers and the built-in modules', async () => {
    const { run } = await setup()
    const result = await run({
      program: `let imported = "resolved"
try { await import("node:fs") } catch (e) { imported = e.message }
return [typeof process, typeof require, typeof Buffer, typeof fetch, typeof setTimeout, imported]`,
      bindings: [],
    })
    expect(result.value).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'function',
      'Cannot import "node:fs": this runtime has no node:fs; the program reaches files, commands and the network through its tools, and the built-in modules are node:path, node:util, node:timers, node:timers/promises and node:vm'])
  })

  it('waits for timers between tool calls', async () => {
    const { run } = await setup()
    const calls: number[] = []
    const result = await run({
      program: `const { setTimeout: sleep } = await import("node:timers/promises")
const results = []
for (let attempt = 1; attempt <= 3; attempt++) {
  const reply = await tools.flaky({ attempt })
  results.push(reply.ok)
  if (reply.ok) break
  await sleep(5 * attempt)
}
return results`,
      bindings: tools({ flaky: (args) => { calls.push(Date.now()); return Promise.resolve({ ok: (args as { attempt: number }).attempt === 3 }) } }),
    })
    expect(result).toEqual({ logs: [], value: [false, false, true] })
    expect(calls[2]! - calls[0]!).toBeGreaterThanOrEqual(14)
  })

  it('stops a program that waits for a timer at its deadline', async () => {
    const { run } = await setup()
    const started = Date.now()
    const result = await run({ program: 'await new Promise(resolve => setTimeout(resolve, 60_000))', bindings: [], timeoutMs: 100 })
    expect(result.error).toEqual({ kind: 'timeout', message: 'execution deadline reached (100ms)' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('imports TypeScript helpers from the working directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), '.dsh-ptc-moejs-modules-'))
    onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
    await mkdir(join(dir, 'lib'))
    await writeFile(join(dir, 'helpers.ts'), `import { words } from './lib/words.ts'
import { basename } from 'node:path'
export async function summarize(tools: { read(args: { path: string }): Promise<{ text: string }> }, path: string) {
  const { text } = await tools.read({ path })
  console.log('summarized', basename(path))
  return { file: basename(path), words: words(text) }
}
`)
    await writeFile(join(dir, 'lib', 'words.ts'), 'export const words = (text: string): number => text.split(/\\s+/).filter(Boolean).length\n')
    const { run } = await setup()
    const result = await run({
      program: 'const { summarize } = await import("./helpers.ts")\nreturn await summarize(tools, "notes/a.txt")',
      bindings: tools({ read: () => Promise.resolve({ text: 'three short words' }) }),
      cwd: dir,
    })
    expect(result).toEqual({ logs: ['summarized a.txt'], value: { file: 'a.txt', words: 3 } })
    const missing = await run({ program: 'await import("./nope.ts")', bindings: [], cwd: dir })
    expect(missing.error?.message).toContain(`Cannot import "./nope.ts": ${join(dir, 'nope.ts')} does not exist`)
  })

  it('imports no files when dsh\'s execution world is another host', async () => {
    const ctx = new Context()
    await ctx.plugin(FileSystem)
    vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    const { runtime } = await mountRuntime({}, {}, ctx)
    const result = await runtime.run(runtime.resolve({ program: 'await import("./helpers.ts")', bindings: [], cwd: tmpdir() }))
    expect(result.error?.message).toContain('this run cannot import files, because its working directory is on another host')
    expect(runtime.executionInstructions).not.toContain('helpers.ts')
    const builtin = await runtime.run(runtime.resolve({ program: 'return (await import("node:path")).posix.join("a", "b")', bindings: [], cwd: tmpdir() }))
    expect(builtin.value).toBe('a/b')
  })

  it('fails a program waiting for a promise nothing can settle', async () => {
    const { run } = await setup()
    const result = await run({ program: 'await new Promise(() => {})', bindings: [] })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('nothing can settle')
  })
})

describe('budgets and termination', () => {
  it('stops an endless loop at the deadline', async () => {
    const { run } = await setup()
    const started = Date.now()
    const result = await run({ program: 'console.log("before the loop"); for (;;) {}', bindings: [], timeoutMs: 300 })
    expect(result).toEqual({ logs: ['before the loop'], error: { kind: 'timeout', message: 'execution deadline reached (300ms)' } })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(await run({ program: 'return "next run"', bindings: [] })).toEqual({ logs: [], value: 'next run' })
  })

  it('stops an endless loop on abort', async () => {
    const { run } = await setup()
    const controller = new AbortController()
    const pending = run({ program: 'for (;;) {}', bindings: [], signal: controller.signal })
    setTimeout(() => { controller.abort('user cancelled') }, 100)
    expect(await pending).toEqual({ logs: [], error: { kind: 'abort', message: 'user cancelled' } })
    expect((await run({ program: 'return 1', bindings: [] })).value).toBe(1)
  })

  it('stops a run waiting for a tool that never answers', async () => {
    const { run } = await setup()
    const controller = new AbortController()
    let called!: () => void
    const reached = new Promise<void>((resolve) => { called = resolve })
    const pending = run({ program: 'await tools.wait({})', bindings: tools({ wait: () => { called(); return never({}) } }), signal: controller.signal })
    await reached
    controller.abort(new Error('run_code settled'))
    expect(await pending).toEqual({ logs: [], error: { kind: 'abort', message: 'run_code settled' } })
  })

  it('settles an already aborted request without running it', async () => {
    const { run } = await setup()
    let calls = 0
    const result = await run({ program: 'await tools.count({})', bindings: tools({ count: () => { calls += 1; return Promise.resolve(null) } }), signal: AbortSignal.abort('too late') })
    expect(result).toEqual({ logs: [], error: { kind: 'abort', message: 'too late' } })
    expect(calls).toBe(0)
  })

  it('keeps logs in order and truncates them at the budget', async () => {
    const { run } = await setup({ maxLogBytes: 64 })
    const result = await run({
      program: `for (let i = 0; i < 5; i++) { console.log("line", i); await tools.echo({}) }
console.error("x".repeat(100))
console.log("dropped")
return "done"`,
      bindings: tools({ echo }),
    })
    expect(result.value).toBe('done')
    expect(result.logs.slice(0, 5)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4'])
    expect(result.logs.at(-1)).toBe(LogLedger.marker(64))
    expect(result.logs.length).toBe(7)
    expect(result.logs[5]).toMatch(/^x+$/)
    expect(JSON.stringify(result.logs.slice(0, -1)).length).toBeLessThanOrEqual(64)
  })

  it.each([
    ['undefined inside an object', 'return { a: undefined }', 'undefined at $.a'],
    ['a function', 'return [function f() {}]', 'a function at $[0]'],
    ['a BigInt', 'return { n: 12n }', 'a BigInt at $.n'],
    ['a cycle', 'const a: any = { b: {} }; a.b.back = a; return a', 'a cycle at $.b.back'],
    ['NaN', 'return { x: 0 / 0 }', 'NaN at $.x'],
    ['Infinity', 'return [1 / 0]', 'an infinite number at $[0]'],
    ['-0', 'return { z: -0 }', '-0 at $.z'],
    ['a Map', 'return new Map([[1, 2]])', 'a Map at $'],
    ['a class instance', 'class C { x = 1 }; return { c: new C() }', 'an object with a class prototype at $.c'],
  ])('fails a completion with %s as invalid-output', async (_label, program, where) => {
    const { run } = await setup()
    expect((await run({ program, bindings: [] })).error).toEqual({ kind: 'invalid-output', message: `program completion must be lossless JSON: ${where}` })
  })

  it('fails a completion over the value budget as output-limit', async () => {
    const { run } = await setup({ maxValueBytes: 100 })
    expect((await run({ program: 'return "v".repeat(98)', bindings: [] })).value).toBe('v'.repeat(98))
    expect(await run({ program: 'console.log("kept"); return "v".repeat(99)', bindings: [] })).toEqual({ logs: ['kept'], error: { kind: 'output-limit', message: 'completion value exceeded 100 bytes' } })
  })

  it('stops a run past its memory budget, which the program cannot catch', async () => {
    const { run } = await setup({ memoryLimitMb: 16 })
    const result = await run({ program: 'const keep: unknown[] = []; try { for (;;) keep.push({ i: keep.length, s: "m" + keep.length }) } catch { return "caught" }', bindings: [] })
    expect(result.error).toEqual({ kind: 'timeout', message: 'memory budget exceeded: the program allocated more than 16 MiB (memoryLimitMb)' })
    expect((await run({ program: 'return "x".repeat(1024).length', bindings: [] })).value).toBe(1024)
  })

  it('fails a run with more tool calls in flight than maxPendingCalls', async () => {
    const { run } = await setup({ maxPendingCalls: 4 })
    const result = await run({ program: 'await Promise.all(Array.from({ length: 5 }, () => tools.wait({})))', bindings: tools({ wait: never }) })
    expect(result.error).toEqual({ kind: 'protocol', message: 'the program had more than 4 tool calls pending at once (maxPendingCalls)' })
  })
})

describe('the sidecar', () => {
  it('runs many programs at once, one of them endless', async () => {
    const { run } = await setup()
    const delayed: PtcBindingFunction = args => new Promise(resolve => setTimeout(() => { resolve(args as never) }, Math.random() * 20))
    const endless = run({ program: 'for (;;) {}', bindings: [], timeoutMs: 2_000 })
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => run({
      program: `const a = await tools.delayed({ i: ${i} }); const b = await tools.delayed({ j: a.i * 2 }); return [a.i, b.j]`,
      bindings: tools({ delayed }),
    })))
    expect(results.map(r => r.value)).toEqual(Array.from({ length: 40 }, (_, i) => [i, i * 2]))
    expect((await endless).error?.kind).toBe('timeout')
  })

  it('stops in-flight runs on disposal and ends the process', async () => {
    const { fiber, run, sidecar } = await setup()
    let called!: () => void
    const reached = new Promise<void>((resolve) => { called = resolve })
    const looping = run({ program: 'for (;;) {}', bindings: [], timeoutMs: null })
    const waiting = run({ program: 'await tools.wait({})', bindings: tools({ wait: () => { called(); return never({}) } }), timeoutMs: null })
    await reached
    const child = sidecar()!
    await fiber.dispose()
    expect(await looping).toEqual({ logs: [], error: { kind: 'abort', message: 'runtime disposed' } })
    expect(await waiting).toEqual({ logs: [], error: { kind: 'abort', message: 'runtime disposed' } })
    expect(await exited(child)).toBe(true)
  })

  it('reports a crashed sidecar as worker-exit and starts a new one', async () => {
    const { run, sidecar } = await setup()
    let called!: () => void
    const reached = new Promise<void>((resolve) => { called = resolve })
    const pending = run({ program: 'await tools.wait({})', bindings: tools({ wait: () => { called(); return never({}) } }) })
    await reached
    const first = sidecar()!
    first.terminate()
    const result = await pending
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toMatch(/^the moejs sidecar exited /)
    expect(await run({ program: 'return "recovered"', bindings: [] })).toEqual({ logs: [], value: 'recovered' })
    expect(sidecar()).not.toBe(first)
  })

  it('reports a sidecar that cannot start as worker-exit', async () => {
    const { runtime, run, sidecar } = await setup()
    await run({ program: 'return 1', bindings: [] })
    const first = sidecar()!
    first.terminate()
    await first.done
    internals(runtime).binary = '/nonexistent/moejs-ptc'
    const result = await run({ program: 'return 1', bindings: [] })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('/nonexistent/moejs-ptc')
  })
})
