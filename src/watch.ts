// dsh-email new-mail trigger watcher (v1.9): one resident IMAP connection
// per trigger-enabled account (EXAMINE + auto-IDLE) that detects new mail
// through the client-level 'exists' event (untagged EXISTS decoded by the
// always-running socket reader, IDLE or NOOP-poll branch alike) plus a
// periodic UNSEEN resync heartbeat, and dispatches one fresh agent session
// per new UNSEEN message.
//
// Dispatch ports the dsh-timer runner pattern with three declared
// deviations: a host setTimeout bounded create deadline
// (no cordis timer service), ctx.get soft reads for the agents /
// dshHomePath services (no static inject additions), and the
// deployment-default model route (no per-session model knob), and an
// explicit meta.cwd (the harness home's trigger-runs directory, the
// framework's no-cwd default dies before the first LLM call) plus
// meta.agentPreset, mirroring the other in-process session creators. The
// sandbox policy stays the host default; a trigger session is never
// cancelled on watcher dispose (it is detached and settles on its own).
//
// State doctrine: the mailbox UNSEEN flag is the only durable state (zero
// state files); active / queue are in-memory exclusion sets of this single
// instance. A failed dispatch keeps the uid UNSEEN for the next resync
// retry; only a missing EXAMINE folder (mailboxMissing) is terminal.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'

import type { ImapFlow } from 'imapflow'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parse as parseYaml } from 'yaml'

import { buildWatcherConnection } from './imap-client.js'
import type { AccountConfig, Context, Logger, TriggerConfig } from './types.js'
import { errMsg, PLUGIN_NAME } from './util.js'

/** Bounded deadline for the trigger session create call (deviation 1: host setTimeout). */
const CREATE_TIMEOUT_MS = 300_000
/** Reconnect backoff base; doubles per consecutive failure, capped at the max. */
const BACKOFF_BASE_MS = 5_000
/** Reconnect backoff cap. */
const BACKOFF_MAX_MS = 60_000
/**
 * Settings-document namespace holding the deployment's default model selection
 * — the same canonical store the framework's agent-default-model service is
 * built on. The literal mirrors the constant the owning package exports; the
 * package is spelled out locally because it is not a dependency of this plugin.
 */
const DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'

/**
 * Sub-directory of the harness home that hosts the trigger sessions'
 * workspace (meta.cwd). Every other in-process session creator in a
 * deployment (timer jobs, the qqbot session manager) passes an explicit
 * meta.cwd; the framework's no-cwd default has proven broken for
 * in-process plugin dispatches (the first turn dies before any LLM call),
 * so the dispatcher always creates a session with an explicit workspace.
 */
const TRIGGER_WORKSPACE_DIR = 'trigger-runs'

/** The connect / watch lifecycle states of one watcher. */
type WatchState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'terminal' | 'disposed'

/**
 * The timer-owner seam: the production dispatcher tracks its bounded
 * create-deadline host timer on the watcher so watcher dispose cancels it;
 * a timer tracked after dispose is cancelled immediately.
 */
export interface DispatchOwner {
  trackTimer(t: NodeJS.Timeout): void
  untrackTimer(t: NodeJS.Timeout): void
}

/** Everything one trigger session dispatch needs. */
export interface DispatchParams {
  ctx: Context
  logger: Logger
  account: AccountConfig
  trigger: TriggerConfig
  uid: number
  /** The fully rendered three-part prompt (envelope line filled by the watcher). */
  prompt: string
  owner: DispatchOwner
}

/** The dispatch outcome: ok, or a visible failure (the uid stays UNSEEN). */
export type DispatchResult = { ok: true } | { failed: 'create_failed' | 'turn_error'; detail: string }

/** The trigger session factory (test seam: replace with a stub to exercise dispatch state). */
export type CreateSessionFn = (p: DispatchParams) => Promise<DispatchResult>

export interface MailWatcherOptions {
  ctx: Context
  account: AccountConfig
  trigger: TriggerConfig
  /** Test seam: IMAP connection factory (default = buildWatcherConnection). */
  createConnection?: (account: AccountConfig) => ImapFlow
  /** Test seam: trigger session factory (default = the production dispatcher). */
  createSession?: CreateSessionFn
}

