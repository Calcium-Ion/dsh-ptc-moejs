/**
 * A PTC runtime for the DeepSeek Harness that runs each program in a fresh
 * moejs runtime inside one long-lived sidecar process. A program's effects on
 * the machine are its tool calls, which dsh's tool pipeline confines.
 * @module dsh-ptc-moejs
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, PtcRuntime, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingErrorClass, PtcBindingFunction, PtcBindingNamespace, PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import z from '@deepseek-ai/schemastery'
import { resolveBinary } from './binary.ts'
import { FRAME_ENVELOPE, messageOf } from './protocol.ts'
import { Sidecar } from './sidecar.ts'
import type { Budgets, Namespace } from './sidecar.ts'

/** Plugin configuration. */
export interface Config {
  /** Default elapsed deadline of a run in milliseconds, tool calls included. */
  timeoutMs?: number
  /** Largest deadline a run may request. */
  maxTimeoutMs?: number
  /** MiB one run may allocate in total, garbage included, before it is stopped. */
  memoryLimitMb?: number
  /** Bytes of serialized logs a run keeps; capture stops at the budget. */
  maxLogBytes?: number
  /** Bytes of serialized completion value; a larger value fails as output-limit. */
  maxValueBytes?: number
  /** Tool calls one run may have in flight at once. */
  maxPendingCalls?: number
  /** Bytes of one frame between host and sidecar: a program, a tool result or tool arguments. */
  maxFrameBytes?: number
}

/** Configuration with every default filled in. */
export type ResolvedConfig = Required<Config>

/** The defaults, with the Node runtime's 120 s and 600 s deadlines. */
export const MoejsConfig: z<Config> = z.object({
  timeoutMs: z.number().default(120_000).description('Default elapsed deadline of a run in milliseconds, tool calls included.'),
  maxTimeoutMs: z.number().default(600_000).description('Largest deadline a run may request, in milliseconds.'),
  memoryLimitMb: z.number().default(512).description('MiB one run may allocate in total, garbage included, before it is stopped.'),
  maxLogBytes: z.number().default(16 * 1024 * 1024).description('Bytes of serialized logs a run keeps; capture stops at the budget.'),
  maxValueBytes: z.number().default(16 * 1024 * 1024).description('Bytes of serialized completion value; a larger value fails as output-limit.'),
  maxPendingCalls: z.number().default(128).description('Tool calls one run may have in flight at once.'),
  maxFrameBytes: z.number().default(64 * 1024 * 1024).description('Bytes of one frame between host and sidecar: a program, a tool result or tool arguments.'),
})

/** setTimeout's largest delay. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/** A frame becomes one JavaScript string, so it stays well below V8's string limit. */
const MAX_FRAME_BYTES = 512 * 1024 * 1024
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Fill in defaults and validate the configuration.
 * @param config - configuration as given.
 * @returns the complete configuration.
 * @throws When a value is out of range.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const resolved = MoejsConfig(config) as ResolvedConfig
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`dsh-ptc-moejs: ${key} must be a positive finite number`)
    }
  }
  for (const key of ['timeoutMs', 'maxTimeoutMs'] as const) {
    if (resolved[key] > MAX_TIMER_DELAY_MS) throw new Error(`dsh-ptc-moejs: ${key} must be at most ${MAX_TIMER_DELAY_MS}`)
  }
  for (const key of ['memoryLimitMb', 'maxLogBytes', 'maxValueBytes', 'maxPendingCalls', 'maxFrameBytes'] as const) {
    if (!Number.isSafeInteger(resolved[key])) throw new Error(`dsh-ptc-moejs: ${key} must be an integer`)
  }
  if (!Number.isSafeInteger(resolved.memoryLimitMb * 1024 * 1024)) throw new Error('dsh-ptc-moejs: memoryLimitMb is too large')
  if (resolved.maxFrameBytes > MAX_FRAME_BYTES) throw new Error(`dsh-ptc-moejs: maxFrameBytes must be at most ${MAX_FRAME_BYTES}`)
  for (const key of ['maxLogBytes', 'maxValueBytes'] as const) {
    if (resolved[key] > resolved.maxFrameBytes - FRAME_ENVELOPE) {
      throw new Error(`dsh-ptc-moejs: ${key} must fit in a frame: at most maxFrameBytes - ${FRAME_ENVELOPE}`)
    }
  }
  return resolved
}

/**
 * Validate the binding namespaces of a request and read each function once.
 * Names follow the rules dsh shares across PTC runtimes, so a namespace list
 * valid here is valid on every runtime.
 * @param bindings - the request's namespaces.
 * @returns the namespaces keyed by their global.
 * @throws When a name is unusable, reserved or used twice.
 */
