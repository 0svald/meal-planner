// Talks to the Apps Script API: Google sign-in (ID token), read everything,
// save a plan. In demo mode (?demo) it reads fixtures/ and keeps saves in memory.
// Every call resolves to the API body: {ok: true, ...} or {ok: false, status, error, message}.

import { STORE, readJSON, writeJSON } from './storage.js'

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const ENDPOINT_RE = /^https:\/\/script\.google\.com\/.+\/exec$/

export const DEMO = new URLSearchParams(location.search).has('demo')

// { endpoint, clientId }: the endpoint comes from the invitation link (or
// Settings → Avanzate, or config.js); the client id is asked to the script.
export function config () {
  return { ...(window.MENU_CONFIG || {}), ...(readJSON(STORE.config) || {}) }
}

export function setEndpoint (endpoint) {
  const before = config()
  writeJSON(STORE.config, { endpoint })
  // A token is tied to the client id of a script: moving to another one
  // needs a new sign-in. The first setup keeps any token already there.
  if (before.endpoint && before.endpoint !== endpoint) forgetToken()
}

// An invitation link carries the API address in the fragment:
// .../web/#invito=<base64url of the /exec URL>. Browsers never send the
// fragment to the server, so the address is not published anywhere.
// Returns true when an invitation was read (and removes it from the address bar).
export function readInvite () {
  const m = /[#&]invito=([A-Za-z0-9_-]+)/.exec(location.hash)
  if (!m) return false
  history.replaceState(null, '', location.pathname + location.search)
  let endpoint
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
    endpoint = atob(b64 + '='.repeat((4 - b64.length % 4) % 4))
  } catch {
    return false
  }
  if (!ENDPOINT_RE.test(endpoint)) return false
  setEndpoint(endpoint)
  return true
}

// The OAuth client id is public: the script hands it out (?resource=config).
async function ensureClientId (cfg) {
  if (cfg.clientId) return cfg
  const res = await fetch(`${cfg.endpoint}?resource=config`)
  const body = await res.json()
  if (!body.ok || !body.client_id) throw new Error('no client id')
  const next = { ...cfg, clientId: body.client_id }
  writeJSON(STORE.config, { endpoint: next.endpoint, clientId: next.clientId })
  return next
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
  let cfg = config()
  if (!cfg.endpoint) return fail('not_configured')
  if (!ENDPOINT_RE.test(cfg.endpoint)) return fail('bad_endpoint')
  if (!navigator.onLine) return fail('offline')
  try {
    cfg = await ensureClientId(cfg)
  } catch {
    return fail('unreachable')
  }
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

// GET everything: {ok, email, admin, resources: {catalog, family, plans, pantry, wishlist}}.
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

export async function saveShoppingList (weekStart, text) {
  if (DEMO) return { ok: true, file: `shopping-lists/spesa-${weekStart}.txt` }
  return call((endpoint, idToken) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ id_token: idToken, action: 'saveShoppingList', week_start: weekStart, text })
  }))
}

// Add and remove pantry staples; the server applies the change to its
// current list, so concurrent edits do not overwrite each other.
export async function updatePantry ({ add = [], remove = [] }) {
  if (DEMO) return demo.updatePantry(add, remove)
  return call((endpoint, idToken) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ id_token: idToken, action: 'updatePantry', add, remove })
  }))
}

export async function addWish ({ name, url = '', note = '' }) {
  if (DEMO) return demo.addWish(name, url, note)
  return post({ action: 'addWish', name, url, note })
}

export async function removeWish (id) {
  if (DEMO) return demo.removeWish(id)
  return post({ action: 'removeWish', id })
}

// Corrections to catalog dishes, kept in dish-edits.json (the catalog itself
// belongs to the skill).
export async function saveDishEdit (dishId, fields) {
  if (DEMO) return demo.saveDishEdit(dishId, fields)
  return post({ action: 'saveDishEdit', dish_id: dishId, fields })
}

export async function resetDishEdit (dishId) {
  if (DEMO) return demo.resetDishEdit(dishId)
  return post({ action: 'resetDishEdit', dish_id: dishId })
}

function post (body) {
  return call((endpoint, idToken) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ id_token: idToken, ...body })
  }))
}

