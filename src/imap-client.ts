// dsh-email IMAP session layer: every tool call opens one fresh connection
// (connect + command + close, no pooling, no idle keep-alive) under a single
// timeout deadline covering the whole call. Multi-phase operations (fetch,
// part downloads on one message) share the one connection of their call
// through an ImapSession. imapflow 2.x natively satisfies the protocol
// contracts this plugin relies on: content fetches use BODY.PEEK/BINARY.PEEK
// (reads never flip the SEEN flag), the IMAP ID command is sent only when the
// server advertises it (the clientInfo payload is the ID value), and the
// connection layer maps the account TLS mode to the library options: 'tls'
// is a direct handshake, 'starttls' upgrades through a mandatory STARTTLS
// (a server without it fails the connection, never a plaintext downgrade),
// and 'none' stays on plaintext without ever attempting STARTTLS.
//
// All helpers surface failures as EmailError with the closed code vocabulary
// (auth / network / tls / timeout / protocol / server); the raw upstream text
// is preserved in the message for pass-through to the agent.
import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type IdInfoObject, type ListResponse, type MessageStructureObject, type SearchObject } from 'imapflow'

import type { AccountConfig } from './types.js'
import { classifyError, EmailError, errMsg, LocalError, PLUGIN_NAME, PLUGIN_VERSION, toBuffer, withDeadline } from './util.js'

/** The IMAP ID payload (sent only when the server advertises the ID capability). */
const CLIENT_INFO: IdInfoObject = { name: PLUGIN_NAME, version: PLUGIN_VERSION }

/**
 * The last server-level command rejection captured from the connection log or
 * the client error event. imapflow reports command rejections (NO/BAD)
 * through the logger and then returns `false` from `search()` and the STORE
 * family, so for those paths the captured status/text is the only way to
 * reconstruct the failure.
 */
export interface CommandErrorCapture {
  /** The IMAP status token of the captured rejection (NO or BAD). */
  status?: 'NO' | 'BAD'
  /** The raw server response text of the captured rejection. */
  text?: string
}

/** Capture one rejection observation (a logger sink entry or an error event):
 * both carry the server response status and text under the same keys. */
function captureFrom(capture: CommandErrorCapture, e: unknown): void {
  if (e === null || typeof e !== 'object') return
  const r = e as { responseStatus?: unknown; responseText?: unknown }
  if (typeof r.responseText === 'string' && r.responseText.length > 0) {
    if (r.responseStatus === 'NO' || r.responseStatus === 'BAD') capture.status = r.responseStatus
    capture.text = r.responseText
  }
}

/**
 * Build one fresh ImapFlow connection for an account endpoint from its TLS
 * mode: 'tls' is a direct handshake (secure=true, STARTTLS off), 'starttls'
 * is a mandatory upgrade (secure=false, doSTARTTLS=true - a server without
 * STARTTLS fails the connection, never a plaintext downgrade), and 'none'
 * stays on plaintext without ever attempting STARTTLS (secure=false,
 * doSTARTTLS=false). The explicit per-account certificate-validation
 * downgrade and every library timeout are bound to the account budget (the
 * overall deadline in the call wrapper is the authority; the library codes
 * back it up). The logger is a capture sink (see CommandErrorCapture), not a
 * console logger.
 * @param acct the account config.
 */
