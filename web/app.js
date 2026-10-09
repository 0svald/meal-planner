// The week screen: canteen lunches next to the home meals, three options per
// meal, live feedback on the rules, save as draft or confirm.
// Planning logic lives in ../engine/; this file fetches, renders and saves.

import { mergeData, canteenWeek, mondayOf, addDays, isoWeekId, weekdayOf, WEEKDAYS } from '../engine/data.js'
import { proposeWeek, evaluatePlan, slotOptions } from '../engine/planner.js'
import { buildWeek, HOME_SLOTS } from '../engine/week.js'
import { shoppingList, shoppingText, quantityNote, usesNote } from '../engine/shopping.js'
import { wishlistView } from '../engine/wishlist.js'
import { STORE, readJSON, writeJSON } from './storage.js'
import * as api from './api.js'

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
// Shown in the settings, to tell which version a phone runs. Bump on release.
const APP_VERSION = '2026-10-09'
const MINOR_COURSES = new Set(['bread', 'fruit', 'dessert'])
const DAY_NAMES = {
  mon: 'Lunedì', tue: 'Martedì', wed: 'Mercoledì', thu: 'Giovedì', fri: 'Venerdì', sat: 'Sabato', sun: 'Domenica'
}
const SLOT_NAMES = { lunch: 'Pranzo', dinner: 'Cena' }
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']
const MONTHS_LONG = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']

const state = {
  data: null,
  fetchedAt: null,
  email: null,
  plansUpdatedAt: null,
  weekStart: null,
  // Local edits by week: { [weekStart]: { plan, dirty, seed } }. Unsaved ones
  // are kept in localStorage so closing the app does not lose them.
  drafts: readJSON(STORE.drafts) || {},
  sheet: null,
  sharePrefill: null,
  slide: null,
  tab: ['plan', 'shopping', 'wishes'].includes(readJSON(STORE.tab)) ? readJSON(STORE.tab) : 'today',
  day: null
}
const $ = sel => document.querySelector(sel)

// --- dates (UI side: "today" comes from the device clock) --------------------

