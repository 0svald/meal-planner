import { test } from 'node:test'
import assert from 'node:assert/strict'
import { complement } from '../rules.js'
import { dish, makeData, weekOf } from './helpers.js'

const dishes = [
  dish('pollo', 'second', { proteins: ['white_meat'] }),
  dish('manzo', 'second', { proteins: ['red_meat'] }),
  dish('pesce', 'second', { proteins: ['fish'] }),
  dish('pasta', 'first')
]
const rule = { id: 'c', type: 'complement', priority: 'hard', params: { groups: ['meat', 'fish', 'eggs', 'cheese', 'legumes'] } }

test('the lunch protein group is not repeated at dinner', () => {
  const data = makeData({ dishes, canteen: { mon: ['pollo'] } })
  const [r] = complement(rule, weekOf(data, { 'mon/dinner': ['manzo'] }))
  assert.equal(r.satisfied, false)
  assert.equal(r.severity, 'hard')
  assert.equal(r.slot, '2026-09-28/dinner')
  assert.equal(r.detail, 'lun: carne sia a pranzo sia a cena')
})

test('different groups complement each other', () => {
  const data = makeData({ dishes, canteen: { mon: ['pollo'] } })
  const [r] = complement(rule, weekOf(data, { 'mon/dinner': ['pesce'], 'tue/dinner': ['pollo'] }))
  assert.equal(r.satisfied, true)
})

test('weekend home lunches count too', () => {
  const data = makeData({ dishes })
  const results = complement(rule, weekOf(data, { 'sat/lunch': ['pesce'], 'sat/dinner': ['pesce'] }))
  assert.equal(results.length, 1)
  assert.equal(results[0].slot, '2026-10-03/dinner')
})

test('groups outside the rule are ignored', () => {
  const data = makeData({ dishes, canteen: { mon: ['pesce'] } })
  const [r] = complement({ ...rule, params: { groups: ['meat'] } }, weekOf(data, { 'mon/dinner': ['pesce'] }))
  assert.equal(r.satisfied, true)
})
