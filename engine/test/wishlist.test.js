import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDefaults, mergeData } from '../data.js'
import { wishlistView, wishIdsOf } from '../wishlist.js'

const wishes = [
  { id: 'w-1', name: 'Polpette di lenticchie', added_by: 'mamma@example.com', added_at: '2026-10-01T10:00:00Z' },
  { id: 'w-2', name: 'Vellutata di zucca', url: 'https://example.com/zucca', added_at: '2026-10-03T10:00:00Z' },
  { id: 'w-3', name: 'Torta salata', note: 'senza forno?', added_at: '2026-10-02T10:00:00Z' }
]

test('mergeData reads wishlist.json', () => {
  assert.deepEqual(mergeData({}).wishlist, [])
  assert.equal(mergeData({ wishlist: { wishes } }).wishlist.length, 3)
})

test('wishIdsOf reads one or more wish refs from source.ref', () => {
  assert.deepEqual(wishIdsOf({ source: { type: 'web', ref: 'wish:w-1' } }), ['w-1'])
  assert.deepEqual(wishIdsOf({ source: { ref: 'Ricetta della nonna, wish:w-2, wish:w-3' } }), ['w-2', 'w-3'])
  assert.deepEqual(wishIdsOf({ source: { type: 'school' } }), [])
})

test('a wish is added once a catalog dish refers to it; pending first, newest first', () => {
  const data = applyDefaults({
    dishes: [{ id: 'polpette-lenticchie', name: 'Polpette di lenticchie', course: 'second', source: { type: 'web', ref: 'wish:w-1' } }],
    wishlist: wishes
  })
  const view = wishlistView(data)
  assert.deepEqual(view.map(w => [w.id, w.status]), [['w-2', 'pending'], ['w-3', 'pending'], ['w-1', 'added']])
  assert.deepEqual(view[2].dishes, [{ id: 'polpette-lenticchie', name: 'Polpette di lenticchie' }])
})
