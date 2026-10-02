// dsh-email configuration: the EMAIL_* env contract (read once at plugin boot)
// plus the optional config layer the cordis loader delivers to the constructor
// (a patch entry targeting this plugin's id: the same fields, camelCase, as
// explicit values). An account is declared by any EMAIL_<NAME>_<FIELD>
// variable; the account is valid only when the four required fields (USER,
// PASS, IMAP_HOST, SMTP_HOST) are all present and the effective FROM (the FROM
// value, else USER) is a mailbox address (a local part and a domain around an
// @), otherwise it is dropped with a warning (boot never fails). The FROM
// shape is validated at parse time so a bare local name can never reach the
// wire (MAIL FROM, the From header, the Message-ID domain).
// EMAIL_DEFAULT_ACCOUNT is stored raw and resolved at call time, so a stale
// default only fails the calls that rely on it. EMAIL_READ_BODY_LIMIT is the
// single global knob for the read-verb body budget.
// The delivered layer is folded onto a copy of the env record before parsing:
// a delivered field is an explicit value (it beats the env value, which beats
// the built-in default); fields the layer omits resolve as the env contract.
// A config account missing a required field is dropped with a warning, the
// same rule as env. Layer composition (which patch layer wins, no deep merge)
// is cordis semantics: the plugin sees only the one object the loader delivers.
import type { AccountConfig, EmailConfig, TlsEndpoint, TlsMode } from './types.js'

/** Account name charset: lowercase start, 1-32 chars (same convention as dsh-timer job ids). */
export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

/** The per-account field set (a variable whose suffix is not a field is not an account variable). */
const FIELDS = new Set([
  'USER',
  'PASS',
  'IMAP_HOST',
  'IMAP_PORT',
  'IMAP_SECURE',
  'IMAP_ALLOW_INSECURE_TLS',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_ALLOW_INSECURE_TLS',
  'FROM',
  'FROM_NAME',
  'SENT_FOLDER',
  'SENT_FOLDER_AUTOCREATE',
  'ALLOW_DELETE',
  'TIMEOUT_MS',
])

/** The four fields whose absence drops the account. */
const REQUIRED = ['USER', 'PASS', 'IMAP_HOST', 'SMTP_HOST'] as const

/** Matches EMAIL_<NAME>_<FIELD>; the name segment is case-insensitive and
 * normalizes to lowercase, so EMAIL_Main_* and EMAIL_MAIN_* declare the same
 * account (deduped by the uppercased form). The field segment is uppercase. */
const ACCOUNT_VAR_RE = /^EMAIL_([A-Za-z][A-Za-z0-9]*)_([A-Z][A-Z_]*)$/

/** Default IMAP port (the 'tls' mode: implicit TLS). */
export const DEFAULT_IMAP_PORT = 993
/** Default SMTP port (the 'starttls' mode: the 587-class STARTTLS port). */
export const DEFAULT_SMTP_PORT = 587
/** Default IMAP TLS mode (implicit TLS, the majority mail-client default). */
export const DEFAULT_IMAP_TLS: TlsMode = 'tls'
/** Default SMTP TLS mode (STARTTLS, the majority mail-client default). */
export const DEFAULT_SMTP_TLS: TlsMode = 'starttls'
/** Default per-account timeout budget in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000
/** Default read-body budget in characters. */
export const DEFAULT_READ_BODY_LIMIT = 20_000

interface RawAccount {
  name: string
  upper: string
  fields: Record<string, string>
}

/**
 * Parse a boolean-typed env value: true-words (true/1/yes/on) vs false-words
 * (false/0/no/off); anything else is invalid.
 * @param value the raw env string.
 * @returns the boolean, or undefined when the value is not a boolean word.
 */
export function parseBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'on':
      return true
    case 'false':
    case '0':
    case 'no':
    case 'off':
      return false
    default:
      return undefined
  }
}

/**
 * Parse a positive-integer env value within the given bounds.
 * @param value the raw env string.
 * @param min the inclusive lower bound.
 * @param max the inclusive upper bound.
 * @returns the number, or undefined when the value is not an integer in range.
 */
export function parseIntBounded(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined
  const n = Number(value.trim())
  if (!Number.isSafeInteger(n) || n < min || n > max) return undefined
  return n
}

/**
 * Parse the SECURE mode value: 'tls' (implicit TLS), 'starttls' (mandatory
 * STARTTLS upgrade) or 'none' (full plaintext), matched case-insensitively.
 * @param value the raw env string.
 * @returns the mode, or undefined when the value is not a mode word.
 */
export function parseTlsMode(value: string): TlsMode | undefined {
  switch (value.trim().toLowerCase()) {
    case 'none':
    case 'tls':
    case 'starttls':
      return value.trim().toLowerCase() as TlsMode
    default:
      return undefined
  }
}

