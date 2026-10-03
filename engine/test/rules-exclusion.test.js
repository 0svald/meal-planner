import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exclusion } from '../rules.js'
import { dish, makeData, weekOf } from './helpers.js'

const dishes = [
  dish('peperonata', 'side', { ingredients: ['Peperoni rossi', 'cipolla'] }),
  dish('pasta-peperoni', 'first', { name: 'Pasta ai peperoni' }),
  dish('insalata', 'side', { ingredients: ['lattuga'] })
]
const rule = { id: 'e', type: 'exclusion', priority: 'hard', params: { ingredients: ['peperoni'] } }

test('substring match on ingredient names, case-insensitive', () => {
  const data = makeData({ dishes })
  const results = exclusion(rule, weekOf(data, { 'mon/dinner': ['peperonata'] }))
  assert.equal(results.length, 1)
  assert.equal(results[0].satisfied, false)
  assert.equal(results[0].slot, '2026-09-28/dinner')
})

test('the dish name is checked too', () => {
  const data = makeData({ dishes })
  const [r] = exclusion(rule, weekOf(data, { 'tue/dinner': ['pasta-peperoni'] }))
  assert.equal(r.satisfied, false)
})

test('canteen lunches are not the family choice', () => {
  const data = makeData({ dishes, canteen: { mon: ['peperonata'] } })
  const [r] = exclusion(rule, weekOf(data, { 'mon/dinner': ['insalata'] }))
  assert.equal(r.satisfied, true)
})
