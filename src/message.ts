// dsh-email message analysis: turns one IMAP fetch (envelope + flags + source
// + body structure) into the AnalyzedMessage the verb handlers shape into
// results. imapflow parses the MIME body structure natively (the part list is
// the BODYSTRUCTURE tree walked in document order), and part content arrives
// CTE-decoded through the PEEK download path. Charset ownership of the
// delivered bytes: inline text parts with a known non-UTF-8 charset are
// delivered transcoded to UTF-8 (the download metadata reports the delivered
// charset); attachment parts and parts with an unknown charset are delivered
// as the raw wire bytes. Decoding applies the delivered charset (full-ICU
// TextDecoder); no second MIME parser sits in the code path.
//
// Reads are flag-neutral: the fetch uses BODY.PEEK (imapflow 2.x content
// default) and the part download uses the PEEK section form, so reading or
// saving a part never flips the SEEN flag.
import type { FetchMessageObject, MessageStructureObject } from 'imapflow'

import { withImapSession, type ImapSession } from './imap-client.js'
import type { AccountConfig, AddressView, AnalyzedMessage, PartView } from './types.js'
import { decodeText, toBuffer } from './util.js'

/** Presentation bound for the raw header block (characters). */
export const RAW_HEADERS_LIMIT = 16_384

/** The marker appended when the header block exceeds the presentation bound. */
export const RAW_HEADERS_TRUNCATED = '[dsh-email: header block truncated]'

/** The fetch items a read-side verb requests (PEEK content path). */
interface FetchItems {
  uid: true
  flags: true
  envelope: true
  internalDate: true
  bodyStructure: true
  headers: true
  source?: true
}

/**
 * Build the fetch data items for one message. The full message source is
 * requested only when the caller needs it (raw headers / references); the
 * part content arrives through the separate PEEK download, so the source is
 * the sole heavy payload and is omitted for parts-only work (save_part).
 * @param withSource whether to include the full message source in the fetch.
 */
function fetchItems(withSource: boolean): FetchItems {
  const items: FetchItems = { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true, headers: true }
  if (withSource) items.source = true
  return items
}

/** The fetch profile of one verb's message access. */
export interface FetchOptions {
  /** Fetch the full source (raw headers + references); omitted for parts-only work. */
  source?: boolean
  /** Download and decode the first text part (else the first html part). */
  body?: boolean
}

/** One body part of the extracted MIME tree, in document order. */
export interface ExtractedParts {
  parts: PartView[]
  /** Part index -> bodystructure part number (for part downloads). */
  partNumbers: Map<number, string>
  /** Body part numbers of the text parts in document order. */
  textPartNumbers: string[]
  /** Body part numbers of the html parts in document order. */
  htmlPartNumbers: string[]
}

/**
 * The part kind: an explicit attachment disposition or a filename marks the
 * part as an attachment (even for text types); otherwise text/plain and
 * text/html map to text and html, everything else is other.
 * @param node the bodystructure leaf.
 */
function partKind(node: MessageStructureObject): PartView['kind'] {
  const disposition = node.disposition?.toLowerCase()
  const filename = node.dispositionParameters?.filename
  if (disposition === 'attachment' || (filename !== undefined && filename.trim() !== '')) return 'attachment'
  if (node.type === 'text/plain') return 'text'
  if (node.type === 'text/html') return 'html'
  return 'other'
}

/** The part filename: Content-Disposition filename, else the Content-Type name parameter. */
function partFilename(node: MessageStructureObject): string | undefined {
  const fromDispositions = node.dispositionParameters?.filename
  if (fromDispositions !== undefined && fromDispositions.trim() !== '') return fromDispositions
  const fromType = node.parameters?.name
  if (fromType !== undefined && fromType.trim() !== '') return fromType
  return undefined
}

/**
 * Walk the body structure tree (multipart nodes recurse, message/rfc822
 * wrappers descend into their encapsulated message) into a flat parts list in
 * MIME document order.
 * @param root the message body structure (may be undefined for a bare message).
 */
