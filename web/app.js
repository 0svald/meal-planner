// Phase A screen: the canteen lunches of the week, read from the Apps Script API
// and cached in localStorage so the page still renders offline.
// Planning logic lives in ../engine/; this file only fetches and renders.

import { mergeData, canteenWeek, mondayOf, addDays, weekdayOf } from '../engine/data.js'

const STORE = { config: 'mf.config', token: 'mf.token', cache: 'mf.cache.v1' }
const DEMO = new URLSearchParams(location.search).has('demo')
const GIS_SRC = 'https://accounts.google.com/gsi/client'

const COURSE_LABELS = {
  first: 'Primo',
  second: 'Secondo',
  side: 'Contorno',
  single: 'Piatto unico',
  bread: 'Pane',
  fruit: 'Frutta',
  dessert: 'Dolce',
  takeaway: 'Asporto'
}
const MINOR_COURSES = new Set(['bread', 'fruit', 'dessert'])
const DAY_NAMES = {
  mon: 'Lunedì', tue: 'Martedì', wed: 'Mercoledì', thu: 'Giovedì', fri: 'Venerdì', sat: 'Sabato', sun: 'Domenica'
}
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']

const state = { data: null, fetchedAt: null, email: null, weekStart: null }
const $ = sel => document.querySelector(sel)

// --- storage (may be unavailable, e.g. private mode) -------------------------

function readJSON (key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJSON (key, value) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Cache is a convenience: the page keeps working without it.
  }
}

function config () {
  return { ...(window.MENU_CONFIG || {}), ...(readJSON(STORE.config) || {}) }
}

// --- dates (UI side: "today" comes from the device clock) --------------------

function today () {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// On Saturday and Sunday the useful canteen week is the next one.
function defaultWeekStart () {
  const t = today()
  const wd = weekdayOf(t)
  return wd === 'sat' || wd === 'sun' ? addDays(mondayOf(t), 7) : mondayOf(t)
}

function shortDate (date) {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}`
}

function dateTime (iso) {
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// --- status messages ---------------------------------------------------------

function showStatus (text, kind = 'info') {
  const el = $('#status')
  el.textContent = text
  el.className = `status ${kind}`
  el.hidden = false
}

function hideStatus () {
  $('#status').hidden = true
}

function showOffline () {
  const when = state.fetchedAt ? ` Dati aggiornati al ${dateTime(state.fetchedAt)}.` : ''
  showStatus(`Sei offline.${when}`, 'info')
}

// --- Google sign-in (ID token for the Apps Script API) -----------------------

let gisPromise = null
let gisClientId = null
let tokenWaiters = []

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
  $('#signin').hidden = true
  tokenWaiters.splice(0).forEach(resolve => resolve(token))
}

// Resolves when the user has signed in (silently via auto-select, or with the button).
async function requestToken (clientId) {
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
    $('#signin-button').replaceChildren()
    gis.renderButton($('#signin-button'), { theme: 'outline', size: 'large', locale: 'it', text: 'signin_with' })
  }
  const pending = new Promise(resolve => tokenWaiters.push(resolve))
  $('#signin').hidden = false
  gis.prompt()
  return pending
}

async function signOut () {
  writeJSON(STORE.token, null)
  writeJSON(STORE.cache, null)
  state.data = null
  state.email = null
  $('#week').hidden = true
  if (gisPromise) (await gisPromise).disableAutoSelect()
}

// --- data --------------------------------------------------------------------

function setData (cache) {
  const r = cache.resources
  state.data = mergeData({ catalog: r.catalog.data, family: r.family.data, plans: r.plans.data })
  state.fetchedAt = cache.fetchedAt
  state.email = cache.email || null
}

async function refresh ({ retried = false } = {}) {
  const cfg = config()
  if (!cfg.endpoint || !cfg.clientId) {
    showStatus('Per iniziare, inserisci l\'indirizzo del servizio e il Client ID nelle impostazioni (⚙︎).', 'info')
    return
  }
  if (!navigator.onLine) {
    if (state.data) showOffline()
    else showStatus('Sei offline e su questo telefono non ci sono ancora dati salvati.', 'error')
    return
  }

  let token = storedToken()
  if (!token) {
    try {
      token = await requestToken(cfg.clientId)
    } catch {
      if (state.data) showOffline()
      else showStatus('Impossibile caricare l\'accesso Google. Controlla la connessione.', 'error')
      return
    }
  }

  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(cfg.endpoint)) {
    showStatus('L\'indirizzo del servizio deve iniziare con https://script.google.com/ e finire con /exec (⚙︎).', 'error')
    return
  }

  let res
  try {
    res = await fetch(`${cfg.endpoint}?resource=all&id_token=${encodeURIComponent(token.value)}`)
  } catch {
    // Online but blocked: usually a login page served instead of JSON (CORS refusal).
    if (state.data) showOffline()
    else {
      showStatus('Il servizio non risponde. Se la connessione funziona, controlla che il deployment ' +
        'dello script sia accessibile a «Chiunque» e che sia stata pubblicata una nuova versione.', 'error')
    }
    return
  }
  let body
  try {
    body = await res.json()
  } catch {
    showStatus(`Il servizio ha risposto con una pagina inattesa (HTTP ${res.status}). ` +
      'Controlla l\'indirizzo /exec e pubblica una nuova versione del deployment.', 'error')
    return
  }

  if (body.ok) {
    const cache = { resources: body.resources, email: body.email, fetchedAt: new Date().toISOString() }
    writeJSON(STORE.cache, cache)
    setData(cache)
    hideStatus()
    render()
    return
  }

  if (body.status === 401 && !retried) {
    writeJSON(STORE.token, null)
    return refresh({ retried: true })
  }
  if (body.status === 403) {
    await signOut()
    showStatus(
      `L'account ${body.email || ''} non è autorizzato a vedere il menu di famiglia. ` +
      'Chiedi di essere aggiunto all\'elenco, oppure accedi con un altro account.',
      'error'
    )
    requestToken(cfg.clientId).then(() => refresh())
    return
  }
  showStatus(`Errore del servizio: ${body.message || body.error || 'sconosciuto'}.`, 'error')
}

