// Plan -> shopping list.
//
// - Ingredients of the home meals of the plan; takeaway meals are skipped and
//   canteen lunches are not in plans.
// - Merged by name (case, spaces and accents ignored), grouped by aisle.
// - Pantry staples are left out: an ingredient is a staple when its name is a
//   pantry item, or starts with one ("sale" covers "sale grosso").
// - Quantities are never computed: a recipe's own qty/unit is repeated next to
//   the dish it belongs to, and nothing is summed or scaled.
// Pure ES module: no DOM, no network, no Node-only API, no Date.now().

import { dishIndex, WEEKDAYS, addDays, dayNumber, mondayOf } from './data.js'

export const AISLE_ORDER = ['produce', 'meat', 'fish', 'dairy', 'bakery', 'pantry', 'frozen', 'other']

export const AISLE_LABELS = {
  produce: 'Frutta e verdura',
  meat: 'Carne',
  fish: 'Pesce',
  dairy: 'Latte, formaggi e uova',
  bakery: 'Pane e forno',
  pantry: 'Dispensa',
  frozen: 'Surgelati',
  other: 'Altro'
}

const DAY_SHORT = { mon: 'lun', tue: 'mar', wed: 'mer', thu: 'gio', fri: 'ven', sat: 'sab', sun: 'dom' }

export function normalize (name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function isStaple (name, pantry) {
  const n = normalize(name)
  return pantry.some(p => n === p || n.startsWith(`${p} `))
}

function quantityText (ing) {
  if (ing.qty === undefined || ing.qty === null || ing.qty === '') return null
  return ing.unit ? `${ing.qty} ${ing.unit}` : String(ing.qty)
}

// { weekStart, items: [...], aisles: [{aisle, label, items}], skipped: [...] }
// Each item: { key, name, aisle, uses: [{dishId, dishName, date, slot, quantity}] }.
export function shoppingList ({ data, plan, pantry = data.pantry || [] }) {
  const dishes = dishIndex(data)
  const staples = pantry.map(normalize)
  const items = new Map()
  const skipped = { pantry: new Set(), takeaway: [], missing: [] }

  const meals = (plan ? plan.meals : []).slice().sort((a, b) =>
    dayNumber(a.date) - dayNumber(b.date) || (a.slot === 'lunch' ? -1 : 1))

  for (const meal of meals) {
    for (const id of meal.dish_ids || []) {
      const dish = dishes.get(id)
      if (!dish) {
        skipped.missing.push(id)
        continue
      }
      if (dish.course === 'takeaway') {
        skipped.takeaway.push(dish.name)
        continue
      }
      for (const ing of dish.ingredients || []) {
        if (!ing || !ing.name) continue
        if (isStaple(ing.name, staples)) {
          skipped.pantry.add(normalize(ing.name))
          continue
        }
        const key = normalize(ing.name)
        if (!items.has(key)) items.set(key, { key, name: ing.name.trim(), aisle: ing.aisle || 'other', uses: [] })
        items.get(key).uses.push({
          dishId: dish.id,
          dishName: dish.name,
          date: meal.date,
          slot: meal.slot,
          quantity: quantityText(ing)
        })
      }
    }
  }

  const all = [...items.values()]
  const known = new Set(AISLE_ORDER)
  const aisles = AISLE_ORDER
    .map(aisle => ({
      aisle,
      label: AISLE_LABELS[aisle],
      items: all
        .filter(i => (known.has(i.aisle) ? i.aisle : 'other') === aisle)
        .sort((a, b) => a.key.localeCompare(b.key, 'it'))
    }))
    .filter(a => a.items.length)

  return {
    weekStart: plan ? plan.week_start : null,
    items: aisles.flatMap(a => a.items),
    aisles,
    skipped: { pantry: [...skipped.pantry].sort(), takeaway: skipped.takeaway, missing: skipped.missing }
  }
}

// Stated quantities of an item, with the dish they come from when more than
// one dish uses it: "320 g per Pasta e lenticchie, 200 g per Pasta al pomodoro".
export function quantityNote (item) {
  const stated = item.uses.filter(u => u.quantity)
  if (!stated.length) return ''
  const dishesUsing = new Set(item.uses.map(u => u.dishId))
  if (dishesUsing.size === 1) return stated.map(u => u.quantity).join(', ')
  return stated.map(u => `${u.quantity} per ${u.dishName}`).join(', ')
}

// When an item is used: "lun cena, sab pranzo".
export function usesNote (item) {
  const seen = new Set()
  return item.uses
    .map(u => {
      const weekday = WEEKDAYS[(dayNumber(u.date) - dayNumber(mondayOf(u.date)))]
      return `${DAY_SHORT[weekday]} ${u.slot === 'lunch' ? 'pranzo' : 'cena'}`
    })
    .filter(t => !seen.has(t) && seen.add(t))
    .join(', ')
}

// Plain text to share (Bring!, Keep, WhatsApp): one item per line, aisles as
// headings. `exclude` holds the keys of items already ticked off.
export function shoppingText (list, { exclude = [] } = {}) {
  const skip = new Set(exclude)
  const lines = []
  if (list.weekStart) {
    const [, m, d] = list.weekStart.split('-').map(Number)
    const [, m2, d2] = addDays(list.weekStart, 6).split('-').map(Number)
    lines.push(`Spesa settimana ${d}/${m} – ${d2}/${m2}`)
  }
  for (const aisle of list.aisles) {
    const items = aisle.items.filter(i => !skip.has(i.key))
    if (!items.length) continue
    lines.push('', aisle.label.toUpperCase())
    for (const item of items) {
      const q = quantityNote(item)
      lines.push(`- ${item.name}${q ? `: ${q}` : ''}`)
    }
  }
  return lines.join('\n').trim()
}
