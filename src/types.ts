// dsh-email shared types: the EMAIL_* account model, the error-code vocabulary,
// and the wire shapes of the email tool (verb args and result documents).
//
// Pure type surface plus one small value (the error-code set); safe to import
// from every module and from the selftest.

import type { Context } from '@deepseek-ai/cordis'

export type { Context }

/**
 * The TLS mode of one endpoint (an explicit mode setting, not a switch):
 * 'tls' = implicit TLS, a direct TLS handshake on the port (993/465-class);
 * 'starttls' = a plaintext connection upgraded through a mandatory STARTTLS
 * (143/587-class) - a server without STARTTLS fails the connection, never a
 * plaintext downgrade; 'none' = full plaintext, no TLS at all (an explicit
 * operator choice: credentials and mail traverse the wire unencrypted).
 */
export type TlsMode = 'none' | 'tls' | 'starttls'

/**
 * A network endpoint pair as configured per account. `tls` carries the mode;
 * `allowInsecure` = true explicitly accepts untrusted (self-signed / invalid)
 * server certificates, default false = strict validation (only meaningful in
 * the 'tls' and 'starttls' modes).
 */
export interface TlsEndpoint {
  host: string
  port: number
  tls: TlsMode
  allowInsecure: boolean
}

/** One configured mail account (IMAP + SMTP endpoint pair, shared credentials). */
export interface AccountConfig {
  name: string
  user: string
  pass: string
  imap: TlsEndpoint
  smtp: TlsEndpoint
  /** Sender address (defaults to `user`). */
  from: string
  /** Sender display name (RFC 2047 encoded on the wire when non-ASCII). */
  fromName?: string
  /** When set, a successful send APPENDs the sent MIME source to this folder. */
  sentFolder?: string
  /**
   * When the SENT_FOLDER copy fails because the folder does not exist,
   * whether to CREATE the folder (IMAP CREATE, once) and retry the APPEND.
   * The exact folder name INBOX (case-insensitive) is never created: servers
   * reserve it, and appending to INBOX is valid without any creation. A
   * CREATE failure (permission, quota, server policy) degrades to the plain
   * copy-failure behavior: the original failure is reported, the delivered
   * message is never rolled back.
   */
  sentFolderAutocreate: boolean
  /**
   * Whether the agent may delete mail on this account (the destructive verbs
   * `delete` and `delete_folder`). Default false = deny (the agent treats the
   * mailbox as read-plus-archive only: list / read / mark / move are always
   * available, and a move is recoverable because the message remains in its
   * destination folder). An operator sets it true only for mailboxes the
   * agent manages outright; a mailbox shared with a human stays false.
   */
  allowDelete: boolean
  /** Per-call timeout budget in milliseconds (connect + command + transfer). */
  timeoutMs: number
  /** True when EMAIL_DEFAULT_ACCOUNT points at this account. */
  isDefault: boolean
}

/** The parsed EMAIL_* contract (read once at plugin boot). */
export interface EmailConfig {
  accounts: AccountConfig[]
  /** Body truncation budget for the read verb, in characters. */
  readBodyLimit: number
}

/**
 * Error codes carried by the failure surface `{ ok: false, error, code }`.
 * The code is transport-origin only: local validation errors (missing
 * parameters, part-selector ambiguity, unknown verb) carry no code.
 */
export type ErrorCode = 'auth' | 'network' | 'tls' | 'timeout' | 'protocol' | 'server'

/** Error codes the client wrappers can attach (the closed vocabulary). */
export const ERROR_CODES: readonly ErrorCode[] = ['auth', 'network', 'tls', 'timeout', 'protocol', 'server']

/** A mail address as presented to the agent (display name + address). */
export interface AddressView {
  name?: string
  address: string
}

/** MIME part classification (body parts and attachments share one list). */
export type PartKind = 'text' | 'html' | 'attachment' | 'other'

/** One entry of the read result `parts` list (MIME document order). */
export interface PartView {
  index: number
  kind: PartKind
  filename?: string
  contentType: string
  size?: number
}

/** One row of the list / list_unseen / search result `messages` array. */
export interface ListMessage {
  uid: number
  messageId?: string
  from?: AddressView
  to?: AddressView[]
  subject?: string
  /** INTERNALDATE (server receive time) as ISO 8601 UTC. */
  date?: string
  seen: boolean
  flagged: boolean
}

/** The read result `body` field (first text/plain, else first text/html). */
export interface BodyView {
  kind: 'text' | 'html'
  text: string
  /** True when the decoded body exceeded the read-body budget. */
  truncated: boolean
  /** Decoded character count before truncation. */
  totalLength: number
}

/**
 * An APPEND attempt result for the send verb (partial-success surface). When a
 * copy that failed on a missing folder is cured by an auto-create (see
 * AccountConfig.sentFolderAutocreate), `created` reports whether this call
 * issued a successful CREATE (true) or the CREATE failed but the retry
 * succeeded anyway (false, e.g. a concurrent creator won the race). Absent
 * when no create was attempted. A copy that still fails after all attempts
 * yields `{ error }`; the delivered message is never rolled back.
 */
export type AppendResult = { ok: true; created?: boolean } | { error: string }

/**
 * A message analyzed from one IMAP fetch (envelope + flags + source + body
 * structure). Internal to the tool layer; the verb handlers shape the public
 * results from it.
 */
export interface AnalyzedMessage {
  uid: number
  messageId?: string
  from?: AddressView
  to?: AddressView[]
  cc?: AddressView[]
  bcc?: AddressView[]
  subject?: string
  /** INTERNALDATE (server receive time) as ISO 8601 UTC. */
  date?: string
  seen: boolean
  flagged: boolean
  /** The RFC 5322 References list of the original message. */
  references: string[]
  /** Raw header block (truncated to the 16KB presentation bound). */
  rawHeaders: string
  /** Parts in MIME document order. */
  parts: PartView[]
  /** Part index -> bodystructure part number (for part downloads). */
  partNumbers: Map<number, string>
  /** Body part numbers in document order, by selection class. */
  textPartNumbers: string[]
  htmlPartNumbers: string[]
  /** Decoded content of the first text part (full, pre-truncation) for quoting. */
  firstTextContent?: string
  /** Decoded content of the first html part (full, pre-truncation). */
  firstHtmlContent?: string
}

/** Outbound message request assembled by the send/reply/forward verbs. */
export interface SendRequest {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  text?: string
  html?: string
  replyTo?: string
  inReplyTo?: string
  references?: string[]
  /** Local file paths (send/reply) or pre-downloaded parts (forward). */
  attachments?: AttachmentSpec[]
}

/** One outbound attachment: a local file path or decoded inline content. */
export type AttachmentSpec =
  | { kind: 'path'; path: string }
  | { kind: 'buffer'; filename: string; contentType: string; content: Buffer }

/** The send-family result document. */
export interface SendResult {
  messageId: string
  append?: AppendResult
}
