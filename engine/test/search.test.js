import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mergeData } from '../data.js'
import { searchDishes, normalizeText, activeFilterCount } from '../search.js'

const fixture = name =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8'))
const dishes = mergeData({ catalog: fixture('catalog'), family: fixture('family-data') }).dishes
const ids = filters => searchDishes(dishes, filters).map(d => d.id)

test('no filters returns every dish, sorted by name', () => {
  const all = searchDishes(dishes)
  assert.equal(all.length, dishes.length)
  assert.deepEqual(all.map(d => d.name), [...all.map(d => d.name)].sort((a, b) => a.localeCompare(b, 'it')))
})

test('text matches name, ingredients and every word, ignoring case and accents', () => {
  assert.equal(normalizeText('Purè di PATATE'), 'pure di patate')
  assert.deepEqual(ids({ text: 'LENTICCHIE' }), ['pasta-lenticchie'])
  assert.ok(ids({ text: 'besciamella' }).includes('lasagne-forno'), 'ingredient name')
  assert.deepEqual(ids({ text: 'pasta pomodoro' }), ['pasta-pomodoro'])
  assert.deepEqual(ids({ text: 'nessunpiatto' }), [])
})

test('course, protein and carbohydrate filters', () => {
  assert.ok(ids({ course: 'second' }).every(id => dishes.find(d => d.id === id).course === 'second'))
  assert.deepEqual(ids({ protein: 'fish' }).sort(), ['bastoncini-merluzzo', 'sushi-asporto'])
  assert.ok(ids({ protein: 'none' }).includes('insalata-verde'))
  assert.ok(!ids({ protein: 'none' }).includes('frittata'))
  assert.ok(ids({ carb: 'tubers' }).includes('gnocchi-pomodoro'))
  assert.ok(ids({ carb: 'none' }).includes('uovo-sodo'))
})

test('vegetables: any, none, raw, cooked', () => {
  assert.ok(ids({ vegetables: 'raw' }).includes('insalata-verde'))
  assert.ok(!ids({ vegetables: 'raw' }).includes('carote-vapore'))
  assert.ok(ids({ vegetables: 'cooked' }).includes('carote-vapore'))
  assert.ok(ids({ vegetables: 'none' }).includes('uovo-sodo'))
  assert.ok(!ids({ vegetables: 'any' }).includes('uovo-sodo'))
})

test('without allergens, maximum time, origin and status', () => {
  const noGlutenNoMilk = ids({ without: ['gluten', 'milk'] })
  assert.ok(noGlutenNoMilk.includes('uovo-sodo'))
  assert.ok(!noGlutenNoMilk.includes('frittata') && !noGlutenNoMilk.includes('pasta-pomodoro'))
  const quick = ids({ max_minutes: 15 })
  assert.ok(quick.includes('frittata') && !quick.includes('lasagne-forno'))
  assert.ok(!quick.includes('sushi-asporto'), 'no time given: left out')
  assert.deepEqual(ids({ origin: 'home' }), ['pasta-lenticchie'])
  assert.deepEqual(ids({ origin: 'takeaway' }), ['sushi-asporto'])
  assert.equal(ids({ status: 'unverified' }).length, dishes.length)
  assert.deepEqual(ids({ status: 'edited' }), [])
  assert.deepEqual(ids({ course: 'first', protein: 'legumes', max_minutes: 45 }), ['zuppa-legumi-pasta'])
})

test('activeFilterCount ignores the text and counts each allergen', () => {
  assert.equal(activeFilterCount({}), 0)
  assert.equal(activeFilterCount({ text: 'pasta', course: 'first', without: ['gluten', 'milk'] }), 3)
})
