// dsh-email email tool: one tool, fifteen verbs (accounts, folders, list,
// list_unseen, search, read, mark, save_part, send, reply, forward,
// create_folder, delete_folder, move, delete).
// The parameter schema is a strict flat declaration: the framework validates
// arguments against it before execute and rejects type/enum violations. The
// semantic rules (account resolution, pagination clamps, per-verb required
// fields, local file checks) are enforced here and surface as local errors
// without a code; transport failures surface as { ok: false, error, code }
// with the closed code vocabulary. Results are serialized JSON documents
// (no `ok` field on success); a missing or unknown verb is plain text,
// mirroring the dsh-ntfy tool convention.
import { access } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  appendSource,
  createMailbox,
  deleteMailbox,
  deleteMessages,
  downloadPartOn,
  fetchMany,
  listFolders,
  moveMessages,
  searchUids,
  storeFlags,
  withImapSession,
} from './imap-client.js'
import type { FetchMessageObject, SearchObject } from 'imapflow'

import { analyzeOn, fetchAndAnalyze, hasFlag, quoteText } from './message.js'
import { savePart } from './save.js'
import { sendWithAppend } from './smtp-send.js'
import type {
  AccountConfig,
  AnalyzedMessage,
  AttachmentSpec,
  BodyView,
  Context,
  EmailConfig,
  ErrorCode,
  ListMessage,
  SendRequest,
  TlsEndpoint,
} from './types.js'
import { resolveAccount } from './config.js'
import { errMsg, LocalError } from './util.js'

/** The verb set of the email tool. */
export const VERBS = [
  'accounts',
  'folders',
  'list',
  'list_unseen',
  'search',
  'read',
  'mark',
  'save_part',
  'send',
  'reply',
  'forward',
  'create_folder',
  'delete_folder',
  'move',
  'delete',
] as const

type Verb = (typeof VERBS)[number]

/** The flat argument object as declared in the parameter schema. */
type Args = Record<string, unknown>

/** The default mailbox path for folder-bound verbs. */
export const DEFAULT_FOLDER = 'INBOX'

/** The default page size for the list-family verbs. */
export const DEFAULT_LIMIT = 25

/** The page-size clamp bounds. */
export const LIMIT_MIN = 1
export const LIMIT_MAX = 100

/**
 * Register the email tool (eleven verbs over the EMAIL_* account set).
 * @param ctx cordis Context (the host must have loaded the dsh-tools service).
 * @param cfg the parsed EMAIL_* config captured at boot (env is static per container boot).
 * @returns framework effect disposer (unregisters the tool when the fiber is unloaded).
 */