// Family members (owner and ADMINS only): list, invite by email, remove.
export async function listMembers () {
  if (DEMO) return demo.members()
  return post({ action: 'listMembers' })
}

export async function inviteMember (email) {
  if (DEMO) return demo.invite(email)
  const appUrl = location.origin + location.pathname
  return post({ action: 'inviteMember', email, app_url: appUrl, endpoint: config().endpoint })
}

export async function removeMember (email) {
  if (DEMO) return demo.remove(email)
  return post({ action: 'removeMember', email })
}

// --- demo --------------------------------------------------------------------

const demo = {
  family_members: ['demo@example.com', 'nonna@example.com'],

  members () {
    return { ok: true, members: this.family_members.map((email, i) => ({ email, owner: i === 0, admin: i === 0 })) }
  },

  invite (email) {
    const e = email.trim().toLowerCase()
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e)) return { ok: false, status: 422, error: 'invalid_member', message: 'email is not valid' }
    if (!this.family_members.includes(e)) this.family_members.push(e)
    return { ...this.members(), invited: e }
  },

  remove (email) {
    this.family_members = this.family_members.filter(m => m !== email)
    return this.members()
  },

  plans: null,
  pantry: null,
  wishlist: null,
  family: null,

  async loadAll () {
    const get = name => fetch(`../fixtures/${name}.json`).then(r => r.json())
    const [catalog, family, plans] = await Promise.all([get('catalog'), get('family-data'), get('plans')])
    if (!this.plans) this.plans = { ...plans, updated_at: plans.updated_at || null }
    this.family = family
    return {
      ok: true,
      email: 'demo@example.com',
      admin: true,
      resources: {
        catalog: { data: catalog, updated_at: null },
        family: { data: family, updated_at: null },
        plans: { data: this.plans, updated_at: this.plans.updated_at },
        pantry: { data: this.pantry, updated_at: this.pantry ? this.pantry.updated_at : null },
        wishlist: { data: this.wishlist, updated_at: this.wishlist ? this.wishlist.updated_at : null },
        edits: { data: this.edits, updated_at: this.edits ? this.edits.updated_at : null }
      }
    }
  },

  saveWishes (wishes) {
    const now = new Date().toISOString()
    this.wishlist = { schema_version: '1.0', updated_at: now, updated_by: 'demo@example.com', wishes }
    return { ok: true, data: this.wishlist, updated_at: now }
  },

  async addWish (name, url, note) {
    const wish = { id: `w-demo-${Date.now().toString(36)}`, name: name.trim(), added_by: 'demo@example.com', added_at: new Date().toISOString() }
    if (url.trim()) wish.url = url.trim()
    if (note.trim()) wish.note = note.trim()
    return { ...this.saveWishes([...(this.wishlist ? this.wishlist.wishes : []), wish]), wish }
  },

  async removeWish (id) {
    return this.saveWishes((this.wishlist ? this.wishlist.wishes : []).filter(w => w.id !== id))
  },

  edits: null,

  saveEdits (edits) {
    const now = new Date().toISOString()
    this.edits = { schema_version: '1.0', updated_at: now, updated_by: 'demo@example.com', edits }
    return { ok: true, data: this.edits, updated_at: now }
  },

  async saveDishEdit (dishId, fields) {
    const edits = { ...(this.edits ? this.edits.edits : {}) }
    edits[dishId] = { fields, edited_by: 'demo@example.com', edited_at: new Date().toISOString() }
    return this.saveEdits(edits)
  },

  async resetDishEdit (dishId) {
    const edits = { ...(this.edits ? this.edits.edits : {}) }
    delete edits[dishId]
    return this.saveEdits(edits)
  },

  async updatePantry (add, remove) {
    const key = n => n.toLowerCase().replace(/\s+/g, ' ').trim()
    const drop = remove.map(key)
    const seen = new Set()
    const items = (this.pantry ? this.pantry.pantry : this.family.pantry).concat(add.map(n => n.trim()))
      .filter(n => n && !drop.includes(key(n)) && !seen.has(key(n)) && seen.add(key(n)))
      .sort((a, b) => a.localeCompare(b, 'it'))
    const now = new Date().toISOString()
    this.pantry = { schema_version: '1.0', updated_at: now, updated_by: 'demo@example.com', pantry: items }
    return { ok: true, data: this.pantry, updated_at: now }
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
