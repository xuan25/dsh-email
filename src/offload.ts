// dsh-email session offload (the retention plane): a per-minute sweep moves
// settled trigger-session directories that outlived their account's retention
// window into the archive, keeping the framework session store bounded.
//
// The sweep is a pure function of (retention log, disk state): no mid-round
// state, single writer (the one plugin process). A crash anywhere in a round
// converges on the next round through the source/destination existence table.
// The retention log records one line per dispatched session (the write gate
// applies at dispatch time); the sweep is the only other writer (compaction
// rewrites the whole file atomically through a same-directory temp + rename).

import { existsSync, readdirSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Context, Logger } from './types.js'
import { PLUGIN_NAME, errMsg } from './util.js'

/** Sweep cadence in ms (the component's only fixed period; the first round runs immediately at boot). */
export const SWEEP_PERIOD_MS = 60_000
/** Completed-line share of the log that triggers a compaction rewrite (>= 25%). */
export const COMPACTION_RATIO = 0.25
/** Consecutive over-envelope sweep increments before the trend alert fires. */
export const TREND_K = 10
/** Per-sweep offload budget default (the EMAIL_OFFLOAD_BATCH knob default). */
export const DEFAULT_OFFLOAD_BATCH = 50

/** Plugin home sub-path under the harness home (retention log + archive live here). */
export const OFFLOAD_HOME_BASE = 'dsh-email'
/** Archive directory under the plugin home. */
export const OFFLOAD_ARCHIVE_DIR = 'archived-sessions'
/** Retention log file name under the plugin home. */
export const OFFLOAD_LOG_FILE = 'retention-log.jsonl'
/** Framework session store root under the harness home (offload source side). */
export const OFFLOAD_STORE_ROOT = 'sessions'

// --- Retention window syntax -------------------------------------------------
// A window is a non-negative integer number of milliseconds (the number form)
// or a duration string of one or two "digits+unit" segments (units d/h/m/s/
// ms) in strict descending order (24h, 4h30m, 90s, 5000ms). A bare numeric
// string is ambiguous and rejected; anything else (a third segment, an
// unknown unit, a separator, any stray character) is invalid. An invalid
// value never fails the account or the component: it warns and resolves to
// 0 (no automatic offload for that account).

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000, ms: 1 }
/** Segment rank in the descending order (a first segment must rank lower). */
const UNIT_RANK: Record<string, number> = { d: 0, h: 1, m: 2, s: 3, ms: 4 }

export type WindowParse = { ok: true; ms: number } | { ok: false; reason: string }

function parseWindowNumber(value: number): WindowParse {
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, reason: 'a number window must be a non-negative integer of milliseconds' }
  }
  return { ok: true, ms: value }
}

function parseWindowString(value: string): WindowParse {
  const m = /^(\d+)(ms|m|d|h|s)(\d+(ms|m|d|h|s))?$/.exec(value)
  if (!m) {
    return {
      ok: false,
      reason: 'a string window must be one or two "digits+unit" segments (units d/h/m/s/ms)',
    }
  }
  const a = Number(m[1]) * UNIT_MS[m[2]]
  if (m[3] === undefined) {
    if (!Number.isSafeInteger(a)) return { ok: false, reason: 'the window exceeds the representable range' }
    return { ok: true, ms: a }
  }
  // The design regex captures the second segment as one group (digits+unit);
  // the digits are the segment minus its unit suffix.
  if (UNIT_RANK[m[2]] >= UNIT_RANK[m[4]]) {
    return { ok: false, reason: 'the segments must be in descending unit order (d > h > m > s > ms)' }
  }
  const ms = a + Number(m[3].slice(0, m[3].length - m[4].length)) * UNIT_MS[m[4]]
  if (!Number.isSafeInteger(ms)) return { ok: false, reason: 'the window exceeds the representable range' }
  return { ok: true, ms }
}

/** Parse a retention window (number = ms, string = duration, rules above). */
export function parseWindowMs(value: number | string): WindowParse {
  return typeof value === 'number' ? parseWindowNumber(value) : parseWindowString(value)
}

// --- Retention log -----------------------------------------------------------

/** One retention log line: a dispatched trigger session awaiting offload duty. */
export interface RetentionEntry {
  id: string
  /** Dispatch time (ISO8601); the retention window is measured from it. */
  createdAt: string
  /** Account name (the unit) the session was dispatched on. */
  unit: string
  /** Session workspace at create time (absent when the create carried no meta.cwd). */
  cwd?: string
}

