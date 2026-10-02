// dsh-email shared utilities: plugin identifier, error classification onto the
// closed code vocabulary, the per-call timeout deadline, and low-level helpers
// (error message extraction, plain-object check, stream buffering, charset
// decoding, address formatting).
//
// Node built-ins plus the two client libraries only; safe to import from the
// selftest (no framework packages).
import { AuthenticationFailure, ImapFlowErrorCode } from 'imapflow'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'

import type { AddressView, ErrorCode } from './types.js'

/** Plugin identifier (registered name, logger tag, skill provider name, prompt section name). */
export const PLUGIN_NAME = 'dsh-email'

/** The dsh-email version the IMAP ID command reports (clientInfo payload). */
export const PLUGIN_VERSION = '0.1.0'

/** Error message extraction (catch variables are unknown under strict). */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Plain-object check: an object that is neither null nor an array. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Resolve the package root: both src/ (development) and lib/ (compiled) sit one level
 * below the package root, so '..' from this file's directory is the package root in
 * both states.
 * @returns absolute package root path.
 */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * A classified transport failure: the message is the raw upstream text
 * (pass-through, no decoration) and `code` names the failure class for the
 * agent's troubleshooting branch. Local validation errors are plain errors
 * without a code and are never classified.
 */
export class EmailError extends Error {
  readonly code?: ErrorCode
  constructor(message: string, code?: ErrorCode) {
    super(message)
    this.name = 'EmailError'
    this.code = code
  }
}

/** The overall-budget deadline breach (distinct from the library timeout codes). */
export class TimeoutError extends Error {
  constructor(budgetMs: number) {
    super(`operation exceeded the ${budgetMs} ms timeout budget`)
    this.name = 'TimeoutError'
  }
}

/**
 * A local (non-transport) failure: argument or message-data validation. Local
 * errors surface without a code, and keep doing so even when they are thrown
 * inside a connection session (the classifier never maps them onto a
 * transport class, so a wrapped local error stays local).
 */
export class LocalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalError'
  }
}

/**
 * Run a promise under an overall time budget. The budget covers connect plus
 * command plus transfer; on breach the rejection is a TimeoutError (code
 * timeout) and the caller's finally block closes the connection.
 * @param p the work to bound.
 * @param ms the budget in milliseconds.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
    timer.unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** Node error codes that are network-plane failures. */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN'])

/** Node error codes that are TLS-plane failures. */
const TLS_CODES = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_BAD_RECORD_MAC', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'])

/**
 * A 5xx server response code at the start of the message or right after a
 * separator, e.g. "552 5.3.0 ..." or "Message failed: 552 5.3.0 ...".
 */
const FIVE_X_RE = /(^|[:\s])5\d\d[\s.]/

/** imapflow structured codes that are timeout-plane failures. */
const IMAP_TIMEOUT_CODES = new Set(['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEOUT'])

/** imapflow structured codes that are protocol-plane failures. */
const IMAP_PROTOCOL_CODES = new Set([
  'InvalidResponse',
  'ResponseProcessingFailed',
  'UnexpectedTag',
  'LineTooLarge',
  'LiteralTooLarge',
  'ResponseTooLarge',
  'InvalidSearchQuery',
  'InvalidSequenceSet',
  'InvalidStringValue',
  'InvalidTokenValue',
  'InvalidTextValue',
  'STARTTLS_INJECTION',
  'COMPRESS_TRAILING_DATA',
  'PollFailed',
  'MAX_IMAP_NESTING_REACHED',
  'DownloadOverflow',
  'DownloadIncomplete',
  'LockTimeout',
  'MissingServerExtension',
])

/**
 * True when the error is one thrown by the imapflow client. imapflow's error
 * type is not a runtime-constructible value import, so detection reads the
 * markers the client actually attaches: the exported AuthenticationFailure
 * class, the authenticationFailed / tlsFailed / mailboxMissing boolean flags,
 * a `code` that is one of the ImapFlowErrorCode tokens, or a serverResponseCode
 * status token.
 * @param err the caught error.
 */
function isImapFlowError(err: Error): boolean {
  if (err instanceof AuthenticationFailure) return true
  const e = err as unknown as Record<string, unknown>
  if (e.authenticationFailed === true || e.tlsFailed === true || e.mailboxMissing === true) return true
  if (typeof e.code === 'string' && Object.prototype.hasOwnProperty.call(ImapFlowErrorCode, e.code)) return true
  if (typeof e.serverResponseCode === 'string') return true
  const status = typeof e.responseStatus === 'string' ? e.responseStatus : ''
  if (status === 'NO' || status === 'BAD') return true
  return false
}

/** The string `code` attached to an error by the client libraries (else undefined). */
function codeOf(err: Error): string | undefined {
  const c = (err as { code?: unknown }).code
  return typeof c === 'string' ? c : undefined
}

/**
 * Classify an upstream error onto the closed code vocabulary. The classification
 * reads the structured fields of the client libraries first (imapflow
 * authenticationFailed / tlsFailed / code / mailboxMissing / responseStatus /
 * serverResponseCode markers; nodemailer error codes EAUTH / EPROTOCOL /
 * ECONNECTION and its cause chain) and falls back to Node errno conventions.
 * Server command rejections split on the IMAP status token: BAD (the server
 * could not process the command) is protocol, NO (the server processed and
 * refused it) is server; the fallback class is protocol.
 * @param err the caught error (unknown under strict).
 * @returns the error code, or undefined when the error is not transport-classified.
 */
