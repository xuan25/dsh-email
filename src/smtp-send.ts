// dsh-email SMTP send layer: one fresh transport per call (no pooling).
// The single-source guarantee: the message is composed exactly once with
// nodemailer's MailComposer (explicit Message-ID and Date pinned by the
// caller, so composition is deterministic); that composed source is what is
// delivered (raw send) and what the SENT_FOLDER APPEND writes, so the sent
// folder copy is byte-identical to the message on the wire. The explicit
// envelope (from + to + cc + bcc) puts the Bcc recipients on the SMTP wire
// while the Bcc header stays out of the MIME source, per RFC 5322/5321.
//
// Failures surface as EmailError with the closed code vocabulary: nodemailer
// error codes map EAUTH -> auth, EPROTOCOL -> protocol, ECONNECTION -> network
// (its cause chain is classified for TLS/DNS specifics), and 5xx SMTP
// responses -> server. The account TLS mode drives the transport: 'starttls'
// makes STARTTLS mandatory (requireTLS), so a server without STARTTLS fails
// the send instead of degrading to plaintext; 'none' stays on plaintext
// without ever attempting STARTTLS (ignoreTLS).
import MailComposer from 'nodemailer/lib/mail-composer'
import { createTransport } from 'nodemailer'
import { detectMimeType } from 'nodemailer/lib/mime-funcs'
import { randomUUID } from 'node:crypto'

import type { AccountConfig, SendRequest, SendResult } from './types.js'
import { classifyError, EmailError, errMsg, toBuffer } from './util.js'

/**
 * Build the composer data for one account and one request: every field the
 * composer would otherwise derive (Message-ID, Date) is pinned explicitly so
 * the composition is deterministic. Attachment entries are fully specified
 * (filename + contentType) so no later normalization step can alter them.
 * @param acct the sending account.
 * @param req the send request.
 */
function buildComposerData(acct: AccountConfig, req: SendRequest) {
  const data: Record<string, unknown> = {
    from: acct.fromName !== undefined ? `${acct.fromName} <${acct.from}>` : acct.from,
    to: req.to,
    subject: req.subject ?? '',
    messageId: `<${randomUUID()}@${domainOf(acct.from)}>`,
    date: new Date(),
  }
  if (req.cc && req.cc.length > 0) data.cc = req.cc
  if (req.bcc && req.bcc.length > 0) data.bcc = req.bcc
  if (req.text !== undefined) data.text = req.text
  if (req.html !== undefined) data.html = req.html
  if (req.replyTo !== undefined) data.replyTo = req.replyTo
  if (req.inReplyTo !== undefined) data.inReplyTo = req.inReplyTo
  if (req.references && req.references.length > 0) data.references = req.references
  const attachments = req.attachments ?? []
  if (attachments.length > 0) {
    // every attachment is emitted as an attachment: the composer only adds a
    // Content-Disposition: attachment header when asked, and the receive side
    // keys the attachment parts on that header
    data.attachments = attachments.map((a) =>
      a.kind === 'path'
        ? {
            path: a.path,
            filename: baseName(a.path),
            contentType: detectMimeType(baseName(a.path)) || 'application/octet-stream',
            disposition: 'attachment',
          }
        : { filename: a.filename, contentType: a.contentType, content: a.content, disposition: 'attachment' },
    )
  }
  return data
}

/** The domain part of an address (for the Message-ID domain); falls back to a literal. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 0 || at === address.length - 1) return 'localhost'
  return address.slice(at + 1)
}

/** Base name of a path (POSIX and Windows separators). */
function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const name = idx >= 0 ? p.slice(idx + 1) : p
  return name || 'attachment'
}

/**
 * Compose the message MIME source exactly once (the bytes the send transmits
 * and the SENT_FOLDER copy carries).
 * @param acct the sending account.
 * @param req the send request.
 * @returns the MIME source as a UTF-8 string.
 */
export async function composeSource(acct: AccountConfig, req: SendRequest): Promise<string> {
  const node = new MailComposer(buildComposerData(acct, req)).compile()
  const buf = await toBuffer(node.createReadStream())
  return buf.toString('utf8')
}

