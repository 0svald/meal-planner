import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mealStructure } from '../rules.js'
import { dish, makeData, weekOf } from './helpers.js'

const dishes = [
  dish('primo', 'first'), dish('secondo', 'second'), dish('contorno', 'side'),
  dish('unico', 'single'), dish('pane', 'bread'), dish('sushi', 'takeaway', { cuisine: 'japanese' })
]
const rule = {
  id: 's',
  type: 'meal_structure',
  priority: 'hard',
  params: { slots: ['lunch', 'dinner'], patterns: [['first'], ['second', 'side'], ['single']] }
}

test('allowed patterns, in any order, bread aside', () => {
  const data = makeData({ dishes })
  const week = weekOf(data, {
    'mon/dinner': ['primo'],
    'tue/dinner': ['contorno', 'secondo'],
    'wed/dinner': ['unico', 'pane'],
    'sat/dinner': ['sushi']
  })
  const [r] = mealStructure(rule, week)
  assert.equal(r.satisfied, true)
})

test('two courses are not allowed', () => {
  const data = makeData({ dishes })
  const results = mealStructure(rule, weekOf(data, { 'mon/dinner': ['primo', 'secondo'], 'tue/dinner': ['secondo'] }))
  assert.deepEqual(results.map(r => r.detail), [
    'Composizione non prevista: primo + secondo (cena di lun)',
    'Composizione non prevista: secondo (cena di mar)'
  ])
})

test('slots outside the rule are not checked', () => {
  const data = makeData({ dishes })
  const [r] = mealStructure({ ...rule, params: { ...rule.params, slots: ['dinner'] } }, weekOf(data, { 'sat/lunch': ['primo', 'secondo'] }))
  assert.equal(r.satisfied, true)
})