function today () {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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

// Italian message for a failed API call.
function messageFor (body) {
  switch (body.error) {
    case 'not_configured':
      return 'Per iniziare, inserisci l\'indirizzo del servizio e il Client ID nelle impostazioni (⚙︎).'
    case 'bad_endpoint':
      return 'L\'indirizzo del servizio deve iniziare con https://script.google.com/ e finire con /exec (⚙︎).'
    case 'offline':
      return 'Sei offline.'
    case 'signin_unavailable':
      return 'Impossibile caricare l\'accesso Google. Controlla la connessione.'
    case 'unreachable':
      return 'Il servizio non risponde. Se la connessione funziona, controlla che il deployment ' +
        'dello script sia accessibile a «Chiunque» e che sia stata pubblicata una nuova versione.'
    case 'not_json':
      return `Il servizio ha risposto con una pagina inattesa (HTTP ${body.httpStatus}). ` +
        'Controlla l\'indirizzo /exec e pubblica una nuova versione del deployment.'
    case 'invalid_plan':
      return `Il servizio ha rifiutato la settimana: ${body.message}`
    default:
      return `Errore del servizio: ${body.message || body.error || 'sconosciuto'}.`
  }
}

// --- data --------------------------------------------------------------------

function setData (cache) {
  const r = cache.resources
  state.data = mergeData({
    catalog: r.catalog.data,
    family: r.family.data,
    plans: r.plans.data,
    pantry: r.pantry ? r.pantry.data : null,
    wishlist: r.wishlist ? r.wishlist.data : null
  })
  state.plansUpdatedAt = (r.plans.data && r.plans.data.updated_at) || null
  state.fetchedAt = cache.fetchedAt
  state.email = cache.email || null
  // Weeks without local edits follow what is saved on Drive.
  for (const [week, draft] of Object.entries(state.drafts)) {
    if (!draft.dirty) delete state.drafts[week]
  }
}

function persistDrafts () {
  const dirty = Object.fromEntries(Object.entries(state.drafts).filter(([, d]) => d.dirty))
  writeJSON(STORE.drafts, Object.keys(dirty).length ? dirty : null)
}

function savedPlan (weekStart) {
  return state.data.plans.find(p => p.week_start === weekStart) || null
}

async function refresh ({ retried = false } = {}) {
  const body = await api.loadAll()
  if (body.ok) {
    const cache = { resources: body.resources, email: body.email, fetchedAt: new Date().toISOString() }
    if (!api.DEMO) writeJSON(STORE.cache, cache)
    setData(cache)
    if (api.DEMO) showStatus('Modalità demo: dati di esempio, non quelli di famiglia. I salvataggi restano in questa pagina.', 'info')
    else hideStatus()
    showWeek()
    return true
  }
  if (body.status === 401 && !retried) {
    api.forgetToken()
    return refresh({ retried: true })
  }
  if (body.status === 403) {
    await api.signOut()
    writeJSON(STORE.cache, null)
    state.data = null
    $('#week').hidden = true
    showStatus(
      `L'account ${body.email || ''} non è autorizzato a vedere il menu di famiglia. ` +
      'Chiedi di essere aggiunto all\'elenco, oppure accedi con un altro account.',
      'error'
    )
    api.requestToken(api.config().clientId).then(() => refresh(), () => {})
    return false
  }
  const offlineLike = ['offline', 'unreachable', 'signin_unavailable'].includes(body.error)
  if (state.data && offlineLike) showOffline()
  else if (body.error === 'offline') showStatus('Sei offline e su questo telefono non ci sono ancora dati salvati.', 'error')
  else showStatus(messageFor(body), 'error')
  return false
}

// --- the plan of the shown week ----------------------------------------------

function draftFor (weekStart) {
  if (!state.drafts[weekStart]) {
    const saved = savedPlan(weekStart)
    if (saved) {
      state.drafts[weekStart] = { plan: structuredClone(saved), dirty: false, seed: 0 }
    } else {
      const out = proposeWeek({ data: state.data, weekStart, seed: 0, withOptions: false })
      state.drafts[weekStart] = { plan: out.plan, dirty: true, seed: 0, proposal: true }
      persistDrafts()
    }
  }
  return state.drafts[weekStart]
}

function setMeal (key, dishIds) {
  const draft = draftFor(state.weekStart)
  const [date, slot] = key.split('/')
  const meals = draft.plan.meals.filter(m => !(m.date === date && m.slot === slot))
  if (dishIds.length) meals.push({ date, slot, dish_ids: dishIds })
  meals.sort((a, b) => (a.date + a.slot < b.date + b.slot ? -1 : 1))
  draft.plan = { ...draft.plan, meals }
  draft.dirty = true
  persistDrafts()
}

function newProposal () {
  const draft = draftFor(state.weekStart)
  if (draft.plan.meals.length && !confirm('Sostituire tutti i pasti della settimana con una nuova proposta?')) return
  const seed = (draft.seed || 0) + 1
  withBusy('Preparo una nuova proposta…', () => {
    const out = proposeWeek({ data: state.data, weekStart: state.weekStart, seed, withOptions: false })
    const saved = savedPlan(state.weekStart)
    state.drafts[state.weekStart] = {
      plan: { ...out.plan, status: saved ? saved.status : 'draft' },
      dirty: true,
      seed,
      proposal: true
    }
    persistDrafts()
  })
}

function discardChanges () {
  if (!confirm('Annullare le modifiche non salvate di questa settimana?')) return
  delete state.drafts[state.weekStart]
  persistDrafts()
  render()
}

async function save (status, { retried = false } = {}) {
  const draft = draftFor(state.weekStart)
  const canteen = canteenWeek(state.data, state.weekStart)
  const plan = {
    id: isoWeekId(state.weekStart),
    week_start: state.weekStart,
    status,
    cycle_week: canteen ? canteen.cycleWeek : null,
    meals: draft.plan.meals
  }
  setSaving(true)
  const body = await api.savePlan(plan, state.plansUpdatedAt)
  setSaving(false)

  if (body.ok) {
    delete state.drafts[state.weekStart]
    persistDrafts()
    const cache = api.DEMO ? null : readJSON(STORE.cache)
    if (cache) {
      cache.resources.plans = { data: body.data, updated_at: body.updated_at }
      writeJSON(STORE.cache, cache)
      setData(cache)
      render()
    } else {
      await refresh()
    }
    showStatus(status === 'confirmed' ? 'Settimana confermata e salvata.' : 'Bozza salvata.', 'info')
    return
  }

  if (body.status === 409 && !retried) {
    const who = body.updated_by || 'qualcun altro'
    const when = body.updated_at ? ` (${dateTime(body.updated_at)})` : ''
    await refresh()
    if (confirm(`${who} ha salvato il menu nel frattempo${when}. Vuoi sovrascrivere con la tua versione?`)) {
      return save(status, { retried: true })
    }
    delete state.drafts[state.weekStart]
    persistDrafts()
    render()
    showStatus('Ho tenuto la versione salvata da ' + who + '.', 'info')
    return
  }
  if (['offline', 'unreachable', 'signin_unavailable'].includes(body.error)) {
    showStatus('Non riesco a salvare adesso: le modifiche restano su questo telefono. Riprova quando sei online.', 'error')
    return
  }
  showStatus(messageFor(body), 'error')
}

function setSaving (on) {
  for (const b of document.querySelectorAll('.plan-actions button')) b.disabled = on
  if (on) showStatus('Salvataggio…', 'info')
}

// Heavy work (a full proposal takes about a second) after the message paints.
function withBusy (message, work) {
  showStatus(message, 'info')
  setTimeout(() => {
    work()
    hideStatus()
    render()
  }, 30)
}

// --- rendering helpers -------------------------------------------------------

function el (tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : v)
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false))
  return node
}

const names = dishes => dishes.map(d => d.name).join(' + ')

function canteenSummary (day) {
  const main = day.items.filter(i => !MINOR_COURSES.has(i.course))
  return main.map(i => i.options.map(d => d.name).join(' o ') + (i.portion === 0.5 ? ' (½)' : '')).join(' · ')
}

// --- week --------------------------------------------------------------------

function planStatusLine (draft, saved) {
  if (draft.dirty && draft.proposal && !saved) return 'Proposta, non ancora salvata'
  if (draft.dirty) return 'Modifiche non salvate'
  if (!saved) return ''
  const who = saved.updated_by ? ` da ${saved.updated_by}` : ''
  const when = saved.updated_at ? ` il ${dateTime(saved.updated_at)}` : ''
  return (saved.status === 'confirmed' ? 'Settimana confermata' : 'Bozza salvata') + who + when
}

function chip (r) {
  const kind = r.satisfied ? (r.penalty > 0 ? 'near' : 'ok') : r.unavoidable ? 'canteen' : r.severity === 'pending' ? 'pending' : r.severity === 'hard' ? 'bad' : 'warn'
  return el('li', { class: `chip ${kind}`, title: r.unavoidable ? 'Già dal menu della mensa' : '' },
    r.detail, r.unavoidable ? ' · mensa' : '')
}

