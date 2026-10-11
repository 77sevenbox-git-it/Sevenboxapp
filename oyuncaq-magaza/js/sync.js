/* Sinxronizasiya (iki istiqamətli). Bir sorğuda həm göndərir (outbox), həm də digər cihazların hadisələrini alır (pull).
   Ünvan təyin olunmayıbsa tətbiq yalnız lokal işləyir. Hər hadisənin unikal id-si var, server təkrarı yazmır.

   Sürət (Apps Script-də hər sorğu ~2–3 san çəkir, ona görə sorğu sayını və gözləməni azaldırıq):
   - yazıdan 0,3 san sonra göndərilir; gedən sorğu yalnız "yoxlama"dırsa, dayandırılıb dərhal əvəzlənir (gözləmə yoxdur);
   - yoxlamalar başlanğıcdan başlanğıca sayılır (sorğu 2,5 san çəkirsə, 4 san aralığı 4 san qalır, 6,5 san olmur);
   - hər sorğunun 30 san-lik həddi var: ilişmiş sorğu sinxronu dayandırmır;
   - nömrə aralığı sinxron sorğusunun içində gəlir (əlavə sorğu yoxdur). */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var DB = root.DB, Replica = root.Replica;

  // Testlərdə dəyişdirilə bilər (Sync.timing)
  var T = { idle: 4000, fast: 1500, hidden: 15000, kick: 300, minGap: 700, errorMin: 4000, errorMax: 30000, timeout: 30000, pingTimeout: 15000, boost: 10000 };
  var BLOCKS = { productSeq: { size: 300, low: 100 }, receiptSeq: { size: 1000, low: 400 } };   // oflayn ehtiyat: aralıq həmişə ≥ "low" qədər qalır (server tavanı BLOCK_MAX = 1000)

  var running = null, again = false, started = false, timer = null, kickTimer = null, fastUntil = 0, lastStart = 0, fails = 0, inflight = null;
  var listeners = [];
  var state = { ok: null, error: null, lastOk: null, lastRun: null, skewMs: 0, kind: null, revoked: false };
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
    return Promise.all([DB.get('meta', 'syncUrl'), DB.get('meta', 'syncToken'), DB.get('meta', 'deviceId'), Replica.cursor(), DB.get('meta', 'revoked')]).then(function (r) {
      return { url: r[0] ? r[0].value : '', token: r[1] ? r[1].value : '', device: r[2] ? r[2].value : '', cursor: r[3], revoked: !!(r[4] && r[4].value) };
    });
  }

  // Ünvanın formasını yoxlayır: ən çox rast gələn səhvlər redaktor linki və /dev ünvanıdır
  function checkUrl(url) {
    if (!url) return _t('Ünvan boşdur');
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
      if (/\/dev$/.test(url)) return _t('Bu /dev ünvanıdır, o yalnız sizin brauzerinizdə işləyir. Deploy → Manage deployments bölməsindən /exec ilə bitən ünvanı götürün');
      if (/script\.google\.com\/(home|d\/)/.test(url)) return _t('Bu Apps Script redaktorunun linkidir. Deploy → Manage deployments → Web app URL lazımdır');
      return _t('Ünvan https://script.google.com/macros/s/…/exec formasında olmalıdır');
    }
    return null;
  }

  // "Failed to fetch" brauzerin ümumi xətasıdır; ən çox səbəbləri istifadəçiyə izah edirik
  function explain(e) {
    var m = e && e.message || String(e);
    if (e && e.timeout) return _t('{0}. İnterneti yoxlayın; Apps Script bəzən yavaş cavab verir, sinxron özü təkrar cəhd edəcək', [m]);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      return _t('Server cavab vermədi. Ən çox səbəb: Deploy-da "Who has access" = "Anyone" deyil (yalnız Google hesabına girmiş brauzerdə işləyir, digər brauzerdə yox). Yoxlama: ünvanı gizli pəncərədə açın, {"ok":true} görünməlidir. Kodu dəyişəndən sonra "New version" deploy etmək də lazımdır');
    }
    if (/Unexpected token|JSON/i.test(m)) return _t('Server JSON əvəzinə səhifə qaytardı (çox güman Google giriş səhifəsi və ya Apps Script limiti). Deploy-da "Who has access" = "Anyone" olmalıdır');
    return m;
  }

  // Bütün şəbəkə sorğuları buradan keçir: zaman həddi (ilişməsin), dayandırma (handle.abort) və gecikmə ölçümü
  function request(url, init, ms, handle) {
    return new Promise(function (resolve, reject) {
      var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var done = false, t0 = Date.now();
      function fin(fn, v) { if (done) return; done = true; clearTimeout(tm); fn(v); }
      var tm = setTimeout(function () {
        var e = new Error(_t('Server {0} san ərzində cavab vermədi', [Math.round(ms / 1000)])); e.timeout = true;
        fin(reject, e); if (ac) ac.abort();
      }, ms);
      if (handle) handle.abort = function () { var e = new Error(_t('Sorğu dayandırıldı')); e.aborted = true; fin(reject, e); if (ac) ac.abort(); };
      if (ac) init.signal = ac.signal;
      fetch(url, init).then(function (r) { if (!r.ok) throw new Error(_t('Server {0}', [r.status])); return r.json(); })
        .then(function (res) {
          var d = Date.now() - t0; rtt.last = d; rtt.avg = rtt.avg ? Math.round(rtt.avg * 0.7 + d * 0.3) : d;
          fin(resolve, res);
        }, function (e) { fin(reject, e); });
    });
  }

  // Server (Code.gs) xəta mətnlərini Azərbaycanca qaytarır; bilinənlər istifadəçinin dilinə çevrilir (Code.gs-i yenidən yerləşdirməyə ehtiyac yoxdur)
  function srvErr(e) {
    switch (e) {
      case 'JSON səhvdir': return _t('JSON səhvdir');
      case 'Naməlum əməliyyat': return _t('Naməlum əməliyyat');
      case 'Naməlum açar': return _t('Naməlum açar');
      case 'Server məşğuldur, sonra təkrar olunacaq': return _t('Server məşğuldur, sonra təkrar olunacaq');
      case 'Təsdiq lazımdır': return _t('Təsdiq lazımdır');
      case 'Arxivləşdirmə gedir, bir neçə dəqiqə sonra təkrar olunacaq': return _t('Arxivləşdirmə gedir, bir neçə dəqiqə sonra təkrar olunacaq');
      case 'Bildiriş ünvanı tanınmır': return _t('Bildiriş ünvanı tanınmır');
      // Cihaz açarları (Code.gs v9)
      case 'Bu cihaz bloklanıb': return _t('Bu cihaz Admin tərəfindən bloklanıb');
      case 'ADMIN_KEY təyin olunmayıb: Apps Script-də setupAdminKey() funksiyasını işlədin': return _t('ADMIN_KEY təyin olunmayıb: Apps Script-də setupAdminKey() funksiyasını işlədin');
      case 'Çox səhv cəhd: 10 dəqiqə gözləyin': return _t('Çox səhv cəhd: 10 dəqiqə gözləyin');
      case 'Admin açarı səhvdir': return _t('Admin açarı (ADMIN_KEY) səhvdir');
      case 'Əməliyyat səhvdir': return _t('Əməliyyat səhvdir');
      case 'Müddət 1–90 gün olmalıdır': return _t('Müddət 1–90 gün olmalıdır');
      case 'Heç bir cihaza ayrıca açar verilməyib: ümumi açarı söndürmək hamını kilidləyər': return _t('Heç bir cihaza ayrıca açar verilməyib: ümumi açarı söndürmək hamını kilidləyər');
      case 'Bu kompüter hələ ümumi açarla işləyir: əvvəl ona ayrıca açar yazın': return _t('Bu kompüter hələ ümumi açarla işləyir: əvvəl ona ayrıca açar yazın');
      case 'Cihaz id-si səhvdir (3–64 simvol: hərf, rəqəm, _ və -)': return _t('Cihaz id-si səhvdir (3–64 simvol: hərf, rəqəm, _ və -)');
      case 'Cihaz bloklanıb: əvvəlcə bərpa edin': return _t('Cihaz bloklanıb: əvvəlcə bərpa edin');
      case 'Bu cihaz üçün açar artıq var. "Yeni açar" seçin': return _t('Bu cihaz üçün açar artıq var. "Yeni açar" seçin');
      case 'Cihaz tapılmadı': return _t('Cihaz tapılmadı');
      case 'Bu cihaz bildiriş üçün qeydiyyatdan keçməyib': return _t('Bu cihaz bildiriş üçün qeydiyyatdan keçməyib');
      default:
        var m24 = /^Son arxivləşdirmədən 24 saat keçməyib \((.+) UTC\)$/.exec(e || '');
        return m24 ? _t('Son arxivləşdirmədən 24 saat keçməyib ({0} UTC)', [m24[1]]) : e;
    }
  }

  // Apps Script CORS preflight qəbul etmir, ona görə text/plain göndəririk
  function post(url, body, opts) {
    opts = opts || {};
    return request(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }, opts.timeout || T.timeout, opts.handle)
      .then(function (res) {
        if (!res.ok) {
          var msg;
          if (res.error === 'İcazə yoxdur') {
            // v9 server kod göndərir; köhnə server (v8) göndərmir: onda ümumi açar mesajı
            msg = res.code === 'legacy_off' ? _t('Ümumi sinxron açarı söndürülüb. Admin-dən bu cihaz üçün ayrıca açar alın')
              : res.code ? _t('Açar bu cihaza uyğun gəlmir. Admin-dən bu cihaz üçün verilən açarı yazın')
              : _t('Açar uyğun gəlmir: tətbiqdəki açar Script properties-dəki SYNC_TOKEN ilə eyni olmalıdır');
          } else msg = srvErr(res.error) || _t('Server xətası');
          var e = new Error(msg); e.code = res.code || null; throw e;
        }
        return res;
      });
  }

  // Bağlantı yoxlaması: ünvan, deploy icazəsi, vərəqlər və açar (token). İki sorğu PARALEL gedir (gözləmə yarıya düşür).
  function verify(url, token, device) {
    var bad = checkUrl(url); if (bad) return Promise.reject(new Error(bad));
    if (device === undefined) return DB.get('meta', 'deviceId').then(function (m) { return verify(url, token, m ? m.value : ''); });
    var pingP = post(url, { action: 'ping', token: token, device: device || undefined }, { timeout: T.pingTimeout });
    pingP.catch(function () { /* nəticəsi aşağıda gözlənilir; GET xətası daha informativdir */ });
    return request(url, { method: 'GET' }, T.pingTimeout, null).then(function (res) {
      if (!res.ok || res.service !== 'magaza-is') throw new Error(_t('Cavab gəldi, amma bu, mağaza skripti deyil'));
      if (!res.tokenSet) throw new Error(_t('Skriptdə SYNC_TOKEN təyin olunmayıb (Project Settings → Script properties)'));
      if ((res.version || 0) < 3) throw new Error(_t('Skriptin köhnə versiyası işləyir. Yeni Code.gs-i yapışdırın və Deploy → Manage deployments → Edit → New version seçin'));
      if (res.missingSheets && res.missingSheets.length) throw new Error(_t('Cədvəllərdə çatışmayan vərəqlər: {0}. setup() funksiyasını işə salın', [res.missingSheets.join(', ')]));
      return pingP;
    }).then(function (p) {
      var v = (p && p.version) || 0;
      var legacyNote = p && p.kind === 'legacy' && v >= 9
        ? '. ' + _t('Bu cihaz hələ ümumi açarla işləyir{0}. Admin-dən bu cihaz üçün ayrıca açar alın.', [p.legacyUntil ? _t(' (son tarix: {0})', [String(p.legacyUntil).slice(0, 10)]) : '']) : '';
      return _t('Bağlantı işləyir{0}', [(v < 6 ? _t('. Diqqət: skript köhnədir (v{0}). {1}{2}telefona bildiriş üçün yeni Code.gs-i yapışdırın, setup() işlədin və "New version" deploy edin (tətbiq bu olmadan da işləyir, məlumat Events vərəqində saxlanılır)', [v, (v < 4 ? _t('Sürətli sinxron və keş düzəlişi, ') : ''), (v < 5 ? _t('təchizatçı/partiya cədvəllərinin Sheets-ə yazılması, ') : '')]) : '')]) + legacyNote;
    }).catch(function (e) { var ne = new Error(explain(e)); ne.code = e && e.code || null; throw ne; });
  }

  function test() {
    return config().then(function (c) { return verify(c.url, c.token, c.device); });
  }

  // Sinxron dövrü olmayan tək əməliyyat (bildiriş qeydiyyatı və s.). Server qoşulmayıbsa xəta.
  function api(action, extra, opts) {
    return config().then(function (c) {
      if (!c.url || !c.token) throw new Error(_t('Server qoşulmayıb'));
      return post(c.url, Object.assign({ action: action, token: c.token, device: c.device }, extra || {}), { timeout: opts && opts.timeout || 25000 });
    });
  }

  // Arxivləşdirmə (Code.gs v7): Admin ekranı. Status sürətlidir; arxivləşdirmə Drive-da fayl nüsxəsi yaradır, ona görə uzun gözləmə (Apps Script limiti 6 dəq)
  function archiveStatus() { return api('archive.status'); }
  function archiveRun() { return api('archive.run', { confirm: 'ARXIV' }, { timeout: 340000 }); }

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

  // Böyük əməliyyat (toplu məhsul yükləmə) üçün n ədəd nömrə ehtiyatı: yetərli deyilsə serverdən dərhal alınır ("allocate" bütün server versiyalarında var).
  // Server qoşulmayıbsa (yalnız lokal iş) lokal sayğac işləyir, ehtiyat lazım deyil. Server qoşulub, amma əlçatmazdırsa xəta: nömrələr toqquşmamalıdır.
  function reserve(key, n) {
    if (!BLOCKS[key]) return Promise.reject(new Error(_t('Naməlum açar')));
    return config().then(function (c) {
      if (!c.url || !c.token) return { local: true };
      return DB.get('meta', 'block:' + key).then(function (b) {
        var have = remaining(b), need = n - have;
        if (need <= 0) return { have: have };
        return DB.get('meta', key).then(function (local) {
          return post(c.url, { action: 'allocate', token: c.token, device: c.device, key: key, count: need, min: local ? local.value : 0 }, { timeout: 25000 });
        }).then(function (res) {
          return storeBlocks([{ key: key, from: res.from, to: res.to }]).then(function () { return { have: have + (res.to - res.from + 1) }; });
        }, function (e) {
          throw new Error(_t('Toplu əməliyyat üçün serverə qoşulmaq lazımdır: {0}', [explain(e)]));
        });
      });
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
      if (!c.url || c.revoked) return { sent: 0, received: 0, skipped: true };
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
            if (res.kind) state.kind = res.kind;
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
        if (skew !== null) { state.skewMs = Math.round(skew); if (root.Services && root.Services.setClockOffset) root.Services.setClockOffset(skew); }
        if (total.received) fastUntil = Math.max(fastUntil, Date.now() + T.boost);   // söhbət gedir: növbəti cavab tez gəlsin
        if (Object.keys(touched).length) emit('applied', touched);
        return total;
      });
    });
  }

  /* ---------- Bloklanmış cihaz (Code.gs v9, FR-101) ----------
     Admin cihazı ləğv edəndə server "revoked" qaytarır. Cihaz kilidlənir (giriş ekranı əvəzinə "bloklanıb" səhifəsi), məlumat SİLİNMİR,
     sinxron dayanır. Göndərilməmiş qeydləri Admin kodu ilə fayl kimi çıxarmaq olur (exportOutbox), Admin onu işləyən cihaza yükləyir (importOutbox). */
  function markRevoked() {
    return DB.put('meta', { key: 'revoked', value: { at: new Date().toISOString() } }).then(function () {
      state = { ok: false, error: _t('Bu cihaz Admin tərəfindən bloklanıb'), lastOk: state.lastOk, lastRun: new Date().toISOString(), skewMs: state.skewMs, kind: state.kind, revoked: true };
      emit('revoked', state); emit('status', state);
      return { sent: 0, received: 0, revoked: true, error: state.error };
    });
  }
  function isRevoked() { return DB.get('meta', 'revoked').then(function (m) { return !!(m && m.value); }); }
  // Admin cihazı bərpa edibsə kilid açılır (köhnə açar yenidən işləyir). true = açıldı.
  function recheck() {
    return config().then(function (c) {
      if (!c.url || !c.token) return false;
      return post(c.url, { action: 'ping', token: c.token, device: c.device || undefined }, { timeout: T.pingTimeout }).then(function () {
        return DB.del('meta', 'revoked').then(function () { state.revoked = false; emit('status', state); return true; });
      }, function (e) {
        if (e && e.code === 'revoked') return false;
        throw new Error(explain(e));
      });
    });
  }
  var OUTBOX_FORMAT = '7boxs-outbox';
  function exportOutbox() {
    return Promise.all([DB.getAll('outbox'), DB.get('meta', 'deviceId')]).then(function (r) {
      var items = r[0].slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
      return { count: items.length, text: JSON.stringify({ format: OUTBOX_FORMAT, v: 1, device: r[1] ? r[1].value : '', exportedAt: new Date().toISOString(), items: items }) };
    });
  }
  // Fayldakı hadisələr bu cihazın göndərmə növbəsinə qoyulur; server onları ilkin cihazın adı ilə yazır, hamı (bu cihaz da) normal yolla alır.
  function importOutbox(text) {
    var data;
    try { data = JSON.parse(String(text)); } catch (e) { return Promise.reject(new Error(_t('Fayl oxunmadı: bu, 7BOXS növbə faylı deyil'))); }
    if (!data || data.format !== OUTBOX_FORMAT || !Array.isArray(data.items)) return Promise.reject(new Error(_t('Fayl oxunmadı: bu, 7BOXS növbə faylı deyil')));
    if (data.items.length > 20000) return Promise.reject(new Error(_t('Fayl çox böyükdür')));
    var good = data.items.filter(function (it) {
      return it && typeof it === 'object' && typeof it.id === 'string' && it.id.length > 0 && it.id.length <= 200 && typeof it.at === 'string' && it.at.length <= 40 &&
        typeof it.type === 'string' && /^[\w.]{1,60}$/.test(it.type) && it.data && typeof it.data === 'object' && typeof it.userId === 'string' && it.userId.length <= 120 &&
        typeof it.device === 'string' && it.device.length <= 200;
    }).map(function (it) { return { id: it.id, at: it.at, type: it.type, data: it.data, userId: it.userId, device: it.device }; });
    var added = 0;
    return DB.atomic(['outbox'], function (t) {
      return good.reduce(function (chain, it) {
        return chain.then(function () { return t.get('outbox', it.id).then(function (have) { if (have) return; added++; return t.put('outbox', it); }); });
      }, Promise.resolve());
    }).then(function () { if (added) kick(); return { added: added, skipped: data.items.length - added }; });
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
      if (!r.skipped) { fails = 0; state = { ok: true, error: null, lastOk: new Date().toISOString(), lastRun: new Date().toISOString(), skewMs: state.skewMs, kind: state.kind, revoked: false }; emit('status', state); }
      return r;
    }, function (e) {
      if (e && e.aborted) return { sent: 0, received: 0, aborted: true };   // yoxlama göndərmə ilə əvəzləndi, xəta deyil
      if (e && e.code === 'revoked') return markRevoked();                    // Admin bu cihazı bağlayıb: sinxron dayanır, tətbiq kilidlənir
      fails++;
      state = { ok: false, error: explain(e), lastOk: state.lastOk, lastRun: new Date().toISOString(), skewMs: state.skewMs, kind: state.kind, revoked: false };
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
    if (!token) return Promise.reject(new Error(_t('Açarı (SYNC_TOKEN) yazın')));
    return verify(url, token).then(function () { return setEndpoint(url, token); }).then(function () { return DB.del('meta', 'revoked'); }).then(function () { return cycle(); }).then(function (r) {
      if (r.error) throw new Error(r.error);
      return r;
    });
  }

  function flush() { return cycle(); }
  function status() { return Object.assign({}, state, { rtt: rtt.last, rttAvg: rtt.avg, fails: fails }); }

  root.Sync = { cycle: cycle, flush: flush, kick: kick, fast: fast, pullNow: pullNow, start: start, stop: stop, on: on, status: status,
    test: test, api: api, reserve: reserve, isRevoked: isRevoked, recheck: recheck, exportOutbox: exportOutbox, importOutbox: importOutbox, archiveStatus: archiveStatus, archiveRun: archiveRun, verify: verify, connect: connect, checkUrl: checkUrl, endpoint: endpoint, setEndpoint: setEndpoint, explain: explain, timing: T };
  if (typeof module !== 'undefined') module.exports = root.Sync;
})(typeof window !== 'undefined' ? window : globalThis);