/**
 * The SMTP envelope for one request: the account sender plus every recipient
 * (to + cc + bcc) - the Bcc recipients exist only on the wire, never in the
 * message headers.
 * @param acct the sending account.
 * @param req the send request.
 */
function buildEnvelope(acct: AccountConfig, req: SendRequest): { from: string; to: string[] } {
  const to = [...req.to]
  if (req.cc) to.push(...req.cc)
  if (req.bcc) to.push(...req.bcc)
  return { from: acct.from, to }
}

/** Wrap an upstream error into the classified EmailError (code vocabulary). */
function fail(acct: AccountConfig, err: unknown): never {
  const code = classifyError(err)
  throw new EmailError(`smtp account "${acct.name}": ${errMsg(err)}`, code)
}

/**
 * Deliver one pre-composed MIME source over a fresh SMTP connection from the
 * account TLS mode: 'tls' is a direct handshake, 'starttls' is a mandatory
 * STARTTLS upgrade (a server without it fails the send, never a plaintext
 * downgrade), and 'none' stays on plaintext without ever attempting STARTTLS.
 * Password auth uses the account credentials. The explicit envelope carries
 * the full recipient set including Bcc.
 * @param acct the sending account.
 * @param source the composed MIME source.
 * @param envelope the SMTP envelope.
 * @returns the message id reported by the transport (parsed from the source).
 */
export async function deliver(acct: AccountConfig, source: string, envelope: { from: string; to: string[] }): Promise<string> {
  const transport = createTransport({
    host: acct.smtp.host,
    port: acct.smtp.port,
    // 'tls' is a direct handshake; every other mode starts on plaintext.
    secure: acct.smtp.tls === 'tls',
    // 'starttls' makes STARTTLS mandatory: the client fails the send when the
    // server lacks STARTTLS instead of continuing unencrypted (the library's
    // opportunistic default is the plaintext hole); it takes precedence over
    // the opportunistic fallback. 'none' disables STARTTLS entirely.
    requireTLS: acct.smtp.tls === 'starttls',
    // 'none' ignores the server's STARTTLS capability even when advertised,
    // so the session stays on plaintext (never used together with requireTLS).
    ignoreTLS: acct.smtp.tls === 'none',
    auth: { user: acct.user, pass: acct.pass },
    // The account field carries the operator-facing semantics of the env
    // variable (default false = strict validation; true = explicitly accept
    // untrusted / self-signed certificates). Node's rejectUnauthorized is the
    // negation, so the mapping inverts it at the connection boundary.
    tls: { rejectUnauthorized: !acct.smtp.allowInsecure },
    connectionTimeout: acct.timeoutMs,
    socketTimeout: acct.timeoutMs,
    logger: false,
  })
  try {
    const info = await transport.sendMail({ raw: source, envelope })
    return info.messageId
  } catch (err) {
    throw fail(acct, err)
  } finally {
    try {
      transport.close()
    } catch {
      // best-effort close: a transport that never connected has nothing to close
    }
  }
}

/**
 * The full send-family flow: compose once, deliver, then - when the account
 * configures a SENT_FOLDER - APPEND the same composed source to it. An
 * APPEND failure is a partial success: the message was sent, the copy failed
 * (no rollback); the failure text is reported on the append field. A copy
 * that fails on a missing folder is cured by the append step's auto-create
 * (see appendSource); on success the `created` flag from that step is
 * surfaced on the append field.
 * @param acct the sending account.
 * @param req the send request.
 * @param appendSourceTo the append step (imap-client appendSource), injected
 * to keep this module transport-pure.
 * @returns the send result (messageId plus the append outcome when configured).
 */
export async function sendWithAppend(
  acct: AccountConfig,
  req: SendRequest,
  appendSourceTo: (
    acct: AccountConfig,
    folder: string,
    source: string,
  ) => Promise<{ created?: boolean }>,
): Promise<SendResult> {
  const source = await composeSource(acct, req)
  const messageId = await deliver(acct, source, buildEnvelope(acct, req))
  const result: SendResult = { messageId }
  if (acct.sentFolder !== undefined) {
    try {
      const appended = await appendSourceTo(acct, acct.sentFolder, source)
      result.append = appended.created === undefined ? { ok: true } : { ok: true, created: appended.created }
    } catch (err) {
      result.append = { error: errMsg(err) }
    }
  }
  return result
}
