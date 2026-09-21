/**
 * Host report wiring tests.
 *
 * The period figures and the session fold added with the new UI had no
 * coverage: `report(args)` parses a browser-supplied clock, `periodTotals`
 * filters on it, and both carriers forward it. A regression here would be
 * invisible until someone noticed the "today" number was wrong.
 *
 * These tests mount the real plugin against a STUB Cordis context and drive the
 * handler the way the client does, so the wiring itself is exercised — not a
 * re-implementation of it.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0

/**
 * Run one case against a fresh temp home, then remove it.
 *
 * AWAITED on purpose: the body is async, so a `finally` that removed the
 * directory the moment `fn()` handed back its promise would delete the ledger
 * out from under a still-running test — and then report that test as passing.
 */
async function test(label, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'api-ledger-report-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  passed++
  console.log(`  ok  ${label}`)
}

const DAY = 86_400_000
/** A fixed clock, so period boundaries are arithmetic rather than "now". */
const NOW = Date.parse('2026-09-20T12:00:00Z')
const TODAY_START = NOW - 6 * 3600_000

/**
 * One record in the shape this plugin actually persists.
 *
 * Two field names matter and are easy to get wrong from memory:
 *   - the fold groups on `identity`, NOT `provider`: this plugin freezes the
 *     credential identity at capture time, so re-pointing a route later cannot
 *     rewrite what history was attributed to;
 *   - the route is stored as `route`, NOT `provider` (that name belongs to the
 *     `llm/stream` options, upstream of the record).
 * A fixture using the upstream names collapses every row into `unknown` while
 * still producing a well-formed payload.
 */
function record(overrides) {
  return Object.assign({
    time: NOW - 3600_000,
    sessionId: 's1',
    route: 'exampleGateway',
    model: 'deepseek-v4-flash',
    purpose: 'agent',
    identity: 'exampleGateway',
    identityLabel: 'exampleGateway',
    keyRef: null,
    pool: 'corporate',
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 500,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
    priced: true,
    usd: 1,
    native: 1,
    currency: 'CNY',
    base: null,
  }, overrides)
}

/**
 * Write a ledger home and mount the plugin against a stub context.
 *
 * The stub is deliberately minimal: `get` answers nothing, so identity
 * resolution takes its documented fail-soft path and keys fall back to route
 * names. Anything the plugin needs beyond that is a bug in its own fail-soft
 * contract, and this mount would fail loudly.
 */
