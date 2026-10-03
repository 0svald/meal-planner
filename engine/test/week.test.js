import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dishGroups, mealGroups, HOME_SLOTS, isComplete, withMeal, planHistory } from '../week.js'
import { dish, makeData, weekOf, makePlan, fullWeek, MONDAY } from './helpers.js'

test('home slots: seven dinners and the weekend lunches', () => {
  assert.equal(HOME_SLOTS.length, 9)
  assert.deepEqual(HOME_SLOTS.filter(s => s.slot === 'lunch').map(s => s.weekday), ['sat', 'sun'])
})

test('dishGroups follows the taxonomy', () => {
  assert.deepEqual([...dishGroups(dish('a', 'second', { proteins: ['red_meat'] }))].sort(), ['meat', 'red_meat'])
  assert.deepEqual([...dishGroups(dish('b', 'second', { proteins: ['shellfish'] }))], ['fish'])
  assert.deepEqual([...dishGroups(dish('c', 'side', { carbs: ['tubers'] }))], ['potatoes'])
  assert.deepEqual([...dishGroups(dish('d', 'single', { tags: ['pizza'], proteins: ['cheese'] }))].sort(), ['cheese', 'pizza'])
  assert.deepEqual([...dishGroups(dish('e', 'first', { proteins: ['legumes'], carbs: ['legumes'] }))], ['legumes'])
})

test('a meal counts once per group', () => {
  const data = makeData({ dishes: [dish('f', 'first', { proteins: ['cheese'] }), dish('s', 'second', { proteins: ['cheese'] })] })
  const week = weekOf(data, { 'mon/dinner': ['f', 's'] })
  const meal = week.meals.find(m => m.slot === 'dinner' && m.weekday === 'mon')
  assert.deepEqual([...mealGroups(meal)], ['cheese'])
})

test('buildWeek: canteen lunches, home slots, plan meals', () => {
  const data = makeData({
    dishes: [dish('p', 'first'), dish('x', 'second'), dish('y', 'side')],
    canteen: { mon: ['p'], tue: ['x', 'y'] }
  })
  const week = weekOf(data, { 'mon/dinner': ['x', 'y'] })
  assert.equal(week.weekStart, MONDAY)
  assert.equal(week.meals.filter(m => m.source === 'canteen').length, 2)
  assert.equal(week.meals.filter(m => m.source === 'home').length, 9)
  const monDinner = week.meals.find(m => m.weekday === 'mon' && m.slot === 'dinner')
  assert.deepEqual(monDinner.dishIds, ['x', 'y'])
  assert.equal(isComplete(week), false)
  assert.equal(isComplete(weekOf(data, fullWeek({}, 'p'))), true)
  const changed = withMeal(week, `${MONDAY}/dinner`, ['p'], new Map(data.dishes.map(d => [d.id, d])))
  assert.deepEqual(changed.meals.find(m => m.weekday === 'mon' && m.slot === 'dinner').dishIds, ['p'])
  assert.deepEqual(monDinner.dishIds, ['x', 'y'], 'withMeal does not modify the input')
})

test('planHistory keeps confirmed plans of earlier weeks', () => {
  const data = makeData({
    dishes: [dish('p', 'first')],
    plans: [
      makePlan({ 'mon/dinner': ['p'] }, { monday: '2026-09-21', status: 'confirmed' }),
      makePlan({ 'tue/dinner': ['p'] }, { monday: '2026-09-14', status: 'draft' }),
      makePlan({ 'wed/dinner': ['p'] }, { monday: MONDAY, status: 'confirmed' })
    ]
  })
  assert.deepEqual(planHistory(data, MONDAY), [{ date: '2026-09-21', slot: 'dinner', dishIds: ['p'] }])
})
