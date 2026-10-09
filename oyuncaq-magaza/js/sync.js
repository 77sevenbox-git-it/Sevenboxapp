/* Sinxronizasiya: outbox-dakı qeydləri Google Apps Script veb tətbiqinə göndərir (FR-102).
   Ünvan təyin olunmayıbsa tətbiq yalnız lokal işləyir. Hər qeydin unikal id-si var, server təkrarı yazmır. */
(function (root) {
  'use strict';
  var DB = root.DB;
  var running = false;

  function endpoint() { return DB.get('meta', 'syncUrl').then(function (m) { return m ? m.value : ''; }); }
  function setEndpoint(url, token) {
    url = String(url || '').trim(); token = String(token || '').trim();
    // Boş açar sahəsi saxlanmış tokeni silmir (sahə təhlükəsizlik üçün hər dəfə boş göstərilir)
    return DB.put('meta', { key: 'syncUrl', value: url }).then(function () { if (token) return DB.put('meta', { key: 'syncToken', value: token }); });
  }

  // Ünvanın formasını yoxlayır: ən çox rast gələn səhvlər redaktor linki və /dev ünvanıdır
  function checkUrl(url) {
    if (!url) return 'Ünvan boşdur';
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
      if (/\/dev$/.test(url)) return 'Bu /dev ünvanıdır, o yalnız sizin brauzerinizdə işləyir. Deploy → Manage deployments bölməsindən /exec ilə bitən ünvanı götürün';
      if (/script\.google\.com\/(home|d\/)/.test(url)) return 'Bu Apps Script redaktorunun linkidir. Deploy → Manage deployments → Web app URL lazımdır';
      return 'Ünvan https://script.google.com/macros/s/…/exec formasında olmalıdır';
    }
    return null;
  }

  // "Failed to fetch" brauzerin ümumi xətasıdır; ən çox səbəbləri istifadəçiyə izah edirik
  function explain(e) {
    var m = e && e.message || String(e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      return 'Server cavab vermədi. Ən çox səbəb: Deploy zamanı "Who has access" = "Anyone" seçilməyib, və ya kod dəyişəndən sonra yeni versiya deploy edilməyib. Ünvanı brauzerdə açın: {"ok":true} görünməlidir';
    }
    return m;
  }

  // Bağlantı testi (GET): ünvan, deploy icazəsi, token və vərəqlər
  function test() {
    return endpoint().then(function (url) {
      var bad = checkUrl(url); if (bad) throw new Error(bad);
      return fetch(url, { method: 'GET' }).then(function (r) { return r.json(); }).then(function (res) {
        if (!res.ok || res.service !== 'magaza-is') throw new Error('Cavab gəldi, amma bu, mağaza skripti deyil');
        if (!res.tokenSet) throw new Error('Skriptdə SYNC_TOKEN təyin olunmayıb (Project Settings → Script properties)');
        if (res.missingSheets && res.missingSheets.length) throw new Error('Cədvəllərdə çatışmayan vərəqlər: ' + res.missingSheets.join(', ') + '. setup() funksiyasını işə salın');
        return 'Bağlantı işləyir';
      });
    }).catch(function (e) { throw new Error(explain(e)); });
  }

  function flush() {
    if (running || (root.navigator && root.navigator.onLine === false)) return Promise.resolve({ sent: 0, skipped: true });
    running = true;
    return Promise.all([endpoint(), DB.get('meta', 'syncToken')]).then(function (cfg) {
      var url = cfg[0], token = cfg[1] ? cfg[1].value : '';
      if (!url) return { sent: 0, skipped: true };
      var bad = checkUrl(url); if (bad) throw new Error(bad);
      return DB.getAll('outbox').then(function (items) {
        items.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
        var batch = items.slice(0, 200);
        if (!batch.length) return { sent: 0 };
        // Apps Script CORS preflight qəbul etmir, ona görə text/plain göndəririk
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'sync', token: token, items: batch }) })
          .then(function (r) { if (!r.ok) throw new Error('Server ' + r.status); return r.json(); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.error === 'İcazə yoxdur' ? 'Token uyğun gəlmir: tətbiqdəki açar Script properties-dəki SYNC_TOKEN ilə eyni olmalıdır' : (res.error || 'Server xətası'));
            var acked = res.acked || [];
            return Promise.all(acked.map(function (id) { return DB.del('outbox', id); })).then(function () { return { sent: acked.length }; });
          });
      });
    }).catch(function (e) { return { sent: 0, error: explain(e) }; })
      .then(function (r) { running = false; return r; });
  }

  root.addEventListener && root.addEventListener('online', function () { flush().then(function () { root.App && root.App.refreshStatus(); }); });

  root.Sync = { flush: flush, test: test, checkUrl: checkUrl, endpoint: endpoint, setEndpoint: setEndpoint };
})(window);
