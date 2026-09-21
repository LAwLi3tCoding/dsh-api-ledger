/**
 * Ledger tests: durability, folding, and the pool-separation invariant.
 *
 * Every case runs against a real temporary directory, because the properties
 * that matter here (an append survives, a torn last line is skipped, a stale
 * rollup is rejected) are properties of the FILES, not of an in-memory object.
 */

import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ledger, dayKeyOf } from '../lib/records.js'

let passed = 0
function test(label, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'api-ledger-test-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  passed++
  console.log(`  ok  ${label}`)
}

/** A complete record; individual tests override the fields they exercise. */
function record(overrides) {
  return Object.assign({
    seq: 0,
    time: Date.parse('2026-09-20T10:00:00Z'),
    sessionId: 's1',
    purpose: 'agent',
    route: 'exampleGateway',
    model: 'deepseek-v4-flash',
    identity: 'EXAMPLE_GATEWAY_API_KEY',
    identityLabel: 'EXAMPLE_GATEWAY_API_KEY',
    keyRef: 'EXAMPLE_GATEWAY_API_KEY',
    pool: 'corporate',
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 5000,
    cacheWriteTokens: 0,
    reasoningTokens: 20,
    priced: true,
    usd: 0.001,
    native: 0.007,
    currency: 'CNY',
    base: { inputPerM: 0.44, outputPerM: 1.32, cacheReadPerM: 0.014, cacheWritePerM: 0, currency: 'CNY' },
    priceSource: 'route',
    matchedKey: 'exampleGateway/deepseek-v4-flash',
  }, overrides)
}

console.log('records.js')

test('an appended record survives a reload from disk', (dir) => {
  const first = new Ledger({ home: dir }).load()
  first.append(record({ identity: 'A' }))
  const second = new Ledger({ home: dir }).load()
  assert.equal(second.records.length, 1)
  assert.equal(second.records[0].identity, 'A')
})

test('a torn trailing line is skipped rather than fatal', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ identity: 'A' }))
  // Simulate a crash mid-append: valid row, then a truncated one.
  appendFileSync(join(dir, 'records.jsonl'), '{"identity":"B","priced":tru')
  const reloaded = new Ledger({ home: dir }).load()
  assert.equal(reloaded.records.length, 1)
  assert.equal(reloaded.records[0].identity, 'A')
})

test('folding separates identities and pools', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ identity: 'EXAMPLE_GATEWAY_API_KEY', pool: 'corporate', usd: 1 }))
  ledger.append(record({ identity: 'EXAMPLE_GATEWAY_API_KEY_2', pool: 'corporate', usd: 2 }))
  ledger.append(record({ identity: 'DEEPSEEK_API_KEY', pool: 'personal-deepseek', usd: 4 }))

  const totals = ledger.computeRollup()
  assert.equal(totals.calls, 3)
  assert.equal(totals.usd, 7)
  assert.equal(totals.byIdentity.length, 3)

  const corporate = totals.byPool.find((p) => p.pool === 'corporate')
  const personal = totals.byPool.find((p) => p.pool === 'personal-deepseek')
  // The invariant this whole plugin exists for: one gateway's spend must not
  // be added to the personal balance's spend.
  assert.equal(corporate.usd, 3)
  assert.equal(corporate.calls, 2)
  assert.equal(personal.usd, 4)
  assert.equal(personal.calls, 1)
})

test('two keys behind one gateway stay two rows, not one', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ identity: 'EXAMPLE_GATEWAY_API_KEY', route: 'gateway-main' }))
  ledger.append(record({ identity: 'EXAMPLE_GATEWAY_API_KEY_2', route: 'gateway-backup' }))
  const totals = ledger.computeRollup()
  assert.equal(totals.byIdentity.length, 2)
  assert.deepEqual(totals.byIdentity.map((r) => r.id).sort(), ['EXAMPLE_GATEWAY_API_KEY', 'EXAMPLE_GATEWAY_API_KEY_2'])
  // Both routes are recorded on their own row, so the report can show which
  // route each credential served.
  assert.equal(totals.byIdentity.find((r) => r.id === 'EXAMPLE_GATEWAY_API_KEY').routes[0].route, 'gateway-main')
})

test('uncounted usage is reported, not silently dropped from the totals', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ identity: 'A', usageMissing: true }))
  ledger.append(record({ identity: 'A' }))
  const totals = ledger.computeRollup()
  assert.equal(totals.calls, 1)
  assert.equal(totals.missingUsage, 1)
})

test('unpriced calls are counted and marked, never rendered as zero-cost', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ identity: 'X', priced: false, usd: 0, base: null, priceSource: 'unpriced' }))
  const totals = ledger.computeRollup()
  assert.equal(totals.unpriced, 1)
  assert.equal(totals.byIdentity[0].unpriced, 1)
  assert.equal(totals.byIdentity[0].usd, 0)
})

test('byModel keys on route AND model, so one model id stays two rows', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ route: 'deepseek-official', model: 'deepseek-flash' }))
  ledger.append(record({ route: 'exampleGateway', model: 'deepseek-v4-flash' }))
  const totals = ledger.computeRollup()
  assert.deepEqual(totals.byModel.map((r) => r.key).sort(), ['deepseek-official/deepseek-flash', 'exampleGateway/deepseek-v4-flash'])
})

