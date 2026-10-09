// Data API for menu-famiglia-app.
// Reads the JSON files of the Drive folder family-meal-planner/ and writes the
// app's own files: plans.json, pantry.json, wishlist.json, dish-edits.json and
// the text files in shopping-lists/. No planning logic lives here: identify the caller, read,
// validate the shape, write.
//
// Script Properties (Project settings > Script properties):
//   FOLDER_ID   id of the family-meal-planner folder
//   ALLOWED     comma-separated list of the Google accounts allowed to use the API
//               (managed from the app by the owner; the owner is always allowed)
//   ADMINS      optional: more accounts that may invite and remove members
//   CLIENT_ID   OAuth client id of the web page (Google Identity Services)
//
// Every response is HTTP 200 (ContentService cannot set a status code); the
// outcome is in the body: {ok: true, ...} or {ok: false, status, error, message}.

var RESOURCES = {
  catalog: 'catalog.json',
  family: 'family-data.json',
  plans: 'plans.json',
  pantry: 'pantry.json',
  wishlist: 'wishlist.json',
  edits: 'dish-edits.json'
};

var TOKEN_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
var MAX_CACHE_SECONDS = 21600; // CacheService limit (6 hours)

function doGet(e) {
  var params = (e && e.parameter) || {};
  try {
    // Public: the OAuth client id is not a secret, and the page needs it to
    // show "Accedi con Google" before it has a token. Nothing else is public.
    if (params.resource === 'config') return json_({ ok: true, resource: 'config', client_id: property_('CLIENT_ID') });
    var email = authenticate_(params.id_token);
    var name = params.resource;
    if (name === 'all') {
      var out = { ok: true, resource: 'all', email: email, admin: isAdmin_(email), resources: {} };
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
//   {id_token, action: 'saveDishEdit', dish_id, fields}
//   {id_token, action: 'resetDishEdit', dish_id}
//   {id_token, action: 'listMembers'}                          (admin only)
//   {id_token, action: 'inviteMember', email, app_url, endpoint} (admin only)
//   {id_token, action: 'removeMember', email}                  (admin only)
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
    if (body.action === 'saveDishEdit') return json_(saveDishEdit_(body.dish_id, body.fields, email));
    if (body.action === 'resetDishEdit') return json_(resetDishEdit_(body.dish_id, email));
    if (body.action === 'listMembers') return json_(listMembers_(email));
    if (body.action === 'inviteMember') return json_(inviteMember_(body, email));
    if (body.action === 'removeMember') return json_(removeMember_(body.email, email));
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
  var list = PropertiesService.getScriptProperties().getProperty('ALLOWED') || '';
  var emails = list.split(',').map(function (s) {
    return s.trim().toLowerCase();
  }).filter(function (s) { return s; });
  var owner = ownerEmail_();
  if (owner && emails.indexOf(owner) === -1) emails.unshift(owner);
  return emails;
}

// --- dish edits ----------------------------------------------------------------
// The family corrects catalog dishes from the app. catalog.json belongs to the
// skill, so the changes live in dish-edits.json and sit on top of it
// (engine/data.js applyDishEdits). Each save replaces the edit of one dish
// under the lock; resetting removes it, back to the catalog version.
// Only the shape is checked here, with the closed sets of the skill's model.py.

var COURSES = ['first', 'second', 'side', 'single', 'bread', 'fruit', 'dessert', 'takeaway'];
var ALLERGENS = ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soy', 'milk', 'nuts', 'celery',
  'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'];
var CARBS = ['cereals', 'tubers', 'legumes', 'simple_sugars'];
var CEREAL_TYPES = ['wheat', 'rice', 'barley', 'spelt', 'corn', 'oats', 'other'];
var PROTEINS = ['red_meat', 'white_meat', 'processed_meat', 'fish', 'shellfish', 'eggs', 'cheese', 'legumes'];
var FATS = ['evo_oil', 'butter_cream', 'aged_cheese', 'nuts_seeds', 'oily_fish', 'fried'];
var VEG_FORMS = ['raw', 'cooked', 'both'];
var CONFIDENCE = ['high', 'medium', 'low'];
var AISLES = ['produce', 'meat', 'fish', 'dairy', 'pantry', 'frozen', 'bakery', 'other'];

function enumList_(value, allowed, field, problems) {
  if (!Array.isArray(value)) return problems.push(field + ' must be a list');
  value.forEach(function (v) { if (allowed.indexOf(v) === -1) problems.push(field + ': unknown value ' + v); });
}

function validateDishFields_(fields) {
  var problems = [];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw apiError_(422, 'invalid_dish', 'fields must be an object');
  Object.keys(fields).forEach(function (k) {
    var v = fields[k];
    if (k === 'name') {
      if (typeof v !== 'string' || !v.trim() || v.length > 120) problems.push('name must be 1-120 characters');
    } else if (k === 'course') {
      if (COURSES.indexOf(v) === -1) problems.push('course: unknown value ' + v);
    } else if (k === 'allergens') {
      enumList_(v, ALLERGENS, 'allergens', problems);
    } else if (k === 'ingredients') {
      if (!Array.isArray(v) || v.length > 60) return problems.push('ingredients must be a list of at most 60');
      v.forEach(function (ing, i) {
        var p = 'ingredients[' + i + ']';
        if (!ing || typeof ing.name !== 'string' || !ing.name.trim() || ing.name.length > 80) problems.push(p + '.name must be 1-80 characters');
        if (!ing || AISLES.indexOf(ing.aisle) === -1) problems.push(p + '.aisle: unknown value');
        if (ing && ing.qty !== undefined && !(typeof ing.qty === 'number' && ing.qty > 0)) problems.push(p + '.qty must be a positive number');
        if (ing && ing.qty !== undefined && typeof ing.unit !== 'string') problems.push(p + '.unit is required with qty');
        if (ing && ing.unit !== undefined && (typeof ing.unit !== 'string' || ing.unit.length > 20)) problems.push(p + '.unit must be text');
        var extra = Object.keys(ing || {}).filter(function (x) { return ['name', 'aisle', 'qty', 'unit'].indexOf(x) === -1; });
        if (extra.length) problems.push(p + ': unknown keys ' + extra.join(', '));
      });
    } else if (k === 'nutrition') {
      if (v === null) return;
      if (typeof v !== 'object' || Array.isArray(v)) return problems.push('nutrition must be an object');
      enumList_(v.carbs || [], CARBS, 'nutrition.carbs', problems);
      enumList_(v.proteins || [], PROTEINS, 'nutrition.proteins', problems);
      enumList_(v.fats || [], FATS, 'nutrition.fats', problems);
      (Array.isArray(v.cereals) ? v.cereals : []).forEach(function (c) {
        if (!c || CEREAL_TYPES.indexOf(c.type) === -1 || typeof c.whole !== 'boolean') problems.push('nutrition.cereals: bad entry');
      });
      if (v.cereals && v.cereals.length && (v.carbs || []).indexOf('cereals') === -1) problems.push('nutrition.cereals needs cereals in carbs');
      if (v.vegetables !== undefined) {
        var veg = v.vegetables;
        if (!veg || typeof veg.present !== 'boolean') problems.push('nutrition.vegetables.present must be true or false');
        else if (veg.present && VEG_FORMS.indexOf(veg.form) === -1) problems.push('nutrition.vegetables.form: unknown value');
      }
      if (CONFIDENCE.indexOf(v.confidence) === -1) problems.push('nutrition.confidence: unknown value');
    } else if (k === 'prep_minutes') {
      if (v !== null && !(typeof v === 'number' && v % 1 === 0 && v >= 0 && v <= 600)) problems.push('prep_minutes must be 0-600 or null');
    } else if (k === 'notes') {
      if (v !== null && (typeof v !== 'string' || v.length > 500)) problems.push('notes must be text up to 500 characters');
    } else if (k === 'verified' || k === 'cookable_at_home') {
      if (typeof v !== 'boolean') problems.push(k + ' must be true or false');
    } else if (k === 'tags') {
      if (!Array.isArray(v) || v.length > 20 || v.some(function (t) { return typeof t !== 'string' || !t || t.length > 30; })) {
        problems.push('tags must be a list of short words');
      }
    } else {
      problems.push('field ' + k + ' cannot be edited');
    }
  });
  if (problems.length) throw apiError_(422, 'invalid_dish', problems.join('; '));
}

function requireDish_(dishId) {
  var dishes = readResource_('catalog').data.dishes || [];
  if (typeof dishId !== 'string' || !dishes.some(function (d) { return d.id === dishId; })) {
    throw apiError_(404, 'not_found', 'No dish with this id in the catalog');
  }
}

function changeEdits_(email, change) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_(503, 'busy', 'Another save is in progress, retry');
  try {
    var current = readResource_('edits').data;
    var edits = change(current && current.edits ? JSON.parse(JSON.stringify(current.edits)) : {});
    var now = new Date().toISOString();
    var data = { schema_version: '1.0', updated_at: now, updated_by: email, edits: edits };
    writeAppFile_('edits', data);
    return { ok: true, email: email, data: data, updated_at: now };
  } finally {
    lock.releaseLock();
  }
}