export function registerTool(ctx: Context, cfg: EmailConfig): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'email',
      description:
        'Read and send mail through configured IMAP/SMTP accounts (EMAIL_* env). ' +
        'accounts lists the configured accounts; folders lists mailboxes; list/list_unseen/search return ' +
        'paginated message summaries (newest first); read returns the analyzed message (parts list plus the ' +
        'first text or html body, truncated to the read-body budget); mark stores flags; save_part writes one ' +
        'part to disk; send/reply/forward deliver a message (and copy it to the account SENT_FOLDER when set, ' +
        'auto-creating that folder when it is missing unless disabled); create_folder/delete_folder/move/delete ' +
        'manage mailboxes and messages (move copies to an existing folder then deletes the source copy; ' +
        'delete/delete_folder are gated on the per-account EMAIL_*_ALLOW_DELETE switch, default deny). ' +
        'Reads are flag-neutral (PEEK); failures carry an error code (auth/network/tls/timeout/protocol/server) ' +
        'for transport origins only. The full verb reference, the EMAIL_* env contract, and limits live in the ' +
        'dsh-email skill.',
      parameters: {
        verb: { type: 'string', required: true, enum: VERBS, description: 'The verb to execute.' },
        account: { type: 'string', description: 'Account name. Absent: EMAIL_DEFAULT_ACCOUNT, or the sole configured account.' },
        folder: { type: 'string', description: 'Mailbox path (default INBOX). For move this is the SOURCE folder.' },
        dest: { type: 'string', description: 'move: the target mailbox. It must already exist and is never auto-created; for any other verb this is ignored.' },
        limit: { type: 'integer', description: `Page size for list/list_unseen/search (default ${DEFAULT_LIMIT}, clamped to ${LIMIT_MIN}-${LIMIT_MAX}).` },
        page: { type: 'integer', description: 'Zero-based page for list/list_unseen/search (default 0).' },
        uid: { type: 'integer', description: 'Message uid (read/save_part/reply/forward).' },
        raw_headers: {
          type: 'boolean',
          description: 'read: include the raw header block of the message in the result (at most 16 KiB, truncated with a trailing marker when larger).',
        },
        uids: {
          oneOf: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' } }],
          description: 'Message uids for mark/move/delete (single value or list).',
        },
        seen: {
          type: 'boolean',
          description:
            'mark: true sets \\Seen, false clears it (at least one of seen/flagged is required for mark). ' +
            'list/list_unseen/search: filter on the same flag - true = only messages with \\Seen set, ' +
            'false = only messages without it, absent = no constraint.',
        },
        flagged: {
          type: 'boolean',
          description:
            'mark: true sets \\Flagged, false clears it (at least one of seen/flagged is required for mark). ' +
            'list/list_unseen/search: filter on the same flag - true = only messages with \\Flagged set, ' +
            'false = only messages without it, absent = no constraint.',
        },
        part: {
          oneOf: [{ type: 'integer' }, { type: 'string' }],
          description: 'save_part: part index (integer, 0-based MIME document order) or part filename (string, must be unique in the message).',
        },
        path: { type: 'string', description: 'save_part: target file path (a trailing slash marks it as a directory); default <cwd>/attachments/.' },
        to: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Recipients (string or list): send/forward required; reply defaults to the sender (plus Cc when reply_all is true).',
        },
        cc: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Cc recipients (string or list) for the send family.' },
        bcc: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Bcc recipients (string or list); delivered on the wire, never in the message headers.' },
        subject: { type: 'string', description: 'Subject line (send-family). Defaults: reply "Re: <original>", forward "Fwd: <original>".' },
        text: { type: 'string', description: 'Plain-text body (send-family).' },
        html: { type: 'string', description: 'HTML body (send-family); combined with text into a multipart/alternative.' },
        body: { type: 'string', description: 'search: text criterion (IMAP TEXT - matches the whole message including headers).' },
        from: { type: 'string', description: 'search: From: criterion (IMAP FROM - matches the From address field).' },
        since: { type: 'string', description: 'search: inclusive start date, YYYY-MM-DD (IMAP SINCE on INTERNALDATE).' },
        until: { type: 'string', description: 'search: exclusive end date, YYYY-MM-DD (IMAP BEFORE on INTERNALDATE).' },
        has_attachment: { type: 'boolean', description: 'search: true restricts to messages with an attachment-disposition part (inline parts are excluded; this is the IMAP Content-Disposition attachment criterion).' },
        header: {
          type: 'object',
          properties: { name: { type: 'string' }, value: { type: 'string' } },
          additionalProperties: false,
          description: 'search: one header criterion ({ name, value } - IMAP HEADER name value).',
        },
        reply_to: { type: 'string', description: 'send: explicit Reply-To address.' },
        reply_all: { type: 'boolean', description: 'reply: true addresses the original sender plus all Cc recipients (default false).' },
        quote: { type: 'boolean', description: 'reply: true (default) appends a "> " line-quoted first text body of the original.' },
        include_original: { type: 'boolean', description: 'forward: true (default) quotes the original text body and re-attaches the original attachments.' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'send: local file paths to attach (each is read at send time).' },
      },
      output: {
        schema: { type: 'string' },
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const verb = args?.verb
        if (typeof verb !== 'string' || !(VERBS as readonly string[]).includes(verb)) {
          return verb === undefined ? `missing verb (${VERBS.join('/')})` : `unknown verb: ${String(verb)}`
        }
        try {
          const result = await OPS[verb as Verb](cfg, args as Args)
          return JSON.stringify(result)
        } catch (err) {
          const doc: Record<string, unknown> = { ok: false, error: errMsg(err) }
          const code = errorCodeOf(err)
          if (code !== undefined) doc.code = code
          return JSON.stringify(doc)
        }
      },
    }),
  )
}

