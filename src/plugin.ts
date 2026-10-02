// dsh-email: mail access plugin for dsh (IMAP receive + SMTP send).
// Reads and sends mail through the EMAIL_* env contract (multiple accounts,
// optional default account and per-account sent folder), plus an optional
// config layer delivered by the cordis loader (a patch entry targeting this
// plugin's id with a `config` object): the delivered fields are validated
// against the static Config schema and folded onto the env record before
// parsing (foldConfig in config.ts). Pure transport: no pooling, no idle
// keep-alive, no state; every verb call opens one fresh connection under the
// account timeout budget. The constructor registers exactly three things: the
// email tool (fifteen verbs), the bundled dsh-email skill, and a one-line
// system-prompt pointer.
import Schema from '@deepseek-ai/schemastery'
import { Service, type Context } from '@deepseek-ai/cordis'
import { PLUGIN_NAME } from './util.js'
import { foldConfig, NAME_RE, type DeliveredConfig } from './config.js'
import { registerTool } from './tool.js'
import { registerSkill } from './skill.js'

/** The TLS-mode field: the three mode words, matched case-insensitively (the env contract does the same). */
function tlsModeField(): Schema {
  return Schema.string().pattern(/^(none|tls|starttls)$/i)
}

/** The declared per-account fields (the camelCase mirror of the env fields). */
const ACCOUNT_FIELDS = {
  user: 'the IMAP/SMTP login name (usually the mailbox address); required',
  pass: 'the password or the provider\'s app-specific password; required',
  imapHost: 'the IMAP server host; required',
  imapPort: 'the IMAP port (default 993)',
  imapSecure: 'the IMAP TLS mode: tls / starttls / none (default tls)',
  imapAllowInsecureTls: 'accept untrusted IMAP server certificates (default false)',
  smtpHost: 'the SMTP server host; required',
  smtpPort: 'the SMTP port (default 587)',
  smtpSecure: 'the SMTP TLS mode: tls / starttls / none (default starttls)',
  smtpAllowInsecureTls: 'accept untrusted SMTP server certificates (default false)',
  from: 'the sender address (default = user)',
  fromName: 'the sender display name',
  sentFolder: 'the folder a successful send is also copied into (default: no copy)',
  sentFolderAutocreate: 'create a missing sent folder and retry the copy (default true; INBOX is never created)',
  allowDelete: 'allow the delete / delete_folder verbs on this account (default false)',
  timeoutMs: 'the per-call timeout budget in milliseconds (default 120000)',
} as const

/** The label of the per-account schema in validation messages. */
const ACCOUNT_CONFIG_LABEL = 'an account config of dsh-email'

/**
 * Wrap a schema so any object key beyond the declared set is a validation
 * failure: the framework would otherwise merge unknown keys into the
 * validated output, letting a patch-file typo (imapport instead of imapPort)
 * pass silently. The loader does not forward options into the transform
 * callback, so the error is raised with an empty option set; the message
 * carries the unknown key and the declared set.
 * @param inner the object schema to guard.
 * @param label the label used in the failure message.
 */
function rejectUnknownKeys(inner: Schema, label: string): Schema {
  const declared = inner.dict ? Object.keys(inner.dict) : []
  const declaredSet = new Set(declared)
  return Schema.transform(inner, (value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!declaredSet.has(key)) {
          throw new Schema.ValidationError(
            `unknown key "${key}" in ${label} (known keys: ${declared.join(', ')})`,
            {},
          )
        }
      }
    }
    return value
  })
}

