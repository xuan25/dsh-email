// dsh-email part-saving: resolves the requested part of one analyzed message
// (by part index or by filename), downloads it through the PEEK path
// (streamed straight to disk), and writes it under the caller's path or the
// default attachments directory.
//
// The bytes on disk are exactly the bytes the client delivers for the part
// (transfer-encoding decoded; inline text parts with a known non-UTF-8
// charset are delivered transcoded to UTF-8 by the client, attachment and
// unknown-charset parts are delivered as the raw wire bytes) - the client
// stream is consumed as-is, no re-encoding is applied at save time. Filename
// presentation sanitizes server-side names that are not valid file names on
// the target filesystem.
import { createWriteStream } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { LocalError } from './util.js'

import type { ImapSession } from './imap-client.js'
import type { AnalyzedMessage, PartView } from './types.js'

/** The default directory (relative to the session working directory) for saved parts. */
export const DEFAULT_SAVE_DIR = 'attachments'

/** Extension per part kind (for default file names). */
function kindExtension(kind: PartView['kind']): string {
  if (kind === 'text') return 'txt'
  if (kind === 'html') return 'html'
  return 'bin'
}

/**
 * Sanitize a server-side file name for the target filesystem: keep only the
 * base name, replace characters that are not portable file-name characters
 * with underscores, drop an empty result.
 * @param name the raw file name.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned
}

/** One resolved part: the tree position, the download coordinates, and the presentation name. */
export interface ResolvedPart {
  part: PartView
  partNumber: string
  displayName: string
}

/**
 * Resolve the requested part of one message. A numeric part is a part index
 * into the parts list (0-based, MIME document order); a string part is a
 * filename match against the part file names (an attachment with a
 * Content-Disposition filename or a Content-Type name). A filename that
 * matches no part is an error listing the available part names; a filename
 * matching several parts is an ambiguity error listing the candidate
 * indexes.
 * @param analyzed the analyzed message.
 * @param part the part index or filename.
 */
export function resolvePart(analyzed: AnalyzedMessage, part: number | string): ResolvedPart {
  if (typeof part === 'number') {
    if (!Number.isInteger(part) || part < 0) throw new LocalError(`part ${part} is not a valid part index`)
    const p = analyzed.parts[part]
    if (p === undefined) {
      throw new LocalError(`part ${part} out of range: the message has ${analyzed.parts.length} parts (indexes 0-${analyzed.parts.length - 1})`)
    }
    return { part: p, partNumber: analyzed.partNumbers.get(part) ?? String(part), displayName: defaultName(analyzed.uid, p) }
  }
  const matches = analyzed.parts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.filename !== undefined && p.filename === part)
  if (matches.length === 0) {
    const names = analyzed.parts.filter((p) => p.filename !== undefined).map((p) => p.filename)
    const avail = names.length > 0 ? `available part filenames: ${names.join(', ')}` : 'the message has no named parts'
    throw new LocalError(`part "${part}" matches no part of the message; ${avail}`)
  }
  if (matches.length > 1) {
    const candidates = matches.map(({ p, i }) => `${i} (${p.filename})`).join(', ')
    throw new LocalError(`part "${part}" is ambiguous: ${candidates}; use the part index instead`)
  }
  const only = matches[0]
  return {
    part: only.p,
    partNumber: analyzed.partNumbers.get(only.i) ?? String(only.i),
    displayName: defaultName(analyzed.uid, only.p),
  }
}

/** The default saved file name for a part (the sanitized filename, else uid + kind extension). */
function defaultName(uid: number, p: PartView): string {
  if (p.kind === 'attachment' && p.filename !== undefined) {
    const clean = sanitizeFilename(p.filename)
    if (clean !== '') return clean
  }
  return `${uid}.${kindExtension(p.kind)}`
}

/**
 * The target file path for one saved part: an explicit path (a trailing slash
 * marks it as a directory) or the default attachments directory. Relative
 * paths resolve against the session working directory.
 * @param input the optional explicit path.
 * @param displayName the sanitized file name.
 */
export function targetPath(input: string | undefined, displayName: string): { dir: string; file: string } {
  if (input === undefined) {
    return { dir: path.resolve(process.cwd(), DEFAULT_SAVE_DIR), file: displayName }
  }
  if (input.endsWith('/') || input.endsWith('\\')) {
    return { dir: path.resolve(input), file: displayName }
  }
  return { dir: path.dirname(path.resolve(input)), file: path.basename(path.resolve(input)) }
}

/**
 * A path that does not already exist: the first free <base>-<n><ext>
 * variant (name collisions never overwrite an existing file).
 * @param dir the target directory (created by the caller).
 * @param file the candidate file name.
 */
export async function uniquePath(dir: string, file: string): Promise<string> {
  const ext = path.extname(file)
  const stem = file.slice(0, file.length - ext.length)
  const candidate = (n: number): string => (n === 0 ? file : `${stem}-${n}${ext}`)
  for (let n = 0; n < 1000; n++) {
    const full = path.join(dir, candidate(n))
    try {
      await access(full)
    } catch {
      return full
    }
  }
  throw new LocalError(`no free file name in ${dir} after 1000 collision suffixes`)
}

/** Stream one part through the session to a file (PEEK; the session owns the
 * mailbox open). */
async function streamPartToFileOn(session: ImapSession, uid: number, partNumber: string, dest: string): Promise<number> {
  const result = await session.client.download(String(uid), partNumber, { uid: true })
  if (!result || !result.content) {
    throw new LocalError(`part ${partNumber} of uid ${uid} has no downloadable content`)
  }
  const content = result.content
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(dest)
    content.on('error', reject)
    ws.on('error', reject)
    ws.on('close', () => {
      bytes = ws.bytesWritten
      resolve()
    })
    content.pipe(ws)
  })
  return bytes
}

/**
 * Save one part of one message to disk: resolve the part (index or filename),
 * prepare the target (explicit path or the default attachments directory,
 * created on demand), stream the part through the PEEK download path on the
 * given session, and report the written location and byte count.
 * @param session the live IMAP session (its mailbox is already open).
 * @param analyzed the analyzed message (the parts tree).
 * @param part the part index or filename.
 * @param destPath an explicit target file path (or directory with a trailing slash); default <cwd>/attachments/.
 * @returns the save result (absolute path, bytes written, file name).
 */
export async function savePart(
  session: ImapSession,
  analyzed: AnalyzedMessage,
  part: number | string,
  destPath?: string,
): Promise<{ path: string; bytes: number; filename: string }> {
  const resolved = resolvePart(analyzed, part)
  const { dir, file } = targetPath(destPath, resolved.displayName)
  await mkdir(dir, { recursive: true })
  const full = await uniquePath(dir, file)
  const bytes = await streamPartToFileOn(session, analyzed.uid, resolved.partNumber, full)
  // report the file name that was actually written, so a duplicate that got
  // the collision suffix is visible in the result
  const name = full.split(/[\\/]/).pop()
  return { path: full, bytes, filename: name && name.length > 0 ? name : file }
}
