import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  addDays, weekdayOf, mondayOf, dayNumber, mergeData, applyDefaults,
  activeMenu, cycleWeek, canteenWeek
} from '../data.js'

const fixture = name =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8'))

const load = () => mergeData({
  catalog: fixture('catalog'),
  family: fixture('family-data'),
  plans: fixture('plans')
})

test('date helpers', () => {
  assert.equal(weekdayOf('2026-10-03'), 'sat')
  assert.equal(weekdayOf('1970-01-01'), 'thu')
  assert.equal(mondayOf('2026-10-04'), '2026-09-28')
  assert.equal(mondayOf('2026-09-28'), '2026-09-28')
  assert.equal(addDays('2026-03-28', 2), '2026-03-30') // across DST
  assert.equal(addDays('2024-02-28', 1), '2024-02-29')
  assert.throws(() => dayNumber('2026-02-30'))
  assert.throws(() => dayNumber('3/10/2026'))
})

test('mergeData takes each key from its file', () => {
  const data = load()
  assert.equal(data.dishes.length, 20)
  assert.equal(data.school_menus.length, 1)
  assert.equal(data.rules.length, 15)
  assert.deepEqual(data.plans, [])
  assert.ok(data.pantry.includes('sale'))
  assert.equal(data.family.adults, 2)
})

test('mergeData falls back to plans in family-data.json', () => {
  const plan = { id: '2026-w40', week_start: '2026-09-28', status: 'draft', meals: [] }
  const family = { ...fixture('family-data'), plans: [plan] }
  assert.deepEqual(mergeData({ catalog: fixture('catalog'), family }).plans, [plan])
  const fromFile = mergeData({ catalog: fixture('catalog'), family, plans: { plans: [] } })
  assert.deepEqual(fromFile.plans, [])
})

test('applyDefaults fills omitted keys', () => {
  const data = applyDefaults({
    dishes: [{ id: 'x', name: 'X', course: 'side', nutrition: { confidence: 'high' } }],
    school_menus: [{
      id: 'm',
      active: true,
      weeks: [{ week: 1, days: [{ weekday: 'mon', items: [{ course: 'side', options: ['x'] }] }] }]
    }]
  })
  const dish = data.dishes[0]
  assert.deepEqual(dish.allergens, [])
  assert.deepEqual(dish.aliases, [])
  assert.equal(dish.verified, false)
  assert.equal(dish.cookable_at_home, true)
  assert.deepEqual(dish.nutrition.vegetables, { present: false })
  assert.deepEqual(dish.nutrition.proteins, [])
  assert.equal(data.school_menus[0].weeks[0].days[0].items[0].portion, 1)
  assert.equal(data.school_menus[0].cycle_start_date, null)
})

test('cycleWeek rotates and handles dates before the start', () => {
  const menu = { cycle_start_date: '2025-09-15', weeks: [{}, {}, {}, {}] }
  assert.equal(cycleWeek(menu, '2025-09-15'), 1)
  assert.equal(cycleWeek(menu, '2025-09-21'), 1) // Sunday, same week
  assert.equal(cycleWeek(menu, '2025-09-22'), 2)
  assert.equal(cycleWeek(menu, '2025-10-13'), 1) // 4 weeks later
  assert.equal(cycleWeek(menu, '2025-09-08'), 4) // the week before
  assert.equal(cycleWeek({ ...menu, cycle_start_date: null }, '2025-09-15'), null)
})

test('canteenWeek returns the five school days with dishes', () => {
  const week = canteenWeek(load(), '2026-10-01')
  assert.equal(week.menuId, 'olbia-inverno-2025-26')
  assert.equal(week.weekStart, '2026-09-28')
  assert.equal(week.cycleWeek, 1)
  assert.equal(week.cycleWeekKnown, true)
  assert.deepEqual(week.days.map(d => d.weekday), ['mon', 'tue', 'wed', 'thu', 'fri'])
  assert.equal(week.days[4].date, '2026-10-02')
  const tue = week.days[1]
  const second = tue.items.find(i => i.course === 'second')
  assert.deepEqual(second.options.map(d => d.id), ['uovo-sodo', 'frittata', 'uova-strapazzate'])
  const wed = week.days[2].items.find(i => i.course === 'second')
  assert.equal(wed.portion, 0.5)
  assert.equal(wed.options[0].name.length > 0, true)
})

test('canteenWeek without a start date uses the fallback week', () => {
  const data = load()
  data.school_menus = data.school_menus.map(m => ({ ...m, cycle_start_date: null }))
  const week = canteenWeek(data, '2026-10-01')
  assert.equal(week.cycleWeek, 1)
  assert.equal(week.cycleWeekKnown, false)
})

test('canteenWeek marks unknown dish ids and empty weeks', () => {
  const data = load()
  data.school_menus[0].weeks.push({ week: 2, days: [] })
  data.school_menus[0].weeks[0].days[0].items[0].options = ['nope']
  const w1 = canteenWeek(data, '2025-09-15')
  assert.equal(w1.days[0].items[0].options[0].missing, true)
  const w2 = canteenWeek(data, '2025-09-22')
  assert.equal(w2.cycleWeek, 2)
  assert.deepEqual(w2.days[0].items, [])
})

test('no active menu', () => {
  const data = load()
  data.school_menus = data.school_menus.map(m => ({ ...m, active: false }))
  assert.equal(activeMenu(data), null)
  assert.equal(canteenWeek(data, '2026-10-01'), null)
})
