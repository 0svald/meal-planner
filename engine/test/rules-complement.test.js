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

const nextDay = { ...rule, id: 'n', params: { ...rule.params, when: 'next_day', same_dish: true } }

test('next_day: dinner is not like the next lunch', () => {
  const data = makeData({ dishes, canteen: { tue: ['pesce'] } })
  const [r] = complement(nextDay, weekOf(data, { 'mon/dinner': ['pesce'] }))
  assert.equal(r.satisfied, false)
  assert.equal(r.slot, '2026-09-28/dinner')
  assert.equal(r.detail, 'pesce a cena lun e a pranzo mar')
})

test('next_day: the same dish counts as alike, a side does not', () => {
  const extra = [...dishes, dish('insalata', 'side')]
  const data = makeData({ dishes: extra, canteen: { wed: ['pasta', 'insalata'] } })
  const [r] = complement(nextDay, weekOf(data, { 'tue/dinner': ['pasta'] }))
  assert.equal(r.detail, 'pasta a cena mar e a pranzo mer')
  const [ok] = complement(nextDay, weekOf(data, { 'tue/dinner': ['pollo', 'insalata'] }))
  assert.equal(ok.satisfied, true)
})

test('next_day: Friday dinner and the Saturday home lunch', () => {
  const data = makeData({ dishes })
  const [r] = complement(nextDay, weekOf(data, { 'fri/dinner': ['manzo'], 'sat/lunch': ['pollo'] }))
  assert.equal(r.detail, 'carne a cena ven e a pranzo sab')
})

test('next_day: Sunday dinner and the next Monday canteen lunch', () => {
  const data = makeData({ dishes, canteen: { mon: ['pollo'] } })
  const week = weekOf(data, { 'sun/dinner': ['manzo'] })
  assert.deepEqual(week.nextMondayLunch.dishIds, ['pollo'], 'one-week menu: next Monday is the same menu day')
  const results = complement(nextDay, week)
  assert.deepEqual(results.map(r => r.slot), ['2026-10-04/dinner'])
})

test('same_day is the default and ignores the next day', () => {
  const data = makeData({ dishes, canteen: { tue: ['pesce'] } })
  const [r] = complement(rule, weekOf(data, { 'mon/dinner': ['pesce'] }))
  assert.equal(r.satisfied, true)
})
