import type { PtcBindingNamespace } from '@deepseek-ai/dsh-ptc-runtime'
import { describe, expect, it } from 'vitest'
import { binaryPackage, resolveBinary } from '../src/binary.ts'
import { resolveConfig, validateBindings } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { LogLedger, TRUNCATION_MARKER, capMessage, failureResult, jsonBytes, parseFrame, successResult } from '../src/protocol.ts'
import { mountRuntime } from './setup.ts'

const mount = (config: Config = {}) => mountRuntime(config)

const noop = () => Promise.resolve(null)

describe('configuration', () => {
  it('fills in the defaults', () => {
    expect(resolveConfig({})).toEqual({
      timeoutMs: 120_000,
      maxTimeoutMs: 600_000,
      memoryLimitMb: 512,
      maxLogBytes: 16 * 1024 * 1024,
      maxValueBytes: 16 * 1024 * 1024,
      maxPendingCalls: 128,
      maxFrameBytes: 64 * 1024 * 1024,
    })
  })

  it.each<[Config, string]>([
    [{ timeoutMs: 0 }, 'timeoutMs must be a positive finite number'],
    [{ maxTimeoutMs: -1 }, 'maxTimeoutMs must be a positive finite number'],
    [{ memoryLimitMb: Number.NaN }, 'memoryLimitMb must be a positive finite number'],
    [{ maxPendingCalls: Number.POSITIVE_INFINITY }, 'maxPendingCalls must be a positive finite number'],
    [{ timeoutMs: 2 ** 31 }, 'timeoutMs must be at most 2147483647'],
    [{ maxLogBytes: 1.5 }, 'maxLogBytes must be an integer'],
    [{ memoryLimitMb: 2 ** 50 }, 'memoryLimitMb is too large'],
    [{ maxFrameBytes: 2 ** 30 }, 'maxFrameBytes must be at most'],
    [{ maxFrameBytes: 4096, maxLogBytes: 4000 }, 'maxLogBytes must fit in a frame'],
    [{ maxFrameBytes: 4096, maxLogBytes: 1024, maxValueBytes: 4000 }, 'maxValueBytes must fit in a frame'],
  ])('rejects %o', (config, message) => {
    expect(() => resolveConfig(config)).toThrow(message)
  })

  it('rejects an invalid configuration at load', async () => {
    await expect(mountRuntime({ maxPendingCalls: 0 })).rejects.toThrow('maxPendingCalls must be a positive finite number')
  })
})

