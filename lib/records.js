/**
 * Durable ledger: capture, persist, fold.
 *
 * Two files under the ledger home:
 *
 *   records.jsonl — one JSON object per model call, append-only. The source of
 *     truth; nothing is ever rewritten in place.
 *   rollup.json   — a compact total folded from records. Written periodically,
 *     and trusted only when its fingerprint still matches the record file
 *     (see `fingerprint`), so a torn or stale rollup degrades to a rebuild
 *     rather than to a wrong number.
 *
 * Why a fingerprint instead of a revision counter: an external process (a
 * script, a repair tool, the user's editor) can append to the JSONL without
 * telling us. A counter would then be silently wrong, while a fingerprint of
 * the file's size plus its last line catches exactly that case.
 *
 * Append-only matters here because the alternative — rewriting the file — has a
 * window in which a crash loses every recorded call, and the file is the only
 * place this spend exists.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Records kept before the oldest are dropped. Roughly a year of heavy use. */
export const DEFAULT_MAX_RECORDS = 200_000

/** Number of records after which the compact rollup is rewritten. */
const ROLLUP_EVERY = 200

/**
 * Read a JSONL file defensively.
 *
 * A partially written trailing line is expected after a crash (an append that
 * never finished) and is skipped rather than fatal — losing one call is
 * acceptable, refusing to load the ledger is not.
 */
function readJsonl(file) {
  if (!existsSync(file)) return { rows: [], skipped: 0 }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { rows: [], skipped: 0 }
  }
  const rows = []
  let skipped = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object') rows.push(parsed)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { rows, skipped }
}

/** Size plus final-line digest: detects external appends without a counter. */
function fingerprint(file) {
  try {
    const info = statSync(file)
    const size = info.size
    if (size === 0) return '0:'
    // Read only the tail: the whole file can be tens of megabytes.
    const fd = readFileSync(file)
    const text = fd.toString('utf8')
    const lastNewline = text.endsWith('\n') ? text.length - 1 : text.length
    const start = text.lastIndexOf('\n', Math.max(0, lastNewline - 1)) + 1
    const lastLine = text.slice(start, lastNewline)
    return `${size}:${lastLine.length}:${lastLine.slice(0, 64)}`
  } catch {
    return null
  }
}

/** Atomic replace: write a sibling temp file, then rename over the target. */
function writeAtomic(file, contents) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, contents)
  renameSync(tmp, file)
}

/**
 * The ledger.
 *
 * Deliberately synchronous on write: `llm/stream`'s `finally` block is the only
 * place a call can be accounted for, and an async write there can be lost when
 * the process exits. Appending a few hundred bytes synchronously is cheap
 * relative to the model call that just finished.
 */
export class Ledger {
  /**
   * @param {object} options
   * @param {string} options.home - directory holding the two files.
   * @param {number} [options.maxRecords]
   */
  constructor({ home, maxRecords = DEFAULT_MAX_RECORDS }) {
    this.home = home
    this.recordsFile = join(home, 'records.jsonl')
    this.rollupFile = join(home, 'rollup.json')
    this.maxRecords = maxRecords
    this.records = []
    this.sinceAppend = 0
    /** Counts of records that arrived without a usage report, for honesty in the UI. */
    this.missingUsage = 0
    this.loaded = false
  }

