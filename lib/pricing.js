/**
 * Price book for `dsh-api-ledger`.
 *
 * The ledger answers two questions that a single global price table cannot:
 *
 *   1. Which CREDENTIAL paid — one route per key (see `identities.js`).
 *   2. What THAT route costs — which is not a function of the model id alone.
 *
 * (2) is the reason this file exists. The same model id (`deepseek-v4-flash`)
 * is served both by the DeepSeek official endpoint and by a corporate gateway,
 * at different prices. Looking a model id up in a public catalog prices the
 * gateway at the public rate and silently reports a number nobody can
 * reconcile against. Every rate here is therefore addressed by `route/model`,
 * never by model alone.
 *
 * Amounts are per ONE MILLION tokens, stored in the currency the vendor bills
 * in. USD is the reporting basis; `usdRates` converts.
 *
 * Correction policy: a record stores the rates it was priced with (its `base`).
 * Changing this table therefore never rewrites history — it only prices calls
 * made after the edit. That property is deliberate; do not "recalculate" old
 * records from the current table.
 */

/** Reporting basis. Every total the client renders is derived from USD. */
export const REPORTING_CURRENCY = 'USD'

/**
 * USD per one unit of the billing currency.
 *
 * A fixed table rather than a fetched rate: a wrong-but-stable number is
 * auditable, while a rate that silently drifts between two page loads makes
 * cost deltas meaningless. Update it by hand when the rate moves materially.
 */
export const USD_RATES = Object.freeze({ USD: 1, CNY: 0.14 })

const M = 1_000_000

/**
 * Route-addressed price book.
 *
 * Keys are `route/model`. A route with no entry here falls back to
 * {@link catalogRates}, and an unknown model is reported as unpriced rather
 * than assumed to cost zero — "we do not know" and "it is free" are different
 * claims and the UI must keep them apart.
 *
 * `pool` names the quota pool the credential draws on. Costs from different
 * pools are never summed: a corporate gateway that does not consume the
 * personal DeepSeek balance must not inflate (or be hidden by) that balance.
 */
const ROUTE_RATES = Object.freeze({
  // Personal DeepSeek balance — peak/off-peak pricing is applied by the caller.
  'deepseek-official/deepseek-flash': rate(0.15, 0.6, 0.003, 'CNY', 'personal-deepseek'),
  'deepseek-official/deepseek-v4-pro': rate(1.32, 3.96, 0.044, 'CNY', 'personal-deepseek'),

  // Corporate gateway. Billed at the public rate, but on its OWN pool: the
  // token spend is real, the personal balance is untouched.
  'exampleGateway/deepseek-v4-flash': rate(0.44, 1.32, 0.014, 'CNY', 'corporate'),
  'gateway/deepseek-v4-flash': rate(0.44, 1.32, 0.014, 'CNY', 'corporate'),

  // Third-party subscription route.
  'openai-codex/gpt-5.6-luna': rate(0.2, 1.2, 0.02, 'USD', 'third-party'),
})

/** Build one rate row. Input/output/cache are per million tokens. */
function rate(inputPerM, outputPerM, cacheReadPerM, currency, pool, cacheWritePerM = 0) {
  return Object.freeze({ inputPerM, outputPerM, cacheReadPerM, cacheWritePerM, currency, pool })
}

/**
 * Route names that address a pool but are not in the table, so an equivalent
 * model id still prices. Matched by exact route name first, then by this map.
 */
const ROUTE_ALIASES = Object.freeze({
  'gateway-main': 'gateway',
  'gateway-backup': 'gateway',
})

/**
 * Which quota pool a route draws on, as DATA rather than as code.
 *
 * This has to be user-editable: adding a third key behind the same gateway, or
 * moving a route to a different subscription, must not require editing the
 * plugin. A route absent from both this table and the rate rows resolves to
 * `'unknown'`, which the report surfaces instead of folding it into a real
 * pool — an unclassified route quietly joining `corporate` would make that
 * pool's total wrong in a way no reader could detect.
 *
 * `poolOf` is consulted by route name only, never by model, because the pool
 * is a property of the credential, not of the model served through it.
 */
export const DEFAULT_POOLS = Object.freeze({
  'deepseek-official': 'personal-deepseek',
  'exampleGateway': 'corporate',
  'gateway': 'corporate',
  'gateway-main': 'corporate',
  'gateway-backup': 'corporate',
  'openai-codex': 'third-party',
})

/** Human labels for the known pools, so the UI never prints a raw slug. */
export const POOL_LABELS = Object.freeze({
  'personal-deepseek': 'DeepSeek 官方额度',
  'corporate': '企业网关额度',
  'third-party': '第三方订阅',
  'unknown': '未归类',
})

/**
 * Public-catalog fallback, keyed by MODEL id, used only when no entry and no
 * alias matched. Rates here are last-resort and carry `pool: 'unknown'` so the
 * report can flag them instead of quietly folding them into a real pool.
 */
const CATALOG_RATES = Object.freeze({
  'deepseek-flash': rate(0.15, 0.6, 0.003, 'CNY', 'unknown'),
  'deepseek-v4-flash': rate(0.44, 1.32, 0.014, 'CNY', 'unknown'),
  'deepseek-v4-pro': rate(1.32, 3.96, 0.044, 'CNY', 'unknown'),
  'gpt-5.6-luna': rate(0.2, 1.2, 0.02, 'USD', 'unknown'),
})

