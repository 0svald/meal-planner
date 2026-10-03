import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mergeData, addDays } from '../data.js'
import { proposeWeek, candidateMeals, evaluatePlan, slotOptions } from '../planner.js'
import { buildWeek } from '../week.js'

const fixture = name =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8'))
const load = () => mergeData({ catalog: fixture('catalog'), family: fixture('family-data'), plans: fixture('plans') })

// Olbia winter menu, cycle week 1 (fixtures start the cycle on 2025-09-15).
const WEEK1 = '2025-09-15'

test('a proposal for every home slot, no hard rule made worse', () => {
  const data = load()
  const out = proposeWeek({ data, weekStart: WEEK1 })
  assert.equal(out.cycleWeek, 1)
  assert.equal(out.slots.length, 9)
  for (const slot of out.slots) {
    assert.ok(slot.chosen.length > 0, `${slot.key} has a proposal`)
    assert.ok(slot.options.length > 0)
    assert.ok(slot.options[0].reasons.every(r => r.effect === '+' || r.effect === '-'))
  }
  const broken = out.results.filter(r => r.severity === 'hard')
  assert.ok(broken.every(r => r.unavoidable), `only canteen-caused hard breaches: ${broken.map(r => r.detail)}`)
  // The canteen alone already has two red-meat lunches (panada, lasagne).
  assert.deepEqual(broken.map(r => r.ruleId), ['crea-carne-rossa'])
})

test('weekly frequencies within bounds where the canteen allows it', () => {
  const data = load()
  const out = proposeWeek({ data, weekStart: WEEK1 })
  const frequencies = out.results.filter(r => r.type === 'frequency')
  for (const r of frequencies) {
    if (r.unavoidable) continue
    assert.equal(r.satisfied, true, r.detail)
  }
  const soft = out.results.filter(r => r.priority === 'soft' && r.type !== 'frequency')
  assert.ok(soft.every(r => r.satisfied), soft.filter(r => !r.satisfied).map(r => r.detail).join('; '))
})

test('three options per slot, the proposal first, different main dishes', () => {
  const out = proposeWeek({ data: load(), weekStart: WEEK1 })
  const dishes = new Map(load().dishes.map(d => [d.id, d]))
  for (const slot of out.slots) {
    assert.equal(slot.options.length, 3, slot.key)
    assert.deepEqual(slot.options[0].dishIds, slot.chosen.map(d => d.id))
    const mains = slot.options.map(o => o.dishIds.filter(id => dishes.get(id).course !== 'side').join('+'))
    assert.equal(new Set(mains).size, 3, `${slot.key}: ${mains}`)
  }
})

test('deterministic for the same seed', () => {
  const a = proposeWeek({ data: load(), weekStart: WEEK1, seed: 7 })
  const b = proposeWeek({ data: load(), weekStart: WEEK1, seed: 7 })
  assert.deepEqual(a, b)
})

test('takeaway is offered at weekend dinners, never imposed', () => {
  const out = proposeWeek({ data: load(), weekStart: WEEK1 })
  for (const slot of out.slots) {
    const offered = slot.options.some(o => o.dishes.some(d => d.course === 'takeaway'))
    assert.equal(offered, slot.slot === 'dinner' && ['sat', 'sun'].includes(slot.weekday), slot.key)
    assert.ok(slot.chosen.every(d => d.course !== 'takeaway'), slot.key)
  }
})

test('candidates follow the meal structure; takeaway only where allowed', () => {
  const data = load()
  const week = buildWeek(data, WEEK1)
  const monDinner = week.meals.find(m => m.weekday === 'mon' && m.slot === 'dinner')
  const satDinner = week.meals.find(m => m.weekday === 'sat' && m.slot === 'dinner')
  const course = id => data.dishes.find(d => d.id === id).course
  const shapes = new Set(candidateMeals(data, monDinner).map(c => c.map(course).join('+')))
  assert.deepEqual([...shapes].sort(), ['first', 'second+side', 'single'])
  assert.ok(candidateMeals(data, satDinner).some(c => c.length === 1 && course(c[0]) === 'takeaway'))
})

