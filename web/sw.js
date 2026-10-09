// Service worker: the app opens without a connection.
//
// Same-origin GETs (the page, its modules, ../engine/, icons, fixtures) are
// network-first: online you always get the latest published version, and every
// successful answer refreshes the cache, even one that arrives after the
// timeout; offline (or after TIMEOUT_MS) the cached copy is served.
// The Apps Script API and Google sign-in are cross-origin and never touched:
// the app keeps its data in localStorage and saves fail clearly when offline.

const CACHE = 'menu-famiglia-v2'
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './api.js',
  './storage.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
  '../engine/data.js',
  '../engine/week.js',
  '../engine/rules.js',
  '../engine/planner.js',
  '../engine/shopping.js',
  '../engine/wishlist.js'
]
const TIMEOUT_MS = 4000

self.addEventListener('install', event => {
  // cache: 'reload' skips the HTTP cache, so a new worker never stores old files.
  const requests = SHELL.map(url => new Request(url, { cache: 'reload' }))
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(requests)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  event.respondWith(networkFirst(request, url))
})

async function networkFirst (request, url) {
  const cache = await caches.open(CACHE)
  // Pages opened from the share sheet or with ?demo carry a query string:
  // offline, any of them falls back to the cached page.
  const key = request.mode === 'navigate' ? new URL('./', self.location).href : url.href.split('?')[0]
  // no-cache: always ask the server (a cheap 304 when nothing changed) instead
  // of reusing the browser's copy for the 10 minutes GitHub Pages allows.
  const network = fetch(new Request(request, { cache: 'no-cache' })).then(response => {
    if (response.ok) cache.put(key, response.clone())
    return response
  })
  try {
    return await withTimeout(network, TIMEOUT_MS)
  } catch {
    // Slow or no network: serve the cached copy now; if the network answers
    // later it still refreshes the cache for the next opening.
    network.catch(() => {})
    const cached = await cache.match(key)
    if (cached) return cached
    try {
      return await network
    } catch {
      return new Response('', { status: 504, statusText: 'Offline' })
    }
  }
}

function withTimeout (promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}
