// Alma's service worker (T45/T46): the app shell works offline; API responses,
// conversation and pictures are never cached (BR-32). Pushes carry no payload,
// so the notification text is fixed here (PD-15).

// v4: the pairing screen no longer re-runs after the fragment is stripped (a good QR showed
// "code spent"). The shell is cache-first, so bumping is what retires the old JS on installed phones.
// v6: five destinations, the Notes screens and the bokeh styles moved out of inline attributes (spec 028).
// v7: conversations, Settings and the accessibility pass changed the built shell (index.html names new bundles; it is cache-first).
// v9: only ok responses are cached (a transient 404/500 of a bundle stuck for good) and the write is kept alive.
const SHELL = 'alma-shell-v9'
const CORE = ['./', './index.html', './manifest.webmanifest', './logo.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== SHELL).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('push', (event) => {
  // No payload to read (PD-15): fixed text in the phone's language. Mirror of
  // remote.pwa.push.text in the PWA dictionaries; the T46 test pins them equal.
  const language = typeof navigator !== 'undefined' && (navigator.language ?? '').toLowerCase().startsWith('es') ? 'es' : 'en'
  const text = language === 'es' ? 'Alma te necesita' : 'Alma needs you'
  event.waitUntil(self.registration.showNotification('Alma', { body: text }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(self.clients.openWindow('./'))
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Network only: anything under /api is conversation, approvals, home state or
  // pictures, and none of it may sit in a cache.
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ??
        fetch(event.request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            event.waitUntil(caches.open(SHELL).then((cache) => cache.put(event.request, copy)))
          }
          return response
        })
    )
  )
})