/** One account of the config layer (the camelCase mirror of the env fields). */
const ACCOUNT_CONFIG = rejectUnknownKeys(
  Schema.object({
    user: Schema.string().description(ACCOUNT_FIELDS.user),
    pass: Schema.string().description(ACCOUNT_FIELDS.pass),
    imapHost: Schema.string().description(ACCOUNT_FIELDS.imapHost),
    imapPort: Schema.number().min(1).max(65535).step(1).description(ACCOUNT_FIELDS.imapPort),
    imapSecure: tlsModeField().description(ACCOUNT_FIELDS.imapSecure),
    imapAllowInsecureTls: Schema.boolean().description(ACCOUNT_FIELDS.imapAllowInsecureTls),
    smtpHost: Schema.string().description(ACCOUNT_FIELDS.smtpHost),
    smtpPort: Schema.number().min(1).max(65535).step(1).description(ACCOUNT_FIELDS.smtpPort),
    smtpSecure: tlsModeField().description(ACCOUNT_FIELDS.smtpSecure),
    smtpAllowInsecureTls: Schema.boolean().description(ACCOUNT_FIELDS.smtpAllowInsecureTls),
    from: Schema.string().description(ACCOUNT_FIELDS.from),
    fromName: Schema.string().description(ACCOUNT_FIELDS.fromName),
    sentFolder: Schema.string().description(ACCOUNT_FIELDS.sentFolder),
    sentFolderAutocreate: Schema.boolean().description(ACCOUNT_FIELDS.sentFolderAutocreate),
    allowDelete: Schema.boolean().description(ACCOUNT_FIELDS.allowDelete),
    timeoutMs: Schema.number().min(1).step(1).description(ACCOUNT_FIELDS.timeoutMs),
  }),
  ACCOUNT_CONFIG_LABEL,
)

/**
 * dsh-email plugin (class form).
 * The constructor performs synchronous initialization (logger, resolution of
 * the delivered config layer onto the EMAIL_* env contract with per-account
 * drop warnings, tool / skill / system-prompt section registration); there is
 * no init lifecycle step because the plugin owns no long-lived effect (the
 * three registrations are framework-tracked effects disposed with the owning
 * fiber).
 * inject = every service the plugin reads: the dsh host services tools / skills /
 * systemPrompt (dsh-tools / dsh-skill / dsh-system-prompt: ctx.tools.register /
 * ctx.skills.registerProvider / ctx.systemPrompt.section). Declaring all three
 * converts a host-missing-the-service failure from a cryptic property error into
 * the clear `cannot get required service "X"`, keeping the declaration consistent
 * with the actual read sites (same convention as dsh-timer). A declared service
 * with no implementation parks the plugin fiber (it never activates, it does not
 * throw).
 * The static Config schema validates the delivered config layer before the
 * constructor runs (a violation fails the entry loudly); the constructor folds
 * it onto the env record through the existing parser (foldConfig): a delivered
 * field is an explicit value (config value beats env value beats the built-in
 * default), fields the layer omits resolve as the env contract. Layer
 * composition (which patch layer wins, no deep merge) is cordis semantics; the
 * plugin tracks no provenance.
 */
export class DshEmailPlugin extends Service {
  static name = PLUGIN_NAME
  static readonly inject = ['tools', 'skills', 'systemPrompt']
  /** The config-layer schema (the camelCase mirror of the env fields). */
  static readonly Config = rejectUnknownKeys(
    Schema.object({
      defaultAccount: Schema.string().description('the account used when a call names no account'),
      readBodyLimit: Schema.number().min(1).step(1).description(
        'the read body truncation budget in characters (default 20000)',
      ),
      accounts: Schema.dict(ACCOUNT_CONFIG, Schema.string().pattern(NAME_RE).description('the account name')),
    }),
    'the dsh-email config',
  )

  constructor(ctx: Context, config: DeliveredConfig | undefined) {
    super(ctx, PLUGIN_NAME)
    const logger = ctx.logger(PLUGIN_NAME)
    const cfg = foldConfig(process.env, config, (msg) => logger.warn(msg))
    registerTool(ctx, cfg)
    registerSkill(ctx)
    ctx.systemPrompt.section({
      name: PLUGIN_NAME,
      order: 3000,
      text:
        'Read and send mail through configured IMAP/SMTP accounts with the email tool; ' +
        'see the dsh-email skill for the verb reference, the EMAIL_* env contract, and limits.',
    })
  }
}

export default DshEmailPlugin
