// dsh-email: mail access plugin for dsh (IMAP receive + SMTP send).
// Reads and sends mail through the EMAIL_* env contract (multiple accounts,
// optional default account and per-account sent folder), plus an optional
// config layer delivered by the cordis loader (a patch entry targeting this
// plugin's id with a `config` object): the delivered fields are validated
// against the static Config schema and folded onto the env record before
// parsing (foldConfig in config.ts). The verb plane is pure transport: no
// pooling, no idle keep-alive, no state; every verb call opens one fresh
// connection under the account timeout budget. The constructor registers
// the email tool (sixteen verbs), the bundled dsh-email skill, and a
// one-line system-prompt pointer; with the v1.9 new-mail trigger it also
// starts one per-account trigger watcher (a resident IMAP connection that
// dispatches a fresh agent session per new mail) as a fiber effect for each
// trigger-enabled account; with the v2.0 session offload it also starts one
// per-minute sweep (a fiber effect, independent of the watchers) that moves
// settled trigger sessions outliving their account's retention window
// (EMAIL_<N>_SESSION_RETENTION, env-only) into the archive under the plugin
// home. The watcher and offload services agents / agentPresets / dshHomePath
// / sessionPersistence / sessions are SOFT reads (ctx.get, never inject): a
// host without them degrades to a visible warning and no watcher / a
// disabled sweep.
import path from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { Service, type Context } from '@deepseek-ai/cordis'
import { OFFLOAD_ARCHIVE_DIR, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE, OFFLOAD_STORE_ROOT, OffloadSweeper, appendRetentionEntry } from './offload.js'
import { PLUGIN_NAME, errMsg } from './util.js'
import { foldConfig, NAME_RE, type DeliveredConfig } from './config.js'
import { registerTool } from './tool.js'
import { registerSkill } from './skill.js'
import { MailWatcher, type RetentionRecord, type RetentionRecorder } from './watch.js'

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
  triggerEnable: 'enable the new-mail trigger watcher for this account (default false)',
  triggerPrompt: 'the policy prompt injected verbatim into each trigger session (required when triggerEnable is true)',
  triggerFolder: 'the folder the trigger watcher listens on (default INBOX)',
  triggerIdleMs: 'the trigger heartbeat resync period in milliseconds (default 600000, lower bound 1000)',
  triggerMaxConcurrent: 'max concurrent trigger sessions on this account (default 1)',
  triggerQueueMax: 'max queued (waiting) new mails before visible overflow; overflow stays UNSEEN (default 100)',
  triggerPreset: 'named agent preset for trigger sessions (default: the deployment default)',
  triggerReasoningEffort:
    'the trigger session reasoning effort, a member of the closed level set off/minimal/low/medium/high/xhigh/max (default: the framework provider default; the framework re-checks the per-model support at first request; an invalid level makes the account trigger malformed - warned, the account stays usable)',
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
    // The eight trigger fields are deliberately unconstrained at the schema
    // layer (Schema.any(), zero constraints): a type declaration here would
    // fail the entry loudly on a config-layer type mismatch at boot, while
    // the runtime validator (parseTriggerFields in config.ts, the single
    // validation point) reports a per-account warning instead and leaves the
    // account fully usable. Non-string values survive the fold as raw values.
    triggerEnable: Schema.any().description(ACCOUNT_FIELDS.triggerEnable),
    triggerPrompt: Schema.any().description(ACCOUNT_FIELDS.triggerPrompt),
    triggerFolder: Schema.any().description(ACCOUNT_FIELDS.triggerFolder),
    triggerIdleMs: Schema.any().description(ACCOUNT_FIELDS.triggerIdleMs),
    triggerMaxConcurrent: Schema.any().description(ACCOUNT_FIELDS.triggerMaxConcurrent),
    triggerQueueMax: Schema.any().description(ACCOUNT_FIELDS.triggerQueueMax),
    triggerPreset: Schema.any().description(ACCOUNT_FIELDS.triggerPreset),
    triggerReasoningEffort: Schema.any().description(ACCOUNT_FIELDS.triggerReasoningEffort),
  }),
  ACCOUNT_CONFIG_LABEL,
)