async function loadDemo () {
  const get = name => fetch(`../fixtures/${name}.json`).then(r => r.json())
  const [catalog, family, plans] = await Promise.all([get('catalog'), get('family-data'), get('plans')])
  state.data = mergeData({ catalog, family, plans })
  showStatus('Modalità demo: dati di esempio, non quelli di famiglia.', 'info')
  render()
}

// --- rendering ---------------------------------------------------------------

function el (tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else node.setAttribute(k, v)
  }
  node.append(...children.filter(c => c !== null && c !== undefined))
  return node
}

function optionNames (item) {
  return item.options.map(d => d.name).join(' oppure ')
}

function renderDay (day, isToday) {
  const main = day.items.filter(i => !MINOR_COURSES.has(i.course))
  const minor = day.items.filter(i => MINOR_COURSES.has(i.course))
  const body = day.items.length === 0
    ? el('p', { class: 'muted' }, 'Nessun pasto in mensa')
    : el('ul', { class: 'courses' },
      ...main.map(item => el('li', {},
        el('span', { class: 'course' }, COURSE_LABELS[item.course] || item.course),
        el('span', { class: 'dish' }, optionNames(item)),
        item.portion === 0.5 ? el('span', { class: 'badge' }, '½ porzione') : null
      ))
    )
  return el('li', { class: isToday ? 'day today' : 'day' },
    el('h2', {}, `${DAY_NAMES[day.weekday]} ${shortDate(day.date)}`, isToday ? el('span', { class: 'badge today-badge' }, 'oggi') : null),
    body,
    minor.length ? el('p', { class: 'muted small' }, minor.map(optionNames).join(' · ')) : null
  )
}

function render () {
  if (!state.data) return
  const week = canteenWeek(state.data, state.weekStart)
  const t = today()
  $('#week').hidden = false
  $('#week-range').textContent = `${shortDate(state.weekStart)} – ${shortDate(addDays(state.weekStart, 4))}`
  $('#week-cycle').textContent = week ? `Mensa: settimana ${week.cycleWeek} di ${week.weekCount}` : ''
  $('#this-week').hidden = state.weekStart === defaultWeekStart()

  const notice = $('#week-notice')
  notice.hidden = true
  if (!week) {
    notice.textContent = 'Nessun menu della mensa attivo. Importalo con l\'assistente del menu.'
    notice.hidden = false
  } else if (!week.cycleWeekKnown) {
    notice.textContent = 'Manca la data di inizio del menu della mensa: mostro la settimana 1. ' +
      'Impostala con l\'assistente del menu.'
    notice.hidden = false
  }

  $('#days').replaceChildren(...(week ? week.days.map(day => renderDay(day, day.date === t)) : []))
}

function moveWeek (delta) {
  state.weekStart = addDays(state.weekStart, 7 * delta)
  render()
}

// --- settings ----------------------------------------------------------------

function openSettings () {
  const form = $('#settings-form')
  const cfg = config()
  form.endpoint.value = cfg.endpoint || ''
  form.clientId.value = cfg.clientId || ''
  $('#settings-account').textContent = state.email ? `Accesso come ${state.email}` : ''
  $('#settings').showModal()
}

function onSettingsClose () {
  if ($('#settings').returnValue !== 'save') return
  const form = $('#settings-form')
  const before = config()
  const next = { endpoint: form.endpoint.value.trim(), clientId: form.clientId.value.trim() }
  writeJSON(STORE.config, next)
  if (next.clientId !== before.clientId) writeJSON(STORE.token, null)
  if (next.endpoint !== before.endpoint || next.clientId !== before.clientId) refresh()
}

// --- start -------------------------------------------------------------------

function main () {
  state.weekStart = defaultWeekStart()
  $('#prev-week').addEventListener('click', () => moveWeek(-1))
  $('#next-week').addEventListener('click', () => moveWeek(1))
  $('#this-week').addEventListener('click', () => {
    state.weekStart = defaultWeekStart()
    render()
  })
  $('#settings-btn').addEventListener('click', openSettings)
  $('#settings').addEventListener('close', onSettingsClose)
  $('#signout-btn').addEventListener('click', async () => {
    $('#settings').close()
    await signOut()
    refresh()
  })

  if (DEMO) {
    $('#settings-btn').hidden = true
    loadDemo()
    return
  }

  const cached = readJSON(STORE.cache)
  if (cached) {
    try {
      setData(cached)
      render()
    } catch {
      writeJSON(STORE.cache, null)
    }
  }
  window.addEventListener('online', () => refresh())
  refresh()
}

main()
