// One evaluator per rule type. Each takes (rule, week, ctx) and returns a list
// of results: { ruleId, type, priority, satisfied, severity, penalty, detail, slot? }.
//
// - `week` comes from buildWeek(); home meals may still be empty.
// - `ctx` = { dishes: Map id -> dish, history: planHistory(...) }.
// - `penalty` is 0 when satisfied; it measures how far the week is from the
//   rule, so the planner can compare candidates (lower is better).
// - `severity` is the rule priority ('hard' | 'soft') when not satisfied,
//   'pending' when the week is incomplete and only a minimum is missing,
//   'ok' otherwise.
// - `slot` ('YYYY-MM-DD/dinner') names the meal a result is about, if any.
// - frequency results also carry `count` and `excess` (count above `max`).
// The details are Italian: the UI shows them as they are.

import { WEEKDAYS, dayNumber } from './data.js'
import {
  EXTRA_COURSES, GROUP_LABELS, mealGroups, slotKey, isTakeawayMeal, isComplete
} from './week.js'

// A bound missed by one unit costs BOUND; a target missed by one unit costs TARGET.
export const BOUND = 10
export const TARGET = 1

const DAY_SHORT = { mon: 'lun', tue: 'mar', wed: 'mer', thu: 'gio', fri: 'ven', sat: 'sab', sun: 'dom' }
const SLOT_LABELS = { lunch: 'pranzo', dinner: 'cena' }
const COURSE_LABELS = {
  first: 'primo',
  second: 'secondo',
  side: 'contorno',
  single: 'piatto unico',
  takeaway: 'asporto',
  bread: 'pane',
  fruit: 'frutta',
  dessert: 'dolce'
}
const CUISINE_LABELS = { pizza: 'pizza', chinese: 'cinese', japanese: 'giapponese', other: 'altro' }

// Courses the variety rule looks at: a side salad may come back every day.
export const VARIETY_COURSES = new Set(['first', 'second', 'single'])

function mealLabel (meal) {
  return `${SLOT_LABELS[meal.slot]} di ${DAY_SHORT[meal.weekday]}`
}

function result (rule, fields) {
  const satisfied = fields.satisfied
  return {
    ruleId: rule.id,
    type: rule.type,
    priority: rule.priority,
    satisfied,
    severity: satisfied ? 'ok' : (fields.pending ? 'pending' : rule.priority),
    penalty: fields.penalty || 0,
    detail: fields.detail,
    ...(fields.slot ? { slot: fields.slot } : {})
  }
}

function homeMeals (week) {
  return week.meals.filter(m => m.source === 'home' && m.dishes.length > 0)
}

// --- frequency ---------------------------------------------------------------
// Counts the meals of the week in the group. `applies_to`: children eat the
// canteen lunches and the home meals; adults only the home meals; family = all.

export function frequency (rule, week) {
  const { group, applies_to: who = 'children', min, target, max } = rule.params
  const meals = week.meals.filter(m => m.dishes.length > 0 && (who !== 'adults' || m.source === 'home'))
  const count = meals.filter(m => mealGroups(m).has(group)).length
  const complete = isComplete(week)

  let penalty = 0
  if (max !== undefined && count > max) penalty += (count - max) * BOUND
  if (min !== undefined && count < min) penalty += (min - count) * BOUND
  if (target !== undefined) penalty += Math.abs(count - target) * TARGET

  const overMax = max !== undefined && count > max
  const underMin = min !== undefined && count < min
  const label = GROUP_LABELS[group] || group
  let detail
  if (target !== undefined || min !== undefined) {
    detail = `${label} ${count} su ${target !== undefined ? target : min}`
    if (max !== undefined && overMax) detail += ` (massimo ${max})`
  } else {
    detail = `${label} ${count} (massimo ${max})`
  }
  return [{
    ...result(rule, {
      satisfied: !overMax && !underMin,
      pending: !overMax && underMin && !complete,
      penalty,
      detail
    }),
    count,
    excess: overMax ? count - max : 0
  }]
}