function saveDishEdit_(dishId, fields, email) {
  requireDish_(dishId);
  validateDishFields_(fields);
  var out = changeEdits_(email, function (edits) {
    edits[dishId] = { fields: fields, edited_by: email, edited_at: new Date().toISOString() };
    return edits;
  });
  out.action = 'saveDishEdit';
  return out;
}

function resetDishEdit_(dishId, email) {
  var out = changeEdits_(email, function (edits) {
    if (!edits[dishId]) throw apiError_(404, 'not_found', 'This dish has no edit');
    delete edits[dishId];
    return edits;
  });
  out.action = 'resetDishEdit';
  return out;
}

// --- family members ----------------------------------------------------------
// The owner of the script (who deployed it, and whose Drive holds the data)
// manages who may use the app: the allowlist lives in the ALLOWED property.
// Further admins can be listed in the optional ADMINS property.

function ownerEmail_() {
  var user = Session.getEffectiveUser();
  return user ? String(user.getEmail() || '').toLowerCase() : '';
}

function isAdmin_(email) {
  var admins = (PropertiesService.getScriptProperties().getProperty('ADMINS') || '').split(',')
    .map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s; });
  var owner = ownerEmail_();
  if (owner) admins.push(owner);
  return admins.indexOf(email) !== -1;
}

