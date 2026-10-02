// dsh-email selftest: drives the shipped lib/ build against in-process fake
// IMAP/SMTP servers (loopback) and asserts the full behavior contract: the
// EMAIL_* env matrix, account resolution, the sixteen tool verbs (wire-level
// assertions on the fake servers for SEARCH construction, PEEK semantics,
// flag store, APPEND source identity, SMTP envelope and MIME shape, mailbox
// create/delete, uid-scoped copy+expunge moves), the
// STARTTLS branches, the closed error-code vocabulary, the tool error
// surface, the delivered config layer (schema validation plus fold semantics,
// including a wire-level proof that a layer-carried value behaves exactly
// like its env counterpart), plugin/skill assembly, and the shipped-hygiene
// guards.
// Run with: node --test test/   (or: node test/selftest.mjs)
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(PKG, 'package.json'))

const { PLUGIN_NAME, PLUGIN_VERSION } = await import(path.join(PKG, 'lib', 'util.js'))
const {
  NAME_RE,
  parseBoolean,
  parseIntBounded,
  parseTlsMode,
  parseEnv,
  foldConfig,
  resolveAccount,
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_PORT,
  DEFAULT_IMAP_TLS,
  DEFAULT_SMTP_TLS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_READ_BODY_LIMIT,
} = await import(path.join(PKG, 'lib', 'config.js'))
const {
  VERBS,
  DEFAULT_FOLDER,
  DEFAULT_LIMIT,
  LIMIT_MIN,
  LIMIT_MAX,
  registerTool,
} = await import(path.join(PKG, 'lib', 'tool.js'))
const { RAW_HEADERS_LIMIT, RAW_HEADERS_TRUNCATED, presentRawHeaders, quoteText } = await import(
  path.join(PKG, 'lib', 'message.js')
)
const { DEFAULT_SAVE_DIR, sanitizeFilename } = await import(path.join(PKG, 'lib', 'save.js'))
const { DshEmailPlugin } = await import(path.join(PKG, 'lib', 'index.js'))
const { startImapServer, makeMessage } = await import(path.join(PKG, 'test', 'fake-imap.mjs'))
const { startSmtpServer } = await import(path.join(PKG, 'test', 'fake-smtp.mjs'))

const ToolArgsError = require('@deepseek-ai/dsh-tools').ToolArgsError

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    failures.push(name + (extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''))
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    failures.push(`${name} :: expected ${e} got ${a}`)
  }
}

// ---------------------------------------------------------------------------
// fixtures and helpers
// ---------------------------------------------------------------------------

const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/

/** A deterministic binary body (latin1 string) of n bytes following i%mod. */
function binPattern(n, mod) {
  let s = ''
  const CH = 8192
  for (let i = 0; i < n; i += CH) {
    const len = Math.min(CH, n - i)
    s += String.fromCharCode(...Array.from({ length: len }, (_, j) => (i + j) % mod))
  }
  return s
}
const REPORT_BODY = binPattern(257, 251)
const BIG_BODY = binPattern(70000, 253)
const PAD_LINE = 'p'.repeat(20000)

/** The five-message INBOX fixture (shared by the TLS and STARTTLS instances). */
function inboxMessages() {
  return [
    makeMessage({
      uid: 1,
      flags: [],
      internalDate: '2026-10-01T10:00:00Z',
      from: { name: 'Sender One', address: 'one@example.com' },
      to: [{ address: 'agent@example.com' }],
      subject: 'First message',
      messageId: '<m1@example.com>',
      rawHeaders:
        'From: Sender One <one@example.com>\r\n' +
        'To: agent@example.com\r\n' +
        'Subject: First message\r\n' +
        'Date: Tue, 01 Oct 2026 10:00:00 +0000\r\n' +
        'Message-ID: <m1@example.com>\r\n' +
        'X-Ref: abc\r\n' +
        '\r\n',
      parts: {
        type: 'multipart/mixed',
        boundary: 'mix-1',
        parts: [
          { type: 'text/plain', charset: 'utf-8', cte: '7bit', body: 'Hello body one.' },
          { type: 'application/octet-stream', cte: 'base64', disposition: 'attachment', filename: 'report.bin', body: REPORT_BODY },
        ],
      },
    }),
    makeMessage({
      uid: 2,
      flags: ['\\Seen'],
      internalDate: '2026-10-03T12:30:00Z',
      from: { address: 'two@example.com' },
      to: [{ address: 'agent@example.com' }],
      cc: [{ address: 'bob@example.com' }],
      subject: 'Second message',
      messageId: '<m2@example.com>',
      inReplyTo: '<m1@example.com>',
      rawHeaders:
        'From: two@example.com\r\n' +
        'To: agent@example.com\r\n' +
        'Cc: bob@example.com\r\n' +
        'Subject: Second message\r\n' +
        'Date: Thu, 03 Oct 2026 12:30:00 +0000\r\n' +
        'Message-ID: <m2@example.com>\r\n' +
        'In-Reply-To: <m1@example.com>\r\n' +
        'References: <m1@example.com>\r\n' +
        `X-Pad: ${PAD_LINE}\r\n` +
        '\r\n',
      parts: { type: 'text/plain', charset: 'utf-8', cte: '7bit', body: 'Body two, seen.' },
    }),
    makeMessage({
      uid: 3,
      flags: [],
      internalDate: '2026-10-04T08:00:00Z',
      from: { address: 'three@example.com' },
      to: [{ address: 'agent@example.com' }],
      subject: 'Big attachment',
      messageId: '<m3@example.com>',
      rawHeaders:
        'From: three@example.com\r\n' +
        'To: agent@example.com\r\n' +
        'Subject: Big attachment\r\n' +
        'Date: Fri, 04 Oct 2026 08:00:00 +0000\r\n' +
        'Message-ID: <m3@example.com>\r\n' +
        '\r\n',
      parts: {
        type: 'multipart/mixed',
        boundary: 'mix-3',
        parts: [
          { type: 'text/plain', charset: 'utf-8', cte: '7bit', body: 'Big body three.' },
          { type: 'application/octet-stream', cte: 'base64', disposition: 'attachment', filename: 'data.bin', body: BIG_BODY },
        ],
      },
    }),
    makeMessage({
      uid: 4,
      flags: ['\\Flagged'],
      internalDate: '2026-10-05T09:00:00Z',
      from: { address: 'four@example.com' },
      to: [{ address: 'agent@example.com' }],
      subject: 'Html only',
      messageId: '<m4@example.com>',
      rawHeaders:
        'From: four@example.com\r\n' +
        'To: agent@example.com\r\n' +
        'Subject: Html only\r\n' +
        'Date: Sat, 05 Oct 2026 09:00:00 +0000\r\n' +
        'Message-ID: <m4@example.com>\r\n' +
        '\r\n',
      parts: { type: 'text/html', charset: 'utf-8', cte: '7bit', body: '<p>Html body four</p>' },
    }),
    makeMessage({
      uid: 5,
      flags: [],
      internalDate: '2026-10-06T09:00:00Z',
      from: { address: 'five@example.com' },
      to: [{ address: 'agent@example.com' }],
      subject: 'No body',
      messageId: '<m5@example.com>',
      rawHeaders:
        'From: five@example.com\r\n' +
        'To: agent@example.com\r\n' +
        'Subject: No body\r\n' +
        'Date: Sun, 06 Oct 2026 09:00:00 +0000\r\n' +
        'Message-ID: <m5@example.com>\r\n' +
        '\r\n',
      parts: {
        type: 'multipart/mixed',
        boundary: 'mix-5',
        parts: [
          { type: 'text/plain', charset: 'utf-8', cte: '7bit', disposition: 'attachment', filename: 'dup.txt', body: 'first dup' },
          { type: 'text/plain', charset: 'utf-8', cte: '7bit', disposition: 'attachment', filename: 'dup.txt', body: 'second dup' },
        ],
      },
    }),
  ]
}

/** The boundary-limit fixture of the trunc account (bodies of 99/100/101 chars). */
function boundaryMessages() {
  const mk = (uid, body, subject) =>
    makeMessage({
      uid,
      flags: [],
      internalDate: '2026-10-01T00:00:00Z',
      from: { address: 'somebody@example.com' },
      to: [{ address: 'agent@example.com' }],
      subject,
      messageId: `<mb${uid}@example.com>`,
      rawHeaders:
        `From: somebody@example.com\r\n` +
        `To: agent@example.com\r\n` +
        `Subject: ${subject}\r\n` +
        `Message-ID: <mb${uid}@example.com>\r\n` +
        '\r\n',
      parts: { type: 'text/plain', charset: 'utf-8', cte: '7bit', body },
    })
  return [mk(1, 'x'.repeat(99), 'b99'), mk(2, 'y'.repeat(100), 'Fwd: Moved'), mk(3, 'z'.repeat(101), 'b101')]
}

/** Six messages whose date order is the reverse of the uid order (with a tie). */
function invertedMessages() {
  const mk = (uid, iso, subject, sender) =>
    makeMessage({
      uid,
      flags: [],
      internalDate: iso,
      from: { address: `${sender}@example.com` },
      to: [{ address: 'agent@example.com' }],
      subject,
      messageId: `<mi${uid}@example.com>`,
      rawHeaders:
        `From: ${sender}@example.com\r\n` +
        `To: agent@example.com\r\n` +
        `Subject: ${subject}\r\n` +
        `Message-ID: <mi${uid}@example.com>\r\n` +
        '\r\n',
      parts: { type: 'text/plain', charset: 'utf-8', cte: '7bit', body: `inverted ${uid}` },
    })
  return [
    mk(1, '2026-10-05T09:00:00Z', 'inv one', 'inv1'),
    mk(2, '2026-10-03T12:30:00Z', 'inv two', 'inv2'),
    mk(3, '2026-10-06T08:00:00Z', 'inv three', 'inv3'),
    mk(4, '2026-10-01T10:00:00Z', 'inv four', 'inv4'),
    mk(5, '2026-10-04T00:00:00Z', 'inv five', 'inv5'),
    mk(6, '2026-10-04T00:00:00Z', 'inv six', 'inv6'),
  ]
}

/** Bodies stored in non-UTF-8 charsets (windows-1252, iso-8859-1, an unknown one). */
function charsetMessages() {
  // single-part messages carry their part Content-Type as a top-level message
  // header (the download path reads it from the message headers), so the mime
  // argument carries those lines for the single-part fixtures
  const head = (uid, subject, sender, mime = '') =>
    `From: ${sender}\r\n` +
    `To: agent@example.com\r\n` +
    `Subject: ${subject}\r\n` +
    `Message-ID: <mc${uid}@example.com>\r\n` +
    mime +
    '\r\n'
  return [
    makeMessage({
      uid: 1,
      flags: [],
      internalDate: '2026-10-01T10:00:00Z',
      from: { address: 'cp1252@example.com' },
      to: [{ address: 'agent@example.com' }],
      subject: 'Charset windows',
      messageId: '<mc1@example.com>',
      rawHeaders: head(1, 'Charset windows', 'cp1252@example.com'),
      // the word below is encodable in windows-1252 (cp1252) as 8E 6F 9A 74 E9, where
      // 8E (Z-caron) and 9A (s-caron) sit in the 0x80-0x9F range cp1252 remaps away from
      // latin-1, so a plain utf-8/latin-1 decode cannot produce the expected text; the
      // bytes are expressed as latin1 code points because Node has no cp1252 buffer codec
      parts: {
        type: 'multipart/alternative',
        boundary: 'alt-1',
        parts: [{ type: 'text/plain', charset: 'windows-1252', cte: '7bit', body: '\u008eo\u009at\u00e9' }],
      },
    }),
    makeMessage({
      uid: 2,
      flags: [],
      internalDate: '2026-10-02T10:00:00Z',
      from: { address: 'latin1@example.com' },
      to: [{ address: 'agent@example.com' }],
      subject: 'Charset iso',
      messageId: '<mc2@example.com>',
      rawHeaders: head(2, 'Charset iso', 'latin1@example.com', 'Content-Type: text/html; charset=iso-8859-1\r\nContent-Transfer-Encoding: 7bit\r\n'),
      parts: { type: 'text/html', charset: 'iso-8859-1', cte: '7bit', body: Buffer.from('café', 'latin1').toString('latin1') },
    }),
    makeMessage({
      uid: 3,
      flags: [],
      internalDate: '2026-10-03T10:00:00Z',
      from: { address: 'unknown@example.com' },
      to: [{ address: 'agent@example.com' }],
      subject: 'Charset unknown',
      messageId: '<mc3@example.com>',
      rawHeaders: head(3, 'Charset unknown', 'unknown@example.com', 'Content-Type: text/plain; charset=x-unknown-charset\r\nContent-Transfer-Encoding: 7bit\r\n'),
      parts: { type: 'text/plain', charset: 'x-unknown-charset', cte: '7bit', body: 'caf\u00e9' },
    }),
  ]
}

/** A single message that carries no Message-ID header at all. */
function noMessageIdMessages() {
  return [
    makeMessage({
      uid: 1,
      flags: [],
      internalDate: '2026-10-01T10:00:00Z',
      from: { address: 'one@example.com' },
      to: [{ address: 'agent@example.com' }],
      subject: 'No message id',
      messageId: null,
      rawHeaders:
        'From: one@example.com\r\n' +
        'To: agent@example.com\r\n' +
        'Subject: No message id\r\n' +
        'Date: Tue, 01 Oct 2026 10:00:00 +0000\r\n' +
        '\r\n',
      parts: { type: 'text/plain', charset: 'utf-8', cte: '7bit', body: 'Body without an id.' },
    }),
  ]
}

/** The EMAIL_* fixture for one account pointing at loopback fake servers.
 * The TLS modes default to 'tls' (implicit TLS) to match the fake servers'
 * dominant mode; the fake self-signed certificates make the insecure flag
 * default on. */
function envOne(name, o = {}) {
  const {
    imapPort,
    smtpPort,
    imapTls = 'tls',
    smtpTls = 'tls',
    imapInsecure = true,
    smtpInsecure = true,
    pass = 'secret',
    from = 'agent@example.com',
    fromName,
    sentFolder,
    sentFolderAutocreate,
    allowDelete,
    timeout,
  } = o
  const env = {
    [`EMAIL_${name}_USER`]: 'agent',
    [`EMAIL_${name}_PASS`]: pass,
    [`EMAIL_${name}_IMAP_HOST`]: '127.0.0.1',
    [`EMAIL_${name}_IMAP_PORT`]: String(imapPort),
    [`EMAIL_${name}_IMAP_SECURE`]: imapTls,
    [`EMAIL_${name}_SMTP_HOST`]: '127.0.0.1',
    [`EMAIL_${name}_SMTP_PORT`]: String(smtpPort),
    [`EMAIL_${name}_SMTP_SECURE`]: smtpTls,
  }
  if (imapInsecure) env[`EMAIL_${name}_IMAP_ALLOW_INSECURE_TLS`] = 'true'
  if (smtpInsecure) env[`EMAIL_${name}_SMTP_ALLOW_INSECURE_TLS`] = 'true'
  if (from) env[`EMAIL_${name}_FROM`] = from
  if (fromName) env[`EMAIL_${name}_FROM_NAME`] = fromName
  if (sentFolder) env[`EMAIL_${name}_SENT_FOLDER`] = sentFolder
  if (sentFolderAutocreate !== undefined) env[`EMAIL_${name}_SENT_FOLDER_AUTOCREATE`] = String(sentFolderAutocreate)
  if (allowDelete !== undefined) env[`EMAIL_${name}_ALLOW_DELETE`] = String(allowDelete)
  if (timeout) env[`EMAIL_${name}_TIMEOUT_MS`] = String(timeout)
  return env
}

