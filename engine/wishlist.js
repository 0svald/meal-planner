// Recipe wishlist: recipes the family asks to add to the catalog.
//
// The app writes wishlist.json; the skill reads it, adds the dishes to
// catalog.json and writes "wish:<id>" in the new dish's source.ref. A wish is
// "added" when some dish refers to it: the skill never writes wishlist.json.
// Pure ES module: no DOM, no network, no Node-only API, no Date.now().

export const WISH_REF = 'wish:'

// Ids of the wishes a dish refers to: source.ref may hold several, e.g.
// "wish:w-20261004-ab12, wish:w-20261005-cd34".
export function wishIdsOf (dish) {
  const ref = (dish.source && dish.source.ref) || ''
  return [...String(ref).matchAll(/wish:([\w-]+)/g)].map(m => m[1])
}

// The wishes with their status, pending first (newest first), then added.
// Each: { ...wish, status: 'pending' | 'added', dishes: [{id, name}] }.
export function wishlistView (data) {
  const byWish = new Map()
  for (const dish of data.dishes || []) {
    for (const id of wishIdsOf(dish)) {
      if (!byWish.has(id)) byWish.set(id, [])
      byWish.get(id).push({ id: dish.id, name: dish.name })
    }
  }
  const view = (data.wishlist || []).map(w => {
    const dishes = byWish.get(w.id) || []
    return { ...w, status: dishes.length ? 'added' : 'pending', dishes }
  })
  const newest = (a, b) => String(b.added_at || '').localeCompare(String(a.added_at || ''))
  return [
    ...view.filter(w => w.status === 'pending').sort(newest),
    ...view.filter(w => w.status === 'added').sort(newest)
  ]
}
