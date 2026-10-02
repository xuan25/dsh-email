// In-process fake IMAP server for the selftest (loopback only).
//
// Implements the IMAP surface the client exercises: greeting, CAPABILITY, ID,
// STARTTLS (in-place TLS upgrade on the same socket), LOGIN, LIST (including
// the empty-refname namespace fallback), LSUB, EXAMINE/SELECT, SEARCH / UID
// SEARCH, FETCH / UID FETCH (UID, FLAGS, ENVELOPE, INTERNALDATE, RFC822.SIZE,
// BODYSTRUCTURE, BODY[HEADER], RFC822, BODY[<part>.MIME], partial windows
// BODY[<part>]<start.len> and BODY[TEXT]), UID STORE, APPEND, CREATE,
// COPY / UID COPY, EXPUNGE / UID EXPUNGE, DELETE, CLOSE, LOGOUT.
//
// CREATE semantics (mirroring a real server): INBOX is never creatable (NO),
// a name that already exists is a NO ("Mailbox exists"), otherwise the
// mailbox is created (empty) and recorded in state.created; a successful
// create is an OK [CREATED] tagged response.
//
// DELETE semantics (mirroring the default server policy): INBOX is never
// deletable (NO), a missing name is a NO, a non-empty mailbox is a NO (most
// servers refuse to delete non-empty mailboxes), otherwise the folder map
// entry is removed and recorded in state.deletedMailboxes.
//
// COPY semantics: copies each source message (matched by UID when UID-prefixed,
// by message number otherwise) into the destination mailbox with a fresh UID;
// a missing destination is a NO. Successful copies are recorded in
// state.copied as { folder, dest, uids }.
//
// EXPUNGE semantics: the bare form removes every \Deleted-flagged message in
// the selected mailbox; UID EXPUNGE removes exactly the named uids
// (regardless of flag state) and never touches other messages. The client
// issues the two-step deletion (mark \Deleted, then expunge) and picks the
// uid-scoped form only when this server advertises UIDPLUS (as modern real
// servers do); without it the bare form is used. Untagged
// `* <seq> EXPUNGE` notifications use the pre-expunge message numbers.
// Expunged uids are recorded in state.expunged as { folder, uids }.
//
// Wire contracts (verified against the client decoder pipeline):
//   - part bodies are delivered in their stored transfer encoding, without the
//     part MIME headers; the client decodes the transfer encoding itself, so a
//     part with no MIME section headers would arrive to the caller undecoded.
//   - a requested BODY[<part>.MIME] section is answered under the same name
//     (the suffix kept), or the client files it under the part key and the
//     part headers are lost.
//   - SEARCH string criteria are case-sensitive literals (a lowercase value
//     must not match an uppercase word); only the HEADER field name is
//     compared case-insensitively.
//   - an APPEND literal may arrive in the same packet as its command line
//     (LITERAL+) or in a later packet after the client waits for the "+ "
//     continuation (classic literal); both must be served.
//
// Transport branches:
//   mode 'tls'          - the connection is TLS from the start (self-signed
//                         cert); STARTTLS is unavailable (the connection is
//                         already TLS)
//   mode 'starttls'     - plaintext socket advertising STARTTLS, upgraded in
//                         place on STARTTLS
//   mode 'starttls-none'- plaintext socket advertising no STARTTLS
//                         capability; the STARTTLS command is rejected (the
//                         mandatory-STARTTLS client must fail, never degrade
//                         to plaintext)
//
// Failure injection:
//   hangGreeting    - accept the connection but never send the greeting (the
//                     client budget must expire: code timeout)
//   greetingDelayMs - delay the greeting by the given milliseconds (a slow
//                     server that consumes part of the client budget)
//   hangAfterAuth   - answer OK to LOGIN, then consume and never answer any
//                     further command (the client budget must expire once,
//                     covering the whole call)
//   failCommand  - per-command tagged response override { status: 'NO' | 'BAD',
//                  text } (protocol vs server classification)
//   appendLimit  - APPEND sources larger than the limit are rejected (server)
//   appendFailFirst - the first APPEND served by the server is rejected (NO)
//                     and every later one succeeds; models a transient first
//                     failure (a concurrent creator winning the CREATE race)
//   users        - the credential map; a bad user or password is a NO
//
// The state object also keeps one record per accepted connection (its
// command log), so a test can assert how many connections a call opened.
//
// Message fixtures render their own MIME source from the parts tree, so the
// delivered source and the BODYSTRUCTURE / part MIME headers never disagree.

import net from 'node:net'
import tls from 'node:tls'

import { CERT_PEM, KEY_PEM } from './test-cert.mjs'

const CRLF = '\r\n'

/** Month abbreviations for IMAP NICKTIME dates. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Format a Date as an IMAP NICKTIME date in UTC (IMAP dates are UTC). */
export function nicktime(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Format a Date as an RFC 1123 date in UTC, quoted. The ENVELOPE date element
 * must be a single token: the line-based parser does not fold the three
 * NICKTIME tokens a real unquoted date expands into, so the date is sent
 * quoted to keep the envelope element alignment intact.
 */
export function quotedDate(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `"${WEEKDAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000"`
  )
}

/** Parse an IMAP date token (NICKTIME or YYYY-MM-DD) into a UTC Date. */
function parseImapDate(token) {
  const t = token.trim().replace(/"/g, '')
  const m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:[ T](\d{2}):(\d{2}):(\d{2}))?\s*(?:([+-]\d{4}))?$/)
  if (m) {
    const day = Number(m[1])
    const mon = MONTHS.indexOf(m[2])
    const year = Number(m[3])
    const hh = m[4] ? Number(m[4]) : 0
    const mm = m[5] ? Number(m[5]) : 0
    const ss = m[6] ? Number(m[6]) : 0
    return new Date(Date.UTC(year, mon < 0 ? 0 : mon, day, hh, mm, ss))
  }
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  return new Date(t)
}

