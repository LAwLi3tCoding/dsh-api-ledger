#!/usr/bin/env node
/**
 * Pre-publish gate.
 *
 * Publishing is the one irreversible operation in this repository: a version is
 * immutable, so whatever ships stays downloadable. The gate therefore inspects
 * the ARTIFACT THAT WOULD SHIP — the packed tarball, not the source tree — and
 * fails closed on anything it cannot explain:
 *
 *   1. the working tree must be committed, so a published tarball always
 *      corresponds to a commit somebody can read;
 *   2. every packed file must be tracked by HEAD;
 *   3. no packed file may contain a credential shape, an absolute local path,
 *      or a name from the local deny list (see `DENY_FILE`);
 *   4. every packed `lib/*.js` must parse;
 *   5. the tarball must install and expose the API it claims;
 *   6. the version must not already exist on the registry, nor be a downgrade;
 *   7. the test suite must pass.
 *
 * The deny list lives OUTSIDE this file on purpose: this script is itself
 * published to a public repository, so embedding machine- or company-specific
 * names here would leak exactly what it exists to catch. The built-in rules are
 * generic shapes only.
 *
 * Wired into `prepublishOnly`, so `npm publish` cannot skip it. Run by hand
 * with `npm run publish:check`.
 *
 * Checks run cheapest-first and every one reports its outcome: a gate that
 * fails silently is worse than no gate at all.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Generic, publishable rules: credential SHAPES and local machine paths.
 * Anything company- or machine-specific belongs in the deny file instead.
 *
 * The third column marks a rule whose matched text must never be echoed: a hit
 * report gets pasted into issues and chat, and that is exactly how a secret
 * escapes the machine it was found on.
 */
const SHARED_RULES = [
  [/\/Users\/[A-Za-z0-9._-]+/, 'absolute local home path', false],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token', true],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'API key', true],
  [/\bghp_[A-Za-z0-9]{20,}\b/, 'GitHub token', true],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key', true],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key', true],
  [/_authToken/i, 'registry credential field', true],
  [/\bssoid\b/i, 'SSO identity token', true],
]

/** A deny file holds case-insensitive regexes, one per line, `#` for comments. */
const DENY_FILE = process.env.PUBLISH_DENY_FILE || join(ROOT, '.publish-deny.txt')

/**
 * Packed binaries cannot be read, so they are refused rather than waved
 * through. Adding one here is a deliberate act, visible in a diff.
 */
const ALLOWED_BINARY = []

const EXPORTS = ['ratesFor', 'evaluateTariff', 'resolveTariffs', 'priceUsage']

const problems = []
const pass = label => console.log(`  ok   ${label}`)
const note = label => console.log(`  --   ${label}`)
function fail(label) {
  problems.push(label)
  console.log(`  FAIL ${label}`)
}
function detail(text, lines = 6) {
  return String(text).split('\n').slice(-lines).map(line => `       ${line}`).join('\n')
}

function run(command, args) {
  try {
    const out = execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: String(out) }
  } catch (error) {
    const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim()
    return { ok: false, out: text || String(error?.message ?? error) }
  }
}

function walk(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, found)
    else found.push(relative(base, full))
  }
  return found
}

function isLower(left, right) {
  const a = String(left).split('-')[0].split('.').map(Number)
  const b = String(right).split('-')[0].split('.').map(Number)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}

