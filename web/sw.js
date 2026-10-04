// Service worker: the app opens without a connection.
//
// Same-origin GETs (the page, its modules, ../engine/, icons, fixtures) are
// network-first: online you always get the latest published version, and every
// successful answer refreshes the cache; offline the cached copy is served.
// The Apps Script API and Google sign-in are cross-origin and never touched:
// the app keeps its data in localStorage and saves fail clearly when offline.

const CACHE = 'menu-famiglia-v1'
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
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()))
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
  try {
    const response = await withTimeout(fetch(request), TIMEOUT_MS)
    if (response.ok) cache.put(key, response.clone())
    return response
  } catch {
    const cached = await cache.match(key)
    if (cached) return cached
    return new Response('', { status: 504, statusText: 'Offline' })
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
