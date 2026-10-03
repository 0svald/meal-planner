// Data API for menu-famiglia-app.
// Reads the JSON files of the Drive folder family-meal-planner/ and writes the
// app's own files: plans.json, pantry.json, wishlist.json and the text files
// in shopping-lists/. No planning logic lives here: identify the caller, read,
// validate the shape, write.
//
// Script Properties (Project settings > Script properties):
//   FOLDER_ID   id of the family-meal-planner folder
//   ALLOWED     comma-separated list of the Google accounts allowed to use the API
//   CLIENT_ID   OAuth client id of the web page (Google Identity Services)
//
// Every response is HTTP 200 (ContentService cannot set a status code); the
// outcome is in the body: {ok: true, ...} or {ok: false, status, error, message}.

var RESOURCES = {
  catalog: 'catalog.json',
  family: 'family-data.json',
  plans: 'plans.json',
  pantry: 'pantry.json',
  wishlist: 'wishlist.json'
};

var TOKEN_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
var MAX_CACHE_SECONDS = 21600; // CacheService limit (6 hours)

function doGet(e) {
  var params = (e && e.parameter) || {};
  try {
    var email = authenticate_(params.id_token);
    var name = params.resource;
    if (name === 'all') {
      var out = { ok: true, resource: 'all', email: email, resources: {} };
      Object.keys(RESOURCES).forEach(function (key) {
        out.resources[key] = readResource_(key);
      });
      return json_(out);
    }
    if (!RESOURCES.hasOwnProperty(name)) {
      throw apiError_(400, 'bad_resource', 'resource must be one of: all, ' + Object.keys(RESOURCES).join(', '));
    }
    var res = readResource_(name);
    return json_({ ok: true, resource: name, email: email, data: res.data, updated_at: res.updated_at });
  } catch (err) {
    return errorOutput_(err);
  }
}

// POST body (sent as text/plain to avoid a CORS preflight):
//   {id_token, action: 'savePlan', plan, base_updated_at}
//   {id_token, action: 'saveShoppingList', week_start, text}
//   {id_token, action: 'updatePantry', add: [...], remove: [...]}
//   {id_token, action: 'addWish', name, url?, note?}
//   {id_token, action: 'removeWish', id}
// `base_updated_at` is the `updated_at` of plans.json the app loaded (null if
// the file did not exist): if someone saved in between, the write is refused
// with 409 and the app reloads. The last confirmed write wins.
function doPost(e) {
  try {
    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseError) {
      throw apiError_(400, 'bad_json', 'Body must be JSON sent as text/plain');
    }
    var email = authenticate_(body.id_token);
    if (body.action === 'savePlan') return json_(savePlan_(body.plan, body.base_updated_at || null, email));
    if (body.action === 'saveShoppingList') return json_(saveShoppingList_(body.week_start, body.text, email));
    if (body.action === 'updatePantry') return json_(updatePantry_(body.add, body.remove, email));
    if (body.action === 'addWish') return json_(addWish_(body, email));
    if (body.action === 'removeWish') return json_(removeWish_(body.id, email));
    throw apiError_(400, 'bad_action', 'unknown action');
  } catch (err) {
    return errorOutput_(err);
  }
}

// --- authentication --------------------------------------------------------
// The web page signs the user in with Google Identity Services and sends the
// resulting ID token. Session.getActiveUser() cannot be used: for consumer
// (gmail.com) accounts it returns an empty email in a web app that runs as
// the owner, and a web app that requires sign-in needs third-party cookies,
// which Safari blocks for a page on github.io.

function authenticate_(token) {
  if (!token) throw apiError_(401, 'unauthenticated', 'Missing id_token');
  var cache = CacheService.getScriptCache();
  var key = 'tok:' + sha256_(token);
  var email = cache.get(key);
  if (!email) {
    var claims = verifyIdToken_(token);
    email = String(claims.email).toLowerCase();
    var ttl = Math.min(MAX_CACHE_SECONDS, Number(claims.exp) - Math.floor(Date.now() / 1000));
    if (ttl > 0) cache.put(key, email, ttl);
  }
  // The allowlist is checked on every call, so removing someone takes effect at once.
  if (allowedEmails_().indexOf(email) === -1) {
    var err = apiError_(403, 'forbidden', 'Account not allowed');
    err.email = email;
    throw err;
  }
  return email;
}

function verifyIdToken_(token) {
  var resp = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true }
  );
  if (resp.getResponseCode() !== 200) throw apiError_(401, 'invalid_token', 'Token rejected by Google');
  var claims = JSON.parse(resp.getContentText());
  var clientId = property_('CLIENT_ID');
  var now = Math.floor(Date.now() / 1000);
  if (claims.aud !== clientId) throw apiError_(401, 'invalid_token', 'Token issued for another client');
  if (TOKEN_ISSUERS.indexOf(claims.iss) === -1) throw apiError_(401, 'invalid_token', 'Unexpected issuer');
  if (!(Number(claims.exp) > now)) throw apiError_(401, 'invalid_token', 'Token expired');
  if (String(claims.email_verified) !== 'true' || !claims.email) {
    throw apiError_(401, 'invalid_token', 'Email not verified');
  }
  return claims;
}