// --- complement --------------------------------------------------------------
// Two meals close in time must not be alike:
//   when: 'same_day' (default) -> lunch and dinner of the same day;
//   when: 'next_day'           -> dinner and the next day's lunch (Sunday
//                                 dinner and the next Monday's canteen lunch).
// Alike = they share a group of `groups`, or, with `same_dish: true`, the same
// first, second or single dish. With `cross: true` the groups exclude each
// other instead: one of them in the first meal rules out the *other* groups in
// the second (groups: ['fish', 'meat'] -> fish at lunch, no meat at dinner, and
// the other way round); the same group twice is left to other rules.

export function complement (rule, week) {
  const { groups = [], when = 'same_day', same_dish: sameDish = false, cross = false } = rule.params
  const find = (weekday, slot) => week.meals.find(m => m.weekday === weekday && m.slot === slot)
  const pairs = WEEKDAYS.map((weekday, i) => when === 'next_day'
    ? [find(weekday, 'dinner'), i < 6 ? find(WEEKDAYS[i + 1], 'lunch') : week.nextMondayLunch]
    : [find(weekday, 'lunch'), find(weekday, 'dinner')])

  const out = []
  for (const [first, second] of pairs) {
    if (!first || !second || !first.dishes.length || !second.dishes.length) continue
    const a = mealGroups(first)
    const b = mealGroups(second)
    const label = g => (GROUP_LABELS[g] || g).toLowerCase()
    if (cross) {
      const clash = groups.flatMap(g1 => groups.filter(g2 => g2 !== g1 && a.has(g1) && b.has(g2)).map(g2 => [g1, g2]))
      if (!clash.length) continue
      const dinner = first.slot === 'dinner' ? first : second
      const what = clash.map(([g1, g2]) => `${label(g1)} a ${first.slot === 'lunch' ? 'pranzo' : 'cena'} e ${label(g2)} a ${second.slot === 'lunch' ? 'pranzo' : 'cena'}`)
      out.push(result(rule, {
        satisfied: false,
        penalty: clash.length * BOUND,
        slot: slotKey(dinner),
        detail: when === 'next_day'
          ? `${what.join(', ')} (cena ${DAY_SHORT[first.weekday]}, pranzo ${DAY_SHORT[second.weekday]})`
          : `${DAY_SHORT[first.weekday]}: ${what.join(', ')}`
      }))
      continue
    }
    const sharedGroups = groups.filter(g => a.has(g) && b.has(g)).map(label)
    const sharedDishes = []
    if (sameDish) {
      const ids = new Set(second.dishes.filter(d => VARIETY_COURSES.has(d.course)).map(d => d.id))
      for (const d of first.dishes) if (VARIETY_COURSES.has(d.course) && ids.has(d.id)) sharedDishes.push(d.name)
    }
    if (!sharedGroups.length && !sharedDishes.length) continue
    // The same dish says it all; otherwise name the groups.
    const shared = sharedDishes.length ? sharedDishes : sharedGroups
    const dinner = first.slot === 'dinner' ? first : second
    out.push(result(rule, {
      satisfied: false,
      penalty: (sharedGroups.length + sharedDishes.length) * BOUND,
      slot: slotKey(dinner),
      detail: when === 'next_day'
        ? `${shared.join(', ')} a cena ${DAY_SHORT[first.weekday]} e a pranzo ${DAY_SHORT[second.weekday]}`
        : `${DAY_SHORT[first.weekday]}: ${shared.join(', ')} sia a pranzo sia a cena`
    }))
  }
  if (out.length) return out
  return [result(rule, {
    satisfied: true,
    detail: cross
      ? `${groups.map(g => GROUP_LABELS[g] || g).join(' e ')}: mai insieme nello stesso giorno`
      : when === 'next_day' ? 'La cena non ripete il pranzo del giorno dopo' : 'Pranzo e cena si completano'
  })]
}

// --- exclusion ---------------------------------------------------------------
// Case-insensitive substring match on ingredient names and on the dish name.
// Only home meals: the canteen menu is not the family's choice.