/** The start of a day in UTC (IMAP date criteria are day-granular). */
function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

/**
 * Wrap an ASCII string into a MIME content line of at most 76 characters
 * (RFC 2045 line length limit).
 * @param text the content to wrap.
 */
function wrapLine(text) {
  const out = []
  for (let i = 0; i < text.length; i += 76) out.push(text.slice(i, i + 76))
  return out.join(CRLF)
}

/** Encode a body buffer per the part transfer encoding into source bytes. */
function encodeForSource(body, cte) {
  if (cte === 'base64') return wrapLine(Buffer.from(body, 'latin1').toString('base64')) + CRLF
  return body.toString('latin1')
}

/** The part MIME header block as stored in the message source. */
function partHeaderBlock(part) {
  let h = `Content-Type: ${part.type}`
  if (part.type.startsWith('text/') && part.charset) h += `; charset=${part.charset}`
  h += CRLF + `Content-Transfer-Encoding: ${part.cte}` + CRLF
  if (part.disposition === 'attachment' && part.filename) h += `Content-Disposition: attachment; filename="${part.filename}"` + CRLF
  return h
}

/** Render the message source: header block plus the rendered body tree. */
function renderBodyTree(node) {
  if (node.parts) {
    const b = node.boundary
    let out = ''
    for (const child of node.parts) {
      // each part body is terminated so the next boundary starts on its own line
      out += `--${b}` + CRLF + partHeaderBlock(child) + CRLF + renderBodyTree(child) + CRLF
    }
    return out + `--${b}--` + CRLF
  }
  return encodeForSource(node.body, node.cte)
}

/**
 * One fixture message. The source is rendered from rawHeaders + the parts
 * tree unless an explicit source override is given.
 */
export function makeMessage(spec) {
  const rawHeaders = spec.rawHeaders
  let source = rawHeaders
  if (spec.parts) source += renderBodyTree(spec.parts)
  else if (spec.sourceOverride) source = spec.sourceOverride
  else source += spec.bodyText ?? ''
  return {
    uid: spec.uid,
    flags: new Set(spec.flags ?? []),
    // stored as a Date so NICKTIME/ENVELOPE renderers can format it directly
    internalDate: typeof spec.internalDate === 'string' ? new Date(spec.internalDate) : spec.internalDate,
    from: spec.from ?? null,
    to: spec.to ?? [],
    cc: spec.cc ?? [],
    bcc: spec.bcc ?? [],
    subject: spec.subject ?? null,
    inReplyTo: spec.inReplyTo ?? null,
    messageId: spec.messageId ?? null,
    rawHeaders,
    parts: spec.parts ?? null,
    source: Buffer.from(source, 'latin1'),
  }
}

/** The part MIME section header block served for BODY[<part>.MIME] requests. */
function partMimeSection(part) {
  return partHeaderBlock(part)
}

/** Render one leaf into the IMAP BODYSTRUCTURE tuple. */
function leafBodyStructure(node) {
  const [major, minor] = node.type.split('/')
  let params = 'NIL'
  if (node.type.startsWith('text/') && node.charset) params = `(charset "${node.charset}")`
  // the size is the CTE-encoded body length, the same bytes the part
  // deliveries serve
  const encoded = Buffer.from(encodeForSource(node.body, node.cte), 'latin1')
  let s = `"${major}" "${minor}" ${params} NIL NIL "${node.cte}" ${encoded.length}`
  if (node.type.startsWith('text/') && node.cte !== 'base64') s += ` ${encoded.toString('latin1').split('\n').length}`
  if (node.type === 'message/rfc822') s += ' NIL NIL NIL'
  s += ' NIL' // md5
  if (node.disposition) {
    if (node.filename) s += ` ("${node.disposition}" (filename "${node.filename}"))`
    else s += ` ("${node.disposition}")`
  } else s += ' NIL'
  s += ' NIL NIL'
  return `(${s})`
}

/** Render a parts tree into the IMAP BODYSTRUCTURE expression. */
function renderBodyStructure(node) {
  if (node.parts) {
    const [major, minor] = node.type.split('/')
    const kids = node.parts.map((p) => renderBodyStructure(p)).join(' ')
    return `(${kids} "${minor}" (boundary "${node.boundary}") NIL)`
  }
  return leafBodyStructure(node)
}

/** Resolve the body-structure node for a part number (dot notation). */
function findPartNode(node, partNumber) {
  if (!node.parts) {
    return partNumber === '1' || partNumber === 'text' ? node : undefined
  }
  const first = Number(partNumber.split('.')[0])
  const rest = partNumber.split('.').slice(1).join('.')
  const child = node.parts[first - 1]
  if (!child) return undefined
  if (rest === '') return child
  return findPartNode(child, rest)
}

/** The part content served for BODY[<part>]: the CTE-encoded body bytes,
 * exactly as they appear in the stored source. */
function partBodyBytes(partNode) {
  return Buffer.from(encodeForSource(partNode.body, partNode.cte), 'latin1')
}

/** The RFC822.SIZE value: the full source length. */
function messageSize(msg) {
  return msg.source.length
}

