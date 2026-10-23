/**
 * The sidecar under dsh's file sandbox, checked against what dsh's Node
 * runtime does for its program process: the policy it resolves, the launch
 * under ctx.sandbox, the environment, the sandbox facts of a result,
 * fail-closed confinement and a Session's mode change.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PtcBindingFunction, PtcBindingNamespace, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { resolveBinary } from '../src/binary.ts'
import { BINARY_DESCRIPTOR_PATH, launchSidecar, sidecarEnvironment } from '../src/launch.ts'
import { Sidecar } from '../src/sidecar.ts'
import { mountRuntime } from './setup.ts'

// The launcher's spawns, recorded and passed through.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
const spawns = vi.mocked(spawn)

/** Whether this host can confine a process, probed apart from the runtime. */
const sandboxUsable = await (async () => {
  const probe = new Context()
  try {
    await probe.plugin(Sandbox, {})
    await probe.sandbox.confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot: process.cwd() })
    return true
  } catch (error: unknown) {
    if (error instanceof SandboxUnavailableError) return false
    throw error
  } finally { await probe.fiber.dispose() }
})()

const binary = resolveBinary()
// What a confined sidecar runs: on Linux, the descriptor the host opened its binary on.
const confinedCommand = process.platform === 'linux' ? BINARY_DESCRIPTOR_PATH : binary
const never: PtcBindingFunction = () => new Promise(() => {})

function tools(functions: Record<string, PtcBindingFunction>): PtcBindingNamespace[] {
  return [{ global: 'tools', functions, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }]
}

async function workspace(parent = tmpdir()): Promise<string> {
  const dir = await mkdtemp(join(parent, '.dsh-ptc-moejs-test-'))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

/**
 * Mount the runtime with a spy on the sandbox whose confinement passes the
 * argv through. The deployment mode is danger-full-access, so the sidecar the
 * runtime starts when it loads runs unconfined; the tests name their policies
 * and workspaces.
 */
async function setup() {
  const { ctx, runtime } = await mountRuntime()
  const confined = (argv: readonly string[]): ConfinedArgv => ({ argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
  const confine = vi.spyOn(ctx.sandbox, 'confine').mockImplementation(async argv => confined(argv))
  onTestFinished(() => { confine.mockRestore() })
  const run = (request: PtcRunRequest) => runtime.run(runtime.resolve(request))
  return { ctx, runtime, confine, run }
}

/** The sidecar spawns in a workspace: a confined sidecar starts there. */
function spawnsIn(dir: string): Array<{ command: string; args: readonly string[]; options: SpawnOptions }> {
  return spawns.mock.calls
    .map(([command, args, options]) => ({ command, args: args as readonly string[], options: options as SpawnOptions }))
    .filter(call => call.options.cwd === dir)
}

describe('launch', () => {
  it('starts the sidecar as the command ctx.sandbox wraps for the resolved policy', async () => {
    const root = await workspace()
    const { confine, run } = await setup()
    confine.mockImplementationOnce(async argv => ({ argv: [process.execPath, join(import.meta.dirname, 'runner.mjs'), ...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }))
    const policy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: root }
    const result = await run({ program: 'return 1', bindings: [], sandboxPolicy: policy })
    expect(result).toEqual({ logs: [], value: 1, sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial' } })
    expect(confine).toHaveBeenCalledWith([confinedCommand], { mode: 'workspace-write', workspaceRoot: root })
    const [call] = spawnsIn(root)
    expect(call?.command).toBe(process.execPath)
    expect(call?.args).toEqual([join(import.meta.dirname, 'runner.mjs'), confinedCommand])
    expect((call?.options.stdio as unknown[]).slice(0, 3)).toEqual(['pipe', 'pipe', 'pipe'])
    expect((call?.options.stdio as unknown[])[3]).toBeTypeOf(process.platform === 'linux' ? 'number' : 'undefined')
  })

  it('starts a danger-full-access sidecar directly', async () => {
    const root = await workspace()
    const { confine, run } = await setup()
    const result = await run({ program: 'return 1', bindings: [], sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: root } })
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(confine).not.toHaveBeenCalled()
    expect(spawns.mock.calls.some(([command]) => command === binary)).toBe(true)
  })

  it('keeps only the variables the Node runtime keeps', async () => {
    const root = await workspace()
    vi.stubEnv('DSH_PTC_MOEJS_TEST_SECRET', 'secret')
    vi.stubEnv('TMP', '/tmp/kept')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const env = sidecarEnvironment()
    expect(env.TMP).toBe('/tmp/kept')
    expect(Object.keys(env).every(name => ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(name.toUpperCase()))).toBe(true)

    const { run } = await setup()
    await run({ program: 'return 1', bindings: [], sandboxPolicy: { mode: 'workspace-write', workspaceRoot: root } })
    expect(spawnsIn(root)[0]?.options.env).toStrictEqual(env)
  })

  it('runs one sidecar per mode and workspace root, shared across Sessions', async () => {
    const [a, b] = [await workspace(), await workspace()]
    const { run } = await setup()
    const ws = (root: string, sessionId?: string): SandboxExecutionPolicy => ({
      mode: 'workspace-write', workspaceRoot: root, ...sessionId === undefined ? {} : { sessionId: SessionId(sessionId) },
    })
    for (const sandboxPolicy of [ws(a), ws(a, 'one'), ws(a, 'two'), ws(b), ws(b)]) {
      expect((await run({ program: 'return 1', bindings: [], sandboxPolicy })).value).toBe(1)
    }
    expect(spawnsIn(a)).toHaveLength(1)
    expect(spawnsIn(b)).toHaveLength(1)
    await run({ program: 'return 1', bindings: [], sandboxPolicy: { mode: 'read-only', workspaceRoot: a } })
    expect(spawnsIn(a)).toHaveLength(2)
  })
})

describe('fail-closed confinement', () => {
  it('fails a run as sandbox-unavailable without starting the sidecar, and tries again on the next run', async () => {
    const root = await workspace()
    const { confine, run } = await setup()
    confine.mockRejectedValueOnce(new SandboxUnavailableError('workspace-write'))
    const sandboxPolicy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: root }
    const failed = await run({ program: 'return 1', bindings: [], sandboxPolicy })
    expect(failed.error?.kind).toBe('sandbox-unavailable')
    expect(failed.error?.message).toContain('no sandbox backend is usable')
    expect(failed.sandbox).toEqual({ mode: 'workspace-write', denied: false })
    expect(spawnsIn(root)).toHaveLength(0)
    expect(await run({ program: 'return 2', bindings: [], sandboxPolicy })).toMatchObject({ value: 2 })
  })

  it('reports a sandbox runner that fails before the sidecar runs as sandbox-unavailable', async () => {
    const root = await workspace()
    const { confine, run } = await setup()
    confine.mockResolvedValueOnce({
      argv: [process.execPath, '-e', 'process.stderr.write("bwrap: setting up uid map: Permission denied\\n"); process.exit(1)'],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }],
    })
    const result = await run({ program: 'return 1', bindings: [], sandboxPolicy: { mode: 'workspace-write', workspaceRoot: root } })
    expect(result.error).toEqual({ kind: 'sandbox-unavailable', message: 'bwrap: setting up uid map: Permission denied' })
  })

  it('fails closed when the sandbox belongs to another execution world', async () => {
    const root = await workspace()
    const { ctx, confine, run } = await setup()
    const mapping = vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    onTestFinished(() => { mapping.mockRestore() })
    const result = await run({ program: 'return 1', bindings: [], sandboxPolicy: { mode: 'read-only', workspaceRoot: root } })
    expect(result.error?.kind).toBe('sandbox-unavailable')
    expect(result.error?.message).toContain('another execution world')
    expect(confine).not.toHaveBeenCalled()
    expect((await run({ program: 'return 1', bindings: [], sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: root } })).value).toBe(1)
  })
})

