/**
 * Price-book tests.
 *
 * The load-bearing assertions are the ones about NOT guessing: an unknown
 * route must come back unpriced rather than free, and a partial override must
 * be rejected rather than half-applied. Those are the failures that produce a
 * plausible wrong number, which is worse than an obvious gap.
 */

import assert from 'node:assert/strict'

import {
  officialRates,
  suspectCurrency,
  DEFAULT_POOLS,
  REPORTING_CURRENCY,
  USD_RATES,
  describeRates,
  normalizeOverride,
  poolOf,
  priceUsage,
  ratesFor,
} from '../lib/pricing.js'

let passed = 0
function test(label, fn) {
  fn()
  passed++
  console.log(`  ok  ${label}`)
}

console.log('pricing.js')

test('all routes are unpriced by default, even known models and familiar names', () => {
  for (const route of ['deepseek-official', 'gateway', 'exampleGateway', 'openai-codex']) {
    assert.equal(ratesFor(route, 'deepseek-flash'), null)
    assert.equal(poolOf(route, null), 'route:' + route)
  }
})
test('reference prices require explicit per-route model opt-in', () => {
  const cfg = { 'proxy/deepseek-flash': { mode: 'reference' } }
  assert.equal(ratesFor('proxy', 'deepseek-flash', cfg).source, 'reference')
  assert.equal(ratesFor('other', 'deepseek-flash', cfg), null)
  assert.equal(ratesFor('proxy', 'unknown', { 'proxy/unknown': { mode: 'reference' } }), null)
})
test('custom and usage-only pricing never silently fall back', () => {
  const key = 'proxy/deepseek-flash'
  assert.equal(ratesFor('proxy', 'deepseek-flash', { [key]: { mode: 'none' } }), null)
  assert.equal(ratesFor('proxy', 'deepseek-flash', { [key]: { inputPerM: 1 } }), null)
  const hit = ratesFor('proxy', 'deepseek-flash', { [key]: { inputPerM: 0, outputPerM: 0, currency: 'USD' } })
  assert.equal(hit.source, 'custom')
  assert.equal(hit.rates.inputPerM, 0)
})

test('a complete override with omitted cache fields defaults them to zero', () => {
  const row = normalizeOverride({ inputPerM: 1, outputPerM: 2, currency: 'USD' })
  assert.notEqual(row, null)
  assert.equal(row.cacheReadPerM, 0)
  assert.equal(row.cacheWritePerM, 0)
})

test('cache reads are billed separately from uncached input', () => {
  const rates = { inputPerM: 1, outputPerM: 10, cacheReadPerM: 0.01, cacheWritePerM: 2, currency: 'USD', pool: 'x' }
  const priced = priceUsage({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, rates)
  assert.equal(priced.native, 1)
  const cached = priceUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }, rates)
  // Treating a cache read as input would overstate this by 100x.
  assert.equal(cached.native, 0.01)
})

test('cost is reported in USD and freezes the rates it used', () => {
  const rates = { inputPerM: 1, outputPerM: 1, cacheReadPerM: 0, cacheWritePerM: 0, currency: 'CNY', pool: 'corporate' }
  const priced = priceUsage({ inputTokens: 1_000_000 }, rates)
  assert.equal(priced.currency, 'CNY')
  assert.equal(priced.native, 1)
  assert.equal(priced.usd, USD_RATES.CNY)
  // `base` is what makes history immune to later price edits.
  assert.deepEqual(priced.base, {
    inputPerM: 1, outputPerM: 1, cacheReadPerM: 0, cacheWritePerM: 0, currency: 'CNY',
  })
})

test('missing and negative token counts are treated as zero', () => {
  const rates = { inputPerM: 1, outputPerM: 1, cacheReadPerM: 1, cacheWritePerM: 1, currency: 'USD', pool: 'x' }
  const priced = priceUsage({ inputTokens: undefined, outputTokens: -5 }, rates)
  assert.equal(priced.native, 0)
  assert.equal(priced.usd, 0)
})

test('groups are explicit, optional and cannot collide with route IDs', () => {
  assert.deepEqual(DEFAULT_POOLS, {})
  assert.equal(poolOf('proxy', null, { proxy: 'Work' }), 'group:Work')
  assert.equal(poolOf('proxy', { pool: 'old-group' }, { proxy: '' }), 'route:proxy')
  assert.equal(poolOf('Work', null), 'route:Work')
})

test('reporting basis is USD and every rate currency converts', () => {
  assert.equal(REPORTING_CURRENCY, 'USD')
  Object.values(USD_RATES).forEach((rate) => assert.ok(rate > 0))
})

test('describeRates names the unit so a row is explainable', () => {
  assert.equal(describeRates({ inputPerM: 1, outputPerM: 2, currency: 'USD' }), '$1/$2 per Mtok')
  assert.equal(describeRates({ inputPerM: 1, outputPerM: 2, currency: 'CNY' }), '¥1/¥2 per Mtok')
  assert.equal(describeRates(null), 'unpriced')
})

test('official tariffs switch at exact UTC boundaries and preserve USD', () => {
  for (const [time, expected] of [['00:59:59', .15], ['01:00:00', .3], ['03:59:59', .3], ['04:00:00', .15], ['06:00:00', .3], ['09:59:59', .3], ['10:00:00', .15]]) {
    const hit = officialRates('deepseek-flash', Date.parse('2026-09-21T' + time + 'Z'))
    assert.equal(hit.rates.inputPerM, expected)
    assert.equal(hit.rates.currency, 'USD')
  }
})
test('holidays and weekends stay off-peak including weekend makeup days', () => {
  for (const day of ['2026-09-20', '2026-09-25', '2026-10-01', '2026-02-23']) {
    assert.equal(officialRates('deepseek-flash', Date.parse(day + 'T02:00:00Z')).tariff, 'off-peak')
  }
  assert.equal(officialRates('deepseek-v4-pro', Date.parse('2026-09-21T02:00:00Z')).rates.outputPerM, 3.96)
})
test('official alias rates agree and unknown dates or models fail closed', () => {
  const time = Date.parse('2026-09-21T02:00:00Z')
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) assert.deepEqual(officialRates(model, time).rates, officialRates('deepseek-flash', time).rates)
  assert.equal(officialRates('unknown', time), null)
  assert.equal(officialRates('constructor', time), null)
  assert.equal(officialRates('deepseek-flash', NaN), null)
  assert.equal(officialRates('deepseek-flash', Date.parse('2027-01-04T02:00:00Z')), null)
})
test('only verified endpoints default to official; explicit choices stay authoritative', () => {
  const context = { official: true, time: Date.parse('2026-09-21T02:00:00Z') }
  assert.equal(ratesFor('any-name', 'deepseek-flash', {}, context).source, 'official')
  assert.equal(ratesFor('any-name', 'deepseek-flash', { 'any-name/deepseek-flash': { mode: 'none' } }, context), null)
  assert.equal(ratesFor('any-name', 'deepseek-flash', { 'any-name/deepseek-flash': { mode: 'official' } }, { ...context, official: false }), null)
})
test('legacy currency warning recognizes only matching mislabelled rates', () => {
  const rec = { model: 'deepseek-flash', currency: 'CNY', base: { currency: 'CNY', inputPerM: .15, outputPerM: .6, cacheReadPerM: .003 } }
  assert.equal(suspectCurrency(rec), true)
  assert.equal(suspectCurrency({ ...rec, currency: 'USD' }), false)
  assert.equal(suspectCurrency({ ...rec, base: null }), false)
})

console.log(`pricing.js: ${passed} passed`)