/** Render the ENVELOPE expression from a message. */
function renderEnvelope(msg) {
  const addr = (a) => {
    if (!a) return 'NIL'
    const [mailbox, host] = a.address.includes('@') ? a.address.split('@') : [a.address, 'localhost']
    return `(${a.name ? `"${a.name}"` : 'NIL'} NIL "${mailbox}" "${host}")`
  }
  const list = (l) => (l && l.length > 0 ? `(${l.map(addr).join(' ')})` : 'NIL')
  const str = (v) => (v === null || v === undefined ? 'NIL' : `"${v}"`)
  return `(${quotedDate(msg.internalDate)} ${str(msg.subject)} ${list(msg.from ? [msg.from] : [])} ${list(msg.from ? [msg.from] : [])} ${list(
    [],
  )} ${list(msg.to)} ${list(msg.cc)} ${list(msg.bcc)} ${str(msg.inReplyTo)} ${str(msg.messageId)})`
}

// ---------------------------------------------------------------------------
// IMAP line tokenizer (requests): atoms, quoted strings, NIL, lists. The
// only literals the client sends inline are APPEND sources, which the
// connection reader extracts before tokenizing the command line.
// ---------------------------------------------------------------------------

/**
 * Tokenize the argument portion of one IMAP command line.
 * @param line the command text after the tag and verb (or the whole line).
 * @returns a list of tokens: strings for atoms/quoted values, 'NIL' for
 *          NIL, { list: [...] } for parenthesized lists.
 */
