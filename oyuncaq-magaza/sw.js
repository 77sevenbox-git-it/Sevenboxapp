/* Service worker: tətbiq fayllarını keşdə saxlayır ki, internet olmadan açılsın (FR-100). */
var CACHE = 'magaza-v4';
var FILES = ['./', 'index.html', 'manifest.json', 'css/app.css', 'js/money.js', 'js/barcode.js', 'js/rules.js', 'js/db.js',
  'js/services.js', 'js/replica.js', 'js/sync.js', 'js/ui.js', 'js/pos.js', 'js/screens.js', 'js/app.js', 'icons/icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return; // Apps Script-ə POST sorğuları keşlənmir
  var url = new URL(req.url);
  if (url.origin === location.origin) {
    // Öz fayllarımız: əvvəl şəbəkə (yenilik üçün), olmasa keş
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); return res;
    }).catch(function () { return caches.match(req).then(function (r) { return r || caches.match('index.html'); }); }));
  } else if (url.hostname.indexOf('fonts.') !== -1) {
    // Şriftlər: əvvəl keş
    e.respondWith(caches.match(req).then(function (r) {
      return r || fetch(req).then(function (res) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); return res; });
    }));
  }
});
