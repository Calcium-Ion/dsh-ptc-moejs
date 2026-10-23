/**
 * The moejs-ptc process of one file policy and the runs in flight on it. Each
 * run is a fresh moejs runtime inside the process. The host keeps the
 * deadlines, aborts and binding calls, and validates every frame the process
 * sends.
 * @module dsh-ptc-moejs/sidecar
 */

import type { Readable, Writable } from 'node:stream'
import type { PtcBindingErrorClass, PtcBindingFunction, PtcJsonValue, PtcRunFailure, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxEnforcement } from '@deepseek-ai/dsh-sandbox'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { FRAME_ENVELOPE, LogLedger, PROTOCOL, capMessage, failureResult, messageOf, parseFrame, successResult } from './protocol.ts'
import type { SidecarFrame } from './protocol.ts'

/** The budgets the sidecar enforces, sent in its boot frame. */
export interface Budgets {
  memoryLimitBytes: number
  maxLogBytes: number
  maxValueBytes: number
  maxPendingCalls: number
  maxFrameBytes: number
}

/** A binding namespace after validation: its functions read once. */
export interface Namespace {
  global: string
  functions: Record<string, PtcBindingFunction>
  errorClass?: PtcBindingErrorClass
}

/** What the host needs of a started sidecar process. */
export interface SidecarProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  /** Settles when the process and its pipes have closed; rejects when the process could not start. */
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  /** Kill the process now. */
  terminate(): void
}

/** A started sidecar process. */
export interface Launched {
  handle: SidecarProcess
  /** How completely the sandbox confines the process; undefined when it runs unconfined. */
  enforcement: SandboxEnforcement | undefined
  /** Whether the sandbox runner, not the sidecar, failed: by the stderr of an exit, or by a spawn error. */
  runnerFailed(exit: { exitCode: number | null } | { error: unknown }, stderr: string): boolean
}

/** What a launch gives: a process, or the failure that kept it from starting. */
export type Launch = Launched | { failure: PtcRunFailure }

/** How long a closing process may take before it is killed. */
const CLOSE_GRACE_MS = 2_000
/** How long a process with no runs stays up before it exits. The next run starts a new one. */
const IDLE_MS = 5 * 60_000
/** How much of the process's stderr a worker-exit message quotes. */
const STDERR_TAIL = 4_096

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true })

/** One run on the sidecar: its logs, its calls and how it ends. */
class Execution {
  readonly ledger: LogLedger
  readonly result: Promise<PtcRunResult>
  private settle!: (result: PtcRunResult) => void
  private settled = false
  private nextCall = 1
  private pending = 0

  constructor(
    readonly id: number,
    private readonly namespaces: Map<string, Namespace>,
    private readonly budgets: Budgets,
    private readonly send: (line: string) => void,
  ) {
    this.ledger = new LogLedger(budgets.maxLogBytes)
    this.result = new Promise((resolve) => { this.settle = resolve })
  }

  get done(): boolean { return this.settled }

  finish(result: PtcRunResult): void {
    if (this.settled) return
    this.settled = true
    this.settle(result)
  }

  fail(failure: PtcRunFailure): void {
    this.finish(failureResult(this.ledger, failure, this.budgets.maxValueBytes))
  }

  /** Stop the program on the sidecar and settle with the failure. */
  stop(failure: PtcRunFailure): void {
    if (this.settled) return
    this.fail(failure)
    this.send(JSON.stringify({ type: 'cancel', run: this.id }))
  }

  handle(frame: Exclude<SidecarFrame, { type: 'boot-ack' }>): void {
    switch (frame.type) {
      case 'log':
        if (frame.truncated) this.ledger.truncate()
        else this.ledger.admit(frame.text)
        return
      case 'done':
        if (frame.error !== undefined) this.fail(frame.error)
        else this.finish(successResult(this.ledger, frame.value, this.budgets.maxValueBytes))
        return
      case 'call':
        this.call(frame)
    }
  }

  private call(frame: Extract<SidecarFrame, { type: 'call' }>): void {
    const functions = this.namespaces.get(frame.global)?.functions
    const fn = functions !== undefined && Object.hasOwn(functions, frame.name) ? functions[frame.name] : undefined
    const problem = frame.id !== this.nextCall ? `call ${frame.id} arrived out of sequence`
      : fn === undefined ? `a call named the undeclared binding ${frame.global}.${frame.name}`
        : this.pending >= this.budgets.maxPendingCalls ? `more than ${this.budgets.maxPendingCalls} calls were pending` : undefined
    if (problem !== undefined || fn === undefined) {
      this.stop({ kind: 'protocol', message: `invalid call from the moejs sidecar: ${problem}` })
      return
    }
    this.nextCall += 1
    this.pending += 1
    void this.reply(frame.id, fn, frame.args).then((line) => {
      this.pending -= 1
      if (!this.settled) this.send(line)
    })
  }