async function mount(home, records, services = {}) {
  mkdirSync(join(home, 'api-ledger'), { recursive: true })
  const lines = records.map((row) => JSON.stringify(row)).join('\n')
  writeFileSync(join(home, 'api-ledger', 'records.jsonl'), `${lines}\n`)

  process.env.DSH_HOME = home
  // Imported after the env var is set is not enough on its own — `defaultHome`
  // reads the environment inside `apply`, so ordering only matters for clarity.
  const host = await import('../lib/index.js')

  const captured = { rpc: null, http: null, preferences: null, stream: null }
  function child() {
    return {
      connection: {
        rpc: {
          handle(path, handlers) {
            captured.rpc = { path, handlers }
            return () => {}
          },
        },
      },
      webServer: {
        register(route) {
          if (route.path === '/api-ledger/report') captured.http = route
          else captured.preferences = route
          return () => {}
        },
      },
      effect: (fn) => {
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      logger: { warn: () => {} },
    }
  }
  const ctx = {
    get: name => services[name],
    on: (name, handler) => { if (name === 'llm/stream') captured.stream = handler; return () => {} },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject: (_names, cb) => { cb(child()) },
    logger: { warn: () => {} },
  }

  host.apply(ctx)
  assert.notEqual(captured.rpc, null, 'plugin must register the RPC carrier')
  assert.equal(captured.rpc.path, '/api-ledger')
  assert.equal(typeof captured.rpc.handlers.report, 'function')
  return captured
}

console.log('report')

const FIXTURE = [
  // Today (within TODAY_START), session s1.
  record({ time: NOW - 3600_000, sessionId: 's1', usd: 1 }),
  // Three days ago: inside the week, outside today, session s2.
  record({ time: NOW - 3 * DAY, sessionId: 's2', usd: 2 }),
  // Ten days ago: inside the month, outside the week, session s1.
  record({ time: NOW - 10 * DAY, sessionId: 's1', usd: 4 }),
  // Forty days ago: outside every window.
  record({ time: NOW - 40 * DAY, sessionId: 's3', usd: 8 }),
]

await test('periods bucket the ledger on the client-supplied clock', async (dir) => {
  const captured = await mount(dir, FIXTURE)
  const report = await captured.rpc.handlers.report({ now: NOW, todayStart: TODAY_START })

  assert.equal(report.ok, true)
  assert.equal(report.totals.calls, 4)
  assert.equal(report.totals.usd, 15)

  assert.deepEqual(report.periods.today, { usd: 1, calls: 1 })
  assert.deepEqual(report.periods.week, { usd: 3, calls: 2 })
  assert.deepEqual(report.periods.month, { usd: 7, calls: 3 })
})

await test('an absent clock zeroes the periods instead of inventing one', async (dir) => {
  const captured = await mount(dir, FIXTURE)
  const report = await captured.rpc.handlers.report({})
  // The host has no business guessing the browser's timezone; a fabricated
  // "today" would be worse than an explicit zero.
  assert.deepEqual(report.periods.today, { usd: 0, calls: 0 })
  assert.deepEqual(report.periods.week, { usd: 0, calls: 0 })
  assert.deepEqual(report.periods.month, { usd: 0, calls: 0 })
  // The global fold is unaffected: it does not depend on the clock.
  assert.equal(report.totals.usd, 15)
})

await test('a session fold covers only that session, and null means none was asked for', async (dir) => {
  const captured = await mount(dir, FIXTURE)
  const scoped = await captured.rpc.handlers.report({ now: NOW, todayStart: TODAY_START, sessionId: 's1' })
  assert.equal(scoped.session.sessionId, 's1')
  assert.equal(scoped.session.totals.calls, 2)
  assert.equal(scoped.session.totals.usd, 5)
  // The global fold still ships alongside, so the tab needs one round trip.
  assert.equal(scoped.totals.usd, 15)

  const global = await captured.rpc.handlers.report({ now: NOW, todayStart: TODAY_START })
  // Null, not an empty fold: the tab must tell "spent nothing" from "not bound".
  assert.equal(global.session, null)
})

await test('an unknown session folds to zero rather than falling back to global', async (dir) => {
  const captured = await mount(dir, FIXTURE)
  const report = await captured.rpc.handlers.report({ now: NOW, sessionId: 'nope' })
  assert.equal(report.session.totals.calls, 0)
  assert.equal(report.session.totals.usd, 0)
})

await test('the carrier forwards args, and the HTTP route reads them from the body', async (dir) => {
  const captured = await mount(dir, FIXTURE)

  // RPC: the handler must not drop its argument.
  const viaRpc = await captured.rpc.handlers.report({ now: NOW, todayStart: TODAY_START })
  assert.equal(viaRpc.periods.today.calls, 1)

  // HTTP: a request body carrying the same clock must produce the same numbers.
  assert.notEqual(captured.http, null)
  assert.equal(captured.http.path, '/api-ledger/report')
  const body = JSON.stringify({ now: NOW, todayStart: TODAY_START })
  const req = {
    method: 'POST',
    on(event, handler) {
      if (event === 'data') handler(body)
      else if (event === 'end') handler()
      return req
    },
  }
  let sent = null
  const res = {
    writeHead: () => {},
    end: (text) => { sent = JSON.parse(text) },
  }
  await captured.http.handler(req, res)
  assert.equal(sent.ok, true)
  assert.deepEqual(sent.periods.today, { usd: 1, calls: 1 })
})

await test('a malformed HTTP body costs only the periods, not the report', async (dir) => {
  const captured = await mount(dir, FIXTURE)
  const req = {
    method: 'POST',
    on(event, handler) {
      if (event === 'data') handler('{not json')
      else if (event === 'end') handler()
      return req
    },
  }
  let sent = null
  const res = { writeHead: () => {}, end: (text) => { sent = JSON.parse(text) } }
  await captured.http.handler(req, res)
  assert.equal(sent.ok, true)
  assert.equal(sent.totals.usd, 15)
  assert.deepEqual(sent.periods.today, { usd: 0, calls: 0 })
})

await test('the report never leaks a credential value', async (dir) => {
  const captured = await mount(dir, FIXTURE)
  const report = await captured.rpc.handlers.report({ now: NOW, todayStart: TODAY_START })
  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes('sk-'), false)
  // With no llm service mounted, identity falls back to the route name.
  const rows = report.totals.byIdentity
  assert.equal(rows[0].id, 'exampleGateway')
  assert.equal(rows[0].keyRef, null)
})

