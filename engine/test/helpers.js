// Small hand-built data sets for the rule tests.
import { applyDefaults, addDays, WEEKDAYS } from '../data.js'
import { buildWeek } from '../week.js'

export const MONDAY = '2026-09-28'

export function dish (id, course, { proteins = [], carbs = [], tags = [], prep = 10, ingredients = [], cuisine, name } = {}) {
  const d = {
    id,
    name: name || id,
    course,
    source: { type: course === 'takeaway' ? 'takeaway' : 'personal' },
    ingredients: ingredients.map(n => ({ name: n, aisle: 'other' })),
    nutrition: { carbs, proteins, confidence: 'high' },
    tags
  }
  if (prep !== null) d.prep_minutes = prep
  if (cuisine) d.cuisine = cuisine
  if (course === 'takeaway') d.cookable_at_home = false
  return d
}

// canteen: { mon: ['id', ...], ... } -> one-week menu starting MONDAY.
export function makeData ({ dishes, canteen = {}, rules = [], plans = [] }) {
  const byId = new Map(dishes.map(d => [d.id, d]))
  const days = Object.entries(canteen).map(([weekday, ids]) => ({
    weekday,
    items: ids.map(id => ({ course: byId.get(id).course, options: [id] }))
  }))
  return applyDefaults({
    dishes,
    school_menus: [{ id: 'm', active: true, cycle_start_date: MONDAY, weeks: [{ week: 1, days }] }],
    rules: rules.map((r, i) => ({ id: r.id || `r${i}`, priority: 'soft', enabled: true, description: 'x', ...r })),
    plans
  })
}

// meals: { 'mon/dinner': ['id'], ... } -> plan for the week of `monday`.
export function makePlan (meals, { monday = MONDAY, status = 'draft' } = {}) {
  return {
    week_start: monday,
    status,
    meals: Object.entries(meals).map(([key, ids]) => {
      const [weekday, slot] = key.split('/')
      return { date: addDays(monday, WEEKDAYS.indexOf(weekday)), slot, dish_ids: ids }
    })
  }
}

export function weekOf (data, meals = {}) {
  return buildWeek(data, MONDAY, { plan: makePlan(meals) })
}

export function ctxOf (data, history = []) {
  return { dishes: new Map(data.dishes.map(d => [d.id, d])), history }
}

// Fill every home slot so the week counts as complete.
export function fullWeek (meals, filler) {
  const keys = ['mon', 'tue', 'wed', 'thu', 'fri'].map(d => `${d}/dinner`)
    .concat(['sat/lunch', 'sat/dinner', 'sun/lunch', 'sun/dinner'])
  return Object.fromEntries(keys.map(k => [k, meals[k] || [filler]]))
}
