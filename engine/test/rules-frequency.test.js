import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frequency } from '../rules.js'
import { dish, makeData, weekOf, fullWeek } from './helpers.js'

const dishes = [
  dish('legumi', 'first', { proteins: ['legumes'], carbs: ['legumes'] }),
  dish('pesce', 'second', { proteins: ['fish'] }),
  dish('pasta', 'first')
]
const rule = (params, priority = 'soft') => ({ id: 'f', type: 'frequency', priority, params: { applies_to: 'children', ...params } })

test('counts canteen lunches and home meals', () => {
  const data = makeData({ dishes, canteen: { mon: ['legumi'], tue: ['legumi'] } })
  const [r] = frequency(rule({ group: 'legumes', min: 3, target: 3 }), weekOf(data, { 'wed/dinner': ['legumi'] }))
  assert.equal(r.detail, 'Legumi 3 su 3')
  assert.equal(r.satisfied, true)
  assert.equal(r.penalty, 0)
})

test('a missing minimum is pending while the week is incomplete', () => {
  const data = makeData({ dishes, canteen: { mon: ['legumi'] } })
  const [partial] = frequency(rule({ group: 'legumes', min: 3, target: 3 }), weekOf(data))
  assert.equal(partial.satisfied, false)
  assert.equal(partial.severity, 'pending')
  const [complete] = frequency(rule({ group: 'legumes', min: 3, target: 3 }), weekOf(data, fullWeek({}, 'pasta')))
  assert.equal(complete.severity, 'soft')
  assert.equal(complete.penalty, 2 * 10 + 2 * 1)
})

test('over the maximum breaks a hard rule', () => {
  const data = makeData({ dishes, canteen: { mon: ['pesce'] } })
  const [r] = frequency(rule({ group: 'fish', max: 1 }, 'hard'), weekOf(data, { 'tue/dinner': ['pesce'] }))
  assert.equal(r.satisfied, false)
  assert.equal(r.severity, 'hard')
  assert.equal(r.penalty, 10)
  assert.equal(r.detail, 'Pesce 2 (massimo 1)')
})

test('target misses cost less than bounds and keep the rule satisfied', () => {
  const data = makeData({ dishes })
  const [r] = frequency(rule({ group: 'fish', target: 2, max: 3 }), weekOf(data, fullWeek({ 'mon/dinner': ['pesce'] }, 'pasta')))
  assert.equal(r.satisfied, true)
  assert.equal(r.penalty, 1)
})

test('adults do not eat at the canteen', () => {
  const data = makeData({ dishes, canteen: { mon: ['pesce'] } })
  const [r] = frequency(rule({ group: 'fish', applies_to: 'adults', target: 1 }), weekOf(data))
  assert.equal(r.detail, 'Pesce 0 su 1')
})