export function classifyError(err: unknown): ErrorCode | undefined {
  if (err instanceof EmailError) return err.code
  if (!(err instanceof Error)) return undefined
  if (err.name === 'TimeoutError') return 'timeout'
  if (isImapFlowError(err)) return classifyImapFlowError(err)

  const code = codeOf(err)
  if (code !== undefined) {
    if (code === 'EAUTH' || code === 'INVALID_LOGIN') return 'auth'
    if (code === 'EPROTOCOL') return 'protocol'
    // nodemailer labels a failed STARTTLS negotiation (a rejected STARTTLS
    // command or a failed upgrade) ETLS
    if (code === 'ETLS') return 'tls'
    // nodemailer labels a rejected DATA transfer EMESSAGE with the server
    // response embedded in the message; a 5xx response is a server refusal
    if (code === 'EMESSAGE' && FIVE_X_RE.test(err.message)) return 'server'
    if (code === 'ECONNECTION') return classifyCauseOr(err)
    if (code === 'ETIMEDOUT') return 'timeout'
    if (NETWORK_CODES.has(code)) return 'network'
    if (TLS_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) return 'tls'
  }
  const byMessage = classifyByMessage(err)
  if (byMessage !== undefined) return byMessage
  if (err.cause instanceof Error) {
    const causeCode = classifyError(err.cause)
    if (causeCode !== undefined) return causeCode
  }
  if (/authentication failed|invalid login/i.test(err.message)) return 'auth'
  if (FIVE_X_RE.test(err.message) || /\bserver (response|rejected)|response=5/i.test(err.message)) return 'server'
  return 'protocol'
}

/**
 * Classify one imapflow error from its structured fields (the marker booleans,
 * the ImapFlowErrorCode token, and the Node errno codes that pass through the
 * library's socket layer).
 * @param err the caught imapflow error.
 */
function classifyImapFlowError(err: Error): ErrorCode {
  const e = err as unknown as Record<string, unknown>
  if (err instanceof AuthenticationFailure || e.authenticationFailed === true) return 'auth'
  if (e.tlsFailed === true) return 'tls'
  const code = typeof e.code === 'string' ? e.code : undefined
  if (code !== undefined) {
    if (IMAP_TIMEOUT_CODES.has(code)) return 'timeout'
    if (IMAP_NETWORK_CODES.has(code)) return 'network'
    if (code.startsWith('ParserError') || IMAP_PROTOCOL_CODES.has(code)) return 'protocol'
    if (NETWORK_CODES.has(code)) return 'network'
    if (TLS_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) return 'tls'
    if (code === 'ETIMEDOUT') return 'timeout'
  }
  if (e.mailboxMissing === true) return 'server'
  const status = typeof e.responseStatus === 'string' ? e.responseStatus.toUpperCase() : undefined
  if (status === 'BAD') return 'protocol'
  if (status === 'NO') return 'server'
  if (e.serverResponseCode === 'BAD') return 'protocol'
  if (e.serverResponseCode !== undefined) return 'server'
  return 'protocol'
}

/** The imapflow code tokens that are network-plane failures. */
const IMAP_NETWORK_CODES = new Set(['NoConnection', 'EConnectionClosed', 'EPROXY', 'ProxyError', 'UnsupportedProxyAddress', 'ERR_INVALID_URL'])

/** Classify a nodemailer connection error from its cause chain (else network). */
function classifyCauseOr(err: Error): ErrorCode {
  if (err.cause instanceof Error) {
    const causeCode = classifyError(err.cause)
    if (causeCode !== undefined) return causeCode
  }
  return 'network'
}

/** Message-sniff classification for errors without a structured code. */
function classifyByMessage(err: Error): ErrorCode | undefined {
  const msg = err.message
  if (/self[- ]signed certificate|unable to verify the first certificate|certificate is not trusted|certificate has expired|altname|starttls/i.test(msg)) {
    return 'tls'
  }
  if (/getaddrinfo|dns/i.test(msg) && /ENOTFOUND|EAI_AGAIN/.test(msg)) return 'network'
  return undefined
}

/**
 * Buffer a readable stream to completion.
 * @param r the stream (e.g. an imapflow part download content stream).
 */
export function toBuffer(r: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    r.on('data', (c: Buffer) => chunks.push(c))
    r.on('end', () => resolve(Buffer.concat(chunks)))
    r.on('error', reject)
  })
}

/**
 * Decode a CTE-decoded byte buffer from a MIME charset (full-ICU Node
 * TextDecoder covers GBK / BIG5 / Shift_JIS / the ISO-8859 family and more).
 * Unknown labels fall back to UTF-8 with replacement (never throws).
 * @param buf the decoded bytes.
 * @param charset the Content-Type charset parameter (may be absent).
 */
export function decodeText(buf: Buffer, charset?: string): string {
  const label = (charset ?? 'utf-8').toLowerCase()
  try {
    return new TextDecoder(label).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

/**
 * Format one address for presentation: the display name in quotes before the
 * address when present.
 * @param a the address view (or null/undefined when the message has none).
 */
export function formatAddress(a?: AddressView | null): string {
  if (!a) return ''
  if (a.name) return `"${a.name}" <${a.address}>`
  return a.address
}

/** Format an address list for presentation (comma separated). */
export function formatAddresses(a?: AddressView[]): string {
  if (!a || a.length === 0) return ''
  return a.map((x) => formatAddress(x)).join(', ')
}
