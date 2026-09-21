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

test('a route-addressed rate wins over the model catalog', () => {
  const hit = ratesFor('exampleGateway', 'deepseek-v4-flash')
  assert.equal(hit.source, 'route')
  assert.equal(hit.matchedKey, 'exampleGateway/deepseek-v4-flash')
  // The corporate route and the personal route serve the same model id at
  // different prices; the whole point is that they do not collapse.
  const other = ratesFor('deepseek-official', 'deepseek-flash')
  assert.notEqual(hit.rates.inputPerM, other.rates.inputPerM)
})

test('an aliased route still prices, and says it was an alias', () => {
  const hit = ratesFor('gateway-backup', 'deepseek-v4-flash')
  assert.equal(hit.source, 'alias')
  assert.equal(hit.matchedKey, 'gateway/deepseek-v4-flash')
})

test('an unknown route is unpriced, NOT free', () => {
  assert.equal(ratesFor('some-new-gateway', 'no-such-model'), null)
})

test('a known model on an unknown route falls back to the catalog, flagged', () => {
  const hit = ratesFor('some-new-gateway', 'deepseek-v4-flash')
  assert.equal(hit.source, 'catalog')
  // The fallback pool is `unknown` so the report can surface it; silently
  // reporting it as a real pool would corrupt that pool's total.
  assert.equal(hit.rates.pool, 'unknown')
  assert.equal(poolOf('some-new-gateway', hit.rates), 'unknown')
})

test('an explicit override beats the built-in table', () => {
  const overrides = {
    'exampleGateway/deepseek-v4-flash': { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, currency: 'CNY', pool: 'corporate' },
  }
  const hit = ratesFor('exampleGateway', 'deepseek-v4-flash', overrides)
  assert.equal(hit.source, 'override')
  assert.equal(hit.rates.inputPerM, 0)
})

test('a partial override is rejected, not merged', () => {
  assert.equal(normalizeOverride({ inputPerM: 1 }), null)
  assert.equal(normalizeOverride({ inputPerM: 1, outputPerM: 2, currency: 'JPY' }), null)
  assert.equal(normalizeOverride(null), null)
  // A rejected override must fall through to the table rather than pricing at zero.
  const hit = ratesFor('exampleGateway', 'deepseek-v4-flash', { 'exampleGateway/deepseek-v4-flash': { inputPerM: 1 } })
  assert.equal(hit.source, 'route')
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

test('the personal and corporate pools stay distinct', () => {
  assert.equal(DEFAULT_POOLS['deepseek-official'], 'personal-deepseek')
  assert.equal(DEFAULT_POOLS['exampleGateway'], 'corporate')
  assert.equal(DEFAULT_POOLS['gateway-main'], 'corporate')
  assert.notEqual(DEFAULT_POOLS['deepseek-official'], DEFAULT_POOLS['exampleGateway'])
})

test('a pool override map replaces the built-in classification', () => {
  assert.equal(poolOf('exampleGateway', null, { exampleGateway: 'third-party' }), 'third-party')
  assert.equal(poolOf('exampleGateway', { pool: 'corporate' }, { exampleGateway: 'third-party' }), 'third-party')
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

console.log(`pricing.js: ${passed} passed`)