/**
 * Parse the EMAIL_* env contract.
 * @param env env record (process.env at boot, or a test fixture).
 * @param warn account-drop reporting hook (the plugin init wires it to the logger).
 * @returns the validated account set (sorted by name), the raw default account
 * name, and the read-body budget.
 */
export function parseEnv(env: Record<string, string | undefined>, warn: (msg: string) => void): EmailConfig {
  const raw: RawAccount[] = []
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    const m = ACCOUNT_VAR_RE.exec(key)
    if (!m) continue
    const field = m[2]
    if (!FIELDS.has(field)) continue
    const upper = m[1].toUpperCase()
    let acct = raw.find((r) => r.upper === upper)
    if (!acct) {
      acct = { name: upper.toLowerCase(), upper, fields: {} }
      raw.push(acct)
    }
    if (acct.fields[field] !== undefined && acct.fields[field] !== value) {
      warn(`account "${acct.name}" has conflicting ${key} values; last one wins`)
    }
    acct.fields[field] = value
  }
  raw.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const defaultName = typeof env.EMAIL_DEFAULT_ACCOUNT === 'string' && env.EMAIL_DEFAULT_ACCOUNT.length > 0
    ? env.EMAIL_DEFAULT_ACCOUNT
    : null

  let readBodyLimit = DEFAULT_READ_BODY_LIMIT
  if (env.EMAIL_READ_BODY_LIMIT !== undefined) {
    const n = parseIntBounded(env.EMAIL_READ_BODY_LIMIT, 1, Number.MAX_SAFE_INTEGER)
    if (n === undefined) {
      warn(`EMAIL_READ_BODY_LIMIT "${env.EMAIL_READ_BODY_LIMIT}" is not a positive integer; using the default ${DEFAULT_READ_BODY_LIMIT}`)
    } else {
      readBodyLimit = n
    }
  }

  // Keys that look like account declarations (an account-like name segment
  // plus an uppercase field suffix) but fall outside the variable recognizer
  // (a name segment that is a letter followed by letters and digits only,
  // case-insensitive) are not recognized as account variables; a warning
  // names the offending key so a mistyped variable is visible at boot.
  const GLOBAL_KEYS = new Set(['EMAIL_DEFAULT_ACCOUNT', 'EMAIL_READ_BODY_LIMIT'])
  const ACCOUNT_LIKE_RE = /^EMAIL_([A-Za-z0-9-]+)_[A-Z][A-Z_]*$/
  for (const key of Object.keys(env)) {
    if (GLOBAL_KEYS.has(key) || ACCOUNT_VAR_RE.test(key)) continue
    const m = ACCOUNT_LIKE_RE.exec(key)
    if (!m) continue
    warn(`EMAIL_ variable "${key}" is not recognized as an account declaration: the name segment "${m[1].toLowerCase()}" must be a letter followed by letters and digits only (case-insensitive)`)
  }

  const accounts: AccountConfig[] = []
  for (const e of raw) {
    if (!NAME_RE.test(e.name)) {
      warn(`account "${e.name}" dropped: name outside the charset [a-z][a-z0-9-]{0,31}`)
      continue
    }
    const missing = REQUIRED.filter((f) => e.fields[f] === undefined || e.fields[f].trim() === '')
    if (missing.length > 0) {
      warn(`account "${e.name}" dropped: missing required field(s) ${missing.join(', ')}`)
      continue
    }
    const acc = buildAccount(e, missing.length === 0)
    if ('error' in acc) {
      warn(`account "${e.name}" dropped: ${acc.error}`)
      continue
    }
    const defaultLower = defaultName === null ? null : defaultName.toLowerCase()
    acc.account.isDefault = defaultLower !== null && defaultLower === e.name
    accounts.push(acc.account)
  }
  return { accounts, readBodyLimit }
}

/**
 * One account of the delivered config layer: the camelCase mirror of the
 * per-account env fields. Every key is optional; a key absent here resolves
 * as the env contract (see foldConfig).
 */
export interface DeliveredAccountConfig {
  user?: string
  pass?: string
  imapHost?: string
  imapPort?: number
  imapSecure?: TlsMode
  imapAllowInsecureTls?: boolean
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: TlsMode
  smtpAllowInsecureTls?: boolean
  from?: string
  fromName?: string
  sentFolder?: string
  sentFolderAutocreate?: boolean
  allowDelete?: boolean
  timeoutMs?: number
}

/**
 * The delivered config layer (validated by the plugin's static Config schema
 * before it reaches the constructor). All keys optional; undefined or {} is
 * exactly the env-only behavior.
 */