function allowedEmails_() {
  return property_('ALLOWED').split(',').map(function (s) {
    return s.trim().toLowerCase();
  }).filter(function (s) { return s; });
}

// --- Drive -----------------------------------------------------------------

function readResource_(name) {
  var file = findFile_(RESOURCES[name]);
  if (!file) {
    // plans.json and pantry.json are created by the app at the first save;
    // until pantry.json exists the pantry of family-data.json applies.
    if (name === 'plans') return { data: { schema_version: '1.0', plans: [] }, updated_at: null };
    if (name === 'pantry' || name === 'wishlist') return { data: null, updated_at: null };
    throw apiError_(404, 'not_found', RESOURCES[name] + ' not found in the folder');
  }
  var data;
  try {
    data = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  } catch (e) {
    throw apiError_(500, 'bad_json', RESOURCES[name] + ' is not valid JSON');
  }
  return { data: data, updated_at: file.getLastUpdated().toISOString() };
}

// Files are found by name: their ids change at every save. While a save is in
// progress two copies can briefly coexist; the newest wins.
function findFile_(fileName) {
  var folder = DriveApp.getFolderById(property_('FOLDER_ID'));
  var it = folder.getFilesByName(fileName);
  var best = null;
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed()) continue;
    if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
  }
  return best;
}

// Only the app's files are ever written (plans.json, pantry.json, wishlist.json):
// catalog.json and family-data.json belong to the skill. A save creates a new
// copy, then moves the old one to archive/ as <name>-YYYYMMDD-HHMM.json (same
// convention as the skill).
var APP_FILES = { plans: true, pantry: true, wishlist: true };

function writeAppFile_(resource, obj) {
  if (!APP_FILES[resource]) throw new Error('The app never writes ' + resource);
  var name = RESOURCES[resource];
  var folder = DriveApp.getFolderById(property_('FOLDER_ID'));
  var old = findFile_(name);
  var created = folder.createFile(name, JSON.stringify(obj), 'application/json');
  if (old) {
    old.moveTo(archiveFolder_(folder));
    old.setName(name.replace(/\.json$/, '') + '-' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmm') + '.json');
  }
  return created;
}

function archiveFolder_(folder) {
  var it = folder.getFoldersByName('archive');
  return it.hasNext() ? it.next() : folder.createFolder('archive');
}

// --- plans -----------------------------------------------------------------

function savePlan_(plan, baseUpdatedAt, email) {
  var catalog = readResource_('catalog').data;
  var dishIds = {};
  (catalog.dishes || []).forEach(function (d) { dishIds[d.id] = true; });
  var clean = validatePlan_(plan, dishIds);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_(503, 'busy', 'Another save is in progress, retry');
  try {
    var current = readResource_('plans').data;
    var stamp = current.updated_at || null;
    if (baseUpdatedAt !== stamp) {
      var conflict = apiError_(409, 'conflict', 'plans.json changed since it was loaded');
      conflict.extra = { updated_at: stamp, updated_by: current.updated_by || null };
      throw conflict;
    }
    var now = new Date().toISOString();
    clean.updated_at = now;
    clean.updated_by = email;
    var plans = (current.plans || []).filter(function (p) { return p.week_start !== clean.week_start; });
    plans.push(clean);
    plans.sort(function (a, b) { return a.week_start < b.week_start ? -1 : 1; });
    var next = {
      schema_version: current.schema_version || '1.0',
      updated_at: now,
      updated_by: email,
      plans: plans
    };
    writeAppFile_('plans', next);
    return { ok: true, action: 'savePlan', email: email, data: next, updated_at: now };
  } finally {
    lock.releaseLock();
  }
}

// --- pantry ----------------------------------------------------------------
// Staples always at home, left out of the shopping list. The app sends the
// change (items to add and to remove), applied here to the current list under
// the lock: two people editing at once never overwrite each other. The first
// change starts from the pantry of family-data.json.

var MAX_PANTRY_ITEMS = 200;
var MAX_PANTRY_NAME = 60;

function pantryKey_(name) {
  return String(name).toLowerCase().replace(/\s+/g, ' ').trim();
}

function pantryItems_(list, field) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw apiError_(422, 'invalid_pantry', field + ' must be a list of names');
  return list.map(function (x) {
    var name = typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > MAX_PANTRY_NAME) {
      throw apiError_(422, 'invalid_pantry', field + ': names must be 1-' + MAX_PANTRY_NAME + ' characters');
    }
    return name;
  });
}

