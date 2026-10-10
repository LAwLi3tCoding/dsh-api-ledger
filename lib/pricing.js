/**
 * Price books for `dsh-api-ledger`.
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
 * Three ideas, deliberately separate:
 *
 *   1. A PRICE BOOK (`tariff`) is a table of model → rates plus the source and
 *      verification date it came from.
 *   2. A SCHEDULE, carried by the book and optional, moves those rates over
 *      time: peak windows, the weekdays they apply to, and the holiday
 *      calendar of ONE time zone.
 *   3. A BINDING says which book a `route/model` uses — and nothing else.
 *      Whether the route "really is" the vendor is NOT part of that decision:
 *      a gateway reselling the same models can bind the same public book, as
 *      long as the user says so.
 *
 * (3) used to be implicit and that was the bug: the built-in table was
 * reachable only from endpoints recognized as the vendor's own. That conflated
 * "this book holds the vendor's published prices" with "this route is the
 * vendor", so peak/off-peak was unreachable for every other route serving the
 * same models. Recognition now only picks the DEFAULT; it no longer grants or
 * withholds the capability.
 *
 * Amounts are per ONE MILLION tokens, stored in the currency the vendor bills
 * in. USD is the reporting basis; `usdRates` converts.
 *
 * Correction policy: a record stores the rates it was priced with (its `base`).
 * Changing a book therefore never rewrites history — it only prices calls made
 * after the edit. That property is deliberate; do not "recalculate" old
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
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 160
  && !/[\x00-\x1f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)

// Account ownership is configured locally; no route names imply a billing group.
export const DEFAULT_POOLS = Object.freeze({})

/** One row of a price book: rates per million tokens, plus how to bill it. */
function rate(inputPerM, outputPerM, cacheReadPerM, currency, pool, cacheWritePerM = 0) {
  return Object.freeze({ inputPerM, outputPerM, cacheReadPerM, cacheWritePerM, currency, pool })
}

const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])

// Holiday dates follow the 2026 State Council holiday notice. Chinese local dates.
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
const HOLIDAYS_2026 = Object.freeze([
  ['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
  ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07'],
].map(range => Object.freeze(range)))

/** The built-in book keeps this id forever: bindings refer to it by name. */
export const BUILTIN_TARIFF_ID = 'deepseek-public-2026'

/**
 * The DeepSeek public price list, as verified on the date below.
 *
 * `basis: 'off-peak'` states what the numbers MEAN: they are the discounted
 * rates, and `peak.multiplier` scales them up inside `peak.windows`. Stating
 * the basis is what lets a second book be written the other way round (peak
 * rates scaled DOWN off-peak) without the code guessing.
 *
 * A verified snapshot, never a live price feed or an invoice.
 */
export const BUILTIN_TARIFF = Object.freeze({
  id: BUILTIN_TARIFF_ID,
  label: 'DeepSeek public price list',
  currency: 'USD',
  timeZone: 'Asia/Shanghai',
  verifiedAt: '2026-09-21',
  source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  basis: 'off-peak',
  peak: Object.freeze({
    days: 'mon-fri',
    windows: Object.freeze(['09:00-12:00', '14:00-18:00']),
    multiplier: 2,
  }),
  holidays: Object.freeze({ 2026: HOLIDAYS_2026 }),
  models: Object.freeze({
    'deepseek-flash': rate(0.15, 0.6, 0.003, 'USD', 'unknown'),
    'deepseek-v4-flash': rate(0.15, 0.6, 0.003, 'USD', 'unknown'),
    'deepseek-v4-flash-vision-exp': rate(0.15, 0.6, 0.003, 'USD', 'unknown'),
    'deepseek-v4-pro': rate(0.66, 1.98, 0.022, 'USD', 'unknown'),
  }),
})

/** Books shipped with the plugin. A user book never replaces one of these. */
export const BUILTIN_TARIFFS = Object.freeze({ [BUILTIN_TARIFF_ID]: BUILTIN_TARIFF })

/** Explicit reference snapshot metadata, kept for the settings payload. */
export const REFERENCE_INFO = Object.freeze({
  url: BUILTIN_TARIFF.source,
  checkedAt: BUILTIN_TARIFF.verifiedAt,
  basis: BUILTIN_TARIFF.basis,
})

/** The built-in book's base rates, keyed by model. */
export const REFERENCE_RATES = BUILTIN_TARIFF.models
export const REFERENCE_MODELS = Object.freeze(Object.keys(REFERENCE_RATES))

// ── schedule ─────────────────────────────────────────────────────────────────

/** One time zone's formatter, cached: building it per call is the expensive part. */
const ZONE_FORMATTERS = new Map()

/**
 * One instant as it reads on a wall clock in `timeZone`.
 *
 * Every part of a schedule decision — date, weekday, clock time — comes from
 * HERE, so a book can never mix two zones. (An earlier version judged the
 * weekday in UTC and the holiday in Asia/Shanghai, which disagreed for eight
 * hours of every day.)
 */
function zonedParts(time, timeZone) {
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) return null
  const zone = typeof timeZone === 'string' && timeZone.length > 0 ? timeZone : 'UTC'
  try {
    let formatter = ZONE_FORMATTERS.get(zone)
    if (formatter === undefined) {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hour12: false, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
      })
      ZONE_FORMATTERS.set(zone, formatter)
    }
    const fields = Object.create(null)
    for (const part of formatter.formatToParts(date)) fields[part.type] = part.value
    // `hour12: false` can still report "24" for midnight on some ICU builds.
    const hour = Number(fields.hour) % 24
    const minute = Number(fields.minute)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
    return {
      stamp: `${fields.month}-${fields.day}`,
      year: fields.year,
      hour,
      minute,
      weekday: typeof fields.weekday === 'string' ? fields.weekday.toLowerCase().slice(0, 3) : '',
    }
  } catch {
    return null
  }
}