/** A minimal cordis Context double collecting every registration. */
function fakeCtx() {
  const state = { tools: [], providers: [], sections: [], provided: [], warns: [] }
  const ctx = {
    reflect: { provide: (name) => { state.provided.push(name) } },
    logger: () => ({ warn: (m) => state.warns.push(m), error() {}, info() {}, debug() {} }),
    tools: { register: (t) => { state.tools.push(t); return () => {} } },
    skills: { registerProvider: (p) => { state.providers.push(p); return () => {} } },
    systemPrompt: { section: (s) => { state.sections.push(s); return () => {} } },
  }
  return { ctx, state }
}

/** Register the tool for one parsed config and return a driver around execute. */
function makeDriver(env, warnSink) {
  const warns = warnSink ?? []
  const cfg = parseEnv(env, (m) => warns.push(m))
  const { ctx, state } = fakeCtx()
  registerTool(ctx, cfg)
  const tool = state.tools[0]
  return {
    cfg,
    warns,
    execute: (args) => Promise.resolve(tool.execute(args)),
  }
}

/** Parse a tool result: JSON documents parse; plain text returns null. */
function doc(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** The IMAP command lines (without tag) of one server instance. */
const imapCmd = (srvState, verb) => srvState.commands.filter((c) => c.startsWith(verb + ' ') || c === verb)

/** The last SMTP connection record of one server instance. */
const lastConn = (srvState) => srvState.connections.at(-1)

/** Run fn with a server handle, always stopping the server afterwards. */
async function withServer(start, fn) {
  const srv = await start()
  try {
    await fn(srv)
  } finally {
    await srv.stop()
  }
}

// ---------------------------------------------------------------------------
// 1. exported constants
// ---------------------------------------------------------------------------
{
  eq('constants: plugin name', PLUGIN_NAME, 'dsh-email')
  eq('constants: plugin version', PLUGIN_VERSION, '0.1.0')
  eq(
    'constants: verb set (16)',
    [...VERBS],
    ['accounts', 'verify', 'folders', 'list', 'list_unseen', 'search', 'read', 'mark', 'save_part', 'send', 'reply', 'forward', 'create_folder', 'delete_folder', 'move', 'delete'],
  )
  eq('constants: default folder', DEFAULT_FOLDER, 'INBOX')
  eq('constants: limit default/min/max', [DEFAULT_LIMIT, LIMIT_MIN, LIMIT_MAX], [25, 1, 100])
  eq('constants: default ports', [DEFAULT_IMAP_PORT, DEFAULT_SMTP_PORT], [993, 587])
  eq('constants: default TLS modes', [DEFAULT_IMAP_TLS, DEFAULT_SMTP_TLS], ['tls', 'starttls'])
  eq('constants: TLS mode parser accepts the three modes case-insensitively', [parseTlsMode('TLS'), parseTlsMode('starttls'), parseTlsMode('NONE'), parseTlsMode('plaintext')], ['tls', 'starttls', 'none', undefined])
  eq('constants: default timeout/read-body-limit', [DEFAULT_TIMEOUT_MS, DEFAULT_READ_BODY_LIMIT], [120000, 20000])
  eq('constants: raw header bound + marker', [RAW_HEADERS_LIMIT, RAW_HEADERS_TRUNCATED], [16384, '[dsh-email: header block truncated]'])
  eq('constants: default save dir', DEFAULT_SAVE_DIR, 'attachments')
}
{
  ok('name regex: accepts lowercase with digits and hyphens', NAME_RE.test('a') && NAME_RE.test('abc-1') && NAME_RE.test('z9-' + 'x'.repeat(28)))
  ok('name regex: rejects digit lead, hyphen lead, long names, and uppercase', !NAME_RE.test('1abc') && !NAME_RE.test('-ab') && !NAME_RE.test('a'.repeat(33)) && !NAME_RE.test('Abc'))
  eq('parseBoolean: true set', [parseBoolean('true'), parseBoolean('1'), parseBoolean('yes'), parseBoolean('on')], [true, true, true, true])
  eq('parseBoolean: false set', [parseBoolean('false'), parseBoolean('0'), parseBoolean('no'), parseBoolean('off')], [false, false, false, false])
  eq('parseBoolean: other is undefined', parseBoolean('maybe'), undefined)
  eq('parseIntBounded: in range', parseIntBounded('8080', 1, 65535), 8080)
  eq('parseIntBounded: non-numeric', parseIntBounded('abc', 1, 65535), undefined)
  eq('parseIntBounded: out of range', [parseIntBounded('0', 1, 65535), parseIntBounded('70000', 1, 65535)], [undefined, undefined])
}

// ---------------------------------------------------------------------------
// 2. EMAIL_* env parse matrix (pure)
// ---------------------------------------------------------------------------
{
  const warns = []
  const env = {
    ...envOne('aaa', { imapPort: 993, smtpPort: 465, from: 'a@example.com', fromName: 'A', sentFolder: 'Outbox', timeout: 1000, imapTls: 'starttls', smtpTls: 'starttls' }),
    ...(() => {
      const e = { ...envOne('bbb', { imapPort: 143, smtpPort: 587, from: '', imapInsecure: false, smtpInsecure: false }) }
      // the USER fallback for the FROM must be a mailbox address
      e.EMAIL_bbb_USER = 'agent@corp.example'
      return e
    })(),
    EMAIL_DEFAULT_ACCOUNT: 'AAA',
    EMAIL_READ_BODY_LIMIT: '12345',
  }
  const cfg = parseEnv(env, (m) => warns.push(m))
  eq('env: two valid accounts sorted by name', cfg.accounts.map((a) => a.name), ['aaa', 'bbb'])
  eq('env: no warnings for a clean fixture', warns, [])
  const a = cfg.accounts[0]
  eq('env: account fields (ports, tls mode, timeout, from, fromName, sentFolder)', [a.imap.port, a.smtp.port, a.imap.tls, a.smtp.tls, a.timeoutMs, a.from, a.fromName, a.sentFolder], [993, 465, 'starttls', 'starttls', 1000, 'a@example.com', 'A', 'Outbox'])
  eq('env: sentFolderAutocreate defaults to true', a.sentFolderAutocreate, true)
  eq('env: default account is case-insensitive', [a.isDefault, cfg.accounts[1].isDefault], [true, false])
  eq('env: read body limit', cfg.readBodyLimit, 12345)
  const b = cfg.accounts[1]
  eq('env: from falls back to the user when unset', b.from, 'agent@corp.example')
  eq('env: stored allowInsecure keeps the operator semantics', [b.imap.allowInsecure, b.smtp.allowInsecure], [false, false])
}
{
  const warns = []
  const cfg = parseEnv(
    { EMAIL_HALF_USER: 'u', EMAIL_HALF_PASS: 'p', EMAIL_HALF_IMAP_HOST: 'h', EMAIL_GOOD_USER: 'g', EMAIL_GOOD_PASS: 'p', EMAIL_GOOD_IMAP_HOST: 'h', EMAIL_GOOD_SMTP_HOST: 'h', EMAIL_GOOD_FROM: 'g@corp.example' },
    (m) => warns.push(m),
  )
  eq('env: half-set account dropped, the rest unaffected', cfg.accounts.map((a) => a.name), ['good'])
  ok('env: drop warning names the account only', warns.length === 1 && warns[0].includes('half') && !warns[0].includes('SECRET_VALUE'), warns)
  ok('env: drop warning states the missing fields', /missing required field/.test(warns[0] ?? ''), warns)
}
{
  const warns = []
  const charsetEnv = { ...envOne('1bad', { imapPort: 1, smtpPort: 2 }), ...envOne('x'.repeat(33), { imapPort: 1, smtpPort: 2 }), EMAIL_GOOD_USER: 'g', EMAIL_GOOD_PASS: 'p', EMAIL_GOOD_IMAP_HOST: 'h', EMAIL_GOOD_SMTP_HOST: 'h', EMAIL_GOOD_FROM: 'g@corp.example' }
  const cfg2 = parseEnv(charsetEnv, (m) => warns.push(m))
  eq('env: only the fully valid account survives', cfg2.accounts.map((a) => a.name), ['good'])
  eq('env: the too-long name warns once (a digit-leading key is never declared at all)', warns.filter((w) => /outside the charset/.test(w)).length, 1)
}
{
  // the key name segment is case-insensitive and dedupes on the uppercased form:
  // EMAIL_Aaa_* and EMAIL_AAA_* declare the single account "aaa"
  const warns = []
  const env = {
    EMAIL_Aaa_USER: 'u',
    EMAIL_Aaa_PASS: 'p',
    EMAIL_AAA_IMAP_HOST: 'h',
    EMAIL_Aaa_IMAP_PORT: '993',
    EMAIL_AAA_SMTP_HOST: 'h',
    EMAIL_Aaa_SMTP_PORT: '465',
    EMAIL_AAA_IMAP_SECURE: 'tls',
    EMAIL_AAA_SMTP_SECURE: 'tls',
    EMAIL_AAA_FROM: 'u@corp.example',
  }
  const cfg = parseEnv(env, (m) => warns.push(m))
  eq('env: mixed-case keys merge into one lowercase account without warnings', [cfg.accounts.map((a) => a.name), warns.length], [['aaa'], 0])
}
{
  const drop = (field, value) => {
    const warns = []
    const env = { ...envOne('bad', { imapPort: 1, smtpPort: 2 }) }
    env[`EMAIL_BAD_${field}`] = value
    const cfg = parseEnv(env, (m) => warns.push(m))
    return { dropped: cfg.accounts.length === 0, warn: warns[0] ?? '' }
  }
  ok('env: invalid IMAP port drops the account', drop('IMAP_PORT', 'abc').dropped)
  ok('env: zero IMAP port drops the account', drop('IMAP_PORT', '0').dropped)
  ok('env: oversized SMTP port drops the account', drop('SMTP_PORT', '70000').dropped)
  ok('env: invalid IMAP secure mode drops the account', drop('IMAP_SECURE', 'maybe').dropped)
  ok('env: a legacy boolean SECURE value is not a mode and drops the account', drop('IMAP_SECURE', 'true').dropped && drop('IMAP_SECURE', 'false').dropped)
  ok('env: invalid timeout drops the account', drop('TIMEOUT_MS', 'abc').dropped)
  ok('env: zero timeout drops the account', drop('TIMEOUT_MS', '0').dropped)
  ok('env: invalid insecure-TLS flag drops the account', drop('IMAP_ALLOW_INSECURE_TLS', 'maybe').dropped)
  ok('env: invalid insecure-TLS flag warning names the field', /ALLOW_INSECURE_TLS/.test(drop('IMAP_ALLOW_INSECURE_TLS', 'maybe').warn))
  ok('env: an invalid SENT_FOLDER_AUTOCREATE value drops the account', drop('SENT_FOLDER_AUTOCREATE', 'maybe').dropped)
  ok('env: the drop warning names the autocreate field', /SENT_FOLDER_AUTOCREATE/.test(drop('SENT_FOLDER_AUTOCREATE', 'maybe').warn))
  const big = parseEnv({ ...envOne('big', { imapPort: 1, smtpPort: 2, timeout: 360000000 }) }, () => {})
  eq('env: a timeout beyond the default budget is accepted (no cap)', big.accounts[0].timeoutMs, 360000000)
}
{
  // The autocreate switch is a strict boolean (true/1/yes/on, false/0/no/off,
  // case-insensitive); an unknown word drops the account at boot.
  const ac = (value) => {
    const e = { ...envOne('ac', { imapPort: 1, smtpPort: 2 }) }
    if (value !== undefined) e.EMAIL_AC_SENT_FOLDER_AUTOCREATE = value
    return parseEnv(e, () => {}).accounts[0]?.sentFolderAutocreate
  }
  eq('env: SENT_FOLDER_AUTOCREATE absent defaults to true', ac(undefined), true)
  eq('env: SENT_FOLDER_AUTOCREATE=false is honored', ac('false'), false)
  eq('env: the autocreate words are case-insensitive', [ac('FALSE'), ac('Off'), ac('YES'), ac('1')], [false, false, true, true])
}
{
  // SECURE is a mode enum: none / tls / starttls (case-insensitive). The
  // contractual defaults are IMAP tls@993 and SMTP starttls@587, with strict
  // certificate validation. A fully minimal account (four required fields
  // only) parses to those defaults.
  const minimal = parseEnv(
    { EMAIL_MIN_USER: 'a@b.example', EMAIL_MIN_PASS: 'p', EMAIL_MIN_IMAP_HOST: 'h', EMAIL_MIN_SMTP_HOST: 'h' },
    () => {},
  )
  const m = minimal.accounts[0]
  eq('env: minimal account takes the contractual TLS defaults', [m.imap.tls, m.imap.port, m.smtp.tls, m.smtp.port, m.imap.allowInsecure, m.smtp.allowInsecure], ['tls', 993, 'starttls', 587, false, false])
  const e = { ...envOne('mode', { imapPort: 1, smtpPort: 2, imapTls: 'TLS', smtpTls: 'StartTLS' }) }
  const cm = parseEnv(e, () => {})
  eq('env: TLS mode words are matched case-insensitively', [cm.accounts[0].imap.tls, cm.accounts[0].smtp.tls], ['tls', 'starttls'])
  const e2 = { ...envOne('none', { imapPort: 1, smtpPort: 2, imapTls: 'none', smtpTls: 'none' }) }
  const cn = parseEnv(e2, () => {})
  eq('env: the none mode (full plaintext) parses on both services', [cn.accounts[0].imap.tls, cn.accounts[0].smtp.tls], ['none', 'none'])
}
{
  // The effective FROM is the FROM value, or the USER value when FROM is
  // unset; it must be a mailbox address, else the account is dropped.
  const withoutFrom = (name, user) => {
    const e = { ...envOne(name, { imapPort: 1, smtpPort: 2, from: '' }) }
    if (user !== undefined) e[`EMAIL_${name}_USER`] = user
    return e
  }
  const warns = []
  const cfg = parseEnv(
    {
      ...envOne('badf', { imapPort: 1, smtpPort: 2, from: 'bare-local' }),
      ...withoutFrom('nouser'),
      ...withoutFrom('okuser', 'agent@corp.example'),
      ...envOne('okfrom', { imapPort: 1, smtpPort: 2, from: 'x@y.z' }),
      ...envOne('emptylocal', { imapPort: 1, smtpPort: 2, from: '@y.z' }),
      ...envOne('emptydomain', { imapPort: 1, smtpPort: 2, from: 'x@' }),
    },
    (m) => warns.push(m),
  )
  eq('from: only mailbox-shaped effective FROMs survive', cfg.accounts.map((a) => a.name), ['okfrom', 'okuser'])
  eq('from: the fallback keeps the USER value', cfg.accounts.find((a) => a.name === 'okuser').from, 'agent@corp.example')
  eq('from: an explicit FROM wins over USER', cfg.accounts.find((a) => a.name === 'okfrom').from, 'x@y.z')
  eq('from: one drop warning per invalid account', warns.length, 4)
  ok('from: drop warnings name the account and the rule, never the value', warns.every((w) => /mailbox/.test(w) && !/bare-local|plainuser|x@/.test(w)), warns)
}
{
  const warns = []
  const cfg = parseEnv(
    {
      'EMAIL_my-acct_USER': 'u',
      'EMAIL_my-acct_PASS': 'p',
      'EMAIL_my-acct_IMAP_HOST': 'h',
      'EMAIL_my-acct_SMTP_HOST': 'h',
      EMAIL_GOOD_USER: 'g',
      EMAIL_GOOD_PASS: 'p',
      EMAIL_GOOD_IMAP_HOST: 'h',
      EMAIL_GOOD_SMTP_HOST: 'h',
      EMAIL_GOOD_FROM: 'g@corp.example',
    },
    (m) => warns.push(m),
  )
  eq('names: unrecognized name segments declare no account', cfg.accounts.map((a) => a.name), ['good'])
  eq('names: one warning per unrecognized key', warns.length, 4)
  ok('names: warnings name the key and the rule', warns.every((w) => /not recognized/.test(w) && w.includes('my-acct')) && warns.some((w) => w.includes('EMAIL_my-acct_USER')), warns)
}
{
  const warns = []
  const cfg = parseEnv({ EMAIL_READ_BODY_LIMIT: 'abc' }, (m) => warns.push(m))
  eq('env: no account variables means zero accounts', cfg.accounts.length, 0)
  eq('env: invalid read-body limit falls back to the default', cfg.readBodyLimit, 20000)
  ok('env: the fallback warning names the variable', warns.length === 1 && /EMAIL_READ_BODY_LIMIT/.test(warns[0]), warns)
}
{
  const env = { ...envOne('main', { imapPort: 1, smtpPort: 2 }), EMAIL_DEFAULT_ACCOUNT: 'ghost' }
  const cfg = parseEnv(env, () => {})
  eq('env: stale default account flags nothing', cfg.accounts[0].isDefault, false)
  eq('env: resolution falls through a stale default to the sole account', resolveAccount(cfg, undefined).account.name, 'main')
  eq('env: an explicit name still resolves', resolveAccount(cfg, 'main').account.name, 'main')
  const staleMany = parseEnv({ ...envOne('aaa', { imapPort: 1, smtpPort: 2 }), ...envOne('bbb', { imapPort: 1, smtpPort: 2 }), EMAIL_DEFAULT_ACCOUNT: 'ghost' }, () => {})
  ok('env: a stale default with many accounts is an error', 'error' in resolveAccount(staleMany, undefined))
}

// ---------------------------------------------------------------------------
// 3. resolveAccount chain (pure)
// ---------------------------------------------------------------------------
{
  const two = parseEnv({ ...envOne('aaa', { imapPort: 1, smtpPort: 2 }), ...envOne('bbb', { imapPort: 1, smtpPort: 2 }) }, () => {})
  const none = parseEnv({}, () => {})
  const single = parseEnv({ ...envOne('solo', { imapPort: 1, smtpPort: 2 }) }, () => {})
  const withDefault = parseEnv({ ...envOne('aaa', { imapPort: 1, smtpPort: 2 }), ...envOne('bbb', { imapPort: 1, smtpPort: 2 }), EMAIL_DEFAULT_ACCOUNT: 'bbb' }, () => {})

  eq('resolve: explicit hit', resolveAccount(two, 'bbb').account.name, 'bbb')
  const unknown = resolveAccount(two, 'zzz')
  ok('resolve: explicit unknown names the valid set', 'error' in unknown && /aaa/.test(unknown.error) && /bbb/.test(unknown.error), unknown)
  ok('resolve: zero accounts is an error', 'error' in resolveAccount(none, undefined))
  eq('resolve: sole account resolves without a default', resolveAccount(single).account.name, 'solo')
  ok('resolve: many accounts without a default is an error', 'error' in resolveAccount(two))
  eq('resolve: valid default wins over the rest', resolveAccount(withDefault).account.name, 'bbb')
}

// ---------------------------------------------------------------------------
// 4. accounts verb (zero network, zero credential leak)
// ---------------------------------------------------------------------------
{
  const env = { ...envOne('main', { imapPort: 1, smtpPort: 2, from: 'agent@example.com', fromName: 'Agent', sentFolder: 'Sent' }), ...envOne('side', { imapPort: 3, smtpPort: 4 }), EMAIL_DEFAULT_ACCOUNT: 'main' }
  const d = makeDriver(env)
  const out = doc(await d.execute({ verb: 'accounts' }))
  ok('accounts: result parses as JSON', out !== null)
  eq('accounts: default account', out.default, 'main')
  eq('accounts: both accounts listed', out.accounts.map((a) => a.name), ['main', 'side'])
  const main = out.accounts[0]
  eq('accounts: main fields', [main.user, main.from, main.isDefault, main.sentFolder, main.sentFolderAutocreate, main.imap, main.smtp], ['agent', 'agent@example.com', true, 'Sent', true, { host: '127.0.0.1', port: 1, tls: 'tls', certVerify: 'insecure' }, { host: '127.0.0.1', port: 2, tls: 'tls', certVerify: 'insecure' }])
  eq('accounts: side account carries the autocreate default', out.accounts[1].sentFolderAutocreate, true)
  eq('accounts: side fields', [out.accounts[1].user, out.accounts[1].isDefault, out.accounts[1].imap.port, out.accounts[1].smtp.port], ['agent', false, 3, 4])
  ok('accounts: no credential value leaks into the output', !(await d.execute({ verb: 'accounts' })).includes('secret'))
  const empty = makeDriver({})
  const emptyOut = doc(await empty.execute({ verb: 'accounts' }))
  ok('accounts: zero accounts is an empty set, not an error', emptyOut !== null && emptyOut.ok !== false && emptyOut.default === null && Array.isArray(emptyOut.accounts) && emptyOut.accounts.length === 0, emptyOut)
}

// ---------------------------------------------------------------------------
// 5. SEARCH wire construction (fake IMAP, TLS)
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, subscribed: ['INBOX'] }),
    (srv) =>
      (async () => {
        const d = makeDriver({ ...envOne('main', { imapPort: srv.port, smtpPort: 1 }) })
        const searchLine = (verb = 'UID SEARCH') => srv.state.commands.filter((c) => c.startsWith(verb + ' ')).at(-1)

        let r = doc(await d.execute({ verb: 'search', from: 'one@example.com', to: 'agent@example.com', subject: 'First message', body: 'hello', header: { name: 'X-Ref', value: 'abc' }, seen: false, since: '2026-09-30', until: '2026-10-02' }))
        eq(
          'search: all-field wire line',
          searchLine(),
          'UID SEARCH SINCE 30-Sep-2026 BEFORE 02-Oct-2026 FROM one@example.com TO agent@example.com SUBJECT "First message" TEXT hello HEADER X-REF abc UNSEEN',
        )
        eq('search: criteria ANDed yield the empty set (body mismatch)', [r.total, r.messages], [0, []])

        r = doc(await d.execute({ verb: 'search', from: 'two@example.com', since: '2026-10-02', until: '2026-10-07' }))
        eq('search: positive from+date wire line', searchLine(), 'UID SEARCH SINCE 02-Oct-2026 BEFORE 07-Oct-2026 FROM two@example.com')
        eq('search: matching uid found', r.messages.map((m) => m.uid), [2])

        r = doc(await d.execute({ verb: 'search', has_attachment: true }))
        eq('search: attachment filter wire line', searchLine(), 'UID SEARCH TEXT "Content-Disposition: attachment"')
        eq('search: attachment filter matches the three fixture messages', r.messages.map((m) => m.uid), [5, 3, 1])

        r = doc(await d.execute({ verb: 'search', since: '2026-10-03' }))
        eq('search: since is day-inclusive', r.messages.map((m) => m.uid), [5, 4, 3, 2])
        r = doc(await d.execute({ verb: 'search', until: '2026-10-04' }))
        eq('search: until is day-exclusive', r.messages.map((m) => m.uid), [2, 1])

        r = doc(await d.execute({ verb: 'search', flagged: true }))
        eq('search: flagged filter wire line', searchLine(), 'UID SEARCH FLAGGED')
        eq('search: flagged filter result', r.messages.map((m) => m.uid), [4])
        r = doc(await d.execute({ verb: 'search', flagged: false }))
        eq('search: unflagged filter wire line', searchLine(), 'UID SEARCH UNFLAGGED')
        eq('search: unflagged filter result', r.messages.map((m) => m.uid), [5, 3, 2, 1])
        r = doc(await d.execute({ verb: 'search', seen: false }))
        eq('search: unseen filter wire line', searchLine(), 'UID SEARCH UNSEEN')
        eq('search: unseen filter result', r.messages.map((m) => m.uid), [5, 4, 3, 1])

        const bad = doc(await d.execute({ verb: 'search', since: 'October 1st' }))
        ok('search: invalid since date surfaces without a code', bad && bad.ok === false && !('code' in bad) && /YYYY-MM-DD/.test(bad.error), bad)
      })(),
  )
}

