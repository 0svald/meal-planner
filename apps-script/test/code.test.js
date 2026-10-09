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

test('saveShoppingList writes shopping-lists/spesa-<week>.txt and archives the older copy', () => {
  const s = setup()
  const first = s.post({ id_token: 'MAMMA', action: 'saveShoppingList', week_start: '2026-10-05', text: 'Spesa\n- pasta' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.file, 'shopping-lists/spesa-2026-10-05.txt')
  const lists = s.drive.folders.find(f => f.name === 'shopping-lists')
  assert.deepEqual(s.fileNames(lists), ['spesa-2026-10-05.txt'])
  s.post({ id_token: 'PAPA', action: 'saveShoppingList', week_start: '2026-10-05', text: 'Spesa\n- riso' })
  assert.deepEqual(s.fileNames(lists), ['spesa-2026-10-05.txt'])
  assert.equal(lists.files()[0].content, 'Spesa\n- riso')
  assert.match(s.fileNames(s.archive())[0], /^spesa-2026-10-05-\d{8}-\d{4}\.txt$/)
  assert.deepEqual(s.fileNames(), ['catalog.json', 'family-data.json'])
})

test('saveShoppingList refuses a bad week or an empty text', () => {
  const s = setup()
  assert.equal(s.post({ id_token: 'MAMMA', action: 'saveShoppingList', week_start: '2026-10-06', text: 'x' }).status, 422)
  assert.equal(s.post({ id_token: 'MAMMA', action: 'saveShoppingList', week_start: '2026-10-05', text: '  ' }).status, 422)
})

test('updatePantry starts from family-data, applies adds and removes, archives', () => {
  const s = loadScript({
    files: { 'catalog.json': catalog, 'family-data.json': { ...family, pantry: ['sale', 'olio', 'pepe'] } },
    tokens
  })
  assert.equal(s.get({ resource: 'all', id_token: 'MAMMA' }).resources.pantry.data, null)
  const a = s.post({ id_token: 'MAMMA', action: 'updatePantry', add: ['  Riso ', 'SALE'], remove: ['pepe'] })
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.deepEqual(a.data.pantry, ['olio', 'Riso', 'sale'])
  assert.equal(a.data.updated_by, 'mamma@example.com')
  const b = s.post({ id_token: 'PAPA', action: 'updatePantry', remove: ['riso'] })
  assert.deepEqual(b.data.pantry, ['olio', 'sale'])
  assert.deepEqual(s.fileNames(), ['catalog.json', 'family-data.json', 'pantry.json'])
  assert.match(s.fileNames(s.archive())[0], /^pantry-\d{8}-\d{4}\.json$/)
  const familyFile = s.drive.files.find(f => f.name === 'family-data.json')
  assert.deepEqual(JSON.parse(familyFile.content).pantry, ['sale', 'olio', 'pepe'], 'family-data.json untouched')
})

test('updatePantry refuses empty or malformed changes', () => {
  const s = setup()
  assert.equal(s.post({ id_token: 'MAMMA', action: 'updatePantry' }).status, 422)
  assert.equal(s.post({ id_token: 'MAMMA', action: 'updatePantry', add: 'riso' }).status, 422)
  assert.equal(s.post({ id_token: 'MAMMA', action: 'updatePantry', add: ['x'.repeat(61)] }).status, 422)
  assert.equal(s.post({ id_token: 'ZIO', action: 'updatePantry', add: ['riso'] }).status, 403)
})

test('addWish / removeWish keep wishlist.json, with who asked and when', () => {
  const s = setup()
  assert.equal(s.get({ resource: 'wishlist', id_token: 'MAMMA' }).data, null)
  const a = s.post({ id_token: 'MAMMA', action: 'addWish', name: '  Polpette   di lenticchie ', url: 'https://example.com/p', note: 'senza forno' })
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.match(a.wish.id, /^w-\d{8}-[0-9a-f]{6}$/)
  assert.equal(a.wish.name, 'Polpette di lenticchie')
  assert.equal(a.wish.added_by, 'mamma@example.com')
  const b = s.post({ id_token: 'PAPA', action: 'addWish', name: 'Vellutata di zucca' })
  assert.deepEqual(b.data.wishes.map(w => w.name), ['Polpette di lenticchie', 'Vellutata di zucca'])
  assert.equal(b.data.wishes[1].url, undefined)
  const c = s.post({ id_token: 'PAPA', action: 'removeWish', id: a.wish.id })
  assert.deepEqual(c.data.wishes.map(w => w.name), ['Vellutata di zucca'])
  assert.equal(s.post({ id_token: 'PAPA', action: 'removeWish', id: a.wish.id }).status, 404)
  assert.deepEqual(s.fileNames(), ['catalog.json', 'family-data.json', 'wishlist.json'])
  assert.equal(s.fileNames(s.archive()).filter(n => n.startsWith('wishlist-')).length, 2)
})

test('addWish refuses bad input', () => {
  const s = setup()
  assert.equal(s.post({ id_token: 'MAMMA', action: 'addWish', name: ' ' }).error, 'invalid_wish')
  assert.equal(s.post({ id_token: 'MAMMA', action: 'addWish', name: 'x', url: 'javascript:alert(1)' }).error, 'invalid_wish')
  assert.equal(s.post({ id_token: 'MAMMA', action: 'addWish', name: 'x'.repeat(81) }).error, 'invalid_wish')
  assert.equal(s.post({ id_token: 'MAMMA', action: 'addWish', name: 'x', note: 42 }).error, 'invalid_wish')
  assert.equal(s.post({ id_token: 'ZIO', action: 'addWish', name: 'x' }).status, 403)
})

const EXEC = 'https://script.google.com/macros/s/AKfyTEST/exec'
const APP = 'https://0svald.github.io/meal-planner/web/'

test('config is public and only gives the client id', () => {
  const out = setup().get({ resource: 'config' })
  assert.deepEqual(out, { ok: true, resource: 'config', client_id: 'client-id' })
})

test('the owner is always allowed and is admin; others are not admin', () => {
  const s = loadScript({ files: { 'catalog.json': catalog, 'family-data.json': family }, tokens, allowed: 'papa@example.com' })
  const mamma = s.get({ resource: 'all', id_token: 'MAMMA' })
  assert.equal(mamma.ok, true, 'owner allowed even if not listed')
  assert.equal(mamma.admin, true)
  assert.equal(s.get({ resource: 'all', id_token: 'PAPA' }).admin, false)
  assert.equal(s.post({ id_token: 'PAPA', action: 'listMembers' }).error, 'not_admin')
  const list = s.post({ id_token: 'MAMMA', action: 'listMembers' })
  assert.deepEqual(list.members.map(m => [m.email, m.owner]), [['mamma@example.com', true], ['papa@example.com', false]])
})

test('inviteMember adds to the allowlist and mails a link with the endpoint in the fragment', () => {
  const s = setup()
  assert.equal(s.get({ resource: 'all', id_token: 'ZIO' }).status, 403)
  const out = s.post({ id_token: 'MAMMA', action: 'inviteMember', email: ' Zio@Example.com ', app_url: APP, endpoint: EXEC })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.invited, 'zio@example.com')
  assert.equal(s.props.ALLOWED, 'papa@example.com,zio@example.com', 'the owner is implicit, not stored')
  assert.equal(s.get({ resource: 'all', id_token: 'ZIO' }).ok, true, 'access works at once')
  assert.equal(s.mail.length, 1)
  const m = s.mail[0]
  assert.equal(m.to, 'zio@example.com')
  const link = m.body.match(/https:\/\/\S+#invito=\S+/)[0]
  const code = link.split('#invito=')[1]
  assert.equal(Buffer.from(code.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(), EXEC)
  assert.ok(link.startsWith(APP))
  assert.ok(m.htmlBody.includes('href="' + link + '"'))
  assert.equal(m.replyTo, 'mamma@example.com', 'replies go to whoever invited')
  assert.equal(out.link, link, 'the app can share the same link by hand')
  // inviting again only resends the mail
  s.post({ id_token: 'MAMMA', action: 'inviteMember', email: 'zio@example.com', app_url: APP, endpoint: EXEC })
  assert.equal(s.props.ALLOWED, 'papa@example.com,zio@example.com')
  assert.equal(s.mail.length, 2)
})

test('inviteMember checks its input and who asks', () => {
  const s = setup()
  const invite = (who, extra) => s.post({ id_token: who, action: 'inviteMember', email: 'x@example.com', app_url: APP, endpoint: EXEC, ...extra })
  assert.equal(invite('PAPA').error, 'not_admin')
  assert.equal(invite('MAMMA', { email: 'not-an-email' }).error, 'invalid_member')
  assert.equal(invite('MAMMA', { app_url: 'http://evil.example.com/' }).error, 'invalid_member')
  assert.equal(invite('MAMMA', { endpoint: 'https://evil.example.com/exec' }).error, 'invalid_member')
  assert.equal(s.mail.length, 0)
})

test('removeMember takes access away at once; the owner cannot be removed', () => {
  const s = setup()
  const out = s.post({ id_token: 'MAMMA', action: 'removeMember', email: 'papa@example.com' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.members.map(m => m.email), ['mamma@example.com'])
  assert.equal(s.get({ resource: 'all', id_token: 'PAPA' }).status, 403)
  assert.equal(s.post({ id_token: 'MAMMA', action: 'removeMember', email: 'mamma@example.com' }).error, 'invalid_member')
  assert.equal(s.post({ id_token: 'MAMMA', action: 'removeMember', email: 'nobody@example.com' }).status, 404)
})

test('ADMINS can manage the family too', () => {
  const s = loadScript({ files: { 'catalog.json': catalog, 'family-data.json': family }, tokens, admins: 'papa@example.com' })
  assert.equal(s.post({ id_token: 'PAPA', action: 'listMembers' }).ok, true)
})

test('saveDishEdit / resetDishEdit keep dish-edits.json; catalog.json is never written', () => {
  const s = setup()
  assert.equal(s.get({ resource: 'edits', id_token: 'MAMMA' }).data, null)
  const fields = {
    name: 'Pasta corta',
    course: 'first',
    prep_minutes: 20,
    allergens: ['gluten'],
    ingredients: [{ name: 'pasta', aisle: 'pantry', qty: 320, unit: 'g' }, { name: 'basilico', aisle: 'produce' }],
    nutrition: { carbs: ['cereals'], cereals: [{ type: 'wheat', whole: false }], proteins: [], fats: ['evo_oil'], vegetables: { present: false }, confidence: 'high' },
    verified: true
  }
  const a = s.post({ id_token: 'PAPA', action: 'saveDishEdit', dish_id: 'pasta', fields })
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.deepEqual(a.data.edits.pasta.fields, fields)
  assert.equal(a.data.edits.pasta.edited_by, 'papa@example.com')
  const b = s.post({ id_token: 'MAMMA', action: 'saveDishEdit', dish_id: 'pollo', fields: { prep_minutes: null } })
  assert.deepEqual(Object.keys(b.data.edits).sort(), ['pasta', 'pollo'])
  const c = s.post({ id_token: 'MAMMA', action: 'resetDishEdit', dish_id: 'pasta' })
  assert.deepEqual(Object.keys(c.data.edits), ['pollo'])
  assert.equal(s.post({ id_token: 'MAMMA', action: 'resetDishEdit', dish_id: 'pasta' }).status, 404)
  assert.deepEqual(s.fileNames(), ['catalog.json', 'dish-edits.json', 'family-data.json'])
  const cat = s.drive.files.find(f => f.name === 'catalog.json')
  assert.deepEqual(JSON.parse(cat.content), catalog, 'catalog.json untouched')
})

test('saveDishEdit refuses unknown dishes, fields and values', () => {
  const s = setup()
  const save = (dish, fields) => s.post({ id_token: 'MAMMA', action: 'saveDishEdit', dish_id: dish, fields })
  assert.equal(save('ghost', { name: 'x' }).status, 404)
  assert.equal(save('pasta', { id: 'other' }).error, 'invalid_dish')
  assert.equal(save('pasta', { course: 'brunch' }).error, 'invalid_dish')
  assert.equal(save('pasta', { allergens: ['nickel'] }).error, 'invalid_dish')
  assert.equal(save('pasta', { ingredients: [{ name: 'x', aisle: 'garage' }] }).error, 'invalid_dish')
  assert.equal(save('pasta', { ingredients: [{ name: 'x', aisle: 'pantry', qty: 2 }] }).error, 'invalid_dish', 'qty needs a unit')
  assert.equal(save('pasta', { nutrition: { proteins: ['dragon'], confidence: 'high' } }).error, 'invalid_dish')
  assert.equal(save('pasta', { prep_minutes: -5 }).error, 'invalid_dish')
  assert.equal(save('pasta', 'not an object').error, 'invalid_dish')
  assert.equal(s.post({ id_token: 'ZIO', action: 'saveDishEdit', dish_id: 'pasta', fields: { name: 'x' } }).status, 403)
})

test('Gmail addresses match ignoring dots, "+" suffixes, case and googlemail.com', () => {
  const s = loadScript({
    files: { 'catalog.json': catalog, 'family-data.json': family },
    tokens: { ...tokens, MARIO: token('mariorossi@gmail.com'), OTHER: token('mario.rosso@gmail.com') },
    allowed: 'Mario.Rossi+menu@googlemail.com'
  })
  assert.equal(s.get({ resource: 'all', id_token: 'MARIO' }).ok, true)
  assert.equal(s.get({ resource: 'all', id_token: 'OTHER' }).status, 403)
  s.post({ id_token: 'MAMMA', action: 'inviteMember', email: 'mario.rossi@gmail.com', app_url: APP, endpoint: EXEC })
  assert.equal(s.props.ALLOWED, 'Mario.Rossi+menu@googlemail.com'.toLowerCase(), 'same account is not added twice')
  const out = s.post({ id_token: 'MAMMA', action: 'removeMember', email: 'mariorossi@gmail.com' })
  assert.equal(out.ok, true)
  assert.equal(s.get({ resource: 'all', id_token: 'MARIO' }).status, 403)
})
