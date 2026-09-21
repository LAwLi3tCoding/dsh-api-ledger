/**
 * Host half of `dsh-api-ledger` — per-credential token and cost accounting.
 *
 * ## What it answers
 *
 * Per-route recorded usage and estimated cost. Grouping is configured by the
 * user; this module never treats an estimate as a remaining account balance.
 *
 * ## Why identity is a route, not a key
 *
 * The capture seam sees `GenerateOptions.provider` and nothing else. A key
 * VALUE must never be copied anywhere — it is resolved by the credentials
 * service at request time and stays there. So a credential is identified by its
 * REFERENCE (`EXAMPLE_GATEWAY_API_KEY`) and, when a route declares none, by its route
 * name. Two keys are separable exactly when they are two routes; that is a
 * configuration requirement, not a limitation this plugin can work around.
 *
 * ## Two traps this file is written around
 *
 * 1. **Nested `llm/stream` dispatch.** The waterfall runs every listener for
 *    every `ctx.llm.stream()` call. A wrapper route that calls `ctx.llm.stream()`
 *    again inside its own `stream()` re-enters the whole waterfall, so a naive
 *    listener records the same usage once per layer. An `AsyncLocalStorage`
 *    marker fixes it: the outer consumption marks the async context, an inner
 *    dispatch sees the marker and passes through without wrapping. Isolation is
 *    per async context, so concurrent calls do not interfere.
 *
 * 2. **`ctx.get('webServer')` at apply time.** The carrier may not have
 *    initialized yet; probing it here silently registers no route and the page
 *    gets a 405 from the SPA fallback. Both carriers are therefore mounted in
 *    child fibers via `ctx.inject([...], ...)`, which waits for the service and
 *    costs nothing when it never appears.
 */

import { readPreferences, savePreference } from './config.js'
import { randomBytes } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'

import { Ledger } from './records.js'
import { identityOf, resolveIdentities } from './identities.js'
import { USD_RATES, REFERENCE_MODELS, REFERENCE_RATES, REFERENCE_INFO, ratesFor, priceUsage, poolOf } from './pricing.js'

/** Marks an async context that is already inside the accounting wrapper. */
const accounting = new AsyncLocalStorage()

/** How long the identity directory is reused before it is rebuilt. */
const IDENTITY_TTL_MS = 30_000

/**
 * Resolve the ledger home.
 *
 * `$DSH_HOME` is honoured because the host may run under a different home than
 * the shell that started it; falling back to `~/.dsh` keeps a plain run
 * working. The subdirectory is created lazily on first append.
 */
function defaultHome(env = process.env) {
  const base = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(env.HOME ?? '.', '.dsh')
  return join(base, 'api-ledger')
}

/** Config file holding user overrides, beside the ledger's own data. */
const CONFIG_FILE = 'config.json'

export const name = 'dsh-api-ledger'

/**
 * No hard dependency, deliberately.
 *
 * Recording spend is useful on its own, and a hard dependency would hold this
 * fiber in `waiting` forever on a headless assembly with no HTTP carrier —
 * losing the history it exists to keep. Every capability is therefore an
 * optional probe or a child-fiber injection.
 */
export const inject = []