/** The error code carried by an upstream error (the closed vocabulary; local errors carry none). */
function errorCodeOf(err: unknown): ErrorCode | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    const code = (err as { code: string }).code
    return (['auth', 'network', 'tls', 'timeout', 'protocol', 'server'] as const).includes(code as never) ? (code as ErrorCode) : undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// argument helpers
// ---------------------------------------------------------------------------

/** Resolve the target account for a verb (explicit name, default, or sole account). */
function getAccount(cfg: EmailConfig, args: Args): AccountConfig {
  const name = typeof args.account === 'string' && args.account.trim() !== '' ? args.account : undefined
  const res = resolveAccount(cfg, name)
  if ('error' in res) throw new Error(res.error)
  return res.account
}

/** The mailbox path (default INBOX). */
function folderOf(args: Args): string {
  const folder = typeof args.folder === 'string' && args.folder.trim() !== '' ? args.folder : DEFAULT_FOLDER
  return folder
}

/** The page size (default 25, clamped 1-100). */
function limitOf(args: Args): number {
  const limit = args.limit
  if (limit === undefined) return DEFAULT_LIMIT
  if (typeof limit !== 'number' || !Number.isInteger(limit)) throw new Error('limit must be an integer')
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, limit))
}

/** The page (zero-based integer, default 0). */
function pageOf(args: Args): number {
  const page = args.page
  if (page === undefined) return 0
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) throw new Error('page must be a non-negative integer')
  return page
}

/** A trimmed non-empty string argument, or undefined. */
function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s === '' ? undefined : s
}

/** A string-or-list argument as a list of trimmed non-empty strings (empty/absent -> undefined). */
function asStringList(v: unknown): string[] | undefined {
  if (v === undefined) return undefined
  let items: string[]
  if (typeof v === 'string') items = [v]
  else if (Array.isArray(v)) items = v.map((x) => String(x))
  else throw new Error('expected a string or a string list')
  const out = items.map((s) => s.trim()).filter((s) => s !== '')
  return out.length > 0 ? out : undefined
}

/** A required string-or-list argument (an error when absent or empty). */
function requiredStringList(args: Args, key: string): string[] {
  const list = asStringList(args[key])
  if (list === undefined) throw new Error(`${key} is required and must be non-empty`)
  return list
}

/** A required integer argument. */
function intOf(args: Args, key: string): number {
  const v = args[key]
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${key} is required and must be an integer`)
  return v
}

/** An integer-or-list argument as a list of distinct integers (empty -> error). */
function intListOf(args: Args, key: string): number[] {
  const v = args[key]
  let items: unknown[]
  if (typeof v === 'number') items = [v]
  else if (Array.isArray(v)) items = v
  else if (v === undefined) throw new Error(`${key} is required`)
  else throw new Error(`${key} must be an integer or a list of integers`)
  const out: number[] = []
  const seen = new Set<number>()
  for (const x of items) {
    if (typeof x !== 'number' || !Number.isInteger(x)) throw new Error(`${key} entries must be integers`)
    if (!seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  if (out.length === 0) throw new Error(`${key} must contain at least one uid`)
  return out
}

/** An optional boolean argument (absent/false -> undefined, true -> true). */
function asTrue(v: unknown): boolean | undefined {
  return v === true ? true : undefined
}

/** One IMAP date criterion (YYYY-MM-DD at UTC midnight; a format error is local). */
function parseDateCriterion(value: string, label: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) throw new Error(`${label} must be YYYY-MM-DD`)
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is not a valid date`)
  return date
}