export function tokenizeArgs(line) {
  const tokens = []
  let i = 0
  const n = line.length
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++
    if (i >= n) break
    const c = line[i]
    if (c === ')') {
      // a closing paren that the list scanner did not consume marks the
      // end of this token list (defensive; balanced lines never reach it)
      break
    }
    if (c === '(') {
      const start = i
      let depth = 0
      let j = i
      for (;;) {
        if (j >= n) throw new Error('unterminated list in IMAP line')
        if (line[j] === '(') depth++
        else if (line[j] === ')') {
          depth--
          if (depth === 0) break
        } else if (line[j] === '"') {
          j++
          while (j < n && line[j] !== '"') {
            if (line[j] === '\\') j++
            j++
          }
        }
        j++
      }
      const inner = line.slice(start + 1, j)
      tokens.push({ list: tokenizeArgs(inner) })
      i = j
    } else if (c === '"') {
      let j = i + 1
      let out = ''
      while (j < n) {
        if (line[j] === '\\' && j + 1 < n) {
          out += line[j + 1]
          j += 2
        } else if (line[j] === '"') break
        else {
          out += line[j]
          j++
        }
      }
      tokens.push(out)
      i = j + 1
    } else if (c === '{') {
      // a literal reference left in the line (should be extracted by the
      // reader); treat the following number as a zero-byte placeholder
      const m = line.slice(i).match(/^\{(\d+)[+-]?\}/)
      tokens.push('')
      i += m ? m[0].length : 1
    } else {
      let j = i
      while (j < n && !/[\s()"]/.test(line[j])) j++
      if (j === i) {
        // defensive: a delimiter the scanner above did not handle; skip it
        // rather than spin on a zero-length atom
        i++
        continue
      }
      tokens.push(line.slice(i, j))
      i = j
    }
  }
  return tokens
}

// ---------------------------------------------------------------------------
// SEARCH criteria evaluation (recursive descent over the token list)
// ---------------------------------------------------------------------------

/** Evaluate one criterion argument of NOT or OR: a parenthesized sequence
 * token is evaluated as a whole sequence, any other token is re-parsed as a
 * single criterion. */
function evalArg(tokens, pos, msg) {
  if (pos[0] >= tokens.length) return true
  const tok = tokens[pos[0]++]
  if (tok !== undefined && typeof tok === 'object' && Array.isArray(tok.list)) {
    return evalCriteria(tok.list, { 0: 0 }, msg)
  }
  pos[0]--
  return evalCriterion(tokens, pos, msg)
}

/** Evaluate exactly one criterion (name plus its operands) against a message. */
function evalCriterion(tokens, pos, msg) {
  if (pos[0] >= tokens.length) return true
  const tok = tokens[pos[0]]
  const upper = typeof tok === 'string' ? tok.toUpperCase() : ''
  pos[0]++
  switch (upper) {
    case 'ALL':
      return true
    case 'UNSEEN':
      return !msg.flags.has('\\Seen')
    case 'SEEN':
      return msg.flags.has('\\Seen')
    case 'FLAGGED':
      return msg.flags.has('\\Flagged')
    case 'UNFLAGGED':
      return !msg.flags.has('\\Flagged')
    case 'NOT':
      return !evalArg(tokens, pos, msg)
    case 'OR': {
      const a = evalArg(tokens, pos, msg)
      const b = evalArg(tokens, pos, msg)
      return a || b
    }
    case 'SINCE':
    case 'BEFORE':
    case 'ON': {
      const value = tokens[pos[0]++]
      const d = parseImapDate(String(value))
      const day = startOfUtcDay(d)
      const mday = startOfUtcDay(new Date(msg.internalDate))
      if (upper === 'SINCE') return mday.getTime() >= day.getTime()
      if (upper === 'BEFORE') return mday.getTime() < day.getTime()
      return mday.getTime() === day.getTime()
    }
    case 'FROM':
    case 'TO':
    case 'CC':
    case 'BCC':
    case 'SUBJECT':
    case 'TEXT':
    case 'BODY': {
      // string criteria are case-sensitive literals (RFC 3501): the value and
      // the searched text keep their case
      const value = String(tokens[pos[0]++] ?? '')
      let hay = ''
      if (upper === 'FROM') hay = msg.from ? `${msg.from.name ?? ''} ${msg.from.address}` : ''
      else if (upper === 'TO') hay = msg.to.map((a) => `${a.name ?? ''} ${a.address}`).join(' ')
      else if (upper === 'CC') hay = msg.cc.map((a) => `${a.name ?? ''} ${a.address}`).join(' ')
      else if (upper === 'BCC') hay = msg.bcc.map((a) => `${a.name ?? ''} ${a.address}`).join(' ')
      else if (upper === 'SUBJECT') hay = msg.subject ?? ''
      else hay = msg.source.toString('latin1')
      return hay.includes(value)
    }
    case 'HEADER': {
      // the field name is matched case-insensitively; the header text keeps
      // its case
      const field = String(tokens[pos[0]++] ?? '')
      const value = String(tokens[pos[0]++] ?? '')
      const hay = msg.rawHeaders
      return new RegExp(`^${field}[ :]`, 'im').test(hay) && hay.includes(value)
    }
    case 'UID': {
      let ok = false
      while (pos[0] < tokens.length && typeof tokens[pos[0]] === 'string' && /^\d+(:\d+)?$/.test(tokens[pos[0]])) {
        const range = tokens[pos[0]++]
        const [a, b] = range.split(':').map(Number)
        const end = b === undefined ? a : b
        for (let u = a; u <= end; u++) if (u === msg.uid) ok = true
      }
      return ok
    }
    default:
      // an unknown criterion is treated as non-matching (the client only
      // emits criteria it requested)
      return false
  }
}

/** Evaluate a flat SEARCH criterion list against a message: every criterion
 * in the list must match (the IMAP implicit AND over the criterion sequence). */
function evalCriteria(tokens, pos, msg) {
  while (pos[0] < tokens.length) {
    if (!evalCriterion(tokens, pos, msg)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Per-connection protocol state machine
// ---------------------------------------------------------------------------

/** One live connection: socket plus per-connection protocol state. */
function handleImapSocket(socket, serverState) {
  // one record per accepted connection: the selftest asserts on it how many
  // connections a tool call opened (the single-session contract)
  const conn = { commands: [] }
  serverState.connections.push(conn)
  serverState.openSockets.push(socket)
  let upgraded = false
  // the wire the current transport state reads and writes on: the raw socket
  // until STARTTLS upgrades it in place, the TLS socket afterwards
  let live = socket
  let user = null
  let selected = null
  let selectedReadOnly = false
  let buf = Buffer.alloc(0)
  let stopped = false
  // once the auth-hang injection triggers, the connection consumes every
  // further byte and answers nothing (a server that died after LOGIN)
  let silent = false

  // Every IMAP line is CRLF-terminated on the wire; responses built with an
  // embedded CRLF between the untagged part and the tagged part still need
  // the final terminator appended here.
  const send = (text) => {
    if (stopped) return
    let out = String(text)
    if (!out.endsWith(CRLF)) out += CRLF
    try {
      live.write(out, 'latin1')
    } catch {
      // the peer went away mid-frame; nothing more can be sent
    }
  }

  /** The capabilities list for the current transport state. */
  const caps = () => (serverState.mode === 'starttls' && !upgraded ? 'IMAP4rev1 UIDPLUS ID STARTTLS LITERAL+' : 'IMAP4rev1 UIDPLUS ID LITERAL+')

  /** Answer a LIST command against the configured folder set. */
  function answerList(args, sendLine) {
    const parts = []
    const refTok = args[0]
    const nameTok = args[1]
    const ref = typeof refTok === 'string' ? refTok : ''
    const name = typeof nameTok === 'string' ? nameTok : ''
    // a visible folder that is subscribed carries the \Subscribed flag in the
    // LIST answer (real servers report it there, not only on LSUB)
    const line = (fname) => {
      const flags = ['\\HasNoChildren']
      if (serverState.subscribed.has(fname)) flags.push('\\Subscribed')
      return `* LIST (${flags.join(' ')}) "/" "${fname}"`
    }
    if (ref === '' && name === '') {
      // the namespace fallback query: report the hierarchy root
      parts.push('* LIST (\\Noselect) "/" ""')
    } else if (name === '*') {
      for (const fname of Object.keys(serverState.folders)) {
        parts.push(line(fname))
      }
    } else if (serverState.folders[name]) {
      parts.push(line(name))
    }
    for (const l of parts) sendLine(l)
  }

  /** Answer a LSUB command (the subscribed flag is fixture data). */
  function answerLsub(args, sendLine) {
    const nameTok = args[1]
    const name = typeof nameTok === 'string' ? nameTok : ''
    const sub = (fname) => (serverState.subscribed && serverState.subscribed.has(fname) ? `* LSUB (\\HasNoChildren) "/" "${fname}"` : null)
    if (name === '*') {
      for (const fname of Object.keys(serverState.folders)) {
        const line = sub(fname)
        if (line) sendLine(line)
      }
    } else {
      const line = sub(name)
      if (line) sendLine(line)
    }
  }

  /** The untagged preamble of a SELECT/EXAMINE response for one mailbox. */
  function openMailbox(folderName, readOnly, sendLine) {
    const folder = serverState.folders[folderName]
    if (!folder) {
      sendLine(`${tag} NO no such folder: ${folderName}`)
      return false
    }
    selected = folderName
    selectedReadOnly = readOnly
    const count = folder.messages.length
    sendLine(`* ${count} EXISTS`)
    sendLine('* 0 RECENT')
    sendLine('* OK [UIDVALIDITY 1] UIDs valid')
    const maxUid = folder.messages.reduce((m, x) => Math.max(m, x.uid), 0)
    sendLine(`* OK [UIDNEXT ${maxUid + 1}] Predicted next UID`)
    const flags = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft']
    sendLine(`* FLAGS (${flags.join(' ')})`)
    if (readOnly) sendLine('* OK [READ-ONLY] mailbox opened read-only')
    return true
  }

  /** Render the requested FETCH data items for one message. */
  function fetchItems(msg, seq, items, sendLine) {
    const out = []
    for (const item of items) {
      const I = item.toUpperCase()
      if (I === 'UID') out.push(`UID ${msg.uid}`)
      else if (I === 'FLAGS') {
        const fl = [...msg.flags]
        out.push(`FLAGS (${fl.join(' ')})`)
      } else if (I === 'ENVELOPE') out.push(`ENVELOPE ${renderEnvelope(msg)}`)
      else if (I === 'INTERNALDATE') out.push(`INTERNALDATE "${nicktime(msg.internalDate)}"`)
      else if (I === 'RFC822.SIZE') out.push(`RFC822.SIZE ${messageSize(msg)}`)
      else if (I === 'BODYSTRUCTURE' || I === 'BODY') {
        out.push(msg.parts ? `BODYSTRUCTURE ${renderBodyStructure(msg.parts)}` : 'BODYSTRUCTURE ("text" "plain" NIL NIL NIL "7bit" 0 1 NIL)')
      } else if (I.startsWith('BODY.PEEK[') || I.startsWith('BODY[') || I === 'RFC822') {
        const sectionMatch = item.match(/^(?:BODY|RFC822)(?:\.PEEK)?\[(.*?)\](?:<(\d+)\.(\d+)>)?$/i)
        if (!sectionMatch) continue
        let section = (sectionMatch[1] ?? '').toUpperCase()
        const start = sectionMatch[2] !== undefined ? Number(sectionMatch[2]) : 0
        const len = sectionMatch[3] !== undefined ? Number(sectionMatch[3]) : Infinity
        if (section === '') {
          // the whole message source (the client's `source` item compiles to
          // BODY.PEEK[], and the response key that maps to it is BODY[])
          const data = msg.source.slice(start, start + len)
          out.push(`BODY[] {${data.length}}${CRLF}${data.toString('latin1')}`)
        } else if (section === 'HEADER' || section.startsWith('HEADER.FIELDS')) {
          const data = Buffer.from(msg.rawHeaders, 'latin1').slice(start, start + len)
          out.push(`BODY[HEADER] {${data.length}}${CRLF}${data.toString('latin1')}`)
        } else if (section.endsWith('.MIME')) {
          const partNode = msg.parts ? findPartNode(msg.parts, section.slice(0, -'.MIME'.length)) : undefined
          const data = Buffer.from(partNode ? partMimeSection(partNode) : '', 'latin1')
          // echo the section name exactly as requested (the .MIME suffix
          // kept): the client files the answer under that key, and stripping
          // the suffix would collide the headers with the part content
          out.push(`BODY[${section}] {${data.length}}${CRLF}${data.toString('latin1')}`)
        } else if (section === 'TEXT') {
          const body = msg.parts ? partBodyBytes(msg.parts) : msg.source
          const data = Buffer.from(body, 'latin1').slice(start, start + len)
          out.push(`BODY[TEXT] {${data.length}}${CRLF}${data.toString('latin1')}`)
        } else {
          const partNode = msg.parts ? findPartNode(msg.parts, section) : undefined
          const data = partNode ? partBodyBytes(partNode).slice(start, start + len) : Buffer.alloc(0)
          out.push(`BODY[${section}] {${data.length}}${CRLF}${data.toString('latin1')}`)
        }
      }
    }
    if (out.length > 0) sendLine(`* ${seq} FETCH (${out.join(' ')})`)
  }

  /** Apply one UID STORE flag operation to the selected folder. */
  function applyStore(range, modifier, flagTokens) {
    if (!selected) return
    const folder = serverState.folders[selected]
    const keys = expandSequenceSet(range)
    const flags = flagTokens.filter((t) => typeof t === 'string').map((t) => (t.startsWith('\\') ? t : `\\${t}`))
    const add = modifier.startsWith('+')
    const remove = modifier.startsWith('-')
    let set = false
    for (const msg of folder.messages) {
      if (keys.has(msg.uid)) {
        set = true
        if (add) for (const f of flags) msg.flags.add(f)
        if (remove) for (const f of flags) msg.flags.delete(f)
      }
    }
    return set
  }

  /** Expand an IMAP sequence set (e.g. "1,3:5" or "3") into a uid set. */
  function expandSequenceSet(rangeTok) {
    const set = new Set()
    for (const part of String(rangeTok).split(',')) {
      const m = part.trim().match(/^(\d+)(?::(\d+))?$/)
      if (!m) continue
      const a = Number(m[1])
      const b = m[2] !== undefined ? Number(m[2]) : a
      for (let x = a; x <= b; x++) set.add(x)
    }
    return set
  }

  let tag = ''

  /** Dispatch one complete command line (the tag is already stripped). */
  function dispatch(line) {
    const sp = line.indexOf(' ')
    if (sp === -1) {
      tag = line
      return
    }
    if (silent) return
    tag = line.slice(0, sp)
    const cmd = line.slice(sp + 1)
    const C = cmd.toUpperCase()
    // the raw command line (tag included) for selftest wire assertions
    serverState.commands.push(cmd)
    conn.commands.push(cmd)

    const tokens = tokenizeArgs(cmd)
    const uidPrefixed = C.startsWith('UID ')
    const verb = (tokens[0] ?? '').toUpperCase()
    // operands start after the verb (and the UID prefix, when present)
    const args = tokens.slice(1 + (uidPrefixed ? 1 : 0))
    // UID-prefixed verbs dispatch under the plain verb name (the second
    // token of the command)
    const verbName = (uidPrefixed ? tokens[1] : tokens[0] ?? '').toUpperCase()

    if (serverState.inject.failCommand && serverState.inject.failCommand[verbName]) {
      const f = serverState.inject.failCommand[verbName]
      send(`${tag} ${f.status} ${f.text}`)
      return
    }

    if (C === 'CAPABILITY') {
      send(`* CAPABILITY ${caps()}${CRLF}${tag} OK Completed`)
    } else if (C === 'ID') {
      send(`* ID ("name" "fake-imap" "version" "1.0")${CRLF}${tag} OK Completed`)
    } else if (C === 'STARTTLS') {
      if (serverState.mode !== 'starttls') {
        send(`${tag} BAD STARTTLS is not available on this connection`)
        return
      }
      send(`${tag} OK Ready to start TLS`)
      socket.removeAllListeners('data')
      socket.pause()
      upgradeToTls(socket).then(
        (tlsSocket) => {
          upgraded = true
          live = tlsSocket
          buf = Buffer.alloc(0)
          tlsSocket.on('data', onData)
          tlsSocket.on('error', () => {})
          tlsSocket.resume()
        },
        (err) => {
          stopped = true
          socket.destroy(err)
        },
      )
    } else if (C === 'NAMESPACE') {
      send(`* NAMESPACE ((("") NIL) NIL NIL)${CRLF}${tag} OK Completed`)
    } else if (verb === 'LOGIN') {
      const u = args[0]
      const p = args[1]
      if (typeof u === 'string' && serverState.users[u] === p) {
        user = u
        send(`${tag} OK Login completed`)
        // the server goes silent right after a successful login: every later
        // command on this connection is consumed and never answered, which
        // makes a whole-call deadline observable as a single timeout
        if (serverState.inject.hangAfterAuth) silent = true
      } else {
        send(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed`)
      }
    } else if (verb === 'AUTHENTICATE') {
      send(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed`)
    } else if (verb === 'LIST') {
      answerList(args, (l) => send(l))
      send(`${tag} OK Completed`)
    } else if (verb === 'LSUB') {
      answerLsub(args, (l) => send(l))
      send(`${tag} OK Completed`)
    } else if (verb === 'EXAMINE' || verb === 'SELECT') {
      const name = typeof args[0] === 'string' ? args[0] : ''
      if (openMailbox(name, verb === 'EXAMINE', (l) => send(l))) send(`${tag} OK Completed`)
    } else if (verbName === 'SEARCH') {
      if (!selected) {
        send(`${tag} NO No mailbox selected`)
        return
      }
      // a fresh cursor per message: the criterion list is evaluated
      // independently against every message
      const folder = serverState.folders[selected]
      const uids = folder.messages.filter((m) => evalCriteria(args, { 0: 0 }, m)).map((m) => m.uid)
      const list = uids.length > 0 ? `* SEARCH ${uids.join(' ')}` : '* SEARCH'
      send(`${list}${CRLF}${tag} OK Completed`)
    } else if (verbName === 'FETCH') {
      if (!selected) {
        send(`${tag} NO No mailbox selected`)
        return
      }
      const isUid = C.startsWith('UID ')
      const rangeTok = typeof args[0] === 'string' ? args[0] : '1'
      const items = parseFetchItems(cmd, rangeTok)
      const keys = expandSequenceSet(rangeTok)
      const folder = serverState.folders[selected]
      for (let i = 0; i < folder.messages.length; i++) {
        const msg = folder.messages[i]
        const key = isUid ? msg.uid : i + 1
        if (keys.has(key)) fetchItems(msg, i + 1, items, (l) => send(l))
      }
      send(`${tag} OK Completed`)
    } else if (verbName === 'STORE') {
      if (!selected) {
        send(`${tag} NO No mailbox selected`)
        return
      }
      const rangeTok = typeof args[0] === 'string' ? args[0] : '1'
      const modTok = (args[1] ?? '').toUpperCase()
      let flagList = []
      for (let i = 2; i < args.length; i++) {
        if (args[i] && typeof args[i] === 'object' && args[i].list) flagList = args[i].list
        else if (typeof args[i] === 'string' && args[i].startsWith('\\')) flagList = [args[i]]
      }
      applyStore(rangeTok, modTok.replace(/\.SILENT$/i, '').replace(/\.KEYWORDS$/i, ''), flagList)
      send(`${tag} OK Completed`)
    } else if (verb === 'APPEND') {
      const name = typeof args[0] === 'string' ? args[0] : ''
      const flags = []
      for (let i = 1; i < args.length; i++) {
        if (args[i] && typeof args[i] === 'object' && args[i].list) {
          for (const t of args[i].list) if (typeof t === 'string') flags.push(t.startsWith('\\') ? t : `\\${t}`)
        }
      }
      const dataMatch = cmd.match(/\{(\d+)[+-]?\}\s*$/)
      if (!dataMatch) {
        send(`${tag} BAD APPEND requires a literal source`)
        return
      }
      const n = Number(dataMatch[1])
      // the literal bytes are read by the connection reader and stashed here
      const source = pendingLiteral ?? Buffer.alloc(0)
      pendingLiteral = undefined
      if (serverState.inject.appendFailFirst && !serverState.appendFailFirstDone) {
        serverState.appendFailFirstDone = true
        send(`${tag} NO first APPEND rejected by policy`)
        return
      }
      const limit = serverState.inject.appendLimit
      if (limit !== undefined && source.length > limit) {
        send(`${tag} NO [APPENDLIMIT] message size ${source.length} exceeds the account limit ${limit}`)
        return
      }
      if (!serverState.folders[name]) {
        send(`${tag} NO no such folder: ${name}`)
        return
      }
      const folder = serverState.folders[name]
      const uid = folder.messages.reduce((m, x) => Math.max(m, x.uid), 0) + 1
      folder.messages.push({
        uid,
        flags: new Set(flags),
        internalDate: new Date(),
        from: null,
        to: [],
        cc: [],
        bcc: [],
        subject: null,
        inReplyTo: null,
        messageId: null,
        rawHeaders: source.toString('latin1'),
        parts: null,
        source,
      })
      serverState.appended.push({ folder: name, flags: [...flags], source })
      send(`${tag} OK [APPENDUID 1 ${uid}] Appended`)
    } else if (verb === 'CREATE') {
      const name = typeof args[0] === 'string' ? args[0] : ''
      if (!name) {
        send(`${tag} BAD CREATE requires a mailbox name`)
        return
      }
      if (name.toUpperCase() === 'INBOX') {
        // Servers reserve INBOX: it can never be created.
        send(`${tag} NO Cannot create INBOX`)
        return
      }
      if (serverState.folders[name]) {
        // A concurrent creator (or a retry after one) won the race: the
        // mailbox already exists.
        send(`${tag} NO Mailbox exists: ${name}`)
        return
      }
      serverState.folders[name] = { messages: [] }
      serverState.created.push(name)
      send(`${tag} OK [CREATED] created ${name}`)
      return
    } else if (verb === 'COPY' || verbName === 'COPY') {
      if (!selected) {
        send(`${tag} NO No mailbox selected`)
        return
      }
      const rangeTok = typeof args[0] === 'string' ? args[0] : '1'
      const dest = typeof args[1] === 'string' ? args[1] : ''
      if (!dest || !serverState.folders[dest]) {
        send(`${tag} NO no such folder: ${dest}`)
        return
      }
      const isUid = C.startsWith('UID ')
      const keys = expandSequenceSet(rangeTok)
      const srcFolder = serverState.folders[selected]
      const destFolder = serverState.folders[dest]
      const copied = []
      srcFolder.messages.forEach((msg, i) => {
        const key = isUid ? msg.uid : i + 1
        if (!keys.has(key)) return
        const uid = destFolder.messages.reduce((m, x) => Math.max(m, x.uid), 0) + 1
        destFolder.messages.push({ ...msg, uid, flags: new Set(msg.flags) })
        copied.push({ uid: msg.uid, destUid: uid })
      })
      if (copied.length > 0) {
        serverState.copied.push({ folder: selected, dest, uids: copied.map((c) => c.uid) })
      }
      send(`${tag} OK Completed`)
      return
    } else if (verb === 'EXPUNGE' || verbName === 'EXPUNGE') {
      if (!selected) {
        send(`${tag} NO No mailbox selected`)
        return
      }
      const folder = serverState.folders[selected]
      const isUid = C.startsWith('UID ')
      const uidKeys = isUid && typeof args[0] === 'string' ? expandSequenceSet(args[0]) : null
      const victims = []
      folder.messages.forEach((msg, i) => {
        const hit = isUid ? (uidKeys ? uidKeys.has(msg.uid) : false) : msg.flags.has('\\Deleted')
        if (hit) victims.push({ msg, seq: i + 1 })
      })
      for (const v of victims) send(`* ${v.seq} EXPUNGE`)
      for (const v of victims) folder.messages.splice(folder.messages.indexOf(v.msg), 1)
      if (victims.length > 0) {
        serverState.expunged.push({ folder: selected, uids: victims.map((v) => v.msg.uid) })
      }
      send(`${tag} OK Completed`)
      return
    } else if (verb === 'DELETE') {
      const name = typeof args[0] === 'string' ? args[0] : ''
      if (!name) {
        send(`${tag} BAD DELETE requires a mailbox name`)
        return
      }
      if (name.toUpperCase() === 'INBOX') {
        // Servers reserve INBOX: it can never be deleted.
        send(`${tag} NO cannot delete INBOX`)
        return
      }
      if (!serverState.folders[name]) {
        send(`${tag} NO no such folder: ${name}`)
        return
      }
      if (serverState.folders[name].messages.length > 0) {
        // The default server policy refuses to delete a non-empty mailbox.
        send(`${tag} NO mailbox not empty: ${name}`)
        return
      }
      delete serverState.folders[name]
      serverState.deletedMailboxes.push(name)
      send(`${tag} OK Completed`)
      return
    } else if (verb === 'CLOSE') {
      selected = null
      send(`${tag} OK Completed`)
    } else if (verb === 'LOGOUT') {
      send(`* BYE fake-imap logging out${CRLF}${tag} OK Completed`)
      stopped = true
      socket.end()
    } else {
      send(`${tag} OK Completed`)
    }
  }

  /** Extract the FETCH data-item list from the command text. */
  function parseFetchItems(cmd, rangeTok) {
    const lp = cmd.indexOf('(')
    if (lp === -1) {
      // a single unwrapped item
      const rest = cmd.replace(new RegExp(`^\\s*${C === 'UID FETCH' ? 'UID ' : ''}${rangeTok}\\s*`), '').trim()
      return [rest]
    }
    let depth = 0
    let end = -1
    for (let i = lp; i < cmd.length; i++) {
      if (cmd[i] === '(') depth++
      else if (cmd[i] === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const inner = cmd.slice(lp + 1, end === -1 ? cmd.length : end)
    // split on whitespace outside brackets/quotes (item text carries no spaces
    // in the section forms this client emits, HEADER.FIELDS excluded)
    const items = []
    let cur = ''
    let inQuote = false
    let inBracket = 0
    for (const ch of inner) {
      if (ch === '"') {
        inQuote = !inQuote
        cur += ch
      } else if (ch === '[') {
        inBracket++
        cur += ch
      } else if (ch === ']') {
        inBracket--
        cur += ch
      } else if ((ch === ' ' || ch === '\t') && !inQuote && inBracket === 0) {
        if (cur) items.push(cur)
        cur = ''
      } else cur += ch
    }
    if (cur) items.push(cur)
    return items
  }

  let pendingLiteral = undefined
  // An APPEND command line may arrive in a packet separate from its literal
  // body; while the literal is still incomplete the connection must keep
  // consuming raw bytes (never lines) until the full length is present.
  let awaitingLiteral = 0
  let appendHead = null

  /** In-place STARTTLS upgrade on the accepted socket. */
  function upgradeToTls(rawSocket) {
    return new Promise((resolve, reject) => {
      const tlsServer = tls.createServer({ cert: CERT_PEM, key: KEY_PEM, isServer: true })
      tlsServer.once('secureConnection', (s) => resolve(s))
      tlsServer.once('error', reject)
      tlsServer.emit('connection', rawSocket)
    })
  }

  function onData(data) {
    buf = Buffer.concat([buf, data])
    for (;;) {
      // While an APPEND literal is still incomplete, consume raw bytes toward
      // it (never split lines) until the full length has arrived; the literal
      // body may contain CRLF and would otherwise be misread as commands.
      if (awaitingLiteral > 0) {
        if (buf.length < awaitingLiteral) return
        pendingLiteral = buf.slice(0, awaitingLiteral)
        buf = buf.slice(awaitingLiteral)
        const head = appendHead
        awaitingLiteral = 0
        appendHead = null
        dispatch(head)
        continue
      }
      const idx = buf.indexOf('\r\n')
      if (idx === -1) return
      const line = buf.slice(0, idx).toString('latin1')
      buf = buf.slice(idx + 2)
      if (line.startsWith('*')) continue
      // an APPEND line ends with a literal header {n}; the n bytes follow
      const litMatch = line.match(/\{(\d+)([+-]?)\}\s*$/)
      if (litMatch && line.toUpperCase().includes('APPEND')) {
        awaitingLiteral = Number(litMatch[1])
        // keep the literal header in the command text: the APPEND dispatch
        // re-derives the expected length from it
        appendHead = line
        if (litMatch[2] !== '+') {
          // a classic (synchronizing) literal: the client waits for the
          // continuation prompt before streaming the literal bytes, which
          // arrive in a later packet. The pinned client version splits
          // incoming data on LF only, so it can not recognize the RFC-correct
          // bare "+ " prompt; the prompt is LF-terminated here (real servers
          // omit the terminator, which this client stalls on) so the classic
          // path stays exercisable
          live.write('+ ' + CRLF, 'latin1')
        }
        continue
      }
      dispatch(line)
    }
  }

  socket.on('data', onData)
  socket.on('close', () => {
    stopped = true
    const i = serverState.openSockets.indexOf(socket)
    if (i >= 0) serverState.openSockets.splice(i, 1)
  })
  // a peer that goes away mid-session must not take the test process down
  socket.on('error', () => {})

  const greeting = `* OK fake-imap ready`
  if (serverState.inject.hangGreeting) {
    // never greet: the client waits on the greeting until the deadline
  } else if (serverState.inject.greetingDelayMs > 0) {
    // a slow server: the greeting (and everything after it) is delayed
    setTimeout(() => {
      if (!stopped) send(greeting)
    }, serverState.inject.greetingDelayMs)
  } else {
    send(greeting)
  }
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

/**
 * Start the fake IMAP server on loopback.
 * @param opts configuration: mode ('tls' | 'starttls'), the user map, the
 *        folder map (name -> { messages: [...] }), the subscribed set, and
 *        the failure injections.
 * @returns a handle with the bound port and stop().
 */
export async function startImapServer(opts = {}) {
  const mode = opts.mode ?? 'tls'
  const serverState = {
    mode,
    users: opts.users ?? { agent: 'secret' },
    folders: opts.folders ?? {},
    subscribed: opts.subscribed ? new Set(opts.subscribed) : new Set(),
    inject: opts.inject ?? {},
    appended: [],
    created: [],
    copied: [],
    expunged: [],
    deletedMailboxes: [],
    appendFailFirstDone: false,
    commands: [],
    connections: [],
    openSockets: [],
  }
  let server
  if (mode === 'tls') {
    server = tls.createServer({ cert: CERT_PEM, key: KEY_PEM }, (socket) => handleImapSocket(socket, serverState))
  } else {
    // 'starttls' and 'starttls-none' both accept plaintext sockets; the
    // latter advertises no STARTTLS capability at all
    server = net.createServer((socket) => handleImapSocket(socket, serverState))
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    state: serverState,
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        for (const s of serverState.openSockets ?? []) s.destroy()
      }),
  }
}