describe('resolve', () => {
  it('supplies the working directory and the default deadline', async () => {
    const { runtime } = await mount({ timeoutMs: 5_000, maxTimeoutMs: 60_000 })
    expect(runtime.timeout).toEqual({ defaultMs: 5_000, maxMs: 60_000 })
    const spec = runtime.resolve({ program: 'return 1', bindings: [] })
    expect(spec.cwd).toBe(process.cwd())
    expect(spec.timeoutMs).toBe(5_000)
    expect(runtime.resolve({ program: '', bindings: [], cwd: '/srv/work' }).cwd).toBe('/srv/work')
  })

  it('caps a requested deadline and keeps an explicit null', async () => {
    const { runtime } = await mount({ maxTimeoutMs: 60_000 })
    expect(runtime.resolve({ program: '', bindings: [], timeoutMs: 1_000 }).timeoutMs).toBe(1_000)
    expect(runtime.resolve({ program: '', bindings: [], timeoutMs: 10_000_000 }).timeoutMs).toBe(60_000)
    expect(runtime.resolve({ program: '', bindings: [], timeoutMs: null }).timeoutMs).toBeNull()
  })

  it('defaults to the smaller of the default and the maximum', async () => {
    const { runtime } = await mount({ timeoutMs: 90_000, maxTimeoutMs: 30_000 })
    expect(runtime.timeout).toEqual({ defaultMs: 30_000, maxMs: 30_000 })
    expect(runtime.resolve({ program: '', bindings: [] }).timeoutMs).toBe(30_000)
  })

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('rejects the deadline %s', async (timeoutMs) => {
    const { runtime } = await mount()
    expect(() => runtime.resolve({ program: '', bindings: [], timeoutMs })).toThrow('timeoutMs must be a positive finite number')
  })

  it('rejects a relative directory', async () => {
    const { runtime } = await mount()
    expect(() => runtime.resolve({ program: '', bindings: [], cwd: 'relative/dir' })).toThrow('cwd must be absolute')
  })

  it('fills in the deployment policy and keeps a policy the caller resolved, as the Node runtime does', async () => {
    const { runtime } = await mount()
    expect(runtime.resolve({ program: '', bindings: [] }).sandboxPolicy).toEqual({ mode: 'danger-full-access', workspaceRoot: process.cwd() })
    const policy = { mode: 'read-only', workspaceRoot: '/srv/work' } as const
    const spec = runtime.resolve({ program: '', bindings: [], sandboxPolicy: policy })
    expect(spec.sandboxPolicy).toBe(policy)
    expect(spec.cwd).toBe('/srv/work')
  })

  it('refuses requests after disposal', async () => {
    const { runtime, fiber } = await mount()
    const spec = runtime.resolve({ program: 'return 1', bindings: [] })
    await fiber.dispose()
    expect(() => runtime.resolve({ program: '', bindings: [] })).toThrow('resolve after disposal')
    await expect(runtime.run(spec)).rejects.toThrow('run after disposal')
  })

  it('rejects a spec that resolve did not produce', async () => {
    const { runtime } = await mount({ maxTimeoutMs: 1_000 })
    const sandboxPolicy = { mode: 'danger-full-access', workspaceRoot: '/' } as const
    await expect(runtime.run({ program: '', bindings: [], cwd: '/', timeoutMs: 10 })).rejects.toThrow('run requires a resolved sandbox policy')
    await expect(runtime.run({ program: '', bindings: [], cwd: 'here', timeoutMs: 10, sandboxPolicy })).rejects.toThrow('run requires a resolved program, cwd and timeout')
    await expect(runtime.run({ program: '', bindings: [], cwd: '/', timeoutMs: 5_000, sandboxPolicy })).rejects.toThrow('run requires a resolved program, cwd and timeout')
  })

  it('describes itself as a TypeScript function-body runtime under the deployment file mode', async () => {
    const { runtime } = await mount({ memoryLimitMb: 256 })
    expect(runtime.language).toBe('typescript')
    expect(runtime.isolation).toBe('process')
    expect(runtime.programFormat).toBe('function-body')
    expect(runtime.sandboxMode).toBe('danger-full-access')
    expect(runtime.executionInstructions).toContain('Node APIs, require, import, process, timers and direct file or network access are absent')
    expect(runtime.executionInstructions).toContain('sandbox_permissions on run_code does not let it do more')
    expect(runtime.executionInstructions).toContain('retry that call with sandbox_permissions and justification in its own arguments')
    expect(runtime.executionInstructions).toContain('256 MiB')
  })
})