test('the rollup is stamped with a fingerprint that detects external appends', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ identity: 'A' }))
  const written = ledger.writeRollup()
  assert.notEqual(written, null)
  assert.notEqual(ledger.readRollup(), null)

  // A tool writes to the JSONL behind our back: the stored rollup now
  // describes a file that no longer exists, and must be rejected.
  appendFileSync(join(dir, 'records.jsonl'), `${JSON.stringify(record({ identity: 'B' }))}\n`)
  assert.equal(ledger.readRollup(), null)
})

test('a corrupt rollup file degrades to null instead of throwing', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ identity: 'A' }))
  writeFileSync(join(dir, 'rollup.json'), '{not json')
  assert.equal(ledger.readRollup(), null)
})

test('max records evicts the oldest, keeping the newest window', (dir) => {
  const ledger = new Ledger({ home: dir, maxRecords: 2 }).load()
  ledger.append(record({ identity: 'first' }))
  ledger.append(record({ identity: 'second' }))
  ledger.append(record({ identity: 'third' }))
  const totals = ledger.computeRollup()
  assert.equal(totals.calls, 2)
  assert.deepEqual(totals.byIdentity.map((r) => r.id).sort(), ['second', 'third'])
})

test('day buckets group by LOCAL calendar day', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  // Built from local calendar fields on purpose, never from a UTC literal: a
  // `Z` timestamp at 22:00 is the NEXT local day at UTC+8, so a UTC literal
  // here would assert a different grouping on every machine.
  const morning = new Date(2026, 8, 20, 9, 0, 0)
  const evening = new Date(2026, 8, 20, 22, 0, 0)
  ledger.append(record({ time: morning.getTime() }))
  ledger.append(record({ time: evening.getTime() }))
  const totals = ledger.computeRollup()
  assert.equal(totals.byDay.length, 1)
  assert.equal(totals.byDay[0].day, '2026-09-20')
  assert.equal(totals.byDay[0].calls, 2)
})

test('day bucketing follows the local zone, not UTC', () => {
  // A UTC instant late in the day is the next local day east of Greenwich.
  // Pinning the function's contract here keeps the choice explicit: the report
  // is read by a person in their own timezone, so "today" must mean their day.
  const utcLate = Date.parse('2026-09-20T22:00:00Z')
  const localDay = dayKeyOf(utcLate)
  const utcDay = new Date(utcLate).toISOString().slice(0, 10)
  const offsetMinutes = new Date(utcLate).getTimezoneOffset()
  if (offsetMinutes < 0) {
    // East of UTC: the local day is already the 21st.
    assert.equal(localDay, '2026-09-21')
    assert.notEqual(localDay, utcDay)
  } else {
    assert.equal(localDay, utcDay)
  }
})

test('an untrustworthy timestamp yields no day bucket rather than a bogus one', () => {
  assert.equal(dayKeyOf(0), null)
  assert.equal(dayKeyOf(Number.NaN), null)
  assert.equal(dayKeyOf(undefined), null)
})

test('a fresh home with no files folds to an empty, valid report', (dir) => {
  const totals = new Ledger({ home: dir }).load().computeRollup()
  assert.equal(totals.calls, 0)
  assert.equal(totals.usd, 0)
  assert.deepEqual(totals.byIdentity, [])
  assert.deepEqual(totals.byPool, [])
})

test('records are appended as one JSON object per line', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ identity: 'A' }))
  ledger.append(record({ identity: 'B' }))
  const lines = readFileSync(join(dir, 'records.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  lines.forEach((line) => assert.equal(typeof JSON.parse(line), 'object'))
})

test('a session fold counts only that session, never falling back to global', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ sessionId: 's1', identity: 'A', usd: 1 }))
  ledger.append(record({ sessionId: 's2', identity: 'A', usd: 2 }))
  ledger.append(record({ sessionId: 's1', identity: 'B', usd: 4 }))

  const session = ledger.foldRecords(ledger.recordsForSession('s1'))
  assert.equal(session.calls, 2)
  assert.equal(session.usd, 5)
  assert.deepEqual(session.byIdentity.map((r) => r.id).sort(), ['A', 'B'])

  // The global fold still sees everything, and the two folds come from one
  // implementation, so they cannot disagree about what a call is.
  assert.equal(ledger.computeRollup().usd, 7)
})

test('an unknown or absent session id yields an empty fold, not the global one', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record({ sessionId: 's1', usd: 3 }))
  // A silent fallback here would render global totals that look session-scoped.
  assert.deepEqual(ledger.recordsForSession('nope'), [])
  assert.equal(ledger.foldRecords(ledger.recordsForSession('nope')).calls, 0)
  assert.deepEqual(ledger.recordsForSession(''), [])
  assert.deepEqual(ledger.recordsForSession(undefined), [])
})

test('no key VALUE can reach the record file', (dir) => {
  const ledger = new Ledger({ home: dir }).load()
  ledger.append(record())
  const text = readFileSync(join(dir, 'records.jsonl'), 'utf8')
  // The only credential-shaped field is the reference NAME.
  assert.equal(text.includes('sk-'), false)
  assert.ok(text.includes('EXAMPLE_GATEWAY_API_KEY'))
})

console.log(`records.js: ${passed} passed`)