function buildConnection(acct: AccountConfig): { client: ImapFlow; capture: CommandErrorCapture } {
  const capture: CommandErrorCapture = {}
  const sink = (obj: unknown): void => {
    const entry = obj as { err?: { responseStatus?: unknown; responseText?: unknown } } | undefined
    if (entry?.err !== undefined) captureFrom(capture, entry.err)
  }
  const client = new ImapFlow({
    host: acct.imap.host,
    port: acct.imap.port,
    // 'tls' is a direct handshake; every other mode starts on plaintext.
    secure: acct.imap.tls === 'tls',
    // 'starttls' makes STARTTLS mandatory: a server without it fails the
    // connection (tls plane) instead of silently degrading to plaintext.
    // 'none' disables STARTTLS entirely (never attempted, even when the
    // server advertises it). With secure=true the library rejects
    // doSTARTTLS=true as a misconfiguration, so the flag is off there.
    doSTARTTLS: acct.imap.tls === 'starttls',
    auth: { user: acct.user, pass: acct.pass },
    clientInfo: CLIENT_INFO,
    disableAutoIdle: true,
    // The account field carries the operator-facing semantics of the env
    // variable (default false = strict validation; true = explicitly accept
    // untrusted / self-signed certificates). Node's rejectUnauthorized is the
    // negation, so the mapping inverts it at the connection boundary.
    tls: { rejectUnauthorized: !acct.imap.allowInsecure },
    logger: { debug: sink, info: sink, warn: sink, error: sink },
    connectionTimeout: acct.timeoutMs,
    greetingTimeout: acct.timeoutMs,
    socketTimeout: acct.timeoutMs,
  })
  // Command rejections that the logger sink does not record still surface as
  // client error events; capture the status from both channels.
  client.on('error', (err: unknown) => {
    captureFrom(capture, err)
  })
  return { client, capture }
}

/**
 * The upstream failure text for error messages: the raw server response text
 * when the client attached one (the pass-through contract), else the error
 * message.
 * @param err the caught error (unknown under strict).
 */
function rawText(err: unknown): string {
  if (err instanceof Error) {
    const e = err as { responseText?: unknown }
    if (typeof e.responseText === 'string' && e.responseText.length > 0) return e.responseText
  }
  return errMsg(err)
}

/** Wrap an upstream error into the classified EmailError (code vocabulary). */
function fail(acct: AccountConfig, folder: string, err: unknown): never {
  const code = classifyError(err)
  const where = folder ? ` in folder "${folder}"` : ''
  throw new EmailError(`account "${acct.name}"${where}: ${rawText(err)}`, code)
}

/**
 * One live IMAP connection with its rejection capture. Multi-phase operations
 * (search, fetch, part downloads) share the session, so the whole tool call
 * runs on a single connection under a single timeout deadline.
 */
export interface ImapSession {
  client: ImapFlow
  capture: CommandErrorCapture
}

/**
 * Run an operation on a fresh connection under the account timeout budget: a
 * single deadline covers connect plus the operation plus transfer; on breach
 * the pending work is abandoned and the connection is closed in the finally
 * block (best effort). The operation callback must not hold the session
 * afterwards.
 * @param acct the account to connect.
 * @param folder the folder context for error texts (may be empty).
 * @param fn the operation (receives the session).
 */
export async function withImapSession<T>(acct: AccountConfig, folder: string, fn: (session: ImapSession) => Promise<T>): Promise<T> {
  const { client, capture } = buildConnection(acct)
  const session: ImapSession = { client, capture }
  try {
    // A single deadline covers connect plus the operation plus transfer
    // (withDeadline takes the promise, not a thunk).
    return await withDeadline(
      (async () => {
        await client.connect()
        return await fn(session)
      })(),
      acct.timeoutMs,
    )
  } catch (err) {
    // local validation errors pass through unclassified and unprefixed;
    // everything else is a transport failure classified and located
    if (err instanceof LocalError) throw err
    throw fail(acct, folder, err)
  } finally {
    try {
      client.close()
    } catch {
      // best-effort close: a connection that never connected has nothing to close
    }
  }
}

/**
 * Run one operation on a fresh connection under the account timeout budget
 * (the single-phase form of withImapSession).
 * @param acct the account to connect.
 * @param folder the folder context for error texts (may be empty).
 * @param fn the operation (receives the connected client and the error capture).
 */
export async function withImap<T>(acct: AccountConfig, folder: string, fn: (client: ImapFlow, capture: CommandErrorCapture) => Promise<T>): Promise<T> {
  return withImapSession(acct, folder, (session) => fn(session.client, session.capture))
}

/**
 * List the visible mailboxes (real names, unicode) with subscription state.
 * @param acct the account to connect.
 * @returns the folder list sorted by name.
 */