function renderFeedback (results) {
  const frequencies = results.filter(r => r.type === 'frequency')
  const others = results.filter(r => r.type !== 'frequency' && !r.satisfied && !r.slot)
  const broken = results.filter(r => r.type !== 'frequency' && !r.satisfied && r.slot)
  const toImprove = frequencies.filter(r => !r.unavoidable && (!r.satisfied || r.penalty > 0)).length + others.length
  const hard = results.some(r => r.severity === 'hard' && !r.unavoidable)
  const summary = broken.length
    ? `${broken.length} ${broken.length === 1 ? 'pasto da rivedere' : 'pasti da rivedere'}`
    : toImprove ? `${toImprove} da migliorare` : 'tutto a posto'
  const details = el('details', { class: 'feedback-details', open: hard },
    el('summary', {}, el('span', {}, 'Equilibrio della settimana'), el('span', { class: `summary-note${hard ? ' bad' : ''}` }, summary)),
    el('ul', { class: 'chips' }, frequencies.map(chip)),
    others.length ? el('ul', { class: 'problems' }, others.map(r => el('li', { class: r.severity }, r.detail))) : null,
    broken.length ? el('p', { class: 'small muted' }, 'I pasti da rivedere sono segnati nei giorni.') : null)
  $('#feedback').replaceChildren(details)
}