/** The live-agent runtime face the dispatcher drives (followup / settle / cancel / snapshot). */
interface LiveAgent {
  followup(message: unknown): unknown
  whenIdle(): Promise<void>
  cancel(opts: { kind: string }): void
  session: { snapshotEvents(): readonly unknown[] }
}

interface TriggerAgentHandle {
  agent: LiveAgent
  dispose(): Promise<void>
}

/** The host's agents service surface (soft read via ctx.get; structural, not a dependency). */
interface AgentsService {
  create(options: {
    sessionId: string
    meta?: Record<string, unknown>
    agentOptions?: { provider?: string; model?: string }
    setup?: (agentCtx: unknown, agent: unknown) => Promise<void>
  }): Promise<TriggerAgentHandle>
}

/** The host's agent preset service surface (structural; dsh-agent-presets is not a dependency). */
interface PresetService {
  /** Deployment default when id is omitted; rejects for an unknown preset id. */
  resolve(id?: string): Promise<{ id: string }>
  /** Like resolve, additionally rejecting a preset that exists but fails composition validation. */
  resolveMountable?(id?: string): Promise<{ id: string }>
  /** Plug the preset's agent-plane composition into the unpublished agent scope (the create's setup hook). */
  mount(agentCtx: unknown, id: string): Promise<void>
}

type TurnEndEvent = {
  type?: unknown
  data?: { reason?: unknown } | null
}

/** Find the most recent turn/end event, scanning from the tail; null when absent. */
function lastTurnEnd(events: readonly unknown[]): TurnEndEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as TurnEndEvent | null
    if (e && e.type === 'turn/end') return e
  }
  return null
}

/** Map a turn/end reason to its kind (string or {reason}/{kind} object). */
function reasonKind(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object') {
    const r = reason as { reason?: unknown; kind?: unknown }
    if (typeof r.reason === 'string') return r.reason
    if (typeof r.kind === 'string') return r.kind
  }
  return 'error'
}

/** The error message carried by an error-kind turn/end reason (when present). */
function turnErrorMessage(reason: unknown): string {
  if (!reason || typeof reason !== 'object') return ''
  const error = (reason as { error?: unknown }).error
  if (!error || typeof error !== 'object') return ''
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

interface DefaultModelSelection {
  provider: string
  model: string
}

/** Validate a candidate default selection: valid only when both fields are non-empty strings. */
function normalizeDefaultSelection(value: unknown): DefaultModelSelection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as { provider?: unknown; model?: unknown }
  if (typeof v.provider !== 'string' || v.provider === '') return undefined
  if (typeof v.model !== 'string' || v.model === '') return undefined
  return { provider: v.provider, model: v.model }
}

/**
 * Read the deployment's default model selection, trying three SOFT sources in
 * order — none of them is a required inject, so a host providing none of
 * them simply has no default route (a route-less session's first turn
 * rejects and the failure is surfaced at settlement). Ports the dsh-timer
 * runner's soft sources with one declared deviation (2): the harness home
 * path is read via ctx.get('dshHomePath') instead of a direct property.
 */
async function readDefaultModelSelection(ctx: Context): Promise<DefaultModelSelection | undefined> {
  const get = ctx.get
  if (typeof get === 'function') {
    const service = get('agentDefaultModel') as { currentSelection?: () => unknown } | undefined
    const fromService = normalizeDefaultSelection(service?.currentSelection?.())
    if (fromService) return fromService
    const settings = get('settings') as { section?: (ns: string) => unknown } | undefined
    const fromSettings = normalizeDefaultSelection(settings?.section?.(DEFAULT_MODEL_SETTINGS_NAMESPACE))
    if (fromSettings) return fromSettings
  }
  if (typeof get !== 'function') return undefined
  const dshHomePath = get('dshHomePath')
  if (typeof dshHomePath !== 'function') return undefined
  try {
    const doc = parseYaml(await readFile(dshHomePath('settings.yaml'), 'utf8')) as unknown
    return normalizeDefaultSelection((doc as { [ns: string]: unknown } | null)?.[DEFAULT_MODEL_SETTINGS_NAMESPACE])
  } catch {
    return undefined
  }
}

