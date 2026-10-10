/* Service worker: tətbiq fayllarını keşdə saxlayır ki, internet olmadan açılsın (FR-100). */
var CACHE = 'magaza-v17';
var FILES = ['./', 'index.html', 'manifest.json', 'css/app.css', 'js/i18n.js', 'js/lang-ru.js', 'js/lang-en.js', 'js/lang-tr.js', 'js/money.js', 'js/barcode.js', 'js/rules.js', 'js/fifo.js', 'js/db.js',
  'js/services.js', 'js/replica.js', 'js/sync.js', 'js/notify.js', 'js/ui.js', 'js/print.js', 'js/pos.js', 'js/screens.js', 'js/app.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/badge-96.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return /^magaza-v/.test(k) && k !== CACHE; }).map(function (k) { return caches.delete(k); }));   // 'magaza-prefs' (dil seçimi) silinmir
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return; // Apps Script-ə POST sorğuları keşlənmir
  var url = new URL(req.url);
  if (url.origin === location.origin) {
    // Öz fayllarımız: əvvəl şəbəkə (yenilik üçün), olmasa keş
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(function (res) {   // no-cache: GitHub Pages-in 10 dəq HTTP keşi köhnə kodu saxlamasın (ETag ilə yoxlanır, dəyişməyibsə 304)
      // Yalnız uğurlu cavab keşlənir: deploy zamanı GitHub Pages-in 404/5xx cavabı yaxşı keş nüsxəsini əvəz edib oflayn işi pozmasın
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return caches.match(req).then(function (r) { return r || caches.match('index.html'); }); }));
  } else if (url.hostname.indexOf('fonts.') !== -1) {
    // Şriftlər: əvvəl keş
    e.respondWith(caches.match(req).then(function (r) {
      return r || fetch(req).then(function (res) { if (res.ok || res.type === 'opaque') { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); } return res; });
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

// Bildirişin dili: səhifə seçilmiş dili "magaza-prefs" keşinə yazır (SW-nin localStorage-ı yoxdur)
var PUSH_TEXT = {
  az: ['Təsdiq sorğusu', 'Kassadan menecer təsdiqi gözlənilir. Tətbiqi açın.'],
  ru: ['Запрос на подтверждение', 'Кассир ждёт подтверждения менеджера. Откройте приложение.'],
  en: ['Approval request', 'The cashier is waiting for manager approval. Open the app.'],
  tr: ['Onay isteği', 'Kasiyer yönetici onayını bekliyor. Uygulamayı açın.']
};
function pushLang() {
  return caches.open('magaza-prefs').then(function (c) { return c.match('lang'); })
    .then(function (r) { return r ? r.text() : 'az'; }).catch(function () { return 'az'; })
    .then(function (l) { return PUSH_TEXT[l] ? l : 'az'; });
}

self.addEventListener('push', function (e) {
  e.waitUntil(Promise.all([self.clients.matchAll({ type: 'window', includeUncontrolled: true }), pushLang()]).then(function (r) {
    var list = r[0], lang = r[1];
    var watching = list.some(function (c) { return c.visibilityState === 'visible' && c.focused; });
    if (watching && Date.now() > expectUntil) return;
    return self.registration.showNotification(PUSH_TEXT[lang][0], {
      body: PUSH_TEXT[lang][1],
      icon: 'icons/icon-192.png',        // böyük rəngli ikon
      badge: 'icons/badge-96.png',       // statusbardakı kiçik ikon: şəffaf fonda ağ siluet (rəngli şəkil boş boz kvadrat kimi görünür)
      tag: 'approval', renotify: true, requireInteraction: true, vibrate: [200, 100, 200], lang: lang,
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
