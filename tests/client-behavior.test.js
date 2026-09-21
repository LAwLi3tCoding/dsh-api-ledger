import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
async function test(name, fn) { await fn(); console.log(`  ok  ${name}`); passed++ }
function boot(saved = null) {
  let bundle
  const storage = new Map(saved ? [['dsh-api-ledger.currency', saved]] : [])
  const win = { localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    __ModuleLoader__: { load: value => { bundle = value } } }
  let report = { status: 'loading', data: null }
  const effects = [], updates = [], timers = new Map(), events = new Map()
  let clock = new Date(2026, 8, 21, 23, 59, 58).getTime()
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])) } }
  const doc = { visibilityState: 'visible', addEventListener: (k, fn) => events.set(k, fn), removeEventListener: k => events.delete(k) }

  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    createContext(value) { const context = { current: value }; context.Provider = { context }; return context },
    useContext: context => context.current,
    useState: initial => [initial?.status ? report : initial, v => updates.push(v)],
    useEffect: effect => effects.push(effect),
    useMemo: fn => fn(),
    useSyncExternalStore: (subscribe, snapshot) => snapshot(),
  }
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    .replace('    // ── plugin', '    window.testApi = { formatMoney, setCurrency, getCurrency, subscribeCurrency, createSource, tokenCount, useReport, LedgerContext, openLedgerSettings };\n    // ── plugin')
  new Function('window', 'document', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', source)(win, doc, fn => { timers.set(fn, fn); return fn }, id => timers.delete(id), ClockDate, fn => fn())
  const plugin = bundle.factory(() => React)
  const slots = new Map()
  plugin.apply({
    get: name => name === 'slots' ? { inject: (_key, fn) => fn(), register: (meta, component) => slots.set(meta.name, component) } : undefined,
    effect: fn => fn(),
  })
  function render(node) {
    if (node == null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(render)
    if (node.type?.context) {
      const c = node.type.context, before = c.current
      c.current = node.props.value
      const result = render(node.props.children)
      c.current = before
      return result
    }
    if (typeof node.type === 'function') return render(node.type(node.props))
    return { ...node, props: { ...node.props, children: render(node.props.children) } }
  }
  function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props.children)] : [] }
  function text(tree) { return Array.isArray(tree) ? tree.map(text).join(' ') : tree && typeof tree === 'object' ? tree.type === 'style' ? '' : text(tree.props.children) : String(tree ?? '') }
  return { api: win.testApi, storage, effects, nodes, text, updates, timers, events, doc, advance: ms => { clock += ms }, show(name, data, props = {}) {
    report = data
    return render(React.createElement(slots.get(name), props))
  } }
}

const totals = { calls: 2, unpriced: 0, usd: 2.14, inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 20,
  byIdentity: [], byDay: [], byModel: [], byPool: [
    { pool: 'personal-deepseek', calls: 1, usd: .14, unpriced: 0 },
    { pool: 'corporate', calls: 1, usd: 2, unpriced: 0 },
  ] }
const data = { ok: true, usdRates: { USD: 1, CNY: .14 }, poolLabels: { 'personal-deepseek': '官方额度', corporate: '公司额度' },
  settings: { revision: "test", routes: [], pricing: {}, referenceModels: [] }, recent: [], yesterday: null, view: totals, totals, today: totals, session: { totals }, viewPools: totals.byPool.map(p => ({ pool: p.pool, totals: { ...totals, ...p, byPool: [p] } })) }
const ready = { status: 'ready', data }

