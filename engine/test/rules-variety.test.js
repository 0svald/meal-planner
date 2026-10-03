import { test } from 'node:test'
import assert from 'node:assert/strict'
import { variety } from '../rules.js'
import { dish, makeData, weekOf, ctxOf } from './helpers.js'

const dishes = [dish('lasagne', 'first'), dish('insalata', 'side'), dish('pollo', 'second')]
const rule = { id: 'v', type: 'variety', priority: 'soft', params: { min_days_between_repeats: 14 } }

test('a dish repeated within the week', () => {
  const data = makeData({ dishes })
  const results = variety(rule, weekOf(data, { 'mon/dinner': ['lasagne'], 'thu/dinner': ['lasagne'] }), ctxOf(data))
  assert.equal(results.length, 1)
  assert.equal(results[0].slot, '2026-10-01/dinner')
  assert.equal(results[0].detail, 'lasagne ripetuto a 3 giorni di distanza (cena di lun e cena di gio)')
  assert.equal(results[0].penalty, Math.ceil(10 * 11 / 14))
})

test('confirmed plans of earlier weeks count', () => {
  const data = makeData({ dishes })
  const history = [{ date: '2026-09-20', slot: 'dinner', dishIds: ['pollo'] }]
  const [r] = variety(rule, weekOf(data, { 'mon/dinner': ['pollo', 'insalata'] }), ctxOf(data, history))
  assert.equal(r.satisfied, false)
  assert.match(r.detail, /8 giorni di distanza \(20\/9 e cena di lun\)/)
})

test('sides may repeat, old dishes are fine', () => {
  const data = makeData({ dishes })
  const history = [{ date: '2026-09-01', slot: 'dinner', dishIds: ['lasagne'] }]
  const week = weekOf(data, { 'mon/dinner': ['pollo', 'insalata'], 'tue/dinner': ['lasagne'], 'thu/dinner': ['insalata'] })
  const [r] = variety(rule, week, ctxOf(data, history))
  assert.equal(r.satisfied, true)
})
