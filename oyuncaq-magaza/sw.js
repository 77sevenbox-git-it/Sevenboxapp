/* Service worker: tətbiq fayllarını keşdə saxlayır ki, internet olmadan açılsın (FR-100). */
var CACHE = 'magaza-v9';
var FILES = ['./', 'index.html', 'manifest.json', 'css/app.css', 'js/money.js', 'js/barcode.js', 'js/rules.js', 'js/fifo.js', 'js/db.js',
  'js/services.js', 'js/replica.js', 'js/sync.js', 'js/notify.js', 'js/ui.js', 'js/print.js', 'js/pos.js', 'js/screens.js', 'js/app.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/badge-96.png'];

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
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(function (res) {   // no-cache: GitHub Pages-in 10 dəq HTTP keşi köhnə kodu saxlamasın (ETag ilə yoxlanır, dəyişməyibsə 304)
      var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); return res;
    }).catch(function () { return caches.match(req).then(function (r) { return r || caches.match('index.html'); }); }));
  } else if (url.hostname.indexOf('fonts.') !== -1) {
    // Şriftlər: əvvəl keş
    e.respondWith(caches.match(req).then(function (r) {
      return r || fetch(req).then(function (res) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); return res; });
    }));
  }
});

/* ---------- Bildirişlər (Web Push) ----------
   Server təsdiq sorğusu gələndə boş push göndərir (mətn yoxdur): bildirişin mətnini burada özümüz qururuq.
   Tətbiq pəncərəsi ekranda və fokusdadırsa bildiriş göstərilmir (səhifə öz xəbərdarlığını verir), test push istisnadır. */
var expectUntil = 0;
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'expect-push') expectUntil = Date.now() + 60000;
});

self.addEventListener('push', function (e) {
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    var watching = list.some(function (c) { return c.visibilityState === 'visible' && c.focused; });
    if (watching && Date.now() > expectUntil) return;
    return self.registration.showNotification('Təsdiq sorğusu', {
      body: 'Kassadan menecer təsdiqi gözlənilir. Tətbiqi açın.',
      icon: 'icons/icon-192.png',        // böyük rəngli ikon
      badge: 'icons/badge-96.png',       // statusbardakı kiçik ikon: şəffaf fonda ağ siluet (rəngli şəkil boş boz kvadrat kimi görünür)
      tag: 'approval', renotify: true, requireInteraction: true, vibrate: [200, 100, 200], lang: 'az',
      data: { url: './index.html#approvals' }
    });
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) { list[i].postMessage({ type: 'open-approvals' }); return list[i].focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