await test('conversion preserves tiny spend, rejects missing FX, and keeps original USD data', () => {
  const { api } = boot()
  assert.equal(api.formatMoney(.14, 'CNY', data.usdRates), '¥1.00')
  assert.equal(api.formatMoney(.14, 'USD', data.usdRates), '$0.140')
  assert.equal(api.formatMoney(0, 'CNY', data.usdRates), '¥0.00')
  assert.equal(api.formatMoney(.000001, 'USD', data.usdRates), '<$0.0001')
  assert.equal(api.formatMoney(1, 'CNY', {}), '—')
  assert.equal(data.today.usd, 2.14)
  assert.equal(api.tokenCount(totals), 370)
})
await test('currency selection persists, notifies all listeners, and rejects unsupported values', () => {
  const b = boot('USD'); let notifications = 0
  const off = b.api.subscribeCurrency(() => notifications++)
  assert.equal(b.api.getCurrency(), 'USD')
  b.api.setCurrency('CNY'); b.api.setCurrency('EUR')
  assert.equal(b.api.getCurrency(), 'CNY')
  assert.equal(b.storage.get('dsh-api-ledger.currency'), 'CNY')
  assert.equal(notifications, 1)
  off(); b.api.setCurrency('USD'); assert.equal(notifications, 1)
})
await test('all four surfaces render both currencies, while billing pools remain separate', () => {
  const b = boot()
  const seats = ['settings.section', 'conversation.view', 'conversation.composer.dock', 'sidebar.footer.action']
  for (const seat of seats) {
    const tree = b.show(seat, ready, { sessionId: 's1', wide: true })
    assert.match(b.text(tree), /¥1\.00/, seat)
    assert.match(seat === 'sidebar.footer.action' ? b.nodes(tree).find(n => n.type === 'button').props.title : b.text(tree), /¥14\.29/, seat)
    assert.doesNotMatch(b.text(tree), /¥15\.29/, 'never present the sum of different billing pools')
  }
  const tree = b.show('settings.section', ready)
  b.nodes(tree).find(n => n.type === 'button' && b.text(n) === 'USD').props.onClick()
  for (const seat of seats) assert.match(b.text(b.show(seat, ready, { sessionId: 's1' })), /\$0\.140/)
})
await test('unbound sessions, transport errors and unpriced calls do not appear as free usage', () => {
  const b = boot()
  assert.equal(b.text(b.show('conversation.composer.dock', ready)).trim(), '')
  assert.match(b.text(b.show('sidebar.footer.action', { status: 'error', error: 'offline', data: null })), /费用暂不可用/)
  const partial = { ...data, today: { ...totals, unpriced: 2, byPool: [{ pool: 'corporate', calls: 2, unpriced: 2, usd: 0 }] } }
  const text = b.text(b.show('sidebar.footer.action', { status: 'ready', data: partial }))
  assert.match(text, /未定价/); assert.doesNotMatch(text, /¥0\.00/)
})
await test('simultaneous reads coalesce, different sessions stay isolated, and later reads refetch', async () => {
  const b = boot(); let calls = 0
  const load = b.api.createSource({ get: () => ({ rpc: { call: async (_path, _method, body) => {
    calls++; return { ok: true, value: { ok: true, session: body.sessionId } }
  } } }) })
  const a = { sessionId: 'a', range: 'all', todayStart: 1 }
  const p = load(a); assert.equal(load(a), p)
  const q = load({ ...a, sessionId: 'b' })
  assert.equal((await p).session, 'a'); assert.equal((await q).session, 'b')
  assert.equal(calls, 2)
  await load(a); assert.equal(calls, 3)
  await load({ ...a, todayStart: 2 }); assert.equal(calls, 4)
})
await test('resident reads refresh at local midnight, pause when hidden, and clean up on unmount', async () => {
  const b = boot(); const requests = []
  b.api.LedgerContext.current = { load: async payload => { requests.push(payload); return data } }
  b.api.useReport('s1', 'all')
  const cleanup = b.effects[0]()
  await Promise.resolve()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionId, 's1')
  const poll = [...b.timers.values()][0]
  b.doc.visibilityState = 'hidden'; poll(); assert.equal(requests.length, 1)
  b.advance(4000); b.doc.visibilityState = 'visible'; b.events.get('visibilitychange')()
  await Promise.resolve()
  assert.equal(requests.length, 2)
  assert.ok(requests[1].todayStart > requests[0].todayStart)
  cleanup(); assert.equal(b.timers.size, 0); assert.equal(b.events.size, 0)
})
await test('an older host payload fails visibly instead of rendering a false zero', async () => {
  const b = boot()
  b.api.LedgerContext.current = { load: async () => ({ ok: true, totals }) }
  b.api.useReport(null, 'today'); const cleanup = b.effects[0]()
  await Promise.resolve()
  assert.equal(b.updates.at(-1).error, 'host-version')
  cleanup()
})