/**
 * The model route of the trigger session: no per-session model knob exists —
 * the deployment's default selection from the soft sources above when one
 * resolves; otherwise no route is passed and the framework's own no-route
 * rejection is surfaced at settlement.
 */
async function resolveAgentOptions(ctx: Context): Promise<{ provider?: string; model?: string }> {
  const selection = await readDefaultModelSelection(ctx)
  if (!selection) return {}
  return { provider: selection.provider, model: selection.model }
}

/** The host's agent preset service, or undefined when the host provides none. */
function getPresetsService(ctx: Context): PresetService | undefined {
  const get = ctx.get
  if (typeof get !== 'function') return undefined
  try {
    const service = get('agentPresets')
    return service === undefined || service === null ? undefined : (service as PresetService)
  } catch {
    return undefined
  }
}

/**
 * The agent preset of the trigger session: a named preset is a hard
 * requirement (no composition failure = create_failed, no fallback); no
 * preset name = the deployment default (service missing = the baseline
 * composition with no error; a resolution failure = warn + baseline). Ports
 * the dsh-timer runner's resolution branches with the same ctx.get soft read.
 */
/** The resolved preset: the create's setup hook plus the resolved id (recorded as meta.agentPreset). */
type PresetResolution = {
  setup?: (agentCtx: unknown, agent: unknown) => Promise<void>
  id?: string
} | { failed: string }

async function resolvePreset(
  ctx: Context,
  preset: string | undefined,
  logger: Logger,
): Promise<PresetResolution> {
  const service = getPresetsService(ctx)
  if (preset !== undefined) {
    if (!service) {
      return { failed: `agent preset "${preset}" is unavailable: the host provides no agent preset service` }
    }
    let id: string
    try {
      const resolved = service.resolveMountable ? await service.resolveMountable(preset) : await service.resolve(preset)
      id = resolved.id
    } catch (err) {
      return { failed: `agent preset "${preset}" is unavailable: ${errMsg(err)}` }
    }
    return {
      id,
      setup: async (agentCtx: unknown): Promise<void> => {
        await service.mount(agentCtx, id)
      },
    }
  }
  if (!service) return {}
  try {
    const id = (await service.resolve()).id
    return {
      id,
      setup: async (agentCtx: unknown): Promise<void> => {
        await service.mount(agentCtx, id)
      },
    }
  } catch (err) {
    logger.warn(`deployment default preset resolution failed (${errMsg(err)}); continuing with the baseline composition`)
    return {}
  }
}

/**
 * Prepare the trigger sessions' shared workspace under the harness home
 * ($DSH_HOME/trigger-runs) and return its path for meta.cwd. Every failure
 * is soft: without the dshHomePath service (or on a mkdir failure) the
 * dispatcher degrades to a workspace-less create and warns.
 */
async function resolveTriggerWorkspace(ctx: Context, logger: Logger): Promise<string | undefined> {
  let dshHomePath: unknown
  try {
    dshHomePath = ctx.get('dshHomePath')
  } catch {
    return undefined
  }
  if (typeof dshHomePath !== 'function') return undefined
  let dir: string
  try {
    dir = (dshHomePath as (p: string) => string)(TRIGGER_WORKSPACE_DIR)
  } catch {
    return undefined
  }
  try {
    await mkdir(dir, { recursive: true })
    return dir
  } catch (err) {
    logger.warn(`trigger workspace preparation failed (${errMsg(err)}); creating the session without a workspace`)
    return undefined
  }
}

/** The three-part prompt fields. */
export interface TriggerPromptFields {
  account: string
  folder: string
  uid: number
  /** INTERNALDATE already rendered as ISO 8601 UTC. */
  internalDate: string
  from: string
  subject: string
  /** The user's TRIGGER_PROMPT, verbatim (zero substitution). */
  policy: string
}

