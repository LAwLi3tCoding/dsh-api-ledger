/**
 * Credential identity: which key paid for a call.
 *
 * The capture seam (`llm/stream`) sees only a ROUTE name — `GenerateOptions.provider`.
 * It never sees a key, and it must not: a key value belongs to the credentials
 * service and must never reach the ledger file, the browser, or a log line.
 *
 * So the identity this ledger records is the credential REFERENCE — the
 * `apiKeyEnv` name, e.g. `EXAMPLE_GATEWAY_API_KEY`. That is enough to answer "which key
 * paid": two keys are distinguishable exactly when they are two routes, and
 * each route's profile names its own reference.
 *
 * The mapping lives in the llm service's configurable-provider directory plus
 * the settings namespace each entry points at, so it is read fresh rather than
 * baked into this file. Nothing here reads, copies, or returns a key VALUE —
 * `credentials.resolve()` is the only thing that materializes one, and this
 * module never calls it.
 */

/** Fallback reference for the official DeepSeek adapter when it declares none. */
const DEEPSEEK_DEFAULT_KEY_ENV = 'DEEPSEEK_API_KEY'

/**
 * Read one settings path (`['providers', 'exampleGateway']`) without assuming the
 * intermediate objects exist. A profile that is mid-edit must degrade to
 * "unknown reference", never throw into the capture path.
 */
function readPath(root, path) {
  let node = root
  for (const step of Array.isArray(path) ? path : []) {
    if (node === null || typeof node !== 'object') return null
    node = node[step]
  }
  return node === undefined ? null : node
}

/**
 * Build the route → credential-reference directory.
 *
 * Fail-soft by design: a deployment with no llm service, no directory, or a
 * route the directory does not describe simply contributes nothing, and the
 * report falls back to the route name as the identity. Recording spend must
 * never depend on this succeeding.
 *
 * @param {object} deps
 * @param {object|undefined} deps.llm - the `llm` service, if mounted.
 * @param {object|undefined} deps.settings - the `settings` service, if mounted.
 * @returns {Promise<Record<string, { provider: string, label: string, keyRef: string|null, baseURL: string|null, declared: boolean }>>}
 */
export async function resolveIdentities({ llm, settings } = {}) {
  const out = Object.create(null)
  if (llm === null || llm === undefined || typeof llm.listConfigurableProviders !== 'function') return out

  let directory
  try {
    directory = llm.listConfigurableProviders()
    // The @Remote signature is synchronous locally, but a carrier may hand
    // back a promise; one await covers both without assuming which.
    if (directory !== null && typeof directory === 'object' && typeof directory.then === 'function') {
      directory = await directory
    }
  } catch {
    return out
  }
  if (!Array.isArray(directory)) return out

  for (const entry of directory) {
    if (entry === null || typeof entry !== 'object') continue
    const provider = entry.provider
    if (typeof provider !== 'string' || provider.length === 0) continue

    let profile = null
    if (settings !== undefined && settings !== null && typeof settings.get === 'function'
      && typeof entry.settingsNs === 'string' && entry.settingsNs.length > 0) {
      try {
        profile = settings.get(entry.settingsNs)
      } catch {
        profile = null
      }
    }

    // `settingsPath` addresses the profile INSIDE the namespace: a multi-route
    // adapter walks to `providers.<id>`, a single-route adapter passes no path
    // and names the section itself.
    const scoped = readPath(profile, entry.settingsPath)
    const cfg = scoped !== null && typeof scoped === 'object' ? scoped : {}

    // Prefer the reference the route actually declares. Only the official
    // DeepSeek adapter has a meaningful default; every other route must
    // declare one, because guessing a name would attribute spend to a
    // credential that may not exist.
    const explicit = typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv.length > 0 ? cfg.apiKeyEnv : null
    const keyRef = explicit !== null
      ? explicit
      : (entry.settingsNs === 'llm-deepseek' ? DEEPSEEK_DEFAULT_KEY_ENV : null)

    out[provider] = {
      provider,
      models: Array.isArray(cfg.models) ? cfg.models.map(m => typeof m === 'string' ? m : m?.id).filter(m => typeof m === 'string') : [],
      label: typeof entry.displayName === 'string' && entry.displayName.length > 0
        ? entry.displayName
        : (typeof cfg.displayName === 'string' && cfg.displayName.length > 0 ? cfg.displayName : provider),
      // `null` is a real answer: "this route declares no reference". The report
      // then keys the row by route name and marks the reference unknown, rather
      // than inventing a plausible-looking variable name.
      keyRef,
      baseURL: typeof cfg.baseURL === 'string' && cfg.baseURL.length > 0 ? cfg.baseURL : null,
      declared: entry.declared === true,
      configured: Object.keys(cfg).length > 0,
    }
  }
  return out
}

/** Keep routes independent, retaining a credential reference only as metadata. */
export function identityOf(route, identities) {
  const entry = identities !== null && typeof identities === 'object' ? identities[route] : undefined
  if (entry === undefined) {
    return { id: route, label: route, keyRef: null }
  }
  return {
    id: route,
    label: entry.label,
    keyRef: entry.keyRef,
  }
}
