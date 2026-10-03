// localStorage helpers. Storage may be unavailable (private mode, blocked
// site data): every call fails soft and the app keeps working without it.

export const STORE = {
  config: 'mf.config',
  token: 'mf.token',
  cache: 'mf.cache.v1',
  drafts: 'mf.drafts.v1'
}

export function readJSON (key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function writeJSON (key, value) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // A cache is a convenience: nothing to do.
  }
}