describe('Session policy', () => {
  it('stops a Session\'s runs when its file mode changes, as the Node runtime does', async () => {
    const { ctx, run } = await setup()
    const session = ctx.sessions.create(SessionId('mode-change'))
    setSandboxMode(session, 'workspace-write')
    let called!: () => void
    const reached = new Promise<void>((resolve) => { called = resolve })
    const pending = run({
      program: 'await tools.wait({})',
      bindings: tools({ wait: () => { called(); return never({}) } }),
      sandboxPolicy: ctx.sandboxPolicy.resolve({ session }),
    })
    await reached
    setSandboxMode(ctx.sessions.create(SessionId('unrelated')), 'read-only')
    setSandboxMode(session, 'workspace-write')
    setSandboxMode(session, 'read-only')
    expect((await pending).error).toEqual({ kind: 'abort', message: 'sandbox mode changed' })
  })

  it('keeps an approved escalation running while the Session\'s own mode stays', async () => {
    const { ctx, run } = await setup()
    const session = ctx.sessions.create(SessionId('escalation'))
    setSandboxMode(session, 'workspace-write')
    let called!: () => void
    const reached = new Promise<void>((resolve) => { called = resolve })
    const controller = new AbortController()
    const pending = run({
      program: 'await tools.wait({})',
      bindings: tools({ wait: () => { called(); return never({}) } }),
      sandboxPolicy: { ...ctx.sandboxPolicy.resolve({ session }), mode: 'danger-full-access' },
      signal: controller.signal,
    })
    await reached
    setSandboxMode(session, 'workspace-write')
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort('done')
    expect((await pending).error).toEqual({ kind: 'abort', message: 'done' })
  })
})