function minutesOf(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(typeof text === 'string' ? text.trim() : '')
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null
}

/** Peak windows are half-open: `09:00-12:00` covers 11:59 and not 12:00. */
function inWindow(spec, hour, minute) {
  const parts = typeof spec === 'string' ? spec.split('-') : []
  const start = minutesOf(parts[0])
  const end = minutesOf(parts[1])
  if (start === null || end === null) return false
  const now = hour * 60 + minute
  return now >= start && now < end
}

/** `all`, one day, a comma list, or a wrap-around range like `fri-mon`. */
function dayMatches(spec, weekday) {
  if (typeof spec !== 'string' || weekday === '') return false
  const wanted = spec.trim().toLowerCase()
  if (wanted === 'all') return true
  const index = WEEKDAYS.indexOf(weekday)
  if (index < 0) return false
  return wanted.split(',').some((part) => {
    const bounds = part.trim().split('-')
    const from = WEEKDAYS.indexOf(bounds[0])
    const to = bounds[1] === undefined ? from : WEEKDAYS.indexOf(bounds[1])
    if (from < 0 || to < 0) return false
    return from <= to ? index >= from && index <= to : index >= from || index <= to
  })
}

/**
 * Which of a book's windows one call falls in.
 *
 * `unknown` is a real answer and must stay one: a book that HAS peak rules but
 * no calendar for that year cannot be priced without guessing, and guessing
 * overcharges every holiday in a calendar we do not hold.
 */
function windowState(book, time) {
  if (!plain(book.peak)) return { state: 'base', multiplier: 1 }
  const parts = zonedParts(time, book.timeZone)
  if (parts === null) return { state: 'unknown', multiplier: 1 }
  const holidays = plain(book.holidays) ? book.holidays[parts.year] : undefined
  if (!Array.isArray(holidays)) return { state: 'unknown', multiplier: 1 }
  const holiday = holidays.some(range => Array.isArray(range) && range.length === 2
    && parts.stamp >= range[0] && parts.stamp <= range[1])
  const windows = Array.isArray(book.peak.windows) ? book.peak.windows : []
  const peak = !holiday && dayMatches(book.peak.days, parts.weekday)
    && windows.some(spec => inWindow(spec, parts.hour, parts.minute))
  const factor = Number(book.peak.multiplier)
  return { state: peak ? 'peak' : 'base', multiplier: peak && Number.isFinite(factor) && factor > 0 ? factor : 1 }
}

/**
 * Price one model on one book at one instant.
 *
 * `mode: 'base'` deliberately ignores the schedule — that is how a fixed
 * snapshot is expressed now, and why a book can offer both readings.
 *
 * @returns {{ rates: object, priceBook: string, priceBookLabel: string, window: 'peak'|'base', multiplier: number, matchedKey: string }|null}
 */
