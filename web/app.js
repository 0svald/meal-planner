// The week screen: canteen lunches next to the home meals, three options per
// meal, live feedback on the rules, save as draft or confirm.
// Planning logic lives in ../engine/; this file fetches, renders and saves.

import { mergeData, canteenWeek, mondayOf, addDays, isoWeekId, WEEKDAYS } from '../engine/data.js'
import { proposeWeek, evaluatePlan, slotOptions } from '../engine/planner.js'
import { buildWeek, HOME_SLOTS } from '../engine/week.js'
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
const MINOR_COURSES = new Set(['bread', 'fruit', 'dessert'])
const DAY_NAMES = {
  mon: 'Lunedì', tue: 'Martedì', wed: 'Mercoledì', thu: 'Giovedì', fri: 'Venerdì', sat: 'Sabato', sun: 'Domenica'
}
const SLOT_NAMES = { lunch: 'Pranzo', dinner: 'Cena' }
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']

const state = {
  data: null,
  fetchedAt: null,
  email: null,
  plansUpdatedAt: null,
  weekStart: null,
  // Local edits by week: { [weekStart]: { plan, dirty, seed } }. Unsaved ones
  // are kept in localStorage so closing the app does not lose them.
  drafts: readJSON(STORE.drafts) || {},
  sheet: null
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
  state.data = mergeData({ catalog: r.catalog.data, family: r.family.data, plans: r.plans.data })
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
  $('#feedback').replaceChildren(...[
    el('h2', {}, 'Equilibrio della settimana'),
    el('ul', { class: 'chips' }, frequencies.map(chip)),
    others.length ? el('ul', { class: 'problems' }, others.map(r => el('li', { class: r.severity }, r.detail))) : null,
    broken.length
      ? el('p', { class: 'small muted' }, `${broken.length} ${broken.length === 1 ? 'pasto da rivedere' : 'pasti da rivedere'}: vedi i giorni segnati.`)
      : el('p', { class: 'small muted' }, 'Nessun pasto viola le regole.')
  ].filter(Boolean))
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

function render () {
  if (!state.data) return
  const weekStart = state.weekStart
  const draft = draftFor(weekStart)
  const saved = savedPlan(weekStart)
  const canteen = canteenWeek(state.data, weekStart)
  const week = buildWeek(state.data, weekStart, { plan: draft.plan })
  const { results } = evaluatePlan({ data: state.data, weekStart, plan: draft.plan })
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
  $('#settings').showModal()
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

function main () {
  state.weekStart = mondayOf(today())
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
  $('#save-btn').addEventListener('click', () => save('draft'))
  $('#confirm-btn').addEventListener('click', () => save('confirmed'))
  $('#propose-btn').addEventListener('click', newProposal)
  $('#discard-btn').addEventListener('click', discardChanges)
  $('#settings-btn').addEventListener('click', openSettings)
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
  window.addEventListener('online', () => refresh())
  refresh()
}

main()