/**
 * dsh-email plugin (class form).
 * The constructor performs synchronous initialization (logger, resolution of
 * the delivered config layer onto the EMAIL_* env contract with per-account
 * drop warnings, tool / skill / system-prompt section registration); there is
 * no init lifecycle step because every long-lived effect is registered inside
 * the constructor itself: the three registrations are framework-tracked
 * effects, and (v1.9) each trigger-enabled account starts its new-mail
 * trigger watcher through ctx.effect (one effect per account, disposed with
 * the owning fiber: watcher.dispose() runs the synchronous
 * invalidate-then-close order).
 * inject = every service the plugin reads HARD: the dsh host services
 * tools / skills / systemPrompt (dsh-tools / dsh-skill / dsh-system-prompt:
 * ctx.tools.register / ctx.skills.registerProvider / ctx.systemPrompt
 * .section). Declaring all three converts a host-missing-the-service failure
 * from a cryptic property error into the clear `cannot get required service
 * "X"`, keeping the declaration consistent with the actual read sites (same
 * convention as dsh-timer). A declared service with no implementation parks
 * the plugin fiber (it never activates, it does not throw). The trigger
 * watcher's services (agents / agentPresets / dshHomePath) are deliberately
 * NOT declared: they are soft reads (ctx.get), so a host without them degrades
 * to a visible warning and no watcher instead of parking the plugin fiber.
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
    // v2.0: session offload (the retention plane). The shared in-flight set
    // (created-not-settled trigger session ids) is owned by the plugin and
    // handed to every trigger watcher; the per-minute sweeper (one fiber
    // effect, independent of the watchers) moves settled trigger sessions
    // that outlived their account's retention window into the archive under
    // the plugin home. Without the dshHomePath service the layout is
    // unresolvable and the component is disabled with a warning (trigger
    // dispatches are unaffected).
    const inflight = new Set<string>()
    let dshHome: ((p: string) => string) | undefined
    try {
      const h = ctx.get('dshHomePath')
      dshHome = typeof h === 'function' ? (h as (p: string) => string) : undefined
    } catch {
      dshHome = undefined
    }
    if (dshHome === undefined) {
      logger.warn('the dshHomePath service is unreachable; the session offload component is disabled (trigger dispatches are unaffected)')
    } else {
      const homeBase = dshHome(OFFLOAD_HOME_BASE)
      const sweeper = new OffloadSweeper({
        ctx,
        logger,
        home: {
          base: homeBase,
          archive: path.join(homeBase, OFFLOAD_ARCHIVE_DIR),
          log: path.join(homeBase, OFFLOAD_LOG_FILE),
          storeRoot: dshHome(OFFLOAD_STORE_ROOT),
        },
        accounts: new Map(cfg.accounts.map((a) => [a.name, a.sessionRetentionMs])),
        inflight,
        cap: cfg.offloadBatch,
      })
      ctx.effect(
        () => {
          sweeper.start()
          return (): void => {
            sweeper.dispose()
          }
        },
        'dsh-email offload sweep',
      )
    }

    // v1.9: start the per-account new-mail trigger watchers (one fiber
    // effect each). A malformed trigger configuration warns and starts no
    // watcher (the account stays fully usable through every mail verb); an
    // 'on' account on a host without the agents service warns once and
    // starts no watcher either (zero connections, zero sessions).
    const onAccounts = cfg.accounts.filter((a) => a.trigger.kind === 'on')
    let hasAgents = false
    if (onAccounts.length > 0) {
      let agents: unknown
      try {
        agents = ctx.get('agents')
      } catch {
        agents = undefined
      }
      hasAgents = agents !== undefined && agents !== null
      if (!hasAgents) {
        const names = onAccounts.map((a) => `"${a.name}"`).join(', ')
        logger.warn(
          `new-mail trigger is enabled for account(s) ${names} but the host provides no agents service; ` +
            'no watcher was started (the accounts stay fully usable through every mail verb)',
        )
      }
    }
    for (const acct of cfg.accounts) {
      if (acct.trigger.kind === 'malformed') {
        logger.warn(
          `account "${acct.name}": trigger configuration is malformed (${acct.trigger.reason}); ` +
            'no watcher started for this account (all mail verbs are unaffected)',
        )
        continue
      }
      if (acct.trigger.kind !== 'on' || !hasAgents) continue
      const trigger = acct.trigger.config
      // The retention write gate: a recorder is attached only for accounts
      // whose retention window is enabled (non-zero); the sweep is the only
      // other writer of the log. A failed append warns (the session stays
      // dispatched but untracked).
      const retention: RetentionRecorder | undefined =
        dshHome !== undefined && acct.sessionRetentionMs > 0
          ? {
              record: (entry: RetentionRecord): void => {
                void appendRetentionEntry(path.join(dshHome(OFFLOAD_HOME_BASE), OFFLOAD_LOG_FILE), {
                  id: entry.id,
                  createdAt: entry.createdAt,
                  unit: acct.name,
                  ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
                }).catch((err: unknown) => {
                  logger.warn(`account "${acct.name}": the retention log write for session ${entry.id} failed (${errMsg(err)}); the session continues untracked`)
                })
              },
            }
          : undefined
      ctx.effect(
        () => {
          const watcher = new MailWatcher({ ctx, account: acct, trigger, inflight, retention })
          watcher.start()
          return (): void => {
            watcher.dispose()
          }
        },
        `dsh-email trigger ${acct.name}`,
      )
    }
  }
}

export default DshEmailPlugin
