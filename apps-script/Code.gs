// Data API for menu-famiglia-app.
// Reads the JSON files of the Drive folder family-meal-planner/. No planning
// logic lives here: identify the caller, read, (later) validate and write.
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
  plans: 'plans.json'
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
    // plans.json is created by the app at the first save.
    if (name === 'plans') return { data: { schema_version: '1.0', plans: [] }, updated_at: null };
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
  Object.keys(RESOURCES).forEach(function (key) {
    var file = findFile_(RESOURCES[key]);
    console.log(RESOURCES[key] + ': ' + (file ? file.getSize() + ' bytes, updated ' + file.getLastUpdated() : 'missing'));
  });
}
