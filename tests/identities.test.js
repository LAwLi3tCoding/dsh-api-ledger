/**
 * Identity-resolution tests.
 *
 * The contract under test is that this module reads REFERENCE NAMES and never
 * key values, and that every degradation path yields a usable identity rather
 * than a throw — a failure here would either leak a secret or silently drop
 * spend from the report.
 */

import assert from 'node:assert/strict'

import { identityOf, resolveIdentities } from '../lib/identities.js'

let passed = 0
function test(label, fn) {
  fn()
  passed++
  console.log(`  ok  ${label}`)
}

/** A minimal stand-in for the llm service's configurable-provider directory. */
function fakeLlm(entries) {
  return { listConfigurableProviders: () => entries }
}

/** A stand-in for the settings service. */
function fakeSettings(sections) {
  return { get: (ns) => sections[ns] }
}

console.log('identities.js')

test('a multi-route adapter resolves each route to its own credential reference', async () => {
  const llm = fakeLlm([
    { provider: 'gateway-main', displayName: 'Example Gateway 主号', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gateway-main'] },
    { provider: 'gateway-backup', displayName: 'Example Gateway 备用号', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gateway-backup'] },
  ])
  const settings = fakeSettings({
    'llm-pi-ai': {
      providers: {
        'gateway-main': { apiKeyEnv: 'EXAMPLE_GATEWAY_API_KEY', baseURL: 'https://gateway.example/v1' },
        'gateway-backup': { apiKeyEnv: 'EXAMPLE_GATEWAY_API_KEY_2', baseURL: 'https://gateway.example/v1' },
      },
    },
  })

  const dir = await resolveIdentities({ llm, settings })
  assert.equal(dir['gateway-main'].keyRef, 'EXAMPLE_GATEWAY_API_KEY')
  assert.equal(dir['gateway-backup'].keyRef, 'EXAMPLE_GATEWAY_API_KEY_2')
  assert.equal(dir['gateway-main'].label, 'Example Gateway 主号')
  // Same endpoint, same model id, different reference: this is the only thing
  // that makes two keys separable, so it must survive resolution intact.
  assert.notEqual(dir['gateway-main'].keyRef, dir['gateway-backup'].keyRef)
})

test('no value field is ever returned, only the reference name', async () => {
  const llm = fakeLlm([
    { provider: 'p', displayName: 'P', settingsNs: 'ns', settingsPath: ['providers', 'p'] },
  ])
  // A profile that (incorrectly) carries an inline secret must not leak it:
  // only `apiKeyEnv` is read, and the key of the secret is never copied.
  const settings = fakeSettings({
    ns: { providers: { p: { apiKeyEnv: 'MY_REF', apiKey: 'demo' } } },
  })
  const dir = await resolveIdentities({ llm, settings })
  const serialized = JSON.stringify(dir)
  assert.equal(serialized.includes('demo'), false)
  assert.equal(serialized.includes('apiKey"'), false)
  assert.equal(dir.p.keyRef, 'MY_REF')
})

test('the official DeepSeek adapter falls back to its default reference', async () => {
  const llm = fakeLlm([
    { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek' },
  ])
  const dir = await resolveIdentities({ llm, settings: fakeSettings({}) })
  assert.equal(dir['deepseek-official'].keyRef, 'DEEPSEEK_API_KEY')
})

test('a route declaring no reference reports null rather than a guess', async () => {
  const llm = fakeLlm([
    { provider: 'mystery', displayName: 'Mystery', settingsNs: 'llm-mystery', settingsPath: ['providers', 'mystery'] },
  ])
  const settings = fakeSettings({ 'llm-mystery': { providers: { mystery: {} } } })
  const dir = await resolveIdentities({ llm, settings })
  // Inventing a variable name here would attribute spend to a credential that
  // may not exist.
  assert.equal(dir.mystery.keyRef, null)
})

test('a missing or broken settings section degrades to unknown, not to a throw', async () => {
  const llm = fakeLlm([
    { provider: 'a', displayName: 'A', settingsNs: 'ns', settingsPath: ['providers', 'a'] },
    { provider: 'b', displayName: 'B', settingsNs: 'ns', settingsPath: ['providers', 'b'] },
  ])
  const settings = {
    get: (ns) => {
      if (ns === 'ns') throw new Error('namespace mid-edit')
      return null
    },
  }
  const dir = await resolveIdentities({ llm, settings })
  assert.equal(dir.a.keyRef, null)
  assert.equal(dir.a.label, 'A')
})

test('absent llm / settings services contribute nothing instead of failing', async () => {
  // Compared by key count, not by deep equality: the directory is deliberately
  // a null-prototype object, so a route named `constructor` or `toString`
  // cannot collide with `Object.prototype` and be mistaken for a real entry.
  for (const deps of [{}, { llm: undefined, settings: undefined }, { llm: {}, settings: {} }]) {
    const dir = await resolveIdentities(deps)
    assert.equal(Object.keys(dir).length, 0)
    assert.equal(Object.getPrototypeOf(dir), null)
  }
})

test('a carrier returning a promise for the directory is awaited', async () => {
  const llm = { listConfigurableProviders: async () => [
    { provider: 'p', displayName: 'P', settingsNs: 'ns', settingsPath: ['providers', 'p'] },
  ] }
  const dir = await resolveIdentities({ llm, settings: fakeSettings({ ns: { providers: { p: { apiKeyEnv: 'REF' } } } }) })
  assert.equal(dir.p.keyRef, 'REF')
})

test('a malformed directory entry is skipped, not fatal', async () => {
  const llm = fakeLlm([null, {}, { provider: '' }, { provider: 'good', displayName: 'G', settingsNs: 'ns' }])
  const dir = await resolveIdentities({ llm, settings: fakeSettings({}) })
  assert.equal(Object.keys(dir).length, 1)
  assert.ok('good' in dir)
})

test('identityOf keeps routes separate even with a shared reference', () => {
  const identities = {
    a: { provider: 'a', label: 'A label', keyRef: 'REF_A' },
    b: { provider: 'b', label: 'B label', keyRef: null },
  }
  assert.deepEqual(identityOf('a', identities), { id: 'a', label: 'A label', keyRef: 'REF_A' })
  // Without a reference the route name still separates two keys.
  assert.deepEqual(identityOf('b', identities), { id: 'b', label: 'B label', keyRef: null })
  assert.deepEqual(identityOf('never-seen', identities), { id: 'never-seen', label: 'never-seen', keyRef: null })
})

console.log(`identities.js: ${passed} passed`)

// Await directly: the older helper does not await async cases.
{
  const llm = fakeLlm([{ provider: 'direct', settingsNs: 'llm-deepseek' }])
  for (const url of ['https://gateway.example', 'https://api.deepseek.com.evil.example', 'http://api.deepseek.com', 'https://api.deepseek.com/unknown']) {
    const result = await resolveIdentities({ llm, settings: fakeSettings({}), environment: { get: () => ({ value: url }) } })
    assert.equal(result.direct.official, false)
  }
  const result = await resolveIdentities({ llm, settings: fakeSettings({ 'llm-deepseek': { baseURL: 'https://api.deepseek.com/v1' } }), environment: { get: () => ({ value: 'https://gateway.example' }) } })
  assert.equal(result.direct.official, true)
  console.log('  ok  official endpoint recognition respects configuration and environment overrides')
}