// ---------------------------------------------------------------------------
// 6. list / list_unseen wire + paging (fake IMAP, TLS)
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, subscribed: ['INBOX'] }),
    (srv) =>
      (async () => {
        const d = makeDriver({ ...envOne('main', { imapPort: srv.port, smtpPort: 1 }) })
        const searchLine = () => srv.state.commands.filter((c) => c.startsWith('UID SEARCH ')).at(-1)

        let r = doc(await d.execute({ verb: 'list', limit: 2, page: 0 }))
        eq('list: wire line is SEARCH ALL', searchLine(), 'UID SEARCH ALL')
        eq('list: newest-first page zero', r.messages.map((m) => m.uid), [5, 4])
        eq('list: paging metadata', [r.total, r.page, r.limit, r.account, r.folder], [5, 0, 2, 'main', 'INBOX'])
        eq('list: message row shape (uid 5)', r.messages[0], { uid: 5, messageId: '<m5@example.com>', from: { address: 'five@example.com' }, to: [{ address: 'agent@example.com' }], subject: 'No body', date: '2026-10-06T09:00:00.000Z', seen: false, flagged: false })
        r = doc(await d.execute({ verb: 'list', limit: 2, page: 1 }))
        eq('list: page one', r.messages.map((m) => m.uid), [3, 2])
        r = doc(await d.execute({ verb: 'list', limit: 2, page: 2 }))
        eq('list: last page is partial', r.messages.map((m) => m.uid), [1])
        eq('list: named from address survives the round trip', r.messages[0].from, { name: 'Sender One', address: 'one@example.com' })
        r = doc(await d.execute({ verb: 'list', limit: 0 }))
        eq('list: limit clamps to the minimum', r.limit, 1)

        r = doc(await d.execute({ verb: 'list_unseen' }))
        eq('list_unseen: wire line', searchLine(), 'UID SEARCH UNSEEN')
        eq('list_unseen: seen message excluded, flagged still listed', r.messages.map((m) => m.uid), [5, 4, 3, 1])

        r = doc(await d.execute({ verb: 'list', seen: false }))
        eq('list: seen: false filter wire line', searchLine(), 'UID SEARCH UNSEEN')
        eq('list: seen: false matches the unseen messages', r.messages.map((m) => m.uid), [5, 4, 3, 1])
        r = doc(await d.execute({ verb: 'list', flagged: true }))
        eq('list: flagged: true filter wire line', searchLine(), 'UID SEARCH FLAGGED')
        eq('list: flagged: true matches the flagged message', r.messages.map((m) => m.uid), [4])
        r = doc(await d.execute({ verb: 'list', seen: false, flagged: true }))
        ok('list: two flag filters AND on the wire', searchLine().includes('UNSEEN') && searchLine().includes('FLAGGED'), searchLine())
        eq('list: the ANDed filters select the intersection', r.messages.map((m) => m.uid), [4])

        r = doc(await d.execute({ verb: 'list', folder: 'NoSuch' }))
        ok('list: missing mailbox is a transport error (server code)', r && r.ok === false && r.code === 'server', r)
      })(),
  )
}

// ---------------------------------------------------------------------------
// 7. read: PEEK semantics, part tree, body selection, raw headers
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, subscribed: ['INBOX'] }),
    (srv) =>
      (async () => {
        const d = makeDriver({ ...envOne('main', { imapPort: srv.port, smtpPort: 1 }) })
        const flagsOf = (uid) => [...srv.state.folders.INBOX.messages.find((m) => m.uid === uid).flags]

        let r = doc(await d.execute({ verb: 'read', uid: 1 }))
        eq('read: message 1 core fields', [r.uid, r.messageId, r.subject, r.date, r.seen, r.flagged, r.account, r.folder], [1, '<m1@example.com>', 'First message', '2026-10-01T10:00:00.000Z', false, false, 'main', 'INBOX'])
        eq('read: from/to views', [r.from, r.to], [{ name: 'Sender One', address: 'one@example.com' }, [{ address: 'agent@example.com' }]])
        eq('read: part tree (text + attachment)', r.parts, [
          { index: 0, kind: 'text', contentType: 'text/plain', size: 15 },
          { index: 1, kind: 'attachment', contentType: 'application/octet-stream', filename: 'report.bin', size: 354 },
        ])
        ok('read: attachment part reports an encoded size', typeof r.parts[1].size === 'number' && r.parts[1].size >= 257, r.parts[1])
        eq('read: body selects the first text part', r.body, { kind: 'text', text: 'Hello body one.', truncated: false, totalLength: 15 })
        eq('read: PEEK leaves the flag set untouched', flagsOf(1), [])
        ok('read: no raw headers without the switch', !('rawHeaders' in r))

        r = doc(await d.execute({ verb: 'read', uid: 4 }))
        eq('read: html-only message falls back to the html part', r.body, { kind: 'html', text: '<p>Html body four</p>', truncated: false, totalLength: '<p>Html body four</p>'.length })
        r = doc(await d.execute({ verb: 'read', uid: 5 }))
        eq('read: no text or html part yields a null body', r.body, null)
        eq('read: PEEK keeps an unseen message unseen', flagsOf(1), [])

        r = doc(await d.execute({ verb: 'read', uid: 2, raw_headers: true }))
        ok('read: raw header block carries the fixture header', typeof r.rawHeaders === 'string' && r.rawHeaders.includes('References: <m1@example.com>'), undefined)
        ok('read: oversized header block truncates with the marker', r.rawHeaders.endsWith(RAW_HEADERS_TRUNCATED), undefined)
        eq('read: truncated header block sits at the bound plus marker', r.rawHeaders.length, RAW_HEADERS_LIMIT + RAW_HEADERS_TRUNCATED.length)
        r = doc(await d.execute({ verb: 'read', uid: 99 }))
        ok('read: unknown uid is a local error without code', r && r.ok === false && !('code' in r) && /not found/.test(r.error), r)

        eq('rawHeaders unit: exact bound passes through', presentRawHeaders('a'.repeat(RAW_HEADERS_LIMIT)), 'a'.repeat(RAW_HEADERS_LIMIT))
        eq('rawHeaders unit: one over truncates with the marker', presentRawHeaders('a'.repeat(RAW_HEADERS_LIMIT + 1)).endsWith(RAW_HEADERS_TRUNCATED), true)
        eq('quoteText unit: line prefix and blank lines', quoteText({ firstTextContent: 'one\n\ntwo' }), '> one\n>\n> two')
      })(),
  )
}