/**
 * The three-part minimal prompt: L1 = type label + account
 * + folder; L2 = the envelope data line (no body excerpt); the policy block
 * = the user prompt verbatim; the tail points at the skill's "Trigger
 * session" section for the execution rules.
 */
export function buildTriggerPrompt(f: TriggerPromptFields): string {
  return [
    `<dsh-email trigger> New message in ${f.folder} on account "${f.account}":`,
    `uid ${f.uid} | INTERNALDATE ${f.internalDate} | From: ${f.from} | Subject: ${f.subject}`,
    '',
    'Policy:',
    f.policy,
    '',
    '(Execution rules: dsh-email skill, "Trigger session" section.)',
  ].join('\n')
}

/** The account log prefix shared by the watcher log and the dispatcher warnings. */
function accountTag(name: string): string {
  return `account "${name}"`
}

/**
 * The production trigger session dispatcher (the default createSession):
 * the dsh-timer runner's create / followup / settle pattern with the three
 * declared deviations. Settlement: a completed / blocked / max-tokens turn
 * = ok; a create failure (agents service missing, preset unresolvable,
 * create rejection, create deadline) or any other turn outcome = a visible
 * failure (the uid stays UNSEEN for the next resync retry). The session
 * handle is always disposed at settlement (the on-disk session log remains).
 */
async function dispatchTriggerSession(p: DispatchParams): Promise<DispatchResult> {
  const { ctx, logger, account, trigger, uid, prompt, owner } = p

  // The agents service: soft read (deviation 3 — no static inject).
  const agents: AgentsService | undefined = (() => {
    try {
      const s = ctx.get('agents')
      return s === undefined || s === null ? undefined : (s as AgentsService)
    } catch {
      return undefined
    }
  })()
  if (!agents || typeof agents.create !== 'function') {
    return { failed: 'create_failed', detail: 'the host provides no agents service' }
  }

  const preset = await resolvePreset(ctx, trigger.preset, logger)
  if ('failed' in preset) {
    return { failed: 'create_failed', detail: preset.failed }
  }
  const agentOptions = await resolveAgentOptions(ctx)
  const workspace = await resolveTriggerWorkspace(ctx, logger)

  // The session meta mirrors every other in-process session creator in a
  // deployment: an explicit meta.cwd (the framework's no-cwd default dies
  // before the first LLM call) and meta.agentPreset for the mounted preset.
  const meta: Record<string, unknown> = {}
  if (workspace !== undefined) meta.cwd = workspace
  if (preset.id !== undefined) meta.agentPreset = preset.id

  // Bounded create: a host setTimeout (deviation 1 — the watcher does not
  // depend on a cordis timer service) tracked on the owner so watcher
  // dispose cancels it; a create resolving late after a cancelled deadline
  // self-disposes at settlement (the factory owns its handle).
  let deadlineDispose: (() => void) | null = null
  let deadlineDisposed = false
  const disarmDeadline = (): void => {
    if (deadlineDisposed || deadlineDispose === null) return
    deadlineDisposed = true
    try {
      deadlineDispose()
    } catch {
      /* timer already fired */
    }
  }
  const createPromise = agents.create({
    sessionId: randomUUID() as SessionId,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
    ...(preset.setup ? { setup: preset.setup } : {}),
  })
  const deadlineSignal = new Promise<{ timedOut: true }>((resolve) => {
    const t = setTimeout(() => {
      resolve({ timedOut: true })
      // Orphan protection: a create that resolves after the deadline would leave an
      // untracked in-flight session; cancel it and dispose it instead.
      void createPromise.then(
        (late) => {
          try {
            late.agent.cancel({ kind: 'user' })
          } catch {
            /* agent gone already */
          }
          void late.dispose().catch(() => {
            /* already disposed */
          })
        },
        () => {
          /* create rejected after the deadline: nothing to dispose */
        },
      )
    }, CREATE_TIMEOUT_MS)
    deadlineDispose = () => {
      clearTimeout(t)
      owner.untrackTimer(t)
    }
    owner.trackTimer(t)
  })

  const createResult = await Promise.race([
    createPromise.then(
      (handle): { timedOut: false; handle: TriggerAgentHandle } => ({ timedOut: false, handle }),
      (err): { failed: string } => ({ failed: errMsg(err) }),
    ),
    deadlineSignal,
  ])
  disarmDeadline()
  if ('failed' in createResult) {
    return { failed: 'create_failed', detail: `agent create failed: ${createResult.failed}` }
  }
  if (createResult.timedOut) {
    return { failed: 'create_failed', detail: `agent create timed out after ${CREATE_TIMEOUT_MS}ms` }
  }
  const created = createResult.handle

  // The first turn: the three-part prompt (envelope line rendered by the watcher).
  const msg = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  })
  let followupError: string | undefined
  try {
    const r = created.agent.followup(msg)
    if (r && typeof (r as { catch?: unknown }).catch === 'function') {
      ;(r as { catch: (fn: (err: unknown) => void) => void }).catch((err) => {
        followupError = errMsg(err)
      })
    }
  } catch (err) {
    followupError = errMsg(err)
  }

  try {
    await created.agent.whenIdle()
  } catch {
    /* whenIdle is not expected to reject; ignore */
  }

  let outcome: DispatchResult
  let endEvent: TurnEndEvent | null = null
  try {
    endEvent = lastTurnEnd(created.agent.session.snapshotEvents())
  } catch {
    endEvent = null
  }
  const kind = endEvent ? reasonKind(endEvent?.data?.reason) : null
  if (kind === 'completed' || kind === 'blocked' || kind === 'max-tokens') {
    outcome = { ok: true }
  } else if (kind !== null) {
    const detail = turnErrorMessage(endEvent?.data?.reason)
    outcome = { failed: 'turn_error', detail: detail || `turn ended with reason ${kind}` }
  } else if (followupError) {
    outcome = { failed: 'turn_error', detail: followupError }
  } else {
    logger.warn(`${accountTag(account.name)}: trigger session for uid ${uid} ended without a turn/end event; falling back to ok`)
    outcome = { ok: true }
  }
  try {
    await created.dispose()
  } catch {
    /* already disposed */
  }
  return outcome
}

