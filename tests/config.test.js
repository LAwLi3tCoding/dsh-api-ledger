import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPreferences, savePreference } from '../lib/config.js'
import { ratesFor, resolveTariffs } from '../lib/pricing.js'
const dir = mkdtempSync(join(tmpdir(), 'ledger-config-'))
const file = join(dir, 'config.json')
let count = 0
function test(name, fn) { fn(); count++; console.log('  ok  ' + name) }
const args = () => ({ revision: readPreferences(file).revision, route: 'proxy', label: 'My API', group: 'Work', model: 'deepseek-flash', mode: 'reference' })
try {
  test('fresh installation has no account mapping or default pricing', () => { assert.deepEqual(readPreferences(file).config, {}) })
  test('explicit reference opt-in persists and separates group from price', () => {
    savePreference(file, args(), ['proxy'])
    const cfg = readPreferences(file).config
    assert.equal(cfg.pools.proxy, 'Work')
    assert.equal(ratesFor('proxy', 'deepseek-flash', cfg.pricing).source, 'reference')
  })
  test('stale writes and unknown routes are rejected without changing the file', () => {
    const before = readFileSync(file, 'utf8')
    assert.throws(() => savePreference(file, { ...args(), revision: 'stale' }, ['proxy']), /conflict/)
    assert.throws(() => savePreference(file, args(), []), /unknown-route/)
    assert.equal(readFileSync(file, 'utf8'), before)
  })
  test('invalid prices and unsupported reference models never save', () => {
    assert.throws(() => savePreference(file, { ...args(), model: 'not-listed' }, ['proxy']), /reference/)
    assert.throws(() => savePreference(file, { ...args(), mode: 'custom', rates: { inputPerM: -1, outputPerM: 2, currency: 'USD' } }, ['proxy']), /price/)
    assert.throws(() => savePreference(file, { ...args(), group: '__proto__' }, ['proxy']), /label/)
  })
  test('custom zero and nonzero prices are explicit and missing values are rejected', () => {
    savePreference(file, { ...args(), mode: 'custom', rates: { inputPerM: 0, outputPerM: 2, cacheReadPerM: .1, cacheWritePerM: .2, currency: 'USD' } }, ['proxy'])
    const hit = ratesFor('proxy', 'deepseek-flash', readPreferences(file).config.pricing)
    assert.equal(hit.rates.inputPerM, 0)
    assert.equal(hit.rates.outputPerM, 2)
    assert.throws(() => savePreference(file, { ...args(), mode: 'custom', rates: { outputPerM: 2, currency: 'USD' } }, ['proxy']), /price/)
  })
  test('usage-only and ungrouping persist without deleting other models', () => {
    savePreference(file, { ...args(), model: 'another-model', mode: 'none', group: '' }, ['proxy'])
    const cfg = readPreferences(file).config
    assert.equal(cfg.pools.proxy, '')
    assert.equal(ratesFor('proxy', 'another-model', cfg.pricing), null)
    assert.equal(ratesFor('proxy', 'deepseek-flash', cfg.pricing).source, 'custom')
  })
  test('deleting preferences removes only the selected route and its prices', () => {
    savePreference(file, { ...args(), route: 'other', label: 'Other' }, ['proxy', 'other'])
    savePreference(file, { revision: readPreferences(file).revision, route: 'proxy', action: 'remove' }, ['proxy', 'other'])
    const cfg = readPreferences(file).config
    assert.equal(cfg.labels.proxy, undefined)
    assert.equal(cfg.pools.proxy, undefined)
    assert.equal(Object.keys(cfg.pricing).some(k => k.startsWith('proxy/')), false)
    assert.equal(cfg.labels.other, 'Other')
  })
  test('removing one model price keeps the route, its group and every other model', () => {
    savePreference(file, { ...args(), route: 'proxy', model: 'deepseek-flash', mode: 'reference' }, ['proxy', 'other'])
    savePreference(file, { ...args(), route: 'proxy', model: 'deepseek-v4-pro', mode: 'reference' }, ['proxy', 'other'])
    const before = readPreferences(file).config
    assert.ok(Object.hasOwn(before.pricing, 'proxy/deepseek-flash'))
    assert.ok(Object.hasOwn(before.pricing, 'proxy/deepseek-v4-pro'))
    savePreference(file, { revision: readPreferences(file).revision, route: 'proxy', action: 'remove-model', model: 'deepseek-v4-pro' }, ['proxy', 'other'])
    const cfg = readPreferences(file).config
    assert.equal(Object.hasOwn(cfg.pricing, 'proxy/deepseek-v4-pro'), false)
    assert.ok(Object.hasOwn(cfg.pricing, 'proxy/deepseek-flash'))
    assert.equal(cfg.labels.proxy, 'My API')
    assert.equal(cfg.pools.proxy, 'Work')
  })
  test('removing one model price rejects stale writes, unknown routes and bad model ids', () => {
    const before = readFileSync(file, 'utf8')
    const remove = { revision: readPreferences(file).revision, route: 'proxy', action: 'remove-model', model: 'deepseek-flash' }
    assert.throws(() => savePreference(file, { ...remove, revision: 'stale' }, ['proxy']), /conflict/)
    assert.throws(() => savePreference(file, { ...remove, route: 'nope' }, ['proxy']), /unknown-route/)
    assert.throws(() => savePreference(file, { ...remove, model: '__proto__' }, ['proxy']), /invalid-model/)
    assert.equal(readFileSync(file, 'utf8'), before)
  })
  test('any route may bind a price book; unknown books, models and windows are rejected', () => {
    savePreference(file, { ...args(), route: 'proxy', model: 'deepseek-v4-pro', mode: 'tariff', tariff: 'deepseek-public-2026', window: 'auto' }, ['proxy'])
    let cfg = readPreferences(file).config
    assert.deepEqual(cfg.pricing['proxy/deepseek-v4-pro'], { mode: 'tariff', tariff: 'deepseek-public-2026', window: 'auto' })
    const before = readFileSync(file, 'utf8')
    const write = extra => savePreference(file, { revision: readPreferences(file).revision, route: 'proxy', label: '', group: '', model: 'deepseek-v4-pro', mode: 'tariff', tariff: 'deepseek-public-2026', ...extra }, ['proxy'])
    assert.throws(() => write({ tariff: 'nope' }), /tariff/)
    assert.throws(() => write({ model: 'model-not-in-book' }), /tariff/)
    assert.throws(() => write({ window: 'sometimes' }), /window/)
    assert.equal(readFileSync(file, 'utf8'), before)
    // `window` is optional and defaults to the schedule being ON.
    savePreference(file, { revision: readPreferences(file).revision, route: 'proxy', label: 'API', group: 'Work', model: 'deepseek-v4-pro', mode: 'tariff', tariff: 'deepseek-public-2026' }, ['proxy'])
    cfg = readPreferences(file).config
    assert.equal(cfg.pricing['proxy/deepseek-v4-pro'].window, 'auto')
  })
  test('a user-defined price book is accepted and priced by its own rows', () => {
    const withBook = JSON.parse(readFileSync(file, 'utf8'))
    withBook.tariffs = { acme: { label: 'ACME', currency: 'CNY', models: { 'acme-pro': { inputPerM: 4, outputPerM: 12 } } } }
    writeFileSync(file, JSON.stringify(withBook, null, 2) + '\n')
    savePreference(file, { revision: readPreferences(file).revision, route: 'proxy', label: 'API', group: 'Work', model: 'acme-pro', mode: 'tariff', tariff: 'acme', window: 'base' }, ['proxy'])
    const cfg = readPreferences(file).config
    assert.deepEqual(cfg.pricing['proxy/acme-pro'], { mode: 'tariff', tariff: 'acme', window: 'base' })
    const hit = ratesFor('proxy', 'acme-pro', cfg.pricing, { books: resolveTariffs(cfg.tariffs), time: Date.now() })
    assert.equal(hit.rates.inputPerM, 4)
    assert.equal(hit.rates.currency, 'CNY')
  })
  test('malformed config fails closed rather than overwriting user content', () => {
    writeFileSync(file, '{bad')
    assert.throws(() => readPreferences(file))
    assert.throws(() => savePreference(file, {}, ['proxy']))
    assert.equal(readFileSync(file, 'utf8'), '{bad')
  })
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log(`config: ${count} passed`)