export function evaluateTariff(book, model, time, mode = 'auto') {
  if (!plain(book) || !plain(book.models) || typeof model !== 'string') return null
  if (!Object.hasOwn(book.models, model)) return null
  let state = { state: 'base', multiplier: 1 }
  if (mode !== 'base') {
    state = windowState(book, time)
    if (state.state === 'unknown') return null
  }
  const base = book.models[model]
  const factor = state.multiplier
  const rates = factor === 1 ? { ...base } : {
    ...base,
    inputPerM: base.inputPerM * factor,
    outputPerM: base.outputPerM * factor,
    cacheReadPerM: base.cacheReadPerM * factor,
    cacheWritePerM: (base.cacheWritePerM || 0) * factor,
  }
  return {
    rates,
    priceBook: book.id,
    priceBookLabel: typeof book.label === 'string' && book.label.length > 0 ? book.label : book.id,
    window: state.state === 'peak' ? 'peak' : 'base',
    multiplier: factor,
    matchedKey: model,
  }
}

/**
 * The built-in book keyed by model alone, in the shape the ledger has always
 * recorded (`tariff` is the TIME WINDOW here, not a book id).
 */
export function officialRates(model, time) {
  const hit = evaluateTariff(BUILTIN_TARIFF, model, time, 'auto')
  if (hit === null) return null
  return {
    rates: hit.rates,
    source: 'official',
    matchedKey: hit.matchedKey,
    tariff: hit.window === 'peak' ? 'peak' : 'off-peak',
    checkedAt: REFERENCE_INFO.checkedAt,
  }
}

// ── user books ───────────────────────────────────────────────────────────────

/** Coerce one book row, defaulting cache and currency from its book. */
function normalizeBookRates(row, currency) {
  if (!plain(row)) return null
  const num = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
  const inputPerM = num(row.inputPerM)
  const outputPerM = num(row.outputPerM)
  const cacheReadPerM = num(row.cacheReadPerM ?? 0)
  const cacheWritePerM = num(row.cacheWritePerM ?? 0)
  if (inputPerM === null || outputPerM === null || cacheReadPerM === null || cacheWritePerM === null) return null
  const unit = row.currency === 'USD' || row.currency === 'CNY' ? row.currency : currency
  return Object.freeze({
    inputPerM, outputPerM, cacheReadPerM, cacheWritePerM,
    currency: unit === 'CNY' ? 'CNY' : 'USD',
    pool: 'unknown',
  })
}

/**
 * Validate one user-defined book, or reject it.
 *
 * Malformed input costs only that book: a typo in `config.json` must never
 * take down the whole price list, because the ledger would then report nothing
 * rather than report everything it does understand.
 */
export function normalizeTariff(id, raw) {
  if (!safeId(id) || id === BUILTIN_TARIFF_ID || !plain(raw)) return null
  const currency = raw.currency === 'CNY' ? 'CNY' : 'USD'
  const models = Object.create(null)
  if (plain(raw.models)) {
    for (const [model, row] of Object.entries(raw.models)) {
      if (!safeId(model)) continue
      const rates = normalizeBookRates(row, currency)
      if (rates !== null) models[model] = rates
    }
  }
  if (Object.keys(models).length === 0) return null

  const book = {
    id,
    label: safeId(raw.label) ? raw.label : id,
    currency,
    timeZone: typeof raw.timeZone === 'string' && raw.timeZone.length > 0 ? raw.timeZone.slice(0, 60) : 'Asia/Shanghai',
    verifiedAt: typeof raw.verifiedAt === 'string' ? raw.verifiedAt.slice(0, 40) : null,
    source: typeof raw.source === 'string' ? raw.source.slice(0, 300) : null,
    basis: typeof raw.basis === 'string' ? raw.basis.slice(0, 40) : null,
    models: Object.freeze(models),
  }
  const peak = plain(raw.peak) ? raw.peak : null
  if (peak !== null && typeof peak.days === 'string' && Array.isArray(peak.windows)) {
    const windows = peak.windows.filter(spec => typeof spec === 'string')
    const multiplier = Number(peak.multiplier)
    if (windows.length > 0 && Number.isFinite(multiplier) && multiplier > 0) {
      book.peak = Object.freeze({ days: peak.days.slice(0, 80), windows: Object.freeze(windows.slice(0, 24)), multiplier })
    }
  }
  if (plain(raw.holidays)) {
    const holidays = Object.create(null)
    for (const [year, ranges] of Object.entries(raw.holidays)) {
      if (!/^\d{4}$/.test(year) || !Array.isArray(ranges)) continue
      const kept = ranges
        .filter(range => Array.isArray(range) && range.length === 2 && range.every(day => typeof day === 'string'))
        .map(range => Object.freeze([range[0].slice(0, 10), range[1].slice(0, 10)]))
      if (kept.length > 0) holidays[year] = Object.freeze(kept)
    }
    if (Object.keys(holidays).length > 0) book.holidays = Object.freeze(holidays)
  }
  return Object.freeze(book)
}