  private async reply(id: number, fn: PtcBindingFunction, args: PtcJsonValue): Promise<string> {
    try {
      const value = snapshotJsonValue(await fn(args))
      if (value === undefined) throw new Error('binding resolution must be lossless JSON')
      const text = JSON.stringify(value)
      const limit = this.budgets.maxFrameBytes - FRAME_ENVELOPE
      if (Buffer.byteLength(text, 'utf8') > limit) throw new Error(`binding resolution exceeds ${limit} bytes of JSON`)
      return `{"type":"reply","run":${this.id},"id":${id},"ok":true,"value":${text}}`
    } catch (error: unknown) {
      // The cap keeps the reply inside one frame.
      return JSON.stringify({ type: 'reply', run: this.id, id, ok: false, message: capMessage(messageOf(error), this.budgets.maxValueBytes) })
    }
  }
}

/** Options of one execution. */
export interface ExecuteOptions {
  timeoutMs: number | null
  signal?: AbortSignal | undefined
}

/** The moejs-ptc process of one file policy, started by a launcher. */
export class Sidecar {
  private process: Launched | undefined
  private starting: Promise<PtcRunFailure | undefined> | undefined
  /** Exits of the processes that have not exited yet, the current one included. */
  private readonly exits = new Set<Promise<void>>()
  private readonly runs = new Map<number, Execution>()
  private nextRun = 1
  private booted = false
  private partial: Buffer[] = []
  private partialBytes = 0
  private stderrTail = ''
  private idleTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(
    private readonly launch: () => Promise<Launch>,
    private readonly budgets: Budgets,
    private readonly idleMs: number = IDLE_MS,
  ) {}

  /** How completely the sandbox confines the current process; undefined when it runs unconfined or not at all. */
  get enforcement(): SandboxEnforcement | undefined { return this.process?.enforcement }

  /**
   * Start the process now rather than on the first run.
   * @returns the failure that kept the process from starting, or undefined once it runs.
   */
  start(): Promise<PtcRunFailure | undefined> {
    if (this.closed) return Promise.resolve({ kind: 'abort', message: 'runtime disposed' })
    if (this.process !== undefined) return Promise.resolve(undefined)
    const starting = this.starting ?? this.launch().then((launch): PtcRunFailure | undefined => {
      if ('failure' in launch) return launch.failure
      if (this.closed) {
        this.retire(launch)
        return { kind: 'abort', message: 'runtime disposed' }
      }
      this.attach(launch)
      return undefined
    }, (error: unknown): PtcRunFailure => ({ kind: 'worker-exit', message: `the moejs sidecar could not start: ${messageOf(error)}` }))
      .finally(() => { this.starting = undefined })
    this.starting = starting
    return starting
  }

  /**
   * Run one program and settle with its result.
   * @param program - the program text.
   * @param namespaces - the validated bindings, keyed by global.
   * @param options - deadline and cancellation.
   * @returns the program's logs and outcome.
   */
  async execute(program: string, namespaces: Map<string, Namespace>, options: ExecuteOptions): Promise<PtcRunResult> {
    const run = new Execution(this.nextRun++, namespaces, this.budgets, line => this.send(line))
    if (this.closed) {
      run.fail({ kind: 'abort', message: 'runtime disposed' })
      return await run.result
    }
    const frame = JSON.stringify({
      type: 'run',
      run: run.id,
      program,
      namespaces: [...namespaces.values()].map(ns => ({
        global: ns.global,
        names: Object.keys(ns.functions),
        ...ns.errorClass === undefined ? {} : { errorClass: ns.errorClass },
      })),
    })
    if (Buffer.byteLength(frame, 'utf8') > this.budgets.maxFrameBytes) {
      run.fail({ kind: 'exception', message: `the program and its bindings exceed ${this.budgets.maxFrameBytes} bytes (maxFrameBytes)` })
      return await run.result
    }
    this.runs.set(run.id, run)
    // The deadline covers starting the process, as the Node runtime's covers its launch.
    const timer = options.timeoutMs === null ? undefined : setTimeout(() => {
      run.stop({ kind: 'timeout', message: `execution deadline reached (${options.timeoutMs}ms)` })
    }, options.timeoutMs)
    const signal = options.signal
    const onAbort = (): void => { run.stop({ kind: 'abort', message: messageOf(signal?.reason) }) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const failure = await this.start()
      if (failure !== undefined) run.fail(failure)
      else if (!run.done) this.send(frame)
      return await run.result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.runs.delete(run.id)
      if (this.runs.size === 0) this.idle()
    }
  }

  /** Abort every run, end the processes and wait until they have exited. */
  async close(reason: string): Promise<void> {
    this.closed = true
    clearTimeout(this.idleTimer)
    for (const run of this.runs.values()) run.stop({ kind: 'abort', message: reason })
    // A launch in flight retires its process when it lands.
    await this.starting
    if (this.process !== undefined) this.retire(this.process)
    await Promise.all(this.exits)
  }