// ---------------------------------------------------------------------------
// 8. mark: four-way flag store verified on the fake
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, subscribed: ['INBOX'] }),
    (srv) =>
      (async () => {
        const d = makeDriver({ ...envOne('main', { imapPort: srv.port, smtpPort: 1 }) })
        const flagsOf = (uid) => [...srv.state.folders.INBOX.messages.find((m) => m.uid === uid).flags]
        let r = doc(await d.execute({ verb: 'mark', uids: 1, seen: true }))
        eq('mark: seen=true result', [r.uids, r.count], [1, 1])
        eq('mark: fake gained \\Seen', flagsOf(1), ['\\Seen'])
        r = doc(await d.execute({ verb: 'mark', uids: 1, seen: false }))
        eq('mark: seen=false clears \\Seen', flagsOf(1), [])
        r = doc(await d.execute({ verb: 'mark', uids: [1, 3], flagged: true }))
        eq('mark: uid list result counts entries', [r.uids, r.count], [2, 2])
        eq('mark: both fakes gained \\Flagged', [flagsOf(1), flagsOf(3)], [['\\Flagged'], ['\\Flagged']])
        r = doc(await d.execute({ verb: 'mark', uids: 1, seen: true, flagged: false }))
        eq('mark: seen and flagged combine', flagsOf(1), ['\\Seen'])
        const bad = doc(await d.execute({ verb: 'mark', uids: 1 }))
        ok('mark: neither flag is a local error without code', bad && bad.ok === false && !('code' in bad), bad)
      })(),
  )
}

// ---------------------------------------------------------------------------
// 9. save_part: part resolution, default dir, duplicate suffix, streaming
// ---------------------------------------------------------------------------
{
  const scratch = (() => {
    try {
      return mkdtempSync(path.join(os.tmpdir(), 'dsh-email-selftest-'))
    } catch {
      const d = path.join(PKG, '.selftest-tmp')
      rmSync(d, { recursive: true, force: true })
      mkdirSync(d, { recursive: true })
      return d
    }
  })()
  const originalCwd = process.cwd()
  process.chdir(scratch)
  try {
    await withServer(
      () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, subscribed: ['INBOX'] }),
      (srv) =>
        (async () => {
          const d = makeDriver({ ...envOne('main', { imapPort: srv.port, smtpPort: 1 }) })
          const dir = path.join(scratch, 'parts')

          let r = doc(await d.execute({ verb: 'save_part', uid: 1, part: 1 }))
          eq('save_part: default directory target', [r.path, r.filename, r.bytes], [path.join(scratch, DEFAULT_SAVE_DIR, 'report.bin'), 'report.bin', 257])
          ok('save_part: default-directory file bytes are the CTE-decoded body', readFileSync(path.join(scratch, DEFAULT_SAVE_DIR, 'report.bin')).equals(Buffer.from(REPORT_BODY, 'latin1')))

          r = doc(await d.execute({ verb: 'save_part', uid: 1, part: 0, path: dir + '/' }))
          eq('save_part: text part by index to an explicit directory', [r.path, r.bytes, r.filename], [path.join(dir, '1.txt'), 15, '1.txt'])
          ok('save_part: text part saved under the synthesized name', r && r.path.startsWith(dir + path.sep), r)

          r = doc(await d.execute({ verb: 'save_part', uid: 3, part: 1, path: dir + '/' }))
          eq('save_part: 70000-byte part streams to the explicit directory', [r.bytes, r.filename], [70000, 'data.bin'])
          const big = readFileSync(path.join(dir, 'data.bin'))
          ok('save_part: streamed bytes match the original body', big.equals(Buffer.from(BIG_BODY, 'latin1')))
          eq('save_part: chunked transfer lands the full body (size check)', big.length, 70000)

          r = doc(await d.execute({ verb: 'save_part', uid: 5, part: 0, path: dir + '/' }))
          eq('save_part: first duplicate name takes the plain name', [r.path, r.filename], [path.join(dir, 'dup.txt'), 'dup.txt'])
          r = doc(await d.execute({ verb: 'save_part', uid: 5, part: 1, path: dir + '/' }))
          eq('save_part: second duplicate takes a suffix', [r.path, r.filename], [path.join(dir, 'dup-1.txt'), 'dup-1.txt'])
          r = doc(await d.execute({ verb: 'save_part', uid: 5, part: 'dup.txt' }))
          ok('save_part: ambiguous filename lists the candidates', r && r.ok === false && !('code' in r) && /0/.test(r.error) && /1/.test(r.error), r)
          r = doc(await d.execute({ verb: 'save_part', uid: 5, part: 7 }))
          ok('save_part: out-of-range index is a local error', r && r.ok === false && !('code' in r), r)
          r = doc(await d.execute({ verb: 'save_part', uid: 5 }))
          ok('save_part: missing part is a local error', r && r.ok === false && !('code' in r), r)

          ok('sanitize unit: only the base name survives, invalid characters become underscores', sanitizeFilename('../x/evil?name:1.bin') === 'evil_name_1.bin', sanitizeFilename('../x/evil?name:1.bin'))
        })(),
    )
  } finally {
    process.chdir(originalCwd)
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 10. read-body limit boundaries (dedicated account, limit 100)
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: boundaryMessages() } }, subscribed: ['INBOX'] }),
    (srv) =>
      (async () => {
        const d = makeDriver({ ...envOne('trunc', { imapPort: srv.port, smtpPort: 1 }), EMAIL_READ_BODY_LIMIT: '100' })
        eq('limit: config carries the global bound', d.cfg.readBodyLimit, 100)
        let r = doc(await d.execute({ verb: 'read', uid: 1 }))
        eq('limit: 99-char body is not truncated', [r.body.truncated, r.body.totalLength, r.body.text.length], [false, 99, 99])
        r = doc(await d.execute({ verb: 'read', uid: 2 }))
        eq('limit: 100-char body sits exactly at the bound', [r.body.truncated, r.body.totalLength, r.body.text.length], [false, 100, 100])
        r = doc(await d.execute({ verb: 'read', uid: 3 }))
        eq('limit: 101-char body truncates to the bound', [r.body.truncated, r.body.totalLength, r.body.text.length], [true, 101, 100])
      })(),
  )
}

// ---------------------------------------------------------------------------
// 11. folders verb
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() }, Sent: { messages: [] } }, subscribed: ['INBOX'] }),
    (srv) =>
      (async () => {
        const d = makeDriver({ ...envOne('main', { imapPort: srv.port, smtpPort: 1 }) })
        const r = doc(await d.execute({ verb: 'folders' }))
        eq('folders: sorted with subscription state', r.folders, [
          { name: 'INBOX', subscribed: true },
          { name: 'Sent', subscribed: false },
        ])
      })(),
  )
}

// ---------------------------------------------------------------------------
// 12. send: envelope, MIME shape, APPEND source identity
// ---------------------------------------------------------------------------
{
  const attachFile = path.join(os.tmpdir(), `dsh-email-selftest-attach-${process.pid}.bin`)
  writeFileSync(attachFile, Buffer.from('attach-payload', 'latin1'))
  try {
    await withServer(
      () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
      (smtp) =>
        withServer(
          () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] }, Sent: { messages: [] } }, subscribed: ['INBOX'] }),
          (imap) =>
            (async () => {
              const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: smtp.port, fromName: 'Agent', sentFolder: 'Sent' }) })

              // text-only send
              let r = doc(await d.execute({ verb: 'send', to: 'eve@example.com', subject: 'Hello', text: 'Send body one.' }))
              ok('send: text-only result carries a message id', r && typeof r.messageId === 'string' && r.messageId.endsWith('@example.com>'), r)
              let conn = lastConn(smtp.state)
              eq('send: SMTP auth user and envelope', [conn.authUser, conn.from, conn.rcpts], ['agent', 'agent@example.com', ['eve@example.com']])
              let src = conn.data.toString('latin1')
              ok('send: display name in the From header, bare address on the wire', /From: Agent <agent@example\.com>/.test(src), src.split('\r\n')[0])
              ok('send: text-only MIME shape', /Content-Type: text\/plain; charset=utf-8/.test(src) && /Send body one\./.test(src) && /MIME-Version: 1\.0/.test(src), undefined)
              ok('send: no Bcc header in the source', !/Bcc:/m.test(src))
              eq('send: APPEND mirrors the wire source byte-identically', [imap.state.appended.length, imap.state.appended[0].folder, imap.state.appended[0].source.equals(conn.data)], [1, 'Sent', true])
              ok('send: appended message carries \\Seen', imap.state.appended[0].flags.includes('\\Seen'), imap.state.appended[0].flags)

              // multipart/alternative (text + html)
              r = doc(await d.execute({ verb: 'send', to: 'eve@example.com', subject: 'Both', text: 'plain side', html: '<p>html side</p>' }))
              ok('send: text+html accepted', r && typeof r.messageId === 'string', r)
              conn = lastConn(smtp.state)
              src = conn.data.toString('latin1')
              ok('send: multipart/alternative shape', /Content-Type: multipart\/alternative/.test(src) && /plain side/.test(src) && /<p>html side<\/p>/.test(src), undefined)

              // attachment + cc + bcc
              r = doc(await d.execute({ verb: 'send', to: 'eve@example.com', cc: 'carol@example.com', bcc: 'dan@example.com', subject: 'Attached', text: 'with file', attachments: [attachFile] }))
              ok('send: attachment accepted', r && typeof r.messageId === 'string', r)
              conn = lastConn(smtp.state)
              eq('send: envelope rcpts include cc and bcc', conn.rcpts, ['eve@example.com', 'carol@example.com', 'dan@example.com'])
              src = conn.data.toString('latin1')
              ok('send: multipart/mixed with an attachment part', /Content-Type: multipart\/mixed/.test(src) && /Content-Disposition: attachment/.test(src) && new RegExp(`filename="?dsh-email-selftest-attach-${process.pid}\\.bin"?`).test(src), undefined)
              ok('send: attachment content is the base64 of the file bytes', src.replace(/\r?\n/g, '').includes(Buffer.from('attach-payload').toString('base64')), undefined)
              ok('send: bcc absent from the headers', !/Bcc:/m.test(src))
              eq('send: APPEND of the attached message is byte-identical to the wire source', imap.state.appended.at(-1).source.equals(lastConn(smtp.state).data), true)

              // local validation without a code
              const noTo = doc(await d.execute({ verb: 'send', text: 'x' }))
              ok('send: missing to is a local error without code', noTo && noTo.ok === false && !('code' in noTo), noTo)
              const noBody = doc(await d.execute({ verb: 'send', to: 'eve@example.com' }))
              ok('send: empty message is a local error without code', noBody && noBody.ok === false && !('code' in noBody), noBody)
              const missing = doc(await d.execute({ verb: 'send', to: 'eve@example.com', text: 'x', attachments: ['/nonexistent/selftest-file'] }))
              ok('send: missing attachment file is a local error', missing && missing.ok === false && !('code' in missing) && /attachment not found/.test(missing.error), missing)
            })(),
        ),
    )
  } finally {
    try {
      rmSync(attachFile, { force: true })
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// 13. reply: threading headers, quoting, reply-all minus own address
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, subscribed: ['INBOX'] }),
        (imap) =>
          (async () => {
            const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: smtp.port }) })
            const src = () => lastConn(smtp.state).data.toString('latin1')

            let r = doc(await d.execute({ verb: 'reply', uid: 2 }))
            ok('reply: default targets the sender only', r && typeof r.messageId === 'string', r)
            let s = src()
            ok('reply: To is the original sender', /To: two@example\.com/.test(s) && !/bob@example\.com/.test(s), undefined)
            ok('reply: In-Reply-To points at the original', /In-Reply-To: <m2@example\.com>/.test(s), undefined)
            ok('reply: References extends the original chain', /References: <m1@example\.com> <m2@example\.com>/.test(s), undefined)
            ok('reply: subject gets the Re: prefix', /Subject: Re: Second message/.test(s), undefined)
            ok('reply: quote of the first text body', /> Body two, seen\./.test(s), undefined)

            r = doc(await d.execute({ verb: 'reply', uid: 2, reply_all: true }))
            ok('reply_all: accepted', r && typeof r.messageId === 'string', r)
            s = src()
            ok('reply_all: sender plus cc, own address excluded', /To: two@example\.com, bob@example\.com/.test(s) && !/To: .*agent@example\.com/.test(s), undefined)

            r = doc(await d.execute({ verb: 'reply', uid: 2, subject: 'Custom subject', text: 'custom note', quote: false }))
            ok('reply: explicit subject and text win', r && typeof r.messageId === 'string', r)
            s = src()
            ok('reply: custom subject and no quote', /Subject: Custom subject/.test(s) && /custom note/.test(s) && !/> Body two/.test(s), undefined)

            r = doc(await d.execute({ verb: 'reply', uid: 1 }))
            ok('reply: Re: prefix is added for an unprefixed original', /Subject: Re: First message/.test(src()), undefined)
            const s2 = src()
            const noPref = await withServer(
              () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN'] }),
              (smtp2) =>
                withServer(
                  () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: boundaryMessages() } }, subscribed: ['INBOX'] }),
                  (imap2) =>
                    (async () => {
                      const d2 = makeDriver({ ...envOne('trunc', { imapPort: imap2.port, smtpPort: smtp2.port }) })
                      await d2.execute({ verb: 'reply', uid: 1 })
                      const s3 = lastConn(smtp2.state).data.toString('latin1')
                      ok('reply: an already-prefixed subject is not double-prefixed', /Subject: Re: b99/.test(s3) && !/Re: Re:/.test(s3), undefined)
                    })(),
                ),
            )
            void noPref
            void s2

            const bad = doc(await d.execute({ verb: 'reply', uid: 2, quote: false }))
            ok('reply: disabled quote without text is a local error', bad && bad.ok === false && !('code' in bad), bad)
            void imap
          })(),
      ),
  )
}

// ---------------------------------------------------------------------------
// 14. forward: prefix handling, include_original (quote + re-attached parts)
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, subscribed: ['INBOX'] }),
        (imap) =>
          (async () => {
            const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: smtp.port }) })
            const src = () => lastConn(smtp.state).data.toString('latin1')

            let r = doc(await d.execute({ verb: 'forward', uid: 1, to: 'carol@example.com' }))
            ok('forward: default includes the original', r && typeof r.messageId === 'string', r)
            let s = src()
            ok('forward: Fwd: subject prefix', /Subject: Fwd: First message/.test(s), undefined)
            ok('forward: no In-Reply-To on a forward', !/In-Reply-To:/.test(s), undefined)
            ok('forward: References carries the original id', /References: <m1@example\.com>/.test(s), undefined)
            ok('forward: quoted original text body', /> Hello body one\./.test(s), undefined)
            ok('forward: original attachment re-attached', /Content-Disposition: attachment/.test(s) && /filename="?report\.bin"?/.test(s), undefined)
            ok('forward: re-attached payload is the original bytes', s.replace(/\r?\n/g, '').includes(Buffer.from(REPORT_BODY, 'latin1').toString('base64')), undefined)

            r = doc(await d.execute({ verb: 'forward', uid: 1, to: 'carol@example.com', include_original: false, text: 'forwarded note' }))
            ok('forward: explicit text without the original', r && typeof r.messageId === 'string', r)
            s = src()
            ok('forward: include_original=false drops quote and attachments', /forwarded note/.test(s) && !/> Hello/.test(s) && !/Content-Disposition: attachment/.test(s), undefined)

            r = doc(await d.execute({ verb: 'forward', uid: 4, to: 'carol@example.com', include_original: false }))
            ok('forward: nothing to forward is a local error', r && r.ok === false && !('code' in r), r)
            void imap
          })(),
      ),
  )
}