export function extractParts(root: MessageStructureObject | undefined): ExtractedParts {
  const parts: PartView[] = []
  const partNumbers = new Map<number, string>()
  const textPartNumbers: string[] = []
  const htmlPartNumbers: string[] = []
  const walk = (node: MessageStructureObject): void => {
    if (node.childNodes && node.childNodes.length > 0) {
      for (const child of node.childNodes) walk(child)
      return
    }
    const kind = partKind(node)
    const filename = partFilename(node)
    const contentType = node.type
    // A single-part (non-multipart) message carries no part number in the IMAP
    // body structure; its whole body is addressable as part "1" (the download
    // path routes single-node messages through the TEXT section), so the root
    // leaf is synthesized to "1" to stay readable and savable.
    const partNumber = node.part === undefined && node.childNodes === undefined ? '1' : node.part
    if (partNumber === undefined) return
    const index = parts.length
    const view: PartView = { index, kind, contentType }
    if (filename !== undefined) view.filename = filename
    if (node.size !== undefined) view.size = node.size
    parts.push(view)
    partNumbers.set(index, partNumber)
    if (kind === 'text') textPartNumbers.push(partNumber)
    else if (kind === 'html') htmlPartNumbers.push(partNumber)
  }
  if (root !== undefined) walk(root)
  return { parts, partNumbers, textPartNumbers, htmlPartNumbers }
}

/** The raw header block of the message source (headers only). */
export function extractHeaderBlock(source: Buffer): string {
  const crlf = source.indexOf('\r\n\r\n')
  if (crlf >= 0) return source.slice(0, crlf + 4).toString('utf8')
  const lf = source.indexOf('\n\n')
  if (lf >= 0) return source.slice(0, lf + 2).toString('utf8')
  return source.toString('utf8')
}

/**
 * The RFC 5322 References list of the message, parsed from the raw header
 * block (references are ASCII angle-bracket tokens; no decoding needed). The
 * header block is unfolded first, so a References field wrapped across lines
 * (continuation lines starting with a space or tab) is one field to match.
 * @param headerBlock the raw header block.
 */
