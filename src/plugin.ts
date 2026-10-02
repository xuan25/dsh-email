// dsh-email: mail access plugin for dsh (IMAP receive + SMTP send).
// Reads and sends mail through the EMAIL_* env contract (multiple accounts,
// optional default account and per-account sent folder). Pure transport: no
// pooling, no idle keep-alive, no state; every verb call opens one fresh
// connection under the account timeout budget. The plugin registers exactly
// three things in the constructor: the email tool (eleven verbs), the bundled
// dsh-email skill, and a one-line system-prompt pointer.
import { Service, type Context } from '@deepseek-ai/cordis'
import { PLUGIN_NAME } from './util.js'
import { parseEnv } from './config.js'
import { registerTool } from './tool.js'
import { registerSkill } from './skill.js'

/**
 * dsh-email plugin (class form).
 * The constructor performs synchronous initialization (logger, env parsing with
 * per-account drop warnings, tool / skill / system-prompt section registration);
 * there is no init lifecycle step because the plugin owns no long-lived effect
 * (the three registrations are framework-tracked effects disposed with the
 * owning fiber).
 * inject = every service the plugin reads: the dsh host services tools / skills /
 * systemPrompt (dsh-tools / dsh-skill / dsh-system-prompt: ctx.tools.register /
 * ctx.skills.registerProvider / ctx.systemPrompt.section). Declaring all three
 * converts a host-missing-the-service failure from a cryptic property error into
 * the clear `cannot get required service "X"`, keeping the declaration consistent
 * with the actual read sites (same convention as dsh-timer). A declared service
 * with no implementation parks the plugin fiber (it never activates, it does not
 * throw).
 * Configuration is env-only (the EMAIL_* contract), so the plugin takes no
 * profile config fields and declares no Config schema.
 */
export class DshEmailPlugin extends Service {
  static name = PLUGIN_NAME
  static readonly inject = ['tools', 'skills', 'systemPrompt']

  constructor(ctx: Context, _config: unknown) {
    super(ctx, PLUGIN_NAME)
    const logger = ctx.logger(PLUGIN_NAME)
    const cfg = parseEnv(process.env, (msg) => logger.warn(msg))
    registerTool(ctx, cfg)
    registerSkill(ctx)
    ctx.systemPrompt.section({
      name: PLUGIN_NAME,
      order: 3000,
      text:
        'Read and send mail through configured IMAP/SMTP accounts with the email tool ' +
        '(accounts/folders/list/list_unseen/search/read/mark/save_part/send/reply/forward verbs); ' +
        'see the dsh-email skill for the verb reference, the EMAIL_* env contract, and limits.',
    })
  }
}

export default DshEmailPlugin
