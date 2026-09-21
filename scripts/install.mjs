/**
 * Install `dsh-api-ledger` into a DSH profile, without the `dsh` CLI.
 *
 * Why this exists: `dsh plugin --profile <name> add <path>` needs the CLI on
 * PATH, and a checkout-relative plugin is easiest to wire by hand anyway. This
 * performs exactly the three things that command performs, so the result is the
 * same shape the CLI would have produced:
 *
 *   1. the profile's `dependencies` gains `link:<abs path>`;
 *   2. the profile's `dsh.profile.bundles` gains the package name;
 *   3. `node_modules/<name>` becomes a relative symlink to the checkout.
 *
 * Idempotent: re-running it repairs a broken link and rewrites nothing else.
 * Run with `--uninstall` to reverse all three.
 *
 * Usage:
 *   node scripts/install.mjs                       # desktop profile, this package
 *   node scripts/install.mjs --profile web
 *   node scripts/install.mjs --uninstall
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

/** Parse `--flag value` pairs; anything unknown is a hard error, not a guess. */
function parseArgs(argv) {
  const out = { profile: 'desktop', uninstall: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--uninstall') { out.uninstall = true; continue }
    if (arg === '--profile') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error('--profile needs a value')
      out.profile = value
      continue
    }
    if (arg === '--help' || arg === '-h') { out.help = true; continue }
    throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help === true) {
  console.log(`Usage: node scripts/install.mjs [--profile <name>] [--uninstall]

Installs ${pkg.name} into $DSH_HOME/profiles/<name> (default: desktop).`)
  process.exit(0)
}

const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', args.profile)
const manifestPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', pkg.name)

if (!existsSync(manifestPath)) {
  console.error(`No profile manifest at ${manifestPath}`)
  console.error(`Known profiles:`)
  const profilesDir = join(dshHome, 'profiles')
  if (existsSync(profilesDir)) {
    for (const entry of readFileSync(profilesDir, 'utf8') === undefined ? [] : []) void entry
  }
  console.error(`  (list ${join(dshHome, 'profiles')} to see them)`)
  process.exit(1)
}

const original = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(original)

/** Atomic write: the profile manifest must never be left half-written. */
function writeManifest(value) {
  const tmp = `${manifestPath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, manifestPath)
}

/** Remove `<linkPath>` if it is a symlink (or a stale file). */
function removeLink() {
  if (!existsSync(linkPath) && !isSymlink(linkPath)) return false
  unlinkSync(linkPath)
  return true
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

if (args.uninstall) {
  let changed = false
  if (manifest.dependencies !== undefined && manifest.dependencies[pkg.name] !== undefined) {
    delete manifest.dependencies[pkg.name]
    changed = true
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    const next = bundles.filter((entry) => entry !== pkg.name)
    if (next.length !== bundles.length) {
      manifest.dsh.profile.bundles = next
      changed = true
    }
  }
  if (changed) writeManifest(manifest)
  const unlinked = removeLink()
  console.log(`uninstalled ${pkg.name} from profile "${args.profile}"`)
  console.log(`  manifest updated : ${changed ? 'yes' : 'no (already absent)'}`)
  console.log(`  node_modules link: ${unlinked ? 'removed' : 'absent'}`)
  console.log('\nRestart DSH for the change to take effect.')
  process.exit(0)
}

// ── install ──────────────────────────────────────────────────────────────────

const linkTarget = `link:${packageRoot}`

manifest.dependencies = manifest.dependencies ?? {}
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
manifest.dsh.profile.bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []

const manifestChanges = []
if (manifest.dependencies[pkg.name] !== linkTarget) {
  manifest.dependencies[pkg.name] = linkTarget
  manifestChanges.push(`dependencies["${pkg.name}"] = "${linkTarget}"`)
}
if (!manifest.dsh.profile.bundles.includes(pkg.name)) {
  manifest.dsh.profile.bundles.push(pkg.name)
  manifestChanges.push(`dsh.profile.bundles += "${pkg.name}"`)
}

// A relative link, matching how this profile already links its other checkouts
// (an absolute one works too, but a moved home would then break it).
const relativeTarget = relative(join(profileDir, 'node_modules'), packageRoot)

let linkChanged = false
const currentTarget = isSymlink(linkPath) ? readFileSync(linkPath, 'utf8') : null
if (currentTarget !== null && resolve(join(profileDir, 'node_modules'), currentTarget) === packageRoot) {
  // Already points at this checkout.
} else {
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  removeLink()
  symlinkSync(relativeTarget, linkPath, 'dir')
  linkChanged = true
}

if (manifestChanges.length > 0) writeManifest(manifest)

console.log(`installed ${pkg.name}@${pkg.version} into profile "${args.profile}"`)
console.log(`  manifest : ${manifestPath}`)
manifestChanges.forEach((line) => console.log(`    + ${line}`))
if (manifestChanges.length === 0) console.log('    (already registered)')
console.log(`  link     : ${linkPath} -> ${relativeTarget}`)
console.log(`             ${linkChanged ? 'created' : '(already correct)'}`)

// Verify the host half actually resolves the way the loader will resolve it, so
// a successful install is not mistaken for a working plugin.
try {
  const entry = join(linkPath, pkg.main ?? 'lib/index.js')
  if (!existsSync(entry)) throw new Error(`missing entry ${entry}`)
  console.log(`  entry    : ${entry}`)
} catch (error) {
  console.error(`  entry    : NOT RESOLVABLE — ${String(error)}`)
  process.exitCode = 1
}

console.log('\nRestart DSH, then look for:')
console.log('  · Settings → "API 账本 / API Ledger"')
console.log('  · a conversation tab "API 账本 / API Ledger" beside 对话 / 轨迹')
