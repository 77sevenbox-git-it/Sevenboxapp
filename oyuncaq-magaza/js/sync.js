/* Sinxronizasiya: outbox-dakı qeydləri Google Apps Script veb tətbiqinə göndərir (FR-102).
   Ünvan təyin olunmayıbsa tətbiq yalnız lokal işləyir. Hər qeydin unikal id-si var, server təkrarı yazmır. */
(function (root) {
  'use strict';
  var DB = root.DB;
  var running = false;

  function endpoint() { return DB.get('meta', 'syncUrl').then(function (m) { return m ? m.value : ''; }); }
  function setEndpoint(url, token) {
    return DB.put('meta', { key: 'syncUrl', value: url || '' }).then(function () { return DB.put('meta', { key: 'syncToken', value: token || '' }); });
  }

  function flush() {
    if (running || (root.navigator && root.navigator.onLine === false)) return Promise.resolve({ sent: 0, skipped: true });
    running = true;
    return Promise.all([endpoint(), DB.get('meta', 'syncToken')]).then(function (cfg) {
      var url = cfg[0], token = cfg[1] ? cfg[1].value : '';
      if (!url) return { sent: 0, skipped: true };
      return DB.getAll('outbox').then(function (items) {
        items.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
        var batch = items.slice(0, 200);
        if (!batch.length) return { sent: 0 };
        // Apps Script CORS preflight qəbul etmir, ona görə text/plain göndəririk
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'sync', token: token, items: batch }) })
          .then(function (r) { if (!r.ok) throw new Error('Server ' + r.status); return r.json(); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.error || 'Server xətası');
            var acked = res.acked || [];
            return Promise.all(acked.map(function (id) { return DB.del('outbox', id); })).then(function () { return { sent: acked.length }; });
          });
      });
    }).catch(function (e) { return { sent: 0, error: e.message }; })
      .then(function (r) { running = false; return r; });
  }

  root.addEventListener && root.addEventListener('online', function () { flush().then(function () { root.App && root.App.refreshStatus(); }); });

  root.Sync = { flush: flush, endpoint: endpoint, setEndpoint: setEndpoint };
})(window);