// ---------------------------------------------------------------------------
// 15. STARTTLS branches end to end (IMAP in-place upgrade + SMTP re-EHLO)
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startSmtpServer({ mode: 'starttls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'starttls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, subscribed: ['INBOX'] }),
        (imap) =>
          (async () => {
            const d = makeDriver({ ...envOne('tlsx', { imapPort: imap.port, smtpPort: smtp.port, imapTls: 'starttls', smtpTls: 'starttls' }) })

            let r = doc(await d.execute({ verb: 'folders' }))
            eq('starttls: folders after the in-place IMAP upgrade', r.folders.map((f) => f.name), ['INBOX'])
            r = doc(await d.execute({ verb: 'list_unseen', limit: 10 }))
            eq('starttls: list over the upgraded connection', r.messages.map((m) => m.uid), [5, 4, 3, 1])
            r = doc(await d.execute({ verb: 'read', uid: 1 }))
            eq('starttls: read over the upgraded connection', [r.body.kind, r.body.text], ['text', 'Hello body one.'])
            ok('starttls: the IMAP wire shows the upgrade and post-upgrade traffic', (() => {
              const c = imap.state.commands
              const i = c.findIndex((x) => x === 'STARTTLS')
              return i > 0 && c.some((x) => x.startsWith('LOGIN ') && c.indexOf(x) > i)
            })(), undefined)

            r = doc(await d.execute({ verb: 'send', to: 'eve@example.com', subject: 'Over STARTTLS', text: 'upgraded send' }))
            ok('starttls: send over the upgraded SMTP connection', r && typeof r.messageId === 'string', r)
            const conn = lastConn(smtp.state)
            eq('starttls: smtp auth user after the re-EHLO', conn.authUser, 'agent')
            ok('starttls: the SMTP wire shows STARTTLS before auth', conn.rawCommands.findIndex((x) => x === 'STARTTLS') >= 0 && conn.rawCommands.findIndex((x) => x.startsWith('AUTH')) > conn.rawCommands.findIndex((x) => x === 'STARTTLS'), undefined)
          })(),
      ),
  )
}

// ---------------------------------------------------------------------------
// 15b. the none mode: full plaintext, no TLS and no STARTTLS ever, even when
// the server advertises STARTTLS (explicit operator opt-in)
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startSmtpServer({ mode: 'starttls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'starttls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } } }),
        (imap) =>
          (async () => {
            const d = makeDriver({ ...envOne('plain', { imapPort: imap.port, smtpPort: smtp.port, imapTls: 'none', smtpTls: 'none' }) })

            let r = doc(await d.execute({ verb: 'folders' }))
            eq('none: folders over a plaintext IMAP session (STARTTLS advertised but never used)', r.folders.map((f) => f.name), ['INBOX'])
            r = doc(await d.execute({ verb: 'list_unseen', limit: 10 }))
            eq('none: list over the plaintext IMAP session', r.messages.map((m) => m.uid), [5, 4, 3, 1])
            eq('none: the IMAP wire shows no STARTTLS at all', imap.state.commands.filter((x) => x === 'STARTTLS').length, 0)

            r = doc(await d.execute({ verb: 'send', to: 'eve@example.com', subject: 'Plaintext', text: 'no tls send' }))
            ok('none: send over a plaintext SMTP session (STARTTLS advertised but ignored)', r && typeof r.messageId === 'string', r)
            const conn = lastConn(smtp.state)
            eq('none: the SMTP wire shows no STARTTLS at all', conn.rawCommands.filter((x) => x === 'STARTTLS').length, 0)
          })(),
      ),
  )
  await withServer(
    () => startSmtpServer({ mode: 'starttls', starttlsAdvertised: false, users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'starttls-none', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } } }),
        (imap) =>
          (async () => {
            const d = makeDriver({ ...envOne('plain', { imapPort: imap.port, smtpPort: smtp.port, imapTls: 'none', smtpTls: 'none' }) })
            const r = doc(await d.execute({ verb: 'folders' }))
            eq('none: folders over a server without STARTTLS support', r.folders.map((f) => f.name), ['INBOX'])
            const rs = doc(await d.execute({ verb: 'send', to: 'eve@example.com', subject: 'Plaintext two', text: 'no tls send two' }))
            ok('none: send over a server without STARTTLS support', rs && typeof rs.messageId === 'string', rs)
          })(),
      ),
  )
}

// ---------------------------------------------------------------------------
// 15c. verify verb: a zero-side-effect live check of every configured account
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, subscribed: ['INBOX'] }),
        (imap) =>
          (async () => {
            const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: smtp.port }) })
            const r = doc(await d.execute({ verb: 'verify' }))
            eq('verify: both channels green on every configured account', r, {
              accounts: [{ name: 'main', ok: true, imap: { ok: true }, smtp: { ok: true } }],
            })
            ok('verify: the success doc carries no call-level ok field', r && !('ok' in r))
            const conn = lastConn(smtp.state)
            ok('verify: the SMTP side authenticated', conn && conn.authUser === 'agent')
            eq('verify: the SMTP side delivered nothing (envelope and data empty)', [conn.from, conn.rcpts, conn.data], [null, [], null])
            eq(
              'verify: the IMAP side logged in but touched no mailbox',
              [imapCmd(imap.state, 'SELECT').length, imapCmd(imap.state, 'STORE').length, imapCmd(imap.state, 'APPEND').length, imapCmd(imap.state, 'LOGIN').length >= 1],
              [0, 0, 0, true],
            )
            const r2 = doc(await d.execute({ verb: 'verify', account: 'nonexistent' }))
            eq('verify: the account parameter is ignored (every configured account is reported)', r2 && r2.accounts.map((a) => a.name), ['main'])
          })(),
      ),
  )
  await withServer(
    () => startSmtpServer({ mode: 'starttls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'starttls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, subscribed: ['INBOX'] }),
        (imap) =>
          (async () => {
            const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: smtp.port, imapTls: 'starttls', smtpTls: 'starttls' }) })
            const r = doc(await d.execute({ verb: 'verify' }))
            eq('verify: starttls mode upgrades both channels and authenticates', r, {
              accounts: [{ name: 'main', ok: true, imap: { ok: true }, smtp: { ok: true } }],
            })
            ok(
              'verify: the IMAP wire shows a STARTTLS upgrade before the login',
              imap.state.commands.includes('STARTTLS') && imapCmd(imap.state, 'LOGIN').length >= 1,
            )
            const conn = lastConn(smtp.state)
            ok('verify: the SMTP wire shows a STARTTLS upgrade', conn && conn.rawCommands.some((x) => x.startsWith('STARTTLS')))
            ok('verify: the starttls run still delivered nothing', conn && conn.from === null && conn.rcpts.length === 0 && conn.data === null)
          })(),
      ),
  )
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'tls', users: { agent: 'other' }, folders: { INBOX: { messages: [] } } }),
        (imap) =>
          (async () => {
            const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: smtp.port }) })
            const r = doc(await d.execute({ verb: 'verify' }))
            const row = r && r.accounts[0]
            ok('verify: an IMAP credential failure is code auth, channel-local', row && row.ok === false && row.imap.ok === false && row.imap.code === 'auth', row)
            ok('verify: the SMTP channel stays green and isolated', row && row.smtp.ok === true)
            ok(
              'verify: the failure output leaks no credential',
              row && !String(row.imap.error).includes('secret') && !String(row.smtp.error ?? '').includes('secret'),
            )
            const conn = lastConn(smtp.state)
            ok(
              'verify: the green SMTP channel authenticated with zero delivery',
              conn && conn.authUser === 'agent' && conn.from === null && conn.rcpts.length === 0 && conn.data === null,
            )
          })(),
      ),
  )
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'other' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } } }),
        (imap) =>
          (async () => {
            const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: smtp.port }) })
            const r = doc(await d.execute({ verb: 'verify' }))
            const row = r && r.accounts[0]
            ok('verify: an SMTP credential failure is code auth, channel-local', row && row.ok === false && row.smtp.ok === false && row.smtp.code === 'auth', row)
            ok('verify: the IMAP channel stays green and isolated', row && row.imap.ok === true)
            ok('verify: the SMTP failure text leaks no credential', row && !String(row.smtp.error).includes('secret'))
            eq('verify: the green IMAP side logged in only', imapCmd(imap.state, 'SELECT').length, 0)
          })(),
      ),
  )
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      (async () => {
        const d = makeDriver({ ...envOne('main', { imapPort: 1, smtpPort: smtp.port }) })
        const r = doc(await d.execute({ verb: 'verify' }))
        const row = r && r.accounts[0]
        ok('verify: an unreachable IMAP endpoint is code network', row && row.ok === false && row.imap.code === 'network', row)
        ok('verify: the SMTP channel is unaffected by the IMAP failure', row && row.smtp.ok === true)
      })(),
  )
  {
    const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } } })
    try {
      const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: 1 }) })
      const r = doc(await d.execute({ verb: 'verify' }))
      const row = r && r.accounts[0]
      ok('verify: an unreachable SMTP endpoint is code network', row && row.ok === false && row.smtp.code === 'network', row)
      ok('verify: the IMAP channel is unaffected by the SMTP failure', row && row.imap.ok === true)
    } finally {
      await imap.stop()
    }
  }
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      (async () => {
        const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } } })
        try {
          const d = makeDriver({ ...envOne('strict', { imapPort: imap.port, smtpPort: smtp.port, imapInsecure: false, smtpInsecure: false }) })
          const r = doc(await d.execute({ verb: 'verify' }))
          const row = r && r.accounts[0]
          ok(
            'verify: strict certificate validation fails both channels as tls',
            row && row.ok === false && row.imap.code === 'tls' && row.smtp.code === 'tls',
            row,
          )
        } finally {
          await imap.stop()
        }
      })(),
  )
  await withServer(
    () => startSmtpServer({ mode: 'starttls', starttlsAdvertised: false, users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      (async () => {
        const imap = await startImapServer({ mode: 'starttls-none', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } } })
        try {
          const d = makeDriver({ ...envOne('plain', { imapPort: imap.port, smtpPort: smtp.port, imapTls: 'starttls', smtpTls: 'starttls' }) })
          const r = doc(await d.execute({ verb: 'verify' }))
          const row = r && r.accounts[0]
          ok(
            'verify: a mandatory STARTTLS endpoint without it fails both channels as tls (never a plaintext downgrade)',
            row && row.ok === false && row.imap.code === 'tls' && row.smtp.code === 'tls',
            row,
          )
        } finally {
          await imap.stop()
        }
      })(),
  )
  {
    const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } }, inject: { hangGreeting: true } })
    const smtp = await startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] })
    try {
      const d = makeDriver({ ...envOne('slow', { imapPort: imap.port, smtpPort: smtp.port, timeout: 400 }) })
      const r = doc(await d.execute({ verb: 'verify' }))
      const row = r && r.accounts[0]
      ok('verify: a silent IMAP greeting is code timeout', row && row.ok === false && row.imap.code === 'timeout', row)
      ok('verify: the SMTP channel completes under its own budget while the IMAP channel hangs', row && row.smtp.ok === true)
    } finally {
      await imap.stop()
      await smtp.stop()
    }
  }
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN', 'LOGIN'] }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } }, subscribed: ['INBOX'] }),
        (imap) =>
          (async () => {
            const d = makeDriver({
              ...envOne('good', { imapPort: imap.port, smtpPort: smtp.port }),
              ...envOne('broken', { imapPort: 1, smtpPort: smtp.port }),
            })
            const r = doc(await d.execute({ verb: 'verify' }))
            const by = (n) => r && r.accounts.find((a) => a.name === n)
            eq('verify: every configured account is reported, bad and good together', r && r.accounts.map((a) => a.name).sort(), ['broken', 'good'])
            ok('verify: the good account is fully green', by('good') && by('good').ok === true && by('good').imap.ok === true && by('good').smtp.ok === true, by('good'))
            const broken = by('broken')
            ok(
              'verify: the broken account reports its IMAP failure without masking the green SMTP channel',
              broken && broken.ok === false && broken.imap.code === 'network' && broken.smtp.ok === true,
              broken,
            )
          })(),
      ),
  )
  {
    const d = makeDriver({})
    const r = doc(await d.execute({ verb: 'verify' }))
    eq('verify: zero configured accounts is a legitimate empty result set', r, { accounts: [] })
    ok('verify: the empty result carries no call-level ok field', r && !('ok' in r))
  }
}

// ---------------------------------------------------------------------------
// 16. error-code vocabulary: tls / auth / network / timeout / protocol / server
// ---------------------------------------------------------------------------
{
  // strict TLS (env default) rejects the fake self-signed certificate
  const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } } })
  try {
    const d = makeDriver({ ...envOne('strict', { imapPort: imap.port, smtpPort: 1, imapInsecure: false, smtpInsecure: false }) })
    const r = doc(await d.execute({ verb: 'folders' }))
    ok('error: strict TLS rejects the self-signed certificate (code tls)', r && r.ok === false && r.code === 'tls', r)
    const net = makeDriver({ ...envOne('net', { imapPort: 1, smtpPort: 1 }) })
    const rn = doc(await net.execute({ verb: 'folders' }))
    ok('error: unreachable port is code network', rn && rn.ok === false && rn.code === 'network', rn)
    const bad = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: 1, pass: 'wrong' }) })
    const ra = doc(await bad.execute({ verb: 'folders' }))
    ok('error: rejected credentials are code auth', ra && ra.ok === false && ra.code === 'auth', ra)
  } finally {
    await imap.stop()
  }
}
{
  const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } }, inject: { hangGreeting: true } })
  try {
    const d = makeDriver({ ...envOne('slow', { imapPort: imap.port, smtpPort: 1, timeout: 400 }) })
    const r = doc(await d.execute({ verb: 'folders' }))
    ok('error: a silent greeting exceeds the budget (code timeout)', r && r.ok === false && r.code === 'timeout', r)
  } finally {
    await imap.stop()
  }
}
{
  const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } }, inject: { failCommand: { EXAMINE: { status: 'NO', text: 'no such mailbox: Archive' } } } })
  try {
    const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: 1 }) })
    const r = doc(await d.execute({ verb: 'list', folder: 'Archive' }))
    ok('error: a NO rejection is code server with the raw text', r && r.ok === false && r.code === 'server' && /no such mailbox: Archive/.test(r.error), r)
  } finally {
    await imap.stop()
  }
}
{
  const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } }, inject: { failCommand: { EXAMINE: { status: 'BAD', text: 'syntax error: malformed EXAMINE' } } } })
  try {
    const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: 1 }) })
    const r = doc(await d.execute({ verb: 'list', folder: 'INBOX' }))
    ok('error: a BAD rejection is code protocol', r && r.ok === false && r.code === 'protocol', r)
  } finally {
    await imap.stop()
  }
}
{
  const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } } })
  try {
    const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: 1 }) })
    const r = doc(await d.execute({ verb: 'list', folder: 'NoSuch' }))
    ok('error: a missing mailbox is code server', r && r.ok === false && r.code === 'server', r)
  } finally {
    await imap.stop()
  }
}
{
  const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, inject: { failCommand: { SEARCH: { status: 'NO', text: 'search unsupported here' } } } })
  try {
    const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: 1 }) })
    const r = doc(await d.execute({ verb: 'search', from: 'one@example.com' }))
    ok('error: a NO search rejection is code server', r && r.ok === false && r.code === 'server', r)
  } finally {
    await imap.stop()
  }
}
{
  // SMTP: a 5xx DATA refusal is code server; a protocol error is code protocol
  const smtp = await startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN'], inject: { dataReject: true } })
  const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } } })
  try {
    const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: smtp.port }) })
    const r = doc(await d.execute({ verb: 'send', to: 'eve@example.com', text: 'x' }))
    ok('error: a 5xx DATA refusal is code server with the response text', r && r.ok === false && r.code === 'server' && /552/.test(r.error), r)
  } finally {
    await smtp.stop()
    await imap.stop()
  }
}
{
  const smtp = await startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN'], inject: { protocolError: true } })
  const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } } })
  try {
    const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: smtp.port }) })
    const r = doc(await d.execute({ verb: 'send', to: 'eve@example.com', text: 'x' }))
    ok('error: an SMTP protocol error is code protocol', r && r.ok === false && r.code === 'protocol', r)
  } finally {
    await smtp.stop()
    await imap.stop()
  }
}
{
  // partial success: send lands, the SENT_FOLDER append is refused
  const smtp = await startSmtpServer({ mode: 'tls', users: { agent: 'secret' }, authOrder: ['PLAIN'] })
  const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] }, Sent: { messages: [] } }, inject: { appendLimit: 100 } })
  try {
    const d = makeDriver({ ...envOne('main', { imapPort: imap.port, smtpPort: smtp.port, sentFolder: 'Sent' }) })
    const r = doc(await d.execute({ verb: 'send', to: 'eve@example.com', subject: 'Big', text: 'a'.repeat(5000) }))
    ok('error: partial success keeps the send ok and reports the append error', r && typeof r.messageId === 'string' && r.append && r.append.ok === undefined && /exceeds the account limit/.test(r.append.error ?? ''), r)
    ok('error: a failed retry carries no created flag', r && r.append && r.append.created === undefined, r)
    ok('error: the existing-folder CREATE attempt left no new mailbox', imap.state.created.length === 0, imap.state.created)
  } finally {
    await smtp.stop()
    await imap.stop()
  }
}

