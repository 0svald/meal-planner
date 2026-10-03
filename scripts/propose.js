#!/usr/bin/env node
// Print the proposals for a week, in Italian.
//
//   node scripts/propose.js [--data DIR] [--week YYYY-MM-DD] [--seed N] [--limit N] [--json]
//
// DIR holds catalog.json, family-data.json and optionally plans.json
// (default: fixtures/). --week is any day of the week (default: the Monday of
// the first canteen cycle week). The skill can call this to share the app's rules.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mergeData, activeMenu, addDays } from '../engine/data.js'
import { proposeWeek } from '../engine/planner.js'

const DAY = { mon: 'lun', tue: 'mar', wed: 'mer', thu: 'gio', fri: 'ven', sat: 'sab', sun: 'dom' }
const SLOT = { lunch: 'pranzo', dinner: 'cena' }

function parseArgs (argv) {
  const args = { data: 'fixtures', week: null, seed: 0, limit: 3, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '--data') args.data = argv[++i]
    else if (a === '--week') args.week = argv[++i]
    else if (a === '--seed') args.seed = Number(argv[++i])
    else if (a === '--limit') args.limit = Number(argv[++i])
    else throw new Error(`Unknown argument: ${a}`)
  }
  return args
}

function readJson (path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

const args = parseArgs(process.argv.slice(2))
const data = mergeData({
  catalog: readJson(join(args.data, 'catalog.json')) || {},
  family: readJson(join(args.data, 'family-data.json')) || {},
  plans: readJson(join(args.data, 'plans.json'))
})
const menu = activeMenu(data)
const week = args.week || (menu && menu.cycle_start_date) || '2026-01-05'
const out = proposeWeek({ data, weekStart: week, seed: args.seed, limit: args.limit })

if (args.json) {
  console.log(JSON.stringify(out, null, 2))
} else {
  const names = dishes => dishes.map(d => d.name).join(' + ') || '—'
  console.log(`Settimana dal ${out.weekStart} al ${addDays(out.weekStart, 6)}` +
    (out.cycleWeek ? ` · mensa settimana ${out.cycleWeek}` : '') + ` · seed ${out.seed}`)
  for (const s of out.slots) {
    console.log(`\n${DAY[s.weekday]} ${s.date.slice(8)} ${SLOT[s.slot]}: ${names(s.chosen)}` +
      `  (${s.candidateCount} possibili)`)
    s.options.forEach((c, i) => {
      const why = c.reasons.map(r => `${r.effect} ${r.detail}`).join('; ')
      console.log(`   ${i + 1}. ${names(c.dishes)}  [${c.score}]${why ? '  ' + why : ''}`)
    })
  }
  console.log('\nRegole:')
  for (const r of out.results) {
    const mark = r.severity === 'ok' ? '✓' : r.unavoidable ? '!' : r.severity === 'hard' ? '✗' : '·'
    console.log(`  ${mark} ${r.detail}${r.unavoidable ? ' — già dalla mensa' : ''}`)
  }
}
