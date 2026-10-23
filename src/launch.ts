/**
 * Starts the sidecar under the confinement dsh's Node runtime gives its
 * program process: `ctx.sandbox` wraps it for the resolved file policy, and
 * its environment keeps only the variables the Node runtime keeps. The host
 * spawns the wrapped command itself. dsh's subprocess service would also put
 * it in a systemd scope behind a Node bootstrap, about 80 ms a start on
 * Linux, to reap the child processes of a program, and the sidecar starts
 * none.
 * @module dsh-ptc-moejs/launch
 */

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { SANDBOX_UNAVAILABLE, classifyRunnerFailure, isRunnerSpawnFailure } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-fs'
import { messageOf } from './protocol.ts'
import type { Launch, SidecarProcess } from './sidecar.ts'

/** The variables the Node runtime keeps for its program process: executable search, Windows system paths and temporary paths. */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])

/**
 * The sidecar's environment: the startup variables of the host's environment and nothing else.
 * @param env - the host's environment.
 * @returns the entries the sidecar keeps.
 */
export function sidecarEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase())))
}

function sandboxUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === SANDBOX_UNAVAILABLE
}

function start(argv: readonly string[], cwd?: string): SidecarProcess {
  const [command, ...args] = argv as [string, ...string[]]
  const child = spawn(command, args, { cwd, env: sidecarEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
  })
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done, terminate: () => { child.kill('SIGKILL') } }
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
    const confined = await ctx.sandbox.confine([binary], { mode: policy.mode, workspaceRoot: policy.workspaceRoot })
    return {
      handle: start(confined.argv, policy.workspaceRoot),
      enforcement: confined.enforcement,
      runnerFailed: (exit, stderr) => 'error' in exit
        ? isRunnerSpawnFailure(exit.error, confined.argv[0], policy.workspaceRoot)
        : classifyRunnerFailure(exit.exitCode, stderr, confined.runnerFailureRules) !== undefined,
    }
  } catch (error: unknown) {
    return { failure: { kind: sandboxUnavailable(error) ? 'sandbox-unavailable' : 'worker-exit', message: messageOf(error) } }
  }
}