export interface DeliveredConfig {
  defaultAccount?: string
  readBodyLimit?: number
  accounts?: Record<string, DeliveredAccountConfig>
}

/** camelCase config-layer key -> the env field suffix it maps onto. */
const CONFIG_FIELD_TO_ENV: Record<string, string> = {
  user: 'USER',
  pass: 'PASS',
  imapHost: 'IMAP_HOST',
  imapPort: 'IMAP_PORT',
  imapSecure: 'IMAP_SECURE',
  imapAllowInsecureTls: 'IMAP_ALLOW_INSECURE_TLS',
  smtpHost: 'SMTP_HOST',
  smtpPort: 'SMTP_PORT',
  smtpSecure: 'SMTP_SECURE',
  smtpAllowInsecureTls: 'SMTP_ALLOW_INSECURE_TLS',
  from: 'FROM',
  fromName: 'FROM_NAME',
  sentFolder: 'SENT_FOLDER',
  sentFolderAutocreate: 'SENT_FOLDER_AUTOCREATE',
  allowDelete: 'ALLOW_DELETE',
  timeoutMs: 'TIMEOUT_MS',
}

/**
 * Fold the delivered config layer into the env contract. The layer is
 * materialized as synthetic EMAIL_* variables written over a copy of the env
 * record (so a delivered value beats the env value, which beats the built-in
 * default), and the merged record is parsed by the unchanged env parser, the
 * single authority for validation and defaults. The input env record is not
 * mutated.
 * @param env the raw env record (process.env at boot, or a test fixture).
 * @param config the delivered config layer (undefined or {} = env only).
 * @param warn the drop-reporting hook (config accounts dropped by the
 * required-field rule report through the same channel as env drops).
 * @returns the validated account set (sorted by name), the raw default
 * account name, and the read-body budget.
 */
export function foldConfig(
  env: Record<string, string | undefined>,
  config: DeliveredConfig | undefined,
  warn: (msg: string) => void,
): EmailConfig {
  if (!config) return parseEnv(env, warn)
  const merged: Record<string, string | undefined> = { ...env }
  if (config.defaultAccount !== undefined) merged.EMAIL_DEFAULT_ACCOUNT = config.defaultAccount
  if (config.readBodyLimit !== undefined) merged.EMAIL_READ_BODY_LIMIT = String(config.readBodyLimit)
  for (const [name, fields] of Object.entries(config.accounts ?? {})) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue
      const suffix = CONFIG_FIELD_TO_ENV[key]
      if (suffix === undefined) continue
      merged[`EMAIL_${name.toUpperCase()}_${suffix}`] =
        typeof value === 'boolean' || typeof value === 'number' ? String(value) : value
    }
  }
  return parseEnv(merged, warn)
}

function buildAccount(e: RawAccount, valid: boolean): { account: AccountConfig } | { error: string } {
  if (!valid) return { error: 'incomplete required fields' }
  const f = e.fields
  const imap = buildEndpoint(f, 'IMAP', DEFAULT_IMAP_PORT, DEFAULT_IMAP_TLS)
  if ('error' in imap) return { error: `imap: ${imap.error}` }
  const smtp = buildEndpoint(f, 'SMTP', DEFAULT_SMTP_PORT, DEFAULT_SMTP_TLS)
  if ('error' in smtp) return { error: `smtp: ${smtp.error}` }
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (f.TIMEOUT_MS !== undefined) {
    const n = parseIntBounded(f.TIMEOUT_MS, 1, Number.MAX_SAFE_INTEGER)
    if (n === undefined) return { error: `TIMEOUT_MS "${f.TIMEOUT_MS}" is not a positive integer` }
    timeoutMs = n
  }
  // The effective FROM is the FROM value when set, else USER. It must be a
  // mailbox address (a local part and a domain around an @) so a bare local
  // name can never reach the wire (MAIL FROM, the From header, the
  // Message-ID domain) as a shape the send pipeline would emit as-is.
  const from = f.FROM !== undefined && f.FROM.trim() !== '' ? f.FROM.trim() : f.USER.trim()
  const at = from.indexOf('@')
  if (at <= 0 || at === from.length - 1) {
    return { error: `effective FROM is not a mailbox address (a local part and a domain around "@" are both required)` }
  }
  const account: AccountConfig = {
    name: e.name,
    user: f.USER.trim(),
    pass: f.PASS,
    imap: imap.endpoint,
    smtp: smtp.endpoint,
    from,
    timeoutMs,
    sentFolderAutocreate: true,
    allowDelete: false,
    isDefault: false,
  }
  if (f.FROM_NAME !== undefined && f.FROM_NAME.trim() !== '') account.fromName = f.FROM_NAME.trim()
  if (f.SENT_FOLDER !== undefined && f.SENT_FOLDER.trim() !== '') account.sentFolder = f.SENT_FOLDER.trim()
  if (f.SENT_FOLDER_AUTOCREATE !== undefined) {
    const b = parseBoolean(f.SENT_FOLDER_AUTOCREATE)
    if (b === undefined) {
      return { error: `SENT_FOLDER_AUTOCREATE "${f.SENT_FOLDER_AUTOCREATE}" is not a boolean (true/false)` }
    }
    account.sentFolderAutocreate = b
  }
  // ALLOW_DELETE gates the destructive verbs (delete, delete_folder). It is a
  // fail-closed switch: the default (and the value when the key is absent) is
  // false, so a mailbox is never agent-deletable unless the operator sets it
  // explicitly. Any non-boolean word drops the account (same treatment as
  // SENT_FOLDER_AUTOCREATE).
  if (f.ALLOW_DELETE !== undefined) {
    const b = parseBoolean(f.ALLOW_DELETE)
    if (b === undefined) {
      return { error: `ALLOW_DELETE "${f.ALLOW_DELETE}" is not a boolean (true/false)` }
    }
    account.allowDelete = b
  }
  return { account }
}