describe('idle sidecars', () => {
  it('ends a sidecar with no runs after the idle period and starts a new one for the next run', async () => {
    const root = await workspace()
    const { ctx } = await setup()
    const budgets = { memoryLimitBytes: 64 << 20, maxLogBytes: 1 << 20, maxValueBytes: 1 << 20, maxPendingCalls: 8, maxPendingTimers: 64, maxFrameBytes: 4 << 20 }
    const sidecar = new Sidecar(() => launchSidecar(ctx, binary, { mode: 'workspace-write', workspaceRoot: root }), budgets, 50)
    onTestFinished(async () => { await sidecar.close('test finished') })
    expect((await sidecar.execute('return 1', new Map(), { timeoutMs: 5_000, cwd: root })).value).toBe(1)
    const first = spawns.mock.results[spawns.mock.calls.findIndex(([, , options]) => (options as SpawnOptions).cwd === root)]!.value as ChildProcess
    if (first.exitCode === null && first.signalCode === null) await new Promise<void>((resolve) => { first.once('exit', () => { resolve() }) })
    expect((await sidecar.execute('return 2', new Map(), { timeoutMs: 5_000, cwd: root })).value).toBe(2)
    expect(spawnsIn(root)).toHaveLength(2)
  })
})

/** The processes below a process, read from /proc. */
function descendants(root: number): number[] {
  const parents = new Map<number, number>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]))
    } catch {
      // The process exited while the list was read.
    }
  }
  return [...parents.keys()].filter((pid) => {
    for (let parent = parents.get(pid); parent !== undefined && parent > 1; parent = parents.get(parent)) {
      if (parent === root) return true
    }
    return false
  })
}

describe.skipIf(!sandboxUsable || process.platform !== 'linux')('a binary the sandbox hides', () => {
  it('starts a confined sidecar whose binary is under /tmp', async () => {
    const dir = await mkdtemp('/tmp/.dsh-ptc-moejs-binary-')
    onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
    const hidden = join(dir, 'moejs-ptc')
    await copyFile(binary, hidden)
    await chmod(hidden, 0o755)
    const root = await workspace(homedir())
    const { ctx } = await mountRuntime({}, { mode: 'workspace-write', workspaceRoot: root })
    const budgets = { memoryLimitBytes: 64 << 20, maxLogBytes: 1 << 20, maxValueBytes: 1 << 20, maxPendingCalls: 8, maxPendingTimers: 64, maxFrameBytes: 4 << 20 }
    const sidecar = new Sidecar(() => launchSidecar(ctx, hidden, { mode: 'workspace-write', workspaceRoot: root }), budgets)
    onTestFinished(async () => { await sidecar.close('test finished') })
    expect(await sidecar.execute('return "started"', new Map(), { timeoutMs: 5_000, cwd: root })).toEqual({ logs: [], value: 'started' })
    expect(sidecar.enforcement).toBeDefined()
  })
})

describe.skipIf(!sandboxUsable)('the host sandbox', () => {
  it('lets a confined sidecar import the files of the workspace', async () => {
    const root = await workspace(homedir())
    await writeFile(join(root, 'helper.ts'), 'export const greet = (name: string): string => `hello ${name}`\n')
    const { runtime } = await mountRuntime({}, { mode: 'workspace-write', workspaceRoot: root })
    const result = await runtime.run(runtime.resolve({ program: 'return (await import("./helper.ts")).greet("sandbox")', bindings: [] }))
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('hello sandbox')
    expect(result.sandbox?.mode).toBe('workspace-write')
  })

  it('runs programs in a confined sidecar that holds none of the host\'s variables', async () => {
    vi.stubEnv('DSH_PTC_MOEJS_TEST_SECRET', 'secret')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const root = await workspace(homedir())
    const { ctx, runtime } = await mountRuntime({}, { mode: 'workspace-write', workspaceRoot: root })
    const result = await runtime.run(runtime.resolve({ program: 'return await tools.echo({ ok: true })', bindings: tools({ echo: args => Promise.resolve(args as never) }) }))
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ ok: true })
    expect(result.sandbox?.mode).toBe('workspace-write')
    expect(['full', 'partial']).toContain(result.sandbox?.enforcement)
    if (process.platform !== 'linux') return
    const sidecars = descendants(process.pid).filter((pid) => {
      try { return readlinkSync(`/proc/${pid}/exe`) === binary } catch { return false }
    })
    expect(sidecars.length).toBeGreaterThan(0)
    const runner = await ctx.sandbox.confine([confinedCommand], { mode: 'workspace-write', workspaceRoot: root })
    for (const pid of sidecars) {
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      expect(environ.some(entry => entry.startsWith('DSH_PTC_MOEJS_TEST_SECRET='))).toBe(false)
      // bwrap gives the sidecar its own PID namespace.
      if (basename(runner.argv[0]!) === 'bwrap') expect(readFileSync(`/proc/${pid}/status`, 'utf8')).toMatch(/^NSpid:\s+\d+\s+\d+/m)
    }
  })
})
