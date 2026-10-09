// A minimal in-memory imitation of the Apps Script services Code.gs uses,
// so the script can run under node:test without Google.
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import vm from 'node:vm'

let clock = Date.parse('2026-10-04T10:00:00Z')
const tick = () => new Date((clock += 60000))

class FakeFile {
  constructor (name, content, parent) {
    this.name = name
    this.content = content
    this.parent = parent
    this.updated = tick()
    this.trashed = false
  }

  getName () { return this.name }
  setName (n) { this.name = n; return this }
  getBlob () { return { getDataAsString: () => this.content } }
  getLastUpdated () { return this.updated }
  getSize () { return Buffer.byteLength(this.content) }
  isTrashed () { return this.trashed }
  moveTo (folder) { this.parent = folder; return this }
}

class FakeFolder {
  constructor (drive, name, parent = null) {
    this.drive = drive
    this.name = name
    this.parent = parent
  }

  files () { return this.drive.files.filter(f => f.parent === this) }
  getFilesByName (name) { return iterator(this.files().filter(f => f.name === name)) }
  getFoldersByName (name) { return iterator(this.drive.folders.filter(f => f.parent === this && f.name === name)) }
  createFolder (name) {
    const f = new FakeFolder(this.drive, name, this)
    this.drive.folders.push(f)
    return f
  }

  createFile (name, content) {
    const f = new FakeFile(name, content, this)
    this.drive.files.push(f)
    return f
  }
}

function iterator (list) {
  let i = 0
  return { hasNext: () => i < list.length, next: () => list[i++] }
}

// tokens: { tokenString: claims }
export function loadScript ({ files = {}, allowed = 'mamma@example.com,papa@example.com', tokens = {}, owner = 'mamma@example.com', admins = '' } = {}) {
  const drive = { files: [], folders: [] }
  const root = new FakeFolder(drive, 'family-meal-planner')
  drive.folders.push(root)
  for (const [name, obj] of Object.entries(files)) root.createFile(name, JSON.stringify(obj))
  const props = { FOLDER_ID: 'root-id', ALLOWED: allowed, CLIENT_ID: 'client-id', ADMINS: admins }
  const mail = []
  const cache = new Map()

  const sandbox = {
    console: { log () {}, error () {} },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v } })
    },
    MailApp: { sendEmail: message => mail.push(message), getRemainingDailyQuota: () => 100 },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) || null, put: (k, v) => cache.set(k, v) }) },
    UrlFetchApp: {
      fetch (url) {
        const token = decodeURIComponent(url.split('id_token=')[1])
        const claims = tokens[token]
        return { getResponseCode: () => (claims ? 200 : 400), getContentText: () => JSON.stringify(claims || {}) }
      }
    },
    DriveApp: { getFolderById: () => root },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ text, setMimeType () { return this } })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => [...createHash('sha256').update(text).digest()].map(b => (b > 127 ? b - 256 : b)),
      formatDate: (d, tz, fmt) => fmt === 'yyyyMMdd'
        ? d.toISOString().slice(0, 10).replace(/-/g, '')
        : d.toISOString().slice(0, 16).replace(/-/g, '').replace('T', '-').replace(':', ''),
      getUuid: () => randomUUID(),
      base64EncodeWebSafe: text => Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
    },
    Session: { getScriptTimeZone: () => 'UTC', getEffectiveUser: () => ({ getEmail: () => owner }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock () {} }) }
  }
  vm.createContext(sandbox)
  const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8')
  vm.runInContext(code, sandbox)

  const call = (fn, e) => JSON.parse(sandbox[fn](e).text)
  return {
    drive,
    root,
    get: params => call('doGet', { parameter: params }),
    post: body => call('doPost', { postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }),
    fileNames: folder => (folder || root).files().map(f => f.name).sort(),
    props,
    mail,
    archive: () => drive.folders.find(f => f.name === 'archive')
  }
}

export function token (email, { aud = 'client-id', exp = 4102444800 } = {}) {
  return { iss: 'https://accounts.google.com', aud, exp: String(exp), email, email_verified: 'true' }
}