await test('sidebar is one button, preserves multi-pool detail and opens the settings ledger', () => {
  const b = boot(); let opened = 0, selected = 0, focused = 0
  const section = { textContent: 'API 账本', getAttribute: () => null, click: () => selected++, focus: () => focused++ }
  const dialog = { querySelectorAll: selector => { assert.equal(selector, 'nav button'); return [section] } }
  b.doc.querySelector = selector => {
    assert.equal(selector, '[data-slot="sidebar.settings"]')
    return { querySelector: selector => selector.startsWith('[role=') ? (opened ? dialog : null) : { click: () => opened++ } }
  }
  const tree = b.show('sidebar.footer.action', ready, { wide: true })
  const buttons = b.nodes(tree).filter(n => n.type === 'button')
  assert.equal(buttons.length, 1, 'no nested currency button')
  assert.match(b.text(tree), /\+1 组/)
  assert.match(buttons[0].props.title, /公司额度 ¥14\.29/)
  buttons[0].props.onClick()
  assert.equal(opened, 1); assert.equal(selected, 1); assert.equal(focused, 1)
  b.doc.querySelector = () => null
  assert.equal(b.api.openLedgerSettings('API 账本'), false)
})

await test('recent calls, single-day composition and day comparisons render without false zero pricing', () => {
  const b = boot()
  const row = { time: Date.now(), model: 'sample-model', route: 'sample-route', pool: 'personal-deepseek', priced: false, usd: 0, inputTokens: 100 }
  const enriched = { ...data, yesterday: { byPool: [] }, recent: Array.from({ length: 8 }, () => row), viewPools: [{ pool: 'personal-deepseek', totals: { ...totals, byDay: [{ day: '2026-09-21', inputTokens: 100, cacheReadTokens: 20 }], byModel: [{ key: 'sample', model: 'sample-model', calls: 1, unpriced: 1, usd: 0 }] } }] }
  const tree = b.show('settings.section', { status: 'ready', data: enriched })
  const text = b.text(tree)
  assert.match(text, /最近调用/)
  assert.match(text, /展开其余调用/)
  assert.match(text, /单日记录/)
  assert.match(text, /昨日 无记录/)
  assert.match(text, /未定价/)
  assert.equal(b.nodes(tree).filter(n => n.type === 'svg').length, 0)
})

await test('official mode renders current tariff and historical currency warning', () => {
  const b = boot()
  const enriched = { ...data, suspectCurrencyCount: 2, settings: { ...data.settings,
    routes: [{ route: 'direct', label: 'Direct', models: ['deepseek-flash'], official: true, active: true }],
    referenceModels: ['deepseek-flash'], officialPrices: { 'deepseek-flash': { tariff: 'peak', rates: { inputPerM: .3, outputPerM: 1.2, cacheReadPerM: .006 } } } } }
  const tree = b.show('settings.section', { status: 'ready', data: enriched })
  assert.match(b.text(tree), /官方价表估算/)
  assert.match(b.text(tree), /高峰/)
  assert.match(b.text(tree), /0.3/)
  assert.match(b.text(tree), /2 条记录疑似/)
  const mode = b.nodes(tree).find(n => n.type === 'select' && n.props.value === 'official')
  assert.ok(mode)
})

console.log(`client behavior: ${passed} passed`)