  private attach(launched: Launched): void {
    const { handle } = launched
    this.process = launched
    this.booted = false
    this.partial = []
    this.partialBytes = 0
    this.stderrTail = ''
    handle.stdout.on('data', (chunk: Buffer) => { this.onData(launched, chunk) })
    handle.stderr.on('data', (chunk: Buffer) => {
      if (this.process === launched) this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL)
    })
    // A write to a process that died fails here. Its exit settles the runs.
    handle.stdin.on('error', () => {})
    const exited = handle.done.then((outcome) => {
      const stderr = this.stderrTail.trim()
      if (launched.runnerFailed({ exitCode: outcome.exitCode }, stderr)) {
        this.lost(launched, { kind: 'sandbox-unavailable', message: stderr })
        return
      }
      const how = outcome.signal === null ? `with code ${outcome.exitCode}` : `on signal ${outcome.signal}`
      this.lost(launched, { kind: 'worker-exit', message: `the moejs sidecar exited ${how}${stderr === '' ? '' : `: ${stderr}`}` })
    }, (error: unknown) => {
      const kind = launched.runnerFailed({ error }, '') ? 'sandbox-unavailable' : 'worker-exit'
      this.lost(launched, { kind, message: `the moejs sidecar could not run: ${messageOf(error)}` })
    })
    this.exits.add(exited)
    void exited.finally(() => { this.exits.delete(exited) })
    handle.stdin.write(JSON.stringify({ type: 'boot', protocol: PROTOCOL, ...this.budgets }) + '\n')
    if (this.runs.size === 0) this.idle()
  }

  /** End a process without failing runs: it exits when its stdin closes, or is killed after the grace period. */
  private retire(launched: Launched): void {
    if (this.process === launched) this.process = undefined
    const { handle } = launched
    handle.stdin.end()
    // A process that never attached has no readers; its output must flow for it to close.
    handle.stdout.resume()
    handle.stderr.resume()
    const killer = setTimeout(() => { handle.terminate() }, CLOSE_GRACE_MS)
    const exited: Promise<void> = handle.done.then(() => {}, () => {}).finally(() => {
      clearTimeout(killer)
      this.exits.delete(exited)
    })
    this.exits.add(exited)
  }

  /** Retire the process once it has had no runs for the idle period. A run in flight when the timer fires keeps it. */
  private idle(): void {
    if (this.closed) return
    if (this.idleTimer !== undefined) {
      this.idleTimer.refresh()
      return
    }
    this.idleTimer = setTimeout(() => {
      if (this.runs.size === 0 && this.process !== undefined) this.retire(this.process)
    }, this.idleMs)
    this.idleTimer.unref()
  }

  private send(line: string): void {
    this.process?.handle.stdin.write(line + '\n')
  }

  /** The process ended or broke: fail its runs; the next run starts a new one. */
  private lost(launched: Launched, failure: PtcRunFailure): void {
    if (this.process !== launched) return
    this.process = undefined
    for (const run of this.runs.values()) run.fail(failure)
    launched.handle.terminate()
  }

  private onData(launched: Launched, chunk: Buffer): void {
    if (this.process !== launched) return
    let start = 0
    for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, newline)
      const line = this.partial.length === 0 ? piece : Buffer.concat([...this.partial, piece])
      this.partial = []
      this.partialBytes = 0
      start = newline + 1
      this.onLine(launched, line)
      if (this.process !== launched) return
    }
    if (start < chunk.length) {
      this.partialBytes += chunk.length - start
      if (this.partialBytes > this.budgets.maxFrameBytes) {
        this.lost(launched, { kind: 'protocol', message: `the moejs sidecar sent a frame longer than ${this.budgets.maxFrameBytes} bytes` })
        return
      }
      this.partial.push(Buffer.from(chunk.subarray(start)))
    }
  }

  private onLine(launched: Launched, bytes: Buffer): void {
    let frame: SidecarFrame | string
    try {
      frame = parseFrame(fatalUtf8.decode(bytes))
    } catch {
      frame = 'a frame is not valid UTF-8'
    }
    if (typeof frame !== 'string' && frame.type === 'boot-ack') {
      if (frame.protocol === PROTOCOL && !this.booted) {
        this.booted = true
        return
      }
      frame = this.booted ? 'a second boot-ack' : `the sidecar speaks protocol ${frame.protocol}, this host ${PROTOCOL}`
    } else if (!this.booted) {
      frame = 'a frame came before the boot-ack'
    }
    if (typeof frame === 'string') {
      this.lost(launched, { kind: 'protocol', message: `invalid frame from the moejs sidecar: ${frame}` })
      return
    }
    // A cancel can cross a run's frames on the wire, so frames of a run that has ended are dropped.
    const run = this.runs.get(frame.run)
    if (run !== undefined && !run.done) run.handle(frame)
  }
}
