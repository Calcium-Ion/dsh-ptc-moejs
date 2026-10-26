/**
 * Starts the sidecar under the confinement dsh's Node runtime gives its
 * program process: `ctx.sandbox` wraps it for the resolved file policy, and
 * its environment keeps the startup variables the Node runtime keeps, plus
 * Electron's Node-mode selector. The host spawns the wrapped command itself.
 * dsh's subprocess service would also put it in a systemd scope behind a
 * Node bootstrap, about 80 ms a start on Linux, to reap the child processes
 * of a program, and the sidecar starts none.
 * @module dsh-ptc-moejs/launch
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { SANDBOX_UNAVAILABLE, classifyRunnerFailure, isRunnerSpawnFailure } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-fs'
import { messageOf } from './protocol.ts'
import type { Launch, SidecarProcess } from './sidecar.ts'

/** The variables the Node runtime keeps for its program process: executable search, Windows system paths and temporary paths. */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])

/**
 * Electron's Node-mode selector, kept for the sandbox runner. On dsh Desktop
 * the Windows runner is `[process.execPath, runner.js, ...]`, and
 * `process.execPath` is Electron, which runs `runner.js` only while this
 * variable is set. dsh's Node runtime keeps it until bootstrap for the same
 * reason.
 */
export const RUNNER_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['ELECTRON_RUN_AS_NODE'])

/**
 * Where a confined sidecar finds its binary on Linux: the descriptor the host
 * opened it on. A sandbox can hide the binary's directory, as bubblewrap
 * hides /tmp under workspace-write, and the descriptor still reaches it.
 */
export const BINARY_DESCRIPTOR_PATH = '/proc/self/fd/3'

/**
 * The sidecar's environment: the host's startup variables and Electron's
 * Node-mode selector, and nothing else.
 * @param env - the host's environment.
 * @returns the entries the sidecar keeps.
 */
export function sidecarEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => {
    const name = key.toUpperCase()
    return STARTUP_ENVIRONMENT_NAMES.has(name) || RUNNER_ENVIRONMENT_NAMES.has(name)
  }))
}

function sandboxUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === SANDBOX_UNAVAILABLE
}

function start(argv: readonly string[], cwd?: string, binary?: number): SidecarProcess {
  const [command, ...args] = argv as [string, ...string[]]
  // The child gets the binary's descriptor as fd 3; the host's copy closes once the child has its own.
  const stdio = binary === undefined ? ['pipe', 'pipe', 'pipe'] as const : ['pipe', 'pipe', 'pipe', binary] as const
  let child: ChildProcess
  try {
    child = spawn(command, args, { cwd, env: sidecarEnvironment(), stdio: [...stdio], windowsHide: true })
  } finally {
    if (binary !== undefined) closeSync(binary)
  }
  const { stdin, stdout, stderr } = child
  if (stdin === null || stdout === null || stderr === null) throw new Error('the moejs sidecar started without its pipes')
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
  })
  return { stdin, stdout, stderr, done, terminate: () => { child.kill('SIGKILL') } }
}

/**
 * Start the sidecar under one file policy. Danger-full-access starts it
 * directly; the other modes confine it with `ctx.sandbox`, which fails closed.
 * @param ctx - a context with dsh's fs and sandbox services.
 * @param binary - the host path of the sidecar binary.
 * @param policy - the file policy the process runs under.
 * @returns the started process, or the failure that kept it from starting.
 */
export async function launchSidecar(ctx: Context, binary: string, policy: SandboxExecutionPolicy): Promise<Launch> {
  try {
    if (policy.mode === 'danger-full-access') return { handle: start([binary]), enforcement: undefined, runnerFailed: () => false }
    // The sidecar runs on this host, so only a sandbox of this host's execution world can confine it.
    if (ctx.fs.processPathFromHostPath(binary) !== binary) {
      return { failure: { kind: 'sandbox-unavailable', message: `the ${policy.mode} file sandbox confines another execution world, and the moejs sidecar runs on this host` } }
    }
    const descriptor = process.platform === 'linux'
    const confined = await ctx.sandbox.confine([descriptor ? BINARY_DESCRIPTOR_PATH : binary], { mode: policy.mode, workspaceRoot: policy.workspaceRoot })
    return {
      handle: start(confined.argv, policy.workspaceRoot, descriptor ? openSync(binary, 'r') : undefined),
      enforcement: confined.enforcement,
      runnerFailed: (exit, stderr) => 'error' in exit
        ? isRunnerSpawnFailure(exit.error, confined.argv[0], policy.workspaceRoot)
        : classifyRunnerFailure(exit.exitCode, stderr, confined.runnerFailureRules) !== undefined,
    }
  } catch (error: unknown) {
    return { failure: { kind: sandboxUnavailable(error) ? 'sandbox-unavailable' : 'worker-exit', message: messageOf(error) } }
  }
}