/** Built-ins plus every valid user book. A built-in id always wins. */
export function resolveTariffs(userTariffs) {
  const registry = Object.create(null)
  if (plain(userTariffs)) {
    for (const [id, raw] of Object.entries(userTariffs)) {
      const book = normalizeTariff(id, raw)
      if (book !== null) registry[id] = book
    }
  }
  for (const [id, book] of Object.entries(BUILTIN_TARIFFS)) registry[id] = book
  return registry
}

/** Books in a stable display order: built-ins first, then user books by label. */
export function tariffList(tariffs) {
  const books = plain(tariffs) ? Object.values(tariffs) : []
  return books.sort((a, b) => {
    const builtin = (a.id === BUILTIN_TARIFF_ID ? 0 : 1) - (b.id === BUILTIN_TARIFF_ID ? 0 : 1)
    if (builtin !== 0) return builtin
    const left = String(a.label || a.id).toLowerCase()
    const right = String(b.label || b.id).toLowerCase()
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/**
 * Coerce one stored binding into an intent, or reject it.
 *
 * The two legacy spellings keep their exact old meaning — including the
 * endpoint gate on `official` — because records already priced under them must
 * keep reading the same way. New bindings use `tariff`.
 */
function normalizeBinding(value) {
  if (!plain(value)) return null
  if (value.mode === 'none') return { kind: 'none' }
  if (value.mode === 'custom') return { kind: 'custom' }
  if (value.mode === 'tariff') {
    if (!safeId(value.tariff)) return null
    return { kind: 'tariff', tariff: value.tariff, window: value.window === 'base' ? 'base' : 'auto' }
  }
  if (value.mode === 'official') return { kind: 'legacy-official' }
  if (value.mode === 'reference') return { kind: 'legacy-reference' }
  return null
}

/** Attach the schedule verdict to a priced hit in the ledger's record shape. */
function withWindow(hit, source) {
  return {
    rates: hit.rates,
    source,
    matchedKey: hit.matchedKey,
    tariff: hit.window === 'peak' ? 'peak' : 'off-peak',
    priceBook: hit.priceBook,
    priceBookLabel: hit.priceBookLabel,
    multiplier: hit.multiplier,
  }
}

/**
 * Resolve one `route/model` to rates.
 *
 * An entry that EXISTS always decides: a partial or unrecognized row resolves
 * to "unpriced", never to a default, because falling back would attribute a
 * price the user did not ask for. Only the absence of an entry lets endpoint
 * recognition pick the built-in book.
 *
 * @param {object} [context]
 * @param {boolean} [context.official] - the route is the vendor's own endpoint.
 * @param {number} [context.time] - request start, in epoch ms.
 * @param {object} [context.books] - tariff registry; built-ins when omitted.
 */
export function ratesFor(route, model, overrides = {}, context = {}) {
  const key = `${route}/${model}`
  const books = plain(context.books) ? context.books : BUILTIN_TARIFFS
  if (Object.hasOwn(overrides, key)) {
    const stored = overrides[key]
    const binding = normalizeBinding(stored)
    if (binding === null) {
      const rates = normalizeOverride(stored)
      return rates ? { rates, source: 'custom', matchedKey: key } : null
    }
    if (binding.kind === 'none') return null
    if (binding.kind === 'custom') {
      const rates = normalizeOverride(stored)
      return rates ? { rates, source: 'custom', matchedKey: key } : null
    }
    if (binding.kind === 'legacy-official') return context.official ? officialRates(model, context.time) : null
    if (binding.kind === 'legacy-reference') {
      const hit = evaluateTariff(BUILTIN_TARIFF, model, context.time, 'base')
      return hit === null ? null : { rates: hit.rates, source: 'reference', matchedKey: model }
    }
    const book = Object.hasOwn(books, binding.tariff) ? books[binding.tariff] : null
    const hit = book === null ? null : evaluateTariff(book, model, context.time, binding.window)
    return hit === null ? null : withWindow(hit, 'tariff')
  }
  if (context.official) return officialRates(model, context.time)
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

/** Flag the legacy USD numbers mistakenly tagged as CNY; never rewrite records. */
export function suspectCurrency(record) {
  const ref = Object.hasOwn(REFERENCE_RATES, record.model) ? REFERENCE_RATES[record.model] : null
  return !!ref && record.currency === 'CNY' && record.base?.currency === 'CNY'
    && ['inputPerM', 'outputPerM', 'cacheReadPerM'].every(k => record.base[k] === ref[k])
}
