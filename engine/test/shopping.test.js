import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyDefaults, mergeData } from '../data.js'
import { shoppingList, shoppingText, quantityNote, usesNote, normalize } from '../shopping.js'
import { proposeWeek } from '../planner.js'

const ing = (name, aisle, qty, unit) => ({ name, aisle, ...(qty !== undefined ? { qty, unit } : {}) })

const data = applyDefaults({
  dishes: [
    { id: 'pasta-lenticchie', name: 'Pasta e lenticchie', course: 'single', ingredients: [ing('Pasta', 'pantry', 320, 'g'), ing('lenticchie', 'pantry', 250, 'g'), ing('Sale grosso', 'pantry'), ing('cipolla', 'produce')] },
    { id: 'pasta-pomodoro', name: 'Pasta al pomodoro', course: 'first', ingredients: [ing('pasta', 'pantry'), ing('passata di pomodoro', 'pantry'), ing("olio extravergine d'oliva", 'pantry')] },
    { id: 'pollo', name: 'Pollo arrosto', course: 'second', ingredients: [ing('cosce di pollo', 'meat', 4), ing('Cipolla ', 'produce')] },
    { id: 'insalata', name: 'Insalata', course: 'side', ingredients: [ing('lattuga', 'produce'), ing('ricotta salata', 'formaggi')] },
    { id: 'sushi', name: 'Sushi (asporto)', course: 'takeaway', ingredients: [ing('riso', 'pantry')] }
  ],
  pantry: ["olio extravergine d'oliva", 'sale', 'pepe']
})

const plan = {
  week_start: '2026-10-05',
  status: 'confirmed',
  meals: [
    { date: '2026-10-10', slot: 'lunch', dish_ids: ['pasta-pomodoro'] },
    { date: '2026-10-05', slot: 'dinner', dish_ids: ['pasta-lenticchie'] },
    { date: '2026-10-06', slot: 'dinner', dish_ids: ['pollo', 'insalata'] },
    { date: '2026-10-10', slot: 'dinner', dish_ids: ['sushi'] },
    { date: '2026-10-11', slot: 'dinner', dish_ids: ['ghost'] }
  ]
}

test('ingredients merged by name, grouped by aisle in store order', () => {
  const list = shoppingList({ data, plan })
  assert.deepEqual(list.aisles.map(a => a.aisle), ['produce', 'meat', 'pantry', 'other'])
  const produce = list.aisles[0].items
  assert.deepEqual(produce.map(i => i.key), ['cipolla', 'lattuga'])
  assert.equal(produce[0].uses.length, 2, 'cipolla from two dishes, one item')
  const pasta = list.items.find(i => i.key === 'pasta')
  assert.equal(pasta.name, 'Pasta', 'the first spelling met is kept')
  assert.equal(pasta.uses.length, 2)
})

test('pantry staples, takeaway and unknown dishes are left out', () => {
  const list = shoppingList({ data, plan })
  const keys = list.items.map(i => i.key)
  assert.ok(!keys.includes('sale grosso'), 'starts with a pantry item')
  assert.ok(!keys.includes("olio extravergine d'oliva"))
  assert.ok(!keys.includes('riso'), 'takeaway sushi is bought ready')
  assert.deepEqual(list.skipped.pantry, ["olio extravergine d'oliva", 'sale grosso'])
  assert.deepEqual(list.skipped.takeaway, ['Sushi (asporto)'])
  assert.deepEqual(list.skipped.missing, ['ghost'])
})

test('an unknown aisle goes to "Altro"', () => {
  const list = shoppingList({ data, plan })
  assert.deepEqual(list.aisles.at(-1).items.map(i => i.key), ['ricotta salata'])
})

test('quantities are repeated as stated, never summed', () => {
  const list = shoppingList({ data, plan })
  const find = key => list.items.find(i => i.key === key)
  assert.equal(quantityNote(find('pasta')), '320 g per Pasta e lenticchie')
  assert.equal(quantityNote(find('lenticchie')), '250 g')
  assert.equal(quantityNote(find('cosce di pollo')), '4')
  assert.equal(quantityNote(find('lattuga')), '')
  assert.equal(usesNote(find('pasta')), 'lun cena, sab pranzo')
})

test('shareable text: one item per line, aisles as headings, ticked items left out', () => {
  const list = shoppingList({ data, plan })
  const text = shoppingText(list, { exclude: ['lattuga'] })
  assert.equal(text, [
    'Spesa settimana 5/10 – 11/10',
    '',
    'FRUTTA E VERDURA',
    '- cipolla',
    '',
    'CARNE',
    '- cosce di pollo: 4',
    '',
    'DISPENSA',
    '- lenticchie: 250 g',
    '- passata di pomodoro',
    '- Pasta: 320 g per Pasta e lenticchie',
    '',
    'ALTRO',
    '- ricotta salata'
  ].join('\n'))
})

test('normalize ignores case, spaces and accents', () => {
  assert.equal(normalize('  Caffè   Macinato '), 'caffe macinato')
})

test('a proposed fixture week gives a non-empty list without staples', () => {
  const fixture = name => JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8'))
  const real = mergeData({ catalog: fixture('catalog'), family: fixture('family-data') })
  const { plan: proposed } = proposeWeek({ data: real, weekStart: '2025-09-15', withOptions: false })
  const list = shoppingList({ data: real, plan: proposed })
  assert.ok(list.items.length > 5)
  for (const staple of real.pantry) assert.ok(!list.items.some(i => i.key === normalize(staple)))
})