function homeRow (date, slot, meals, results) {
  const key = `${date}/${slot}`
  const meal = meals.find(m => m.date === date && m.slot === slot)
  const dishes = meal ? meal.dishes : []
  const problems = results.filter(r => r.slot === key && !r.satisfied && !r.unavoidable)
  const hard = problems.some(r => r.severity === 'hard')
  return el('div', { class: 'meal-row' },
    el('span', { class: 'meal-label' }, SLOT_NAMES[slot]),
    el('div', { class: 'meal-body' },
      el('button', {
        type: 'button',
        class: `slot-btn${dishes.length ? '' : ' empty'}${hard ? ' bad' : problems.length ? ' warn' : ''}`,
        'data-key': key,
        onclick: () => openSheet(key)
      },
      el('span', { class: 'slot-text' }, dishes.length ? names(dishes) : 'Da scegliere'),
      el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')),
      problems.length ? el('ul', { class: 'problems' }, problems.map(r => el('li', { class: r.severity }, r.detail))) : null
    )
  )
}

const TABS = ['today', 'plan', 'shopping', 'wishes']

// Offline the app is read-only: everything stays visible (and the week can
// still be edited on the phone), but nothing that writes to Drive can start.
function applyOnlineState () {
  const offline = !navigator.onLine
  document.body.classList.toggle('offline', offline)
  for (const b of document.querySelectorAll('[data-write]')) b.disabled = offline
  $('#offline-banner').hidden = !offline
}

function render () {
  renderView()
  applyOnlineState()
}

function renderView () {
  if (!state.data) return
  document.body.classList.toggle('tab-today', state.tab === 'today')
  $('#week').hidden = false
  $('#bottom-nav').hidden = false
  for (const tab of TABS) {
    if (state.tab === tab) $(`#nav-${tab}`).setAttribute('aria-current', 'page')
    else $(`#nav-${tab}`).removeAttribute('aria-current')
    $(`#${tab}-view`).hidden = state.tab !== tab
  }
  // Today and the recipe wishlist have their own header, without the week.
  const ownHeader = state.tab === 'today' || state.tab === 'wishes'
  $('.week-nav').hidden = ownHeader
  if (ownHeader) {
    $('#this-week').hidden = true
    $('#week-notice').hidden = true
    return state.tab === 'today' ? renderToday() : renderWishes()
  }
  const weekStart = state.weekStart
  const draft = draftFor(weekStart)
  const saved = savedPlan(weekStart)
  const canteen = canteenWeek(state.data, weekStart)
  const t = today()

  $('#week').hidden = false
  $('#week-range').textContent = `${shortDate(weekStart)} – ${shortDate(addDays(weekStart, 6))}`
  $('#week-cycle').textContent = canteen ? `Mensa: settimana ${canteen.cycleWeek} di ${canteen.weekCount}` : ''
  $('#this-week').hidden = weekStart === mondayOf(t)

  const notice = $('#week-notice')
  notice.hidden = true
  if (!canteen) {
    notice.textContent = 'Nessun menu della mensa attivo. Importalo con l\'assistente del menu.'
    notice.hidden = false
  } else if (!canteen.cycleWeekKnown) {
    notice.textContent = 'Manca la data di inizio del menu della mensa: mostro la settimana 1. ' +
      'Impostala con l\'assistente del menu.'
    notice.hidden = false
  }

  if (state.tab === 'shopping') return renderShopping(draft, saved)

  const week = buildWeek(state.data, weekStart, { plan: draft.plan })
  const { results } = evaluatePlan({ data: state.data, weekStart, plan: draft.plan })
  $('#plan-status').textContent = planStatusLine(draft, saved)
  $('#discard-btn').hidden = !(draft.dirty && saved)
  renderFeedback(results)

  const days = WEEKDAYS.map((weekday, i) => {
    const date = addDays(weekStart, i)
    const canteenDay = canteen && canteen.days.find(d => d.date === date)
    const homeSlots = HOME_SLOTS.filter(s => s.weekday === weekday).map(s => s.slot)
    const lunch = homeSlots.includes('lunch')
      ? homeRow(date, 'lunch', week.meals, results)
      : el('div', { class: 'meal-row canteen' },
        el('span', { class: 'meal-label' }, 'Pranzo', el('small', {}, 'mensa')),
        el('p', { class: 'meal-body canteen-text' }, canteenDay && canteenDay.items.length ? canteenSummary(canteenDay) : 'Nessun pasto in mensa'))
    return el('li', { class: date === t ? 'day today' : 'day' },
      el('h2', {}, `${DAY_NAMES[weekday]} ${shortDate(date)}`, date === t ? el('span', { class: 'badge' }, 'oggi') : null),
      lunch,
      homeRow(date, 'dinner', week.meals, results)
    )
  })
  $('#days').replaceChildren(...days)
}

// Render the shown week; a week with nothing saved first gets a proposal,
// which takes about a second, so say so before computing it.
function showWeek () {
  if (!state.drafts[state.weekStart] && !savedPlan(state.weekStart)) {
    withBusy('Preparo la proposta della settimana…', () => draftFor(state.weekStart))
  } else {
    render()
  }
}

function moveWeek (delta) {
  state.weekStart = addDays(state.weekStart, 7 * delta)
  showWeek()
}

// --- today -------------------------------------------------------------------

function longDate (date) {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS_LONG[m - 1]}`
}

function dayTitle (date) {
  const t = today()
  if (date === t) return 'Oggi'
  if (date === addDays(t, 1)) return 'Domani'
  if (date === addDays(t, -1)) return 'Ieri'
  return DAY_NAMES[weekdayOf(date)]
}

function moveDay (delta) {
  state.day = addDays(state.day, delta)
  state.weekStart = mondayOf(state.day)
  state.slide = delta > 0 ? 'from-right' : delta < 0 ? 'from-left' : null
  showWeek()
}

// Swipe left / right on the "Oggi" view to move to the next / previous day.
// Only clearly horizontal, quick gestures count, so vertical scrolling and
// taps on the meal cards keep working as before.
const SWIPE_MIN_PX = 60
const SWIPE_MAX_MS = 1000

// The whole page area counts (also the empty space under the cards), except
// the bottom bar, form fields and open dialogs.
function setupSwipe (target) {
  let start = null
  target.addEventListener('touchstart', event => {
    const ignore = event.target.closest && event.target.closest('.bottom-nav, dialog, input, textarea, select')
    if (state.tab !== 'today' || event.touches.length !== 1 || ignore || document.querySelector('dialog[open]')) {
      start = null
      return
    }
    const t = event.touches[0]
    start = { x: t.clientX, y: t.clientY, time: Date.now() }
  }, { passive: true })
  target.addEventListener('touchend', event => {
    if (!start || state.tab !== 'today') return
    const t = event.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    const quick = Date.now() - start.time <= SWIPE_MAX_MS
    start = null
    if (!quick || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 1.5 * Math.abs(dy)) return
    moveDay(dx < 0 ? 1 : -1)
  }, { passive: true })
  target.addEventListener('touchcancel', () => { start = null }, { passive: true })
}

// One meal as a card: the dishes one per line with their course. Home meals
// open the edit sheet; canteen lunches are read-only.
function mealCard (label, meal, { key = null, problems = [], canteen = null } = {}) {
  const main = meal ? meal.dishes.filter(d => !MINOR_COURSES.has(d.course)) : []
  const minor = meal ? meal.dishes.filter(d => MINOR_COURSES.has(d.course)) : []
  const hard = problems.some(r => r.severity === 'hard')
  const body = [
    el('div', { class: 'meal-card-head' },
      el('span', { class: 'meal-card-label' }, label),
      canteen ? el('span', { class: 'badge' }, 'mensa') : null,
      key ? el('span', { class: 'chev', 'aria-hidden': 'true' }, '›') : null),
    main.length
      ? el('ul', { class: 'meal-dishes' }, main.map(d => el('li', {},
        el('span', { class: 'meal-dish' }, d.name),
        el('span', { class: 'meal-course' }, COURSE_LABELS[d.course] || ''))))
      : el('p', { class: 'meal-empty' }, key ? 'Da scegliere: tocca per le proposte' : 'Nessun pasto in mensa'),
    canteen && canteen.alternatives.length
      ? el('p', { class: 'small muted' }, `In alternativa: ${canteen.alternatives.join(', ')}`)
      : null,
    minor.length ? el('p', { class: 'small muted' }, minor.map(d => d.name).join(' · ')) : null,
    problems.length ? el('ul', { class: 'problems' }, problems.map(r => el('li', { class: r.severity }, r.detail))) : null
  ]
  const cls = `meal-card${hard ? ' bad' : problems.length ? ' warn' : ''}${key ? ' editable' : ''}`
  return key
    ? el('button', { type: 'button', class: cls, 'data-key': key, onclick: () => openSheet(key) }, ...body)
    : el('section', { class: cls }, ...body)
}

function renderToday () {
  if (!state.day) state.day = today()
  const date = state.day
  const weekStart = mondayOf(date)
  if (state.weekStart !== weekStart) state.weekStart = weekStart
  const draft = draftFor(weekStart)
  const saved = savedPlan(weekStart)
  const week = buildWeek(state.data, weekStart, { plan: draft.plan })
  const { results } = evaluatePlan({ data: state.data, weekStart, plan: draft.plan })
  const weekday = weekdayOf(date)
  const homeSlots = HOME_SLOTS.filter(s => s.weekday === weekday).map(s => s.slot)
  const problemsOf = key => results.filter(r => r.slot === key && !r.satisfied && !r.unavoidable)

  const cards = ['lunch', 'dinner'].map(slot => {
    const key = `${date}/${slot}`
    const meal = week.meals.find(m => m.date === date && m.slot === slot)
    if (homeSlots.includes(slot)) return mealCard(SLOT_NAMES[slot], meal, { key, problems: problemsOf(key) })
    // Canteen lunch: show what the children eat, with the printed alternatives.
    const canteenDay = canteenWeek(state.data, weekStart)?.days.find(d => d.date === date)
    const alternatives = canteenDay
      ? canteenDay.items.filter(i => !MINOR_COURSES.has(i.course) && i.options.length > 1)
        .flatMap(i => i.options.slice(1).map(d => d.name))
      : []
    return mealCard(SLOT_NAMES[slot], meal, { canteen: { alternatives } })
  })

  const status = planStatusLine(draft, saved)
  const view = $('#today-view')
  view.classList.remove('from-right', 'from-left')
  if (state.slide) {
    void view.offsetWidth // restart the animation
    view.classList.add(state.slide)
    state.slide = null
  }
  view.replaceChildren(...[
    el('nav', { class: 'day-nav', 'aria-label': 'Giorno' },
      el('button', { type: 'button', 'aria-label': 'Giorno precedente', onclick: () => moveDay(-1) }, '‹'),
      el('div', { class: 'day-title' },
        el('div', { class: 'day-name' }, dayTitle(date)),
        el('div', { class: 'muted' }, `${DAY_NAMES[weekday].toLowerCase()} ${longDate(date)}`)),
      el('button', { type: 'button', 'aria-label': 'Giorno successivo', onclick: () => moveDay(1) }, '›')),
    date !== today()
      ? el('button', { type: 'button', class: 'link-btn', onclick: () => { state.day = today(); moveDay(0) } }, 'Torna a oggi')
      : null,
    el('div', { class: 'meal-cards' }, cards),
    el('div', { class: 'today-foot' },
      status ? el('p', { class: 'small muted' }, status) : null,
      el('button', { type: 'button', class: 'link-btn', onclick: () => showTab('plan') }, 'Vedi tutta la settimana'))
  ].filter(Boolean))
}

// --- shopping list -----------------------------------------------------------

function checksFor (weekStart) {
  return (readJSON(STORE.checks) || {})[weekStart] || []
}

function setChecks (weekStart, keys) {
  const all = readJSON(STORE.checks) || {}
  // Keep the ticks of the last few weeks only.
  for (const week of Object.keys(all)) if (week < addDays(weekStart, -28)) delete all[week]
  if (keys.length) all[weekStart] = keys
  else delete all[weekStart]
  writeJSON(STORE.checks, all)
}

function currentList () {
  return shoppingList({ data: state.data, plan: draftFor(state.weekStart).plan })
}

function shareText () {
  return shoppingText(currentList(), { exclude: checksFor(state.weekStart) })
}

async function shareList () {
  const text = shareText()
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Lista della spesa', text })
      return
    } catch (err) {
      if (err && err.name === 'AbortError') return
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    showStatus('Lista copiata: incollala dove vuoi.', 'info')
  } catch {
    showStatus('Non riesco a condividere la lista da questo browser.', 'error')
  }
}

async function saveListToDrive () {
  showStatus('Salvataggio della lista…', 'info')
  const body = await api.saveShoppingList(state.weekStart, shareText())
  if (body.ok) showStatus(`Lista salvata su Drive (${body.file}).`, 'info')
  else if (['offline', 'unreachable', 'signin_unavailable'].includes(body.error)) showStatus('Non riesco a salvare adesso: riprova quando sei online.', 'error')
  else showStatus(messageFor(body), 'error')
}

function renderShopping (draft, saved) {
  const weekStart = state.weekStart
  const list = currentList()
  const checked = new Set(checksFor(weekStart))
  const toBuy = list.items.filter(i => !checked.has(i.key)).length

  let note = null
  if (draft.dirty || !saved) note = 'La lista segue la settimana mostrata, che ha modifiche non salvate.'
  else if (saved.status !== 'confirmed') note = 'La settimana è ancora una bozza: la lista può cambiare.'

  const toggle = key => {
    const next = new Set(checksFor(weekStart))
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setChecks(weekStart, [...next])
    render()
  }

  const item = i => {
    const q = quantityNote(i)
    return el('li', { class: checked.has(i.key) ? 'item done' : 'item' },
      el('label', {},
        el('input', { type: 'checkbox', checked: checked.has(i.key), onchange: () => toggle(i.key) }),
        el('span', { class: 'item-text' },
          el('span', { class: 'item-name' }, i.name),
          q ? el('span', { class: 'item-qty' }, q) : null,
          el('span', { class: 'item-uses' }, usesNote(i)))))
  }

  const skipped = []
  if (list.skipped.pantry.length) skipped.push(`dispensa (${list.skipped.pantry.join(', ')})`)
  if (list.skipped.takeaway.length) skipped.push(`asporto (${list.skipped.takeaway.join(', ')})`)

  $('#shopping-view').replaceChildren(...[
    note ? el('p', { class: 'notice' }, note) : null,
    list.items.length
      ? el('div', { class: 'shopping-actions' },
        el('button', { type: 'button', class: 'primary', onclick: shareList }, `Condividi (${toBuy} da comprare)`),
        el('button', { type: 'button', class: 'secondary', 'data-write': true, onclick: saveListToDrive }, 'Salva su Drive'))
      : el('p', { class: 'notice' }, 'Nessun ingrediente: scegli prima i pasti della settimana.'),
    ...list.aisles.map(a => el('section', { class: 'aisle' },
      el('h2', {}, a.label),
      el('ul', { class: 'items' }, a.items.map(item)))),
    skipped.length ? el('p', { class: 'small muted' }, `Non in lista: ${skipped.join('; ')}.`) : null,
    checked.size
      ? el('button', { type: 'button', class: 'link-btn', onclick: () => { setChecks(weekStart, []); render() } }, 'Togli tutte le spunte')
      : null,
    el('p', { class: 'small muted' }, 'Le quantità compaiono solo quando la ricetta le indica.'),
    renderPantry(list)
  ].filter(Boolean))
}

// --- pantry ------------------------------------------------------------------

let pantryBusy = false

async function changePantry (change, done) {
  if (pantryBusy) return
  pantryBusy = true
  showStatus('Aggiorno la dispensa…', 'info')
  const body = await api.updatePantry(change)
  pantryBusy = false
  if (body.ok) {
    const cache = api.DEMO ? null : readJSON(STORE.cache)
    if (cache) {
      cache.resources.pantry = { data: body.data, updated_at: body.updated_at }
      writeJSON(STORE.cache, cache)
      setData(cache)
      hideStatus()
      render()
    } else {
      await refresh()
    }
    if (done) done()
    return
  }
  if (['offline', 'unreachable', 'signin_unavailable'].includes(body.error)) {
    showStatus('Non riesco a cambiare la dispensa adesso: riprova quando sei online.', 'error')
  } else {
    showStatus(messageFor(body), 'error')
  }
}

function renderPantry (list) {
  const staples = state.data.pantry.slice().sort((a, b) => a.localeCompare(b, 'it'))
  const have = new Set(staples.map(n => n.toLowerCase().trim()))
  const suggestions = list.items.map(i => i.name).filter(n => !have.has(n.toLowerCase().trim()))
  const input = el('input', {
    name: 'item',
    type: 'text',
    list: 'pantry-suggest',
    placeholder: 'Aggiungi, es. riso',
    autocomplete: 'off',
    maxlength: '60',
    'aria-label': 'Voce da aggiungere alla dispensa'
  })
  const add = event => {
    event.preventDefault()
    const name = input.value.trim()
    if (!name) return
    if (have.has(name.toLowerCase())) {
      input.value = ''
      return
    }
    changePantry({ add: [name] }, () => { input.value = '' })
  }
  return el('section', { class: 'aisle pantry', id: 'pantry' },
    el('h2', {}, 'Dispensa'),
    el('p', { class: 'small muted' }, 'Cose sempre in casa: non finiscono nella lista della spesa.'),
    staples.length
      ? el('ul', { class: 'pantry-items' }, staples.map(name => el('li', {},
        el('span', {}, name),
        el('button', {
          type: 'button',
          class: 'remove',
          'data-write': true,
          'aria-label': `Togli ${name} dalla dispensa`,
          onclick: () => changePantry({ remove: [name] })
        }, '×'))))
      : el('p', { class: 'small muted' }, 'La dispensa è vuota.'),
    el('form', { class: 'pantry-add', onsubmit: add },
      input,
      el('button', { type: 'submit', class: 'secondary', 'data-write': true }, 'Aggiungi')),
    el('datalist', { id: 'pantry-suggest' }, suggestions.map(n => el('option', { value: n })))
  )
}

// --- recipe wishlist ---------------------------------------------------------

let wishBusy = false

async function changeWishes (call, done) {
  if (wishBusy) return
  wishBusy = true
  showStatus('Salvataggio…', 'info')
  const body = await call()
  wishBusy = false
  if (body.ok) {
    const cache = api.DEMO ? null : readJSON(STORE.cache)
    if (cache) {
      cache.resources.wishlist = { data: body.data, updated_at: body.updated_at }
      writeJSON(STORE.cache, cache)
      setData(cache)
      hideStatus()
      render()
    } else {
      await refresh()
    }
    if (done) done()
    return
  }
  if (['offline', 'unreachable', 'signin_unavailable'].includes(body.error)) {
    showStatus('Non riesco a salvare adesso: riprova quando sei online.', 'error')
  } else if (body.error === 'invalid_wish') {
    showStatus(`Controlla i campi: ${body.message}`, 'error')
  } else {
    showStatus(messageFor(body), 'error')
  }
}

function renderWishes () {
  const wishes = wishlistView(state.data)
  const form = el('form', { class: 'wish-form' },
    el('label', {}, 'Ricetta',
      el('input', { name: 'name', type: 'text', required: true, maxlength: '80', placeholder: 'es. Polpette di lenticchie', autocomplete: 'off' })),
    el('label', {}, 'Link (facoltativo)',
      el('input', { name: 'url', type: 'url', maxlength: '500', placeholder: 'https://…', autocomplete: 'off' })),
    el('label', {}, 'Nota (facoltativa)',
      el('input', { name: 'note', type: 'text', maxlength: '300', placeholder: 'es. senza forno, piaciuta dai nonni', autocomplete: 'off' })),
    el('button', { type: 'submit', class: 'primary', 'data-write': true }, 'Aggiungi alla lista'))
  form.addEventListener('submit', event => {
    event.preventDefault()
    const wish = { name: form.name.value.trim(), url: form.url.value.trim(), note: form.note.value.trim() }
    if (!wish.name) return
    changeWishes(() => api.addWish(wish), () => {
      showStatus('Aggiunta. La caricherà l\'assistente del menu quando glielo chiedi.', 'info')
    })
  })

  const card = w => el('li', { class: `wish ${w.status}` },
    el('div', { class: 'wish-head' },
      w.url
        ? el('a', { href: w.url, target: '_blank', rel: 'noopener noreferrer', class: 'wish-name' }, w.name)
        : el('span', { class: 'wish-name' }, w.name),
      el('span', { class: 'badge' }, w.status === 'added' ? 'nel catalogo' : 'in attesa')),
    w.note ? el('p', { class: 'wish-note' }, w.note) : null,
    w.status === 'added'
      ? el('p', { class: 'small muted' }, `Aggiunta come: ${w.dishes.map(d => d.name).join(', ')}`)
      : null,
    el('div', { class: 'wish-foot' },
      el('span', { class: 'small muted' },
        [w.added_by ? `da ${w.added_by.split('@')[0]}` : '', w.added_at ? dateTime(w.added_at) : ''].filter(Boolean).join(' · ')),
      el('button', {
        type: 'button',
        class: 'link-btn',
        'data-write': true,
        onclick: () => {
          if (confirm(`Togliere «${w.name}» dalla lista?`)) changeWishes(() => api.removeWish(w.id))
        }
      }, 'Togli')))

  const pending = wishes.filter(w => w.status === 'pending').length
  // A link shared from another app (Android share sheet) fills the form once.
  if (state.sharePrefill) {
    form.name.value = state.sharePrefill.name
    form.url.value = state.sharePrefill.url
    form.note.value = state.sharePrefill.note
    state.sharePrefill = null
    setTimeout(() => form.name.focus(), 0)
  }

  $('#wishes-view').replaceChildren(...[
    el('section', { class: 'aisle' },
      el('h2', {}, 'Ricette da provare'),
      el('p', { class: 'small muted' },
        'Segna qui le ricette da aggiungere al menu. Poi in chat chiedi all\'assistente del menu ' +
        '«carica le ricette della lista»: le classifica, ti chiede conferma e le aggiunge al catalogo.'),
      form),
    wishes.length
      ? el('p', { class: 'small muted' }, `${pending} in attesa, ${wishes.length - pending} già nel catalogo.`)
      : el('p', { class: 'small muted' }, 'La lista è vuota.'),
    wishes.length ? el('ul', { class: 'wishes' }, wishes.map(card)) : null
  ].filter(Boolean))
}

function showTab (tab) {
  state.tab = tab
  writeJSON(STORE.tab, tab === 'today' ? null : tab)
  if (tab === 'today') {
    state.day = today()
    state.weekStart = mondayOf(state.day)
  }
  window.scrollTo(0, 0)
  showWeek()
}

// --- meal sheet --------------------------------------------------------------

function contextLine (label, meal) {
  if (!meal || !meal.dishes.length) return null
  const main = meal.dishes.filter(d => !MINOR_COURSES.has(d.course))
  return el('p', { class: 'small muted' }, `${label}: ${names(main)}`)
}

function openSheet (key, limit = 3) {
  const [date, slot] = key.split('/')
  const draft = draftFor(state.weekStart)
  const out = slotOptions({ data: state.data, weekStart: state.weekStart, plan: draft.plan, key, limit, seed: draft.seed || 0 })
  const week = buildWeek(state.data, state.weekStart, { plan: draft.plan })
  const weekday = WEEKDAYS[WEEKDAYS.indexOf(week.meals.find(m => m.date === date).weekday)]
  const sameDayLunch = slot === 'dinner' ? week.meals.find(m => m.date === date && m.slot === 'lunch') : null
  const nextDate = addDays(date, 1)
  const nextLunch = slot === 'dinner'
    ? (week.meals.find(m => m.date === nextDate && m.slot === 'lunch') || (weekday === 'sun' ? week.nextMondayLunch : null))
    : null
  const current = out.current.map(d => d.id).join('+')
  state.sheet = { key, limit }

  const option = o => el('li', {},
    el('button', {
      type: 'button',
      class: `option${o.dishIds.join('+') === current ? ' current' : ''}`,
      onclick: () => {
        setMeal(key, o.dishIds)
        $('#sheet').close()
        render()
      }
    },
    el('span', { class: 'option-name' }, names(o.dishes),
      o.takeaway ? el('span', { class: 'badge' }, 'asporto') : null,
      o.dishIds.join('+') === current ? el('span', { class: 'badge' }, 'attuale') : null),
    o.reasons.length
      ? el('span', { class: 'reasons' }, o.reasons.slice(0, 3).map(r =>
        el('span', { class: r.effect === '+' ? 'plus' : 'minus' }, `${r.effect === '+' ? '+' : '−'} ${r.detail}`)))
      : el('span', { class: 'reasons' }, el('span', { class: 'neutral' }, 'Rispetta tutte le regole'))
    ))

  $('#sheet-body').replaceChildren(...[
    el('h2', {}, `${SLOT_NAMES[slot]} di ${DAY_NAMES[weekday].toLowerCase()} ${shortDate(date)}`),
    contextLine('A pranzo', sameDayLunch),
    contextLine('Pranzo del giorno dopo', nextLunch),
    out.options.length
      ? el('ul', { class: 'options' }, out.options.map(option))
      : el('p', { class: 'notice' }, 'Nessuna alternativa rispetta le regole rigide con il resto della settimana.'),
    el('p', { class: 'small muted' }, `${out.candidateCount} combinazioni possibili rispettano le regole rigide.`),
    el('div', { class: 'actions' },
      out.current.length
        ? el('button', { type: 'button', class: 'secondary', onclick: () => { setMeal(key, []); $('#sheet').close(); render() } }, 'Svuota')
        : null,
      limit < 10 && out.candidateCount > out.options.length
        ? el('button', { type: 'button', class: 'secondary', onclick: () => openSheet(key, 10) }, 'Altre proposte')
        : null,
      el('button', { type: 'button', class: 'primary', onclick: () => $('#sheet').close() }, 'Chiudi')
    )
  ].filter(Boolean))
  if (!$('#sheet').open) $('#sheet').showModal()
}

// --- settings ----------------------------------------------------------------

function openSettings () {
  const form = $('#settings-form')
  const cfg = api.config()
  form.endpoint.value = cfg.endpoint || ''
  form.clientId.value = cfg.clientId || ''
  $('#settings-account').textContent = state.email ? `Accesso come ${state.email}` : ''
  $('#app-version').textContent = `Versione dell'app: ${APP_VERSION}`
  $('#settings').showModal()
}