/** The header criterion object ({ name, value } - both required non-empty strings). */
function headerCriterion(args: Args): { name: string; value: string } | undefined {
  const h = args.header
  if (h === undefined) return undefined
  if (typeof h !== 'object' || h === null || Array.isArray(h)) throw new Error('header must be an object with name and value')
  const name = asString((h as Record<string, unknown>).name)
  const value = asString((h as Record<string, unknown>).value)
  if (name === undefined || value === undefined) throw new Error('header requires both name and value')
  return { name, value }
}

/**
 * The structured search criteria from the flat search arguments (the per-flag
 * boolean filters are handled separately by the caller). No "at least one
 * criterion" rule is enforced here: a search may be satisfied by flag filters
 * alone, so the caller validates the combined result.
 * @param args the flat argument object.
 */
function searchCriteria(args: Args): SearchObject {
  const q: SearchObject = {}
  const since = asString(args.since)
  if (since !== undefined) q.since = parseDateCriterion(since, 'since')
  const until = asString(args.until)
  if (until !== undefined) q.before = parseDateCriterion(until, 'until')
  const from = asString(args.from)
  if (from !== undefined) q.from = from
  if (Array.isArray(args.to)) throw new Error('search to must be a single address (not a list)')
  const to = asString(args.to)
  if (to !== undefined) q.to = to
  const subject = asString(args.subject)
  if (subject !== undefined) q.subject = subject
  const body = asString(args.body)
  if (asTrue(args.has_attachment) === true && body !== undefined) throw new Error('has_attachment cannot be combined with body (both use the IMAP TEXT criterion)')
  if (asTrue(args.has_attachment) === true) q.text = 'Content-Disposition: attachment'
  else if (body !== undefined) q.text = body
  const header = headerCriterion(args)
  if (header !== undefined) q.header = { [header.name]: header.value }
  return q
}

/**
 * The IMAP flag criteria from the per-flag boolean filters shared by the
 * list-family verbs: seen true -> SEEN, seen false -> UNSEEN, flagged
 * true -> FLAGGED, flagged false -> UNFLAGGED. Each filter names exactly one
 * state of one flag, so a self-contradiction is not expressible; the only
 * remaining conflict is list_unseen's implicit seen: false against an
 * explicit seen: true, which the caller rejects.
 * @param args the flat argument object.
 * @returns the query fragment (empty when neither filter is present).
 */
function flagFilters(args: Args): { seen?: boolean; flagged?: boolean } {
  const q: { seen?: boolean; flagged?: boolean } = {}
  if (args.seen === true) q.seen = true
  else if (args.seen === false) q.seen = false
  if (args.flagged === true) q.flagged = true
  else if (args.flagged === false) q.flagged = false
  return q
}

/** Shape one fetched message into the public summary row (key order uid,
 * messageId, from, to, subject, date, seen, flagged). */
function summarize(row: FetchMessageObject): ListMessage {
  const m: Partial<ListMessage> = { uid: row.uid }
  const env = row.envelope
  if (env) {
    if (env.messageId) m.messageId = env.messageId
    const from = env.from?.[0]
    if (from?.address) m.from = from.name ? { name: from.name, address: from.address } : { address: from.address }
    const to = env.to?.map(addressView).filter((x): x is NonNullable<typeof x> => x !== undefined)
    if (to && to.length > 0) m.to = to
    if (env.subject !== undefined) m.subject = env.subject
  }
  const internal = row.internalDate
  if (internal !== undefined) {
    const d = internal instanceof Date ? internal : new Date(internal)
    if (!Number.isNaN(d.getTime())) m.date = d.toISOString()
  }
  m.seen = hasFlag(row.flags, '\\Seen')
  m.flagged = hasFlag(row.flags, '\\Flagged')
  return m as ListMessage
}

function addressView(a?: { name?: string; address?: string }): { name?: string; address: string } | undefined {
  if (!a || !a.address) return undefined
  return a.name ? { name: a.name, address: a.address } : { address: a.address }
}

