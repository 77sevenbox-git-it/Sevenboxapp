/* Sinxronizasiya (iki istiqamətli). Bir sorğuda həm göndərir (outbox), həm də digər cihazların hadisələrini alır (pull).
   Ünvan təyin olunmayıbsa tətbiq yalnız lokal işləyir. Hər hadisənin unikal id-si var, server təkrarı yazmır.

   Sürət (Apps Script-də hər sorğu ~2–3 san çəkir, ona görə sorğu sayını və gözləməni azaldırıq):
   - yazıdan 0,3 san sonra göndərilir; gedən sorğu yalnız "yoxlama"dırsa, dayandırılıb dərhal əvəzlənir (gözləmə yoxdur);
   - yoxlamalar başlanğıcdan başlanğıca sayılır (sorğu 2,5 san çəkirsə, 4 san aralığı 4 san qalır, 6,5 san olmur);
   - hər sorğunun 30 san-lik həddi var: ilişmiş sorğu sinxronu dayandırmır;
   - nömrə aralığı sinxron sorğusunun içində gəlir (əlavə sorğu yoxdur). */
(function (root) {
  'use strict';
  var DB = root.DB, Replica = root.Replica;

  // Testlərdə dəyişdirilə bilər (Sync.timing)
  var T = { idle: 4000, fast: 1500, hidden: 15000, kick: 300, minGap: 700, errorMin: 4000, errorMax: 30000, timeout: 30000, pingTimeout: 15000, boost: 10000 };
  var BLOCKS = { productSeq: { size: 100, low: 30 }, receiptSeq: { size: 500, low: 150 } };

  var running = null, again = false, started = false, timer = null, kickTimer = null, fastUntil = 0, lastStart = 0, fails = 0, inflight = null;
  var listeners = [];
  var state = { ok: null, error: null, lastOk: null, lastRun: null, skewMs: 0 };
  var rtt = { last: 0, avg: 0 };

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
    if (e && e.timeout) return m + '. İnterneti yoxlayın; Apps Script bəzən yavaş cavab verir, sinxron özü təkrar cəhd edəcək';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      return 'Server cavab vermədi. Ən çox səbəb: Deploy-da "Who has access" = "Anyone" deyil (yalnız Google hesabına girmiş brauzerdə işləyir, digər brauzerdə yox). Yoxlama: ünvanı gizli pəncərədə açın, {"ok":true} görünməlidir. Kodu dəyişəndən sonra "New version" deploy etmək də lazımdır';
    }
    if (/Unexpected token|JSON/i.test(m)) return 'Server JSON əvəzinə səhifə qaytardı (çox güman Google giriş səhifəsi və ya Apps Script limiti). Deploy-da "Who has access" = "Anyone" olmalıdır';
    return m;
  }

  // Bütün şəbəkə sorğuları buradan keçir: zaman həddi (ilişməsin), dayandırma (handle.abort) və gecikmə ölçümü
  function request(url, init, ms, handle) {
    return new Promise(function (resolve, reject) {
      var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var done = false, t0 = Date.now();
      function fin(fn, v) { if (done) return; done = true; clearTimeout(tm); fn(v); }
      var tm = setTimeout(function () {
        var e = new Error('Server ' + Math.round(ms / 1000) + ' san ərzində cavab vermədi'); e.timeout = true;
        fin(reject, e); if (ac) ac.abort();
      }, ms);
      if (handle) handle.abort = function () { var e = new Error('Sorğu dayandırıldı'); e.aborted = true; fin(reject, e); if (ac) ac.abort(); };
      if (ac) init.signal = ac.signal;
      fetch(url, init).then(function (r) { if (!r.ok) throw new Error('Server ' + r.status); return r.json(); })
        .then(function (res) {
          var d = Date.now() - t0; rtt.last = d; rtt.avg = rtt.avg ? Math.round(rtt.avg * 0.7 + d * 0.3) : d;
          fin(resolve, res);
        }, function (e) { fin(reject, e); });
    });
  }

  // Apps Script CORS preflight qəbul etmir, ona görə text/plain göndəririk
  function post(url, body, opts) {
    opts = opts || {};
    return request(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }, opts.timeout || T.timeout, opts.handle)
      .then(function (res) {
        if (!res.ok) throw new Error(res.error === 'İcazə yoxdur' ? 'Açar uyğun gəlmir: tətbiqdəki açar Script properties-dəki SYNC_TOKEN ilə eyni olmalıdır' : (res.error || 'Server xətası'));
        return res;
      });
  }

  // Bağlantı yoxlaması: ünvan, deploy icazəsi, vərəqlər və açar (token). İki sorğu PARALEL gedir (gözləmə yarıya düşür).
  function verify(url, token) {
    var bad = checkUrl(url); if (bad) return Promise.reject(new Error(bad));
    var pingP = post(url, { action: 'ping', token: token }, { timeout: T.pingTimeout });
    pingP.catch(function () { /* nəticəsi aşağıda gözlənilir; GET xətası daha informativdir */ });
    return request(url, { method: 'GET' }, T.pingTimeout, null).then(function (res) {
      if (!res.ok || res.service !== 'magaza-is') throw new Error('Cavab gəldi, amma bu, mağaza skripti deyil');
      if (!res.tokenSet) throw new Error('Skriptdə SYNC_TOKEN təyin olunmayıb (Project Settings → Script properties)');
      if ((res.version || 0) < 3) throw new Error('Skriptin köhnə versiyası işləyir. Yeni Code.gs-i yapışdırın və Deploy → Manage deployments → Edit → New version seçin');
      if (res.missingSheets && res.missingSheets.length) throw new Error('Cədvəllərdə çatışmayan vərəqlər: ' + res.missingSheets.join(', ') + '. setup() funksiyasını işə salın');
      return pingP;
    }).then(function (p) {
      var v = (p && p.version) || 0;
      return 'Bağlantı işləyir' + (v < 5 ? '. Diqqət: skript köhnədir (v' + v + '). ' + (v < 4 ? 'Sürətli sinxron və keş düzəlişi üçün, ' : '') + 'təchizatçı və partiya cədvəllərinin Sheets-ə yazılması üçün yeni Code.gs-i yapışdırın, setup() işlədin və "New version" deploy edin (tətbiq bu olmadan da işləyir, məlumat Events vərəqində saxlanılır)' : '');
    }).catch(function (e) { throw new Error(explain(e)); });
  }

  function test() {
    return config().then(function (c) { return verify(c.url, c.token); });
  }

  /* ---------- Nömrə aralıqları ---------- */
  function remaining(b) {
    var ranges = b && b.value && b.value.ranges ? b.value.ranges : [];
    return ranges.reduce(function (a, r) { return a + Math.max(0, r[1] - r[0] + 1); }, 0);
  }

  // Hansı aralıqlar azalıb: sinxron sorğusunun içində istənilir
  function neededAlloc() {
    return Promise.all(Object.keys(BLOCKS).map(function (key) {
      return DB.get('meta', 'block:' + key).then(function (b) {
        if (remaining(b) >= BLOCKS[key].low) return null;
        return DB.get('meta', key).then(function (local) { return { key: key, count: BLOCKS[key].size, min: local ? local.value : 0 }; });
      });
    })).then(function (list) { return list.filter(Boolean); });
  }

  function storeBlocks(blocks) {
    return DB.atomic(['meta'], function (t) {
      return blocks.reduce(function (chain, b) {
        return chain.then(function () {
          return t.get('meta', 'block:' + b.key).then(function (cur) {
            var ranges = cur && cur.value && cur.value.ranges ? cur.value.ranges : [];
            ranges.push([b.from, b.to]);
            return t.put('meta', { key: 'block:' + b.key, value: { ranges: ranges } });
          });
        });
      }, Promise.resolve());
    });
  }

  // Köhnə server (v3): aralıq ayrıca "allocate" sorğusu ilə alınır
  function ensureBlocksLegacy(c) {
    return Object.keys(BLOCKS).reduce(function (chain, key) {
      return chain.then(function () {
        return DB.get('meta', 'block:' + key).then(function (b) {
          if (remaining(b) >= BLOCKS[key].low) return;
          return DB.get('meta', key).then(function (local) {
            return post(c.url, { action: 'allocate', token: c.token, key: key, count: BLOCKS[key].size, min: local ? local.value : 0 });
          }).then(function (res) { return storeBlocks([{ key: key, from: res.from, to: res.to }]); });
        });
      });
    }, Promise.resolve());
  }

  /* ---------- Bir dövr: göndər + al ---------- */
  function doCycle() {
    return config().then(function (c) {
      if (!c.url) return { sent: 0, received: 0, skipped: true };
      var bad = checkUrl(c.url); if (bad) throw new Error(bad);
      var total = { sent: 0, received: 0 }, touched = {}, cursor = c.cursor, skew = null, legacy = false;

      function step(n) {
        return Promise.all([DB.getAll('outbox'), n === 0 ? neededAlloc() : Promise.resolve([])]).then(function (r) {
          var items = r[0], alloc = r[1];
          items.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
          var batch = items.slice(0, 200);
          var sentAt = Date.now();
          var handle = {};
          inflight = { pure: !batch.length && !alloc.length, abort: function () { if (handle.abort) handle.abort(); } };
          var body = { action: 'sync', token: c.token, device: c.device, since: cursor, items: batch, limit: 500 };
          if (alloc.length) body.alloc = alloc;
          return post(c.url, body, { handle: handle }).then(function (res) {
            inflight = null;
            // Kompüterin saatı serverdən çox fərqlənirsə xəbərdarlıq (son yazan qalib qaydası saata əsaslanır)
            if (res.now) skew = Date.parse(res.now) - (sentAt + Date.now()) / 2;
            if (alloc.length && !res.blocks) legacy = true;          // köhnə server aralığı bu sorğuda vermir
            var acked = res.acked || [];
            return Promise.all(acked.map(function (id) { return DB.del('outbox', id); })).then(function () {
              total.sent += acked.length;
              return res.blocks && res.blocks.length ? storeBlocks(res.blocks) : null;
            }).then(function () {
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
          }, function (e) { inflight = null; throw e; });
        });
      }

      // Köhnə versiyadan yenilənmiş cihaz: keçmişdə buraxılmış təchizatçı/partiya hadisələrini bir dəfəlik oxuyur (hər dövrdə bir səhifə)
      function backfillPass() {
        return DB.get('meta', 'backfill').then(function (m) {
          var b = m && m.value; if (!b || b.done) return;
          return post(c.url, { action: 'sync', token: c.token, device: c.device, since: b.next, items: [], limit: 500 }).then(function (res) {
            var events = res.events || [];
            return Replica.backfill(events).then(function (sum) {
              var next = res.next || b.next;
              var done = !events.length || !res.more || next >= b.upTo;
              return DB.put('meta', { key: 'backfill', value: { upTo: b.upTo, next: next, done: done } }).then(function () {
                Object.keys(sum.touched).forEach(function (k) { touched[k] = true; });
                if (!done) fastUntil = Math.max(fastUntil, Date.now() + 3000);
              });
            });
          });
        }).catch(function () { /* doldurma alınmadısa növbəti dövrdə təkrar */ });
      }

      return step(0).then(function () { return legacy ? ensureBlocksLegacy(c) : null; }).then(backfillPass).then(function () {
        if (skew !== null) state.skewMs = Math.round(skew);
        if (total.received) fastUntil = Math.max(fastUntil, Date.now() + T.boost);   // söhbət gedir: növbəti cavab tez gəlsin
        if (Object.keys(touched).length) emit('applied', touched);
        return total;
      });
    });
  }

  // opts.push: yazıdan sonra çağırılır (gedən "yoxlama" sorğusunu dayandırıb dərhal göndərir)
  // opts.passive: zamanlayıcıdan çağırılır (dövr gedirsə, əlavə dövr yaratmır)
  function cycle(opts) {
    opts = opts || {};
    if (running) {
      if (!opts.passive) again = true;
      if (opts.push && inflight && inflight.pure) inflight.abort();
      return running;
    }
    if (root.navigator && root.navigator.onLine === false) return Promise.resolve({ sent: 0, received: 0, skipped: true });
    running = doCycle().then(function (r) {
      if (!r.skipped) { fails = 0; state = { ok: true, error: null, lastOk: new Date().toISOString(), lastRun: new Date().toISOString(), skewMs: state.skewMs }; emit('status', state); }
      return r;
    }, function (e) {
      if (e && e.aborted) return { sent: 0, received: 0, aborted: true };   // yoxlama göndərmə ilə əvəzləndi, xəta deyil
      fails++;
      state = { ok: false, error: explain(e), lastOk: state.lastOk, lastRun: new Date().toISOString(), skewMs: state.skewMs };
      emit('status', state);
      return { sent: 0, received: 0, error: state.error };
    }).then(function (r) {
      running = null; inflight = null;
      if (again) { again = false; return cycle().then(function (r2) { r2.sent = (r2.sent || 0) + (r.sent || 0); r2.received = (r2.received || 0) + (r.received || 0); return r2; }); }
      return r;
    });
    return running;
  }

  // Yazıdan sonra tez göndərmək üçün (qısa gecikmə ilə birləşdirilir)
  function kick() {
    fastUntil = Math.max(fastUntil, Date.now() + 8000);
    if (kickTimer) return;
    kickTimer = setTimeout(function () { kickTimer = null; cycle({ push: true }); }, T.kick);
  }

  // Bir müddət tez-tez yoxlama (məs. menecer təsdiqi gözlənərkən)
  function fast(ms) { fastUntil = Math.max(fastUntil, Date.now() + (ms || 60000)); if (timer) { clearTimeout(timer); timer = null; schedule(); } }

  // Login zamanı yeni PIN-i tez tutmaq üçün: dövrü gözləyir, amma uzun çəkməsin
  function pullNow(timeoutMs) {
    return Promise.race([cycle(), new Promise(function (resolve) { setTimeout(function () { resolve({ timeout: true }); }, timeoutMs || 5000); })]);
  }

  function interval() {
    if (state.ok === false) return Math.min(T.errorMin * Math.pow(2, Math.max(0, fails - 1)), T.errorMax);   // 4 → 8 → 16 → 30 san
    if (fastUntil > Date.now()) return T.fast;
    return (root.document && root.document.hidden) ? T.hidden : T.idle;
  }
  // Başlanğıcdan başlanğıca: sorğu uzun çəkibsə, gözləmə qısalır
  function schedule() {
    if (!started) return;
    var wait = Math.max(T.minGap, interval() - (Date.now() - lastStart));
    timer = setTimeout(function () { timer = null; lastStart = Date.now(); cycle({ passive: true }).then(schedule, schedule); }, wait);
  }

  function start() {
    if (started) return; started = true;
    lastStart = Date.now();
    cycle().then(schedule, schedule);
    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('visibilitychange', function () {
        if (!root.document.hidden) { fastUntil = Math.max(fastUntil, Date.now() + 6000); cycle().then(function () { emit('status', state); }); }
      });
    }
    if (root.addEventListener) {
      root.addEventListener('online', function () { cycle(); });
      root.addEventListener('focus', function () { if (Date.now() - lastStart > 2500) { lastStart = Date.now(); cycle({ passive: true }); } });
    }
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
  function status() { return Object.assign({}, state, { rtt: rtt.last, rttAvg: rtt.avg, fails: fails }); }

  root.Sync = { cycle: cycle, flush: flush, kick: kick, fast: fast, pullNow: pullNow, start: start, stop: stop, on: on, status: status,
    test: test, verify: verify, connect: connect, checkUrl: checkUrl, endpoint: endpoint, setEndpoint: setEndpoint, explain: explain, timing: T };
  if (typeof module !== 'undefined') module.exports = root.Sync;
})(typeof window !== 'undefined' ? window : globalThis);