// ---------------------------------------------------------------------------
// 17. tool error surface: schema boundary vs local errors
// ---------------------------------------------------------------------------
{
  const d = makeDriver({ ...envOne('main', { imapPort: 1, smtpPort: 1 }) })
  const tryExec = async (args) => {
    try {
      return { out: await d.execute(args) }
    } catch (e) {
      return { err: e }
    }
  }
  let r = await tryExec({})
  ok('surface: a missing verb is rejected by the schema before execute', r.err instanceof ToolArgsError && /verb/.test(String(r.err.message)), r.err && String(r.err.message))
  r = await tryExec({ verb: 'bogus' })
  ok('surface: an unknown verb is rejected by the schema enum', r.err instanceof ToolArgsError && /one of/.test(String(r.err.message)), r.err && String(r.err.message))
  r = await tryExec({ verb: 'list', limit: 'x' })
  ok('surface: a non-integer limit is a schema violation', r.err instanceof ToolArgsError, undefined)
  r = await tryExec({ verb: 'list', seen: 'bogus' })
  ok('surface: a non-boolean flag filter is a schema violation', r.err instanceof ToolArgsError, undefined)
  r = await tryExec({ verb: 'read' })
  const readOut = doc(r.out)
  ok('surface: a missing uid is a local error without a code', readOut && readOut.ok === false && !('code' in readOut), r.out)
}

// ---------------------------------------------------------------------------
// 18. plugin assembly + skill provider
// ---------------------------------------------------------------------------
{
  const savedEnv = {}
  for (const k of Object.keys(process.env)) if (k.startsWith('EMAIL_')) { savedEnv[k] = process.env[k]; delete process.env[k] }
  try {
    const { ctx, state } = fakeCtx()
    new DshEmailPlugin(ctx, {})
    eq('plugin: static name', DshEmailPlugin.name, 'dsh-email')
    eq('plugin: inject set', DshEmailPlugin.inject, ['tools', 'skills', 'systemPrompt'])
    eq('plugin: registered on the context', state.provided, ['dsh-email'])
    eq('plugin: one tool named email', [state.tools.length, state.tools[0].name], [1, 'email'])
    eq('plugin: tool verb enum is the closed set', state.tools[0].parameters.properties?.verb?.enum, [...VERBS])
    eq('plugin: one prompt section', state.sections.length, 1)
    ok('plugin: prompt section is a single line', state.sections[0].text.length > 0 && !state.sections[0].text.includes('\n'), undefined)
    ok('plugin: prompt section names tool and skill', state.sections[0].text.includes('email tool') && state.sections[0].text.includes('dsh-email skill'), undefined)
    eq('plugin: one skill provider', state.providers.length, 1)
    const provider = state.providers[0]()
    eq('plugin: provider name', provider.name, 'dsh-email')
    const [cand] = await provider.list()
    ok('plugin: candidate metadata', cand.name === 'dsh-email' && cand.source === 'bundled' && typeof cand.description === 'string' && cand.description.length > 0 && cand.invocation.modelInvocable === true && cand.invocation.userInvocable === true, cand)
    const got = await provider.get(cand)
    ok('plugin: skill body served', typeof got.content === 'string' && got.content.length > 500, undefined)
    ok('plugin: frontmatter stripped from the body', !got.content.startsWith('---'), undefined)
    ok('plugin: body keeps the verb reference', got.content.includes('verb') && got.content.includes('EMAIL_'), undefined)
  } finally {
    Object.assign(process.env, savedEnv)
  }
}
{
  // the constructor parses the real process env: its warnings mirror parseEnv
  const { ctx, state } = fakeCtx()
  new DshEmailPlugin(ctx, {})
  let want = 0
  parseEnv(process.env, () => { want += 1 })
  eq('plugin: boot warnings mirror parseEnv of the real env', state.warns.length, want)
}

// ---------------------------------------------------------------------------
// 19. mandatory STARTTLS: a plaintext endpoint without STARTTLS fails as tls
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'starttls-none', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } } }),
    (srv) =>
      (async () => {
        const d = makeDriver(envOne('plain', { imapPort: srv.port, smtpPort: 1, imapTls: 'starttls' }))
        const out = doc(await d.execute({ verb: 'folders' }))
        ok('starttls: an IMAP server without STARTTLS is code tls', out && out.ok === false && out.code === 'tls' && /does not support STARTTLS/i.test(out.error), out)
      })(),
  )
  await withServer(
    () => startSmtpServer({ mode: 'starttls', users: { agent: 'secret' }, starttlsAdvertised: false }),
    (smtp) =>
      (async () => {
        const d = makeDriver(envOne('plain', { imapPort: 1, smtpPort: smtp.port, smtpTls: 'starttls' }))
        const out = doc(await d.execute({ verb: 'send', to: 'eve@example.com', text: 'over starttls' }))
        ok('starttls: an SMTP server without advertised STARTTLS is code tls', out && out.ok === false && out.code === 'tls', out)
      })(),
  )
}

// ---------------------------------------------------------------------------
// 20. charset delivery: known non-UTF-8 parts arrive transcoded, unknown
//     charsets arrive as stored bytes
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: charsetMessages() } } }),
    (srv) =>
      (async () => {
        const d = makeDriver(envOne('main', { imapPort: srv.port, smtpPort: 1 }))
        let r = doc(await d.execute({ verb: 'read', uid: 1 }))
        eq('charset: a windows-1252 text part reads back transcoded', [r.body.kind, r.body.text], ['text', 'Žošté'])
        r = doc(await d.execute({ verb: 'read', uid: 2 }))
        eq('charset: an iso-8859-1 html part reads back transcoded', [r.body.kind, r.body.text], ['html', 'café'])
        r = doc(await d.execute({ verb: 'read', uid: 3 }))
        eq('charset: an unknown charset arrives as stored bytes (utf-8 fallback)', r.body.text, 'caf\uFFFD')
        const dest = path.join(os.tmpdir(), `dsh-email-selftest-cs-${process.pid}-${Date.now()}.txt`)
        r = doc(await d.execute({ verb: 'save_part', uid: 1, part: 0, path: dest }))
        ok('charset: save_part reports the explicit destination', r && r.path === dest, r)
        eq('charset: the saved part holds the transcoded bytes', readFileSync(dest, 'utf8'), 'Žošté')
        try {
          rmSync(dest)
        } catch {
          // already absent
        }
      })(),
  )
}

// ---------------------------------------------------------------------------
// 21. the list_unseen predicate versus an explicit seen: true is a local error
// (a per-flag boolean cannot contradict itself, so this is the only remaining
// flag-filter conflict the caller must reject)
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } } }),
    (srv) =>
      (async () => {
        const d = makeDriver(envOne('main', { imapPort: srv.port, smtpPort: 1 }))
        const searchLine = () => srv.state.commands.filter((c) => c.startsWith('UID SEARCH ')).at(-1)
        let out = doc(await d.execute({ verb: 'list_unseen', seen: true }))
        ok('flag filters: seen: true inside list_unseen is a local error without code', out && out.ok === false && !('code' in out) && /list_unseen/.test(out.error) && /seen/.test(out.error), out)
        out = doc(await d.execute({ verb: 'list_unseen', seen: false }))
        eq('flag filters: the implicit predicate accepts the same state', out.messages.map((m) => m.uid), [5, 4, 3, 1])
        out = doc(await d.execute({ verb: 'list_unseen', flagged: true }))
        eq('flag filters: the other flag ANDs with the implicit predicate', out.messages.map((m) => m.uid), [4])
        out = doc(await d.execute({ verb: 'list', seen: true }))
        eq('flag filters: seen: true is plain on list (no implicit predicate)', out.messages.map((m) => m.uid), [2])
        eq('flag filters: seen: true wire line', searchLine(), 'UID SEARCH SEEN')
      })(),
  )
}

// ---------------------------------------------------------------------------
// 22. stable paging when the date order is not the uid order
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: invertedMessages() } } }),
    (srv) =>
      (async () => {
        const d = makeDriver(envOne('main', { imapPort: srv.port, smtpPort: 1 }))
        let r = doc(await d.execute({ verb: 'list', limit: 3 }))
        eq('paging: page one is the date-descending head', r.messages.map((m) => m.uid), [3, 1, 6])
        eq('paging: total counts the whole match set', r.total, 6)
        r = doc(await d.execute({ verb: 'list', limit: 3, page: 1 }))
        eq('paging: page two keeps the stable tie order', r.messages.map((m) => m.uid), [5, 2, 4])
        r = doc(await d.execute({ verb: 'search', since: '2026-10-03' }))
        eq('paging: a search window is date-ordered too', r.messages.map((m) => m.uid), [3, 1, 6, 5, 2])
      })(),
  )
}

// ---------------------------------------------------------------------------
// 23. command rejections classify on the IMAP status token
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, inject: { failCommand: { STORE: { status: 'NO', text: 'no such store' } } } }),
    (srv) =>
      (async () => {
        const d = makeDriver(envOne('main', { imapPort: srv.port, smtpPort: 1 }))
        const out = doc(await d.execute({ verb: 'mark', uids: [2], seen: true }))
        ok('rejection: a NO STORE is code server with the raw text', out && out.ok === false && out.code === 'server' && /no such store/.test(out.error), out)
      })(),
  )
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, inject: { failCommand: { STORE: { status: 'BAD', text: 'syntax error: malformed STORE' } } } }),
    (srv) =>
      (async () => {
        const d = makeDriver(envOne('main', { imapPort: srv.port, smtpPort: 1 }))
        const out = doc(await d.execute({ verb: 'mark', uids: [2], seen: true }))
        ok('rejection: a BAD STORE is code protocol with the raw text', out && out.ok === false && out.code === 'protocol' && /malformed STORE/.test(out.error), out)
      })(),
  )
}

// ---------------------------------------------------------------------------
// 24. one deadline covers the whole call, connect included
// ---------------------------------------------------------------------------
{
  const imap = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } }, inject: { greetingDelayMs: 900, hangAfterAuth: true } })
  try {
    const d = makeDriver(envOne('slow', { imapPort: imap.port, smtpPort: 1, timeout: 1000 }))
    const t0 = Date.now()
    const r = doc(await d.execute({ verb: 'list' }))
    const elapsed = Date.now() - t0
    ok('deadline: the budget trips on the silent command (code timeout)', r && r.ok === false && r.code === 'timeout', r)
    ok('deadline: the whole call stops at the budget, not budget plus budget', elapsed >= 1000 && elapsed < 1750, elapsed)
  } finally {
    await imap.stop()
  }
}

// ---------------------------------------------------------------------------
// 25. one connection per call, multi-step verbs included
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' } }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } } }),
        (imap) =>
          (async () => {
            const d = makeDriver(envOne('main', { imapPort: imap.port, smtpPort: smtp.port }))
            const before = imap.state.connections.length
            const tmp = path.join(os.tmpdir(), `dsh-email-selftest-one-${process.pid}.bin`)
            const r = doc(await d.execute({ verb: 'save_part', uid: 1, part: 1, path: tmp }))
            ok('session: save_part succeeds', r && r.bytes === REPORT_BODY.length, r)
            eq('session: save_part opens exactly one connection', imap.state.connections.length, before + 1)
            try {
              rmSync(tmp)
            } catch {
              // already absent
            }
            const before2 = imap.state.connections.length
            const f = doc(await d.execute({ verb: 'forward', uid: 1, to: 'eve@example.com', text: 'fwd body' }))
            ok('session: forward re-attaches over one session', f && typeof f.messageId === 'string', f)
            eq('session: forward opens exactly one more connection', imap.state.connections.length, before2 + 1)
            const src = lastConn(smtp.state).data.toString('latin1')
            ok('session: the forwarded message carries the re-attached part', /filename="?report\.bin"?/.test(src) && src.replace(/\r?\n/g, '').includes(Buffer.from(REPORT_BODY, 'latin1').toString('base64')), undefined)
          })(),
      ),
  )
}

// ---------------------------------------------------------------------------
// 26. a missing Message-ID leaves no threading headers behind
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' } }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: noMessageIdMessages() } } }),
        (imap) =>
          (async () => {
            const d = makeDriver(envOne('main', { imapPort: imap.port, smtpPort: smtp.port }))
            let r = doc(await d.execute({ verb: 'reply', uid: 1, text: 'reply body' }))
            ok('nomid: a reply to a message without a Message-ID is delivered', r && typeof r.messageId === 'string', r)
            let src = lastConn(smtp.state).data
            ok('nomid: the reply carries neither In-Reply-To nor References', !/In-Reply-To:/mi.test(src) && !/References:/mi.test(src), undefined)
            r = doc(await d.execute({ verb: 'forward', uid: 1, to: 'eve@example.com', text: 'fwd body' }))
            ok('nomid: a forward of a message without a Message-ID is delivered', r && typeof r.messageId === 'string', r)
            src = lastConn(smtp.state).data
            ok('nomid: the forward carries no threading headers', !/In-Reply-To:/mi.test(src) && !/References:/mi.test(src), undefined)
          })(),
      ),
  )
}