await test('the payload carries exactly the paths the client reads', async (dir) => {
  const captured = await mount(dir, FIXTURE)
  const report = await captured.rpc.handlers.report({ now: NOW, todayStart: TODAY_START })

  // These are the paths `lib/client.js` reads. A rename on either side renders
  // empty charts on a page that still looks structurally fine — the failure
  // this test exists to prevent, and one that already happened once.
  assert.equal(typeof report.recordCount, 'number')
  assert.equal(typeof report.poolLabels, 'object')
  assert.deepEqual(Object.keys(report.periods).sort(), ['month', 'today', 'week'])
  assert.ok(Array.isArray(report.totals.byIdentity))
  assert.ok(Array.isArray(report.totals.byPool))
  assert.ok(Array.isArray(report.totals.byDay))
  assert.ok(Array.isArray(report.totals.byModel))
  // The credential cell renders its route summary off each identity row, and
  // the field is `routes` (an array), not a map.
  assert.ok(Array.isArray(report.totals.byIdentity[0].routes))
  assert.equal(report.totals.byIdentity[0].routes[0].route, 'exampleGateway')
})

await test('dashboard periods and session filters keep separate pool charts and honest unpriced totals', async (dir) => {
  const captured = await mount(dir, [
    record({ time: TODAY_START, usd: .14, pool: 'personal-deepseek', route: 'personal' }),
    record({ time: TODAY_START - 1, usd: 9, pool: 'personal-deepseek', route: 'personal' }),
    record({ time: TODAY_START + 1, usd: 2, pool: 'corporate', sessionId: 's2' }),
    record({ time: TODAY_START + 2, usd: 0, priced: false, pool: 'corporate' }),
  ])
  const r = await captured.rpc.handlers.report({ now: NOW, todayStart: TODAY_START, range: 'today', sessionId: 's1' })
  assert.equal(r.usdRates.CNY, .14)
  assert.equal(r.today.calls, 3)
  assert.equal(r.view.calls, 2)
  assert.equal(r.view.unpriced, 1)
  assert.equal(r.viewPools.length, 2)
  assert.equal(r.viewPools.find(p => p.pool === 'route:personal').totals.usd, .14)
  assert.equal(r.viewPools.find(p => p.pool === 'route:exampleGateway').totals.byPool[0].unpriced, 1)
  assert.equal(r.viewPools.find(p => p.pool === 'route:exampleGateway').totals.byModel[0].unpriced, 1)
  const nextDay = await captured.rpc.handlers.report({ now: NOW + DAY, todayStart: TODAY_START + DAY, range: 'today' })
  assert.equal(nextDay.today.calls, 0)
  assert.equal(nextDay.view.calls, 0)
})

await test('yesterday uses client calendar boundaries and recent calls stay scoped and bounded', async (dir) => {
  const yesterdayStart = TODAY_START - 23 * 3600_000
  const rows = [record({ time: yesterdayStart - 1, usd: 99 }), record({ time: yesterdayStart, usd: 2 }), record({ time: TODAY_START - 1, usd: 3 })]
  for (let i = 0; i < 20; i++) rows.push(record({ time: TODAY_START + i, model: 'model-' + i, secret: 'must-not-leak' }))
  rows.push(record({ time: TODAY_START + 30, sessionId: 's2' }))
  const captured = await mount(dir, rows)
  const r = await captured.rpc.handlers.report({ now: NOW, todayStart: TODAY_START, yesterdayStart, range: 'today', sessionId: 's1' })
  assert.equal(r.yesterday.usd, 5)
  assert.equal(r.recent.length, 15)
  assert.equal(r.recent[0].model, 'model-19')
  assert.equal(r.recent[14].model, 'model-5')
  assert.equal(JSON.stringify(r.recent).includes('must-not-leak'), false)
  const unknown = await captured.rpc.handlers.report({ now: NOW, todayStart: TODAY_START })
  assert.equal(unknown.yesterday, null)
})

