/** Local billing preferences. No credentials or provider settings are written. */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { normalizeOverride, REFERENCE_MODELS } from './pricing.js'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeName = value => typeof value === 'string' && value.length <= 160 && !/[\x00-\x1f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
export function readPreferences(file) {
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '{}'
  const config = JSON.parse(raw)
  if (!plain(config)) throw new Error('invalid-config')
  for (const key of ['pricing', 'pools', 'labels']) {
    if (config[key] !== undefined && !plain(config[key])) throw new Error('invalid-config')
  }
  return { config, revision: createHash('sha256').update(raw).digest('hex') }
}

export function savePreference(file, args, knownRoutes) {
  const current = readPreferences(file)
  if (args?.revision !== current.revision) throw new Error('config-conflict')
  if (!safeName(args.route) || !knownRoutes.includes(args.route)) throw new Error('unknown-route')
  const cfg = current.config
  if (args.action === 'remove') {
    for (const key of ['labels', 'pools']) if (cfg[key]) delete cfg[key][args.route]
    if (cfg.pricing) for (const key of Object.keys(cfg.pricing)) if (key.startsWith(args.route + '/')) delete cfg.pricing[key]
  } else {
  if (!safeName(args.label) || !safeName(args.group)) throw new Error('invalid-label')
  cfg.labels = { ...cfg.labels, [args.route]: args.label.trim() }
  cfg.pools = { ...cfg.pools, [args.route]: args.group.trim() }
  if (args.model) {
    if (!safeName(args.model)) throw new Error('invalid-model')
    let price
    if (args.mode === 'none') price = { mode: 'none' }
    else if (args.mode === 'reference') {
      if (!REFERENCE_MODELS.includes(args.model)) throw new Error('no-reference-price')
      price = { mode: 'reference' }
    } else if (args.mode === 'custom') {
      price = normalizeOverride(args.rates)
      if (!price) throw new Error('invalid-price')
      price = { ...price, mode: 'custom' }
      delete price.pool
    } else throw new Error('invalid-price-mode')
    cfg.pricing = { ...cfg.pricing, [`${args.route}/${args.model}`]: price }
  }
  }
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, file)
  return { ok: true }
}
