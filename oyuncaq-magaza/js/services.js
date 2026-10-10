/* Tətbiq qatı: məhsul, satış, qaytarma, növbə, istifadəçi və audit əməliyyatları.
   Hər yazı əməliyyatı: icazə yoxlanır → atomik tranzaksiya → audit → outbox (serverə sinxron üçün). */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var DB = root.DB, Rules = root.Rules, Money = root.Money, Barcode = root.Barcode;

  function err(msg, code) { var e = new Error(msg); e.code = code || 'error'; return e; }
  // Hər çağırış əvvəlkindən ciddi böyük vaxt qaytarır: eyni cihazın iki ardıcıl yazısı eyni millisaniyəyə düşməsin (son yazan qalib qaydası üçün)
  var lastNow = 0;
  // Cihazın saatı serverdən 1 dəq.-dən çox fərqlənirsə, hadisə damğaları serverin saatına görə düzəldilir (saatı yanlış cihaz "son yazan qalib" qaydasını pozmasın)
  var clockOffset = 0;
  function nowMs() { return Date.now() + clockOffset; }
  function now() { var t = nowMs(); if (t <= lastNow) t = lastNow + 1; lastNow = t; return new Date(t).toISOString(); }
  function setClockOffset(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || Math.abs(ms) > 30 * 86400000) return Promise.resolve();   // 30 gündən böyük fərq ağlabatan deyil (səhv/saxta cavab): düzəliş tətbiq olunmur
    var v = Math.abs(ms) > 60000 ? Math.round(ms) : 0;
    if (v === clockOffset || (v && clockOffset && Math.abs(v - clockOffset) < 5000)) return Promise.resolve();   // ölçmə səs-küyünə görə hər dövrdə yazma
    if (lastNow) lastNow += v - clockOffset;           // əvvəlki (yanlış saatla verilmiş) damğaları da yeni saata köçür ki, "ciddi artan" qaydası düzgün saatı geridə saxlamasın
    clockOffset = v;
    return DB.put('meta', { key: 'clockOffset', value: v }).catch(function () { /* növbəti dövrdə təkrar */ });
  }
  // Mövcud qeydi dəyişən əməliyyat üçün: vaxt həmin qeydin gördüyümüz versiyasından ciddi sonra olmalıdır (eyni millisaniyə / geri qalan saat "son yazan qalib"də redaktəni itirməsin)
  function nowAfter(prevIso) { var p = Date.parse(prevIso || ''); if (p && p > lastNow) lastNow = p; return now(); }

  /* ---------- Təhlükəsizlik ---------- */
  function toHex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  function hashPin(pin, salt) {
    var data = new TextEncoder().encode(salt + ':' + pin);
    return root.crypto.subtle.digest('SHA-256', data).then(toHex);
  }
  function newSalt() { return toHex(root.crypto.getRandomValues(new Uint8Array(16))); }

  // Şifrə (password) forması: PBKDF2-SHA256. Hash "p1$<təkrar sayı>$<hex>" kimi saxlanır: forma və təkrar sayı hash-ın özündən oxunur
  // (təkrar sayını sonra artırmaq olar, köhnə hash-lar işləməyə davam edir). PIN: köhnə qaydada duz+SHA-256 (4–8 rəqəm üçün yavaş KDF mənasızdır, hücum yenə də saniyələrlədir).
  var PBKDF2_ITER = 310000, PW_RE = /^p1\$(\d{5,7})\$([0-9a-f]{64})$/;
  function pbkdf2(secret, salt, iter) {
    var enc = new TextEncoder();
    return root.crypto.subtle.importKey('raw', enc.encode(String(secret == null ? '' : secret).normalize('NFC')), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return root.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iter }, k, 256);
    }).then(function (bits) { return 'p1$' + iter + '$' + toHex(bits); });
  }
  function credOf(u) { return PW_RE.test(String(u && u.pinHash || '')) ? 'password' : 'pin'; }       // istifadəçinin HAZIRKI giriş forması (hash formatından)
  function hashFor(form, secret, salt) { return form === 'password' ? pbkdf2(secret, salt, PBKDF2_ITER) : hashPin(String(secret == null ? '' : secret), salt); }
  // Yazılan kod istifadəçinin saxlanılan hash-ına uyğundur? (formanı hash-ın formatı müəyyən edir; yanlış formatlı/şübhəli təkrar sayı rədd olunur)
  function checkSecret(u, secret) {
    var m = PW_RE.exec(String(u.pinHash || ''));
    if (!m) return hashPin(String(secret == null ? '' : secret), u.salt).then(function (h) { return h === u.pinHash; });
    var iter = parseInt(m[1], 10);
    if (iter < 10000 || iter > 1000000) return Promise.resolve(false);
    return pbkdf2(secret, u.salt, iter).then(function (h) { return h === u.pinHash; });
  }
  // Müvəqqəti PIN: kriptoqrafik təsadüfi 6 rəqəm (Math.random proqnozlaşdırıla bilər)
  function tempPin() { return String(100000 + (root.crypto.getRandomValues(new Uint32Array(1))[0] % 900000)); }
  function randInt(n) { var a = new Uint32Array(1), lim = 4294967296 - (4294967296 % n); do { root.crypto.getRandomValues(a); } while (a[0] >= lim); return a[0] % n; }
  // Müvəqqəti şifrə: 12 simvol (3 böyük, 4 kiçik, 3 rəqəm, 2 işarə; oxşar simvollar çıxarılıb), qarışdırılıb. Qaydalara həmişə uyğundur.
  function tempPassword() {
    function pick(s, k) { var o = []; for (var i = 0; i < k; i++) o.push(s.charAt(randInt(s.length))); return o; }
    var out = [].concat(pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 3), pick('abcdefghijkmnpqrstuvwxyz', 4), pick('23456789', 3), pick('!@#$%&*?+=', 2));
    for (var i = out.length - 1; i > 0; i--) { var j = randInt(i + 1), x = out[i]; out[i] = out[j]; out[j] = x; }
    return out.join('');
  }
  function tempFor(form) { return form === 'password' ? tempPassword() : tempPin(); }

  var session = { user: null };

  function matrix() { return DB.get('meta', 'matrix').then(function (m) { return m ? m.value : Rules.DEFAULT_MATRIX; }); }

  // Rol və "aktiv" bayrağı hər dəfə bazadan oxunur: başqa cihazda Admin rolu dəyişibsə və ya hesabı söndürübsə bu cihazda köhnə səlahiyyət qalmasın.
  // perm massivdirsə, onlardan biri kifayətdir.
  function requirePerm(perm, user) {
    var live = !user;
    user = user || session.user;
    if (!user) return Promise.reject(err(_t('Daxil olun'), 'auth'));
    var perms = [].concat(perm);
    return Promise.all([matrix(), live ? DB.get('users', user.id) : Promise.resolve(null)]).then(function (r) {
      if (live) {
        var u = r[1];
        if (!u || !u.active) throw err(_t('Hesabınız söndürülüb. Yenidən daxil olun'), 'auth');
        user.role = u.role; user.name = u.name;
      }
      if (!perms.some(function (p) { return Rules.can(r[0], user.role, p); })) throw err(_t('Bu əməliyyata icazəniz yoxdur: {0}', [(Rules.PERMISSIONS[perms[0]] || perms[0])]), 'forbidden');
      return user;
    });
  }

  var EPOCH = '1970-01-01T00:00:00.000Z';
  var device = null;        // bu brauzerin/cihazın sabit nömrəsi (hadisələrin mənşəyini göstərir)
  var evCounter = 0;

  // Audit və outbox eyni tranzaksiyada yazılır ki, biri olub digəri olmasın.
  // Outbox id-si: vaxt + artan say + audit id → eyni millisaniyədə də sıra pozulmur (məs. məhsul → mal qəbulu).
  // Hadisə Sheets-in bir xanasına sığmalıdır (50 000 simvol). Sığmayanı server qəbul edib işarələyir, amma digər cihazlar onu görməzdi —
  // ona görə əməliyyat YAZILMADAN rədd edilir (tranzaksiya geri qaytarılır) və istifadəçiyə bölməyi deyilir.
  var EVENT_MAX_CHARS = 45000;
  function log(t, type, data, user, at) {
    var size = JSON.stringify(data == null ? {} : data).length;
    if (size > EVENT_MAX_CHARS) return Promise.reject(err(_t('Əməliyyat çox böyükdür ({0} simvol, ən çoxu {1}). Daha kiçik hissələrə bölün', [size, EVENT_MAX_CHARS]), 'event_too_big'));
    var ts = at || now();
    var entry = { id: DB.uid('a'), at: ts, type: type, userId: user ? user.id : null, userName: user ? user.name : null, data: data };
    evCounter = (evCounter + 1) % 1000000;
    var eid = ts + '_' + String(evCounter).padStart(6, '0') + '_' + entry.id;
    return t.put('audit', entry).then(function () {
      return t.put('outbox', { id: eid, at: ts, type: type, data: data, userId: entry.userId, device: device });
    }).then(function () { if (root.Sync && root.Sync.kick) root.Sync.kick(); });
  }

  // Nömrə aralıqları: server cihazlara ayrı-ayrı aralıq verir ki, iki kassada eyni barkod/çek nömrəsi olmasın.
  // Aralıq heç vaxt alınmayıbsa (server qoşulmayıb) lokal sayğac işləyir.
  function nextSeq(t, key) {
    return t.get('meta', 'block:' + key).then(function (b) {
      var ranges = b && b.value && b.value.ranges ? b.value.ranges : null;
      if (ranges) {
        while (ranges.length && ranges[0][0] > ranges[0][1]) ranges.shift();
        if (ranges.length) {
          var v = ranges[0][0]++;
          return t.put('meta', { key: 'block:' + key, value: { ranges: ranges } }).then(function () { return v; });
        }
        throw err(_t('Nömrə ehtiyatı bitib. İnternetə qoşulun və bir neçə saniyə gözləyin'), 'seq_exhausted');
      }
      return t.get('meta', key).then(function (m) {
        var v2 = (m ? m.value : 0) + 1;
        return t.put('meta', { key: key, value: v2 }).then(function () { return v2; });
      });
    });
  }

  /* ---------- İlkin quraşdırma ---------- */
  // Sabit id-lər: bütün brauzerlərdə eyni istifadəçi eyni id-yə malikdir, ona görə PIN dəyişikliyi serverdən düzgün yayılır
  var DEMO_USERS = [
    { id: 'u_admin', name: 'Admin', role: 'admin', pin: '1234' },
    { id: 'u_menecer', name: 'Menecer', role: 'menecer', pin: '2222' },
    { id: 'u_kassir', name: 'Kassir', role: 'kassir', pin: '1111' },
    { id: 'u_muhasib1', name: 'Mühasib 1', role: 'muhasib', pin: '3333' },
    { id: 'u_muhasib2', name: 'Mühasib 2', role: 'muhasib', pin: '4444' }
  ];

  function loadDevice() {
    return DB.get('meta', 'deviceId').then(function (m) {
      if (m) { device = m.value; return; }
      device = DB.uid('d');
      return DB.put('meta', { key: 'deviceId', value: device });
    });
  }

  // Köhnə (v1) bazanı yeni sxemə keçirir: təsadüfi istifadəçi id-ləri sabit id-lərlə əvəzlənir və serverə göndərilir
  function migrate() {
    return migrateV2().then(migrateV3).then(migrateV4).then(migrateV5).then(migrateV6);
  }

  // v5 → v6: təchizatçı ödənişləri ("supplier.pay" icazəsi, "supplierPays" anbarı). Köhnə versiyalı cihaz yeni hadisələri tanımayıb ötürmüş ola bilər:
  // bir dəfəlik "doldurma" onları serverdən alır (idempotent hadisələr: supplier.paid / supplier.pay_voided; kassa hərəkəti cash.out/in artıq köhnə cihazda da işləyir).
  function migrateV6() {
    return DB.get('meta', 'schema').then(function (m) {
      if (m && m.value >= 6) return;
      return DB.get('meta', 'syncCursor').then(function (c) {
        var cur = c ? c.value : 0;
        return DB.atomic(['meta'], function (t) {
          return t.get('meta', 'matrix').then(function (x) {
            return t.put('meta', { key: 'matrix', value: Rules.upgradeMatrix(x ? x.value : Rules.DEFAULT_MATRIX) });
          }).then(function () { return t.put('meta', { key: 'backfill', value: { upTo: cur, next: 0, done: cur === 0 } }); })
            .then(function () { return t.put('meta', { key: 'schema', value: 6 }); });
        });
      });
    });
  }

  // v4 → v5: "stock.request" icazəsi (kassir mal gəldiyini menecerə sorğu ilə bildirir). Köhnə matris eyni qaydayla yenilənir.
  function migrateV5() {
    return DB.get('meta', 'schema').then(function (m) {
      if (m && m.value >= 5) return;
      return DB.atomic(['meta'], function (t) {
        return t.get('meta', 'matrix').then(function (x) {
          return t.put('meta', { key: 'matrix', value: Rules.upgradeMatrix(x ? x.value : Rules.DEFAULT_MATRIX) });
        }).then(function () { return t.put('meta', { key: 'schema', value: 5 }); });
      });
    });
  }

  // v3 → v4: təchizatçılar və partiyalar. İcazə matrisi yenilənir; köhnə cihazın artıq buraxdığı təchizatçı/partiya hadisələri
  // serverdən bir dəfəlik "doldurma" ilə alınır (sync.js, meta.backfill). Təzə cihazda doldurma lazım deyil.
  function migrateV4() {
    return DB.get('meta', 'schema').then(function (m) {
      if (m && m.value >= 4) return;
      return Promise.all([DB.get('meta', 'matrix'), DB.get('meta', 'syncCursor')]).then(function (r) {
        var cur = r[1] ? r[1].value : 0;
        return DB.atomic(['meta'], function (t) {
          return t.put('meta', { key: 'matrix', value: Rules.upgradeMatrix(r[0] ? r[0].value : Rules.DEFAULT_MATRIX) })
            .then(function () { return t.put('meta', { key: 'backfill', value: { upTo: cur, next: 0, done: cur === 0 } }); })
            .then(function () { return t.put('meta', { key: 'schema', value: 4 }); });
        });
      });
    });
  }

  // v2 → v3: mal qəbulu ayrıca "stock.receive" icazəsi oldu; əvvəl "product.edit" olan rollara verilir (Kassirə verilmir)
  function migrateV3() {
    return DB.get('meta', 'schema').then(function (m) {
      if (m && m.value >= 3) return;
      return DB.atomic(['meta'], function (t) {
        return t.get('meta', 'matrix').then(function (x) {
          var up = Rules.upgradeMatrix(x ? x.value : Rules.DEFAULT_MATRIX);
          return t.put('meta', { key: 'matrix', value: up });
        }).then(function () { return t.put('meta', { key: 'schema', value: 3 }); });
      });
    });
  }

  function migrateV2() {
    return DB.get('meta', 'schema').then(function (m) {
      if (m && m.value >= 2) return;
      return DB.getAll('users').then(function (users) {
        var byName = {}; DEMO_USERS.forEach(function (d) { byName[d.name] = d; });
        var ts = now();
        return DB.atomic(['users', 'meta', 'audit', 'outbox'], function (t) {
          var ops = [];
          users.forEach(function (u) {
            var d = byName[u.name];
            var nu = Object.assign({}, u, { id: d ? d.id : u.id, updatedAt: u.mustChangePin ? EPOCH : ts });
            if (nu.id !== u.id) ops.push(t.del('users', u.id));
            ops.push(t.put('users', nu));
            ops.push(log(t, 'user.upserted', { user: nu, reason: 'migrate' }, null));
          });
          ops.push(t.get('meta', 'matrixAt').then(function (x) { if (!x) return t.put('meta', { key: 'matrixAt', value: EPOCH }); }));
          ops.push(t.get('meta', 'storeAt').then(function (x) { if (!x) return t.put('meta', { key: 'storeAt', value: EPOCH }); }));
          ops.push(t.put('meta', { key: 'schema', value: 2 }));
          return Promise.all(ops);
        });
      });
    });
  }

  function init() {
    return DB.open().then(function () { return DB.get('meta', 'clockOffset'); }).then(function (c) {
      if (c && typeof c.value === 'number' && isFinite(c.value)) clockOffset = c.value;
      return DB.get('meta', 'initialized');
    }).then(function (done) {
      if (done) return loadDevice().then(migrate);
      return loadDevice().then(function () {
        return Promise.all(DEMO_USERS.map(function (u) {
          var salt = newSalt();
          return hashPin(u.pin, salt).then(function (h) {
            return { id: u.id, name: u.name, role: u.role, salt: salt, pinHash: h, active: true, mustChangePin: true, updatedAt: EPOCH };
          });
        }));
      }).then(function (users) {
        return DB.atomic(['users', 'meta', 'audit', 'outbox'], function (t) {
          return Promise.all(users.map(function (u) {
            return t.put('users', u).then(function () { return log(t, 'user.upserted', { user: u, reason: 'seed' }, null); });
          })).then(function () {
            return Promise.all([
              t.put('meta', { key: 'matrix', value: Rules.DEFAULT_MATRIX }),
              t.put('meta', { key: 'matrixAt', value: EPOCH }),
              t.put('meta', { key: 'store', value: { name: '[Mağaza adı]', voen: '[VÖEN]', address: '[Ünvan]', registerName: 'Kassa 1' } }),
              t.put('meta', { key: 'storeAt', value: EPOCH }),
              t.put('meta', { key: 'schema', value: 6 }),
              t.put('meta', { key: 'initialized', value: now() })
            ]);
          });
        });
      });
    });
  }

  function storeInfo() { return DB.get('meta', 'store').then(function (m) { return m.value; }); }
  function deviceId() { return device; }

  /* ---------- Giriş ---------- */
  // Giriş ekranı üçün: yalnız ad/rol və HAZIRKI giriş forması (pin/password); hash və duz heç vaxt
  function listUsers() {
    return DB.getAll('users').then(function (us) {
      return us.filter(function (u) { return u.active; }).map(function (u) { return { id: u.id, name: u.name, role: u.role, cred: credOf(u) }; });
    });
  }

  // Girişsiz çağırış heç nə qaytarmasın (daxili istifadə üçün getAuthPolicy login-in içində girişsiz də işləyir)
  function whenLoggedIn(fn) { return function () { var a = arguments; if (!session.user) return Promise.reject(err(_t('Daxil olun'), 'auth')); return fn.apply(null, a); }; }
  // Rol üzrə giriş forması siyasəti (Admin seçir). İlkin: hamı PIN.
  function getAuthPolicy() { return DB.get('meta', 'authPolicy').then(function (m) { return Rules.normalizeAuth(m && m.value); }); }
  // İstifadəçi hazırkı formasından fərqli formaya keçməlidir (siyasət dəyişib / rolu dəyişib) və ya Admin müvəqqəti kod verib
  function needsChange(u, policy) { return !!u.mustChangePin || credOf(u) !== (policy[u.role] || 'pin'); }
  function setAuthPolicy(next) {
    return requirePerm('admin.permissions').then(function (user) {
      if (!next || typeof next !== 'object') throw err(_t('Giriş forması səhvdir'));
      var keys = Object.keys(next);
      if (keys.some(function (r) { return !Rules.DEFAULT_AUTH.hasOwnProperty(r) || Rules.AUTH_FORMS.indexOf(next[r]) === -1; })) throw err(_t('Giriş forması səhvdir'));
      var at = now();
      return DB.atomic(['meta', 'audit', 'outbox'], function (t) {
        return t.get('meta', 'authPolicy').then(function (old) {
          var before = Rules.normalizeAuth(old && old.value);
          // Yalnız göndərilən rollar dəyişir; qalanları hazırkı qalır (qismən yeniləmə başqa rolları "pin"ə qaytarmasın)
          var pol = Rules.normalizeAuth(Object.assign({}, before, next));
          if (JSON.stringify(before) === JSON.stringify(pol)) return { policy: pol, unchanged: true };
          return t.put('meta', { key: 'authPolicy', value: pol }).then(function () { return t.put('meta', { key: 'authPolicyAt', value: at }); })
            .then(function () { return log(t, 'admin.auth_policy_changed', { before: before, after: pol }, user, at); })
            .then(function () { return { policy: pol }; });
        });
      });
    });
  }
  // Cari istifadəçinin keçməli olduğu forma (siyasətə görə) — məcburi dəyişmə ekranı üçün
  function myCredTarget() {
    var me = session.user; if (!me) return Promise.reject(err(_t('Daxil olun'), 'auth'));
    return Promise.all([DB.get('users', me.id), getAuthPolicy()]).then(function (r) { return { form: r[1][(r[0] || me).role] || 'pin', current: r[0] ? credOf(r[0]) : 'pin' }; });
  }
  // Təsdiq pəncərəsi üçün: təsdiq edə bilən aktiv şəxslərin hamısı PIN-dədirsə 'pin', yoxsa 'any' (PIN və ya şifrə yazıla bilər)
  function approverForm(perm) {
    return Promise.all([DB.getAll('users'), matrix()]).then(function (r) {
      var cands = r[0].filter(function (u) { return u.active && Rules.can(r[1], u.role, perm); });
      return cands.some(function (u) { return credOf(u) === 'password'; }) ? 'any' : 'pin';
    });
  }

  function verifyPin(userId, pin) {
    return DB.get('users', userId).then(function (u) {
      if (!u || !u.active) throw err(_t('İstifadəçi tapılmadı'));
      return checkSecret(u, pin).then(function (ok) { return { u: u, ok: ok }; });
    });
  }

  // Yanlış PIN sayğacı cihazın bazasında (meta.authFail) saxlanılır: səhifəni yeniləmək (F5) və ya tabı yenidən açmaq sayğacı sıfırlamır. Serverə getmir.
  function loadFail(userId) {
    return DB.get('meta', 'authFail').then(function (m) {
      var v = m && m.value && Object.prototype.hasOwnProperty.call(m.value, userId) ? m.value[userId] : null;
      return v ? { n: v.n | 0, until: Number(v.until) || 0 } : { n: 0, until: 0 };
    });
  }
  function login(userId, pin) {
    return loadFail(userId).then(function (f) {
      if (Date.now() < f.until) throw err(_t('Çox səhv cəhd. {0} dəqiqə gözləyin', [Math.ceil((f.until - Date.now()) / 60000)]), 'locked');
      return verifyPin(userId, pin).then(function (r) {
        if (r.ok) return r;
        // PIN başqa cihazda dəyişdirilmiş ola bilər: istifadəçiləri serverdən yeniləyib bir də yoxlayırıq
        var pull = root.Sync && root.Sync.pullNow ? root.Sync.pullNow(6000) : Promise.resolve();
        return pull.then(function () { return verifyPin(userId, pin); });
      });
    }).then(function (r) {
      var u = r.u;
      if (!r.ok) {
        // SEC-06: 5 yanlış cəhd → 5 dəqiqə blok. Sayğac tranzaksiya daxilində yenilənir ki, eyni anda gələn cəhdlər itməsin
        return DB.atomic(['meta', 'audit', 'outbox'], function (t) {
          return t.get('meta', 'authFail').then(function (m) {
            var all = (m && m.value) || {}, f = Object.prototype.hasOwnProperty.call(all, userId) ? all[userId] : { n: 0, until: 0 };
            f = { n: (f.n | 0) + 1, until: Number(f.until) || 0 };
            if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; }
            all[userId] = f;
            return t.put('meta', { key: 'authFail', value: all });
          }).then(function () { return log(t, 'auth.failed', { userId: userId }, null); });
        }).then(function () { throw err(credOf(u) === 'password' ? _t('Şifrə səhvdir') : _t('PIN səhvdir')); });
      }
      // Siyasət dəyişibsə (və ya Admin müvəqqəti kod veribsə) istifadəçi öz hazırkı kodu ilə daxil olur, sonra yenisini seçməlidir
      return getAuthPolicy().then(function (policy) {
        var must = needsChange(u, policy);
        session.user = { id: u.id, name: u.name, role: u.role, mustChangePin: must };
        if (!must) persistSession(u);
        return DB.atomic(['meta', 'audit', 'outbox'], function (t) {
          return t.get('meta', 'authFail').then(function (m) {
            if (!m || !m.value || !Object.prototype.hasOwnProperty.call(m.value, userId)) return;
            delete m.value[userId];
            return t.put('meta', { key: 'authFail', value: m.value });
          }).then(function () { return log(t, 'auth.login', {}, session.user); });
        }).then(function () { return session.user; });
      });
    });
  }

  // Sessiya brauzer tabında saxlanılır (yeniləmə / SW yenilənməsi çıxış etdirməsin). Tab bağlananda silinir, 12 saatdan sonra və PIN/rol dəyişəndə etibarsızdır.
  var SESSION_KEY = 'mag.session', SESSION_TTL = 12 * 3600000;
  function sessionStore() { try { return root.sessionStorage || null; } catch (e) { return null; } }
  function fingerprint(u) { return String(u.pinHash || '').slice(0, 16) + '|' + u.role; }
  function persistSession(u) {
    var ss = sessionStore(); if (!ss) return;
    try { if (!u) ss.removeItem(SESSION_KEY); else ss.setItem(SESSION_KEY, JSON.stringify({ id: u.id, fp: fingerprint(u), at: Date.now() })); } catch (e) { /* yaddaş bağlıdırsa davam */ }
  }
  function restoreSession() {
    var ss = sessionStore(); if (!ss) return Promise.resolve(null);
    var raw = null;
    try { raw = JSON.parse(ss.getItem(SESSION_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || !raw.id || Date.now() - raw.at > SESSION_TTL) { persistSession(null); return Promise.resolve(null); }
    return Promise.all([DB.get('users', raw.id), getAuthPolicy()]).then(function (r) {
      var u = r[0];
      if (!u || !u.active || needsChange(u, r[1]) || fingerprint(u) !== raw.fp) { persistSession(null); return null; }
      session.user = { id: u.id, name: u.name, role: u.role, mustChangePin: false };
      return session.user;
    });
  }

  function logout() { session.user = null; persistSession(null); }
  function currentUser() { return session.user; }

  function validateNewPin(newPin, oldPin) {
    if (!/^\d{4,8}$/.test(newPin)) return _t('PIN 4–8 rəqəm olmalıdır');
    if (newPin === oldPin) return _t('Yeni PIN köhnə PIN ilə eyni ola bilməz');
    if (/^(\d)\1+$/.test(newPin) || '0123456789'.indexOf(newPin) !== -1 || '9876543210'.indexOf(newPin) !== -1) return _t('Çox sadə PIN seçməyin');
    return null;
  }
  function validateNewSecret(form, next, old) {
    next = String(next == null ? '' : next);
    if (form === 'password') {
      var bad = Rules.passwordProblem(next); if (bad) return bad;
      if (next === old) return _t('Yeni şifrə köhnə kodla eyni ola bilməz');
      return null;
    }
    return validateNewPin(next, old);
  }

  // Giriş kodunu dəyişir. Yeni kod ROLUN siyasətindəki formadadır (PIN və ya şifrə): siyasət dəyişibsə istifadəçi PIN-dən şifrəyə (və ya əksinə) keçir.
  // "user.upserted" hadisəsi (duz + hash) serverə gedir və "Users" vərəqində yenilənir
  function changeCredential(oldSecret, newSecret) {
    var me = session.user;
    if (!me) return Promise.reject(err(_t('Daxil olun'), 'auth'));
    return Promise.all([DB.get('users', me.id), getAuthPolicy()]).then(function (r) {
      var u = r[0], form = r[1][u.role] || 'pin';
      var bad = validateNewSecret(form, newSecret, oldSecret); if (bad) throw err(bad);
      return checkSecret(u, oldSecret).then(function (ok) {
        if (!ok) throw err(credOf(u) === 'password' ? _t('Köhnə şifrə səhvdir') : _t('Köhnə PIN səhvdir'));
        var salt = newSalt();
        return hashFor(form, newSecret, salt).then(function (nh) {
          u.salt = salt; u.pinHash = nh; u.mustChangePin = false; u.updatedAt = nowAfter(u.updatedAt);
          return DB.atomic(['users', 'audit', 'outbox'], function (t) {
            return t.put('users', u).then(function () { return log(t, 'user.upserted', { user: u, reason: form === 'password' ? 'password_changed' : 'pin_changed' }, me, u.updatedAt); });
          }).then(function () { me.mustChangePin = false; persistSession(u); });
        });
      });
    });
  }
  function changePin(oldPin, newPin) { return changeCredential(oldPin, newPin); }       // köhnə ad (uyğunluq üçün)

  // Admin: unudulmuş kod üçün müvəqqəti kod verir (rolun formasında: PIN və ya şifrə). İstifadəçi ilk girişdə özünün yenisini seçir.
  function resetPin(userId) {
    return requirePerm('admin.users').then(function (admin) {
      return Promise.all([DB.get('users', userId), getAuthPolicy()]).then(function (r) {
        var u = r[0];
        if (!u) throw err(_t('İstifadəçi tapılmadı'));
        var form = r[1][u.role] || 'pin', temp = tempFor(form), salt = newSalt();
        return hashFor(form, temp, salt).then(function (h) {
          u.salt = salt; u.pinHash = h; u.mustChangePin = true; u.updatedAt = nowAfter(u.updatedAt);
          return DB.atomic(['users', 'audit', 'outbox'], function (t) {
            return t.put('users', u).then(function () { return log(t, 'user.upserted', { user: u, reason: 'pin_reset' }, admin, u.updatedAt); });
          }).then(function () { return temp; });
        });
      });
    });
  }

  /* ---------- İstifadəçilərin idarəsi (Admin) ---------- */
  function cleanName(n) { return String(n == null ? '' : n).replace(/\s+/g, ' ').trim(); }
  function nameKey(n) { return cleanName(n).toLocaleLowerCase('az'); }
  function validateUserName(name, users, selfId) {
    var n = cleanName(name);
    if (n.length < 2) return _t('Ad ən azı 2 simvol olmalıdır');
    if (n.length > 40) return _t('Ad 40 simvoldan uzun ola bilməz');
    if (users.some(function (u) { return u.id !== selfId && nameKey(u.name) === nameKey(n); })) return _t('Bu adda istifadəçi artıq var');
    return null;
  }

  function createUser(d) {
    return requirePerm('admin.users').then(function (admin) {
      return DB.getAll('users').then(function (users) {
        var bad = validateUserName(d && d.name, users);
        if (bad) throw err(bad);
        if (!d || !Rules.ROLE_NAMES[d.role]) throw err(_t('Rol seçin'));
        return getAuthPolicy().then(function (policy) {
          var form = policy[d.role] || 'pin', temp = tempFor(form), salt = newSalt();
          return hashFor(form, temp, salt).then(function (h) {
            var at = now();
            var u = { id: DB.uid('u'), name: cleanName(d.name), role: d.role, salt: salt, pinHash: h, active: true, mustChangePin: true, updatedAt: at };
            return DB.atomic(['users', 'audit', 'outbox'], function (t) {
              return t.put('users', u).then(function () { return log(t, 'user.upserted', { user: u, reason: 'created' }, admin, at); });
            }).then(function () { return { user: { id: u.id, name: u.name, role: u.role, active: true }, tempPin: temp, cred: form }; });
          });
        });
      });
    });
  }

  // Ad, rol, aktivlik. Son aktiv Admin söndürülə / rolu azaldıla bilməz; öz hesabınızı söndürə bilməzsiniz.
  function updateUser(id, patch) {
    return requirePerm('admin.users').then(function (admin) {
      return DB.getAll('users').then(function (users) {
        var cur = users.filter(function (u) { return u.id === id; })[0];
        if (!cur) throw err(_t('İstifadəçi tapılmadı'));
        var next = Object.assign({}, cur);
        if (patch.name != null) {
          var bad = validateUserName(patch.name, users, id); if (bad) throw err(bad);
          next.name = cleanName(patch.name);
        }
        if (patch.role != null) {
          if (!Rules.ROLE_NAMES[patch.role]) throw err(_t('Rol səhvdir'));
          next.role = patch.role;
        }
        if (patch.active != null) next.active = !!patch.active;
        if (next.name === cur.name && next.role === cur.role && next.active === cur.active) return { user: cur, unchanged: true };
        if (id === admin.id && !next.active) throw err(_t('Öz hesabınızı söndürə bilməzsiniz'));
        var wasAdmin = cur.active && cur.role === 'admin', stillAdmin = next.active && next.role === 'admin';
        if (wasAdmin && !stillAdmin && !users.some(function (u) { return u.id !== id && u.active && u.role === 'admin'; })) {
          throw err(_t('Sistemdə ən azı bir aktiv Admin qalmalıdır'));
        }
        next.updatedAt = nowAfter(cur.updatedAt);
        return DB.atomic(['users', 'audit', 'outbox'], function (t) {
          return t.put('users', next).then(function () { return log(t, 'user.upserted', { user: next, reason: 'updated', before: { name: cur.name, role: cur.role, active: cur.active } }, admin, next.updatedAt); });
        }).then(function () { return { user: next }; });
      });
    });
  }

  // Başqa cihazdan gələn istifadəçi dəyişikliyindən sonra cari sessiyanı yoxlayır:
  // 'gone' — hesab söndürülüb və ya PIN Admin tərəfindən sıfırlanıb (çıxış lazımdır); 'changed' — ad/rol dəyişib; 'same'.
  function refreshSession() {
    var me = session.user;
    if (!me) return Promise.resolve('none');
    return DB.get('users', me.id).then(function (u) {
      if (!u || !u.active) return 'gone';
      if (u.mustChangePin && !me.mustChangePin) return 'gone';
      var changed = u.role !== me.role || u.name !== me.name;
      me.role = u.role; me.name = u.name;
      if (!u.mustChangePin && !me.mustChangePin) persistSession(u);
      return changed ? 'changed' : 'same';
    });
  }

  function listAllUsers() {
    return requirePerm('admin.users').then(function () {
      return Promise.all([DB.getAll('users'), getAuthPolicy()]).then(function (r) {
        return r[0].map(function (u) { return { id: u.id, name: u.name, role: u.role, active: u.active, mustChangePin: u.mustChangePin, cred: credOf(u), target: r[1][u.role] || 'pin', mustChange: needsChange(u, r[1]) }; });
      });
    });
  }

  // Menecer təsdiqi: PIN kimə məxsusdursa və icazəsi varsa, onu qaytarır (SEC-04)
  function approveWithPin(pin, perm) {
    return Promise.all([DB.getAll('users'), matrix()]).then(function (r) {
      var candidates = r[0].filter(function (u) { return u.active && Rules.can(r[1], u.role, perm); });
      return Promise.all(candidates.map(function (u) { return checkSecret(u, pin).then(function (ok) { return ok ? u : null; }); }))
        .then(function (res) {
          var u = res.filter(Boolean)[0];
          if (!u) throw err(_t('PIN yanlışdır və ya bu şəxsin təsdiq icazəsi yoxdur'));
          return { id: u.id, name: u.name, role: u.role };
        });
    });
  }

  /* ---------- Məhsullar ---------- */
  function listProducts() {
    return DB.getAll('products').then(function (ps) { return ps.sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); }); });
  }

  // Kassir alış qiymətini görmür (SEC-03): ekrana veriləndən əvvəl təmizlənir
  function sanitizeForRole(p, canSeeCost) {
    if (canSeeCost) return p;
    var c = Object.assign({}, p); delete c.avgCost; delete c.lastCost; return c;
  }

  function validateProductInput(d) {
    if (!d.name || !String(d.name).trim()) return _t('Məhsulun adı boşdur');
    if (String(d.name).trim().length > 200) return _t('Ad 200 simvoldan uzun ola bilməz');         // digər cihazlar 200-dən uzun adlı hadisəni rədd edir
    if (d.price == null || d.price <= 0) return _t('Satış qiyməti 0-dan böyük olmalıdır');
    var md = Rules.maxDiscountProblem(d.maxDiscount); if (md) return md;
    var im = Rules.imageProblem(d.image); if (im) return im;
    if (['category', 'brand', 'ageGroup'].some(function (k) { return String(d[k] || '').length > 200; })) return _t('Kateqoriya, marka və yaş qrupu 200 simvoldan uzun ola bilməz');
    if (String(d.mfrBarcode || '').length > 500) return _t('İstehsalçı barkodu 500 simvoldan uzun ola bilməz');
    if (d.mfrBarcode) {
      // İstehsalçı barkodunun uzunluğu/formatı məhdudlaşdırılmır (EAN, UPC, Code128, hərf-rəqəm). Yalnız öz barkodlarımızla qarışmasın.
      if (/\s/.test(d.mfrBarcode)) return _t('İstehsalçı barkodunda boşluq ola bilməz');
      if (Barcode.isStoreBarcode(d.mfrBarcode) || Barcode.isReceiptBarcode(d.mfrBarcode)) return _t('Bu, mağaza və ya çek barkodudur, istehsalçı barkodu deyil');
    }
    return null;
  }

  // Qaytarır: {product, warnings[]}. Təkrar istehsalçı barkodu bloklamır, xəbərdarlıq edir (FR-13).
  function createProduct(d) {
    return requirePerm('product.edit').then(function (user) {
      var v = validateProductInput(d); if (v) throw err(v);
      return matrix().then(function (m) {
        if (!Rules.can(m, user.role, 'product.price.set')) throw err(_t('Satış qiymətini yalnız Menecer və Admin təyin edir'));
        var warnings = [];
        return DB.atomic(['products', 'meta', 'priceHistory', 'audit', 'outbox'], function (t) {
          var p0 = d.mfrBarcode ? t.byIndex('products', 'mfrBarcode', d.mfrBarcode) : Promise.resolve([]);
          return p0.then(function (dups) {
            if (dups.length) warnings.push(_t('Bu istehsalçı barkodu artıq var: {0}', [dups.map(function (x) { return x.name; }).join(', ')]));
            return nextSeq(t, 'productSeq');
          }).then(function (seq) {
            var p = {
              id: DB.uid('p'), name: String(d.name).trim(), category: d.category || '', brand: d.brand || '', ageGroup: d.ageGroup || '',
              storeBarcode: Barcode.storeBarcode(seq), mfrBarcode: d.mfrBarcode || '',
              price: d.price, lastCost: d.cost || 0, avgCost: d.cost || 0, stock: 0, negSalesSinceReceipt: 0,
              minStock: d.minStock || 0, active: true, createdAt: now(), createdBy: user.id,
              image: d.image || '', maxDiscount: d.maxDiscount || 0         // maxDiscount: bu məhsula kassada verilə bilən ən çox endirim, % (0 = endirim yoxdur)
            };
            p.updatedAt = EPOCH; p.updatedDev = '';       // yaradılma "son yazan qalib" müqayisəsində iştirak etmir: istənilən dəyişiklik ondan sonra gəlir (cihaz saatları fərqli olsa da)
            return t.put('products', p)
              .then(function () { return t.put('priceHistory', { id: DB.uid('ph'), productId: p.id, type: 'sale', old: null, new: p.price, userId: user.id, at: now() }); })
              .then(function () { return log(t, 'product.created', { product: p }, user); })
              .then(function () { return { product: p, warnings: warnings }; });
          });
        });
      });
    });
  }

  function updateProduct(id, changes) {
    return requirePerm('product.edit').then(function (user) {
      return matrix().then(function (m) {
        var canPrice = Rules.can(m, user.role, 'product.price.set');
        var warnings = [];
        return DB.atomic(['products', 'priceHistory', 'audit', 'outbox'], function (t) {
          return t.get('products', id).then(function (p) {
            if (!p) throw err(_t('Məhsul tapılmadı'));
            var next = Object.assign({}, p);
            ['name', 'category', 'brand', 'ageGroup', 'minStock', 'active'].forEach(function (k) { if (k in changes) next[k] = changes[k]; });
            if ('mfrBarcode' in changes) next.mfrBarcode = changes.mfrBarcode || '';
            if ('image' in changes) next.image = changes.image || '';
            if ('price' in changes && changes.price !== p.price) {
              if (!canPrice) throw err(_t('Satış qiymətini yalnız Menecer və Admin təyin edir'));
              next.price = changes.price;
            }
            if ('maxDiscount' in changes && (changes.maxDiscount || 0) !== (p.maxDiscount || 0)) {
              if (!canPrice) throw err(_t('Maksimum endirimi yalnız Menecer və Admin təyin edir'));      // qiymət kimi: kassir öz endirim həddini artıra bilməz
              next.maxDiscount = changes.maxDiscount || 0;
            }
            var v = validateProductInput(next); if (v) throw err(v);
            var at = nowAfter(p.updatedAt);       // yenilənmə vaxtı hadisənin vaxtı ilə eynidir: bütün cihazlar eyni "son yazan"ı seçir
            next.updatedAt = at; next.updatedDev = device;
            var chk = next.mfrBarcode && next.mfrBarcode !== p.mfrBarcode ? t.byIndex('products', 'mfrBarcode', next.mfrBarcode) : Promise.resolve([]);
            return chk.then(function (dups) {
              if (dups.length) warnings.push(_t('Bu istehsalçı barkodu artıq var: {0}', [dups.map(function (x) { return x.name; }).join(', ')]));
              return t.put('products', next);
            }).then(function () {
              if (next.price !== p.price) return t.put('priceHistory', { id: DB.uid('ph'), productId: id, type: 'sale', old: p.price, new: next.price, userId: user.id, at: now() });
            }).then(function () {
              // "before"-da şəkil yoxdur: hadisə Sheets xanasına (50 000 simvol) sığmalıdır, şəkil "after"-dədir
              var before = Object.assign({}, p); if (before.image) before.image = 'img';
              return log(t, 'product.updated', { id: id, before: before, after: next }, user, at);
            })
              .then(function () { return { product: next, warnings: warnings }; });
          });
        });
      });
    });
  }

  /* ---------- Təchizatçılar ---------- */
  function validateSupplier(d, suppliers, selfId) {
    var n = cleanName(d.name);
    if (n.length < 2) return _t('Təchizatçının adı ən azı 2 simvol olmalıdır');
    if (n.length > 60) return _t('Ad 60 simvoldan uzun ola bilməz');
    if (suppliers.some(function (s) { return s.id !== selfId && nameKey(s.name) === nameKey(n); })) return _t('Bu adda təchizatçı artıq var');
    if (String(d.phone || '').length > 40) return _t('Telefon çox uzundur');
    if (String(d.note || '').length > 300) return _t('Qeyd 300 simvoldan uzun ola bilməz');
    if (d.debtBasis != null && DEBT_BASES.indexOf(d.debtBasis) === -1) return _t('Borc əsası səhvdir');
    if (d.openingDebt != null && (!Number.isInteger(d.openingDebt) || Math.abs(d.openingDebt) > MAX_PAY)) return _t('Açılış borcu səhvdir');
    return null;
  }
  var DEBT_BASES = ['received', 'sold'], PAY_METHODS = ['cash', 'bank'], MAX_PAY = 1e9;      // 1e9 qəpik = 10 mln ₼

  function listSuppliers(opts) {
    return requirePerm(['supplier.view', 'stock.receive', 'stock.request']).then(function () {
      return DB.getAll('suppliers').then(function (list) {
        list = list.filter(function (s) { return (opts && opts.all) || s.active; });
        return list.sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); });
      });
    });
  }

  // Borc əsası və açılış borcu pula təsir edir: yalnız "supplier.pay" icazəsi olan dəyişə bilər
  function debtFieldsAllowed(user, d) {
    if (d.debtBasis == null && d.openingDebt == null) return Promise.resolve();
    return matrix().then(function (m) { if (!Rules.can(m, user.role, 'supplier.pay')) throw err(_t('Bu əməliyyata icazəniz yoxdur: {0}', [Rules.PERMISSIONS['supplier.pay']]), 'forbidden'); });
  }
  function createSupplier(d) {
    return requirePerm('supplier.manage').then(function (user) {
      return debtFieldsAllowed(user, d || {}).then(function () { return DB.getAll('suppliers'); }).then(function (all) {
        var bad = validateSupplier(d || {}, all); if (bad) throw err(bad);
        var at = now();
        var s = { id: DB.uid('sup'), name: cleanName(d.name), phone: String(d.phone || '').trim(), note: String(d.note || '').trim(), active: true, updatedAt: at, debtBasis: d.debtBasis || 'received', openingDebt: d.openingDebt || 0 };
        return DB.atomic(['suppliers', 'audit', 'outbox'], function (t) {
          return t.put('suppliers', s).then(function () { return log(t, 'supplier.upserted', { supplier: s, reason: 'created' }, user, at); }).then(function () { return s; });
        });
      });
    });
  }

  function updateSupplier(id, patch) {
    return requirePerm('supplier.manage').then(function (user) {
      return debtFieldsAllowed(user, patch || {}).then(function () { return DB.getAll('suppliers'); }).then(function (all) {
        var cur = all.filter(function (s) { return s.id === id; })[0];
        if (!cur) throw err(_t('Təchizatçı tapılmadı'));
        var next = Object.assign({}, cur);
        ['name', 'phone', 'note'].forEach(function (k) { if (patch[k] != null) next[k] = k === 'name' ? cleanName(patch[k]) : String(patch[k]).trim(); });
        if (patch.active != null) next.active = !!patch.active;
        if (patch.debtBasis != null) next.debtBasis = patch.debtBasis;
        if (patch.openingDebt != null) next.openingDebt = patch.openingDebt;
        if (next.debtBasis == null) next.debtBasis = 'received';
        if (next.openingDebt == null) next.openingDebt = 0;
        var bad = validateSupplier(next, all, id); if (bad) throw err(bad);
        if (JSON.stringify(next) === JSON.stringify(Object.assign({}, cur, { debtBasis: cur.debtBasis || 'received', openingDebt: cur.openingDebt || 0 }))) return { supplier: cur, unchanged: true };
        next.updatedAt = nowAfter(cur.updatedAt);
        return DB.atomic(['suppliers', 'audit', 'outbox'], function (t) {
          return t.put('suppliers', next).then(function () { return log(t, 'supplier.upserted', { supplier: next, reason: 'updated' }, user, next.updatedAt); }).then(function () { return { supplier: next }; });
        });
      });
    });
  }

  // Mal qəbulu. Hər qəbul bir PARTİYADIR (FIFO): məhsul, təchizatçı, say, alış qiyməti, vaxt — bütün cihazlarda eyni.
  // Orta çəkili maya (FR-24) saxlanılır. Yalnız "stock.receive" icazəsi olan rol (defolt: Menecer, Admin).
  // unitCost verilməyibsə (alış qiymətini görməyən rol) son qiymət götürülür. supplierId verilməyibsə partiya "təchizatçısız"dır.
  var RECEIPT_STORES = ['products', 'stockMoves', 'priceHistory', 'suppliers', 'lots', 'audit', 'outbox'];
  var MAX_RECEIPT_QTY = 100000;
  function validateReceiptQty(qty) {
    if (!Number.isInteger(qty) || qty <= 0) return _t('Say müsbət tam ədəd olmalıdır');
    if (qty > MAX_RECEIPT_QTY) return _t('Say {0}-dən çox ola bilməz', [MAX_RECEIPT_QTY]);
    return null;
  }

  // Qəbulun özü (tranzaksiya daxilində): qalıq, orta maya, partiya, audit. Birbaşa qəbul və təsdiqlənmiş sorğu eyni kodu işlədir.
  // o: {productId, qty, unitCost, note, supplierId, approval: {id, requestedBy}} — approval olarsa partiyanın id-si sorğudan törəyir (lot_<sorğu id>):
  // iki menecer eyni sorğunu eyni anda təsdiqləsə də qalıq iki dəfə artmır (bax: replica.js, stock.received).
  function receiveInTx(t, user, o, at) {
    return Promise.all([t.get('products', o.productId), o.supplierId ? t.get('suppliers', o.supplierId) : Promise.resolve(null)]).then(function (r) {
      var p = r[0], sup = r[1], unitCost = o.unitCost;
      if (!p) throw err(_t('Məhsul tapılmadı'));
      if (o.supplierId && (!sup || !sup.active)) throw err(_t('Təchizatçı tapılmadı və ya söndürülüb'));
      if (unitCost == null) unitCost = p.lastCost || 0;
      var before = p.stock, lotId = o.approval ? 'lot_' + o.approval.id : DB.uid('lot');
      Object.assign(p, Rules.applyReceipt(p, o.qty, unitCost));
      var lot = { id: lotId, productId: p.id, supplierId: o.supplierId || null, qty: o.qty, unitCost: unitCost, at: at, userId: user.id, note: o.note || '' };
      if (o.approval) lot.approvalId = o.approval.id;
      var ev = { productId: p.id, qty: o.qty, unitCost: unitCost, supplierId: lot.supplierId, lotId: lotId, at: at, note: lot.note };
      if (o.approval) { ev.approvalId = o.approval.id; ev.requestedBy = o.approval.requestedBy; }
      return t.put('products', p)
        .then(function () { return t.put('stockMoves', { id: DB.uid('sm'), productId: p.id, type: 'receipt', qty: o.qty, before: before, after: p.stock, unitCost: unitCost, note: o.note || '', at: at, userId: user.id }); })
        .then(function () { return t.put('priceHistory', { id: DB.uid('ph'), productId: p.id, type: 'cost', old: null, new: unitCost, userId: user.id, at: at }); })
        .then(function () { return t.put('lots', lot); })
        .then(function () { return log(t, 'stock.received', ev, user, at); })
        .then(function () { return { product: p, lotId: lotId, qty: o.qty, unitCost: unitCost, supplierId: lot.supplierId }; });
    });
  }

  function receiveStock(productId, qty, unitCost, note, supplierId) {
    return requirePerm('stock.receive').then(function (user) {
      var bad = validateReceiptQty(qty); if (bad) throw err(bad);
      if (unitCost != null && !(unitCost >= 0)) throw err(_t('Alış qiyməti səhvdir'));
      return DB.atomic(RECEIPT_STORES, function (t) {
        return receiveInTx(t, user, { productId: productId, qty: qty, unitCost: unitCost, note: note, supplierId: supplierId }, now()).then(function (r) { return r.product; });
      });
    });
  }

  // Kassir "mal gəldi" sorğusu göndərir; qalıq YALNIZ menecer/admin təsdiqləyəndə artır (decideApproval). Kassir alış qiymətini görmür və yazmır:
  // qiyməti təsdiq edən yazır (yazmasa son qiymət götürülür). Eyni məhsula gözləyən sorğu varsa ikincisi qəbul edilmir (təsadüfi ikiqat basma).
  function requestStockReceipt(productId, qty, supplierId, note) {
    return requirePerm('stock.request').then(function (me) {
      var bad = validateReceiptQty(qty); if (bad) throw err(bad);
      note = String(note || '').trim();
      if (note.length > 200) throw err(_t('Qeyd 200 simvoldan uzun ola bilməz'));
      return Promise.all([DB.get('products', productId), supplierId ? DB.get('suppliers', supplierId) : Promise.resolve(null), DB.getAll('approvals')]).then(function (r) {
        var p = r[0], sup = r[1];
        if (!p || !p.active) throw err(_t('Məhsul tapılmadı'));
        if (supplierId && (!sup || !sup.active)) throw err(_t('Təchizatçı tapılmadı və ya söndürülüb'));
        var dup = r[2].some(function (a) { return a.kind === 'stock.receive' && a.status === 'pending' && isFresh(a) && a.requestedBy.id === me.id && a.payload && a.payload.productId === productId; });
        if (dup) throw err(_t('Bu məhsul üçün sorğu artıq menecerin cavabını gözləyir. Dəyişmək istəyirsinizsə əvvəl onu ləğv edin'));
        var payload = { productId: p.id, productName: p.name, qty: qty, supplierId: sup ? sup.id : null, supplierName: sup ? sup.name : '', note: note };
        var tx = approvalText('{0} mal qəbulu istəyir: «{1}», {2} ədəd', [me.name, p.name, qty]);
        return requestApproval('stock.receive', 'stock.receive', tx.summary, tx.tk, tx.tp, payload);
      });
    });
  }

  // Kassirin öz mal qəbulu sorğuları (son 7 gün), yenidən köhnəyə doğru
  function listMyStockRequests() {
    var me = session.user;
    if (!me) return Promise.resolve([]);
    var from = nowMs() - 7 * 86400000;
    return DB.getAll('approvals').then(function (all) {
      return all.filter(function (a) { return a.kind === 'stock.receive' && a.requestedBy.id === me.id && Date.parse(a.at) >= from; })
        .map(function (a) { var st = a.status === 'pending' && !isFresh(a) ? 'expired' : a.status; return Object.assign({}, a, { state: st }); })
        .sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    });
  }

  /* ---------- FIFO hesabatı ---------- */
  function fifoState() {
    return Promise.all([DB.getAll('lots'), DB.getAll('sales'), DB.getAll('returns'), DB.getAll('products'), DB.getAll('suppliers')]).then(function (r) {
      var stock = {}, avg = {};
      r[3].forEach(function (p) { stock[p.id] = p.stock; avg[p.id] = p.avgCost || 0; });
      var res = root.Fifo.replay({ lots: r[0], sales: r[1], returns: r[2], stock: stock, avgCost: avg });
      var names = {}; r[4].forEach(function (s) { names[s.id] = s.name; });
      var pnames = {}; r[3].forEach(function (p) { pnames[p.id] = p.name; });
      return { res: res, lots: r[0], sales: r[1], returns: r[2], suppliers: r[4], names: names, pnames: pnames };
    });
  }

  // Dövr üzrə: hansı təchizatçının malından nə qədər satılıb (FIFO). Alış qiymətinə baxmaq icazəsi yoxdursa maya/mənfəət verilmir.
  // from/to: ISO vaxt, [from, to). Qaytarır: {rows:[{supplierId,name,soldQty,returnedQty,qty,revenue,cost,profit,onHandQty,onHandValue,products:[…]}], totals}
  function supplierReport(range) {
    return requirePerm('supplier.view').then(function () {
      return Promise.all([fifoState(), matrix()]).then(function (r) {
        var st = r[0], seeCost = Rules.can(r[1], session.user.role, 'product.cost.view');
        var rep = root.Fifo.supplierReport(st.res, st.sales, st.returns, range && range.from || '', range && range.to || '');
        var hand = root.Fifo.onHand(st.res);
        var keys = {}; Object.keys(rep).forEach(function (k) { keys[k] = 1; }); Object.keys(hand).forEach(function (k) { keys[k] = 1; });
        st.suppliers.forEach(function (s) { keys[s.id] = 1; });
        var rows = Object.keys(keys).map(function (k) {
          var a = rep[k] || { soldQty: 0, returnedQty: 0, qty: 0, revenue: 0, cost: 0, products: {} }, h = hand[k] || { qty: 0, value: 0 };
          var prods = Object.keys(a.products).map(function (pid) {
            var p = a.products[pid];
            return { productId: pid, name: st.pnames[pid] || pid, soldQty: p.soldQty, returnedQty: p.returnedQty, qty: p.qty, revenue: p.revenue, cost: seeCost ? p.cost : null, profit: seeCost ? p.revenue - p.cost : null };
          }).sort(function (x, y) { return y.qty - x.qty; });
          return { supplierId: k || null, name: k ? (st.names[k] || _t('Silinmiş təchizatçı')) : _t('Təchizatçısız (köhnə qalıq / mənfi satış)'), soldQty: a.soldQty, returnedQty: a.returnedQty, qty: a.qty,
            revenue: a.revenue, cost: seeCost ? a.cost : null, profit: seeCost ? a.revenue - a.cost : null, onHandQty: h.qty, onHandValue: seeCost ? Math.round(h.value) : null, products: prods };
        }).filter(function (x) { return x.supplierId || x.soldQty || x.returnedQty || x.onHandQty; })
          .sort(function (a, b) { return (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1) || b.qty - a.qty || a.name.localeCompare(b.name, 'az'); });
        var totals = rows.reduce(function (t, x) {
          t.soldQty += x.soldQty; t.returnedQty += x.returnedQty; t.qty += x.qty; t.revenue += x.revenue; t.onHandQty += x.onHandQty;
          if (seeCost) { t.cost += x.cost; t.profit += x.profit; t.onHandValue += x.onHandValue; }
          return t;
        }, { soldQty: 0, returnedQty: 0, qty: 0, revenue: 0, cost: 0, profit: 0, onHandQty: 0, onHandValue: 0 });
        var excess = 0; Object.keys(st.res.returns).forEach(function (k) { excess += st.res.returns[k].excess || 0; });
        return { rows: rows, totals: totals, seeCost: seeCost, excessReturnQty: excess };
      });
    });
  }

  // Bir məhsulun partiyaları (köhnədən yeniyə) və hər məhsulun hazırda hansı təchizatçıların malından qaldığı
  function productLots(productId) {
    return requirePerm(['product.view', 'supplier.view']).then(function () {
      return Promise.all([fifoState(), matrix()]).then(function (r) {
        var st = r[0], seeCost = Rules.can(r[1], session.user.role, 'product.cost.view');
        return root.Fifo.productLots(st.res, productId).map(function (l) {
          return { id: l.id, at: l.at, opening: l.opening, supplierId: l.supplierId, supplier: l.supplierId ? (st.names[l.supplierId] || '—') : null, qty: l.qty, remaining: l.remaining, unitCost: seeCost ? l.unitCost : null };
        });
      });
    });
  }
  function stockBySupplier() {
    return requirePerm(['product.view', 'supplier.view']).then(function () {
      return fifoState().then(function (st) {
        var out = {};   // productId → [{name, qty}] (qalığı olan partiyalar təchizatçıya görə)
        Object.keys(st.res.lots).forEach(function (id) {
          var L = st.res.lots[id]; if (L.remaining <= 0) return;
          var arr = out[L.productId] || (out[L.productId] = []);
          var nm = L.supplierId ? (st.names[L.supplierId] || '—') : null;
          var f = arr.filter(function (x) { return x.name === nm; })[0];
          if (f) f.qty += L.remaining; else arr.push({ name: nm, qty: L.remaining });
        });
        return out;
      });
    });
  }

  /* ---------- Təchizatçı hesabı: borc, ödənişlər, hesabat sənədi ----------
     Borc = açılış borcu + hesablanan məbləğ (alınan mal və ya satılan malın alış dəyəri — təchizatçı üzrə seçilir) − ödənişlər.
     Nağd ödəniş AÇIQ növbənin kassasından çıxır: "kassadan məxaric" (cash.out) kimi də yazılır, ona görə gözlənilən nağd, Z hesabatı və köhnə versiyalı cihazlar düzgün işləyir.
     Bank ödənişi kassaya toxunmur. Ləğv: nağd idisə kassaya geri mədaxil (cash.in) yazılır. Borcu görmək: "supplier.pay" və ya ("supplier.view" + "product.cost.view"). */
  function debtAccess() {
    return requirePerm(['supplier.pay', 'supplier.view']).then(function (user) {
      return matrix().then(function (m) {
        var canPay = Rules.can(m, user.role, 'supplier.pay');
        if (!(canPay || Rules.can(m, user.role, 'product.cost.view'))) throw err(_t('Bu əməliyyata icazəniz yoxdur: {0}', [Rules.PERMISSIONS['product.cost.view']]), 'forbidden');
        return { user: user, canPay: canPay };
      });
    });
  }

  // {supplierId: {debt, basis}} — cədvəldə borc sütunu üçün
  function supplierBalances() {
    return debtAccess().then(function (a) {
      return Promise.all([fifoState(), DB.getAll('supplierPays')]).then(function (r) {
        var st = r[0], out = {};
        st.suppliers.forEach(function (s) { out[s.id] = { debt: root.Fifo.debtAt(s, st.lots, r[1].filter(function (p) { return p.supplierId === s.id; }), st.res, st.sales, st.returns, ''), basis: s.debtBasis || 'received' }; });
        return { balances: out, canPay: a.canPay };
      });
    });
  }

  function listSupplierPays(supplierId) {
    return debtAccess().then(function () {
      return DB.byIndex('supplierPays', 'supplierId', supplierId).then(function (list) { return list.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; }); });
    });
  }

  // Hesab çıxarışı (sənədin məlumatı). range: {from, to} ISO [from, to) və ya boş (bütün vaxt); fromDay/toDay yalnız sənədin başlığında göstərilir.
  function supplierStatement(supplierId, range) {
    range = range || {};
    return debtAccess().then(function (a) {
      return Promise.all([fifoState(), DB.byIndex('supplierPays', 'supplierId', supplierId), storeInfo()]).then(function (r) {
        var st = r[0], sup = st.suppliers.filter(function (x) { return x.id === supplierId; })[0];
        if (!sup) throw err(_t('Təchizatçı tapılmadı'));
        var stm = root.Fifo.supplierStatement({ sup: sup, lots: st.lots, pays: r[1], res: st.res, sales: st.sales, returns: st.returns, from: range.from || '', to: range.to || '' });
        stm.accruedItems.forEach(function (it) { it.name = st.pnames[it.productId] || it.productId; });
        stm.supplier = { id: sup.id, name: sup.name, phone: sup.phone || '', note: sup.note || '' };
        stm.range = { from: range.from || '', to: range.to || '', fromDay: range.fromDay || '', toDay: range.toDay || '' };
        stm.store = r[2]; stm.by = a.user.name; stm.at = now();
        return stm;
      });
    });
  }

  // Ödəniş. method: 'cash' (açıq növbənin kassasından çıxır) | 'bank'. opts.confirmOver: borcdan çox (avans) ödənişi təsdiqləyir.
  function paySupplier(supplierId, amount, method, note, opts) {
    return requirePerm('supplier.pay').then(function (user) {
      if (!Number.isInteger(amount) || amount <= 0) throw err(_t('Məbləğ səhvdir'));
      if (amount > MAX_PAY) throw err(_t('Məbləğ çox böyükdür'));
      if (PAY_METHODS.indexOf(method) === -1) throw err(_t('Ödəniş üsulunu seçin'));
      note = String(note || '').trim();
      if (note.length > 200) throw err(_t('Qeyd 200 simvoldan uzun ola bilməz'));
      return Promise.all([fifoState(), DB.byIndex('supplierPays', 'supplierId', supplierId), method === 'cash' ? currentShift() : Promise.resolve(null)]).then(function (r) {
        var st = r[0], sup = st.suppliers.filter(function (x) { return x.id === supplierId; })[0], shift = r[2];
        if (!sup) throw err(_t('Təchizatçı tapılmadı'));
        if (method === 'cash' && !shift) throw err(_t('Nağd ödəniş üçün növbə açıq olmalıdır: pul kassadan çıxır'), 'no_shift');
        return (shift ? shiftReport(shift) : Promise.resolve(null)).then(function (rep) {
        // Kassada olmayan pul çıxmasın (məbləğdə səhv, və ya başqa kassanın satışı hələ gəlməyib): bank ödənişi və ya əvvəl kassaya mədaxil seçilə bilər
        if (rep && amount > rep.expectedCash) throw err(_t('Kassada kifayət qədər nağd yoxdur: olmalı nağd {0} ₼. Bank ödənişi seçin və ya əvvəl kassaya mədaxil yazın', [Money.format(Math.max(rep.expectedCash, 0))]), 'no_cash');
        var debt = root.Fifo.debtAt(sup, st.lots, r[1], st.res, st.sales, st.returns, '');
        if (amount > debt && !(opts && opts.confirmOver)) throw err(_t('Ödəniş borcdan ({0} ₼) çoxdur. Avans kimi yazmaq üçün təsdiqləyin', [Money.format(Math.max(debt, 0))]), 'overpay');
        var at = now(), id = DB.uid('sp');
        var pay = { id: id, supplierId: sup.id, supplierName: sup.name, amount: amount, method: method, at: at, userId: user.id, userName: user.name, note: note, updatedAt: at };
        var move = null;
        if (method === 'cash') {
          move = { id: DB.uid('cm'), shiftId: shift.id, type: 'out', amount: amount, reason: _t('Tədarükçüyə ödəniş: {0}', [sup.name], 'az') + (note ? ' — ' + note : ''), at: at, userId: user.id, approvedBy: user.id, supplierPayId: id };
          pay.shiftId = shift.id; pay.cashMoveId = move.id;
        }
        return DB.atomic(['supplierPays', 'cashMoves', 'shifts', 'audit', 'outbox'], function (t) {
          return (move ? t.get('shifts', shift.id) : Promise.resolve(null)).then(function (sh) {
            if (move && (!sh || sh.status !== 'open')) throw err(_t('Növbə açıq deyil'));
            return t.put('supplierPays', pay);
          }).then(function () { return move ? t.put('cashMoves', move) : null; })
            .then(function () { return move ? log(t, 'cash.out', { move: move }, user, at) : null; })
            .then(function () { return log(t, 'supplier.paid', { pay: pay }, user, at); })
            .then(function () { return { pay: pay, move: move, debtBefore: debt }; });
        });
        });
      });
    });
  }

  // Ödənişi ləğv etmək (səhv yazılıb). Nağd idisə məbləğ kassaya geri mədaxil olur (açıq növbə lazımdır). Qeyd məcburidir. Təkrar ləğv olmur.
  function voidSupplierPay(payId, reason) {
    return requirePerm('supplier.pay').then(function (user) {
      reason = String(reason || '').trim();
      if (reason.length < 3) throw err(_t('Səbəbi yazın'));
      if (reason.length > 200) throw err(_t('Qeyd 200 simvoldan uzun ola bilməz'));
      return Promise.all([DB.get('supplierPays', payId), currentShift()]).then(function (r) {
        var pay = r[0], shift = r[1];
        if (!pay) throw err(_t('Ödəniş tapılmadı'));
        if (pay.voidedAt) throw err(_t('Ödəniş artıq ləğv edilib'));
        if (pay.method === 'cash' && !shift) throw err(_t('Nağd ödənişi ləğv etmək üçün növbə açıq olmalıdır: pul kassaya qayıdır'), 'no_shift');
        var at = nowAfter(pay.at);
        // Sabit id: iki cihaz eyni ödənişi ləğv etsə də kassaya yalnız bir mədaxil düşür (replica.js eyni id-ni təkrar yazmır)
        var move = pay.method === 'cash' ? { id: 'cm_void_' + pay.id, shiftId: shift.id, type: 'in', amount: pay.amount, reason: _t('Ləğv edilmiş ödəniş: {0}', [pay.supplierName], 'az'), at: at, userId: user.id, approvedBy: user.id, supplierPayId: pay.id } : null;
        return DB.atomic(['supplierPays', 'cashMoves', 'audit', 'outbox'], function (t) {
          return t.get('supplierPays', payId).then(function (cur) {
            if (!cur || cur.voidedAt) throw err(_t('Ödəniş artıq ləğv edilib'));
            cur.voidedAt = at; cur.voidedBy = user.id; cur.voidedByName = user.name; cur.voidReason = reason; cur.updatedAt = at;
            return t.put('supplierPays', cur).then(function () {
              return t.get('cashMoves', 'cm_void_' + payId);
            }).then(function (ex) { return move && !ex ? t.put('cashMoves', move) : null; })
              .then(function () { return move ? log(t, 'cash.in', { move: move }, user, at) : null; })
              .then(function () { return log(t, 'supplier.pay_voided', { id: payId, at: at, by: { id: user.id, name: user.name }, reason: reason, pay: cur }, user, at); })
              .then(function () { return cur; });
          });
        });
      });
    });
  }

  // Kassa yalnız mağaza barkodu ilə işləyir (FR-16). İstehsalçı barkodu → xəbərdarlıq.
  function lookupForPos(code) {
    code = String(code || '').trim();
    if (!code) return Promise.resolve({ kind: 'empty' });
    return DB.byIndex('products', 'storeBarcode', code).then(function (r) {
      if (r.length) return r[0].active ? { kind: 'product', product: r[0] } : { kind: 'inactive', product: r[0] };
      if (Barcode.isReceiptBarcode(code)) return { kind: 'receipt' };
      return DB.byIndex('products', 'mfrBarcode', code).then(function (m) {
        return m.length ? { kind: 'mfr', products: m } : { kind: 'notfound' };
      });
    });
  }

  /* ---------- Növbə ---------- */
  function currentShift() {
    // Bir neçə cihazda eyni anda növbə açılıbsa, ən əvvəl açılan cari sayılır; digəri onun ardınca ayrıca bağlanır
    return DB.byIndex('shifts', 'status', 'open').then(function (s) {
      s.sort(function (a, b) { return a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : a.id < b.id ? -1 : 1; });
      return s[0] || null;
    });
  }

  // Ən son bağlanmış növbə: yeni növbə onun sayılmış nağdı ilə başlayır
  function lastClosedShift() {
    return DB.byIndex('shifts', 'status', 'closed').then(function (list) {
      list.sort(function (a, b) { return (a.closedAt || '') < (b.closedAt || '') ? 1 : -1; });
      return list[0] || null;
    });
  }

  // openingNote: başlanğıc nağd əvvəlki növbənin qalığından fərqlidirsə izah məcburidir (fərq auditdə qalır)
  function openShift(openingCash, openingNote) {
    return requirePerm('shift.open_close').then(function (user) {
      if (!(openingCash >= 0)) throw err(_t('Başlanğıc nağdı yazın'));
      return currentShift().then(function (cur) {
        if (cur) throw err(_t('Artıq açıq növbə var'));
        return lastClosedShift();
      }).then(function (prev) {
        var expected = prev && prev.countedCash != null ? prev.countedCash : null;
        var diff = expected == null ? 0 : openingCash - expected;
        if (diff !== 0 && !(openingNote && String(openingNote).trim())) {
          throw err(_t('Əvvəlki növbədən qalıq {0} ₼ idi. Fərqli məbləğ üçün izah yazın', [Money.format(expected)]));
        }
        return DB.atomic(['shifts', 'audit', 'outbox'], function (t) {
          return t.byIndex('shifts', 'status', 'open').then(function (open) {
            if (open.length) throw err(_t('Artıq açıq növbə var'));
            var s = { id: DB.uid('sh'), status: 'open', openedAt: now(), openedBy: user.id, openedByName: user.name, openingCash: openingCash };
            if (expected != null) { s.prevShiftId = prev.id; s.prevCash = expected; s.openingDiff = diff; if (diff !== 0) s.openingNote = String(openingNote).trim(); }
            return t.put('shifts', s).then(function () { return log(t, 'shift.opened', { shift: s }, user); }).then(function () { return s; });
          });
        });
      });
    });
  }

  function shiftData(shiftId) {
    return Promise.all([DB.byIndex('sales', 'shiftId', shiftId), DB.byIndex('returns', 'shiftId', shiftId), DB.byIndex('cashMoves', 'shiftId', shiftId)])
      .then(function (r) { return { sales: r[0], returns: r[1], cashMoves: r[2] }; });
  }

  function shiftReport(shift) {
    return shiftData(shift.id).then(function (d) {
      var sum = Rules.shiftSummary(d.sales, d.returns);
      sum.expectedCash = Rules.expectedCash(shift, d.sales, d.returns, d.cashMoves);
      sum.cashIn = d.cashMoves.filter(function (m) { return m.type === 'in'; }).reduce(function (a, m) { return a + m.amount; }, 0);
      sum.cashOut = d.cashMoves.filter(function (m) { return m.type === 'out'; }).reduce(function (a, m) { return a + m.amount; }, 0);
      // o cümlədən təchizatçılara ödənilən (ləğv edilənlər çıxılır)
      sum.supplierPaid = d.cashMoves.filter(function (m) { return m.supplierPayId; }).reduce(function (a, m) { return a + (m.type === 'out' ? m.amount : -m.amount); }, 0);
      return sum;
    });
  }

  function cashMove(type, amount, reason, approver) {
    return requirePerm('shift.open_close').then(function (user) {
      if (!(amount > 0)) throw err(_t('Məbləğ səhvdir'));
      if (!reason) throw err(_t('Səbəbi yazın'));
      if (type === 'out' && !approver) throw err(_t('Kassadan məxaric menecer təsdiqi tələb edir'));
      return currentShift().then(function (s) {
        if (!s) throw err(_t('Növbə açıq deyil'));
        return DB.atomic(['cashMoves', 'audit', 'outbox'], function (t) {
          var m = { id: DB.uid('cm'), shiftId: s.id, type: type, amount: amount, reason: reason, at: now(), userId: user.id, approvedBy: approver ? approver.id : null };
          return t.put('cashMoves', m).then(function () { return log(t, 'cash.' + type, { move: m }, user); }).then(function () { return m; });
        });
      });
    });
  }

  function closeShift(countedCash, note) {
    return requirePerm('shift.open_close').then(function (user) {
      function diffCheck(s) {
        return shiftReport(s).then(function (rep) {
          var diff = countedCash - rep.expectedCash;
          if (diff !== 0 && !note) throw err(_t('Kassa fərqi var ({0} ₼). İzah yazın', [Money.format(diff)]));
          return rep;
        });
      }
      // Digər kassaların bu növbədəki satışları da hesabata düşsün: həmişə əvvəlcə serverdən yenilənir (hesabat bağlandıqdan sonra düzəlmir).
      // Oflayndırsa gözləmə olmur; internet yavaşdırsa ekranda "yoxlanılır" göstəricisi var.
      var pull = root.Sync && root.Sync.pullNow ? root.Sync.pullNow(8000) : Promise.resolve();
      return pull.then(currentShift).then(function (s) {
        if (!s) throw err(_t('Açıq növbə yoxdur'));
        return Promise.all([diffCheck(s), DB.getAll('outbox')]).then(function (r) {
          var rep = r[0];
          if (r[1].length && root.navigator && root.navigator.onLine === false) {
            throw err(_t('Sinxronlaşmamış {0} qeyd var. İnternet qayıdana qədər növbə bağlanmır (FR-104)', [r[1].length]));
          }
          var diff = countedCash - rep.expectedCash;
          s.status = 'closed'; s.closedAt = now(); s.closedBy = user.id; s.countedCash = countedCash; s.expectedCash = rep.expectedCash; s.diff = diff; s.note = note || ''; s.report = rep;
          return DB.atomic(['shifts', 'audit', 'outbox'], function (t) {
            return t.put('shifts', s).then(function () { return log(t, 'shift.closed', { shift: s }, user); }).then(function () { return s; });
          });
        });
      });
    });
  }

  /* ---------- Satış ---------- */
  // Çekin hadisəsi Google Sheets-in bir xanasına (ən çox 50 000 simvol) yazılır: 100 sətir ən pis halda ~37 000 simvol edir
  var MAX_CART_LINES = 100;
  // cart: [{productId, qty, discount?}] — sətir endirimi {type:'percent', percent}|{type:'amount', amount}, hər ikisində approvedBy (təsdiqləyən istifadəçi)
  // discount: bütün çek üçün eyni formada endirim|null (köhnə forma {percent, approvedBy} da qəbul olunur), payment: rules.validatePayment girişi
  // Hədləri DƏQİQ burada yoxlayırıq (ekrana etibar yoxdur): sətir üçün məhsulun max endirimi, çek üçün Admin həddi (həm faiz, həm məbləğ).
  function checkout(cart, discount, payment) {
    return requirePerm('pos.sell').then(function (user) {
      if (!cart.length) throw err(_t('Çek boşdur'));
      if (cart.length > MAX_CART_LINES) throw err(_t('Bir çekdə ən çox {0} sətir ola bilər. Çeki iki hissəyə bölün', [MAX_CART_LINES]), 'cart_too_big');
      if (discount && !discount.approvedBy) throw err(_t('Endirim menecer tərəfindən təsdiqlənməyib'));
      cart.forEach(function (c) { if (c.discount && !c.discount.approvedBy) throw err(_t('Endirim menecer tərəfindən təsdiqlənməyib')); });
      return currentShift().then(function (shift) {
        if (!shift) throw err(_t('Satış üçün növbəni açın'));
        return DB.atomic(['products', 'sales', 'meta', 'stockMoves', 'audit', 'outbox'], function (t) {
          return Promise.all(cart.map(function (c) { return t.get('products', c.productId); }).concat([t.get('meta', 'store')])).then(function (got) {
            var storeMeta = got.pop(), products = got, caps = Rules.discountCaps(storeMeta && storeMeta.value);
            var lines = [];
            var negatives = [];
            for (var i = 0; i < cart.length; i++) {
              var p = products[i];
              if (!p || !p.active) throw err(_t('Məhsul satışda deyil'));
              if (!Number.isInteger(cart[i].qty) || cart[i].qty <= 0) throw err(_t('Say səhvdir: {0}', [p.name]));
              var chk = Rules.negativeStockCheck(p, cart[i].qty);
              if (chk.blocked) throw err(_t('"{0}" qalığı yoxdur və artıq {1} mənfi çekdə satılıb. Mal qəbulu daxil edin', [p.name, Rules.NEGATIVE_SALE_LIMIT]), 'negative_blocked');
              if (chk.needsNegative) negatives.push(p.id);
              var line = { productId: p.id, name: p.name, storeBarcode: p.storeBarcode, price: p.price, qty: cart[i].qty, unitCost: p.avgCost, negative: chk.needsNegative };
              var cd = cart[i].discount;
              if (cd) {
                var gross = p.price * cart[i].qty, lv = Rules.validateLineDiscount(gross, cd, p.maxDiscount || 0);
                if (lv) throw err(_t('"{0}": {1}', [p.name, lv]), 'discount');
                line.discount = Rules.discountValue(gross, cd);
                if (Rules.discountKind(cd) === 'percent') line.discountPercent = cd.percent;
                line.discountBy = cd.approvedBy.id;
              }
              lines.push(line);
            }
            var rd = null;                                                   // çek endirimi: normallaşdırılmış təsvir
            if (discount) {
              rd = Rules.discountKind(discount) === 'amount' ? { type: 'amount', amount: discount.amount } : { type: 'percent', percent: discount.percent };
              var rv = Rules.validateReceiptDiscount(Rules.cartTotals(lines, null).total, rd, caps); if (rv) throw err(rv, 'discount');
            }
            var totals = Rules.cartTotals(lines, rd);
            var pay = Rules.validatePayment(Object.assign({}, payment, { total: totals.total }));
            if (!pay.ok) throw err(pay.error, 'payment');
            pay.method = payment.method; pay.bankType = payment.method === 'cash' ? null : payment.bankType;

            return nextSeq(t, 'receiptSeq').then(function (no) {
              var sale = {
                id: DB.uid('s'), receiptNo: no, receiptBarcode: Barcode.receiptBarcode(no), at: now(), shiftId: shift.id,
                cashierId: user.id, cashierName: user.name, lines: lines, totals: totals,
                discount: rd ? Object.assign({}, rd, { approvedBy: discount.approvedBy.id, approvedByName: discount.approvedBy.name }) : null,
                payment: pay, offline: !!(root.navigator && root.navigator.onLine === false),
                fiscal: { id: null, status: 'disabled' } // e-kassa modulu söndürülüb (FR-66, FR-67)
              };
              var writes = products.map(function (p, i) {
                var before = p.stock;
                p.stock -= cart[i].qty;
                if (negatives.indexOf(p.id) !== -1) p.negSalesSinceReceipt = (p.negSalesSinceReceipt || 0) + 1;
                return t.put('products', p).then(function () {
                  return t.put('stockMoves', { id: DB.uid('sm'), productId: p.id, type: 'sale', qty: -cart[i].qty, before: before, after: p.stock, ref: sale.id, at: sale.at, userId: user.id });
                });
              });
              return Promise.all(writes)
                .then(function () { return t.put('sales', sale); })
                .then(function () { return log(t, 'sale.created', { sale: sale }, user); })
                .then(function () { return sale; });
            });
          });
        });
      });
    });
  }

  function auditEvent(type, data) {
    var user = session.user;
    return DB.atomic(['audit', 'outbox'], function (t) { return log(t, type, data, user); });
  }

  /* ---------- Qaytarma ---------- */
  function findSaleByCode(code) {
    code = String(code || '').trim();
    var no = Barcode.receiptNoFromBarcode(code);
    if (no == null && /^\d{1,10}$/.test(code)) no = parseInt(code, 10);
    if (no == null) return Promise.resolve(null);
    return DB.byIndex('sales', 'receiptNo', no).then(function (r) { return r[0] || null; });
  }

  function returnedQtyBySale(saleId) {
    return DB.byIndex('returns', 'saleId', saleId).then(function (rs) {
      var map = {};
      rs.forEach(function (r) { r.lines.forEach(function (l) { map[l.lineIndex] = (map[l.lineIndex] || 0) + l.qty; }); });
      return { map: map, cashRefunded: rs.reduce(function (a, r) { return a + (r.cashAmount || 0); }, 0) };
    });
  }

  // Eyni sətir bir neçə dəfə göndərilsə sayları toplanır: yoxsa hər biri ayrıca yoxlanıb satılandan çox qaytarmaq olardı
  function mergeReturnItems(items) {
    var by = {}, out = [];
    (items || []).forEach(function (it) {
      if (!it || !it.qty) return;
      if (by[it.lineIndex]) { by[it.lineIndex].qty += it.qty; return; }
      by[it.lineIndex] = { lineIndex: it.lineIndex, qty: it.qty }; out.push(by[it.lineIndex]);
    });
    return out;
  }

  // items: [{lineIndex, qty}]
  // Qaytarma sayının yoxlanması (menecer təsdiqindən ƏVVƏL çağırılır): satılandan və əvvəl qaytarılandan çox ola bilməz
  function validateReturn(saleId, items) {
    items = mergeReturnItems(items);
    return Promise.all([DB.get('sales', saleId), returnedQtyBySale(saleId)]).then(function (r) {
      var sale = r[0], prev = r[1];
      if (!sale) throw err(_t('Çek tapılmadı'));
      var win = Rules.returnWindow(sale.at, now());
      if (win.expired) throw err(_t('Çekin qaytarma müddəti bitib ({0} gün keçib, limit {1} gün)', [win.daysPassed, Rules.RETURN_DAYS]), 'expired');
      var any = false;
      items.forEach(function (it) {
        if (!it.qty) return;
        var l = sale.lines[it.lineIndex];
        if (!l) throw err(_t('Sətir tapılmadı'));
        if (!(it.qty > 0) || Math.floor(it.qty) !== it.qty) throw err(_t('"{0}": say tam müsbət ədəd olmalıdır', [l.name]));
        var can = Rules.returnableQty(l.qty, prev.map[it.lineIndex]);
        if (it.qty > can) throw err(_t('"{0}": satılıb {1}, əvvəl qaytarılıb {2} — ən çox {3} ədəd qaytarmaq olar', [l.name, l.qty, (prev.map[it.lineIndex] || 0), can]));
        any = true;
      });
      if (!any) throw err(_t('Qaytarılacaq say yazın'));
      return true;
    });
  }

  function createReturn(saleId, items, approver, reason) {
    return requirePerm('pos.return.request').then(function (user) {
      if (!approver) throw err(_t('Qaytarma menecer təsdiqi tələb edir'));
      items = mergeReturnItems(items);
      return Promise.all([DB.get('sales', saleId), returnedQtyBySale(saleId), currentShift()]).then(function (r) {
        var sale = r[0], prev = r[1], shift = r[2];
        if (!sale) throw err(_t('Çek tapılmadı'));
        if (!shift) throw err(_t('Qaytarma üçün növbəni açın'));
        var win = Rules.returnWindow(sale.at, now());
        if (win.expired) throw err(_t('Çekin qaytarma müddəti bitib ({0} gün keçib, limit {1} gün)', [win.daysPassed, Rules.RETURN_DAYS]), 'expired');
        var lines = [];
        items.forEach(function (it) {
          if (!it.qty) return;
          var l = sale.lines[it.lineIndex];
          if (!l) throw err(_t('Sətir tapılmadı'));
          var can = Rules.returnableQty(l.qty, prev.map[it.lineIndex]);
          if (it.qty > can) throw err(_t('"{0}" üzrə ən çox {1} ədəd qaytarmaq olar', [l.name, can]));
          lines.push({ lineIndex: it.lineIndex, productId: l.productId, name: l.name, price: l.price, qty: it.qty });
        });
        if (!lines.length) throw err(_t('Qaytarılacaq məhsul seçin'));
        // Pul: sətir endirimi və çek endirimi nəzərə alınır; hissə-hissə qaytarmada cəm dəqiq həmin sətrin ödənişinə bərabər çıxır
        var rf = Rules.refundFor(sale, lines.map(function (l) { return { lineIndex: l.lineIndex, qty: l.qty }; }), prev.map);
        lines.forEach(function (l, i) { l.refund = rf.lines[i].refund; });
        var amount = rf.amount;
        // Pul ilkin üsulla: əvvəlcə nağd hissəyə qədər nağd, qalanı banka
        var cashLeft = Math.max(0, sale.payment.cashPart - prev.cashRefunded);
        var cashAmount = Math.min(amount, cashLeft);
        var bankAmount = amount - cashAmount;
        return DB.atomic(['products', 'returns', 'stockMoves', 'audit', 'outbox'], function (t) {
          var rec = {
            id: DB.uid('r'), saleId: sale.id, receiptNo: sale.receiptNo, shiftId: shift.id, at: now(), lines: lines, amount: amount,
            cashAmount: cashAmount, bankAmount: bankAmount, bankType: bankAmount ? sale.payment.bankType : null,
            userId: user.id, approvedBy: approver.id, approvedByName: approver.name, reason: reason || ''
          };
          return Promise.all(lines.map(function (l) {
            return t.get('products', l.productId).then(function (p) {
              var before = p.stock; p.stock += l.qty;
              return t.put('products', p).then(function () {
                return t.put('stockMoves', { id: DB.uid('sm'), productId: p.id, type: 'return', qty: l.qty, before: before, after: p.stock, ref: rec.id, at: rec.at, userId: user.id });
              });
            });
          })).then(function () { return t.put('returns', rec); })
            .then(function () { return log(t, 'return.created', { ret: rec }, user); })
            .then(function () { return rec; });
        });
      });
    });
  }

  /* ---------- Admin ---------- */
  function getMatrix() { return matrix(); }
  function setMatrix(m) {
    return requirePerm('admin.permissions').then(function (user) {
      // Admin özünü icazə idarəsindən kənarlaşdıra bilməz
      if (m.admin.indexOf('admin.permissions') === -1) throw err(_t('Admin icazə idarəsini özündən götürə bilməz'));
      var at = now();
      return DB.atomic(['meta', 'audit', 'outbox'], function (t) {
        return t.get('meta', 'matrix').then(function (old) {
          return t.put('meta', { key: 'matrix', value: m }).then(function () { return t.put('meta', { key: 'matrixAt', value: at }); })
            .then(function () { return log(t, 'admin.matrix_changed', { before: old && old.value, after: m, v: Rules.MATRIX_VERSION }, user, at); });
        });
      });
    });
  }

  // info mövcud ayarların ÜSTÜNƏ yazılır (yalnız verilən sahələr dəyişir): mağaza adı formu endirim hədlərini, hədd formu isə mağaza adını silməsin
  function setStoreInfo(info) {
    return requirePerm('admin.users').then(function (user) {
      var p = info.discountMaxPercent, a = info.discountMaxAmount;
      if (p != null && !(typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 100)) throw err(_t('Endirim faizi 0 ilə 100 arasında olmalıdır'));
      if (a != null && !(typeof a === 'number' && Number.isInteger(a) && a >= 0 && a <= 1e9)) throw err(_t('Endirim məbləği səhvdir'));
      var at = now();
      return DB.atomic(['meta', 'audit', 'outbox'], function (t) {
        return t.get('meta', 'store').then(function (cur) {
          var merged = Object.assign({}, cur && cur.value, info);
          // Dəyişiklik yoxdursa hadisə yaranmır: yoxsa təzə qoşulan cihaz ilkin mətnləri bütün cihazlara yazıb mağaza adını silərdi
          if (cur && JSON.stringify(cur.value) === JSON.stringify(merged)) return { unchanged: true };
          return t.put('meta', { key: 'store', value: merged }).then(function () { return t.put('meta', { key: 'storeAt', value: at }); })
            .then(function () { return log(t, 'admin.store_changed', { store: merged }, user, at); });
        });
      });
    });
  }

  /* ---------- Təsdiq sorğuları (kassir → menecer, serverlə) ---------- */
  // Sorğunun mətni: summary həmişə Azərbaycanca (köhnə cihazlar üçün), tk/tp şablon və dəyərlərdir — menecer öz dilində görür (bax: ui.js, UI.reqText)
  function approvalText(key, params) { return { summary: _t(key, params, 'az'), tk: key, tp: params }; }

  var APPROVAL_TTL = 10 * 60000;                 // kassada gözləyən əməliyyatlar (sətir silmə, endirim, qaytarma)
  var STOCK_REQUEST_TTL = 24 * 3600000;          // mal qəbulu sorğusu: kassir gözləmir, menecer sonra da təsdiqləyə bilər
  function ttlOf(a) { return a.kind === 'stock.receive' ? STOCK_REQUEST_TTL : APPROVAL_TTL; }
  function isFresh(a) { return nowMs() - Date.parse(a.at) < ttlOf(a); }

  // kind: 'line_delete' | 'sale_cancel' | 'discount' | ..., perm: təsdiq üçün lazım olan icazə, summary: menecerə göstərilən mətn
  function requestApproval(kind, perm, summary, tk, tp, payload) {
    var me = session.user;
    if (!me) return Promise.reject(err(_t('Daxil olun'), 'auth'));
    var rec = { id: DB.uid('ap'), kind: kind, perm: perm, summary: summary, tk: tk || null, tp: tp || null, payload: payload || null, requestedBy: { id: me.id, name: me.name, role: me.role }, at: now(), status: 'pending', device: device };
    return DB.atomic(['approvals', 'audit', 'outbox'], function (t) {
      return t.put('approvals', rec).then(function () { return log(t, 'approval.requested', { approval: rec }, me, rec.at); }).then(function () { return rec; });
    });
  }

  function listPendingApprovals() {
    return DB.getAll('approvals').then(function (all) {
      return all.filter(function (a) { return a.status === 'pending' && isFresh(a); }).sort(function (a, b) { return a.at < b.at ? -1 : 1; });
    });
  }

  // opts (yalnız mal qəbulu sorğusunda): təsdiq edən sayı, təchizatçını və alış qiymətini düzəldə bilər: {qty, supplierId, unitCost}
  function decideApproval(id, decision, opts) {
    if (decision !== 'approved' && decision !== 'rejected') return Promise.reject(err(_t('Qərar səhvdir')));
    opts = opts || {};
    return DB.get('approvals', id).then(function (a0) {
      if (!a0) throw err(_t('Sorğu tapılmadı'));
      return requirePerm(a0.perm).then(function (me) {
        if (a0.requestedBy.id === me.id) throw err(_t('Öz sorğunuzu təsdiqləyə bilməzsiniz'));
        var stock = decision === 'approved' && a0.kind === 'stock.receive' && a0.payload;
        var qty = a0.payload && a0.payload.qty, supplierId = a0.payload ? a0.payload.supplierId : null, unitCost = null;
        if (stock) {
          if (opts.qty != null) qty = opts.qty;
          if (opts.supplierId !== undefined) supplierId = opts.supplierId || null;
          var bad = validateReceiptQty(qty); if (bad) throw err(bad);
          if (opts.unitCost != null) {
            if (!(opts.unitCost >= 0)) throw err(_t('Alış qiyməti səhvdir'));
            unitCost = opts.unitCost;
          }
        }
        return DB.atomic(['approvals'].concat(RECEIPT_STORES), function (t) {
          // Vəziyyət tranzaksiyanın içində yenidən oxunur: ikiqat klik və ya eyni anda gələn cavab sorğunu iki dəfə icra etməsin
          return t.get('approvals', id).then(function (a) {
            if (!a) throw err(_t('Sorğu tapılmadı'));
            if (a.status !== 'pending') throw err(_t('Sorğuya artıq cavab verilib'));
            if (!isFresh(a)) throw err(_t('Sorğunun vaxtı bitib'));
            var at = now();
            a.status = decision; a.decidedBy = { id: me.id, name: me.name, role: me.role }; a.decidedAt = at;
            var work = stock
              ? receiveInTx(t, me, { productId: a.payload.productId, qty: qty, unitCost: unitCost, note: a.payload.note, supplierId: supplierId, approval: { id: a.id, requestedBy: a.requestedBy } }, at)
                .then(function (r) { a.result = { qty: r.qty, unitCost: r.unitCost, supplierId: r.supplierId, lotId: r.lotId }; })
              : Promise.resolve();
            return work.then(function () { return t.put('approvals', a); })
              .then(function () { return log(t, 'approval.decided', { id: a.id, decision: decision, by: a.decidedBy, decidedAt: at, result: a.result || null }, me, at); })
              .then(function () { return a; });
          });
        });
      });
    });
  }

  function cancelApproval(id) {
    var me = session.user;
    return DB.get('approvals', id).then(function (a) {
      if (!a || a.status !== 'pending' || !me || a.requestedBy.id !== me.id) return null;
      var at = now();
      return DB.atomic(['approvals', 'audit', 'outbox'], function (t) {
        a.status = 'cancelled'; a.decidedAt = at;
        return t.put('approvals', a).then(function () { return log(t, 'approval.decided', { id: a.id, decision: 'cancelled', by: null, decidedAt: at }, me, at); }).then(function () { return a; });
      });
    });
  }

  // Kassirin gözlədiyi sorğunun vəziyyəti. Təsdiq yalnız səlahiyyətli aktiv istifadəçidən gəlibsə qəbul edilir.
  function checkApproval(id) {
    return DB.get('approvals', id).then(function (a) {
      if (!a) return { state: 'missing' };
      if (a.status === 'pending') return { state: isFresh(a) ? 'pending' : 'expired' };
      if (a.status !== 'approved') return { state: a.status };
      return Promise.all([DB.get('users', a.decidedBy.id), matrix()]).then(function (r) {
        var u = r[0];
        if (!u || !u.active || !Rules.can(r[1], u.role, a.perm)) return { state: 'rejected', reason: 'invalid_approver' };
        return { state: 'approved', approver: { id: u.id, name: u.name, role: u.role } };
      });
    });
  }

  function listConflicts() { return DB.get('meta', 'conflicts').then(function (m) { return m ? m.value : []; }); }

  function bySaleTime(a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : b.receiptNo - a.receiptNo; }
  function recentSales(limit) {
    return DB.getAll('sales').then(function (s) { return s.sort(bySaleTime).slice(0, limit || 50); });
  }

  // Axtarış üçün: kiçik hərf, "İ"/"ı" → "i" (Azərbaycan və Türk yazısında klaviatura fərqləri axtarışı pozmasın)
  function fold(x) { return String(x == null ? '' : x).toLowerCase().replace(/̇/g, '').replace(/ı/g, 'i'); }
  function pad2(n) { return ('0' + n).slice(-2); }

  // Bir axtarış sözü bir çekə uyğundurmu? Söz bunlardan biri ola bilər: kassir adı, məhsul adı, çek nömrəsi, çek və ya məhsul barkodu,
  // tarix (gg.aa.iiii · gg.aa · aa.iiii · iiii-aa-gg), çekin yekun məbləği (45 · 45,5 · 45.50).
  function tokenTest(tok) {
    var digits = /^\d+$/.test(tok), amount = /^\d+([.,]\d{1,2})?$/.test(tok) ? Money.parse(tok) : null, m, day = null, dayPart = null, month = null;
    if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(tok))) day = m[3] + '-' + pad2(m[2]) + '-' + pad2(m[1]);
    else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(tok))) day = m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
    else if ((m = /^(\d{1,2})\.(\d{1,2})$/.exec(tok))) dayPart = '-' + pad2(m[2]) + '-' + pad2(m[1]);     // gg.aa (məbləğ kimi də oxuna bilər: ikisinə də baxılır)
    else if ((m = /^(\d{1,2})\.(\d{4})$/.exec(tok))) month = m[2] + '-' + pad2(m[1]);
    var no = digits ? parseInt(tok, 10) : null;
    return function (s, text, codes) {
      if (text.indexOf(tok) !== -1) return true;
      if (tok.length >= 6 && codes.indexOf(tok) !== -1) return true;                   // barkod (çek və ya məhsul): qısa rəqəm tikələri təsadüfi uyğunlaşır, ona görə uzunluq tələb olunur
      if (no != null && s.receiptNo === no) return true;
      if (amount != null && s.totals.total === amount) return true;
      if (day || dayPart || month) {
        var d = Rules.localDate(s.at);
        if (day && d === day) return true;
        if (dayPart && d.slice(4) === dayPart) return true;
        if (month && d.slice(0, 7) === month) return true;
      }
      return false;
    };
  }

  // query: boşluqla ayrılmış sözlər, HAMISI uyğun gəlməlidir. Qaytarır: {list: ən yeni əvvəl (ən çox limit), total: uyğun gələn çek sayı}
  function searchSales(query, limit) {
    var tokens = fold(query).split(/\s+/).filter(Boolean);
    limit = limit || 100;
    return DB.getAll('sales').then(function (all) {
      var tests = tokens.map(tokenTest);
      var hit = !tests.length ? all : all.filter(function (s) {
        var text = fold(s.cashierName + ' ' + s.lines.map(function (l) { return l.name; }).join(' '));
        var codes = (s.receiptBarcode || '') + ' ' + s.lines.map(function (l) { return l.storeBarcode || ''; }).join(' ');
        return tests.every(function (fn) { return fn(s, text, codes); });
      });
      hit.sort(bySaleTime);
      return { list: hit.slice(0, limit), total: hit.length };
    });
  }
  function outboxCount() { return DB.getAll('outbox').then(function (o) { return o.length; }); }

  function seedDemoProducts() {
    var demo = [
      { name: 'Konstruktor dəsti, 120 hissə', category: 'Oyuncaq', price: 1450, cost: 900, qty: 6, ageGroup: '6+' },
      { name: 'Yumşaq ayı, 25 sm', category: 'Oyuncaq', price: 600, cost: 350, qty: 0, ageGroup: '0+' },
      { name: 'Maqnit «Bakı»', category: 'Suvenir', price: 225, cost: 90, qty: 40 },
      { name: 'Qız qalası maketi', category: 'Suvenir', price: 1800, cost: 1100, qty: 4 },
      { name: 'Puzzl 500 hissə', category: 'Oyuncaq', price: 1200, cost: 700, qty: 8, ageGroup: '8+' }
    ];
    return demo.reduce(function (chain, d) {
      return chain.then(function () {
        return createProduct(d).then(function (r) { return d.qty ? receiveStock(r.product.id, d.qty, d.cost, 'Nümunə qalıq') : null; });
      });
    }, Promise.resolve());
  }

  var Services = {
    MAX_CART_LINES: MAX_CART_LINES, EVENT_MAX_CHARS: EVENT_MAX_CHARS,
    init: init, storeInfo: storeInfo, setStoreInfo: setStoreInfo, listUsers: listUsers, login: login, logout: logout, currentUser: currentUser, changePin: changePin, changeCredential: changeCredential,
    getAuthPolicy: whenLoggedIn(getAuthPolicy), setAuthPolicy: setAuthPolicy, myCredTarget: myCredTarget, approverForm: whenLoggedIn(approverForm),
    approveWithPin: approveWithPin, requirePerm: requirePerm, getMatrix: getMatrix, setMatrix: setMatrix,
    listProducts: listProducts, sanitizeForRole: sanitizeForRole, createProduct: createProduct, updateProduct: updateProduct,
    receiveStock: receiveStock, lookupForPos: lookupForPos, seedDemoProducts: seedDemoProducts,
    currentShift: currentShift, lastClosedShift: lastClosedShift, openShift: openShift, closeShift: closeShift, shiftReport: shiftReport, cashMove: cashMove,
    checkout: checkout, auditEvent: auditEvent, findSaleByCode: findSaleByCode, returnedQtyBySale: returnedQtyBySale, createReturn: createReturn, validateReturn: validateReturn,
    recentSales: recentSales, searchSales: whenLoggedIn(searchSales), outboxCount: outboxCount, deviceId: deviceId, resetPin: resetPin, listSuppliers: listSuppliers, createSupplier: createSupplier, updateSupplier: updateSupplier, supplierReport: supplierReport, productLots: productLots, stockBySupplier: stockBySupplier, supplierBalances: supplierBalances, listSupplierPays: listSupplierPays, supplierStatement: supplierStatement, paySupplier: paySupplier, voidSupplierPay: voidSupplierPay,
    listAllUsers: listAllUsers, createUser: createUser, updateUser: updateUser, refreshSession: refreshSession, validateNewPin: validateNewPin,
    requestApproval: requestApproval, requestStockReceipt: requestStockReceipt, listMyStockRequests: listMyStockRequests, listPendingApprovals: listPendingApprovals, setClockOffset: setClockOffset, decideApproval: decideApproval, cancelApproval: cancelApproval,
    checkApproval: checkApproval, listConflicts: listConflicts, EPOCH: EPOCH, restoreSession: restoreSession, _session: session
  };
  root.Services = Services;
  if (typeof module !== 'undefined') module.exports = Services;
})(typeof window !== 'undefined' ? window : globalThis);