// ---------------------------------------------------------------------------
// 27. save_part destinations, a search to-list, sent-folder auto-create default
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' } }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } } }),
        (imap) =>
          (async () => {
            const d = makeDriver(envOne('main', { imapPort: imap.port, smtpPort: smtp.port, sentFolder: 'Ghost' }))
            const explicit = path.join(os.tmpdir(), `dsh-email-selftest-sp-${process.pid}.bin`)
            let r = doc(await d.execute({ verb: 'save_part', uid: 1, part: 'report.bin', path: explicit }))
            ok('save_part: an explicit file path is used as-is', r && r.path === explicit && r.bytes === REPORT_BODY.length, r)
            ok('save_part: the explicit file holds the part bytes', readFileSync(explicit, 'latin1') === REPORT_BODY, undefined)
            try {
              rmSync(explicit)
            } catch {
              // already absent
            }
            r = doc(await d.execute({ verb: 'save_part', uid: 1, part: 'nope.bin' }))
            ok('save_part: an unknown filename is a local error listing the real ones', r && r.ok === false && !('code' in r) && /nope\.bin/.test(r.error) && /report\.bin/.test(r.error), r)
            const out = doc(await d.execute({ verb: 'search', to: ['eve@example.com'] }))
            ok('search: a to list is a local error', out && out.ok === false && !('code' in out) && /single address/.test(out.error), out)
            // Default behavior (autocreate on): the missing Ghost folder is
            // created on first use and the retry of the APPEND succeeds.
            const sent = doc(await d.execute({ verb: 'send', to: 'eve@example.com', text: 'append was missing at first' }))
            ok('autocreate: a missing sent folder is created on first use', sent && typeof sent.messageId === 'string' && sent.append && sent.append.ok === true && sent.append.created === true, sent)
            ok('autocreate: the SMTP delivery happened first', lastConn(smtp.state).data.includes('append was missing at first'), undefined)
            eq('autocreate: exactly one CREATE was issued', [String(imap.state.created.length), ...imap.state.created], ['1', 'Ghost'])
            ok('autocreate: the retried APPEND landed in the created folder', imap.state.appended.length === 1 && imap.state.appended[0].folder === 'Ghost', imap.state.appended)
            ok('autocreate: the appended copy carries \\Seen', imap.state.appended[0].flags.includes('\\Seen'), imap.state.appended[0].flags)
          })(),
      ),
  )
}

// ---------------------------------------------------------------------------
// 28. sent-folder auto-create matrix (switch off, INBOX guard, race, limit)
// ---------------------------------------------------------------------------
{
  await withServer(
    () => startSmtpServer({ mode: 'tls', users: { agent: 'secret' } }),
    (smtp) =>
      withServer(
        () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } } }),
        (imap) =>
          (async () => {
            const stopExtra = async (srv) => {
              await srv.stop()
            }

            // Switch off: a missing folder is a plain copy failure, no CREATE.
            const off = makeDriver(envOne('off', { imapPort: imap.port, smtpPort: smtp.port, sentFolder: 'Ghost', sentFolderAutocreate: false }))
            let r = doc(await off.execute({ verb: 'send', to: 'eve@example.com', text: 'autocreate off' }))
            ok('autocreate off: a missing folder is never created', r && typeof r.messageId === 'string' && r.append && /no such folder: Ghost/.test(r.append.error ?? ''), r)
            ok('autocreate off: the copy failure stays a partial success', r && r.append && r.append.ok === undefined, r)
            eq('autocreate off: no CREATE was issued', imap.state.created.length, 0)
            eq('autocreate off: nothing was appended', imap.state.appended.length, 0)

            // INBOX guard: even with autocreate enabled, the reserved folder
            // name is never CREATEd, whatever the copy failure says.
            const imapGuard = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] } }, inject: { failCommand: { APPEND: { status: 'NO', text: 'append refused here' } } } })
            const guard = makeDriver(envOne('guard', { imapPort: imapGuard.port, smtpPort: smtp.port, sentFolder: 'INBOX' }))
            r = doc(await guard.execute({ verb: 'send', to: 'eve@example.com', text: 'inbox guard' }))
            ok('autocreate guard: an INBOX copy failure is reported as-is', r && typeof r.messageId === 'string' && r.append && /append refused here/.test(r.append.error ?? ''), r)
            eq('autocreate guard: INBOX was never CREATEd', imapGuard.state.created.length, 0)
            await stopExtra(imapGuard)

            // Race: the first APPEND fails, the CREATE answers "Mailbox
            // exists" (a concurrent creator won), the retry succeeds.
            const imapRace = await startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: [] }, Sent: { messages: [] } }, inject: { appendFailFirst: true } })
            const race = makeDriver(envOne('race', { imapPort: imapRace.port, smtpPort: smtp.port, sentFolder: 'Sent' }))
            r = doc(await race.execute({ verb: 'send', to: 'eve@example.com', text: 'race retry' }))
            ok('race: a transient first failure is healed by the retry', r && typeof r.messageId === 'string' && r.append && r.append.ok === true && r.append.created === false, r)
            eq('race: no new folder was created', imapRace.state.created.length, 0)
            ok('race: the retried APPEND landed in Sent', imapRace.state.appended.length === 1 && imapRace.state.appended[0].folder === 'Sent', imapRace.state.appended)
            await stopExtra(imapRace)
          })(),
      ),
  )
}

// ---------------------------------------------------------------------------
// 28b. mailbox management: create_folder / delete_folder / move / delete
// ---------------------------------------------------------------------------
{
  const warns = []
  const on = parseEnv({ ...envOne('main', { imapPort: 993, smtpPort: 587, allowDelete: true }) }, (m) => warns.push(m))
  eq('allowDelete: the boolean word is parsed', [on.accounts[0].allowDelete, warns], [true, []])
  const off = parseEnv(envOne('main', { imapPort: 993, smtpPort: 587 }), () => {})
  eq('allowDelete: absent key defaults to false (fail-closed)', off.accounts[0].allowDelete, false)
  const dropWarns = []
  const dropped = parseEnv({ ...envOne('main', { imapPort: 993, smtpPort: 587 }), EMAIL_main_ALLOW_DELETE: 'maybe' }, (m) => dropWarns.push(m))
  eq('allowDelete: an invalid word drops the account', dropped.accounts.length, 0)
  ok('allowDelete: the drop warning names the field', dropWarns.length === 1 && dropWarns[0].includes('ALLOW_DELETE'), dropWarns)
}
{
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: inboxMessages() } } }),
    (srv) =>
      (async () => {
        const deny = makeDriver(envOne('main', { imapPort: srv.port, smtpPort: 1 }))
        const grant = makeDriver({ ...envOne('main', { imapPort: srv.port, smtpPort: 1 }), EMAIL_main_ALLOW_DELETE: 'true' })

        const acc = doc(await grant.execute({ verb: 'accounts' }))
        ok('accounts: allowDelete is presented per account', acc && acc.accounts[0].allowDelete === true, acc)
        const accDeny = doc(await deny.execute({ verb: 'accounts' }))
        ok('accounts: the default presentation is false', accDeny && accDeny.accounts[0].allowDelete === false, accDeny)

        // --- create_folder ---
        let r = doc(await deny.execute({ verb: 'create_folder', folder: 'Archive' }))
        ok('create_folder: a new mailbox is created', r && r.created === true && r.folder === 'Archive', r)
        eq('create_folder: exactly one CREATE on the wire', srv.state.created.length, 1)
        ok('create_folder: the wire is a plain CREATE', imapCmd(srv.state, 'CREATE').some((c) => c.startsWith('CREATE Archive')), srv.state.commands)
        const createsAfterFirst = imapCmd(srv.state, 'CREATE').length
        r = doc(await deny.execute({ verb: 'create_folder', folder: 'Archive' }))
        ok('create_folder: an existing mailbox is idempotent', r && r.created === false, r)
        eq('create_folder: the repeat issues no CREATE (pre-check)', imapCmd(srv.state, 'CREATE').length, createsAfterFirst)
        eq('create_folder: the repeat created nothing new', srv.state.created.length, 1)
        r = doc(await deny.execute({ verb: 'create_folder', folder: 'INBOX' }))
        ok('create_folder: INBOX is a reserved-name local error', r && r.ok === false && !('code' in r) && /INBOX/.test(r.error), r)
        r = doc(await deny.execute({ verb: 'create_folder' }))
        ok('create_folder: a missing folder is a local error', r && r.ok === false && !('code' in r) && /folder is required/.test(r.error), r)

        // --- move ---
        r = doc(await deny.execute({ verb: 'move', folder: 'INBOX', dest: 'Missing', uids: [1] }))
        ok('move: a missing destination is a local error', r && r.ok === false && !('code' in r) && /does not exist/.test(r.error), r)
        eq('move: a missing destination issues no COPY', srv.state.copied.length, 0)
        r = doc(await deny.execute({ verb: 'move', folder: 'INBOX', dest: 'inbox', uids: [1] }))
        ok('move: dest identical to the source (case-insensitive) is a local error', r && r.ok === false && !('code' in r) && /differ/.test(r.error), r)
        r = doc(await deny.execute({ verb: 'move', folder: 'INBOX', uids: [1] }))
        ok('move: a missing dest is a local error', r && r.ok === false && !('code' in r) && /dest is required/.test(r.error), r)

        r = doc(await deny.execute({ verb: 'move', folder: 'INBOX', dest: 'Archive', uids: [1, 3] }))
        ok('move: the full copy-then-expunge sequence succeeds', r && r.deleted === true && r.uids === 2 && r.from === 'INBOX' && r.to === 'Archive', r)
        eq('move: the copy landed in the destination', srv.state.copied.map((c) => [c.folder, c.dest, ...c.uids]), [['INBOX', 'Archive', 1, 3]])
        eq('move: the source expunge named exactly the moved uids', srv.state.expunged.map((c) => [c.folder, ...c.uids]), [['INBOX', 1, 3]])
        eq('move: the source lost exactly the moved uids', srv.state.folders.INBOX.messages.map((m) => m.uid).sort((a, b) => a - b), [2, 4, 5])
        eq('move: the destination holds the two copies', srv.state.folders.Archive.messages.length, 2)
        ok(
          'move: the wire is copy, delete-flag, uid-scoped expunge',
          imapCmd(srv.state, 'UID COPY').some((c) => /UID COPY .+Archive/.test(c)) &&
            imapCmd(srv.state, 'UID STORE').some((c) => c.startsWith('UID STORE 1,3 +FLAGS')) &&
            imapCmd(srv.state, 'UID EXPUNGE').some((c) => c.startsWith('UID EXPUNGE 1,3')),
          srv.state.commands,
        )

        // a uid-scoped expunge must never sweep an unrelated \Deleted message
        const m4 = srv.state.folders.INBOX.messages.find((m) => m.uid === 4)
        m4.flags.add('\\Deleted')
        r = doc(await deny.execute({ verb: 'move', folder: 'INBOX', dest: 'Archive', uids: [2] }))
        ok('move: a later move still succeeds', r && r.deleted === true, r)
        const m4After = srv.state.folders.INBOX.messages.find((m) => m.uid === 4)
        ok('move: the unrelated \\Deleted message stays in the source', m4After !== undefined && m4After.flags.has('\\Deleted'), m4After && [...m4After.flags])

        // partial success: the copy is ok, the source-side expunge is rejected
        const srvPartial = await startImapServer({
          mode: 'tls',
          users: { agent: 'secret' },
          folders: { INBOX: { messages: inboxMessages() }, Archive: { messages: [] } },
          inject: { failCommand: { EXPUNGE: { status: 'NO', text: 'expunge frozen' } } },
        })
        const dPartial = makeDriver(envOne('main', { imapPort: srvPartial.port, smtpPort: 1 }))
        r = doc(await dPartial.execute({ verb: 'move', folder: 'INBOX', dest: 'Archive', uids: [1] }))
        ok('move: a failed source deletion is a partial success, not an error', r && r.ok !== false && r.deleted === false && /duplicat/.test(r.note ?? ''), r)
        ok('move: the copy happened before the failure', srvPartial.state.copied.length === 1 && srvPartial.state.copied[0].dest === 'Archive', srvPartial.state.copied)
        eq('move: nothing was expunged', srvPartial.state.expunged.length, 0)
        await srvPartial.stop()

        // a failed copy: nothing is expunged, the failure is classified
        const srvCopyFail = await startImapServer({
          mode: 'tls',
          users: { agent: 'secret' },
          folders: { INBOX: { messages: inboxMessages() }, Archive: { messages: [] } },
          inject: { failCommand: { COPY: { status: 'NO', text: 'copy frozen' } } },
        })
        const dCopyFail = makeDriver(envOne('main', { imapPort: srvCopyFail.port, smtpPort: 1 }))
        r = doc(await dCopyFail.execute({ verb: 'move', folder: 'INBOX', dest: 'Archive', uids: [1] }))
        ok('move: a failed copy is a server-classified error', r && r.ok === false && r.code === 'server' && /copy frozen/.test(r.error), r)
        eq('move: no expunge follows a failed copy', srvCopyFail.state.expunged.length, 0)
        await srvCopyFail.stop()

        // --- delete (the destructive verbs are gated) ---
        r = doc(await deny.execute({ verb: 'delete', folder: 'INBOX', uids: [1] }))
        ok('delete: without the grant it is a local error stating the fact', r && r.ok === false && !('code' in r) && r.error === 'delete is not allowed on account "main"', r)
        r = doc(await deny.execute({ verb: 'delete_folder', folder: 'Archive' }))
        ok('delete_folder: without the grant it is a local error stating the fact', r && r.ok === false && !('code' in r) && r.error === 'delete_folder is not allowed on account "main"', r)
        eq('delete: the gated calls touched nothing', [srv.state.expunged.length, srv.state.deletedMailboxes.length], [2, 0])

        // granted delete: the uid-scoped expunge removes exactly the named uids
        r = doc(await grant.execute({ verb: 'delete', folder: 'INBOX', uids: [5] }))
        ok('delete: with the grant the uid-scoped expunge runs', r && r.folder === 'INBOX' && r.uids === 1, r)
        eq('delete: exactly the named uid left the folder', srv.state.folders.INBOX.messages.map((m) => m.uid).sort((a, b) => a - b), [4])
        ok('delete: the unrelated \\Deleted message survives a uid-scoped delete', srv.state.folders.INBOX.messages.find((m) => m.uid === 4) !== undefined, undefined)
        ok(
          'delete: the wire is delete-flag then uid-scoped expunge',
          imapCmd(srv.state, 'UID STORE').some((c) => c.startsWith('UID STORE 5 +FLAGS')) && imapCmd(srv.state, 'UID EXPUNGE').some((c) => c === 'UID EXPUNGE 5'),
          srv.state.commands,
        )

        // a server refusal of the expunge passes through classified
        const srvDelFail = await startImapServer({
          mode: 'tls',
          users: { agent: 'secret' },
          folders: { INBOX: { messages: inboxMessages() } },
          inject: { failCommand: { EXPUNGE: { status: 'NO', text: 'expunge frozen' } } },
        })
        const dDelFail = makeDriver({ ...envOne('main', { imapPort: srvDelFail.port, smtpPort: 1 }), EMAIL_main_ALLOW_DELETE: 'true' })
        r = doc(await dDelFail.execute({ verb: 'delete', folder: 'INBOX', uids: [1] }))
        ok('delete: a server refusal is a classified error', r && r.ok === false && r.code === 'server' && /expunge frozen/.test(r.error), r)
        await srvDelFail.stop()

        // --- delete_folder ---
        r = doc(await grant.execute({ verb: 'delete_folder', folder: 'INBOX' }))
        ok('delete_folder: INBOX is reserved even with the grant', r && r.ok === false && !('code' in r) && /INBOX/.test(r.error), r)
        r = doc(await grant.execute({ verb: 'delete_folder' }))
        ok('delete_folder: a missing folder is a local error', r && r.ok === false && !('code' in r) && /folder is required/.test(r.error), r)
        r = doc(await grant.execute({ verb: 'delete_folder', folder: 'Nope' }))
        ok('delete_folder: a missing mailbox is a server error', r && r.ok === false && r.code === 'server' && /no such folder/.test(r.error), r)
        r = doc(await grant.execute({ verb: 'delete_folder', folder: 'Archive' }))
        ok('delete_folder: a non-empty mailbox is refused by the server policy', r && r.ok === false && r.code === 'server' && /not empty/.test(r.error), r)
        r = doc(await grant.execute({ verb: 'create_folder', folder: 'Scratch' }))
        ok('delete_folder: setup created an empty mailbox', r && r.created === true, r)
        r = doc(await grant.execute({ verb: 'delete_folder', folder: 'Scratch' }))
        ok('delete_folder: an empty mailbox is deleted', r && r.folder === 'Scratch', r)
        ok('delete_folder: the wire is a plain DELETE', imapCmd(srv.state, 'DELETE').some((c) => c.startsWith('DELETE Scratch')), srv.state.commands)
        ok('delete_folder: the folder map lost the entry', !('Scratch' in srv.state.folders), undefined)
        eq('delete_folder: the deletion is recorded', srv.state.deletedMailboxes, ['Scratch'])
      })(),
  )
}