describe('validateBindings', () => {
  const ns = (global: string, errorClass?: PtcBindingNamespace['errorClass']): PtcBindingNamespace => ({
    global, functions: { run: noop }, ...errorClass === undefined ? {} : { errorClass },
  })

  it('reads each function once into a null-prototype record', () => {
    const functions = Object.create(null) as Record<string, unknown>
    let reads = 0
    Object.defineProperty(functions, '__proto__', { enumerable: true, get: () => { reads += 1; return noop } })
    functions.constructor = noop
    functions.notAFunction = 42
    const result = validateBindings([{ global: 'tools', functions: functions as PtcBindingNamespace['functions'] }])
    const tools = result.get('tools')!.functions
    expect(Object.getPrototypeOf(tools)).toBeNull()
    expect(Object.keys(tools)).toEqual(['__proto__', 'constructor'])
    expect(tools['__proto__']).toBe(noop)
    expect(reads).toBe(1)
  })

  it.each([
    ['$tools', 'is not a usable identifier'],
    ['1tools', 'is not a usable identifier'],
    ['class', 'is not a usable identifier'],
    ['lambda', 'is not a usable identifier'],
    ['console', 'reserved binding global'],
    ['__dsh_main__', 'reserved binding global'],
    ['__builtins__', 'reserved binding global'],
    ['__name__', 'reserved binding global'],
    ['__debug__', 'reserved binding global'],
  ])('rejects the global %s', (global, message) => {
    expect(() => validateBindings([ns(global)])).toThrow(message)
  })

  it('rejects names injected twice', () => {
    expect(() => validateBindings([ns('tools'), ns('tools')])).toThrow('duplicate injected global "tools"')
    expect(() => validateBindings([ns('tools', { name: 'tools', memberNameProperty: 'toolName' })])).toThrow('duplicate injected global')
    expect(() => validateBindings([ns('a', { name: 'E', memberNameProperty: 'm' }), ns('b', { name: 'E', memberNameProperty: 'm' })])).toThrow('duplicate injected global "E"')
  })

  it.each([
    [{ name: 'console', memberNameProperty: 'toolName' }, 'reserved binding global'],
    [{ name: 'Tool Error', memberNameProperty: 'toolName' }, 'is not a usable identifier'],
    [{ name: 'ToolCallError', memberNameProperty: '' }, 'is not usable'],
    [{ name: 'ToolCallError', memberNameProperty: 'message' }, 'is not usable'],
    [{ name: 'ToolCallError', memberNameProperty: 'add_note' }, 'is not usable'],
    [{ name: 'ToolCallError', memberNameProperty: '__cause__' }, 'is not usable'],
  ])('rejects the error class %o', (errorClass, message) => {
    expect(() => validateBindings([ns('tools', errorClass)])).toThrow(message)
  })

  it('accepts member properties that are not identifiers', () => {
    const result = validateBindings([ns('tools', { name: 'ToolCallError', memberNameProperty: 'tool-name' })])
    expect(result.get('tools')!.errorClass).toEqual({ name: 'ToolCallError', memberNameProperty: 'tool-name' })
  })
})

describe('parseFrame', () => {
  it('rebuilds each frame type and drops unknown fields', () => {
    expect(parseFrame('{"type":"boot-ack","protocol":1,"extra":true}')).toEqual({ type: 'boot-ack', protocol: 1 })
    expect(parseFrame('{"type":"call","run":3,"id":1,"global":"tools","name":"bash","args":{"a":[1]},"x":1}'))
      .toEqual({ type: 'call', run: 3, id: 1, global: 'tools', name: 'bash', args: { a: [1] } })
    expect(parseFrame('{"type":"log","run":3,"text":"hi"}')).toEqual({ type: 'log', run: 3, text: 'hi', truncated: false })
    expect(parseFrame('{"type":"log","run":3,"text":"","truncated":true}')).toEqual({ type: 'log', run: 3, text: '', truncated: true })
    expect(parseFrame('{"type":"log","run":3,"text":"","truncated":"yes"}')).toEqual({ type: 'log', run: 3, text: '', truncated: false })
    expect(parseFrame('{"type":"done","run":3}')).toEqual({ type: 'done', run: 3 })
    expect(parseFrame('{"type":"done","run":3,"value":null}')).toEqual({ type: 'done', run: 3, value: null })
    expect(parseFrame('{"type":"done","run":3,"error":{"kind":"exception","message":"boom","stack":"x"}}'))
      .toEqual({ type: 'done', run: 3, error: { kind: 'exception', message: 'boom' } })
  })

  it.each([
    ['not json', 'a frame is not JSON'],
    ['[1]', 'a frame is not an object'],
    ['null', 'a frame is not an object'],
    ['{"type":"boot-ack"}', 'invalid boot-ack frame'],
    ['{"type":"log","text":"x"}', 'a frame has no valid run id'],
    ['{"type":"log","run":0,"text":"x"}', 'a frame has no valid run id'],
    ['{"type":"log","run":1.5,"text":"x"}', 'a frame has no valid run id'],
    ['{"type":"log","run":1}', 'invalid log frame'],
    ['{"type":"call","run":1,"id":0,"global":"t","name":"n","args":{}}', 'invalid call frame'],
    ['{"type":"call","run":1,"id":1,"global":"t","name":"n"}', 'call arguments are not lossless JSON'],
    ['{"type":"call","run":1,"id":1,"global":"t","name":"n","args":{"x":-0}}', 'call arguments are not lossless JSON'],
    ['{"type":"call","run":1,"id":1,"global":"t","name":"n","args":[1e400]}', 'call arguments are not lossless JSON'],
    ['{"type":"done","run":1,"value":-0}', 'a completion value is not lossless JSON'],
    ['{"type":"done","run":1,"value":1,"error":{"kind":"exception","message":"x"}}', 'invalid done frame'],
    ['{"type":"done","run":1,"error":{"kind":"abort","message":"x"}}', 'invalid done frame'],
    ['{"type":"done","run":1,"error":{"kind":"exception"}}', 'invalid done frame'],
    ['{"type":"reply","run":1}', 'a frame has an unknown type'],
  ])('rejects %s', (line, message) => {
    expect(parseFrame(line)).toBe(message)
  })
})