function updatePantry_(add, remove, email) {
  var toAdd = pantryItems_(add, 'add');
  var toRemove = pantryItems_(remove, 'remove').map(pantryKey_);
  if (!toAdd.length && !toRemove.length) throw apiError_(422, 'invalid_pantry', 'nothing to change');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_(503, 'busy', 'Another save is in progress, retry');
  try {
    var current = readResource_('pantry').data;
    var items = current && Array.isArray(current.pantry)
      ? current.pantry
      : (readResource_('family').data.pantry || []);
    var keys = {};
    var next = [];
    items.concat(toAdd).forEach(function (name) {
      var key = pantryKey_(name);
      if (keys[key] || toRemove.indexOf(key) !== -1) return;
      keys[key] = true;
      next.push(name);
    });
    if (next.length > MAX_PANTRY_ITEMS) throw apiError_(422, 'invalid_pantry', 'too many items');
    next.sort(function (a, b) { return a.localeCompare(b, 'it'); });
    var now = new Date().toISOString();
    var data = { schema_version: '1.0', updated_at: now, updated_by: email, pantry: next };
    writeAppFile_('pantry', data);
    return { ok: true, action: 'updatePantry', email: email, data: data, updated_at: now };
  } finally {
    lock.releaseLock();
  }
}

// --- wishlist --------------------------------------------------------------
// Recipes the family would like added to the catalog. The skill reads this
// file, adds the dishes to catalog.json with "wish:<id>" in source.ref, and
// never writes it: the app shows a wish as added when a dish refers to it.

var MAX_WISHES = 200;

function text_(value, field, max, required) {
  var t = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (value != null && typeof value !== 'string') throw apiError_(422, 'invalid_wish', field + ' must be text');
  if (required && !t) throw apiError_(422, 'invalid_wish', field + ' is required');
  if (t.length > max) throw apiError_(422, 'invalid_wish', field + ' is longer than ' + max + ' characters');
  return t;
}

function changeWishlist_(email, change) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_(503, 'busy', 'Another save is in progress, retry');
  try {
    var current = readResource_('wishlist').data;
    var wishes = change(current && Array.isArray(current.wishes) ? current.wishes.slice() : []);
    var now = new Date().toISOString();
    var data = { schema_version: '1.0', updated_at: now, updated_by: email, wishes: wishes };
    writeAppFile_('wishlist', data);
    return { ok: true, email: email, data: data, updated_at: now };
  } finally {
    lock.releaseLock();
  }
}

function addWish_(body, email) {
  var wish = { name: text_(body.name, 'name', 80, true) };
  var url = text_(body.url, 'url', 500, false);
  if (url) {
    if (!/^https?:\/\/\S+$/i.test(url)) throw apiError_(422, 'invalid_wish', 'url must start with http:// or https://');
    wish.url = url;
  }
  var note = text_(body.note, 'note', 300, false);
  if (note) wish.note = note;
  var now = new Date();
  wish.id = 'w-' + Utilities.formatDate(now, 'UTC', 'yyyyMMdd') + '-' + Utilities.getUuid().slice(0, 6);
  wish.added_by = email;
  wish.added_at = now.toISOString();
  var out = changeWishlist_(email, function (wishes) {
    if (wishes.length >= MAX_WISHES) throw apiError_(422, 'invalid_wish', 'the list is full');
    wishes.push(wish);
    return wishes;
  });
  out.action = 'addWish';
  out.wish = wish;
  return out;
}

function removeWish_(id, email) {
  if (typeof id !== 'string' || !id) throw apiError_(422, 'invalid_wish', 'id is required');
  var out = changeWishlist_(email, function (wishes) {
    var kept = wishes.filter(function (w) { return w.id !== id; });
    if (kept.length === wishes.length) throw apiError_(404, 'not_found', 'No wish with this id');
    return kept;
  });
  out.action = 'removeWish';
  return out;
}

// --- shopping lists ----------------------------------------------------------
// One text file per week in shopping-lists/: spesa-<week_start>.txt. The text
// is built by engine/shopping.js in the app; a newer copy replaces the older,
// which moves to archive/.

var MAX_LIST_BYTES = 20000;