/**
 * The per-account new-mail trigger watcher. One resident IMAP connection
 * (EXAMINE on the listened folder, auto-IDLE on); new mail reaches it two
 * ways — the client-level 'exists' event (untagged EXISTS from the
 * always-running socket reader) and the heartbeat resync (the sole repair
 * for a lost event / count drift, and the half-open black-hole probe).
 * Detection triggers the same action: a UNSEEN search (server/uid order)
 * minus the in-flight exclusion set, dispatching slot-first, then the FIFO
 * queue, then visible overflow (the uid stays UNSEEN).
 *
 * Any watcher command failure (connect, EXAMINE, search, fetch) is the
 * uniform failure path: close, exponential backoff (5s x 2^n, cap 60s,
 * reset on a successful connect + resync), reconnect, resync on the new
 * connection. Only a missing EXAMINE folder (mailboxMissing) is terminal.
 */
export class MailWatcher implements DispatchOwner {
  private readonly options: MailWatcherOptions
  private readonly logger: Logger
  private readonly account: AccountConfig
  private readonly trigger: TriggerConfig
  private readonly createSession: CreateSessionFn

  /** True once dispose() has run: every callback no-ops, in-flight sessions detach. */
  disposed = false
  private state: WatchState = 'idle'
  private client: ImapFlow | null = null
  private timers = new Set<NodeJS.Timeout>()
  private backoffCount = 0
  /** Slot holders: a create is in progress or the session is running. */
  private readonly active = new Set<number>()
  /** FIFO of uids waiting for a slot (bounded by queueMax). */
  private queue: number[] = []
  private resyncing = false
  private resyncPending = false

  constructor(options: MailWatcherOptions) {
    this.options = options
    this.account = options.account
    this.trigger = options.trigger
    this.logger = options.ctx.logger(PLUGIN_NAME)
    this.createSession = options.createSession ?? dispatchTriggerSession
  }

