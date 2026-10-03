// Data helpers shared by the app and the skill: merge the Drive files into one
// object, apply the schema defaults, and compute the canteen week for a date.
// Pure ES module: no DOM, no network, no Node-only API, no Date.now().

export const SCHEMA_VERSION = '1.0'
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const SCHOOL_DAYS = WEEKDAYS.slice(0, 5)

const DAY_MS = 24 * 60 * 60 * 1000
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// --- dates -----------------------------------------------------------------
// Dates are 'YYYY-MM-DD' strings. Arithmetic runs on UTC day numbers, so the
// result never depends on the time zone or on daylight saving.

export function dayNumber (date) {
  const m = DATE_RE.exec(date)
  if (!m) throw new Error(`Invalid date: ${date}`)
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const back = new Date(ms).toISOString().slice(0, 10)
  if (back !== date) throw new Error(`Invalid date: ${date}`)
  return ms / DAY_MS
}

export function fromDayNumber (n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

export function addDays (date, days) {
  return fromDayNumber(dayNumber(date) + days)
}

// 'mon'..'sun' for a date.
export function weekdayOf (date) {
  // Day 0 (1970-01-01) was a Thursday.
  return WEEKDAYS[(((dayNumber(date) + 3) % 7) + 7) % 7]
}

// The Monday of the week containing the date.
export function mondayOf (date) {
  return addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)))
}

// ISO week id of the week containing the date, as plans use it: '2026-w40'.
export function isoWeekId (date) {
  const thursday = dayNumber(mondayOf(date)) + 3
  const year = fromDayNumber(thursday).slice(0, 4)
  const week = Math.floor((thursday - dayNumber(`${year}-01-01`)) / 7) + 1
  return `${year}-w${String(week).padStart(2, '0')}`
}

// --- merge and defaults ----------------------------------------------------

// Merge the Drive files into the single object of docs/schema.md.
// `plans` comes from plans.json and `pantry` from pantry.json (both written by
// the app); until those files exist, from family-data.json.
export function mergeData ({ catalog = {}, family = {}, plans = null, pantry = null } = {}) {
  const planList = plans && Array.isArray(plans.plans) ? plans.plans : family.plans
  const staples = pantry && Array.isArray(pantry.pantry) ? pantry.pantry : family.pantry
  return applyDefaults({
    schema_version: catalog.schema_version || family.schema_version || SCHEMA_VERSION,
    family: family.family || {},
    dishes: catalog.dishes || [],
    school_menus: catalog.school_menus || [],
    rules: family.rules || [],
    plans: planList || [],
    pantry: staples || []
  })
}

// Fill the keys the skill omits when they hold their default value.
// Returns new objects; the input is not modified.
export function applyDefaults (data) {
  return {
    ...data,
    family: withFamilyDefaults(data.family || {}),
    dishes: (data.dishes || []).map(withDishDefaults),
    school_menus: (data.school_menus || []).map(withMenuDefaults),
    rules: data.rules || [],
    plans: data.plans || [],
    pantry: data.pantry || []
  }
}

function withFamilyDefaults (family) {
  return {
    adults: 2,
    ...family,
    children: family.children || [],
    disliked_ingredients: family.disliked_ingredients || []
  }
}

export function withDishDefaults (dish) {
  const out = {
    ...dish,
    allergens: dish.allergens || [],
    ingredients: dish.ingredients || [],
    tags: dish.tags || [],
    aliases: dish.aliases || [],
    verified: dish.verified === true,
    cookable_at_home: dish.cookable_at_home !== false
  }
  if (dish.nutrition) {
    const n = dish.nutrition
    out.nutrition = {
      ...n,
      carbs: n.carbs || [],
      cereals: n.cereals || [],
      proteins: n.proteins || [],
      fats: n.fats || [],
      vegetables: n.vegetables || { present: false }
    }
  }
  return out
}

function withMenuDefaults (menu) {
  return {
    ...menu,
    active: menu.active === true,
    cycle_start_date: menu.cycle_start_date || null,
    notes: menu.notes || [],
    weeks: (menu.weeks || []).map(week => ({
      ...week,
      days: (week.days || []).map(day => ({
        ...day,
        items: (day.items || []).map(item => ({
          ...item,
          options: item.options || [],
          portion: item.portion === undefined ? 1 : item.portion
        }))
      }))
    }))
  }
}

// --- canteen ---------------------------------------------------------------

export function activeMenu (data) {
  return (data.school_menus || []).find(m => m.active) || null
}

// Cycle week (1..N) for a date, or null when the menu has no start date.
// Holidays are ignored on purpose: the cycle advances every calendar week.
export function cycleWeek (menu, date) {
  const n = (menu.weeks || []).length
  if (!menu.cycle_start_date || n === 0) return null
  const start = mondayOf(menu.cycle_start_date)
  const weeks = Math.floor((dayNumber(mondayOf(date)) - dayNumber(start)) / 7)
  return ((weeks % n) + n) % n + 1
}

// The canteen lunches of the week containing `date`.
// `fallbackWeek` is used when the menu has no cycle_start_date yet.
// Returns null when there is no active menu.
export function canteenWeek (data, date, { fallbackWeek = 1 } = {}) {
  const menu = activeMenu(data)
  if (!menu) return null
  const weekStart = mondayOf(date)
  const computed = cycleWeek(menu, weekStart)
  const number = computed || fallbackWeek
  const week = menu.weeks.find(w => w.week === number) || null
  const dishes = dishIndex(data)
  const days = SCHOOL_DAYS.map((weekday, i) => {
    const day = week && week.days.find(d => d.weekday === weekday)
    return {
      date: addDays(weekStart, i),
      weekday,
      items: day ? day.items.map(item => resolveItem(item, dishes)) : []
    }
  })
  return {
    menuId: menu.id,
    menuName: menu.name,
    weekStart,
    cycleWeek: number,
    cycleWeekKnown: computed !== null,
    weekCount: menu.weeks.length,
    days
  }
}

function resolveItem (item, dishes) {
  const options = item.options.map(id => dishes.get(id) || { id, name: id, missing: true })
  return { course: item.course, portion: item.portion, options }
}

export function dishIndex (data) {
  return new Map((data.dishes || []).map(d => [d.id, d]))
}