/**
 * Resolve the rates for one call.
 *
 * @param {string} route - provider route name from `GenerateOptions.provider`.
 * @param {string} model - model id from `GenerateOptions.model`.
 * @param {Record<string, object>} [overrides] - user edits, addressed by
 *   `route/model`. Checked before anything else, because an explicit edit is
 *   the user correcting us.
 * @returns {{ rates: object, source: 'override' | 'route' | 'alias' | 'catalog', matchedKey: string } | null}
 *   `null` when nothing matched — the caller records the call as UNPRICED.
 */
export function ratesFor(route, model, overrides) {
  const key = `${route}/${model}`

  if (overrides && typeof overrides === 'object' && Object.hasOwn(overrides, key)) {
    const entry = normalizeOverride(overrides[key])
    if (entry !== null) return { rates: entry, source: 'override', matchedKey: key }
  }

  if (Object.hasOwn(ROUTE_RATES, key)) {
    return { rates: ROUTE_RATES[key], source: 'route', matchedKey: key }
  }

  const alias = ROUTE_ALIASES[route]
  if (alias !== undefined) {
    const aliasKey = `${alias}/${model}`
    if (Object.hasOwn(ROUTE_RATES, aliasKey)) {
      return { rates: ROUTE_RATES[aliasKey], source: 'alias', matchedKey: aliasKey }
    }
  }

  if (Object.hasOwn(CATALOG_RATES, model)) {
    return { rates: CATALOG_RATES[model], source: 'catalog', matchedKey: model }
  }

  return null
}

/**
 * Coerce one user override into a complete rate row, or reject it.
 *
 * A partial override is rejected rather than merged: a row carrying the user's
 * output price beside our input price would produce a number that matches
 * neither, and nothing downstream could tell.
 */
export function normalizeOverride(value) {
  if (value === null || typeof value !== 'object') return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  const inputPerM = num(value.inputPerM)
  const outputPerM = num(value.outputPerM)
  const cacheReadPerM = num(value.cacheReadPerM ?? 0)
  const cacheWritePerM = num(value.cacheWritePerM ?? 0)
  if (inputPerM === null || outputPerM === null || cacheReadPerM === null || cacheWritePerM === null) return null
  const currency = value.currency === 'USD' || value.currency === 'CNY' ? value.currency : null
  if (currency === null) return null
  return Object.freeze({
    inputPerM,
    outputPerM,
    cacheReadPerM,
    cacheWritePerM,
    currency,
    pool: typeof value.pool === 'string' && value.pool.length > 0 ? value.pool : 'unknown',
  })
}

/**
 * Resolve the quota pool for one route.
 *
 * Order: explicit pool map, then the matched rate row's own pool, then the
 * route's own prefix. The last step catches a route whose model never matched
 * a rate — an unpriced call still belongs to a credential, and knowing whose
 * balance it drew on is useful even when its cost cannot be computed.
 *
 * @param {string} route
 * @param {object|null} rates - matched rate row, or null when unpriced.
 * @param {Record<string, string>} [pools] - user overrides for {@link DEFAULT_POOLS}.
 */
export function poolOf(route, rates, pools) {
  const table = pools && typeof pools === 'object' ? pools : DEFAULT_POOLS
  if (typeof table[route] === 'string' && table[route].length > 0) return table[route]
  if (rates !== null && typeof rates.pool === 'string' && rates.pool.length > 0) return rates.pool
  if (typeof DEFAULT_POOLS[route] === 'string') return DEFAULT_POOLS[route]
  return 'unknown'
}

/**
 * Price one usage sample.
 *
 * Cache reads are billed separately from uncached input because they differ by
 * orders of magnitude on every route here; treating a cache read as input
 * would overstate spend by ~100x on a long session.
 *
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} usage
 * @param {object} rates - a row from {@link ratesFor}.
 * @returns {{ usd: number, native: number, currency: string, pool: string, base: object }}
 */
export function priceUsage(usage, rates) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  // `inputTokens` on the wire counts UNCACHED input on every adapter observed
  // here, so cache read/write are added as their own buckets, never subtracted
  // from it. An adapter that reports the total instead would need its own
  // normalization; guessing which convention is in play would corrupt totals.
  const native =
    (n(usage.inputTokens) * rates.inputPerM
      + n(usage.outputTokens) * rates.outputPerM
      + n(usage.cacheReadTokens) * rates.cacheReadPerM
      + n(usage.cacheWriteTokens) * rates.cacheWritePerM) / M

  const fx = USD_RATES[rates.currency] ?? 0
  return {
    usd: native * fx,
    native,
    currency: rates.currency,
    pool: rates.pool,
    // Stored on the record so a later price edit cannot rewrite this call's
    // cost. Also what makes the report explainable: each row shows its rates.
    base: {
      inputPerM: rates.inputPerM,
      outputPerM: rates.outputPerM,
      cacheReadPerM: rates.cacheReadPerM,
      cacheWritePerM: rates.cacheWritePerM,
      currency: rates.currency,
    },
  }
}

/** Human-readable formatting shared by the host payload and its tests. */
export function describeRates(rates) {
  if (rates === null || typeof rates !== 'object') return 'unpriced'
  const unit = rates.currency === 'USD' ? '$' : '¥'
  return `${unit}${rates.inputPerM}/${unit}${rates.outputPerM} per Mtok`
}