await test('regrouping and price edits change the projection without rewriting history', async (dir) => {
  const rows = [record({ route: 'a', identity: 'SHARED', usd: 1 }), record({ route: 'b', identity: 'SHARED', usd: 2 })]
  const captured = await mount(dir, rows)
  const handler = captured.rpc.handlers
  let r = await handler.report({ now: NOW, todayStart: TODAY_START })
  assert.equal(r.view.byIdentity.length, 2)
  assert.equal(r.viewPools.length, 2)
  await handler.savePreference({ revision: r.settings.revision, route: 'a', label: 'Primary', group: 'Team', model: 'deepseek-v4-flash', mode: 'none' })
  r = await handler.report({ now: NOW, todayStart: TODAY_START })
  await handler.savePreference({ revision: r.settings.revision, route: 'b', label: 'Secondary', group: 'Team', model: 'deepseek-v4-flash', mode: 'custom', rates: { inputPerM: 99, outputPerM: 99, currency: 'CNY' } })
  r = await handler.report({ now: NOW, todayStart: TODAY_START })
  assert.equal(r.viewPools.length, 1)
  assert.equal(r.poolLabels['group:Team'], 'Team')
  assert.equal(r.view.usd, 3)
  assert.equal(r.today.byPool[0].usd, 3)
  assert.equal(r.recent[0].pool, 'group:Team')
  assert.equal(r.view.byIdentity.find(row => row.id === 'a').label, 'Primary')
  const disk = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'api-ledger', 'records.jsonl'), 'utf8').split('\n')[0])
  assert.equal(disk.identity, 'SHARED')
  assert.equal(disk.usd, 1)
})

await test('HTTP preference writes require same origin, JSON and a current process token', async (dir) => {
  const captured = await mount(dir, [record({ route: 'proxy' })])
  const data = await captured.rpc.handlers.report()
  async function request(headers, args) {
    let result, status
    const req = { method: 'POST', headers, on(event, cb) { if (event === 'data') cb(JSON.stringify(args)); if (event === 'end') cb(); return req } }
    await captured.preferences.handler(req, { writeHead(s) { status = s }, end(body) { result = JSON.parse(body) } })
    return { result, status }
  }
  const headers = { origin: 'http://localhost:4000', host: 'localhost:4000', 'content-type': 'application/json' }
  const args = { token: data.settings.token, revision: data.settings.revision, route: 'proxy', label: 'API', group: '', model: 'deepseek-flash', mode: 'none' }
  assert.equal((await request({ ...headers, origin: 'https://untrusted.example' }, args)).status, 403)
  assert.equal((await request(headers, { ...args, token: 'invalid' })).status, 403)
  assert.equal((await request({ ...headers, 'content-type': 'text/plain' }, args)).status, 403)
  assert.equal((await request(headers, args)).status, 200)
  assert.equal((await request(headers, args)).status, 400)
})

await test('actual accounting stream honors usage-only, custom and reference modes for future calls', async (dir) => {
  const captured = await mount(dir, [])
  async function call() {
    const generator = captured.stream({ provider: 'proxy', model: 'deepseek-flash', sessionId: 's1' }, () => (async function* () { yield { type: 'usage', usage: { inputTokens: 1000000 } } })())
    for await (const ignored of generator) void ignored
  }
  await call()
  let r = await captured.rpc.handlers.report()
  assert.equal(r.totals.unpriced, 1)
  await captured.rpc.handlers.savePreference({ revision: r.settings.revision, route: 'proxy', label: 'API', group: '', model: 'deepseek-flash', mode: 'custom', rates: { inputPerM: 2, outputPerM: 3, currency: 'USD' } })
  await call()
  r = await captured.rpc.handlers.report()
  assert.equal(r.totals.usd, 2)
  assert.equal(r.totals.unpriced, 1)
  await captured.rpc.handlers.savePreference({ revision: r.settings.revision, route: 'proxy', label: 'API', group: '', model: 'deepseek-flash', mode: 'reference' })
  await call()
  r = await captured.rpc.handlers.report()
  assert.ok(Math.abs(r.totals.usd - 2.15) < 1e-9)
  assert.equal(r.recent.filter(row => row.priceSource === 'reference').length, 1)
  assert.equal(r.totals.calls, 3)
})

