/**
 * The host side of the sidecar protocol: validation of every frame the
 * sidecar sends, the log ledger, and the result of a run. Frame shapes are
 * described in the sidecar's package documentation (internal/sidecar).
 * @module dsh-ptc-moejs/protocol
 */

import type { PtcJsonValue, PtcRunFailure, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'

/** The wire version this host speaks. */
export const PROTOCOL = 2

/** Bytes around a value in one frame, reserved out of the frame budget. */
export const FRAME_ENVELOPE = 256

/** The failure kinds a done frame may carry. A timeout here is the memory budget, which the sidecar enforces. */
const SIDECAR_KINDS: ReadonlySet<string> = new Set(['exception', 'invalid-output', 'output-limit', 'timeout', 'protocol', 'worker-exit'])

/** One frame from the sidecar, rebuilt field by field. */
export type SidecarFrame =
  | { type: 'boot-ack'; protocol: number }
  | { type: 'call'; run: number; id: number; global: string; name: string; args: PtcJsonValue }
  | { type: 'log'; run: number; text: string; truncated: boolean }
  | { type: 'done'; run: number; value?: PtcJsonValue; error?: PtcRunFailure }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Parse and validate one line from the sidecar.
 * @param line - one JSON line, without its newline.
 * @returns the rebuilt frame, or a string that says what is wrong with it.
 */
export function parseFrame(line: string): SidecarFrame | string {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return 'a frame is not JSON'
  }
  if (!record(raw)) return 'a frame is not an object'
  if (raw.type === 'boot-ack') {
    return typeof raw.protocol === 'number' ? { type: 'boot-ack', protocol: raw.protocol } : 'invalid boot-ack frame'
  }
  if (!positiveInteger(raw.run)) return 'a frame has no valid run id'
  const run = raw.run
  switch (raw.type) {
    case 'call':
      if (!positiveInteger(raw.id) || typeof raw.global !== 'string' || typeof raw.name !== 'string') return 'invalid call frame'
      // JSON.parse turns "-0" into -0 and "1e400" into Infinity, and isJsonValue rejects both.
      if (!Object.hasOwn(raw, 'args') || !isJsonValue(raw.args)) return 'call arguments are not lossless JSON'
      return { type: 'call', run, id: raw.id, global: raw.global, name: raw.name, args: raw.args as PtcJsonValue }
    case 'log':
      if (typeof raw.text !== 'string') return 'invalid log frame'
      return { type: 'log', run, text: raw.text, truncated: raw.truncated === true }
    case 'done': {
      const hasValue = Object.hasOwn(raw, 'value')
      if (hasValue && !isJsonValue(raw.value)) return 'a completion value is not lossless JSON'
      if (raw.error === undefined) {
        return hasValue ? { type: 'done', run, value: raw.value as PtcJsonValue } : { type: 'done', run }
      }
      const error = raw.error
      if (hasValue || !record(error) || typeof error.message !== 'string' || typeof error.kind !== 'string' || !SIDECAR_KINDS.has(error.kind)) {
        return 'invalid done frame'
      }
      return { type: 'done', run, error: { kind: error.kind as PtcRunFailure['kind'], message: error.message } }
    }
    default:
      return 'a frame has an unknown type'
  }
}

/** UTF-8 bytes of the JSON text of a value, which the log and value budgets count. */
export function jsonBytes(value: PtcJsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** The marker ending a diagnostic cut to its budget. */
export const TRUNCATION_MARKER = '… [truncated]'

/**
 * Cap a diagnostic at maxBytes of serialized JSON, marker included.
 * @param message - the failure message.
 * @param maxBytes - the value budget, which diagnostics share.
 * @returns the message, or a prefix of it that ends with the marker.
 */
export function capMessage(message: string, maxBytes: number): string {
  if (message.length * 6 + 2 <= maxBytes || jsonBytes(message) <= maxBytes) return message
  let low = 0
  let high = Math.min(message.length, maxBytes)
  // The longest prefix whose JSON, with the marker, fits.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (jsonBytes(message.slice(0, middle) + TRUNCATION_MARKER) <= maxBytes) low = middle
    else high = middle - 1
  }
  let end = low
  // Never split a surrogate pair.
  const code = message.charCodeAt(end - 1)
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1
  return message.slice(0, end) + TRUNCATION_MARKER
}

/**
 * The logs of one run under the log budget. The budget counts the logs as
 * dsh serializes them, a JSON array of strings. The marker line that ends a
 * cut run is outside the budget.
 */
export class LogLedger {
  readonly logs: string[] = []
  private left: number
  private cut = false

  constructor(private readonly maxBytes: number) {
    // Each entry pays for its JSON string and the "[" or "," before it, so
    // one byte stays for the closing "]".
    this.left = maxBytes - 1
  }

  /** The line marking where capture stopped. */
  static marker(maxBytes: number): string {
    return `[dsh-ptc-moejs] log capture truncated at ${maxBytes} bytes`
  }

  /**
   * Admit one entry, or stop capture when it does not fit.
   * @param text - one console line.
   */
  admit(text: string): void {
    if (this.cut) return
    const cost = text.length + 3 > this.left ? undefined : jsonBytes(text) + 1
    if (cost === undefined || cost > this.left) {
      this.truncate()
      return
    }
    this.left -= cost
    this.logs.push(text)
  }

  /** Stop capture and append the marker once. */
  truncate(): void {
    if (this.cut) return
    this.cut = true
    this.logs.push(LogLedger.marker(this.maxBytes))
  }
}

/**
 * The result of a run that completed.
 * @param ledger - the run's logs.
 * @param value - the completion value, if any.
 * @param maxValueBytes - the value budget.
 * @returns the seam result, with output-limit for a value over the budget.
 */
export function successResult(ledger: LogLedger, value: PtcJsonValue | undefined, maxValueBytes: number): PtcRunResult {
  if (value === undefined) return { logs: ledger.logs }
  if (jsonBytes(value) > maxValueBytes) {
    return { logs: ledger.logs, error: { kind: 'output-limit', message: `completion value exceeded ${maxValueBytes} bytes` } }
  }
  return { logs: ledger.logs, value }
}

/**
 * The result of a run that failed.
 * @param ledger - the run's logs.
 * @param failure - why it failed.
 * @param maxValueBytes - the budget the message is capped at.
 * @returns the seam result.
 */
export function failureResult(ledger: LogLedger, failure: PtcRunFailure, maxValueBytes: number): PtcRunResult {
  return { logs: ledger.logs, error: { kind: failure.kind, message: capMessage(failure.message, maxValueBytes) } }
}

/** The text of an error or any thrown value. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return 'unrenderable error'
  }
}