function buildEndpoint(f: Record<string, string>, prefix: 'IMAP' | 'SMTP', defaultPort: number, defaultTls: TlsMode): { endpoint: TlsEndpoint } | { error: string } {
  const host = f[`${prefix}_HOST`]
  if (host === undefined || host.trim() === '') return { error: 'missing host' }
  let port = defaultPort
  if (f[`${prefix}_PORT`] !== undefined) {
    const n = parseIntBounded(f[`${prefix}_PORT`], 1, 65535)
    if (n === undefined) return { error: `PORT "${f[`${prefix}_PORT`]}" is not an integer in 1-65535` }
    port = n
  }
  // SECURE is an explicit mode setting (tls / starttls / none), not a boolean
  // switch. The mode is matched case-insensitively; any other value (including
  // a legacy boolean word) drops the account.
  let tls = defaultTls
  if (f[`${prefix}_SECURE`] !== undefined) {
    const m = parseTlsMode(f[`${prefix}_SECURE`])
    if (m === undefined) return { error: `SECURE "${f[`${prefix}_SECURE`]}" is not a TLS mode (none / tls / starttls)` }
    tls = m
  }
  // Operator-facing semantics of the env variable: default false = strict
  // certificate validation; true = explicitly accept untrusted (self-signed /
  // invalid) server certificates. The connection layer maps this to Node's
  // negated rejectUnauthorized (see imap-client / smtp-send).
  let allowInsecure = false
  if (f[`${prefix}_ALLOW_INSECURE_TLS`] !== undefined) {
    const b = parseBoolean(f[`${prefix}_ALLOW_INSECURE_TLS`])
    if (b === undefined) {
      return { error: `ALLOW_INSECURE_TLS "${f[`${prefix}_ALLOW_INSECURE_TLS`]}" is not a boolean (true/false)` }
    }
    allowInsecure = b
  }
  return { endpoint: { host: host.trim(), port, tls, allowInsecure } }
}

/** A successful account resolution. */
export interface Resolved {
  account: AccountConfig
}

/** A failed account resolution (the error text names the valid set). */
export interface ResolutionError {
  error: string
}

/**
 * Resolve the target account through the single rule chain (no dual track):
 * an explicit account name must be in the valid set; otherwise the default
 * account when it is valid; otherwise the sole account when exactly one is
 * configured; otherwise the error.
 * @param cfg the parsed config.
 * @param explicit the explicit account parameter (absent = the rest of the chain).
 * @returns the account or the error text (never throws).
 */
export function resolveAccount(cfg: EmailConfig, explicit: string | undefined): Resolved | ResolutionError {
  if (explicit !== undefined) {
    const hit = cfg.accounts.find((a) => a.name === explicit)
    if (hit) return { account: hit }
    const valid = cfg.accounts.map((a) => a.name).join(', ')
    return { error: `unknown account "${explicit}" (valid accounts: ${valid || 'none'})` }
  }
  if (cfg.accounts.length === 0) {
    return { error: 'no account specified and no mail accounts configured (set EMAIL_<NAME>_USER / _PASS / _IMAP_HOST / _SMTP_HOST)' }
  }
  const defaultName = cfg.accounts.find((a) => a.isDefault)
  if (defaultName) return { account: defaultName }
  if (cfg.accounts.length === 1) return { account: cfg.accounts[0] }
  const valid = cfg.accounts.map((a) => a.name).join(', ')
  return {
    error: `no account specified and no default account configured (valid accounts: ${valid}; set EMAIL_DEFAULT_ACCOUNT or name an account)`,
  }
}