export async function listFolders(acct: AccountConfig): Promise<Array<{ name: string; subscribed: boolean }>> {
  const out = await withImap(acct, '', async (client) => {
    const list: ListResponse[] = await client.list()
    return list
      // servers that do not report subscription state leave the field unset
      .map((l) => ({ name: l.path, subscribed: l.subscribed === true }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  })
  return out
}

/**
 * Search a mailbox for message uids (IMAP SEARCH with the structured query,
 * uid:true). The mailbox is opened read-only: search touches no flags.
 * @param acct the account to connect.
 * @param folder the mailbox path (e.g. INBOX).
 * @param query the structured search object (imapflow SearchObject).
 * @returns the matching uids in server (ascending uid) order.
 */
export async function searchUids(acct: AccountConfig, folder: string, query: SearchObject): Promise<number[]> {
  return await withImap(acct, folder, async (client, capture) => {
    await client.mailboxOpen(folder, { readOnly: true })
    const result = await client.search(query, { uid: true })
    if (result === false) {
      // imapflow reports the rejection through the logger (and, for some
      // paths, only through the client error event) and returns false;
      // rebuild the classified error from the captured status/text.
      const code = capture.status === 'BAD' ? 'protocol' : 'server'
      throw new EmailError(capture.text ?? 'search failed (server response)', code)
    }
    if (result === undefined) return []
    return result
  })
}

/**
 * Fetch message data for a set of uids (read-only mailbox open, PEEK content
 * path: the fetch never flips SEEN). The response order follows the requested
 * range order.
 * @param acct the account to connect.
 * @param folder the mailbox path.
 * @param uids the message uids to fetch.
 * @param query the fetch data items.
 * @returns the fetched messages (a missing message is simply absent).
 */
export async function fetchMany(
  acct: AccountConfig,
  folder: string,
  uids: number[],
  query: FetchQueryObject,
): Promise<FetchMessageObject[]> {
  if (uids.length === 0) return []
  return await withImap(acct, folder, async (client) => {
    await client.mailboxOpen(folder, { readOnly: true })
    return await client.fetchAll(uids, query, { uid: true })
  })
}

/**
 * Fetch one message by uid (read-only mailbox open, PEEK content path).
 * @param acct the account to connect.
 * @param folder the mailbox path.
 * @param uid the message uid.
 * @param query the fetch data items.
 * @returns the fetched message, or undefined when the uid does not exist.
 */
export async function fetchOneMsg(
  acct: AccountConfig,
  folder: string,
  uid: number,
  query: FetchQueryObject,
): Promise<FetchMessageObject | undefined> {
  return await withImap(acct, folder, async (client) => {
    await client.mailboxOpen(folder, { readOnly: true })
    const result = await client.fetchOne(uid, query, { uid: true })
    if (result === false || result === undefined) return undefined
    return result
  })
}

/**
 * Fetch one message by uid on a live session (the session owns the mailbox
 * open, so the caller may already have selected the folder).
 * @param session the live IMAP session.
 * @param folder the mailbox path.
 * @param uid the message uid.
 * @param query the fetch data items.
 * @returns the fetched message, or undefined when the uid does not exist.
 */
export async function fetchOneMsgOn(
  session: ImapSession,
  folder: string,
  uid: number,
  query: FetchQueryObject,
): Promise<FetchMessageObject | undefined> {
  await session.client.mailboxOpen(folder, { readOnly: true })
  const result = await session.client.fetchOne(uid, query, { uid: true })
  if (result === false || result === undefined) return undefined
  return result
}

/**
 * Download one body part on a live session (PEEK path; the session must have
 * the message's mailbox open). The delivered stream is consumed as-is: the
 * bytes on disk / in memory are exactly the bytes the client delivers for the
 * part.
 * @param session the live IMAP session.
 * @param uid the message uid.
 * @param part the bodystructure part number (e.g. "2" or "1.2").
 * @returns the part bytes, or undefined when the part is missing.
 */
export async function downloadPartOn(session: ImapSession, uid: number, part: string): Promise<Buffer | undefined> {
  const result = await session.client.download(String(uid), part, { uid: true })
  if (!result || !result.content) return undefined
  return await toBuffer(result.content)
}

/**
 * Store flags on a set of uids (read-write mailbox open; the flags are applied
 * silently so the command does not trigger a flags response).
 * @param acct the account to connect.
 * @param folder the mailbox path.
 * @param uids the message uids.
 * @param add the flags to set (e.g. ['\Seen']).
 * @param remove the flags to clear (e.g. ['\Flagged']).
 */
export async function storeFlags(
  acct: AccountConfig,
  folder: string,
  uids: number[],
  add: string[],
  remove: string[],
): Promise<void> {
  if (uids.length === 0) return
  await withImap(acct, folder, async (client, capture) => {
    await client.mailboxOpen(folder, { readOnly: false })
    let rejected = false
    if (add.length > 0) {
      rejected = (await client.messageFlagsAdd(uids, add, { uid: true, silent: true })) === false
    }
    if (remove.length > 0) {
      rejected = rejected || (await client.messageFlagsRemove(uids, remove, { uid: true, silent: true })) === false
    }
    if (rejected) {
      // STORE reports the rejection through the logger (and, for some paths,
      // only through the client error event) and returns false; rebuild the
      // classified error from the captured status/text.
      const code = capture.status === 'BAD' ? 'protocol' : 'server'
      throw new EmailError(capture.text ?? 'flag update failed (server response)', code)
    }
  })
}

/**
 * Create one mailbox (IMAP CREATE, a top-level command - no mailbox open
 * needed). Idempotent: a pre-check through LIST reports an existing mailbox
 * as `created: false` without issuing CREATE; a CREATE that fails after the
 * pre-check (a concurrent creator won the race) is resolved by a second
 * existence check, and any other failure (permission, quota, server policy)
 * is classified and rethrown.
 * @param acct the account to connect.
 * @param folder the mailbox path to create.
 * @returns `created: true` when this call issued a successful CREATE, `false`
 *   when the mailbox already existed.
 */
export async function createMailbox(acct: AccountConfig, folder: string): Promise<{ created: boolean }> {
  return await withImapSession(acct, folder, async (session) => {
    const names = await session.client.list()
    const exists = names.some((l) => l.path.toUpperCase() === folder.toUpperCase())
    if (exists) return { created: false }
    try {
      await session.client.mailboxCreate(folder)
      return { created: true }
    } catch (firstError) {
      const again = await session.client.list()
      if (again.some((l) => l.path.toUpperCase() === folder.toUpperCase())) return { created: false }
      throw firstError
    }
  })
}

/**
 * Delete one mailbox (IMAP DELETE, a top-level command - no mailbox open
 * needed). Server policy decides the outcome for a mailbox the client does
 * not control: a missing mailbox or a non-empty folder (most servers refuse
 * to delete non-empty mailboxes) is a classified pass-through error.
 * @param acct the account to connect.
 * @param folder the mailbox path to delete.
 */
export async function deleteMailbox(acct: AccountConfig, folder: string): Promise<void> {
  await withImap(acct, folder, async (client) => {
    await client.mailboxDelete(folder)
  })
}

/**
 * Move a set of messages to an existing destination mailbox: one fresh
 * connection under the account budget opens the source mailbox read-write and
 * runs the two-phase sequence `UID COPY <set> <dest>` followed by the
 * two-step source deletion (mark the moved uids \Deleted, then expunge:
 * uid-scoped `UID EXPUNGE <set>` when the server advertises UIDPLUS, else a
 * folder-wide bare EXPUNGE). The destination is pre-checked through LIST and
 * is never auto-created (a missing destination is a local error naming the
 * create_folder verb). On a UIDPLUS server the uid-scoped expunge removes
 * exactly the moved uids: other messages (including ones another party marked
 * \Deleted) are untouched. When the copy succeeds but the source-side
 * deletion is rejected the messages are duplicated (present in both folders,
 * still flagged \Deleted in the source) and the partial outcome is reported,
 * not raised.
 * @param acct the account to connect.
 * @param from the source mailbox path.
 * @param dest the destination mailbox path (must already exist).
 * @param uids the message uids to move.
 * @returns `deleted: true` on the full sequence, or `deleted: false` plus a
 *   `note` describing the partial state.
 */
export async function moveMessages(
  acct: AccountConfig,
  from: string,
  dest: string,
  uids: number[],
): Promise<{ deleted: boolean; note?: string }> {
  return await withImapSession(acct, from, async (session) => {
    const { client, capture } = session
    const names = await client.list()
    if (!names.some((l) => l.path.toUpperCase() === dest.toUpperCase())) {
      throw new LocalError(`target folder "${dest}" does not exist (create it with the create_folder verb first)`)
    }
    await client.mailboxOpen(from, { readOnly: false })
    const copy = await client.messageCopy(uids, dest, { uid: true })
    if (copy === false) {
      const code = capture.status === 'BAD' ? 'protocol' : 'server'
      throw new EmailError(capture.text ?? 'copy failed (server response)', code)
    }
    const expunged = await client.messageDelete(uids, { uid: true })
    if (expunged === false) {
      return {
        deleted: false,
        note:
          `source deletion failed (${capture.text ?? 'server response'}): the messages are duplicated in "${dest}" ` +
          `and still present in "${from}" (left flagged \\Deleted there)`,
      }
    }
    return { deleted: true }
  })
}

/**
 * Delete a set of messages from a mailbox: the two-step IMAP deletion on a
 * read-write mailbox open - mark the named uids \Deleted, then expunge
 * (uid-scoped `UID EXPUNGE <set>` when the server advertises UIDPLUS, else a
 * folder-wide bare EXPUNGE). On a UIDPLUS server exactly the given uids are
 * removed regardless of their prior flag state; on a server without UIDPLUS
 * the folder-wide expunge also removes any other \Deleted-flagged message in
 * the folder (the plugin never uses the bare form by choice: it is the
 * library's fallback). A server rejection of either step is classified and
 * rethrown with the captured response text.
 * @param acct the account to connect.
 * @param folder the mailbox path.
 * @param uids the message uids to delete.
 */
export async function deleteMessages(acct: AccountConfig, folder: string, uids: number[]): Promise<void> {
  await withImap(acct, folder, async (client, capture) => {
    await client.mailboxOpen(folder, { readOnly: false })
    const ok = await client.messageDelete(uids, { uid: true })
    if (ok === false) {
      const code = capture.status === 'BAD' ? 'protocol' : 'server'
      throw new EmailError(capture.text ?? 'expunge failed (server response)', code)
    }
  })
}

/**
 * Append one MIME source to a folder with the SEEN flag (the SENT_FOLDER
 * copy of a sent message). No mailbox open is needed (APPEND is a top-level
 * command). When the copy fails and the account allows it, the destination
 * folder is auto-created (IMAP CREATE, once) and the APPEND is retried once:
 * the exact folder name INBOX (case-insensitive) is never created (servers
 * reserve it), a CREATE failure (already exists from a race, permission,
 * quota, server policy) is tolerated, and a copy that still fails after the
 * retry reports the ORIGINAL failure - the auto-create path never turns a
 * copy failure into a send failure (the message was already delivered).
 * @param acct the account to connect.
 * @param folder the destination mailbox path.
 * @param source the full MIME source (string).
 * @returns an empty object when the first APPEND succeeded, or an object
 *   whose `created` reports the auto-create outcome (true = this call issued
 *   a successful CREATE; false = the CREATE failed but the retry succeeded)
 *   when a create was attempted.
 */
export async function appendSource(
  acct: AccountConfig,
  folder: string,
  source: string,
): Promise<{ created?: boolean }> {
  const doAppend = () =>
    withImap(acct, folder, async (client) => {
      await client.append(folder, Buffer.from(source, 'utf8'), ['\Seen'])
    })
  try {
    await doAppend()
    return {}
  } catch (firstError) {
    if (!acct.sentFolderAutocreate || folder.trim().toUpperCase() === 'INBOX') {
      throw firstError
    }
    let created = false
    try {
      await withImap(acct, folder, async (client) => {
        await client.mailboxCreate(folder)
      })
      created = true
    } catch {
      // CREATE failed (already exists from a race, or the server denies
      // creation): continue to the single retry; its outcome decides.
    }
    try {
      await doAppend()
      return { created }
    } catch {
      throw firstError
    }
  }
}

/** The bodystructure tree of one message (for part-list construction). */
export type { MessageStructureObject }
