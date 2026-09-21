/**
 * Client-half wiring test.
 *
 * The browser half is the one piece the host log cannot describe: a bundle can
 * be served, evaluated, and then fail inside `apply` with the error visible only
 * in the browser console. That failure mode looks exactly like "the plugin is
 * installed but no UI appears", which is impossible to diagnose from the host.
 *
 * So this test evaluates the REAL `lib/client.js` under a stub module loader and
 * a stub Cordis context, and asserts what `apply` actually registered. It does
 * not render React; it checks the registration contract the shell depends on.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
function test(label, fn) {
  fn()
  passed++
  console.log(`  ok  ${label}`)
}

/** Minimal React: enough for the factory body and for `apply`. */
const React = {
  createElement: (...args) => ({ __element: args }),
  createContext: (value) => ({ __context: value, Provider: 'Provider' }),
  useContext: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (compute) => compute(),
  useSyncExternalStore: () => null,
}

/** Evaluate the module and hand back the plugin it registers. */
function evaluateClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let captured = null
  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  }
  const localRequire = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }
  // The bundle's only ambient dependency is `window`; `require` arrives as the
  // factory parameter, exactly as the browser module loader passes it.
  new Function('window', source)(windowStub)
  assert.notEqual(captured, null, 'client.js must register itself with __ModuleLoader__')
  assert.equal(captured.id, 'dsh-api-ledger')
  assert.equal(typeof captured.factory, 'function')
  return captured.factory(localRequire)
}

/** A stub Cordis context that records slot registrations. */
function makeCtx(options = {}) {
  const registrations = []
  const injected = []
  const effects = []
  const slots = {
    inject(key, callback) {
      injected.push(key)
      callback()
    },
    register(registration, component) {
      registrations.push({ registration, component })
      return () => {}
    },
  }
  const locale = {
    register(namespace, dicts) {
      if (options.localeThrows === true) throw new Error('locale registration refused')
      return () => {}
    },
    getLocale: () => ({ active: options.active === undefined ? 'zh' : options.active }),
    subscribe: () => () => {},
    getSnapshot: () => null,
  }
  const ctx = {
    get(name) {
      if (name === 'slots') return options.noSlots === true ? undefined : slots
      if (name === 'locale') return options.noLocale === true ? undefined : locale
      return undefined
    },
    effect(fn) {
      effects.push(fn)
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: () => () => {},
  }
  return { ctx, registrations, injected, effects }
}

console.log('client')

test('the bundle evaluates and exports its plugin object', () => {
  const plugin = evaluateClient()
  assert.equal(plugin.name, 'dsh-api-ledger-client')
  assert.equal(typeof plugin.apply, 'function')
})

test('the plugin declares slots as a hard dependency', () => {
  // Without this declaration `apply` may run before the service exists, take
  // the `slots === undefined` early return, and contribute nothing — silently,
  // with a healthy host log. Declaring it makes Cordis hold the plugin until
  // the service appears instead.
  const plugin = evaluateClient()
  assert.ok(Array.isArray(plugin.inject), 'inject must be declared on the plugin object')
  assert.ok(plugin.inject.includes('slots'), 'slots must be injected')
})

test('the package manifest declares the client modules the bundle needs', () => {
  // `dsh.client.inject` orders the client module graph. Only REAL client
  // modules belong here: naming one that publishes no `dsh.client` (for
  // instance `@deepseek-ai/dsh-client-ui-slots`, which is not a deliverable
  // client bundle) would reference something the graph cannot load.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const inject = manifest.dsh && manifest.dsh.client && manifest.dsh.client.inject
  assert.ok(Array.isArray(inject) && inject.length > 0, 'dsh.client.inject must list the needed modules')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-locale'), 'locale module must be declared')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-settings'), 'settings module must be declared')
  assert.ok(!inject.includes('@deepseek-ai/dsh-client-ui-slots'), 'ui-slots is not a client module and must not be named')
})

test('apply registers BOTH seats with the shell-visible ids and orders', () => {
  const plugin = evaluateClient()
  const built = makeCtx()
  plugin.apply(built.ctx)

  const byName = {}
  built.registrations.forEach((entry) => { byName[entry.registration.name] = entry.registration })

  assert.ok(byName['settings.section'], 'settings.section must be registered')
  assert.equal(byName['settings.section'].id, 'api-ledger')
  assert.equal(byName['settings.section'].order, 36)

  assert.ok(byName['conversation.view'], 'conversation.view must be registered')
  assert.equal(byName['conversation.view'].id, 'api-ledger')
  // Order 50 is the whole point of the seat: rightmost, after the approval
  // ledger (40). A silent revert to 35 would look like "it renders in the wrong
  // place" rather than a bug.
  assert.equal(byName['conversation.view'].order, 50)
})

test('resident cost readouts use the supported session dock and sidebar seats', () => {
  const plugin = evaluateClient()
  const built = makeCtx()
  plugin.apply(built.ctx)
  for (const name of ['conversation.composer.dock', 'sidebar.footer.action']) {
    const entry = built.registrations.find(e => e.registration.name === name)
    assert.ok(entry, name)
    assert.equal(entry.registration.id, 'api-ledger')
    assert.equal(typeof entry.component, 'function')
  }
})

test('a missing slots service yields no registrations instead of throwing', () => {
  const plugin = evaluateClient()
  const built = makeCtx({ noSlots: true })
  plugin.apply(built.ctx)
  assert.deepEqual(built.registrations, [])
})

test('a missing locale service still registers both seats', () => {
  const plugin = evaluateClient()
  const built = makeCtx({ noLocale: true })
  plugin.apply(built.ctx)
  assert.equal(built.registrations.length, 4)
})

test('the nav labels are thunks that follow the active locale', () => {
  const plugin = evaluateClient()
  const zh = makeCtx({ active: 'zh' })
  plugin.apply(zh.ctx)
  const zhLabel = zh.registrations.find((e) => e.registration.name === 'settings.section').registration.label
  assert.equal(typeof zhLabel, 'function', 'label must be a thunk so a language switch needs no re-registration')
  assert.equal(zhLabel(), 'API 账本')

  const en = makeCtx({ active: 'en' })
  plugin.apply(en.ctx)
  const enLabel = en.registrations.find((e) => e.registration.name === 'settings.section').registration.label
  assert.equal(enLabel(), 'API Ledger')
})

test('a locale registration failure must NOT cost the UI', () => {
  // This is the failure this test exists for: `apply` registers the locale
  // dictionaries BEFORE it registers any slot, so an exception there aborts the
  // function and the plugin mounts with no UI at all — visible only as "nothing
  // appears", with the host log showing a healthy plugin.
  const plugin = evaluateClient()
  const built = makeCtx({ localeThrows: true })
  plugin.apply(built.ctx)
  assert.equal(built.registrations.length, 4, 'slots must still register when the locale service refuses')
})

console.log(`client: ${passed} passed`)
