// Talks to the Apps Script API: Google sign-in (ID token), read everything,
// save a plan. In demo mode (?demo) it reads fixtures/ and keeps saves in memory.
// Every call resolves to the API body: {ok: true, ...} or {ok: false, status, error, message}.

import { STORE, readJSON, writeJSON } from './storage.js'

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const ENDPOINT_RE = /^https:\/\/script\.google\.com\/.+\/exec$/

export const DEMO = new URLSearchParams(location.search).has('demo')

export function config () {
  return { ...(window.MENU_CONFIG || {}), ...(readJSON(STORE.config) || {}) }
}

// --- Google sign-in ----------------------------------------------------------

let gisPromise = null
let gisClientId = null
let tokenWaiters = []
let signInUi = { show () {}, hide () {} }

// The page tells the API how to show and hide its sign-in box.
export function setSignInUi (ui) {
  signInUi = ui
}

function loadGis () {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = GIS_SRC
      s.async = true
      s.onload = () => resolve(window.google.accounts.id)
      s.onerror = () => {
        gisPromise = null
        reject(new Error('Google sign-in unavailable'))
      }
      document.head.append(s)
    })
  }
  return gisPromise
}

function decodeJwt (jwt) {
  const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

function storedToken () {
  const t = readJSON(STORE.token)
  return t && t.exp - 60 > Date.now() / 1000 ? t : null
}

function onCredential (response) {
  const claims = decodeJwt(response.credential)
  const token = { value: response.credential, exp: claims.exp, email: claims.email }
  writeJSON(STORE.token, token)
  signInUi.hide()
  tokenWaiters.splice(0).forEach(resolve => resolve(token))
}

// Resolves when the user has signed in (silently via auto-select, or with the button).
export async function requestToken (clientId) {
  const gis = await loadGis()
  if (gisClientId !== clientId) {
    gis.initialize({
      client_id: clientId,
      callback: onCredential,
      auto_select: true,
      use_fedcm_for_prompt: true,
      itp_support: true
    })
    gisClientId = clientId
    signInUi.render(el => gis.renderButton(el, { theme: 'outline', size: 'large', locale: 'it', text: 'signin_with' }))
  }
  const pending = new Promise(resolve => tokenWaiters.push(resolve))
  signInUi.show()
  gis.prompt()
  return pending
}

export async function signOut () {
  writeJSON(STORE.token, null)
  if (gisPromise) (await gisPromise).disableAutoSelect()
}

export function forgetToken () {
  writeJSON(STORE.token, null)
}

// --- calls -------------------------------------------------------------------

const fail = (error, message, extra = {}) => ({ ok: false, status: 0, error, message, ...extra })

async function token (cfg) {
  const t = storedToken()
  if (t) return t
  return requestToken(cfg.clientId)
}

async function call (request) {
  const cfg = config()
  if (!cfg.endpoint || !cfg.clientId) return fail('not_configured')
  if (!ENDPOINT_RE.test(cfg.endpoint)) return fail('bad_endpoint')
  if (!navigator.onLine) return fail('offline')
  let t
  try {
    t = await token(cfg)
  } catch {
    return fail('signin_unavailable')
  }
  let res
  try {
    res = await request(cfg.endpoint, t.value)
  } catch {
    // Online but blocked: usually a login page served instead of JSON (CORS refusal).
    return fail('unreachable')
  }
  try {
    return await res.json()
  } catch {
    return fail('not_json', '', { httpStatus: res.status })
  }
}

// GET everything: {ok, email, resources: {catalog, family, plans}}.
export async function loadAll () {
  if (DEMO) return demo.loadAll()
  return call((endpoint, idToken) => fetch(`${endpoint}?resource=all&id_token=${encodeURIComponent(idToken)}`))
}

// POST as text/plain: a JSON content type would trigger a CORS preflight
// that Apps Script cannot answer.
export async function savePlan (plan, baseUpdatedAt) {
  if (DEMO) return demo.savePlan(plan, baseUpdatedAt)
  return call((endpoint, idToken) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ id_token: idToken, action: 'savePlan', plan, base_updated_at: baseUpdatedAt })
  }))
}

// --- demo --------------------------------------------------------------------

const demo = {
  plans: null,

  async loadAll () {
    const get = name => fetch(`../fixtures/${name}.json`).then(r => r.json())
    const [catalog, family, plans] = await Promise.all([get('catalog'), get('family-data'), get('plans')])
    if (!this.plans) this.plans = { ...plans, updated_at: plans.updated_at || null }
    return {
      ok: true,
      email: 'demo@example.com',
      resources: {
        catalog: { data: catalog, updated_at: null },
        family: { data: family, updated_at: null },
        plans: { data: this.plans, updated_at: this.plans.updated_at }
      }
    }
  },

  async savePlan (plan, baseUpdatedAt) {
    if ((baseUpdatedAt || null) !== (this.plans.updated_at || null)) {
      return { ok: false, status: 409, error: 'conflict', updated_at: this.plans.updated_at, updated_by: this.plans.updated_by }
    }
    const now = new Date().toISOString()
    const stored = { ...plan, updated_at: now, updated_by: 'demo@example.com' }
    const plans = this.plans.plans.filter(p => p.week_start !== plan.week_start).concat(stored)
      .sort((a, b) => (a.week_start < b.week_start ? -1 : 1))
    this.plans = { schema_version: '1.0', updated_at: now, updated_by: 'demo@example.com', plans }
    return { ok: true, data: this.plans, updated_at: now }
  }
}