/**
 * The list-family verbs (list / list_unseen / search) share one flow: resolve
 * the account, build the search query (per-mode base plus the per-flag
 * boolean filters), search for the matching uids, and page over the match
 * set filtered-first: the metadata of every matching uid is fetched, the
 * rows are sorted newest first (date descending, uid as tiebreak), and only
 * then is the page window sliced - so a row lands on the same page across
 * fetches, whatever the relation between uid order and date order. A plain
 * list with no flag filters matches everything (IMAP ALL); a search with
 * neither criterion nor flag filter is a local error.
 * @param cfg the parsed config.
 * @param args the flat argument object.
 * @param mode which list-family verb is running.
 */
async function opListLike(cfg: EmailConfig, args: Args, mode: 'list' | 'list_unseen' | 'search'): Promise<unknown> {
  const acct = getAccount(cfg, args)
  const folder = folderOf(args)
  const limit = limitOf(args)
  const page = pageOf(args)
  const flagQuery = flagFilters(args)
  const hasFlagFilters = Object.keys(flagQuery).length > 0
  let query: SearchObject
  if (mode === 'search') query = searchCriteria(args)
  else if (mode === 'list_unseen') query = { seen: false }
  else query = {}
  if (mode === 'list_unseen' && flagQuery.seen === true) {
    throw new Error('seen: true contradicts the implicit seen: false of list_unseen (drop it)')
  }
  if (hasFlagFilters) Object.assign(query, flagQuery)
  if (mode === 'list' && !hasFlagFilters) query.all = true
  if (mode === 'search' && !hasFlagFilters && Object.keys(query).length === 0) {
    throw new Error('search requires at least one criterion (since/until/from/to/subject/body/has_attachment/seen/flagged/header)')
  }
  const uids = await searchUids(acct, folder, query)
  const total = uids.length
  let messages: ListMessage[] = []
  if (total > 0) {
    const fetched = await fetchMany(acct, folder, uids, { uid: true, envelope: true, flags: true, internalDate: true })
    messages = fetched
      .map(summarize)
      .sort((a, b) => {
        if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1
        return b.uid - a.uid
      })
      .slice(page * limit, page * limit + limit)
  }
  return { account: acct.name, folder, total, page, limit, messages }
}

// ---------------------------------------------------------------------------
// verb handlers
// ---------------------------------------------------------------------------

/**
 * Present one endpoint for the accounts verb: the mode plus the certificate
 * policy (only in the TLS modes, where validation applies). No credential
 * material is ever presented.
 * @param e the endpoint config.
 */
function presentEndpoint(e: TlsEndpoint) {
  return {
    host: e.host,
    port: e.port,
    tls: e.tls,
    ...(e.tls === 'none' ? {} : { certVerify: e.allowInsecure ? ('insecure' as const) : ('strict' as const) }),
  }
}