describe('results', () => {
  it('admits logs up to the serialized budget and marks the cut once', () => {
    const ledger = new LogLedger(20)
    ledger.admit('abc') // ["abc"] is 7 bytes
    ledger.admit('defgh') // ["abc","defgh"] is 15 bytes
    ledger.admit('ij') // would make 20 bytes: still fits
    expect(JSON.stringify(ledger.logs).length).toBe(20)
    ledger.admit('k')
    ledger.admit('after')
    ledger.truncate()
    expect(ledger.logs).toEqual(['abc', 'defgh', 'ij', LogLedger.marker(20)])
  })

  it('counts escapes as the JSON array does', () => {
    const ledger = new LogLedger(12)
    ledger.admit('"\n') // ["\"\n"] is 8 bytes
    ledger.admit('\u0001') // escapes to 8 bytes; 4 are left
    expect(ledger.logs).toEqual(['"\n', LogLedger.marker(12)])
  })

  it('maps a completion over the value budget to output-limit', () => {
    const ledger = new LogLedger(100)
    ledger.admit('kept')
    expect(successResult(ledger, { a: 'x'.repeat(20) }, 20)).toEqual({ logs: ['kept'], error: { kind: 'output-limit', message: 'completion value exceeded 20 bytes' } })
    expect(successResult(ledger, { a: 'x' }, 20)).toEqual({ logs: ['kept'], value: { a: 'x' } })
    expect(successResult(ledger, undefined, 20)).toEqual({ logs: ['kept'] })
  })

  it('caps failure messages at the value budget, marker included', () => {
    const ledger = new LogLedger(100)
    const result = failureResult(ledger, { kind: 'exception', message: 'e'.repeat(500) }, 64)
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(jsonBytes(result.error!.message)).toBeLessThanOrEqual(64)
    expect(failureResult(ledger, { kind: 'timeout', message: 'short' }, 64).error).toEqual({ kind: 'timeout', message: 'short' })
  })

  it('never splits a surrogate pair when capping', () => {
    const capped = capMessage('😀'.repeat(100), 40)
    expect(capped.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(capped.slice(0, -TRUNCATION_MARKER.length)).toMatch(/^(😀)+$/u)
    expect(jsonBytes(capped)).toBeLessThanOrEqual(40)
  })
})

describe('resolveBinary', () => {
  it('finds the binary of this platform', () => {
    expect(resolveBinary()).toMatch(/dsh-ptc-moejs-[a-z0-9]+-[a-z0-9]+[\\/]bin[\\/]moejs-ptc(\.exe)?$/)
  })

  it('names the package that is missing and the supported platforms', () => {
    expect(() => resolveBinary('aix', 'ppc64')).toThrow('no sidecar binary for aix-ppc64 (supported: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64)')
    expect(() => resolveBinary('freebsd', 'x64')).toThrow('no sidecar binary for freebsd-x64')
  })

  it('names the Windows package windows-x64', () => {
    expect(binaryPackage('win32', 'x64')).toBe('dsh-ptc-moejs-windows-x64')
    expect(binaryPackage('linux', 'arm64')).toBe('dsh-ptc-moejs-linux-arm64')
  })
})
