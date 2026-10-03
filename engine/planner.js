// Proposals for the home meals of a week.
//
// proposeWeek({ data, weekStart, seed, plan, limit }) returns, for each home
// slot (7 dinners + Saturday and Sunday lunch), the proposed meal and `limit`
// (default 3) options to choose from, with the reasons for their ranking.
// Options differ in their main dish (not just the side); where a takeaway
// rule allows it, one option is a takeaway, which is never imposed.
//
// - Candidates are built from the meal_structure patterns (a first; a second
//   and a side; a single dish) using the dishes cookable at home, plus the
//   takeaway dishes where a takeaway rule allows them.
// - Hard rules filter: a candidate is dropped if it makes any hard rule worse
//   than leaving the slot empty (so a canteen week that already breaks a hard
//   rule does not block every proposal, but nothing adds to the breach).
// - Soft rules score: the sum of their penalties, lower is better.
// - The week is filled greedily, then improved slot by slot until no single
//   change lowers the score. Ties are broken by a hash of the seed, so the
//   result is deterministic for the same data and seed.
// Pure ES module: no DOM, no network, no Node-only API, no Date.now().

import { dishIndex, isoWeekId } from './data.js'
import { buildWeek, withMeal, slotKey, planHistory } from './week.js'
import { evaluateWeek, penalties } from './rules.js'

export const DEFAULT_PATTERNS = [['first'], ['second', 'side'], ['single']]
const MAX_PASSES = 5