const OPS: Record<Verb, (cfg: EmailConfig, args: Args) => Promise<unknown>> = {
  async accounts(cfg) {
    // Zero configured accounts is a legitimate state: the result presents
    // the empty account set (no default to report), not an error.
    const res = resolveAccount(cfg, undefined)
    const effectiveDefault = 'account' in res ? res.account.name : null
    return {
      default: effectiveDefault,
      accounts: cfg.accounts.map((a) => ({
        name: a.name,
        user: a.user,
        from: a.from,
        imap: presentEndpoint(a.imap),
        smtp: presentEndpoint(a.smtp),
        ...(a.sentFolder !== undefined ? { sentFolder: a.sentFolder } : {}),
        sentFolderAutocreate: a.sentFolderAutocreate,
        allowDelete: a.allowDelete,
        isDefault: a.isDefault,
      })),
    }
  },

  async folders(cfg, args) {
    const acct = getAccount(cfg, args)
    const folders = await listFolders(acct)
    return { account: acct.name, folders }
  },

  list: (cfg, args) => opListLike(cfg, args, 'list'),
  list_unseen: (cfg, args) => opListLike(cfg, args, 'list_unseen'),
  search: (cfg, args) => opListLike(cfg, args, 'search'),

  async read(cfg, args) {
    const acct = getAccount(cfg, args)
    const folder = folderOf(args)
    const uid = intOf(args, 'uid')
    const analyzed = await fetchAndAnalyze(acct, folder, uid, { source: true, body: true })
    if (!analyzed) throw new Error(`uid ${uid} not found in folder ${folder}`)
    const out: Record<string, unknown> = { account: acct.name, folder, uid }
    if (analyzed.messageId !== undefined) out.messageId = analyzed.messageId
    if (analyzed.from !== undefined) out.from = analyzed.from
    if (analyzed.to !== undefined) out.to = analyzed.to
    if (analyzed.cc !== undefined) out.cc = analyzed.cc
    if (analyzed.bcc !== undefined) out.bcc = analyzed.bcc
    if (analyzed.subject !== undefined) out.subject = analyzed.subject
    if (analyzed.date !== undefined) out.date = analyzed.date
    out.seen = analyzed.seen
    out.flagged = analyzed.flagged
    if (args.raw_headers === true) out.rawHeaders = analyzed.rawHeaders
    out.parts = analyzed.parts
    out.body = bodyView(analyzed, cfg.readBodyLimit)
    return out
  },

  async mark(cfg, args) {
    const acct = getAccount(cfg, args)
    const folder = folderOf(args)
    const uids = intListOf(args, 'uids')
    const seen = args.seen
    const flagged = args.flagged
    if (seen === undefined && flagged === undefined) throw new Error('mark requires at least one of seen/flagged')
    const add: string[] = []
    const remove: string[] = []
    if (seen === true) add.push('\\Seen')
    else if (seen === false) remove.push('\\Seen')
    if (flagged === true) add.push('\\Flagged')
    else if (flagged === false) remove.push('\\Flagged')
    await storeFlags(acct, folder, uids, add, remove)
    return { account: acct.name, folder, uids: uids.length, count: uids.length }
  },
  async save_part(cfg, args) {
    const acct = getAccount(cfg, args)
    const folder = folderOf(args)
    const uid = intOf(args, 'uid')
    const part = args.part
    if (part === undefined) throw new Error('part is required (a part index or a part filename)')
    if (typeof part !== 'string' && typeof part !== 'number') {
      throw new Error('part must be a part index (integer) or a part filename (string)')
    }
    if (typeof part === 'string' && part.trim() === '') throw new Error('part must be non-empty when a string')
    const destPath = typeof args.path === 'string' ? args.path : undefined
    // One connection for the whole call: the analysis fetch and the part
    // download share a single IMAP session under a single timeout deadline.
    const res = await withImapSession(acct, folder, async (session) => {
      const analyzed = await analyzeOn(session, folder, uid, {})
      if (!analyzed) throw new LocalError(`uid ${uid} not found in folder ${folder}`)
      return await savePart(session, analyzed, part, destPath)
    })
    return { account: acct.name, folder, uid, path: res.path, bytes: res.bytes, filename: res.filename }
  },

  async send(cfg, args) {
    const acct = getAccount(cfg, args)
    const to = requiredStringList(args, 'to')
    const text = asString(args.text)
    const html = asString(args.html)
    const attachments = asStringList(args.attachments)
    for (const p of attachments ?? []) {
      try {
        await access(p)
      } catch {
        throw new Error(`attachment not found: ${p}`)
      }
    }
    if (text === undefined && html === undefined && (attachments?.length ?? 0) === 0) {
      throw new Error('send requires at least one of text, html, attachments')
    }
    const req: SendRequest = {
      to,
      cc: asStringList(args.cc),
      bcc: asStringList(args.bcc),
      subject: asString(args.subject),
      text,
      html,
      replyTo: asString(args.reply_to),
    }
    const specs = (attachments ?? []).map((p) => ({ kind: 'path' as const, path: p }))
    if (specs.length > 0) req.attachments = specs
    const res = await sendWithAppend(acct, req, appendSource)
    return { account: acct.name, ...res }
  },

  async reply(cfg, args) {
    const acct = getAccount(cfg, args)
    const folder = folderOf(args)
    const uid = intOf(args, 'uid')
    const analyzed = await fetchAndAnalyze(acct, folder, uid, { source: true, body: true })
    if (!analyzed) throw new Error(`uid ${uid} not found in folder ${folder}`)
    if (!analyzed.from?.address) throw new Error(`cannot reply: uid ${uid} has no sender address`)
    const explicitTo = asStringList(args.to)
    const replyAll = args.reply_all === true
    let to: string[]
    if (explicitTo !== undefined) to = explicitTo
    else if (replyAll) {
      // the original sender plus the original To/Cc, minus the sending account's
      // own address (case-insensitive), so a reply-all never addresses itself
      const self = acct.from.toLowerCase()
      to = [analyzed.from.address]
      for (const a of analyzed.to ?? []) if (a.address.toLowerCase() !== self) to.push(a.address)
      for (const a of analyzed.cc ?? []) if (a.address.toLowerCase() !== self) to.push(a.address)
    } else to = [analyzed.from.address]
    const text = asString(args.text)
    const html = asString(args.html)
    let textOut: string | undefined
    if (args.quote === false) {
      // quoting disabled: the explicit text is the whole body
      textOut = text
    } else {
      const quote = quoteText(analyzed)
      textOut = quote !== undefined ? (text !== undefined ? `${text}\n\n${quote}` : quote) : text
    }
    if (textOut === undefined && text === undefined && html === undefined) {
      throw new Error('reply requires text or html (quote is disabled and the original has no decodable text body)')
    }
    const req: SendRequest = {
      to,
      subject: asString(args.subject) ?? prefixedSubject('Re: ', analyzed.subject),
      text: textOut,
      html,
      inReplyTo: analyzed.messageId,
      references: appendReference(analyzed.references, analyzed.messageId),
    }
    const res = await sendWithAppend(acct, req, appendSource)
    return { account: acct.name, ...res }
  },

  async forward(cfg, args) {
    const acct = getAccount(cfg, args)
    const folder = folderOf(args)
    const uid = intOf(args, 'uid')
    const to = requiredStringList(args, 'to')
    const includeOriginal = args.include_original !== false
    let text = asString(args.text)
    const html = asString(args.html)
    const attachments: AttachmentSpec[] = []
    // One connection for the whole call: the analysis fetch and every
    // re-attached part of the original share a single IMAP session under a
    // single timeout deadline.
    const analyzed = await withImapSession(acct, folder, async (session) => {
      const a = await analyzeOn(session, folder, uid, { source: true, body: true })
      if (!a) throw new LocalError(`uid ${uid} not found in folder ${folder}`)
      if (includeOriginal) {
        const quote = quoteText(a)
        if (quote !== undefined) text = text !== undefined ? `${text}\n\n${quote}` : quote
        for (const p of a.parts) {
          if (p.kind !== 'attachment') continue
          const partNumber = a.partNumbers.get(p.index)
          if (partNumber === undefined) continue
          const buf = await downloadPartOn(session, uid, partNumber)
          if (buf === undefined) continue
          attachments.push({ kind: 'buffer', filename: p.filename ?? `attachment-${p.index}`, contentType: p.contentType, content: buf })
        }
      }
      return a
    })
    if (text === undefined && html === undefined && attachments.length === 0) {
      throw new Error('forward requires text, html, or include_original')
    }
    const req: SendRequest = {
      to,
      cc: asStringList(args.cc),
      bcc: asStringList(args.bcc),
      subject: asString(args.subject) ?? prefixedSubject('Fwd: ', analyzed.subject),
      text,
      html,
      references: appendReference(analyzed.references, analyzed.messageId),
    }
    if (attachments.length > 0) req.attachments = attachments
    const res = await sendWithAppend(acct, req, appendSource)
    return { account: acct.name, ...res }
  },
  // ---------------------------------------------------------------------
  // mailbox management: create_folder / delete_folder / move / delete
  // ---------------------------------------------------------------------

  async create_folder(cfg, args) {
    const acct = getAccount(cfg, args)
    const folder = requireFolder(args, 'create_folder')
    if (folder.trim().toUpperCase() === 'INBOX') {
      throw new Error('INBOX is reserved and cannot be created')
    }
    const res = await createMailbox(acct, folder)
    return { account: acct.name, folder, created: res.created }
  },

  async delete_folder(cfg, args) {
    const acct = getAccount(cfg, args)
    requireDeletePermission(acct, 'delete_folder')
    const folder = requireFolder(args, 'delete_folder')
    if (folder.trim().toUpperCase() === 'INBOX') {
      throw new Error('INBOX is reserved and cannot be deleted')
    }
    await deleteMailbox(acct, folder)
    return { account: acct.name, folder }
  },

  async move(cfg, args) {
    const acct = getAccount(cfg, args)
    const from = folderOf(args)
    const dest = args.dest
    if (typeof dest !== 'string' || dest.trim() === '') {
      throw new Error('dest is required for move (the target mailbox; it must already exist)')
    }
    if (dest.trim().toUpperCase() === from.trim().toUpperCase()) {
      throw new Error('dest must differ from the source folder')
    }
    const uids = intListOf(args, 'uids')
    const res = await moveMessages(acct, from, dest.trim(), uids)
    return { account: acct.name, from, to: dest.trim(), uids: uids.length, deleted: res.deleted, ...(res.note ? { note: res.note } : {}) }
  },

  async delete(cfg, args) {
    const acct = getAccount(cfg, args)
    requireDeletePermission(acct, 'delete')
    const folder = folderOf(args)
    const uids = intListOf(args, 'uids')
    await deleteMessages(acct, folder, uids)
    return { account: acct.name, folder, uids: uids.length }
  },
}