export function apply(ctx) {
  const home = defaultHome()
  const ledger = new Ledger({ home }).load()
  const configFile = join(home, CONFIG_FILE)
  const settingsToken = randomBytes(32).toString('hex')

  function overrides() {
    try {
      const { config, revision } = readPreferences(configFile)
      return { revision, pricing: config.pricing || {}, pools: config.pools || {}, labels: config.labels || {} }
    } catch {
      return { pricing: {}, pools: {}, labels: {}, error: 'invalid-config' }
    }
  }

  /** Cached route → credential-reference directory. */
  let identityCache = { at: 0, value: null }
  async function identities() {
    const now = Date.now()
    if (identityCache.value !== null && now - identityCache.at < IDENTITY_TTL_MS) return identityCache.value
    const value = await resolveIdentities({ llm: ctx.get('llm'), settings: ctx.get('settings') })
    identityCache = { at: now, value }
    return value
  }

  /**
   * One priced, identified record.
   *
   * `keyRef` stores the credential reference NAME only. No key value is read,
   * copied, or persisted here — and `base` freezes the rates used, so editing
   * the price book later cannot rewrite this call's cost.
   */
  function account(usage, options, startedAt) {
    const route = typeof options?.provider === 'string' ? options.provider : 'unknown'
    const model = typeof options?.model === 'string' ? options.model : 'unknown'
    const cfg = overrides()
    const matched = ratesFor(route, model, cfg.pricing)
    const pool = poolOf(route, matched === null ? null : matched.rates, cfg.pools)

    const priced = matched !== null
    const price = priced ? priceUsage(usage, matched.rates) : null

    const record = {
      seq: ledger.records.length,
      time: startedAt,
      sessionId: typeof options?.sessionId === 'string' ? options.sessionId : null,
      purpose: typeof options?.purpose === 'string' ? options.purpose : 'agent',
      route,
      model,
      identity: identityCache.value !== null ? identityOf(route, identityCache.value).id : route,
      identityLabel: identityCache.value !== null ? identityOf(route, identityCache.value).label : route,
      keyRef: identityCache.value !== null ? identityOf(route, identityCache.value).keyRef : null,
      pool,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      priced,
      usd: price === null ? 0 : price.usd,
      native: price === null ? 0 : price.native,
      currency: price === null ? null : price.currency,
      base: price === null ? null : price.base,
      priceSource: matched === null ? 'unpriced' : matched.source,
      matchedKey: matched === null ? null : matched.matchedKey,
    }
    ledger.append(record)
    return record
  }

  // ── capture ────────────────────────────────────────────────────────────────
  //
  // The `finally` block is the only place a call can be accounted for: the
  // stream may end, be abandoned, or throw. Accounting there means a cancelled
  // call is still billed — which is correct, because the provider bills it too.
  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    const downstream = next()

    // Inner layer of a wrapper route: the outer layer already accounted for
    // this usage. Pass the stream through untouched.
    if (accounting.getStore() !== undefined) return downstream

    // Use request start time consistently for recent-call and period views.
    const startedAt = Date.now()

    return (async function* ledgerStream() {
      let usage = null
      const iterator = downstream[Symbol.asyncIterator]()
      let completed = false
      try {
        for (;;) {
          // Pull inside the marker so a nested dispatch started by a wrapper
          // adapter inherits it and is recognized as already accounted.
          const step = await accounting.run(true, () => iterator.next())
          if (step.done === true) break
          const chunk = step.value
          if (chunk !== null && chunk !== undefined && chunk.type === 'usage' && chunk.usage !== null && chunk.usage !== undefined) {
            usage = chunk.usage
          }
          yield chunk
        }
        completed = true
      } finally {
        // A hand-rolled loop has none of `for await`'s auto-close semantics: a
        // consumer that breaks or throws must have `return()` propagated, or
        // the upstream HTTP stream keeps running to completion while nobody
        // reads its usage chunk — the provider bills it and we leak the socket.
        if (!completed) {
          try {
            await iterator.return?.()
          } catch {
            // Closing an already-failed stream is not itself an error worth
            // reporting; the failure that caused it has already surfaced.
          }
        }
        if (usage !== null) {
          try {
            await identities()
            account(usage, options, startedAt)
          } catch (error) {
            // Accounting must never break a completed model call.
            ctx.logger?.warn?.(`dsh-api-ledger: accounting failed: ${String(error)}`)
          }
        } else {
          // Report the omission instead of silently under-counting: a call with
          // no usage chunk means the totals are incomplete, and the UI says so.
          ledger.missingUsage++
        }
      }
    })()
  }), 'dsh-api-ledger: llm/stream accounting')

  const DAY_MS = 86_400_000

  /**
   * Totals for one time window, or zeros when no clock was supplied.
   *
   * Filtered on each record's own timestamp and folded with the same
   * `foldRecords` the global total uses, so a period can never disagree with
   * the whole about what counts as a call.
   */
  function periodTotals(since) {
    if (!Number.isFinite(since)) return { usd: 0, calls: 0 }
    const scoped = ledger.records.filter((rec) => Number(rec.time) >= since)
    const folded = ledger.foldRecords(scoped)
    return { usd: folded.usd, calls: folded.calls }
  }

  /**
   * Build the report the client renders. All amounts are USD.
   *
   * Both folds ship in one payload because the settings page and the
   * conversation tab mount independently: whichever opens first must not need a
   * second round trip.
   *
   * The CLOCK ARRIVES FROM THE CLIENT. "Today" is a local calendar day and the
   * host has no business guessing the browser's timezone; an absent clock yields
   * zeroed periods rather than a fabricated one.
   *
   * @param {object} [args]
   * @param {string} [args.sessionId] - session whose totals to include alongside the global ones.
   * @param {number} [args.now] - the reader's clock, in epoch ms.
   * @param {number} [args.todayStart] - the reader's local midnight, in epoch ms.
   */
  async function report(args = {}) {
    const a = args !== null && typeof args === 'object' ? args : {}
    const sessionId = typeof a.sessionId === 'string' && a.sessionId.length > 0 ? a.sessionId : null
    const now = Number.isFinite(Number(a.now)) ? Number(a.now) : 0
    const todayStart = Number.isFinite(Number(a.todayStart)) ? Number(a.todayStart) : 0

    const directory = await identities()
    const cfg = overrides()
    // Projection changes grouping and labels only; immutable prices stay intact.
    const projected = ledger.records.map(rec => ({ ...rec,
      identity: rec.route || 'unknown',
      identityLabel: cfg.labels[rec.route] || directory[rec.route]?.label || rec.route || 'unknown',
      pool: poolOf(rec.route || 'unknown', null, cfg.pools),
    }))
    const totals = ledger.foldRecords(projected)
    const knownRoutes = [...new Set([...Object.keys(directory).filter(r => directory[r].declared || directory[r].configured), ...projected.map(r => r.route).filter(Boolean), ...Object.keys(cfg.labels), ...Object.keys(cfg.pools), ...Object.keys(cfg.pricing).map(k => k.slice(0, k.indexOf('/'))).filter(Boolean)])]
    const routes = knownRoutes.map(route => ({
      active: !!(directory[route]?.declared || directory[route]?.configured),
      historical: projected.some(r => r.route === route),
      hasPreferences: Object.hasOwn(cfg.labels, route) || Object.hasOwn(cfg.pools, route) || Object.keys(cfg.pricing).some(k => k.startsWith(route + '/')),
      route, label: cfg.labels[route] || directory[route]?.label || route,
      group: cfg.pools[route] || '', keyRef: directory[route]?.keyRef || null,
      models: [...new Set([...(directory[route]?.models || []), ...projected.filter(r => r.route === route).map(r => r.model).filter(Boolean), ...Object.keys(cfg.pricing).filter(k => k.startsWith(route + '/')).map(k => k.slice(route.length + 1))])],
    }))
    const labels = Object.fromEntries(routes.map(r => [poolOf(r.route, null, cfg.pools), r.group || r.label]))
    const revision = cfg.revision || null

    const sessionRecords = sessionId === null ? [] : projected.filter(rec => rec.sessionId === sessionId)
    const scoped = sessionId === null ? projected : sessionRecords
    const rangeStart = a.range === 'today' ? todayStart : a.range === 'week' ? now - 7 * DAY_MS
      : a.range === 'month' ? now - 30 * DAY_MS : null
    const viewRecords = rangeStart === null ? scoped : scoped.filter((rec) => rangeStart > 0 && Number(rec.time) >= rangeStart)
    const view = ledger.foldRecords(viewRecords)
    const today = ledger.foldRecords(projected.filter((rec) => todayStart > 0 && Number(rec.time) >= todayStart))

    return {
      ok: true,
      generatedAt: Date.now(),
      home,
      // The raw line count, not `totals.calls`: a record that reported no usage
      // is excluded from the fold but is still a record the file holds.
      recordCount: ledger.records.length,
      missingUsage: totals.missingUsage + ledger.missingUsage,
      persistError: ledger.persistError ?? null,
      poolLabels: labels,
      settings: { token: settingsToken, revision, routes, pricing: cfg.pricing, referenceModels: REFERENCE_MODELS, referenceRates: REFERENCE_RATES, referenceInfo: REFERENCE_INFO, error: cfg.error || null },
      usdRates: USD_RATES,
      today,
      yesterday: Number(a.yesterdayStart) > 0 && Number(a.yesterdayStart) < todayStart
        ? ledger.foldRecords(projected.filter((rec) => Number(rec.time) >= Number(a.yesterdayStart) && Number(rec.time) < todayStart)) : null,
      recent: viewRecords.filter((rec) => rec.usageMissing !== true).slice().sort((a, b) => Number(b.time) - Number(a.time)).slice(0, 15).map((rec) => ({
        time: rec.time, route: rec.route, model: rec.model, pool: rec.pool,
        inputTokens: rec.inputTokens, outputTokens: rec.outputTokens,
        cacheReadTokens: rec.cacheReadTokens, cacheWriteTokens: rec.cacheWriteTokens,
        priced: rec.priced === true, usd: rec.usd, priceSource: rec.priceSource, currency: rec.currency, base: rec.base,
      })),
      view,
      // Each chart and amount keeps its billing pool. Never use a combined
      // amount as if it were a deduction from one personal balance.
      viewPools: view.byPool.map((pool) => ({
        pool: pool.pool,
        totals: ledger.foldRecords(viewRecords.filter((rec) => (rec.pool ?? 'unknown') === pool.pool)),
      })),
      totals,
      // Null rather than an empty fold when no session was asked for: the tab
      // must be able to tell "this session spent nothing" from "no session was
      // addressed", and only one of those is worth showing the user.
      session: sessionId === null
        ? null
        : { sessionId, totals: ledger.foldRecords(sessionRecords) },
      periods: {
        today: periodTotals(todayStart > 0 ? todayStart : (now > 0 ? now - DAY_MS : NaN)),
        week: periodTotals(now > 0 ? now - 7 * DAY_MS : NaN),
        month: periodTotals(now > 0 ? now - 30 * DAY_MS : NaN),
      },
      pools: cfg.pools,
    }
  }

  /**
   * Read a JSON request body, degrading to `{}` on anything unparseable.
   *
   * The body carries the browser's clock, so a malformed one must cost only the
   * period figures — never the whole report. `req.on('error')` resolves rather
   * than rejects for the same reason: a broken socket should still get the
   * global numbers back.
   */
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let text = ''
      req.on('data', (chunk) => { if (text.length + chunk.length > 65536) { reject(new Error('body-too-large')); return } text += chunk })
      req.on('end', () => {
        if (text.length === 0) {
          resolve({})
          return
        }
        try {
          const parsed = JSON.parse(text)
          resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })
  }

  // ── carriers ───────────────────────────────────────────────────────────────

  // Preferred: the Connection RPC channel the client generation already uses.
  // Mounted in a child fiber because the service may not be ready when `apply`
  // runs, and because DSH 0.1.5 `rpc.handle` can throw for every caller (it
  // resolves services from the Connection plugin's own fiber). That throw would
  // otherwise kill this child silently and leave the page on HTTP 405.
  ctx.inject(['connection'], (child) => {
    try {
      const dispose = child.connection.rpc.handle('/api-ledger', {
        report: async (args) => report(args),
        savePreference: async (args) => {
          const data = await report()
          return savePreference(configFile, args, data.settings.routes.map(r => r.route))
        },
      })
      child.effect(() => () => { void dispose() }, 'dsh-api-ledger: rpc channel')
    } catch (error) {
      child.logger?.warn?.(`dsh-api-ledger: rpc channel unavailable: ${String(error)}`)
    }
  })

  // Compatibility carrier: a plain HTTP route, also useful for `curl`ing the
  // numbers out of a script.
  ctx.inject(['webServer'], (child) => {
    child.webServer.register({
      kind: 'exact', path: '/api-ledger/preferences',
      handler: async (req, res) => {
        const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
        const origin = req.headers?.origin
        let originHost = null
        try { originHost = new URL(origin).host } catch {}
        if (req.method !== 'POST' || originHost !== req.headers?.host || !String(req.headers?.['content-type']).startsWith('application/json')) {
          send(403, { ok: false, error: 'same-origin-required' }); return
        }
        try {
          const args = await readJsonBody(req)
          if (args.token !== settingsToken) { send(403, { ok: false, error: 'invalid-token' }); return }
          const data = await report()
          send(200, savePreference(configFile, args, data.settings.routes.map(r => r.route)))
        } catch (error) { send(400, { ok: false, error: error.message }) }
      },
    })

    child.webServer.register({
      kind: 'exact',
      path: '/api-ledger/report',
      handler: async (req, res) => {
        const send = (payload, status = 200) => {
          res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(JSON.stringify(payload))
        }
        try {
          if (req.method !== 'GET' && req.method !== 'POST') {
            send({ ok: false, error: 'method-not-allowed' }, 405)
            return
          }
          // The browser's clock rides in the body, so this carrier must read it
          // rather than answering from the URL alone — otherwise the periods
          // would silently zero out on the fallback path while working over RPC.
          send(await report(await readJsonBody(req)))
        } catch (error) {
          send({ ok: false, error: error?.message ?? String(error) }, 500)
        }
      },
    })
  })
}