// Drop the offline copy of the app and load the latest published version.
// Data and unsaved edits in localStorage are kept.
async function updateApp () {
  showStatus('Scarico l\'ultima versione…', 'info')
  try {
    if ('caches' in window) for (const key of await caches.keys()) await caches.delete(key)
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null
    if (reg) await reg.update()
  } catch {
    // Reloading is enough when the cache cannot be cleared.
  }
  location.reload()
}

function onSettingsClose () {
  if ($('#settings').returnValue !== 'save') return
  const form = $('#settings-form')
  const before = api.config()
  const next = { endpoint: form.endpoint.value.trim(), clientId: form.clientId.value.trim() }
  writeJSON(STORE.config, next)
  if (next.clientId !== before.clientId) api.forgetToken()
  if (next.endpoint !== before.endpoint || next.clientId !== before.clientId) refresh()
}

// --- start -------------------------------------------------------------------

// --- installable app (PWA) ---------------------------------------------------

let installPrompt = null

function registerServiceWorker () {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('sw.js').catch(() => {})
}

function setupInstall () {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
  const help = $('#install-help')
  if (standalone) help.textContent = 'L\'app è installata su questo telefono.'
  else if (ios) help.textContent = 'Per installarla su iPhone: in Safari tocca Condividi, poi «Aggiungi alla schermata Home».'
  else help.textContent = 'Per installarla: dal menu del browser scegli «Installa app» o «Aggiungi a schermata Home».'
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    installPrompt = event
    $('#install-btn').hidden = false
  })
  $('#install-btn').addEventListener('click', async () => {
    if (!installPrompt) return
    installPrompt.prompt()
    await installPrompt.userChoice.catch(() => null)
    installPrompt = null
    $('#install-btn').hidden = true
  })
  window.addEventListener('appinstalled', () => {
    $('#install-btn').hidden = true
    help.textContent = 'L\'app è installata su questo telefono.'
  })
}

