import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadScript, token } from './fake-google.js'

const catalog = { schema_version: '1.0', dishes: [{ id: 'pasta' }, { id: 'pollo' }, { id: 'insalata' }], school_menus: [] }
const family = { schema_version: '1.0', family: {}, rules: [], pantry: [] }
const tokens = { MAMMA: token('mamma@example.com'), PAPA: token('papa@example.com'), ZIO: token('zio@example.com') }

const plan = (meals = [{ date: '2026-10-05', slot: 'dinner', dish_ids: ['pasta'] }]) =>
  ({ id: '2026-w41', week_start: '2026-10-05', status: 'draft', cycle_week: 2, meals })

const setup = () => loadScript({ files: { 'catalog.json': catalog, 'family-data.json': family }, tokens })

test('doGet: no token, unknown token, account not allowed', () => {
  const s = setup()
  assert.equal(s.get({ resource: 'all' }).status, 401)
  assert.equal(s.get({ resource: 'all', id_token: 'NOPE' }).error, 'invalid_token')
  const refused = s.get({ resource: 'all', id_token: 'ZIO' })
  assert.equal(refused.status, 403)
  assert.equal(refused.email, 'zio@example.com')
})

test('doGet: all resources, plans empty until the first save', () => {
  const out = setup().get({ resource: 'all', id_token: 'MAMMA' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.resources.catalog.data, catalog)
  assert.deepEqual(out.resources.plans.data.plans, [])
  assert.equal(out.resources.plans.updated_at, null)
})

test('savePlan creates plans.json and records who saved', () => {
  const s = setup()
  const out = s.post({ id_token: 'MAMMA', action: 'savePlan', plan: plan(), base_updated_at: null })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.data.updated_by, 'mamma@example.com')
  assert.equal(out.data.plans.length, 1)
  assert.equal(out.data.plans[0].updated_by, 'mamma@example.com')
  assert.deepEqual(s.fileNames(), ['catalog.json', 'family-data.json', 'plans.json'])
  const read = s.get({ resource: 'plans', id_token: 'PAPA' })
  assert.equal(read.data.updated_at, out.updated_at)
})

test('a stale save is refused with 409, then succeeds with the new base', () => {
  const s = setup()
  const first = s.post({ id_token: 'MAMMA', action: 'savePlan', plan: plan(), base_updated_at: null })
  const stale = s.post({ id_token: 'PAPA', action: 'savePlan', plan: plan(), base_updated_at: null })
  assert.equal(stale.status, 409)
  assert.equal(stale.updated_by, 'mamma@example.com')
  assert.equal(stale.updated_at, first.updated_at)
  const second = s.post({
    id_token: 'PAPA',
    action: 'savePlan',
    plan: { ...plan([{ date: '2026-10-06', slot: 'dinner', dish_ids: ['pollo', 'insalata'] }]), status: 'confirmed' },
    base_updated_at: stale.updated_at
  })
  assert.equal(second.ok, true)
  assert.equal(second.data.plans.length, 1, 'the plan of the same week is replaced')
  assert.equal(second.data.plans[0].status, 'confirmed')
})

test('every save archives the previous plans.json; the skill files are never touched', () => {
  const s = setup()
  const a = s.post({ id_token: 'MAMMA', action: 'savePlan', plan: plan(), base_updated_at: null })
  const other = { ...plan(), id: '2026-w42', week_start: '2026-10-12', meals: [] }
  const b = s.post({ id_token: 'MAMMA', action: 'savePlan', plan: other, base_updated_at: a.updated_at })
  assert.equal(b.ok, true)
  assert.deepEqual(b.data.plans.map(p => p.week_start), ['2026-10-05', '2026-10-12'])
  assert.deepEqual(s.fileNames(), ['catalog.json', 'family-data.json', 'plans.json'])
  const archived = s.fileNames(s.archive())
  assert.equal(archived.length, 1)
  assert.match(archived[0], /^plans-\d{8}-\d{4}\.json$/)
  const files = s.drive.files.filter(f => f.name === 'catalog.json' || f.name === 'family-data.json')
  assert.equal(files.length, 2)
})

test('invalid plans are refused with the reasons', () => {
  const s = setup()
  const bad = s.post({
    id_token: 'MAMMA',
    action: 'savePlan',
    base_updated_at: null,
    plan: {
      id: 'week 41',
      week_start: '2026-10-06',
      status: 'done',
      meals: [
        { date: '2026-10-20', slot: 'brunch', dish_ids: ['pizza'] },
        { date: '2026-10-07', slot: 'dinner', dish_ids: [] }
      ]
    }
  })
  assert.equal(bad.status, 422)
  for (const text of ['Monday', 'id must', 'status', 'outside the week', 'lunch or dinner', 'unknown dish pizza', 'non-empty']) {
    assert.ok(bad.message.includes(text), `${text} in ${bad.message}`)
  }
  assert.deepEqual(s.fileNames(), ['catalog.json', 'family-data.json'])
})

test('doPost refuses bad bodies and unknown actions', () => {
  const s = setup()
  assert.equal(s.post('not json').error, 'bad_json')
  assert.equal(s.post({ id_token: 'MAMMA', action: 'deleteAll' }).error, 'bad_action')
  assert.equal(s.post({ id_token: 'ZIO', action: 'savePlan', plan: plan() }).status, 403)
})
