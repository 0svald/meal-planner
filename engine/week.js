// The week as a list of meals (canteen lunches + home meals), plus the
// frequency groups a meal counts toward. Shared by rules.js and planner.js.
// Pure ES module: no DOM, no network, no Node-only API, no Date.now().

import { WEEKDAYS, addDays, mondayOf, dayNumber, canteenWeek, dishIndex } from './data.js'

// Home meals the family plans: every dinner plus Saturday and Sunday lunch.
export const HOME_SLOTS = WEEKDAYS.flatMap(weekday =>
  weekday === 'sat' || weekday === 'sun'
    ? [{ weekday, slot: 'lunch' }, { weekday, slot: 'dinner' }]
    : [{ weekday, slot: 'dinner' }]
)

// Courses that complete a meal without being part of its structure.
export const EXTRA_COURSES = new Set(['bread', 'fruit', 'dessert'])

// Frequency groups (docs/taxonomy.md): group -> dish fields that make a dish count.
export const FREQUENCY_GROUPS = {
  legumes: { proteins: ['legumes'] },
  fish: { proteins: ['fish', 'shellfish'] },
  meat: { proteins: ['red_meat', 'white_meat', 'processed_meat'] },
  red_meat: { proteins: ['red_meat'] },
  white_meat: { proteins: ['white_meat'] },
  processed_meat: { proteins: ['processed_meat'] },
  eggs: { proteins: ['eggs'] },
  cheese: { proteins: ['cheese'] },
  potatoes: { carbs: ['tubers'] },
  pizza: { tags: ['pizza'] }
}

export const GROUP_LABELS = {
  legumes: 'Legumi',
  fish: 'Pesce',
  meat: 'Carne',
  red_meat: 'Carne rossa',
  white_meat: 'Carne bianca',
  processed_meat: 'Carni lavorate',
  eggs: 'Uova',
  cheese: 'Formaggi',
  potatoes: 'Patate',
  pizza: 'Pizza'
}

const groupCache = new WeakMap()

export function dishGroups (dish) {
  if (groupCache.has(dish)) return groupCache.get(dish)
  const groups = new Set()
  const n = dish.nutrition || {}
  for (const [group, fields] of Object.entries(FREQUENCY_GROUPS)) {
    for (const [field, values] of Object.entries(fields)) {
      const have = field === 'tags' ? (dish.tags || []) : (n[field] || [])
      if (values.some(v => have.includes(v))) groups.add(group)
    }
  }
  groupCache.set(dish, groups)
  return groups
}

// A meal counts once per group, however many of its dishes belong to it.
export function mealGroups (meal) {
  const groups = new Set()
  for (const dish of meal.dishes) for (const g of dishGroups(dish)) groups.add(g)
  return groups
}

export function slotKey (meal) {
  return `${meal.date}/${meal.slot}`
}

export function isTakeawayMeal (meal) {
  return meal.dishes.length > 0 && meal.dishes.every(d => d.course === 'takeaway')
}

function homeMeal (date, weekday, slot, dishIds, dishes) {
  return {
    date,
    weekday,
    slot,
    source: 'home',
    dishIds: dishIds.slice(),
    dishes: dishIds.map(id => dishes.get(id) || { id, name: id, course: 'other', missing: true })
  }
}

// Every meal of the week: canteen lunches Mon-Fri (first printed option) and
// the home slots, filled from `plan` when given, empty otherwise.
export function buildWeek (data, date, { plan = null } = {}) {
  const weekStart = mondayOf(date)
  const dishes = dishIndex(data)
  const canteen = canteenWeek(data, weekStart)
  const planned = new Map((plan ? plan.meals : []).map(m => [`${m.date}/${m.slot}`, m.dish_ids || []]))
  const meals = []
  WEEKDAYS.forEach((weekday, i) => {
    const date = addDays(weekStart, i)
    const canteenDay = canteen && canteen.days.find(d => d.date === date)
    if (canteenDay && canteenDay.items.length) {
      const lunch = canteenDay.items.map(item => item.options[0]).filter(Boolean)
      meals.push({
        date, weekday, slot: 'lunch', source: 'canteen', dishIds: lunch.map(d => d.id), dishes: lunch
      })
    }
    for (const s of HOME_SLOTS.filter(h => h.weekday === weekday)) {
      meals.push(homeMeal(date, weekday, s.slot, planned.get(`${date}/${s.slot}`) || [], dishes))
    }
  })
  return { weekStart, cycleWeek: canteen ? canteen.cycleWeek : null, meals }
}

// Replace the dishes of one home meal; returns a new week.
export function withMeal (week, key, dishIds, dishes) {
  return {
    ...week,
    meals: week.meals.map(m =>
      m.source === 'home' && slotKey(m) === key ? homeMeal(m.date, m.weekday, m.slot, dishIds, dishes) : m
    )
  }
}

export function isComplete (week) {
  return week.meals.every(m => m.source !== 'home' || m.dishes.length > 0)
}

// Home meals of confirmed plans that start before `weekStart`, oldest first.
export function planHistory (data, weekStart) {
  const start = dayNumber(weekStart)
  return (data.plans || [])
    .filter(p => p.status === 'confirmed' && dayNumber(p.week_start) < start)
    .flatMap(p => p.meals.map(m => ({ date: m.date, slot: m.slot, dishIds: m.dish_ids || [] })))
    .sort((a, b) => dayNumber(a.date) - dayNumber(b.date))
}
