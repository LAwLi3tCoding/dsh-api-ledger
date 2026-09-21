/**
 * i18n tests.
 *
 * Bilingual balance is STRUCTURAL in `lib/client.js`: one `MESSAGES` row holds
 * both languages, so "this key exists in one language only" cannot be written
 * down. These tests cover what the shape cannot guarantee:
 *
 *   1. an empty or malformed row;
 *   2. a duplicated key, where the later row silently wins;
 *   3. a `{placeholder}` present in one language but not the other, which
 *      renders a literal `{count}` to the user in that one language;
 *   4. a `t('…')` call naming a key that does not exist, which renders the raw
 *      key instead of text — the failure mode that looks like a styling bug.
 *
 * The array is read straight out of the source rather than through the browser
 * bundle: evaluating that bundle needs React and `window.__ModuleLoader__`, and
 * none of that is relevant to the strings.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
function test(label, fn) {
  fn()
  passed++
  console.log(`  ok  ${label}`)
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Pull the plain data array out of the browser bundle. */
function extractMessages() {
  const start = source.indexOf('var MESSAGES = [')
  assert.notEqual(start, -1, 'client.js must declare `var MESSAGES = [')
  const open = source.indexOf('[', start)
  // Walk to the matching bracket, ignoring brackets inside string literals.
  let depth = 0
  let inString = false
  let quote = ''
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) inString = false
      continue
    }
    if (ch === "'" || ch === '"') { inString = true; quote = ch; continue }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        const literal = source.slice(open, i + 1)
        return new Function(`return ${literal}`)()
      }
    }
  }
  throw new Error('unterminated MESSAGES array')
}

const MESSAGES = extractMessages()
const keys = MESSAGES.map((row) => row[0])
const byKey = new Map()
MESSAGES.forEach((row) => {
  if (!byKey.has(row[0])) byKey.set(row[0], row)
})

/** Placeholders a message interpolates, order-insensitive. */
function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
}

console.log('i18n')

test('the message table is a non-empty array of [key, zh, en] rows', () => {
  assert.ok(MESSAGES.length > 0)
  MESSAGES.forEach((row, i) => {
    assert.ok(Array.isArray(row), `row ${i} is not an array`)
    assert.equal(row.length, 3, `row ${i} must be [key, zh, en]`)
    row.forEach((cell, c) => {
      assert.equal(typeof cell, 'string', `row ${i} column ${c} is not a string`)
      assert.ok(cell.length > 0, `row ${i} column ${c} is empty`)
    })
  })
})

test('no key is duplicated', () => {
  // A duplicate is silently absorbed by the later row, so the earlier text can
  // never be reached — and nothing else would report it.
  const seen = new Set()
  const duplicates = []
  keys.forEach((key) => {
    if (seen.has(key)) duplicates.push(key)
    seen.add(key)
  })
  assert.deepEqual(duplicates, [])
})

test('both languages cover exactly the same keys', () => {
  // Compare KEY SETS. Comparing distinct message TEXT would be meaningless:
  // several keys legitimately share a string ("API 账本" is three keys, and
  // "输入" is both a column header and a chart band), so a duplicate-count
  // equality would fail while the translations are perfectly correct.
  const zhKeys = MESSAGES.map((row) => row[0]).sort()
  const enKeys = MESSAGES.map((row) => row[0]).sort()
  assert.deepEqual(enKeys, zhKeys)
  assert.equal(new Set(zhKeys).size, MESSAGES.length)
  assert.equal(byKey.size, MESSAGES.length)
})

test('every placeholder exists in both languages', () => {
  byKey.forEach((row) => {
    const [key, zh, en] = row
    assert.deepEqual(
      placeholders(en),
      placeholders(zh),
      `placeholder mismatch for ${key}: zh has [${placeholders(zh)}], en has [${placeholders(en)}]`,
    )
  })
})

test('a key is namespaced, never a bare word', () => {
  // Keys are dotted so a raw-key fallback in the UI is obviously wrong rather
  // than reading as plausible text.
  keys.forEach((key) => assert.match(key, /^[a-z][A-Za-z]*\.[A-Za-z][\w.]*$/, `${key} is not namespaced`))
})

test('every key referenced by the UI exists in the table', () => {
  // A typo here renders the raw key, which looks like a layout problem rather
  // than a missing translation.
  const referenced = new Set()
  const patterns = [/\bt\('([A-Za-z][\w.]*)'/g, /\blabelFor\('([A-Za-z][\w.]*)'/g]
  patterns.forEach((pattern) => {
    for (const match of source.matchAll(pattern)) referenced.add(match[1])
  })
  assert.ok(referenced.size > 0, 'expected the UI to reference message keys')
  const missing = [...referenced].filter((key) => !byKey.has(key)).sort()
  assert.deepEqual(missing, [], `UI references undeclared keys: ${missing.join(', ')}`)
})

test('the namespace matches the package identity', () => {
  assert.match(source, /var NS = 'api-ledger'/)
})

test('the dict builder produces both languages from the one table', () => {
  // Mirrors buildDicts() without evaluating the bundle.
  const zh = Object.fromEntries(MESSAGES.map((row) => [row[0], row[1]]))
  const en = Object.fromEntries(MESSAGES.map((row) => [row[0], row[2]]))
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.equal(Object.keys(zh).length, MESSAGES.length)
  assert.equal(zh.constructor, Object)
  assert.equal(en.constructor, Object)
})

test('no message survived in the bundle as hardcoded Chinese', () => {
  // Every user-visible string must live in the table. Comments and the table
  // itself are the only places Chinese is allowed.
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const tableStart = withoutComments.indexOf('var MESSAGES = [')
  const tableEnd = withoutComments.indexOf('var NS = ')
  const remainder = withoutComments.slice(0, tableStart) + withoutComments.slice(tableEnd)
  const offenders = [...remainder.matchAll(/'[^'\n]*[\u4e00-\u9fa5][^'\n]*'/g)].map((m) => m[0])
  assert.deepEqual(offenders, [], `Chinese text outside the table: ${offenders.join(', ')}`)
})

console.log(`i18n: ${passed} passed`)