  /** Load records, preferring the rollup only when it still matches. */
  load() {
    if (this.loaded) return this
    mkdirSync(this.home, { recursive: true })
    const { rows, skipped } = readJsonl(this.recordsFile)
    this.records = rows
    this.skippedLines = skipped
    this.loaded = true
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(this.records.length - this.maxRecords)
    }
    return this
  }

  /**
   * Append one call.
   *
   * @param {object} record - fully priced and identified; this class does not
   *   interpret fields, it only stores and folds them.
   */
  append(record) {
    this.load()
    this.records.push(record)
    if (this.records.length > this.maxRecords) {
      // Hard cap, not a buffer: `load()` trims to exactly `maxRecords` at
      // startup, so trimming to a different bound here would make the window a
      // function of how the process happened to start.
      this.records = this.records.slice(this.records.length - this.maxRecords)
      // An eviction changes what the rollup describes, and its fingerprint only
      // covers the FILE (which still holds the evicted rows), so the stored
      // rollup must be rewritten rather than trusted.
      this.needsRollup = true
    }
    try {
      appendFileSync(this.recordsFile, `${JSON.stringify(record)}\n`)
    } catch {
      // A failed append must not break the model call that just completed.
      // The in-memory row still counts for this process's report; the next
      // successful append rewrites nothing, so the row is simply absent after
      // a restart. Surfacing the failure in the UI is better than throwing,
      // and `persistError` is what the report reads.
      this.persistError = 'append-failed'
    }
    this.sinceAppend++
    if (this.sinceAppend >= ROLLUP_EVERY || this.needsRollup === true) {
      this.sinceAppend = 0
      this.needsRollup = false
      this.writeRollup()
    }
    return record
  }

  /** Fold every record into per-identity / per-model / per-day totals. */
  computeRollup() {
    return this.foldRecords(this.records)
  }

  /**
   * Fold a record subset into the same shape.
   *
   * Extracted from {@link computeRollup} so the session-scoped view reuses one
   * definition of every total. A second implementation for sessions would be a
   * second place for "what counts as a call" to drift, and the two figures
   * would disagree with no way for a reader to tell which is wrong.
   *
   * @param {object[]} list - records to fold.
   */
  foldRecords(list) {
    const byIdentity = Object.create(null)
    const byModel = Object.create(null)
    const byDay = Object.create(null)
    const byPool = Object.create(null)
    let calls = 0
    let usd = 0
    let unpriced = 0
    let missingUsage = 0
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let reasoningTokens = 0

    for (const rec of list) {
      if (rec.usageMissing === true) {
        missingUsage++
        continue
      }
      calls++
      const cost = typeof rec.usd === 'number' && Number.isFinite(rec.usd) ? rec.usd : 0
      if (rec.priced !== true) unpriced++
      usd += cost
      inputTokens += rec.inputTokens ?? 0
      outputTokens += rec.outputTokens ?? 0
      cacheReadTokens += rec.cacheReadTokens ?? 0
      cacheWriteTokens += rec.cacheWriteTokens ?? 0
      reasoningTokens += rec.reasoningTokens ?? 0

      const id = typeof rec.identity === 'string' ? rec.identity : 'unknown'
      const row = byIdentity[id] ?? (byIdentity[id] = {
        id,
        label: typeof rec.identityLabel === 'string' ? rec.identityLabel : id,
        keyRef: rec.keyRef ?? null,
        pool: typeof rec.pool === 'string' ? rec.pool : 'unknown',
        calls: 0, usd: 0, unpriced: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        routes: Object.create(null),
      })
      row.calls++
      row.usd += cost
      if (rec.priced !== true) row.unpriced++
      row.inputTokens += rec.inputTokens ?? 0
      row.outputTokens += rec.outputTokens ?? 0
      row.cacheReadTokens += rec.cacheReadTokens ?? 0
      row.cacheWriteTokens += rec.cacheWriteTokens ?? 0
      row.reasoningTokens += rec.reasoningTokens ?? 0
      if (typeof rec.route === 'string') row.routes[rec.route] = (row.routes[rec.route] ?? 0) + 1

      const poolKey = typeof rec.pool === 'string' ? rec.pool : 'unknown'
      const poolRow = byPool[poolKey] ?? (byPool[poolKey] = {
        pool: poolKey, calls: 0, usd: 0, unpriced: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      })
      poolRow.calls++
      if (rec.priced !== true) poolRow.unpriced++
      poolRow.usd += cost
      poolRow.inputTokens += rec.inputTokens ?? 0
      poolRow.outputTokens += rec.outputTokens ?? 0
      poolRow.cacheReadTokens += rec.cacheReadTokens ?? 0
      poolRow.cacheWriteTokens += rec.cacheWriteTokens ?? 0

      const modelKey = `${rec.route ?? 'unknown'}/${rec.model ?? 'unknown'}`
      const modelRow = byModel[modelKey] ?? (byModel[modelKey] = {
        key: modelKey, route: rec.route ?? null, model: rec.model ?? null,
        displayName: rec.displayName ?? null, calls: 0, usd: 0, unpriced: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      })
      modelRow.calls++
      if (rec.priced !== true) modelRow.unpriced++
      modelRow.usd += cost
      modelRow.inputTokens += rec.inputTokens ?? 0
      modelRow.outputTokens += rec.outputTokens ?? 0
      modelRow.cacheReadTokens += rec.cacheReadTokens ?? 0
      modelRow.cacheWriteTokens += rec.cacheWriteTokens ?? 0

      const day = dayKeyOf(rec.time)
      if (day !== null) {
        const dayRow = byDay[day] ?? (byDay[day] = {
          day, calls: 0, usd: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        })
        dayRow.calls++
        dayRow.usd += cost
        dayRow.inputTokens += rec.inputTokens ?? 0
        dayRow.outputTokens += rec.outputTokens ?? 0
        dayRow.cacheReadTokens += rec.cacheReadTokens ?? 0
        dayRow.cacheWriteTokens += rec.cacheWriteTokens ?? 0
      }
    }

    return {
      calls, usd, unpriced, missingUsage,
      inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
      byIdentity: Object.values(byIdentity).map((row) => ({
        ...row,
        // Only the top few routes are shown; keeping every route name for every
        // identity would bloat the payload for no reader.
        routes: Object.entries(row.routes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([route, count]) => ({ route, count })),
      })).sort((a, b) => b.usd - a.usd || b.calls - a.calls),
      byPool: Object.values(byPool).sort((a, b) => b.usd - a.usd),
      byModel: Object.values(byModel).sort((a, b) => b.usd - a.usd),
      byDay: Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    }
  }

  /** Persist the compact rollup, stamped with the fingerprint it folded. */
  writeRollup() {
    try {
      const rollup = {
        version: 1,
        foldedAt: Date.now(),
        records: this.records.length,
        fingerprint: fingerprint(this.recordsFile),
        totals: this.computeRollup(),
      }
      writeAtomic(this.rollupFile, JSON.stringify(rollup))
      this.persistError = undefined
      return rollup
    } catch {
      this.persistError = 'rollup-failed'
      return null
    }
  }

  /** Read the stored rollup, or null when it no longer describes the records. */
  readRollup() {
    if (!existsSync(this.rollupFile)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.rollupFile, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return null
      if (parsed.fingerprint !== fingerprint(this.recordsFile)) return null
      return parsed
    } catch {
      return null
    }
  }

  /**
   * Records belonging to one session, in capture order.
   *
   * Returns `[]` for an absent id rather than every record: a session-scoped
   * view that silently fell back to global totals would look like a quiet
   * session instead of a binding failure.
   */
  recordsForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return []
    return this.records.filter((rec) => rec.sessionId === sessionId)
  }
}

/** `YYYY-MM-DD` in local time, or null for a timestamp we cannot trust. */
export function dayKeyOf(time) {
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return null
  const d = new Date(time)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Ensure the parent directory of a file exists. */
export function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true })
}