function requireAdmin_(email) {
  if (!isAdmin_(email)) throw apiError_(403, 'not_admin', 'Only the owner can manage the family');
}

function membersView_() {
  var owner = ownerEmail_();
  return allowedEmails_().map(function (m) { return { email: m, owner: m === owner, admin: isAdmin_(m) }; });
}

function saveAllowed_(emails) {
  var owner = ownerEmail_();
  var list = emails.filter(function (m) { return m !== owner; });
  PropertiesService.getScriptProperties().setProperty('ALLOWED', list.join(','));
}

function listMembers_(email) {
  requireAdmin_(email);
  return { ok: true, action: 'listMembers', members: membersView_() };
}

var EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
var ENDPOINT_RE = /^https:\/\/script\.google\.com\/[\w\/.-]+\/exec$/;

// Adds the address to the allowlist and sends the invitation: a link to the
// app with the API address in the fragment (#invito=...), which browsers never
// send to GitHub. The page reads it, keeps it, and asks for the Google sign-in.
function inviteMember_(body, email) {
  requireAdmin_(email);
  var to = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) throw apiError_(422, 'invalid_member', 'email is not valid');
  var appUrl = String(body.app_url || '');
  if (!/^https:\/\/[^\s#?]+$/.test(appUrl)) throw apiError_(422, 'invalid_member', 'app_url must be an https URL without query or fragment');
  var endpoint = String(body.endpoint || '');
  if (!ENDPOINT_RE.test(endpoint)) throw apiError_(422, 'invalid_member', 'endpoint must be the /exec URL');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_(503, 'busy', 'Another save is in progress, retry');
  try {
    var emails = allowedEmails_();
    if (emails.indexOf(to) === -1) emails.push(to);
    saveAllowed_(emails);
  } finally {
    lock.releaseLock();
  }

  var link = appUrl + '#invito=' + Utilities.base64EncodeWebSafe(endpoint).replace(/=+$/, '');
  var subject = 'Invito al Menu di famiglia';
  var text = 'Ciao,\n\n' + email + ' ti ha invitato a usare il Menu di famiglia: il menu della settimana, ' +
    'la lista della spesa e le ricette da provare.\n\n' +
    'Apri questo link dal telefono e accedi con questo indirizzo Google (' + to + '):\n' + link + '\n\n' +
    'Poi, dal menu di Chrome, scegli «Installa app» per averla nella schermata Home.\n';
  var html = '<p>Ciao,</p><p>' + escapeHtml_(email) + ' ti ha invitato a usare il <b>Menu di famiglia</b>: ' +
    'il menu della settimana, la lista della spesa e le ricette da provare.</p>' +
    '<p><a href="' + escapeHtml_(link) + '" style="display:inline-block;padding:10px 18px;background:#2f6b4f;' +
    'color:#fff;border-radius:8px;text-decoration:none">Apri il Menu di famiglia</a></p>' +
    '<p>Accedi con questo indirizzo Google: <b>' + escapeHtml_(to) + '</b>.<br>' +
    'Poi, dal menu di Chrome, scegli «Installa app» per averla nella schermata Home.</p>';
  MailApp.sendEmail({ to: to, subject: subject, body: text, htmlBody: html, name: 'Menu di famiglia' });
  return { ok: true, action: 'inviteMember', invited: to, members: membersView_() };
}

function removeMember_(target, email) {
  requireAdmin_(email);
  var who = String(target || '').trim().toLowerCase();
  if (who === ownerEmail_()) throw apiError_(422, 'invalid_member', 'The owner cannot be removed');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_(503, 'busy', 'Another save is in progress, retry');
  try {
    var emails = allowedEmails_();
    if (emails.indexOf(who) === -1) throw apiError_(404, 'not_found', 'Not in the family');
    saveAllowed_(emails.filter(function (m) { return m !== who; }));
  } finally {
    lock.releaseLock();
  }
  return { ok: true, action: 'removeMember', removed: who, members: membersView_() };
}

function escapeHtml_(text) {
  return String(text).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// --- Drive -----------------------------------------------------------------

function readResource_(name) {
  var file = findFile_(RESOURCES[name]);
  if (!file) {
    // plans.json and pantry.json are created by the app at the first save;
    // until pantry.json exists the pantry of family-data.json applies.
    if (name === 'plans') return { data: { schema_version: '1.0', plans: [] }, updated_at: null };
    if (name === 'pantry' || name === 'wishlist' || name === 'edits') return { data: null, updated_at: null };
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

// Only the app's files are ever written (plans.json, pantry.json, wishlist.json,
// dish-edits.json):
// catalog.json and family-data.json belong to the skill. A save creates a new
// copy, then moves the old one to archive/ as <name>-YYYYMMDD-HHMM.json (same
// convention as the skill).
var APP_FILES = { plans: true, pantry: true, wishlist: true, edits: true };

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
  console.log('Owner: ' + ownerEmail_() + ' · allowed accounts: ' + allowedEmails_().length);
  console.log('Mail quota left today: ' + MailApp.getRemainingDailyQuota());
  console.log('Client id set: ' + Boolean(property_('CLIENT_ID')));
  console.log('pantry.json is optional: until the first change the pantry of family-data.json applies.');
  Object.keys(RESOURCES).forEach(function (key) {
    var file = findFile_(RESOURCES[key]);
    console.log(RESOURCES[key] + ': ' + (file ? file.getSize() + ' bytes, updated ' + file.getLastUpdated() : 'missing'));
  });
}