/**
 * The mailbox name for the create_folder / delete_folder verbs: those verbs
 * act on the mailbox itself (there is no default folder for them), so an
 * absent or empty value is a local error.
 * @param args the flat argument object.
 * @param verb the verb name (for the error text).
 */
function requireFolder(args: Args, verb: string): string {
  const folder = args.folder
  if (typeof folder !== 'string' || folder.trim() === '') {
    throw new Error(`folder is required for ${verb} (the mailbox path)`)
  }
  return folder.trim()
}

/**
 * The per-account destructive-verb gate (EMAIL_*_ALLOW_DELETE, fail-closed
 * default false): the account refuses the verb with a local error (no code)
 * stating the fact only (verb + account name, no remediation, no env key) -
 * granting the right is the operator's decision, not an agent action.
 * @param acct the resolved account.
 * @param verb the calling verb (for the error text).
 */
function requireDeletePermission(acct: AccountConfig, verb: string): void {
  if (acct.allowDelete) return
  throw new Error(`${verb} is not allowed on account "${acct.name}"`)
}

/**
 * The read result body: the first text part (kind text) else the first html
 * part (kind html), truncated to the read-body budget (the totalLength field
 * reports the pre-truncation length).
 */
function bodyView(analyzed: AnalyzedMessage, limit: number): BodyView | null {
  let kind: 'text' | 'html'
  let content: string
  if (analyzed.firstTextContent !== undefined) {
    kind = 'text'
    content = analyzed.firstTextContent
  } else if (analyzed.firstHtmlContent !== undefined) {
    kind = 'html'
    content = analyzed.firstHtmlContent
  } else {
    return null
  }
  const totalLength = content.length
  const truncated = totalLength > limit
  return { kind, text: truncated ? content.slice(0, limit) : content, truncated, totalLength }
}

/**
 * The reply/forward subject default: the prefix joined to the original subject,
 * left unchanged when the original already carries the prefix (case-insensitive).
 * @param prefix the thread prefix ("Re: " or "Fwd: ").
 * @param original the original subject (may be absent).
 */
function prefixedSubject(prefix: string, original: string | undefined): string {
  const base = (original ?? '').trim()
  if (base === '') return prefix.trimEnd()
  if (base.toLowerCase().startsWith(prefix.toLowerCase())) return base
  return `${prefix}${base}`
}

/** The reference chain of the original plus its own Message-ID (deduplicated, appended when absent). */
function appendReference(references: string[], messageId?: string): string[] | undefined {
  if (messageId === undefined) return references.length > 0 ? references : undefined
  if (references.includes(messageId)) return references.length > 0 ? references : [messageId]
  return [...references, messageId]
}