await test('route discovery hides unconfigured built-ins but keeps configured providers without calls', async (dir) => {
  const captured = await mount(dir, [], { llm: { listConfigurableProviders: () => [
    { provider: 'unused', settingsNs: 'providers', settingsPath: ['unused'] },
    { provider: 'ready', settingsNs: 'providers', settingsPath: ['ready'], displayName: 'Ready' },
  ] }, settings: { get: () => ({ ready: { models: [{ id: 'my-model' }] } }) } })
  const r = await captured.rpc.handlers.report()
  assert.deepEqual(r.settings.routes.map(row => row.route), ['ready'])
  assert.deepEqual(r.settings.routes[0].models, ['my-model'])
  assert.equal(r.viewPools.length, 0)
})

await test('inactive preference-only routes disappear after deletion while history remains', async (dir) => {
  const captured = await mount(dir, [record({ route: 'historic' })])
  writeFileSync(join(dir, 'api-ledger', 'config.json'), JSON.stringify({ labels: { stale: 'Unused' }, pools: { stale: 'Old' }, pricing: { 'stale/model': { mode: 'none' } } }))
  let r = await captured.rpc.handlers.report()
  assert.equal(r.settings.routes.find(row => row.route === 'stale').active, false)
  assert.equal(r.settings.routes.find(row => row.route === 'stale').historical, false)
  await captured.rpc.handlers.savePreference({ revision: r.settings.revision, route: 'stale', action: 'remove' })
  r = await captured.rpc.handlers.report()
  assert.deepEqual(r.settings.routes.map(row => row.route), ['historic'])
  assert.equal(r.settings.routes[0].historical, true)
  assert.equal(r.totals.calls, 1)
})

await test('official capture uses verified endpoints, persists tariff, and rejects gateway opt-in', async dir => {
  const captured = await mount(dir, [record({ base: { currency: 'CNY', inputPerM: .15, outputPerM: .6, cacheReadPerM: .003 } })], {
    llm: { listConfigurableProviders: () => [{ provider: 'direct', settingsNs: 'llm-deepseek' }, { provider: 'proxy', settingsNs: 'other' }] },
    settings: { get: ns => ({ baseURL: ns === 'llm-deepseek' ? 'https://api.deepseek.com' : 'https://gateway.example' }) },
  })
  const clock = Date.now
  Date.now = () => Date.parse('2026-09-21T02:00:00Z')
  try {
    for await (const chunk of captured.stream({ provider: 'direct', model: 'deepseek-flash' }, () => (async function* () { yield { type: 'usage', usage: { inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000 } } })())) void chunk
    const r = await captured.rpc.handlers.report()
    assert.equal(r.recent[0].priceSource, 'official')
    assert.equal(r.recent[0].tariff, 'peak')
    assert.equal(r.recent[0].currency, 'USD')
    assert.equal(r.recent[0].usd, 1.506)
    assert.equal(r.suspectCurrencyCount, 1)
    assert.ok(Math.abs(r.totals.usd - 2.506) < 1e-12)
    await assert.rejects(() => captured.rpc.handlers.savePreference({ revision: r.settings.revision, route: 'proxy', label: '', group: '', model: 'deepseek-flash', mode: 'official' }), /no-official-price/)
    await captured.rpc.handlers.savePreference({ revision: r.settings.revision, route: 'direct', label: '', group: '', model: 'deepseek-flash', mode: 'official' })
  } finally { Date.now = clock }
})

console.log(`report: ${passed} passed`)
