/**
 * One long-lived moejs-ptc process and the runs in flight on it. Each run is
 * a fresh moejs runtime inside the process. The host keeps the deadlines,
 * aborts and binding calls, and validates every frame the process sends.
 * @module dsh-ptc-moejs/sidecar
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PtcBindingErrorClass, PtcBindingFunction, PtcJsonValue, PtcRunFailure, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
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

/** How long a closing process may take before it is killed. */
const CLOSE_GRACE_MS = 2_000
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

/** The moejs-ptc process of one provider instance. */
export class Sidecar {
  private child: ChildProcessWithoutNullStreams | undefined
  private exited: Promise<void> = Promise.resolve()
  private readonly runs = new Map<number, Execution>()
  private nextRun = 1
  private booted = false
  private partial: Buffer[] = []
  private partialBytes = 0
  private stderrTail = ''
  private closed = false

  constructor(private readonly binary: string, private readonly budgets: Budgets) {}

  /** Start the process now rather than on the first run. */
  start(): void {
    if (this.child !== undefined || this.closed) return
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.booted = false
    this.partial = []
    this.partialBytes = 0
    this.stderrTail = ''
    let markExited!: () => void
    this.exited = new Promise((resolve) => { markExited = resolve })
    child.stdout.on('data', (chunk: Buffer) => { this.onData(child, chunk) })
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL)
    })
    // A write to a process that died fails here. Its exit settles the runs.
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      this.lost(child, { kind: 'worker-exit', message: `the moejs sidecar could not run: ${error.message}` })
      markExited()
    })
    child.on('exit', (code, signal) => {
      const stderr = this.stderrTail.trim()
      const how = signal === null ? `with code ${code}` : `on signal ${signal}`
      this.lost(child, { kind: 'worker-exit', message: `the moejs sidecar exited ${how}${stderr === '' ? '' : `: ${stderr}`}` })
      markExited()
    })
    child.stdin.write(JSON.stringify({ type: 'boot', protocol: PROTOCOL, ...this.budgets }) + '\n')
    this.updateRef()
  }

  /**
   * Run one program and settle with its result.
   * @param program - the program text.
   * @param namespaces - the validated bindings, keyed by global.
   * @param options - deadline and cancellation.
   * @returns the program's logs and outcome.
   */
  execute(program: string, namespaces: Map<string, Namespace>, options: ExecuteOptions): Promise<PtcRunResult> {
    const run = new Execution(this.nextRun++, namespaces, this.budgets, line => this.send(line))
    if (this.closed) {
      run.fail({ kind: 'abort', message: 'runtime disposed' })
      return run.result
    }
    this.start()
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
      return run.result
    }
    this.runs.set(run.id, run)
    const timer = options.timeoutMs === null ? undefined : setTimeout(() => {
      run.stop({ kind: 'timeout', message: `execution deadline reached (${options.timeoutMs}ms)` })
    }, options.timeoutMs)
    const signal = options.signal
    const onAbort = (): void => { run.stop({ kind: 'abort', message: messageOf(signal?.reason) }) }
    signal?.addEventListener('abort', onAbort, { once: true })
    this.send(frame)
    this.updateRef()
    return run.result.finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.runs.delete(run.id)
      this.updateRef()
    })
  }

  /** Abort every run, end the process and wait until it has exited. */
  async close(reason: string): Promise<void> {
    this.closed = true
    for (const run of this.runs.values()) run.stop({ kind: 'abort', message: reason })
    const child = this.child
    const killer = child === undefined ? undefined : setTimeout(() => { child.kill('SIGKILL') }, CLOSE_GRACE_MS)
    child?.stdin.end()
    await this.exited
    clearTimeout(killer)
  }

  private send(line: string): void {
    this.child?.stdin.write(line + '\n')
  }

  /** The process ended or broke: fail its runs; the next run starts a new one. */
  private lost(child: ChildProcessWithoutNullStreams, failure: PtcRunFailure): void {
    if (this.child !== child) return
    this.child = undefined
    for (const run of this.runs.values()) run.fail(failure)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }

  private onData(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    let start = 0
    for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, newline)
      const line = this.partial.length === 0 ? piece : Buffer.concat([...this.partial, piece])
      this.partial = []
      this.partialBytes = 0
      start = newline + 1
      this.onLine(child, line)
      if (this.child !== child) return
    }
    if (start < chunk.length) {
      this.partialBytes += chunk.length - start
      if (this.partialBytes > this.budgets.maxFrameBytes) {
        this.lost(child, { kind: 'protocol', message: `the moejs sidecar sent a frame longer than ${this.budgets.maxFrameBytes} bytes` })
        return
      }
      this.partial.push(Buffer.from(chunk.subarray(start)))
    }
  }

  private onLine(child: ChildProcessWithoutNullStreams, bytes: Buffer): void {
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
      this.lost(child, { kind: 'protocol', message: `invalid frame from the moejs sidecar: ${frame}` })
      return
    }
    // A cancel can cross a run's frames on the wire, so frames of a run that has ended are dropped.
    const run = this.runs.get(frame.run)
    if (run !== undefined && !run.done) run.handle(frame)
  }

  /** An idle sidecar does not keep the host process alive. */
  private updateRef(): void {
    const child = this.child
    if (child === undefined) return
    const busy = this.runs.size > 0
    for (const handle of [child, child.stdout, child.stderr, child.stdin] as { ref(): void; unref(): void }[]) {
      if (busy) handle.ref()
      else handle.unref()
    }
  }
}