export function exclusion (rule, week) {
  const terms = (rule.params.ingredients || []).map(t => t.toLowerCase())
  const out = []
  for (const meal of homeMeals(week)) {
    for (const dish of meal.dishes) {
      const texts = [dish.name || '', ...(dish.ingredients || []).map(i => i.name)].map(t => t.toLowerCase())
      const hit = terms.find(term => texts.some(t => t.includes(term)))
      if (hit) {
        out.push(result(rule, {
          satisfied: false,
          penalty: BOUND,
          slot: slotKey(meal),
          detail: `${dish.name} contiene ${hit} (${mealLabel(meal)})`
        }))
      }
    }
  }
  return out.length ? out : [result(rule, { satisfied: true, detail: 'Nessun ingrediente escluso' })]
}

// --- time_limit --------------------------------------------------------------
// Total prep_minutes of a home meal on the listed days. A dish without
// prep_minutes fails the check: the family has not said it is quick.
// Takeaway meals need no preparation.

export function timeLimit (rule, week) {
  const { max_prep_minutes: limit, days = WEEKDAYS } = rule.params
  const out = []
  for (const meal of homeMeals(week)) {
    if (!days.includes(meal.weekday) || isTakeawayMeal(meal)) continue
    const unknown = meal.dishes.filter(d => typeof d.prep_minutes !== 'number')
    const total = meal.dishes.reduce((sum, d) => sum + (d.prep_minutes || 0), 0)
    if (unknown.length) {
      out.push(result(rule, {
        satisfied: false,
        penalty: BOUND,
        slot: slotKey(meal),
        detail: `${unknown.map(d => d.name).join(', ')}: tempo di preparazione non indicato (${mealLabel(meal)})`
      }))
    } else if (total > limit) {
      out.push(result(rule, {
        satisfied: false,
        penalty: Math.ceil((total - limit) / 15) * BOUND,
        slot: slotKey(meal),
        detail: `Preparazione ${total} minuti, massimo ${limit} (${mealLabel(meal)})`
      }))
    }
  }
  return out.length ? out : [result(rule, { satisfied: true, detail: `Preparazione entro ${limit} minuti` })]
}

// --- variety -----------------------------------------------------------------
// Days since a dish last appeared in a confirmed plan or earlier this week.
// Only main courses (VARIETY_COURSES) of home meals count; canteen lunches do not.

export function variety (rule, week, ctx) {
  const minDays = rule.params.min_days_between_repeats
  const lastSeen = new Map()
  for (const past of ctx.history || []) {
    const [, m, d] = past.date.split('-').map(Number)
    for (const id of past.dishIds) lastSeen.set(id, { date: past.date, label: `${d}/${m}` })
  }
  const out = []
  const meals = homeMeals(week).slice().sort((a, b) =>
    dayNumber(a.date) - dayNumber(b.date) || (a.slot === 'lunch' ? -1 : 1))
  for (const meal of meals) {
    for (const dish of meal.dishes) {
      if (!VARIETY_COURSES.has(dish.course)) continue
      const prev = lastSeen.get(dish.id)
      if (prev !== undefined) {
        const days = dayNumber(meal.date) - dayNumber(prev.date)
        if (days < minDays) {
          out.push(result(rule, {
            satisfied: false,
            penalty: Math.ceil(BOUND * (minDays - days) / minDays),
            slot: slotKey(meal),
            detail: `${dish.name} ripetuto a ${days} ${days === 1 ? 'giorno' : 'giorni'} di distanza ` +
              `(${prev.label} e ${mealLabel(meal)})`
          }))
        }
      }
      lastSeen.set(dish.id, { date: meal.date, label: mealLabel(meal) })
    }
  }
  return out.length ? out : [result(rule, { satisfied: true, detail: `Nessuna ricetta ripetuta entro ${minDays} giorni` })]
}