// Android share sheet -> ?share_title=&share_text=&share_url= (manifest
// share_target): open the recipe wishlist with the form filled in.
function readShareTarget () {
  const params = new URLSearchParams(location.search)
  if (!['share_title', 'share_text', 'share_url'].some(k => params.has(k))) return
  const title = (params.get('share_title') || '').trim()
  let text = (params.get('share_text') || '').trim()
  let url = (params.get('share_url') || '').trim()
  const inText = text.match(/https?:\/\/\S+/)
  if (!url && inText) url = inText[0]
  if (inText) text = text.replace(inText[0], '').trim()
  const name = (title || text).slice(0, 80)
  state.sharePrefill = { name, url: url.slice(0, 500), note: title ? text.slice(0, 300) : '' }
  state.tab = 'wishes'
  params.delete('share_title')
  params.delete('share_text')
  params.delete('share_url')
  const rest = params.toString()
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''))
}

function main () {
  state.day = today()
  state.weekStart = mondayOf(state.day)
  registerServiceWorker()
  setupInstall()
  readShareTarget()
  window.addEventListener('offline', () => {
    applyOnlineState()
    if (state.data) showOffline()
  })
  window.addEventListener('online', () => {
    applyOnlineState()
    refresh()
  })
  api.setSignInUi({
    show: () => { $('#signin').hidden = false },
    hide: () => { $('#signin').hidden = true },
    render: draw => {
      const box = $('#signin-button')
      box.replaceChildren()
      draw(box)
    }
  })
  $('#prev-week').addEventListener('click', () => moveWeek(-1))
  $('#next-week').addEventListener('click', () => moveWeek(1))
  $('#this-week').addEventListener('click', () => {
    state.weekStart = mondayOf(today())
    moveWeek(0)
  })
  for (const tab of TABS) $(`#nav-${tab}`).addEventListener('click', () => showTab(tab))
  setupSwipe(document)
  $('#save-btn').addEventListener('click', () => save('draft'))
  $('#confirm-btn').addEventListener('click', () => save('confirmed'))
  $('#propose-btn').addEventListener('click', newProposal)
  $('#discard-btn').addEventListener('click', discardChanges)
  $('#settings-btn').addEventListener('click', openSettings)
  $('#update-btn').addEventListener('click', updateApp)
  $('#settings').addEventListener('close', onSettingsClose)
  $('#signout-btn').addEventListener('click', async () => {
    $('#settings').close()
    await api.signOut()
    writeJSON(STORE.cache, null)
    state.data = null
    $('#week').hidden = true
    refresh()
  })

  if (api.DEMO) {
    $('#settings-btn').hidden = true
    refresh()
    return
  }

  const cached = readJSON(STORE.cache)
  if (cached) {
    try {
      setData(cached)
      showWeek()
    } catch {
      writeJSON(STORE.cache, null)
    }
  }
  refresh()
}

main()