// ---------------------------------------------------------------------------
// 29. the delivered config layer: schema validation + fold semantics
// ---------------------------------------------------------------------------
{
  // -- the schema: accept matrix (the layer is a camelCase mirror of the env)
  const validate = (x) => DshEmailPlugin.Config['~standard'].validate(x)
  const issues = (x) => (validate(x).issues ?? []).map((i) => i.message)
  const noIssues = (x) => validate(x).issues === undefined

  ok('cfgschema: an empty layer passes', noIssues({}))
  ok('cfgschema: absent layers pass (undefined and null, the env-only behavior)', noIssues(undefined) && noIssues(null))
  ok('cfgschema: the full mirror passes', noIssues({
    defaultAccount: 'default',
    readBodyLimit: 500,
    accounts: {
      default: {
        user: 'agent@example.com', pass: 'secret', imapHost: 'imap.example.com', imapPort: 994,
        imapSecure: 'TLS', imapAllowInsecureTls: true, smtpHost: 'smtp.example.com', smtpPort: 465,
        smtpSecure: 'none', smtpAllowInsecureTls: false, from: 'agent@example.com', fromName: 'Agent',
        sentFolder: 'Sent', sentFolderAutocreate: false, allowDelete: true, timeoutMs: 5000,
      },
      'other-acct': { user: 'eve@example.com', pass: 'pw', imapHost: 'imap2.example.com', smtpHost: 'smtp2.example.com' },
    },
  }))
  ok('cfgschema: a sparse layer passes', noIssues({ accounts: { default: { imapPort: 994 } } }))
  ok('cfgschema: TLS mode words pass case-insensitively (the env contract normalizes case)', noIssues({ accounts: { a: { imapSecure: 'TLS', smtpSecure: 'StartTls' } } }))
  const v = validate({ readBodyLimit: 500, defaultAccount: 'default', accounts: { default: { imapPort: 994 } } })
  ok('cfgschema: the validated value keeps the carried fields verbatim', v.value.readBodyLimit === 500 && v.value.defaultAccount === 'default' && v.value.accounts.default.imapPort === 994 && Object.keys(v.value.accounts).join() === 'default', v.value)

  // -- the schema: reject matrix (each violation fails the entry loudly)
  ok('cfgschema: an unknown root key fails (typo guard)', issues({ bogus: 1 }).some((m) => m.includes('unknown key "bogus"') && m.includes('defaultAccount')))
  ok('cfgschema: an unknown account key fails (the imapport typo)', issues({ accounts: { default: { imapport: 1 } } }).some((m) => m.includes('unknown key "imapport"')))
  eq('cfgschema: port bounds are inclusive 1-65535', issues({ accounts: { default: { imapPort: 0 } } }).length + issues({ accounts: { default: { imapPort: 65536 } } }).length, 2)
  ok('cfgschema: a fractional port fails (the integer step)', issues({ accounts: { default: { imapPort: 993.5 } } }).length === 1)
  ok('cfgschema: a non-numeric port fails', issues({ accounts: { default: { imapPort: '993' } } }).length === 1)
  ok('cfgschema: timeoutMs and readBodyLimit of 0 fail', issues({ accounts: { default: { timeoutMs: 0 } } }).length === 1 && issues({ readBodyLimit: 0 }).length === 1)
  ok('cfgschema: an unknown TLS mode fails', issues({ accounts: { default: { imapSecure: 'auto' } } }).length === 1)
  ok('cfgschema: a non-boolean switch fails', issues({ accounts: { default: { allowDelete: 'maybe' } } }).length === 1)
  ok('cfgschema: an account name outside the charset fails', issues({ accounts: { 'Bad_Name': {} } }).length === 1 && issues({ accounts: { '9x': {} } }).length === 1)
  ok('cfgschema: an account name over 32 characters fails', issues({ accounts: { ['a'.repeat(33)]: {} } }).length === 1)
  ok('cfgschema: a non-object root fails', issues('nope').length === 1)
  ok('cfgschema: a non-object accounts value fails', issues({ accounts: [1] }).length === 1)

  // -- fold semantics: one precedence chain (config value, env value, default)
  const envBase = {
    ...envOne('default', { imapPort: 993, smtpPort: 1, imapInsecure: true, smtpInsecure: true }),
    EMAIL_DEFAULT_TIMEOUT_MS: '123456',
    EMAIL_DEFAULT_SMTP_SECURE: 'starttls',
  }
  const byName = (cfg) => Object.fromEntries(cfg.accounts.map((a) => [a.name, a]))

  let f = foldConfig(envBase, { readBodyLimit: 500, accounts: { default: { imapPort: 994 } } }, () => {})
  eq('fold: the config value beats the env value for the same field', byName(f).default.imap.port, 994)
  eq('fold: the config value beats the env value at the top level', f.readBodyLimit, 500)
  eq('fold: a field the layer omits keeps the env value', byName(f).default.smtp.port, 1)
  eq('fold: a field in neither layer keeps the built-in default', byName(f).default.imap.tls, DEFAULT_IMAP_TLS)
  eq('fold: the env timeout wins over the default', byName(f).default.timeoutMs, 123456)
  eq('fold: the env TLS mode wins over the default', byName(f).default.smtp.tls, 'starttls')

  f = foldConfig(envBase, { accounts: { default: { smtpPort: 465, smtpSecure: 'none', allowDelete: true } } }, () => {})
  eq('fold: a sparse layer changes only the fields it carries', [byName(f).default.smtp.port, byName(f).default.smtp.tls, byName(f).default.allowDelete], [465, 'none', true])
  eq('fold: a sparse layer keeps the untouched IMAP side', byName(f).default.imap.port, 993)

  f = foldConfig(envBase, { accounts: { extra: { user: 'eve@example.com', pass: 'pw', imapHost: 'imap2.example.com', smtpHost: 'smtp2.example.com' } } }, () => {})
  eq('fold: a config-only account joins the env accounts', f.accounts.map((a) => a.name), ['default', 'extra'])
  eq('fold: the config-only account resolves its own defaults', [byName(f).extra.imap.port, byName(f).extra.smtp.port, byName(f).extra.from], [993, 587, 'eve@example.com'])

  const dropWarns = []
  f = foldConfig(envBase, { accounts: { partial: { user: 'eve@example.com', pass: 'pw', imapHost: 'imap2.example.com' } } }, (m) => dropWarns.push(m))
  eq('fold: a config account missing a required field is dropped (the env rule)', f.accounts.map((a) => a.name), ['default'])
  ok('fold: the drop reports through the boot warning channel', dropWarns.some((m) => m.includes('partial') && m.includes('SMTP_HOST')), dropWarns)

  f = foldConfig({ ...envBase, ...envOne('side', { imapPort: 5, smtpPort: 5 }), EMAIL_DEFAULT_ACCOUNT: 'default' }, { defaultAccount: 'side' }, () => {})
  eq('fold: the layer defaultAccount beats the env one (baked into isDefault)', [byName(f).side.isDefault, byName(f).default.isDefault], [true, false])

  f = foldConfig(envBase, { accounts: { default: { from: 'boss@example.com', fromName: 'Boss', sentFolder: 'Archive', sentFolderAutocreate: false } } }, () => {})
  eq('fold: string fields carry through to the parsed config', [byName(f).default.from, byName(f).default.fromName, byName(f).default.sentFolder, byName(f).default.sentFolderAutocreate], ['boss@example.com', 'Boss', 'Archive', false])

  const envCopy = { ...envBase }
  eq('fold: a layer of {} is exactly the env-only parse', JSON.stringify(parseEnv(envBase, () => {})), JSON.stringify(foldConfig(envCopy, {}, () => {})))
  ok('fold: the input env record is not mutated', JSON.stringify(envCopy) === JSON.stringify(envBase))

  // -- wire level: a layer-carried bound behaves exactly like its env
  // counterpart (the two channels are the same expressiveness)
  await withServer(
    () => startImapServer({ mode: 'tls', users: { agent: 'secret' }, folders: { INBOX: { messages: boundaryMessages() } }, subscribed: ['INBOX'] }),
    (srv) =>
      (async () => {
        const cfg = foldConfig(envOne('trunc', { imapPort: srv.port, smtpPort: 1 }), { readBodyLimit: 100 }, () => {})
        eq('layer-limit: the folded config carries the global bound', cfg.readBodyLimit, 100)
        const { ctx, state } = fakeCtx()
        registerTool(ctx, cfg)
        const execute = (args) => Promise.resolve(state.tools[0].execute(args))
        let r = doc(await execute({ verb: 'read', uid: 1 }))
        eq('layer-limit: a 99-char body is not truncated', [r.body.truncated, r.body.totalLength, r.body.text.length], [false, 99, 99])
        r = doc(await execute({ verb: 'read', uid: 3 }))
        eq('layer-limit: a 101-char body truncates at the layer bound', [r.body.truncated, r.body.totalLength, r.body.text.length], [true, 101, 100])
      })(),
  )

  // -- assembly: the constructor folds the delivered layer (real env scrubbed)
  {
    const savedEnv = {}
    for (const k of Object.keys(process.env)) if (k.startsWith('EMAIL_')) { savedEnv[k] = process.env[k]; delete process.env[k] }
    try {
      // The real deployment declares all-caps EMAIL_DEFAULT_* variables; the
      // config layer synthesizes the same casing, so the two layers write the
      // very same variables (no case-variant conflict at the parser).
      const upper = {}
      for (const [k, val] of Object.entries(envOne('default', { imapPort: 993, smtpPort: 1 }))) upper[k.toUpperCase()] = val
      Object.assign(process.env, { ...upper, EMAIL_DEFAULT_ACCOUNT: 'default' })
      const { ctx, state } = fakeCtx()
      new DshEmailPlugin(ctx, { readBodyLimit: 500, accounts: { default: { imapPort: 1234 } } })
      ok('assembly: a valid layer produces no boot warnings', state.warns.length === 0, state.warns)
      const out = doc(await state.tools[0].execute({ verb: 'accounts' }))
      eq('assembly: the folded layer is visible in the accounts verb', [out.default, out.accounts[0].imap.port, out.accounts[0].smtp.port], ['default', 1234, 1])
      ok('assembly: the accounts presentation keeps its shape (no source annotations)', out.accounts.every((a) => Object.keys(a).every((k) => ['name', 'user', 'from', 'imap', 'smtp', 'sentFolder', 'sentFolderAutocreate', 'allowDelete', 'isDefault'].includes(k))), out.accounts)
    } finally {
      for (const k of Object.keys(process.env)) if (k.startsWith('EMAIL_')) delete process.env[k]
      Object.assign(process.env, savedEnv)
    }
  }
}

// ---------------------------------------------------------------------------
// 30. shipped hygiene guards
// ---------------------------------------------------------------------------
{
  for (const f of readdirSync(path.join(PKG, 'src'))) {
    if (!f.endsWith('.ts')) continue
    const src = readFileSync(path.join(PKG, 'src', f), 'utf8')
    ok(`shipped source: src/${f} carries no CJK characters`, !CJK_RE.test(src))
    ok(`shipped source: src/${f} carries no version-round tags`, !/\bv\d{2}\b/.test(src))
    ok(`shipped source: src/${f} carries no calendar dates`, !/20\d{2}-\d{2}-\d{2}/.test(src))
  }
  for (const f of ['README.md', path.join('skill', 'dsh-email', 'SKILL.md'), 'cordis.patch.yml', 'package.json']) {
    const src = readFileSync(path.join(PKG, f), 'utf8')
    ok(`shipped file: ${f} is ASCII-clean`, !CJK_RE.test(src))
  }
}
{
  const skip = new Set(['.git', 'lib', 'node_modules', '.selftest-tmp'])
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (skip.has(e)) continue
      const p = path.join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) ok(`ascii sweep: ${path.relative(PKG, p)} carries no CJK`, !CJK_RE.test(readFileSync(p, 'utf8')))
    }
  }
  walk(PKG)
}
{
  const manifest = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'))
  eq('manifest: name', manifest.name, 'dsh-email')
  eq('manifest: module type', manifest.type, 'module')
  eq('manifest: entry', manifest.main, './lib/index.js')
  ok('manifest: exports point at entry + types', manifest.exports['.'].default === './lib/index.js' && manifest.exports['.'].types === './lib/index.d.ts')
  eq('manifest: runtime dependencies are the two protocol libraries', Object.keys(manifest.dependencies ?? {}).sort(), ['imapflow', 'nodemailer'])
  ok('manifest: peer set', ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/schemastery', 'yaml'].every((p) => p in manifest.peerDependencies))
  eq('manifest: bundle patch pointer', manifest.dsh.bundle.patch, './cordis.patch.yml')
  ok('manifest: bundle patch file present', existsSync(path.join(PKG, 'cordis.patch.yml')))
  ok('manifest: files entries present', manifest.files.every((f) => existsSync(path.join(PKG, f.replace(/\/$/, '')))))
  const patch = readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8')
  ok('manifest: patch registers the plugin id', patch.includes('id: dsh-email') && patch.includes("name: 'dsh-email'"))
  ok('manifest: compiled entry present', existsSync(path.join(PKG, 'lib', 'index.js')))
}
// selftest hygiene guard
{
  const raw = readFileSync(path.join(PKG, 'test', 'selftest.mjs'), 'utf8')
  const testSrc = raw.slice(0, raw.indexOf('// selftest hygiene guard'))
  ok('selftest hygiene: no design-doc section pointers', !/design doc|design v\d|\u00a7\d/.test(testSrc))
  ok('selftest hygiene: no machine-specific paths', !/\/workspace\//.test(testSrc))
  ok('selftest hygiene: no source line-number pointers', !/L\d+[-\u2013\u2014]L?\d+/.test(testSrc))
  ok('selftest hygiene: no review-round wrappers', !/round-?\d+|review #\d/.test(testSrc))
  ok('selftest hygiene: no project version-round tags', !/\bv\d{2}\b/.test(testSrc))
  ok('selftest hygiene: no CJK characters', !CJK_RE.test(testSrc))
  ok('selftest hygiene: no review finding identifiers', !/R\d{1,2}-[A-Za-z]\w*/.test(testSrc))
  ok('selftest hygiene: no version-round identifiers', !/\bv\d{2}[A-Za-z_]\w*/.test(testSrc))
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------
console.log(`dsh-email selftest: ${pass} passed, ${fail} failed`)
for (const f of failures) console.log(`  FAIL: ${f}`)
process.exit(fail > 0 ? 1 : 0)