export function extractReferences(headerBlock: string): string[] {
  const unfolded = headerBlock.replace(/\r?\n[ \t]/g, ' ')
  const m = unfolded.match(/^references[ :]([^\r\n]*)/im)
  if (!m) return []
  return m[1]
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/**
 * Shape the public raw header field: the header block capped at the
 * presentation bound (the marker makes truncation visible to the agent).
 * @param headerBlock the raw header block.
 */
export function presentRawHeaders(headerBlock: string): string {
  if (headerBlock.length <= RAW_HEADERS_LIMIT) return headerBlock
  return headerBlock.slice(0, RAW_HEADERS_LIMIT) + RAW_HEADERS_TRUNCATED
}

function toAddressView(a?: { name?: string; address?: string }): AddressView | undefined {
  if (!a || !a.address) return undefined
  return a.name ? { name: a.name, address: a.address } : { address: a.address }
}

function toAddressList(l?: Array<{ name?: string; address?: string }>): AddressView[] | undefined {
  if (!l || l.length === 0) return undefined
  const out = l.map(toAddressView).filter((x): x is AddressView => x !== undefined)
  return out.length > 0 ? out : undefined
}

/** True when the message flag set contains the given flag (case-insensitive). */
export function hasFlag(flags: Set<string> | undefined, flag: string): boolean {
  if (!flags) return false
  for (const f of flags) if (f.toLowerCase() === flag.toLowerCase()) return true
  return false
}

/**
 * Build the analyzed message from a fetch result plus the optional decoded
 * body contents (the first text / html part, when the caller downloaded them
 * in the same session).
 * @param msg the fetch result (envelope, flags, internalDate, source, body structure).
 * @param extracted the part tree extraction.
 * @param firstTextContent decoded content of the first text part (may be absent).
 * @param firstHtmlContent decoded content of the first html part (may be absent).
 */
export function buildAnalyzed(
  msg: FetchMessageObject,
  extracted: ExtractedParts,
  firstTextContent?: string,
  firstHtmlContent?: string,
): AnalyzedMessage {
  const source = msg.source ?? Buffer.alloc(0)
  const headerBlock = extractHeaderBlock(source)
  const out: AnalyzedMessage = {
    uid: msg.uid,
    seen: hasFlag(msg.flags, '\\Seen'),
    flagged: hasFlag(msg.flags, '\\Flagged'),
    references: extractReferences(headerBlock),
    rawHeaders: presentRawHeaders(headerBlock),
    parts: extracted.parts,
    partNumbers: extracted.partNumbers,
    textPartNumbers: extracted.textPartNumbers,
    htmlPartNumbers: extracted.htmlPartNumbers,
  }
  const env = msg.envelope
  if (env) {
    const from = toAddressView(env.from?.[0])
    if (from) out.from = from
    out.to = toAddressList(env.to)
    out.cc = toAddressList(env.cc)
    out.bcc = toAddressList(env.bcc)
    if (env.subject !== undefined) out.subject = env.subject
    if (env.messageId) out.messageId = env.messageId
  }
  const internal = msg.internalDate
  if (internal !== undefined) {
    const d = internal instanceof Date ? internal : new Date(internal)
    if (!Number.isNaN(d.getTime())) out.date = d.toISOString()
  }
  if (firstTextContent !== undefined) out.firstTextContent = firstTextContent
  if (firstHtmlContent !== undefined) out.firstHtmlContent = firstHtmlContent
  return out
}

/**
 * The session form of fetchAndAnalyze: fetch and analyze one message on the
 * given live session (the mailbox is opened read-only by this call), then -
 * when body contents are wanted - download the first text part (or, lacking
 * one, the first html part) and decode it. No flag changes.
 * @param session the live IMAP session.
 * @param folder the mailbox path.
 * @param uid the message uid.
 * @param opts the fetch profile (source / body switches).
 * @returns the analyzed message, or undefined when the uid does not exist.
 */
export async function analyzeOn(session: ImapSession, folder: string, uid: number, opts: FetchOptions = {}): Promise<AnalyzedMessage | undefined> {
  const withSource = opts.source === true
  const withBody = opts.body === true
  await session.client.mailboxOpen(folder, { readOnly: true })
  const msg = await session.client.fetchOne(uid, fetchItems(withSource), { uid: true })
  if (msg === false || msg === undefined) return undefined
  const extracted = extractParts(msg.bodyStructure)
  let textContent: string | undefined
  let htmlContent: string | undefined
  if (withBody) {
    const textPart = extracted.textPartNumbers[0]
    const htmlPart = extracted.htmlPartNumbers[0]
    if (textPart !== undefined) {
      textContent = await downloadPartText(session, uid, textPart)
    } else if (htmlPart !== undefined) {
      htmlContent = await downloadPartText(session, uid, htmlPart)
    }
  }
  return buildAnalyzed(msg, extracted, textContent, htmlContent)
}

/**
 * Fetch and analyze one message on a single connection: open the mailbox
 * read-only, fetch the requested PEEK data items, then - when body contents
 * are wanted - download the first text part (or, lacking one, the first html
 * part) and decode it. One connection, no flag changes.
 * @param acct the account to connect.
 * @param folder the mailbox path.
 * @param uid the message uid.
 * @param opts the fetch profile (source / body switches).
 * @returns the analyzed message, or undefined when the uid does not exist.
 */
export async function fetchAndAnalyze(acct: AccountConfig, folder: string, uid: number, opts: FetchOptions = {}): Promise<AnalyzedMessage | undefined> {
  return withImapSession(acct, folder, (session) => analyzeOn(session, folder, uid, opts))
}

/** Download one part through the session (PEEK) and decode it to text: the
 * delivered stream is consumed as-is, decoded with the delivered charset. */
async function downloadPartText(session: ImapSession, uid: number, part: string): Promise<string | undefined> {
  const result = await session.client.download(String(uid), part, { uid: true })
  if (!result || !result.content) return undefined
  const buf = await toBuffer(result.content)
  // The download metadata carries the charset of the delivered stream: a
  // transcoded inline text part reports utf-8, a raw part reports the wire
  // charset (or none). The bodystructure charset is the wire-side value and
  // may not match the delivered bytes, so the metadata is the authority.
  const charset = result.meta?.charset
  return decodeText(buf, charset)
}

/**
 * The first text content of an analyzed message for quoting (reply / forward
 * quote the original first text part line by line).
 * @param analyzed the analyzed message.
 */
export function quoteText(analyzed: AnalyzedMessage): string | undefined {
  const text = analyzed.firstTextContent
  if (text === undefined) return undefined
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n')
}