  /** Begin the connect / watch loop (idempotent). */
  start(): void {
    if (this.state !== 'idle') return
    this.state = 'connecting'
    void this.cycle()
  }

  /**
   * Dispose (synchronous, safe to call more than once): invalidate first
   * (the close event is emitted synchronously by close() and must not
   * trigger a zombie reconnect), then cancel every pending host timer
   * (backoff / heartbeat / in-flight create deadlines), then close the
   * connection, drop the queue (its UNSEEN uids replay on the next boot),
   * and detach the in-flight sessions (they settle on their own; a late
   * settlement is a no-op for this dead watcher and never throws).
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.state = 'disposed'
    for (const t of this.timers) {
      try {
        clearTimeout(t)
      } catch {
        /* timer already fired */
      }
    }
    this.timers.clear()
    const client = this.client
    this.client = null
    this.queue.length = 0
    if (client) {
      try {
        void client.close()
      } catch {
        /* already gone */
      }
    }
  }

  /** Track a host timer for dispose-time cancellation (a post-dispose track cancels it). */
  trackTimer(t: NodeJS.Timeout): void {
    if (this.disposed) {
      try {
        clearTimeout(t)
      } catch {
        /* timer already fired */
      }
      return
    }
    t.unref?.()
    this.timers.add(t)
  }

  /** Forget a host timer (it fired or was disarmed). */
  untrackTimer(t: NodeJS.Timeout): void {
    this.timers.delete(t)
  }

  /** One connect / watch attempt: fresh client, fresh listeners (imapflow: one connect per instance). */
  private async cycle(): Promise<void> {
    if (this.disposed) return
    const factory = this.options.createConnection ?? ((acct: AccountConfig) => buildWatcherConnection(acct).client)
    const client = factory(this.account)
    this.client = client
    this.state = 'connecting'
    client.on('exists', (): void => {
      if (!this.disposed) this.noteExists()
    })
    client.on('close', (): void => {
      if (this.disposed || this.state !== 'connected') return
      // A spontaneous close (socket drop, library timeout, forced destroy)
      // is the uniform failure path: reconnect through the backoff.
      void this.reconnectAfterFailure('connection closed unexpectedly')
    })
    client.on('error', (err: Error): void => {
      if (this.disposed || this.state !== 'connected') return
      void this.reconnectAfterFailure(`socket error: ${errMsg(err)}`)
    })
    try {
      await client.connect()
      if (this.disposed) return
      // EXAMINE: open the listened folder read-only (the watcher never writes flags).
      await client.mailboxOpen(this.trigger.folder, { readOnly: true })
      if (this.disposed) return
      this.state = 'connected'
      // The backoff streak resets only after the resync succeeded: a resync
      // that fails after a clean connect routes to the uniform failure path
      // and keeps the escalation streak intact. resync re-arms the heartbeat
      // itself on success, so nothing is armed here.
      await this.resync()
      if (!this.disposed && this.state === 'connected') this.backoffCount = 0
    } catch (err) {
      if (this.disposed) return
      const e = err as { mailboxMissing?: boolean }
      if (e && e.mailboxMissing === true) {
        // The only terminal state: the listened folder does not exist on the
        // server. No retry loop; it self-heals on a config change (loader
        // dispose + reconstruct) or the folder appearing server-side.
        this.state = 'terminal'
        this.logger.error(
          `${this.logTag()}: trigger watcher stopped: folder "${this.trigger.folder}" does not exist on the ` +
            'server (EXAMINE rejected); no further retries until the folder or the triggerFolder setting changes',
        )
        try {
          await client.close()
        } catch {
          /* already gone */
        }
        return
      }
      this.state = 'reconnecting'
      await this.closeClient()
      this.logger.warn(
        `${this.logTag()}: trigger watcher connect failed: ${errMsg(err)} (attempt ${this.backoffCount + 1}); reconnecting with backoff`,
      )
      this.scheduleBackoff()
    }
  }

  /** The uniform failure path: close (if any), log, back off, reconnect.
   *
   * Guarded on the connected state, not just dispose: a single transport
   * failure can surface through several racing paths (the library error
   * event, the socket close event, the in-flight command the heartbeat
   * resync was waiting on), and exactly one of them may take the
   * connected -> reconnecting transition. The losers no-op, so the backoff
   * is scheduled exactly once and no second reconnect cycle can start
   * beside the first. */
  private async reconnectAfterFailure(reason: string): Promise<void> {
    if (this.disposed || this.state !== 'connected') return
    this.state = 'reconnecting'
    this.logger.warn(`${this.logTag()}: trigger watcher ${reason}; reconnecting with backoff`)
    await this.closeClient()
    if (this.disposed) return
    this.scheduleBackoff()
  }

  /** Close the current connection, swallowing an already-dead client. */
  private async closeClient(): Promise<void> {
    const c = this.client
    this.client = null
    if (!c) return
    try {
      await c.close()
    } catch {
      /* already closed */
    }
  }

  private scheduleBackoff(): void {
    if (this.disposed) return
    this.backoffCount += 1
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.backoffCount - 1), BACKOFF_MAX_MS)
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (this.disposed) return
      this.state = 'connecting'
      void this.cycle()
    }, delay)
    this.trackTimer(t)
  }

  /** Arm the one-shot heartbeat (the periodic resync; re-armed after every successful resync). */
  private armHeartbeat(): void {
    if (this.disposed) return
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (this.disposed) return
      // The UNSEEN resync doubles as the half-open black-hole probe: the
      // SEARCH carries the account's timeout budget, so a silent transport
      // fails it and routes to the uniform failure path.
      void this.resync()
    }, this.trigger.idleMs)
    this.trackTimer(t)
  }

  /** Note an untagged EXISTS (the client-level 'exists' event): resync. */
  private noteExists(): void {
    if (this.state !== 'connected') return
    void this.resync()
  }

  /**
   * The UNSEEN resync: search the listened folder for UNSEEN uids (server /
   * uid order) and dispatch every one not already in flight. A burst of
   * exists events (or an overlapping heartbeat) collapses into one in-flight
   * resync plus at most one follow-up.
   */
  private async resync(): Promise<void> {
    if (this.disposed || this.state !== 'connected') return
    if (this.resyncing) {
      this.resyncPending = true
      return
    }
    this.resyncing = true
    this.resyncPending = false
    try {
      const uids = await this.searchUnseen()
      if (this.disposed || this.state !== 'connected') return
      this.dispatchUids(uids)
      if (!this.disposed && this.state === 'connected') this.armHeartbeat()
    } catch (err) {
      // The uniform failure rule: any watcher command failure closes, backs
      // off, and resyncs on the next connect.
      if (!this.disposed) {
        void this.reconnectAfterFailure(`command failed: ${errMsg(err)}`)
      }
    } finally {
      this.resyncing = false
      if (this.resyncPending && !this.disposed && this.state === 'connected') {
        this.resyncPending = false
        void this.resync()
      }
    }
  }

  /** The UNSEEN uid list of the listened folder (uid mode; server order). */
  private async searchUnseen(): Promise<number[]> {
    const client = this.client
    if (!client) throw new Error('watcher has no connection')
    const result = await client.search({ seen: false }, { uid: true })
    return Array.isArray(result) ? result : []
  }

  /** Dispatch new uids in uid order: free slot first, then the FIFO queue, then visible overflow. */
  private dispatchUids(uids: number[]): void {
    const sorted = [...uids].sort((a, b) => a - b)
    const overflow: number[] = []
    for (const uid of sorted) {
      if (this.disposed) break
      if (this.isTracked(uid)) continue
      if (this.active.size < this.trigger.maxConcurrent) {
        this.active.add(uid)
        void this.dispatchUid(uid)
      } else if (this.queue.length < this.trigger.queueMax) {
        this.queue.push(uid)
      } else {
        // Overflow: visible, never dropped silently; the mail stays UNSEEN
        // and is picked up by a later resync once capacity frees up.
        overflow.push(uid)
      }
    }
    if (overflow.length > 0) {
      // One visible log per resync carries the spec fields: account (log
      // prefix), folder, the overflowed uids, and the overflow count.
      this.logger.warn(
        `${this.logTag()}: trigger queue full (folder "${this.trigger.folder}", ${this.trigger.queueMax} waiting, ` +
          `${this.active.size} active): ${overflow.length} uid(s) overflowed — uid ${overflow.join(', ')} ` +
          'stay UNSEEN and are retried on the next resync',
      )
    }
  }

  /** The in-flight exclusion set: an uid in active or in the queue is not re-dispatched. */
  private isTracked(uid: number): boolean {
    return this.active.has(uid) || this.queue.includes(uid)
  }

  /** Refill free slots from the FIFO queue (after a slot freed). */
  private pumpQueue(): void {
    if (this.disposed) return
    while (this.queue.length > 0 && this.active.size < this.trigger.maxConcurrent) {
      const uid = this.queue.shift() as number
      this.active.add(uid)
      void this.dispatchUid(uid)
    }
  }

  /** One dispatch: fetch the envelope on the own connection, render the prompt, run the session. */
  private async dispatchUid(uid: number): Promise<void> {
    let result: DispatchResult
    try {
      const env = await this.fetchEnvelope(uid)
      if (this.disposed) return
      const prompt = buildTriggerPrompt({
        account: this.account.name,
        folder: this.trigger.folder,
        uid,
        internalDate: env.internalDate,
        from: env.from,
        subject: env.subject,
        policy: this.trigger.prompt,
      })
      result = await this.createSession({
        ctx: this.options.ctx,
        logger: this.logger,
        account: this.account,
        trigger: this.trigger,
        uid,
        prompt,
        owner: this,
      })
    } catch (err) {
      // The uniform failure rule: any watcher command failure (including the
      // envelope fetch on a dead connection) closes, backs off, and resyncs
      // on the next connect; the uid stays UNSEEN. Routed through the
      // state-guarded uniform failure path so this path is mutually
      // exclusive with the close / error events of the same transport
      // failure — at most one backoff per failure.
      void this.reconnectAfterFailure(`command failed: ${errMsg(err)}`)
      return
    }
    this.finishDispatch(uid, result)
  }

  /** The dispatch epilogue: free the slot, log the outcome, refill the queue. */
  private finishDispatch(uid: number, result: DispatchResult): void {
    this.active.delete(uid)
    if (this.disposed) return
    if ('ok' in result) {
      this.logger.info(`${this.logTag()}: trigger session settled for uid ${uid}`)
    } else {
      this.logger.warn(
        `${this.logTag()}: trigger dispatch for uid ${uid} failed (${result.failed}): ${result.detail}; ` +
          'the message stays UNSEEN and is retried on the next resync',
      )
    }
    this.pumpQueue()
  }

  /** The envelope of one uid on the watcher's own connection (no extra IMAP connection). */
  private async fetchEnvelope(uid: number): Promise<{ from: string; subject: string; internalDate: string }> {
    const client = this.client
    if (!client) throw new Error('watcher has no connection')
    const messages = await client.fetchAll(String(uid), { envelope: true, internalDate: true }, { uid: true })
    const msg = messages[0]
    if (!msg) throw new Error(`uid ${uid} vanished before the envelope fetch`)
    const envelope = msg.envelope
    const from = (envelope?.from?.[0]?.address as string | undefined) ?? ''
    const subject = (envelope?.subject as string | undefined) ?? ''
    let internalDate: string
    const raw = msg.internalDate
    if (raw instanceof Date) {
      internalDate = raw.toISOString()
    } else if (typeof raw === 'string' && raw !== '') {
      const d = new Date(raw)
      internalDate = Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString()
    } else {
      internalDate = new Date(0).toISOString()
    }
    return { from, subject, internalDate }
  }

  private logTag(): string {
    return accountTag(this.account.name)
  }
}
