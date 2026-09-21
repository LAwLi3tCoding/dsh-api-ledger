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

// Account ownership is configured locally; no route names imply a billing group.
export const DEFAULT_POOLS = Object.freeze({})
function rate(inputPerM, outputPerM, cacheReadPerM, currency, pool, cacheWritePerM = 0) {
  return Object.freeze({ inputPerM, outputPerM, cacheReadPerM, cacheWritePerM, currency, pool })
}

/** Explicit reference snapshots, never an automatic tariff or live invoice. */
export const REFERENCE_INFO = Object.freeze({
  url: 'https://api-docs.deepseek.com/quick_start/pricing/',
  checkedAt: '2026-09-21',
  basis: 'off-peak',
})
export const REFERENCE_RATES = Object.freeze({
  'deepseek-flash': rate(0.15, 0.6, 0.003, 'USD', 'unknown'),
  'deepseek-v4-flash': rate(0.15, 0.6, 0.003, 'USD', 'unknown'),
  'deepseek-v4-flash-vision-exp': rate(0.15, 0.6, 0.003, 'USD', 'unknown'),
  'deepseek-v4-pro': rate(0.66, 1.98, 0.022, 'USD', 'unknown'),
})

// Holiday dates follow the 2026 State Council holiday notice. Chinese local dates.
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
const HOLIDAYS_2026 = [ ['01-01','01-03'], ['02-15','02-23'], ['04-04','04-06'],
  ['05-01','05-05'], ['06-19','06-21'], ['09-25','09-27'], ['10-01','10-07'] ]

/** A verified public tariff snapshot, not a live price feed or invoice. */
export function officialRates(model, time) {
  const base = Object.hasOwn(REFERENCE_RATES, model) ? REFERENCE_RATES[model] : null
  const date = new Date(time)
  if (!base || !Number.isFinite(date.getTime())) return null
  const chinaDate = new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  // Unknown calendars must not silently overcharge holidays in a new year.
  if (!chinaDate.startsWith('2026-')) return null
  const holiday = HOLIDAYS_2026.some(([start, end]) => chinaDate.slice(5) >= start && chinaDate.slice(5) <= end)
  const hour = date.getUTCHours()
  const peak = !holiday && date.getUTCDay() >= 1 && date.getUTCDay() <= 5
    && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
  const factor = peak ? 2 : 1
  return { rates: { ...base, inputPerM: base.inputPerM * factor,
    outputPerM: base.outputPerM * factor, cacheReadPerM: base.cacheReadPerM * factor },
    source: 'official', matchedKey: model, tariff: peak ? 'peak' : 'off-peak',
    checkedAt: REFERENCE_INFO.checkedAt }
}

/** Flag the legacy USD numbers mistakenly tagged as CNY; never rewrite records. */
export function suspectCurrency(record) {
  const ref = Object.hasOwn(REFERENCE_RATES, record.model) ? REFERENCE_RATES[record.model] : null
  return !!ref && record.currency === 'CNY' && record.base?.currency === 'CNY'
    && ['inputPerM', 'outputPerM', 'cacheReadPerM'].every(k => record.base[k] === ref[k])
}

/** Explicit choices take precedence; verified official endpoints have a tariff default. */
export function ratesFor(route, model, overrides = {}, context = {}) {
  const key = `${route}/${model}`
  const value = Object.hasOwn(overrides, key) ? overrides[key] : { mode: context.official ? 'official' : 'none' }
  if (value?.mode === 'official') return context.official ? officialRates(model, context.time) : null
  if (value?.mode === 'reference') {
    const rates = REFERENCE_RATES[model]
    return rates ? { rates, source: 'reference', matchedKey: model } : null
  }
  if (value?.mode === 'none') return null
  const rates = normalizeOverride(value)
  return rates ? { rates, source: 'custom', matchedKey: key } : null
}

export const REFERENCE_MODELS = Object.freeze(Object.keys(REFERENCE_RATES))

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

/** Explicit display groups are independent from historical prices and credentials. */
export function poolOf(route, rates, pools = {}) {
  if (Object.hasOwn(pools, route) && typeof pools[route] === 'string' && pools[route].length) return `group:${pools[route]}`
  return `route:${route}`
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