function entryLine(e: RetentionEntry): string {
  return JSON.stringify({
    id: e.id,
    createdAt: e.createdAt,
    unit: e.unit,
    ...(e.cwd !== undefined && e.cwd !== '' ? { cwd: e.cwd } : {}),
  })
}

export function parseEntryLine(line: string): RetentionEntry | null {
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const o = data as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return null
  if (typeof o.createdAt !== 'string' || !Number.isFinite(Date.parse(o.createdAt))) return null
  if (typeof o.unit !== 'string' || o.unit === '') return null
  if ('cwd' in o && o.cwd !== undefined && typeof o.cwd !== 'string') return null
  return {
    id: o.id,
    createdAt: o.createdAt,
    unit: o.unit,
    ...(typeof o.cwd === 'string' && o.cwd !== '' ? { cwd: o.cwd } : {}),
  }
}

async function readLogRaw(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

export interface RetentionLogRead {
  /** Parseable entries, in file order. */
  entries: RetentionEntry[]
  /** True when a torn trailing line was detected and repaired in place. */
  repaired: boolean
  /** Lines that were neither blank nor parseable (skipped, counted). */
  badLines: number
}

/**
 * Read the retention log. A torn trailing line (the file not ending in a
 * newline = a write cut off mid-line) is repaired to the last complete line
 * before parsing; unparseable complete lines are skipped and counted.
 */
export async function readRetentionLog(filePath: string): Promise<RetentionLogRead> {
  let raw = await readLogRaw(filePath)
  let repaired = false
  if (raw !== '' && !raw.endsWith('\n')) {
    const cut = raw.lastIndexOf('\n')
    raw = cut < 0 ? '' : raw.slice(0, cut + 1)
    repaired = true
    await writeFile(filePath, raw)
  }
  const entries: RetentionEntry[] = []
  let badLines = 0
  for (const line of raw.split('\n')) {
    if (line === '') continue
    const e = parseEntryLine(line)
    if (e === null) badLines++
    else entries.push(e)
  }
  return { entries, repaired, badLines }
}

/**
 * In-process write mutex (single process, single writer): the append and the
 * compaction rewrite must not interleave, or a rewrite racing an append loses
 * the appended line. A promise chain hands the file to one operation at a
 * time.
 */
let logWriteTail: Promise<unknown> = Promise.resolve()
function withLogWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = logWriteTail.then(fn, fn)
  logWriteTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Append one entry line (single append write, directory created on demand).
 * A torn tail left by a cut-off earlier write is closed with a newline first,
 * so the new line cannot fuse with the torn fragment.
 */
export function appendRetentionEntry(filePath: string, entry: RetentionEntry): Promise<void> {
  return withLogWrite(async () => {
    await mkdir(path.dirname(filePath), { recursive: true })
    const raw = await readLogRaw(filePath)
    if (raw !== '' && !raw.endsWith('\n')) {
      await appendFile(filePath, '\n', 'utf8')
    }
    await appendFile(filePath, entryLine(entry) + '\n', 'utf8')
  })
}

/**
 * Test seam holder: when `rewriteBarrier.fn` is set it is awaited inside the
 * compaction rewrite between the temp write and the rename, so a test can
 * park the rewrite and force an append into the rewrite window (the mutex
 * contract: the append must still land on the post-rename file). Production
 * never sets it.
 */
export const rewriteBarrier: { fn: (() => Promise<void> | void) | undefined } = { fn: undefined }

/**
 * Atomic log rewrite (same-directory temp file + rename): keep exactly the
 * given entries, in this order. The compaction step uses it.
 */
export function rewriteRetentionLog(filePath: string, keep: readonly RetentionEntry[]): Promise<void> {
  return withLogWrite(async () => {
    const tmp = `${filePath}.tmp`
    await writeFile(tmp, keep.map((e) => entryLine(e) + '\n').join(''), 'utf8')
    if (rewriteBarrier.fn) await rewriteBarrier.fn()
    await rename(tmp, filePath)
  })
}

// --- The sweeper -------------------------------------------------------------

/** Host service faces the sweeper reads (soft reads; structural). */
interface SessionPersistenceService {
  /** Resolve a session's on-disk log path from its header (id + optional cwd). */
  locate?(meta: { id: string; cwd?: string }): { kind?: string; path: string }
}

interface SessionRegistry {
  /** Defined = the session id is live in the framework registry. */
  get(id: string): unknown
}

export interface OffloadHome {
  /** Plugin home under the harness home (log + archive live here). */
  base: string
  /** Archive directory (created on demand). */
  archive: string
  /** Retention log file. */
  log: string
  /** Framework session store root under the harness home (offload source side). */
  storeRoot: string
}

export interface OffloadSweeperOptions {
  ctx: Context
  logger: Logger
  home: OffloadHome
  /** Account name -> current retention window in ms (0 = retain, no offload). */
  accounts: ReadonlyMap<string, number>
  /** Session ids dispatched but not yet settled (plugin-owned, shared with the trigger watchers). */
  inflight: ReadonlySet<string>
  /** Per-sweep offload budget (the EMAIL_OFFLOAD_BATCH knob, default 50). */
  cap: number
  /** Test seam: the clock (default Date.now). */
  now?: () => number
  /** Test seam: device-number reader (default stat; undefined = path absent). */
  devOf?: (p: string) => Promise<number | undefined>
  /** Test seam: the archive move (default fs.rename). */
  move?: (src: string, dst: string) => Promise<void>
}

export interface SweepReport {
  /** Set when the round was skipped (the component is disabled this round). */
  disabled?: string
  /** Offload work attempted this round (rename attempts, bounded by the cap). */
  candidates: number
  /** Sessions moved into the archive this round (settled-confirmed). */
  offloaded: number
  /** Sessions already archived by an earlier round (the entry completed). */
  alreadyArchived: number
  /** Sessions found on neither side (completed; the line is compaction-eligible). */
  sourceGone: number
  /** Candidates still live at processing time (kept, not completed). */
  skippedLive: number
  /** Entries that hit a round error (kept, retried next round). */
  errors: number
  /** Log lines removed by the compaction rewrite this round (0 without a rewrite). */
  removedLines: number
  /** Post-compaction log line count (the round's balance). */
  balance: number
  /** This round's increment: balance + removed - previous balance. */
  increment: number
  /** True when the trend alert fired this round (K consecutive over-envelope rounds). */
  trendAlert: boolean
  /** Pre-compaction completed-line share (0 on an empty log). */
  completedRatio: number
}

/**
 * The per-minute offload sweep (one instance per plugin process). Each round:
 * a mount/availability check, the log read (torn-tail repair, bad-line
 * skip), the per-entry pass in file order (liveness gate, path resolution,
 * the source/destination existence table; the offload budget bounds the
 * rename work while completed and live lines re-derive at no budget cost;
 * the settled re-check after the move), the ratio-triggered compaction
 * rewrite, and the trend alert on consecutive over-envelope increments.
 */
export class OffloadSweeper {
  private readonly opts: OffloadSweeperOptions
  private readonly now: () => number
  private readonly devOf: (p: string) => Promise<number | undefined>
  private readonly move: (src: string, dst: string) => Promise<void>
  private timer: NodeJS.Timeout | undefined
  private running = false
  /** Edge-#10 startup check (the missing-log warning) runs at most once. */
  private startupChecked = false
  /** Previous round's post-compaction balance (undefined before the first round). */
  private prevBalance: number | undefined
  /** Consecutive over-envelope increments (the trend alert counter). */
  private streak = 0

  constructor(opts: OffloadSweeperOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
    this.move = opts.move ?? ((src, dst) => rename(src, dst))
    this.devOf = opts.devOf ?? (async (p) => {
      try {
        return (await stat(p)).dev
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return undefined
        throw err
      }
    })
  }

  /** Run one sweep round (safe to call concurrently; overlapping rounds are dropped). */
  async sweep(): Promise<SweepReport> {
    const report: SweepReport = {
      candidates: 0,
      offloaded: 0,
      alreadyArchived: 0,
      sourceGone: 0,
      skippedLive: 0,
      errors: 0,
      removedLines: 0,
      balance: 0,
      increment: 0,
      trendAlert: false,
      completedRatio: 0,
    }
    const { ctx, logger, home, accounts, inflight } = this.opts
    const tag = `${PLUGIN_NAME}: offload`

    // 0. Round health: the persistence service, the archive directory, and
    //    the mount consistency of archive vs session store.
    let sp: SessionPersistenceService | undefined
    try {
      const s = ctx.get('sessionPersistence')
      sp = s === undefined || s === null ? undefined : (s as SessionPersistenceService)
    } catch {
      sp = undefined
    }
    if (sp === undefined) {
      logger.warn(`${tag}: the session persistence service is unreachable; this sweep is skipped`)
      return { ...report, disabled: 'the session persistence service is unreachable' }
    }
    if (typeof sp.locate !== 'function') {
      logger.warn(`${tag}: the session persistence service exposes no locate; entries will be skipped this round`)
    }
    let registry: SessionRegistry | undefined
    try {
      const s = ctx.get('sessions')
      registry = s === undefined || s === null ? undefined : (s as SessionRegistry)
    } catch {
      registry = undefined
    }
    if (registry === undefined) {
      logger.warn(`${tag}: the session registry service is unreachable; liveness falls back to the in-flight set`)
    }

    try {
      await mkdir(home.archive, { recursive: true })
    } catch (err) {
      logger.warn(`${tag}: the archive directory is unavailable (${errMsg(err)}); this sweep is skipped`)
      return { ...report, disabled: `the archive directory is unavailable: ${errMsg(err)}` }
    }
    const aDev = await this.devOf(home.archive)
    const sDev = await this.devOf(home.storeRoot)
    if (aDev === undefined || sDev === undefined) {
      logger.warn(`${tag}: the archive or the session store root is missing on this host; this sweep is skipped`)
      return { ...report, disabled: 'the archive or the session store root is missing' }
    }
    if (aDev !== sDev) {
      logger.warn(`${tag}: the archive and the session store sit on different mounts; this sweep is skipped (offload disabled)`)
      return { ...report, disabled: 'the archive and the session store are on different mounts' }
    }

    // Edge #10 (checked once, on the first round = plugin startup): the log
    // should exist (the archive holds evidence of prior offload activity) but
    // is missing: previously tracked sessions linger in the store, so warn
    // prominently. New dispatches are still tracked and the next tracked
    // dispatch recreates the log.
    if (!this.startupChecked) {
      this.startupChecked = true
      let priorOffload = false
      try {
        priorOffload = readdirSync(home.archive).length > 0
      } catch {
        priorOffload = false
      }
      if (priorOffload && !existsSync(home.log)) {
        logger.warn(
          `${tag}: the retention log is missing although the archive directory is not empty; previously tracked ` +
            'sessions will linger in the session store (new dispatches are still tracked and the next tracked dispatch recreates the log)',
        )
      }
    }

    // 1. Log read (torn-tail repair, bad-line skip).
    const { entries, repaired, badLines } = await readRetentionLog(home.log)
    if (repaired) logger.warn(`${tag}: the retention log had a torn trailing line; it was repaired`)
    if (badLines > 0) logger.warn(`${tag}: ${badLines} unparseable retention log line(s) were skipped`)

    // 2. Per-entry pass (file order). The offload budget (cap) limits the
    //    rename work of the round: completed lines (the state re-derives to
    //    already archived or source gone) and still-live lines are re-checked
    //    at no budget cost, so they never starve the pending work behind
    //    them; the budget takes the first renameable lines in file order and
    //    the rest are picked up by later rounds in the same order.
    const now = this.now()
    // Line-granular completed accounting: every line that survives the round
    // (live, in-window, budget-pending, or errored) is appended to `keep`;
    // a line whose state re-derives to completed (archived, source gone) is
    // not. Duplicate ids can therefore never make one line drag another.
    const keep: RetentionEntry[] = []
    let processed = 0
    for (const e of entries) {
      const windowMs = accounts.get(e.unit)
      if (windowMs === 0) {
        keep.push(e)
        continue
      }
      if (windowMs !== undefined && now - Date.parse(e.createdAt) <= windowMs) {
        keep.push(e)
        continue
      }

      const live =
        inflight.has(e.id) || (registry !== undefined ? registry.get(e.id) !== undefined : false)
      if (live) {
        keep.push(e)
        report.skippedLive++
        continue
      }

      if (typeof sp.locate !== 'function') {
        logger.warn(`${tag}: no locate on the persistence service; entry ${e.id} is kept for the next round`)
        keep.push(e)
        report.errors++
        continue
      }
      let src: string
      try {
        const loc = sp.locate({ id: e.id, ...(e.cwd !== undefined ? { cwd: e.cwd } : {}) })
        src = path.dirname(loc.path)
      } catch (err) {
        logger.warn(`${tag}: locating session ${e.id} failed (${errMsg(err)}); the entry is kept`)
        keep.push(e)
        report.errors++
        continue
      }
      const dst = path.join(home.archive, path.basename(src))

      // The source/destination existence table (dev = undefined: absent).
      const srcDev = await this.devOf(src)
      const dstDev = await this.devOf(dst)
      if (srcDev === undefined && dstDev === undefined) {
        report.sourceGone++
        continue
      }
      if (srcDev === undefined) {
        report.alreadyArchived++
        continue
      }
      if (dstDev !== undefined) {
        logger.warn(`${tag}: source ${src} and archive entry ${dst} both exist for session ${e.id}; the entry is kept for manual resolution`)
        keep.push(e)
        report.errors++
        continue
      }
      // Offload work (budgeted): the cap takes the first renameable lines in
      // file order; the rest stay pending for the later rounds.
      if (processed >= this.opts.cap) {
        keep.push(e)
        continue
      }
      processed++
      report.candidates++
      try {
        await this.move(src, dst)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          report.sourceGone++
        } else if (code === 'EEXIST') {
          const still = await this.devOf(src)
          if (still === undefined) {
            report.alreadyArchived++
          } else {
            logger.warn(`${tag}: moving ${src} to ${dst} reported a conflict and both sides remain; the entry is kept for manual resolution`)
            keep.push(e)
            report.errors++
          }
        } else {
          logger.warn(`${tag}: moving ${src} to ${dst} failed (${errMsg(err)}); the entry is kept and retried next round`)
          keep.push(e)
          report.errors++
        }
        continue
      }
      // Settled re-check after the move: a session that went live between the
      // check and the move goes back to the store (the entry stays).
      const liveNow =
        inflight.has(e.id) || (registry !== undefined ? registry.get(e.id) !== undefined : false)
      if (liveNow) {
        try {
          await this.move(dst, src)
        } catch {
          /* the reverse move failed; the entry stays and the next round re-derives */
        }
        logger.warn(`${tag}: session ${e.id} went live after the archive move; it was moved back and the entry is kept`)
        keep.push(e)
        continue
      }
      report.offloaded++
      logger.debug(`${tag}: archived session ${e.id} (unit ${e.unit}) from ${src} to ${dst}`)
    }

    // 3. Compaction (ratio-triggered, atomic rewrite).
    const preBalance = entries.length
    const ratio = preBalance > 0 ? (preBalance - keep.length) / preBalance : 0
    report.completedRatio = ratio
    if (preBalance > 0 && ratio >= COMPACTION_RATIO) {
      await rewriteRetentionLog(home.log, keep)
      report.removedLines = preBalance - keep.length
    }
    report.balance = preBalance - report.removedLines

    // 4. Trend alert on consecutive over-envelope increments (the increment
    //    = new log lines since the previous round; the first round re-derives
    //    the previous balance from the file line count at boot, so it
    //    measures arrivals since boot and never judges on stale state).
    if (this.prevBalance === undefined) {
      this.prevBalance = preBalance
    }
    const increment = report.balance + report.removedLines - this.prevBalance
    this.prevBalance = report.balance
    report.increment = increment
    this.streak = increment > this.opts.cap ? this.streak + 1 : 0
    if (this.streak >= TREND_K) {
      report.trendAlert = true
      // Trend line content: the streak count, the balance, the per-sweep
      // increment over the budget, the completed-line ratio, and one
      // discriminator sentence.
      const growth = increment - this.opts.cap
      const advice =
        ratio < COMPACTION_RATIO
          ? 'the compaction trigger is permanently dormant (the arrival rate reaches at least four times the budget): completed lines are never evicted; check the offload batch knob first'
          : 'the compaction trigger is still active: balance and store backlog grow by (increment - cap) per sweep; raise the offload batch knob or lower the dispatch rate'
      logger.warn(
        `${tag}: trend alert: ${this.streak} consecutive sweeps over the offload budget ` +
          `(balance ${report.balance}, increment ${increment}/sweep, budget ${this.opts.cap}, ` +
          `completed-line ratio ${Math.round(ratio * 100)}%, growth rate ${growth}/sweep) - ${advice}`,
      )
    }

    // 5. Round summary line.
    logger.info(
      `${tag}: sweep done (candidates ${report.candidates}, offloaded ${report.offloaded}, ` +
        `already archived ${report.alreadyArchived}, source gone ${report.sourceGone}, ` +
        `still live ${report.skippedLive}, errors ${report.errors}, ` +
        `log lines removed ${report.removedLines}, balance ${report.balance})`,
    )
    return report
  }

  /** Arm the periodic sweep: an immediate first round, then one per period. */
  start(): void {
    if (this.timer !== undefined) return
    void this.safeSweep()
    this.timer = setInterval(() => {
      void this.safeSweep()
    }, SWEEP_PERIOD_MS)
    this.timer.unref?.()
  }

  private async safeSweep(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.sweep()
    } catch (err) {
      this.opts.logger.error(`${PLUGIN_NAME}: offload sweep failed (${errMsg(err)}); the round is skipped`)
    } finally {
      this.running = false
    }
  }

  /** Stop the periodic sweep (an in-flight round finishes; state is kept). */
  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}
