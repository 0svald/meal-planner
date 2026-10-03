import { test } from 'node:test'
import assert from 'node:assert/strict'
import { takeaway } from '../rules.js'
import { dish, makeData, weekOf, ctxOf, fullWeek } from './helpers.js'

const dishes = [
  dish('pizza', 'takeaway', { cuisine: 'pizza', tags: ['pizza'] }),
  dish('sushi', 'takeaway', { cuisine: 'japanese' }),
  dish('pasta', 'first')
]
const rule = {
  id: 'a',
  type: 'takeaway',
  priority: 'soft',
  params: { per_week: 1, days: ['sat', 'sun'], slot: 'dinner', rotate_cuisines: ['pizza', 'chinese', 'japanese'] }
}

test('one takeaway at the weekend', () => {
  const data = makeData({ dishes })
  const [r] = takeaway(rule, weekOf(data, { 'sat/dinner': ['pizza'] }), ctxOf(data))
  assert.equal(r.satisfied, true)
  assert.equal(r.detail, 'Asporto 1 (al massimo 1)')
})

test('takeaway is optional', () => {
  const data = makeData({ dishes })
  const [r] = takeaway(rule, weekOf(data, fullWeek({}, 'pasta')), ctxOf(data))
  assert.equal(r.satisfied, true)
  assert.equal(r.penalty, 0)
})

test('wrong day and too many', () => {
  const data = makeData({ dishes })
  const results = takeaway(rule, weekOf(data, { 'wed/dinner': ['pizza'], 'sun/dinner': ['sushi'] }), ctxOf(data))
  assert.deepEqual(results.map(r => r.detail), ['Asporto fuori dai giorni previsti (cena di mer)', 'Asporto 2 volte, al massimo 1'])
})

test('cuisines rotate after the last confirmed takeaway', () => {
  const data = makeData({ dishes })
  const history = [{ date: '2026-09-26', slot: 'dinner', dishIds: ['pizza'] }]
  const [r] = takeaway(rule, weekOf(data, { 'sat/dinner': ['pizza'] }), ctxOf(data, history))
  assert.equal(r.satisfied, false)
  assert.equal(r.detail, 'Questa settimana tocca alla cucina cinese')
  const afterChinese = [{ date: '2026-09-26', slot: 'dinner', dishIds: ['sushi'] }]
  const [ok] = takeaway(rule, weekOf(data, { 'sat/dinner': ['pizza'] }), ctxOf(data, afterChinese))
  assert.equal(ok.satisfied, true, 'after japanese comes pizza')
})
