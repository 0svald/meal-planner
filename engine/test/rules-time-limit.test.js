import { test } from 'node:test'
import assert from 'node:assert/strict'
import { timeLimit } from '../rules.js'
import { dish, makeData, weekOf } from './helpers.js'

const dishes = [
  dish('arrosto', 'second', { prep: 40 }),
  dish('insalata', 'side', { prep: 10 }),
  dish('veloce', 'first', { prep: 20 }),
  dish('panada', 'single', { prep: null }),
  dish('sushi', 'takeaway', { prep: null, cuisine: 'japanese' })
]
const rule = { id: 't', type: 'time_limit', priority: 'hard', params: { max_prep_minutes: 45, days: ['mon', 'tue', 'wed', 'thu', 'fri'] } }

test('the prep times of a meal add up', () => {
  const data = makeData({ dishes })
  const [r] = timeLimit(rule, weekOf(data, { 'mon/dinner': ['arrosto', 'insalata'], 'tue/dinner': ['veloce'] }))
  assert.equal(r.satisfied, false)
  assert.equal(r.slot, '2026-09-28/dinner')
  assert.equal(r.detail, 'Preparazione 50 minuti, massimo 45 (cena di lun)')
})

test('an unknown prep time fails on the listed days only', () => {
  const data = makeData({ dishes })
  const results = timeLimit(rule, weekOf(data, { 'wed/dinner': ['panada'], 'sat/dinner': ['panada'] }))
  assert.equal(results.length, 1)
  assert.equal(results[0].slot, '2026-09-30/dinner')
})

test('takeaway needs no preparation', () => {
  const data = makeData({ dishes })
  const [r] = timeLimit(rule, weekOf(data, { 'fri/dinner': ['sushi'] }))
  assert.equal(r.satisfied, true)
})