/** Built-in rules plus the local deny list, if one exists. */
function activeRules() {
  const list = [...SHARED_RULES]
  if (!existsSync(DENY_FILE)) {
    note(`no deny list at ${relative(ROOT, DENY_FILE)} — generic rules only`)
    return list
  }
  let count = 0
  for (const raw of readFileSync(DENY_FILE, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    try {
      // The pattern travels with the label: two rules can match one line, and
      // "deny list" twice would say nothing about which one fired.
      list.push([new RegExp(line, 'i'), `deny list (${line})`, false])
      count++
    } catch {
      fail(`deny list entry is not a valid regex: ${line}`)
    }
  }
  note(`deny list: ${count} local rule(s) from ${relative(ROOT, DENY_FILE)}`)
  return list
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
console.log(`publish-check: ${pkg.name}@${pkg.version}`)
if (pkg.private === true) fail('package.json is private and cannot be published')

// 1. A published tarball must correspond to a commit.
const status = run('git', ['status', '--porcelain'])
if (!status.ok) note('git is unavailable — skipped the clean-tree check')
else if (status.out.trim().length > 0) fail(`working tree is dirty; commit or stash first:\n${status.out.trim().split('\n').map(l => `       ${l}`).join('\n')}`)
else pass('working tree is committed')

const tracked = new Set()
const head = run('git', ['ls-tree', '-r', '--name-only', 'HEAD'])
if (head.ok) for (const path of head.out.split('\n')) if (path.length > 0) tracked.add(path)

// 2-5. Pack for real, then inspect what would actually ship.
const work = mkdtempSync(join(tmpdir(), 'publish-check-'))
try {
  const packed = run('npm', ['pack', '--pack-destination', work])
  const tarballs = existsSync(work) ? readdirSync(work).filter(name => name.endsWith('.tgz')) : []
  if (!packed.ok || tarballs.length !== 1) {
    fail(`npm pack failed:\n${detail(packed.out)}`)
  } else {
    const tarball = join(work, tarballs[0])
    const listed = run('tar', ['-tzf', tarball])
    const shipped = listed.ok ? listed.out.split('\n').filter(Boolean).map(entry => entry.replace(/^package\//, '')).filter(Boolean) : []
    pass(`packed ${shipped.length} file(s): ${tarballs[0]}`)

    const untar = run('tar', ['-xzf', tarball, '-C', work])
    const root = join(work, 'package')
    if (!untar.ok || !existsSync(root)) {
      fail(`could not extract the tarball:\n${detail(untar.out)}`)
    } else {
      if (tracked.size === 0) note('git HEAD is unavailable — skipped the committed-files check')
      else {
        const uncommitted = shipped.filter(path => !tracked.has(path))
        if (uncommitted.length > 0) fail(`packed files are not committed: ${uncommitted.join(', ')}`)
        else pass('every packed file is committed')
      }

      // 3. Fail-closed content scan: any hit refuses the publish.
      const rules = activeRules()
      const hits = []
      for (const path of walk(root)) {
        const bytes = readFileSync(join(root, path))
        if (bytes.includes(0)) {
          if (!ALLOWED_BINARY.includes(path)) hits.push(`${path}: unreadable binary (list it in ALLOWED_BINARY if intentional)`)
          continue
        }
        bytes.toString('utf8').split('\n').forEach((line, index) => {
          for (const [pattern, label, redact] of rules) {
            if (!pattern.test(line)) continue
            // Credential-shaped hits stay location-only: the report is often
            // pasted somewhere, and the match IS the secret.
            hits.push(redact ? `${path}:${index + 1}: ${label}` : `${path}:${index + 1}: ${label} — ${line.trim().slice(0, 80)}`)
          }
        })
      }
      if (hits.length > 0) fail(`packed content is not publishable:\n${hits.slice(0, 20).map(h => `       ${h}`).join('\n')}`)
      else pass(`no credential shapes, local paths or denied names in ${rules.length} rule(s)`)

      // 4. Everything that executes at runtime must parse.
      const syntax = shipped.filter(path => /^lib\/.*\.js$/.test(path))
      const broken = syntax.filter(path => !run('node', ['--check', join(root, path)]).ok)
      if (broken.length > 0) fail(`packed files do not parse: ${broken.join(', ')}`)
      else pass(`${syntax.length} packed lib file(s) parse`)

      // 5. The artifact must install and expose its API.
      const prefix = join(work, 'install')
      const install = run('npm', ['install', '--prefix', prefix, tarball, '--no-audit', '--no-fund'])
      const installedRoot = join(prefix, 'node_modules', pkg.name)
      if (!install.ok || !existsSync(installedRoot)) {
        fail(`the tarball does not install:\n${detail(install.out)}`)
      } else {
        const installed = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'))
        if (installed.version !== pkg.version) fail(`installed version ${installed.version} != ${pkg.version}`)
        const pricing = await import(pathToFileURL(join(installedRoot, 'lib', 'pricing.js')).href)
        const host = await import(pathToFileURL(join(installedRoot, 'lib', 'index.js')).href)
        const missing = EXPORTS.filter(name => typeof pricing[name] !== 'function')
        if (missing.length > 0) fail(`installed pricing.js is missing: ${missing.join(', ')}`)
        else if (host.name !== pkg.name || typeof host.apply !== 'function') fail('installed index.js does not export the plugin contract')
        else pass(`installs as ${installed.version} and exposes the plugin contract`)
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

// 6. The registry decides whether this version is publishable at all.
try {
  const response = await fetch(`https://registry.npmjs.org/${pkg.name}`, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) note(`registry answered HTTP ${response.status} — skipped the version check`)
  else {
    const data = await response.json()
    const latest = data?.['dist-tags']?.latest
    if (data?.versions && Object.hasOwn(data.versions, pkg.version)) fail(`${pkg.version} is already published — bump the version`)
    else if (typeof latest === 'string' && isLower(pkg.version, latest)) fail(`${pkg.version} is lower than the published latest (${latest}) — bump the version`)
    else pass(`registry: latest is ${latest ?? 'unknown'}, ${pkg.version} is free`)
  }
} catch {
  note('registry unreachable — skipped the version check')
}

// 7. Nothing ships untested.
const tests = run('npm', ['test'])
const checks = [...tests.out.matchAll(/(\d+) passed/g)].map(m => Number(m[1])).reduce((sum, n) => sum + n, 0)
if (!tests.ok) fail(`test suite failed:\n${detail(tests.out, 8)}`)
else pass(`test suite: ${checks} checks passed`)

if (problems.length > 0) {
  console.error(`publish-check: FAILED (${problems.length} problem(s)) — do not publish`)
  process.exit(1)
}
console.log('publish-check: passed')
