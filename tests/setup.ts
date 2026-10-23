/**
 * Mounts the runtime on dsh's own fs, sandbox and policy services, as dsh's
 * Node runtime tests do. The policy defaults to danger-full-access, which
 * starts the sidecar unconfined on every platform.
 */
import { Context } from '@deepseek-ai/cordis'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { onTestFinished } from 'vitest'
import MoejsPtcRuntime from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { SidecarProcess } from '../src/sidecar.ts'

export async function mountRuntime(config: Config = {}, policy: { mode?: SandboxMode; workspaceRoot?: string } = {}, ctx = new Context()) {
  onTestFinished(async () => { await ctx.fiber.dispose() })
  if (!ctx.get('sessions')) await ctx.plugin(SessionStore)
  if (!ctx.get('fs')) await ctx.plugin(FileSystem)
  if (!ctx.get('sandbox')) await ctx.plugin(Sandbox, {})
  if (!ctx.get('sessionProjections')) await ctx.plugin(SessionProjections)
  if (!ctx.get('sandboxPolicy')) await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', ...policy })
  const fiber = await ctx.plugin(MoejsPtcRuntime, config)
  return { ctx, fiber, runtime: ctx.ptcRuntime as MoejsPtcRuntime }
}

interface Internals {
  binary: string
  sidecars: Map<string, { process?: { handle: SidecarProcess } }>
}

/** The runtime's private state that the lifecycle tests reach into. */
export function internals(runtime: MoejsPtcRuntime): Internals {
  return runtime as unknown as Internals
}

/** The running process of the sidecar under a mode (and root, for confined modes). */
export function sidecarProcess(runtime: MoejsPtcRuntime, key = 'danger-full-access'): SidecarProcess | undefined {
  return internals(runtime).sidecars.get(key)?.process?.handle
}