function saveShoppingList_(weekStart, text, email) {
  var start = parseDate_(weekStart);
  if (!start || start.getUTCDay() !== 1) throw apiError_(422, 'invalid_list', 'week_start must be a Monday YYYY-MM-DD');
  if (typeof text !== 'string' || !text.trim()) throw apiError_(422, 'invalid_list', 'text must be a non-empty string');
  if (text.length > MAX_LIST_BYTES) throw apiError_(422, 'invalid_list', 'text is too long');

  var folder = DriveApp.getFolderById(property_('FOLDER_ID'));
  var it = folder.getFoldersByName('shopping-lists');
  var lists = it.hasNext() ? it.next() : folder.createFolder('shopping-lists');
  var name = 'spesa-' + weekStart + '.txt';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_(503, 'busy', 'Another save is in progress, retry');
  try {
    var old = [];
    var files = lists.getFilesByName(name);
    while (files.hasNext()) {
      var f = files.next();
      if (!f.isTrashed()) old.push(f);
    }
    lists.createFile(name, text, 'text/plain');
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmm');
    old.forEach(function (f) {
      f.moveTo(archiveFolder_(folder));
      f.setName('spesa-' + weekStart + '-' + stamp + '.txt');
    });
    return { ok: true, action: 'saveShoppingList', email: email, file: 'shopping-lists/' + name };
  } finally {
    lock.releaseLock();
  }
}

// Shape checks only: the planning rules live in engine/, not here.
function validatePlan_(plan, dishIds) {
  var problems = [];
  if (!plan || typeof plan !== 'object') throw apiError_(422, 'invalid_plan', 'plan must be an object');
  var start = parseDate_(plan.week_start);
  if (!start) problems.push('week_start must be YYYY-MM-DD');
  else if (start.getUTCDay() !== 1) problems.push('week_start must be a Monday');
  if (typeof plan.id !== 'string' || !/^\d{4}-w\d{2}$/.test(plan.id)) problems.push('id must look like 2026-w40');
  if (plan.status !== 'draft' && plan.status !== 'confirmed') problems.push('status must be draft or confirmed');
  if (plan.cycle_week != null && !(Number(plan.cycle_week) >= 1 && Number(plan.cycle_week) % 1 === 0)) {
    problems.push('cycle_week must be a positive integer');
  }
  var meals = [];
  if (!Array.isArray(plan.meals) || plan.meals.length > 14) {
    problems.push('meals must be a list of at most 14 meals');
  } else {
    var seen = {};
    plan.meals.forEach(function (m, i) {
      var p = 'meals[' + i + ']';
      var day = m && parseDate_(m.date);
      if (!day) return problems.push(p + '.date must be YYYY-MM-DD');
      var offset = start ? Math.round((day - start) / 86400000) : 0;
      if (offset < 0 || offset > 6) problems.push(p + '.date is outside the week');
      if (m.slot !== 'lunch' && m.slot !== 'dinner') problems.push(p + '.slot must be lunch or dinner');
      if (seen[m.date + '/' + m.slot]) problems.push(p + ' repeats ' + m.date + ' ' + m.slot);
      seen[m.date + '/' + m.slot] = true;
      if (!Array.isArray(m.dish_ids) || !m.dish_ids.length) {
        return problems.push(p + '.dish_ids must be a non-empty list');
      }
      m.dish_ids.forEach(function (id) {
        if (!dishIds[id]) problems.push(p + ': unknown dish ' + id);
      });
      meals.push({ date: m.date, slot: m.slot, dish_ids: m.dish_ids.slice() });
    });
  }
  if (problems.length) throw apiError_(422, 'invalid_plan', problems.join('; '));
  var clean = { id: plan.id, week_start: plan.week_start, status: plan.status, meals: meals };
  if (plan.cycle_week != null) clean.cycle_week = Number(plan.cycle_week);
  return clean;
}

function parseDate_(text) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || '');
  if (!m) return null;
  var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === text ? d : null;
}

// --- helpers ---------------------------------------------------------------

function property_(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw apiError_(500, 'not_configured', 'Script property ' + key + ' is not set');
  return value;
}

function apiError_(status, code, message) {
  var err = new Error(message);
  err.apiStatus = status;
  err.apiCode = code;
  return err;
}

function errorOutput_(err) {
  if (!err.apiStatus) console.error(err && err.stack ? err.stack : err);
  var body = {
    ok: false,
    status: err.apiStatus || 500,
    error: err.apiCode || 'internal',
    message: err.apiStatus ? err.message : 'Internal error'
  };
  if (err.email) body.email = err.email;
  if (err.extra) Object.keys(err.extra).forEach(function (k) { body[k] = err.extra[k]; });
  return json_(body);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sha256_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// Run from the editor after setting the Script Properties: checks the setup
// and lists what the API would return, without needing a token.
function checkSetup() {
  console.log('Allowed accounts: ' + allowedEmails_().length);
  console.log('Client id set: ' + Boolean(property_('CLIENT_ID')));
  console.log('pantry.json is optional: until the first change the pantry of family-data.json applies.');
  Object.keys(RESOURCES).forEach(function (key) {
    var file = findFile_(RESOURCES[key]);
    console.log(RESOURCES[key] + ': ' + (file ? file.getSize() + ' bytes, updated ' + file.getLastUpdated() : 'missing'));
  });
}