// --- takeaway ----------------------------------------------------------------
// Takeaway is optional: at most `per_week` takeaway meals, only on `days` at
// `slot`, cuisines in rotation (after the last confirmed takeaway comes the
// next cuisine of the list). The planner offers it as one of the options of
// those slots, it never imposes it.

export function takeaway (rule, week, ctx) {
  const { per_week: perWeek = 1, days = WEEKDAYS, slot = 'dinner', rotate_cuisines: rotation = [] } = rule.params
  const meals = homeMeals(week).filter(isTakeawayMeal)
  const out = []

  for (const meal of meals) {
    if (!days.includes(meal.weekday) || meal.slot !== slot) {
      out.push(result(rule, {
        satisfied: false,
        penalty: BOUND,
        slot: slotKey(meal),
        detail: `Asporto fuori dai giorni previsti (${mealLabel(meal)})`
      }))
    }
  }

  if (meals.length > perWeek) {
    out.push(result(rule, {
      satisfied: false,
      penalty: (meals.length - perWeek) * BOUND,
      detail: `Asporto ${meals.length} volte, al massimo ${perWeek}`
    }))
  }

  const expected = nextCuisine(rotation, ctx)
  if (expected) {
    for (const meal of meals) {
      const cuisine = meal.dishes[0].cuisine
      if (cuisine && cuisine !== expected) {
        out.push(result(rule, {
          satisfied: false,
          penalty: Math.ceil(BOUND / 3),
          slot: slotKey(meal),
          detail: `Questa settimana tocca alla cucina ${CUISINE_LABELS[expected] || expected}`
        }))
      }
    }
  }
  return out.length ? out : [result(rule, { satisfied: true, detail: `Asporto ${meals.length} (al massimo ${perWeek})` })]
}

function nextCuisine (rotation, ctx) {
  if (!rotation.length) return null
  let last = null
  for (const past of ctx.history || []) {
    for (const id of past.dishIds) {
      const dish = ctx.dishes.get(id)
      if (dish && dish.course === 'takeaway' && dish.cuisine) last = dish.cuisine
    }
  }
  if (!last || !rotation.includes(last)) return null
  return rotation[(rotation.indexOf(last) + 1) % rotation.length]
}

// --- meal_structure ----------------------------------------------------------
// The courses of a home meal (bread, fruit and dessert aside) must match one of
// the allowed patterns. A takeaway meal is one dish of course takeaway.

export function mealStructure (rule, week) {
  const { slots = ['lunch', 'dinner'], patterns = [] } = rule.params
  const allowed = patterns.map(p => p.slice().sort().join('+'))
  const out = []
  for (const meal of homeMeals(week)) {
    if (!slots.includes(meal.slot)) continue
    if (isTakeawayMeal(meal) && meal.dishes.length === 1) continue
    const courses = meal.dishes.map(d => d.course).filter(c => !EXTRA_COURSES.has(c))
    if (!allowed.includes(courses.slice().sort().join('+'))) {
      out.push(result(rule, {
        satisfied: false,
        penalty: BOUND,
        slot: slotKey(meal),
        detail: `Composizione non prevista: ${courses.map(c => COURSE_LABELS[c] || c).join(' + ') || 'vuoto'} (${mealLabel(meal)})`
      }))
    }
  }
  return out.length ? out : [result(rule, { satisfied: true, detail: 'Composizione dei pasti corretta' })]
}

// --- all rules ---------------------------------------------------------------

export const EVALUATORS = {
  frequency,
  complement,
  exclusion,
  time_limit: timeLimit,
  variety,
  takeaway,
  meal_structure: mealStructure
}

// Evaluate every enabled rule on the week.
export function evaluateWeek (rules, week, ctx) {
  return rules
    .filter(r => r.enabled !== false && EVALUATORS[r.type])
    .flatMap(r => EVALUATORS[r.type](r, week, ctx))
}

// Sum of penalties by priority: { hard, soft }.
export function penalties (results) {
  const out = { hard: 0, soft: 0 }
  for (const r of results) out[r.priority === 'hard' ? 'hard' : 'soft'] += r.penalty
  return out
}