export function validateBindings(bindings: readonly PtcBindingNamespace[]): Map<string, Namespace> {
  const namespaces = new Map<string, Namespace>()
  const injected = new Set<string>()
  const claim = (name: unknown, role: string): string => {
    if (typeof name !== 'string' || !IDENTIFIER.test(name) || PORTABLE_RESERVED_WORDS.has(name)) {
      throw new Error(`dsh-ptc-moejs: ${role} ${JSON.stringify(name)} is not a usable identifier`)
    }
    if (RESERVED_BINDING_GLOBALS.has(name)) throw new Error(`dsh-ptc-moejs: reserved binding global ${JSON.stringify(name)}`)
    if (injected.has(name)) throw new Error(`dsh-ptc-moejs: duplicate injected global ${JSON.stringify(name)}`)
    injected.add(name)
    return name
  }
  for (const namespace of bindings) {
    const global = claim(namespace.global, 'binding global')
    let errorClass: PtcBindingErrorClass | undefined
    if (namespace.errorClass !== undefined) {
      const name = claim(namespace.errorClass.name, 'binding error class')
      const member = namespace.errorClass.memberNameProperty
      if (typeof member !== 'string' || member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dsh-ptc-moejs: binding error member property ${JSON.stringify(member)} is not usable`)
      }
      errorClass = { name, memberNameProperty: member }
    }
    // Null prototype: `__proto__` and `constructor` are ordinary names.
    const functions = Object.create(null) as Record<string, PtcBindingFunction>
    for (const name of Object.keys(namespace.functions)) {
      const fn = namespace.functions[name]
      if (typeof fn === 'function') Object.defineProperty(functions, name, { value: fn, enumerable: true })
    }
    namespaces.set(global, { global, functions, ...errorClass === undefined ? {} : { errorClass } })
  }
  return namespaces
}

/** The moejs PTC runtime: `ctx.ptcRuntime` backed by one moejs-ptc sidecar. */
export class MoejsPtcRuntime extends PtcRuntime {
  static Config = MoejsConfig
  readonly language = 'typescript'
  readonly isolation = 'process'
  private readonly config: ResolvedConfig
  private readonly sidecar: Sidecar
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveConfig(config)
    const budgets: Budgets = {
      memoryLimitBytes: this.config.memoryLimitMb * 1024 * 1024,
      maxLogBytes: this.config.maxLogBytes,
      maxValueBytes: this.config.maxValueBytes,
      maxPendingCalls: this.config.maxPendingCalls,
      maxFrameBytes: this.config.maxFrameBytes,
    }
    this.sidecar = new Sidecar(resolveBinary(), budgets)
    ctx.effect(() => {
      this.sidecar.start()
      return async () => {
        this.disposed = true
        await this.sidecar.close('runtime disposed')
      }
    }, 'moejs ptc-runtime sidecar')
  }

  override get executionInstructions(): string {
    return 'The program is the body of an async TypeScript function with erasable syntax: enum and namespaces with values are syntax errors, and type annotations are not checked. '
      + 'Top-level await and return are supported. '
      + 'The program runs in moejs with the JavaScript standard library, the tool bindings and console.log, info, warn, error and debug. '
      + 'Node APIs, require, import, process, timers and direct file or network access are absent: use the tools for files, commands and the network. '
      + 'run_code takes no sandbox_permissions or justification with this runtime. '
      + 'When the sandbox denies a tool call, retry that call with sandbox_permissions and justification in its own arguments. The user approves each such call. '
      + 'Emit output with console.log(...) or return a lossless JSON value: plain objects, arrays, strings, finite numbers, booleans and null. '
      + 'Only printed values and the returned value become program output. '
      + `Each call starts a fresh runtime that may allocate ${this.config.memoryLimitMb} MiB in total, and variables from earlier calls are gone.`
  }

  override get timeout(): { defaultMs: number; maxMs: number } {
    return { defaultMs: Math.min(this.config.timeoutMs, this.config.maxTimeoutMs), maxMs: this.config.maxTimeoutMs }
  }

  /**
   * Fill in the working directory and deadline of a request.
   * @param request - program, bindings and optional choices.
   * @returns the request with a cwd and a capped deadline, or null for none.
   * @throws When the request names a sandbox policy, a relative cwd or an invalid timeout.
   */
  resolve(request: PtcRunRequest): PtcRunSpec {
    if (this.disposed) throw new Error('dsh-ptc-moejs: resolve after disposal')
    if (request.sandboxPolicy !== undefined) {
      throw new Error('dsh-ptc-moejs rejects an explicit sandboxPolicy: its programs reach files through tools, which apply their own policy')
    }
    const cwd = request.cwd ?? process.cwd()
    if (!isAbsolute(cwd)) throw new Error('dsh-ptc-moejs: cwd must be absolute')
    const requested = request.timeoutMs
    if (requested !== undefined && requested !== null && (!Number.isFinite(requested) || requested <= 0)) {
      throw new Error('dsh-ptc-moejs: timeoutMs must be a positive finite number')
    }
    const timeoutMs = requested === null ? null : Math.min(requested ?? this.config.timeoutMs, this.config.maxTimeoutMs)
    return { ...request, cwd, timeoutMs }
  }

  /**
   * Run a resolved program. Its outcome is a field of the result.
   * @param spec - what resolve returned.
   * @returns the program's logs and its value or failure.
   * @throws When the spec was not resolved or its bindings break the seam's rules.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    if (this.disposed) throw new Error('dsh-ptc-moejs: run after disposal')
    if (spec.sandboxPolicy !== undefined) throw new Error('dsh-ptc-moejs: this runtime rejects an explicit sandboxPolicy')
    const timeout = spec.timeoutMs
    if (typeof spec.program !== 'string' || !isAbsolute(spec.cwd)
      || (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0 || timeout > this.config.maxTimeoutMs))) {
      throw new Error('dsh-ptc-moejs: run requires a resolved program, cwd and timeout')
    }
    const namespaces = validateBindings(spec.bindings)
    if (spec.signal?.aborted === true) return { logs: [], error: { kind: 'abort', message: messageOf(spec.signal.reason) } }
    return await this.sidecar.execute(spec.program, namespaces, { timeoutMs: timeout, signal: spec.signal })
  }
}

export default MoejsPtcRuntime
