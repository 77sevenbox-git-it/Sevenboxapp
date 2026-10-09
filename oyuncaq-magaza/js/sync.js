/* Sinxronizasiya (iki istiqamətli). Bir sorğuda həm göndərir (outbox), həm də digər cihazların hadisələrini alır (pull).
   Ünvan təyin olunmayıbsa tətbiq yalnız lokal işləyir. Hər hadisənin unikal id-si var, server təkrarı yazmır.
   Sürət: yazıdan ~0,3 san sonra göndərilir; səhifə açıq olanda 8 san-dən bir yoxlanılır, təsdiq gözlənəndə 2 san-dən bir. */
(function (root) {
  'use strict';
  var DB = root.DB, Replica = root.Replica;

  var IDLE_MS = 8000, FAST_MS = 2000, HIDDEN_MS = 60000, ERROR_MS = 20000, KICK_MS = 300;
  var BLOCKS = { productSeq: { size: 100, low: 30 }, receiptSeq: { size: 500, low: 150 } };

  var running = null, again = false, started = false, timer = null, kickTimer = null, fastUntil = 0;
  var listeners = [];
  var state = { ok: null, error: null, lastOk: null, lastRun: null, skewMs: 0 };

  function emit(kind, data) { listeners.slice().forEach(function (fn) { try { fn(kind, data); } catch (_) { /* dinləyici xətası sinxronu dayandırmasın */ } }); }
  function on(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (x) { return x !== fn; }); }; }

  function endpoint() { return DB.get('meta', 'syncUrl').then(function (m) { return m ? m.value : ''; }); }
  function setEndpoint(url, token) {
    url = String(url || '').trim(); token = String(token || '').trim();
    // Boş açar sahəsi saxlanmış tokeni silmir (sahə təhlükəsizlik üçün hər dəfə boş göstərilir)
    return DB.put('meta', { key: 'syncUrl', value: url }).then(function () { if (token) return DB.put('meta', { key: 'syncToken', value: token }); });
  }
  function config() {
    return Promise.all([DB.get('meta', 'syncUrl'), DB.get('meta', 'syncToken'), DB.get('meta', 'deviceId'), Replica.cursor()]).then(function (r) {
      return { url: r[0] ? r[0].value : '', token: r[1] ? r[1].value : '', device: r[2] ? r[2].value : '', cursor: r[3] };
    });
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
      return 'Server cavab vermədi. Ən çox səbəb: Deploy-da "Who has access" = "Anyone" deyil (yalnız Google hesabına girmiş brauzerdə işləyir, digər brauzerdə yox). Yoxlama: ünvanı gizli pəncərədə açın, {"ok":true} görünməlidir. Kodu dəyişəndən sonra "New version" deploy etmək də lazımdır';
    }
    if (/Unexpected token|JSON/i.test(m)) return 'Server JSON əvəzinə səhifə qaytardı (çox güman Google giriş səhifəsi). Deploy-da "Who has access" = "Anyone" olmalıdır';
    return m;
  }

  // Apps Script CORS preflight qəbul etmir, ona görə text/plain göndəririk
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('Server ' + r.status); return r.json(); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error === 'İcazə yoxdur' ? 'Açar uyğun gəlmir: tətbiqdəki açar Script properties-dəki SYNC_TOKEN ilə eyni olmalıdır' : (res.error || 'Server xətası'));
        return res;
      });
  }

  // Bağlantı yoxlaması: ünvan, deploy icazəsi, vərəqlər və açar (token)
  function verify(url, token) {
    var bad = checkUrl(url); if (bad) return Promise.reject(new Error(bad));
    return fetch(url, { method: 'GET' }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok || res.service !== 'magaza-is') throw new Error('Cavab gəldi, amma bu, mağaza skripti deyil');
      if (!res.tokenSet) throw new Error('Skriptdə SYNC_TOKEN təyin olunmayıb (Project Settings → Script properties)');
      if ((res.version || 0) < 3) throw new Error('Skriptin köhnə versiyası işləyir. Yeni Code.gs-i yapışdırın və Deploy → Manage deployments → Edit → New version seçin');
      if (res.missingSheets && res.missingSheets.length) throw new Error('Cədvəllərdə çatışmayan vərəqlər: ' + res.missingSheets.join(', ') + '. setup() funksiyasını işə salın');
      return post(url, { action: 'ping', token: token });
    }).then(function () { return 'Bağlantı işləyir'; }).catch(function (e) { throw new Error(explain(e)); });
  }

  function test() {
    return config().then(function (c) { return verify(c.url, c.token); });
  }

  /* ---------- Nömrə aralıqları ---------- */
  function remaining(b) {
    var ranges = b && b.value && b.value.ranges ? b.value.ranges : [];
    return ranges.reduce(function (a, r) { return a + Math.max(0, r[1] - r[0] + 1); }, 0);
  }

  function ensureBlocks(c) {
    return Object.keys(BLOCKS).reduce(function (chain, key) {
      return chain.then(function () {
        return DB.get('meta', 'block:' + key).then(function (b) {
          if (remaining(b) >= BLOCKS[key].low) return;
          return DB.get('meta', key).then(function (local) {
            return post(c.url, { action: 'allocate', token: c.token, key: key, count: BLOCKS[key].size, min: local ? local.value : 0 });
          }).then(function (res) {
            return DB.atomic(['meta'], function (t) {
              return t.get('meta', 'block:' + key).then(function (cur) {
                var ranges = cur && cur.value && cur.value.ranges ? cur.value.ranges : [];
                ranges.push([res.from, res.to]);
                return t.put('meta', { key: 'block:' + key, value: { ranges: ranges } });
              });
            });
          });
        });
      });
    }, Promise.resolve());
  }

  /* ---------- Bir dövr: göndər + al ---------- */
  function doCycle() {
    return config().then(function (c) {
      if (!c.url) return { sent: 0, received: 0, skipped: true };
      var bad = checkUrl(c.url); if (bad) throw new Error(bad);
      var total = { sent: 0, received: 0 }, touched = {}, cursor = c.cursor, skew = null;

      function step(n) {
        return DB.getAll('outbox').then(function (items) {
          items.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
          var batch = items.slice(0, 200);
          var sentAt = Date.now();
          return post(c.url, { action: 'sync', token: c.token, device: c.device, since: cursor, items: batch, limit: 300 }).then(function (res) {
            // Kompüterin saatı serverdən çox fərqlənirsə xəbərdarlıq (son yazan qalib qaydası saata əsaslanır)
            if (res.now) skew = Date.parse(res.now) - (sentAt + Date.now()) / 2;
            var acked = res.acked || [];
            return Promise.all(acked.map(function (id) { return DB.del('outbox', id); })).then(function () {
              total.sent += acked.length;
              var events = res.events || [];
              if (!events.length && res.next === cursor) return false;
              return Replica.apply(events, res.next, { force: !!res.rewind }).then(function (sum) {
                cursor = res.next;
                total.received += sum.applied;
                Object.keys(sum.touched).forEach(function (k) { touched[k] = true; });
                return true;
              });
            }).then(function () {
              if (n < 60 && (res.more || items.length > batch.length)) return step(n + 1);
            });
          });
        });
      }

      return step(0).then(function () { return ensureBlocks(c); }).then(function () {
        if (skew !== null) state.skewMs = Math.round(skew);
        if (Object.keys(touched).length) emit('applied', touched);
        return total;
      });
    });
  }

  function cycle() {
    if (running) { again = true; return running; }
    if (root.navigator && root.navigator.onLine === false) return Promise.resolve({ sent: 0, received: 0, skipped: true });
    running = doCycle().then(function (r) {
      if (!r.skipped) { state = { ok: true, error: null, lastOk: new Date().toISOString(), lastRun: new Date().toISOString(), skewMs: state.skewMs }; emit('status', state); }
      return r;
    }, function (e) {
      state = { ok: false, error: explain(e), lastOk: state.lastOk, lastRun: new Date().toISOString(), skewMs: state.skewMs };
      emit('status', state);
      return { sent: 0, received: 0, error: state.error };
    }).then(function (r) {
      running = null;
      if (again) { again = false; return cycle().then(function (r2) { r2.sent = (r2.sent || 0) + (r.sent || 0); r2.received = (r2.received || 0) + (r.received || 0); return r2; }); }
      return r;
    });
    return running;
  }

  // Yazıdan sonra tez göndərmək üçün (qısa gecikmə ilə birləşdirilir)
  function kick() {
    fastUntil = Math.max(fastUntil, Date.now() + 8000);
    if (kickTimer) return;
    kickTimer = setTimeout(function () { kickTimer = null; cycle(); }, KICK_MS);
  }

  // Bir müddət tez-tez yoxlama (məs. menecer təsdiqi gözlənərkən)
  function fast(ms) { fastUntil = Math.max(fastUntil, Date.now() + (ms || 60000)); if (timer) { clearTimeout(timer); timer = null; schedule(); } }

  // Login zamanı yeni PIN-i tez tutmaq üçün: dövrü gözləyir, amma uzun çəkməsin
  function pullNow(timeoutMs) {
    return Promise.race([cycle(), new Promise(function (resolve) { setTimeout(function () { resolve({ timeout: true }); }, timeoutMs || 5000); })]);
  }

  function delay() {
    if (state.ok === false) return ERROR_MS;
    if (fastUntil > Date.now()) return FAST_MS;
    return (root.document && root.document.hidden) ? HIDDEN_MS : IDLE_MS;
  }
  function schedule() {
    timer = setTimeout(function () { timer = null; cycle().then(schedule, schedule); }, delay());
  }

  function start() {
    if (started) return; started = true;
    cycle().then(schedule, schedule);
    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('visibilitychange', function () { if (!root.document.hidden) cycle().then(function () { emit('status', state); }); });
    }
    if (root.addEventListener) root.addEventListener('online', function () { cycle(); });
  }
  function stop() { started = false; if (timer) clearTimeout(timer); timer = null; if (kickTimer) clearTimeout(kickTimer); kickTimer = null; }

  // Yeni cihazı qoşmaq: yoxla → saxla → serverdən bütün məlumatı çək
  function connect(url, token) {
    url = String(url || '').trim(); token = String(token || '').trim();
    if (!token) return Promise.reject(new Error('Açarı (SYNC_TOKEN) yazın'));
    return verify(url, token).then(function () { return setEndpoint(url, token); }).then(function () { return cycle(); }).then(function (r) {
      if (r.error) throw new Error(r.error);
      return r;
    });
  }

  function flush() { return cycle(); }
  function status() { return state; }

  root.Sync = { cycle: cycle, flush: flush, kick: kick, fast: fast, pullNow: pullNow, start: start, stop: stop, on: on, status: status,
    test: test, verify: verify, connect: connect, checkUrl: checkUrl, endpoint: endpoint, setEndpoint: setEndpoint, explain: explain };
  if (typeof module !== 'undefined') module.exports = root.Sync;
})(typeof window !== 'undefined' ? window : globalThis);