test('meals already in the plan are kept', () => {
  const data = load()
  const plan = { week_start: WEEK1, status: 'draft', meals: [{ date: addDays(WEEK1, 1), slot: 'dinner', dish_ids: ['pasta-pomodoro'] }] }
  const out = proposeWeek({ data, weekStart: WEEK1, plan })
  const tue = out.slots.find(s => s.weekday === 'tue')
  assert.equal(tue.fixed, true)
  assert.deepEqual(tue.chosen.map(d => d.id), ['pasta-pomodoro'])
})

test('a confirmed earlier week steers variety', () => {
  const data = load()
  const first = proposeWeek({ data, weekStart: WEEK1 })
  data.plans = [{ ...first.plan, status: 'confirmed' }]
  const nextMonday = addDays(WEEK1, 7)
  const varietyPenalty = out => out.results.filter(r => r.type === 'variety').reduce((s, r) => s + r.penalty, 0)
  // Repeating last week's meals as they were...
  const repeated = {
    week_start: nextMonday,
    status: 'draft',
    meals: first.plan.meals.map(m => ({ ...m, date: addDays(m.date, 7) }))
  }
  const same = proposeWeek({ data, weekStart: nextMonday, plan: repeated })
  // ...costs more than what the planner proposes.
  const proposed = proposeWeek({ data, weekStart: nextMonday })
  assert.ok(varietyPenalty(same) > 0)
  assert.ok(varietyPenalty(proposed) < varietyPenalty(same))
})

test('the proposed plan carries its ISO week id', () => {
  const out = proposeWeek({ data: load(), weekStart: WEEK1, withOptions: false })
  assert.equal(out.plan.id, '2025-w38')
  assert.equal(out.slots[0].options, undefined)
})

test('evaluatePlan judges a hand-made week and flags the canteen breaches', () => {
  const data = load()
  const plan = {
    week_start: WEEK1,
    status: 'draft',
    meals: [
      { date: WEEK1, slot: 'dinner', dish_ids: ['lasagne-forno'] },
      { date: addDays(WEEK1, 1), slot: 'dinner', dish_ids: ['frittata', 'insalata-verde'] }
    ]
  }
  const { results } = evaluatePlan({ data, weekStart: WEEK1, plan })
  const byId = id => results.filter(r => r.ruleId === id)
  // Monday: lasagne (red meat, 75 minutes) after a red-meat canteen lunch.
  assert.ok(byId('tempo-feriali').some(r => !r.satisfied && r.slot === `${WEEK1}/dinner`))
  assert.ok(byId('complemento-pranzo').some(r => !r.satisfied && r.slot === `${WEEK1}/dinner`))
  const redMeat = byId('crea-carne-rossa')[0]
  assert.equal(redMeat.satisfied, false)
  assert.equal(redMeat.unavoidable, undefined, 'the third red meat is the family choice')
  // Tuesday: eggs at the canteen lunch and at dinner.
  assert.ok(byId('complemento-pranzo').some(r => r.slot === `${addDays(WEEK1, 1)}/dinner`))
  const legumes = byId('crea-legumi')[0]
  assert.equal(legumes.severity, 'pending')
})

test('slotOptions: current meal first, then allowed alternatives', () => {
  const data = load()
  const key = `${addDays(WEEK1, 3)}/dinner`
  const plan = { week_start: WEEK1, status: 'draft', meals: [{ date: addDays(WEEK1, 3), slot: 'dinner', dish_ids: ['pasta-pomodoro'] }] }
  const out = slotOptions({ data, weekStart: WEEK1, plan, key })
  assert.deepEqual(out.current.map(d => d.id), ['pasta-pomodoro'])
  assert.equal(out.options.length, 3)
  assert.deepEqual(out.options[0].dishIds, ['pasta-pomodoro'])
  const more = slotOptions({ data, weekStart: WEEK1, plan, key, limit: 10 })
  assert.ok(more.options.length > 3)
  assert.throws(() => slotOptions({ data, weekStart: WEEK1, key: `${WEEK1}/lunch` }), /Unknown home slot/)
})
