// Catalog search: free text plus filters on the dish properties. Pure, like
// the rest of engine/, so the app and the skill find the same dishes.

// Lower case without accents, so "melanzane" finds "Melanzane" and "pure"
// finds "purè".
export function normalizeText (text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function haystack (dish) {
  return normalizeText([
    dish.name,
    ...(dish.aliases || []),
    ...(dish.tags || []),
    ...(dish.ingredients || []).map(i => i.name)
  ].join(' '))
}

const HOME_SOURCES = ['personal', 'web']

// filters: {
//   text: words, all must appear in the name, aliases, tags or ingredients;
//   course: a course id;
//   protein: a protein id, or 'none' for dishes without proteins;
//   carb: a carbohydrate id, or 'none';
//   vegetables: 'any' | 'none' | 'raw' | 'cooked' (raw and cooked include 'both');
//   without: allergen ids the dish must not contain;
//   max_minutes: preparation time at most this (dishes without a time are left out);
//   origin: 'home' (personal or web) | 'school' | 'takeaway';
//   status: 'unverified' | 'edited' | 'cookable' (cookable at home)
// }
// Empty or missing filters match everything. Results are sorted by name.
export function searchDishes (dishes, filters = {}) {
  const words = normalizeText(filters.text).split(/\s+/).filter(Boolean)
  const without = filters.without || []
  const maxMinutes = filters.max_minutes ? Number(filters.max_minutes) : null
  return dishes.filter(dish => {
    const n = dish.nutrition || {}
    const proteins = n.proteins || []
    const carbs = n.carbs || []
    const veg = n.vegetables && n.vegetables.present ? n.vegetables.form || 'cooked' : 'none'
    const source = (dish.source || {}).type
    if (words.length) {
      const text = haystack(dish)
      if (!words.every(w => text.includes(w))) return false
    }
    if (filters.course && dish.course !== filters.course) return false
    if (filters.protein === 'none' ? proteins.length : filters.protein && !proteins.includes(filters.protein)) return false
    if (filters.carb === 'none' ? carbs.length : filters.carb && !carbs.includes(filters.carb)) return false
    if (filters.vegetables === 'any' && veg === 'none') return false
    if (filters.vegetables === 'none' && veg !== 'none') return false
    if (filters.vegetables === 'raw' && !['raw', 'both'].includes(veg)) return false
    if (filters.vegetables === 'cooked' && !['cooked', 'both'].includes(veg)) return false
    if (without.some(a => (dish.allergens || []).includes(a))) return false
    if (maxMinutes !== null && !(typeof dish.prep_minutes === 'number' && dish.prep_minutes <= maxMinutes)) return false
    if (filters.origin === 'home' && !HOME_SOURCES.includes(source)) return false
    if (filters.origin === 'school' && source !== 'school') return false
    if (filters.origin === 'takeaway' && dish.course !== 'takeaway' && source !== 'takeaway') return false
    if (filters.status === 'unverified' && dish.verified) return false
    if (filters.status === 'edited' && !dish.edited) return false
    if (filters.status === 'cookable' && dish.cookable_at_home === false) return false
    return true
  }).sort((a, b) => a.name.localeCompare(b.name, 'it'))
}

// How many filters are set (the free text excluded), for the "Filtri (n)" button.
export function activeFilterCount (filters = {}) {
  return ['course', 'protein', 'carb', 'vegetables', 'max_minutes', 'origin', 'status']
    .filter(k => filters[k]).length + (filters.without || []).length
}