// FNV-1a: a small deterministic hash for tie-breaking.
function hash (text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

function enabled (rules) {
  return rules.filter(r => r.enabled !== false)
}

// Dishes the planner may propose for home meals. Low-confidence classifications
// the family has not verified are left out until they are confirmed.
export function usableDishes (data) {
  return data.dishes.filter(d =>
    d.cookable_at_home !== false &&
    d.course !== 'takeaway' &&
    !(d.nutrition && d.nutrition.confidence === 'low' && !d.verified))
}

// All candidate meals (lists of dish ids) for one home meal.
export function candidateMeals (data, meal) {
  const rules = enabled(data.rules)
  const structure = rules.find(r =>
    r.type === 'meal_structure' && (r.params.slots || ['lunch', 'dinner']).includes(meal.slot))
  const patterns = structure ? structure.params.patterns : DEFAULT_PATTERNS
  const byCourse = new Map()
  for (const dish of usableDishes(data)) {
    if (!byCourse.has(dish.course)) byCourse.set(dish.course, [])
    byCourse.get(dish.course).push(dish.id)
  }

  const out = []
  for (const pattern of patterns) {
    let combos = [[]]
    for (const course of pattern) {
      const options = byCourse.get(course) || []
      combos = combos.flatMap(combo => options.filter(id => !combo.includes(id)).map(id => [...combo, id]))
    }
    out.push(...combos.filter(c => c.length === pattern.length))
  }

  const takeawayAllowed = rules.some(r =>
    r.type === 'takeaway' &&
    (r.params.slot || 'dinner') === meal.slot &&
    (r.params.days || []).includes(meal.weekday))
  if (takeawayAllowed) {
    for (const dish of data.dishes) if (dish.course === 'takeaway') out.push([dish.id])
  }
  return out
}

function ruleTotals (results) {
  const totals = new Map()
  for (const r of results) totals.set(r.ruleId, (totals.get(r.ruleId) || 0) + r.penalty)
  return totals
}

// Why a candidate ranks where it does: the soft rules it helps ('+') or hurts
// ('-') compared with leaving the slot empty.
function reasonsFor (key, results, totals, baseTotals, rules) {
  const reasons = []
  for (const rule of rules) {
    if (rule.priority === 'hard') continue
    const delta = (totals.get(rule.id) || 0) - (baseTotals.get(rule.id) || 0)
    if (delta === 0) continue
    const own = results.filter(r => r.ruleId === rule.id)
    const about = own.find(r => r.slot === key) || own.find(r => !r.satisfied) || own[0]
    reasons.push({ ruleId: rule.id, effect: delta < 0 ? '+' : '-', delta, detail: about ? about.detail : rule.description })
  }
  return reasons.sort((a, b) => a.delta - b.delta)
}

// Candidates for one slot given the rest of the week, best first.
function rankSlot (state, week, key) {
  const { rules, ctx, dishes, seed, candidates } = state
  const baseline = evaluateWeek(rules, withMeal(week, key, [], dishes), ctx)
  const baseTotals = ruleTotals(baseline)
  const hardRules = rules.filter(r => r.priority === 'hard')
  const ranked = []
  for (const dishIds of candidates.get(key)) {
    const results = evaluateWeek(rules, withMeal(week, key, dishIds, dishes), ctx)
    const totals = ruleTotals(results)
    if (hardRules.some(r => (totals.get(r.id) || 0) > (baseTotals.get(r.id) || 0))) continue
    ranked.push({
      dishIds,
      takeaway: isTakeaway({ dishIds }, dishes),
      score: penalties(results).soft,
      tie: hash(`${seed}|${key}|${dishIds.join('+')}`),
      results,
      totals,
      baseTotals
    })
  }
  ranked.sort((a, b) => a.score - b.score || a.tie - b.tie)
  return ranked
}

// A frequency maximum already exceeded without the free slots, or a meal rule
// broken as much without them (the fixed meals break it).
const MEAL_RULES = new Set(['complement', 'exclusion', 'time_limit', 'variety', 'meal_structure'])

function unavoidable (r, before) {
  if (r.satisfied) return false
  const own = before.filter(b => b.ruleId === r.ruleId)
  if (r.type === 'frequency') return r.excess > 0 && own.some(b => b.excess >= r.excess)
  if (MEAL_RULES.has(r.type)) return own.reduce((sum, b) => sum + b.penalty, 0) >= r.penalty
  return false
}

const isTakeaway = (c, dishes) => c.dishIds.some(id => (dishes.get(id) || {}).course === 'takeaway')

// The proposal is home-cooked: takeaway is only offered as an option.
function homeCooked (ranked) {
  return ranked.filter(c => !c.takeaway)
}

// The current meal first, then the best candidates with a different main dish
// (a side alone does not make another option); one takeaway where available.
function pickOptions (ranked, current, limit, dishes) {
  const main = c => c.dishIds.filter(id => (dishes.get(id) || {}).course !== 'side').join('+')
  const same = c => c.dishIds.join('+') === current.join('+')
  const options = []
  const seen = new Set()
  for (const c of [...ranked.filter(same), ...ranked]) {
    if (options.length >= limit) break
    if (seen.has(main(c))) continue
    seen.add(main(c))
    options.push(c)
  }
  const takeaway = ranked.find(c => c.takeaway)
  if (takeaway && limit > 1 && !options.some(c => c.takeaway)) {
    if (options.length >= limit) options.pop()
    options.push(takeaway)
  }
  return options
}

function describe (dishIds, dishes) {
  return dishIds.map(id => {
    const d = dishes.get(id)
    return d ? { id, name: d.name, course: d.course } : { id, name: id, course: null, missing: true }
  })
}

function setup (data, weekStart, plan, seed) {
  const dishes = dishIndex(data)
  const rules = enabled(data.rules)
  const week = buildWeek(data, weekStart, { plan })
  const ctx = { dishes, history: planHistory(data, week.weekStart) }
  const homeMeals = week.meals.filter(m => m.source === 'home')
  const candidates = new Map(homeMeals.map(m => [slotKey(m), candidateMeals(data, m)]))
  return { week, homeMeals, state: { rules, ctx, dishes, seed, candidates } }
}

function optionView (key, c, rules, dishes) {
  return {
    dishIds: c.dishIds,
    dishes: describe(c.dishIds, dishes),
    score: c.score,
    takeaway: c.takeaway,
    reasons: reasonsFor(key, c.results, c.totals, c.baseTotals, rules)
  }
}

// Results of every enabled rule on the week; breaches the canteen lunches
// already cause without the slots in `free` are flagged `unavoidable`.
function judge (state, week, free) {
  const { rules, ctx, dishes } = state
  const before = evaluateWeek(rules, free.reduce((w, k) => withMeal(w, k, [], dishes), week), ctx)
  const results = evaluateWeek(rules, week, ctx).map(r =>
    unavoidable(r, before) ? { ...r, unavoidable: true } : r)
  return { results, penalties: penalties(results) }
}

function planOf (week) {
  return {
    id: isoWeekId(week.weekStart),
    week_start: week.weekStart,
    status: 'draft',
    cycle_week: week.cycleWeek,
    meals: week.meals
      .filter(x => x.source === 'home' && x.dishIds.length)
      .map(x => ({ date: x.date, slot: x.slot, dish_ids: x.dishIds }))
  }
}

// How the week of `plan` stands against the rules, as the family edited it.
// `unavoidable` marks what the canteen lunches alone already break.
export function evaluatePlan ({ data, weekStart, plan = null }) {
  const { week, homeMeals, state } = setup(data, weekStart, plan, 0)
  return judge(state, week, homeMeals.map(slotKey))
}

// The options for one home slot (key 'YYYY-MM-DD/slot') given the rest of the
// plan: the current meal first if it is still allowed, then the best candidates
// with a different main dish. Computed on demand, when the family opens a slot.
export function slotOptions ({ data, weekStart, plan = null, key, limit = 3, seed = 0 }) {
  const { week, state } = setup(data, weekStart, plan, seed)
  const meal = week.meals.find(m => m.source === 'home' && slotKey(m) === key)
  if (!meal) throw new Error(`Unknown home slot: ${key}`)
  const ranked = rankSlot(state, week, key)
  return {
    key,
    current: describe(meal.dishIds, state.dishes),
    options: pickOptions(ranked, meal.dishIds, limit, state.dishes)
      .map(c => optionView(key, c, state.rules, state.dishes)),
    candidateCount: ranked.length
  }
}

export function proposeWeek ({ data, weekStart, seed = 0, plan = null, limit = 3, withOptions = true }) {
  const setupResult = setup(data, weekStart, plan, seed)
  const { homeMeals, state } = setupResult
  const { rules, ctx, dishes } = state
  let week = setupResult.week
  const fixed = new Set(homeMeals.filter(m => m.dishIds.length).map(slotKey))
  const free = homeMeals.map(slotKey).filter(k => !fixed.has(k))

  // Greedy fill, in calendar order.
  for (const key of free) {
    const [best] = homeCooked(rankSlot(state, week, key))
    if (best) week = withMeal(week, key, best.dishIds, dishes)
  }

  // Local improvement: change one slot at a time while the score drops.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false
    for (const key of free) {
      const current = penalties(evaluateWeek(rules, week, ctx)).soft
      const [best] = homeCooked(rankSlot(state, week, key))
      const now = week.meals.find(m => slotKey(m) === key).dishIds
      if (best && best.score < current && best.dishIds.join('+') !== now.join('+')) {
        week = withMeal(week, key, best.dishIds, dishes)
        changed = true
      }
    }
    if (!changed) break
  }

  const slots = homeMeals.map(m => {
    const key = slotKey(m)
    const meal = week.meals.find(x => slotKey(x) === key)
    const out = {
      key,
      date: m.date,
      weekday: m.weekday,
      slot: m.slot,
      fixed: fixed.has(key),
      chosen: describe(meal.dishIds, dishes)
    }
    if (withOptions) {
      const ranked = rankSlot(state, week, key)
      out.options = pickOptions(ranked, meal.dishIds, limit, dishes).map(c => optionView(key, c, rules, dishes))
      out.candidateCount = ranked.length
    }
    return out
  })

  // Breaches the canteen lunches (and the fixed meals) already cause: the
  // proposals cannot fix them, and the UI should say so instead of blaming the plan.
  const { results, penalties: totals } = judge(state, week, free)
  return {
    weekStart: week.weekStart,
    cycleWeek: week.cycleWeek,
    seed,
    slots,
    results,
    penalties: totals,
    plan: planOf(week)
  }
}
