/* node tests/hack.test.js — hücum (penetration) testləri, YALNIZ yerli təqlid mühitində (canlı serverə toxunmur).
   A) Code.gs v9 server: autentifikasiya/avtorizasiya yan keçmə, tip qarışdırma, cihaz id inyeksiyası, ADMIN_KEY brute-force, ləğv olunmuş cihaz,
      Script Properties tükəndirmə, ardıcıllıq zəhərlənməsi (allocate), sızma, zəhərli hadisələr.
   B) Müştəri: server ünvanı ilə token oğurluğu, hostile .xlsx (zip-bomba, yalan ölçü, sətir nömrəsi bombası, regex yavaşlatma, entity bombası),
      prototip çirklənməsi, zəhərli hadisənin digər cihazı dondurması, növbə faylı (importOutbox) yoxlaması.
   Uğursuz yoxlama = real zəiflik. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const { spawnSync } = require('child_process');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');
const Import = require('../js/import.js');

const LEGACY = 'legacy-shared-token-0123456789';
const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const JS = path.join(__dirname, '..', 'js');
let passed = 0, failed = 0;
const findings = [];
function t(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; }, e => { failed++; findings.push(name); console.log('✗ ' + name + '\n   ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n   ')); }); }

const ping = (b, token, device) => b.post({ action: 'ping', token, device });
const syncReq = (b, token, device, items, extra) => b.post(Object.assign({ action: 'sync', token, device, since: 0, items: items || [], limit: 5 }, extra || {}));
const adminReq = (b, over) => b.post(Object.assign({ token: LEGACY, device: 'admin_pc', adminKey: b.adminKey }, over));
function fresh() { const b = makeBackend({ token: LEGACY }); b.adminKey = b.sandbox.setupAdminKey(); return b; }
let evN = 0;
const ev = (over) => { const at = new Date().toISOString(); return Object.assign({ id: at + '_' + String(++evN).padStart(6, '0') + '_hack', at, type: 'noop.test', userId: 'u1', device: 'x', data: { n: evN } }, over || {}); };
function mkDevice(b, id) { const r = adminReq(b, { action: 'devices.create', id, name: 'N ' + id }); assert.ok(r.ok, JSON.stringify(r)); return r.token; }
const eventsCount = (b) => b.rows('Events').length;
const propsSnap = (b) => JSON.stringify(Object.keys(b.store.props).sort().map(k => [k, b.store.props[k]]));

(async () => {
  /* ===================== A) SERVER ===================== */
  await t('A1 tip qarışdırma: token/device sətir olmayanda (rəqəm, massiv, obyekt, null, bool) heç vaxt keçmir', () => {
    const b = fresh();
    const bad = [5, 0, true, false, null, [LEGACY], [[LEGACY]], { toString: LEGACY }, { $gt: '' }, LEGACY + ' ', ' ' + LEGACY, LEGACY + '\u0000', LEGACY.toUpperCase(), LEGACY.slice(0, -1), LEGACY + 'x', LEGACY.replace('l', 'ӏ'), ''];
    for (const tok of bad) {
      for (const dev of ['any_dev', ['any_dev'], { a: 1 }, 7, null]) {
        const r = b.post({ action: 'sync', token: tok, device: dev, since: 0, items: [ev()] });
        assert.strictEqual(r.ok, false, 'token=' + JSON.stringify(tok) + ' device=' + JSON.stringify(dev));
      }
    }
    assert.strictEqual(eventsCount(b), 0, 'rədd olunan sorğular Events-ə heç nə yazmır');
    // body özü massiv/sətir/null/rəqəm/boş: çökmə yox, rədd
    for (const raw of ['[]', '"x"', 'null', '5', '', '{', '{"__proto__":{"token":"' + LEGACY + '"},"action":"ping"}', '{"action":"ping","token":' + JSON.stringify(LEGACY) + ',"token":"x"}']) {
      const r = b.post(raw);
      assert.strictEqual(r.ok, false, 'xam gövdə: ' + raw);
    }
  });

  await t('A2 cihaz saxtakarlığı: A cihazının açarı B-nin id-si ilə, böyük/kiçik hərf, boşluq, mövcud olmayan id ilə işləmir', () => {
    const b = fresh();
    const ta = mkDevice(b, 'dev_aaa'), tb = mkDevice(b, 'dev_bbb');
    assert.ok(ping(b, ta, 'dev_aaa').ok); assert.ok(ping(b, tb, 'dev_bbb').ok);
    for (const id of ['dev_bbb', 'DEV_AAA', 'dev_aaa ', ' dev_aaa', 'dev_aaa\n', 'dev_aaa\u0000', 'dev_aa', 'dev_aaaa', 'dev-aaa', '', null, ['dev_aaa'], 'dev_aaa/../dev_bbb']) {
      const r = ping(b, ta, id);
      assert.strictEqual(r.ok, false, 'A açarı id=' + JSON.stringify(id));
    }
    assert.strictEqual(ping(b, tb, 'dev_aaa').ok, false);
    assert.strictEqual(eventsCount(b), 0);
  });

  await t('A3 cihaz id inyeksiyası: xüsusi adlar (__proto__, constructor, SYNC_TOKEN...) heç bir property-ni pozmur və Admin siyahısından gizlənə bilmir', () => {
    const b = fresh();
    const before = ['SYNC_TOKEN', 'ADMIN_KEY', 'productSeq', 'receiptSeq', 'LEGACY_UNTIL'].map(k => [k, b.store.props[k]]);
    const evil = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'SYNC_TOKEN', 'ADMIN_KEY', 'LEGACY_UNTIL', 'productSeq', 'receiptSeq', 'ls_admin_pc', 'DEV_x'];
    for (const id of evil) { const r = ping(b, LEGACY, id); assert.ok(r.ok, id); }
    for (const [k, v] of before) assert.strictEqual(b.store.props[k], v, k + ' dəyişməməlidir');
    assert.strictEqual(({}).polluted, undefined);
    const l = adminReq(b, { action: 'devices.list' });
    assert.ok(l.ok);
    const seen = l.unknown.map(u => u.id);
    for (const id of evil) assert.ok(seen.includes(id), 'tanınmayan cihaz siyahısında görünməlidir: ' + id + ' (görünən: ' + seen.join(',') + ')');
  });

  await t('A4 ADMIN_KEY yan keçmə: undefined/null/boş/massiv/obyekt/rəqəm/bool, SYNC_TOKEN, cihaz açarı, prefiks/böyük hərf', () => {
    const b = fresh();
    const dk = mkDevice(b, 'dev_aaa');
    const snap = propsSnap(b);
    const bad = [undefined, null, '', ' ', 0, 1, true, false, [], [b.adminKey], {}, { a: b.adminKey }, LEGACY, dk, b.adminKey.toUpperCase(), b.adminKey.slice(0, 63), b.adminKey + ' ', ' ' + b.adminKey, b.adminKey + 'x'];
    for (const act of ['devices.list', 'devices.create', 'devices.rotate', 'devices.revoke', 'devices.restore', 'devices.rename', 'legacy.set']) {
      for (const k of bad) {
        const body = { action: act, token: LEGACY, device: 'admin_pc', id: 'dev_new1', name: 'x', mode: 'off', days: 5 };
        if (k !== undefined) body.adminKey = k;
        const r = b.post(body);
        assert.ok(r.ok === false && /^adminkey_/.test(r.code), act + ' adminKey=' + JSON.stringify(k) + ' → ' + JSON.stringify(r));
        delete b.store.cache.adm_fail;            // növbəti cəhd kilid səbəbindən deyil, açar səbəbindən rədd olunsun
      }
    }
    assert.strictEqual(propsSnap(b).replace(/"ls_[^"]*"[^\]]*\]/g, ''), snap.replace(/"ls_[^"]*"[^\]]*\]/g, ''), 'rədd olunan admin əməliyyatları heç nəyi dəyişmir');
  });

  await t('A5 ADMIN_KEY təyin olunmayıbsa boş/yanlış açar heç nəyi açmır (fail-closed)', () => {
    const b = makeBackend({ token: LEGACY });                     // setupAdminKey işə salınmayıb
    for (const k of [undefined, null, '', 'x', 0, [], {}]) {
      const r = b.post({ action: 'devices.create', token: LEGACY, device: 'admin_pc', id: 'dev_zzz', adminKey: k });
      assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'adminkey_unset');
    }
    assert.ok(!Object.keys(b.store.props).some(k => k.startsWith('DEV_')));
  });

  await t('A6 ADMIN_KEY brute-force: kilid cihaz id/token dəyişməklə yan keçilmir; sayğac yalnız səhv açarda artır', () => {
    const b = fresh();
    const dk = mkDevice(b, 'dev_aaa');
    for (let i = 0; i < 5; i++) b.post({ action: 'devices.list', token: i % 2 ? LEGACY : dk, device: i % 2 ? 'x' + i : 'dev_aaa', adminKey: 'guess' + i });
    for (const [tok, dev] of [[LEGACY, 'admin_pc'], [dk, 'dev_aaa'], [LEGACY, 'brand_new_' + Math.random().toString(36).slice(2, 8)]]) {
      const r = b.post({ action: 'devices.list', token: tok, device: dev, adminKey: b.adminKey });
      assert.strictEqual(r.code, 'adminkey_locked', 'düzgün açar da kilid müddətində rədd olunmalıdır');
    }
    assert.strictEqual(Number(b.store.cache.adm_fail), 5, 'kilid dövründə sayğac artmır');
  });

  await t('A7 adi cihaz açarı sahibi admin əməliyyatı edə bilmir, siyahıda hash/açar sızmır', () => {
    const b = fresh();
    const dk = mkDevice(b, 'dev_cash');
    for (const act of ['devices.list', 'devices.create', 'devices.rotate', 'devices.revoke', 'devices.restore', 'devices.rename', 'legacy.set']) {
      const r = b.post({ action: act, token: dk, device: 'dev_cash', id: 'dev_cash', name: 'hack', mode: 'on', days: 90 });
      assert.strictEqual(r.ok, false, act);
    }
    const l = adminReq(b, { action: 'devices.list' });
    const flat = JSON.stringify(l);
    const rec = JSON.parse(b.store.props.DEV_dev_cash);
    assert.ok(!flat.includes(rec.hash), 'hash siyahıda yoxdur');
    assert.ok(!flat.includes(dk), 'açar siyahıda yoxdur');
    assert.ok(!flat.includes(b.adminKey) && !flat.includes(LEGACY));
  });

  await t('A8 sızma: ping/sync/allocate/doGet cavablarında token, hash, ADMIN_KEY, Spreadsheet ID yoxdur', () => {
    const b = fresh();
    const dk = mkDevice(b, 'dev_cash');
    const hash = JSON.parse(b.store.props.DEV_dev_cash).hash;
    const outs = [ping(b, dk, 'dev_cash'), syncReq(b, dk, 'dev_cash', [ev()]), b.post({ action: 'allocate', key: 'productSeq', count: 3, token: dk, device: 'dev_cash' }), b.get(), ping(b, 'səhv', 'dev_cash'), ping(b, LEGACY, 'old')];
    for (const o of outs) {
      const s = JSON.stringify(o);
      for (const secret of [dk, hash, b.adminKey, LEGACY, '1NTzVrx9ioe9elwn3c85RwU64e9NWuylaKT8uyLoe67g']) assert.ok(!s.includes(secret), 'sızıb: ' + secret.slice(0, 8) + ' → ' + s.slice(0, 120));
    }
    const g = b.get();                                   // girişsiz GET yalnız ümumi vəziyyəti göstərir
    assert.deepStrictEqual(Object.keys(g).sort(), ['missingSheets', 'ok', 'rev', 'service', 'tokenSet', 'version']);
  });

  await t('A9 ləğv olunmuş cihaz: heç bir əməliyyat keçmir, hadisə yazılmır, açarı bilməyən "ləğv" cavabından məlumat çıxara bilmir', () => {
    const b = fresh();
    const dk = mkDevice(b, 'dev_lost');
    assert.ok(adminReq(b, { action: 'devices.revoke', id: 'dev_lost', reason: 'oğurlanıb' }).ok);
    const n0 = eventsCount(b);
    for (const body of [{ action: 'ping' }, { action: 'sync', since: 0, items: [ev()] }, { action: 'allocate', key: 'receiptSeq', count: 5 }, { action: 'archive.status' }, { action: 'push.test' }, { action: 'devices.list', adminKey: b.adminKey }]) {
      const r = b.post(Object.assign({ token: dk, device: 'dev_lost' }, body));
      assert.strictEqual(r.ok, false, body.action); assert.strictEqual(r.code, 'revoked');
    }
    assert.strictEqual(eventsCount(b), n0);
    assert.strictEqual(b.post({ action: 'ping', token: 'təsadüfi-açar', device: 'dev_lost' }).code, 'denied', 'açarı bilməyən kəs cihazın ləğv olunduğunu öyrənmir');
    assert.strictEqual(ping(b, dk, 'dev_other').ok, false, 'ləğv olunmuş cihazın açarı başqa id ilə işləmir');
  });

  await t('A10 köhnə ümumi açarın müddəti bitəndən sonra bağlanır; müddəti uzatma yalnız ADMIN_KEY ilə, yanlış müddət dəyərləri rədd', () => {
    const b = fresh(); const dk = mkDevice(b, 'dev_aaa');
    b.store.props.LEGACY_UNTIL = String(Date.now() - 1000); b.tick(121);   // əllə dəyişiklik keş müddəti qədər gecikir
    assert.strictEqual(ping(b, LEGACY, 'old_pc').ok, false);
    assert.strictEqual(b.post({ action: 'legacy.set', mode: 'on', days: 3, token: LEGACY, device: 'admin_pc', adminKey: b.adminKey }).ok, false, 'müddəti bitmiş ümumi açar admin əməliyyatı da aça bilmir');
    const own = (over) => b.post(Object.assign({ token: dk, device: 'dev_aaa', adminKey: b.adminKey, action: 'legacy.set' }, over));
    for (const days of [0, -5, 91, 1e9, 'abc', null, [], {}, 0.5, NaN]) {
      const r = own({ mode: 'on', days });
      assert.strictEqual(r.ok, false, 'days=' + JSON.stringify(days));
      assert.ok(Number(b.store.props.LEGACY_UNTIL) < Date.now(), 'yanlış müddət LEGACY_UNTIL-i dəyişmir');
    }
    assert.ok(own({ mode: 'on', days: 3 }).ok);
    assert.ok(ping(b, LEGACY, 'old_pc').ok);
  });

  await t('A11 Script Properties tükəndirmə: ümumi açarla çoxlu uydurma cihaz id-si göndərib "son görünmə" property-ləri ilə yaddaşı doldurmaq olmur', () => {
    const b = fresh();
    const before = Object.keys(b.store.props).length;
    for (let i = 0; i < 400; i++) { delete b.store.cache['lsw_junk' + i]; ping(b, LEGACY, 'junk_dev_' + i); }
    const grown = Object.keys(b.store.props).length - before;
    assert.ok(grown <= 60, 'Script Properties-də ' + grown + ' yeni açar yarandı (limit 500 KB; hücumçu property yazmağı və Admin əməliyyatlarını əngəlləyə bilər)');
  });

  await t('A12 yetkisiz sorğular heç bir property/keş yazmır (500 rədd edilmiş sorğudan sonra vəziyyət eynidir)', () => {
    const b = fresh(); mkDevice(b, 'dev_aaa');
    b.post({ action: 'sync', token: 'x', device: 'rand_warm', items: [] });                 // yalnız sabit açarlar (p_SYNC_TOKEN, p_devIds) keşə düşür
    const snap = propsSnap(b), cacheKeys = Object.keys(b.store.cache).length;
    for (let i = 0; i < 500; i++) b.post({ action: 'sync', token: 'x' + i, device: 'rand_' + i, items: [ev()] });
    assert.strictEqual(propsSnap(b), snap); assert.strictEqual(Object.keys(b.store.cache).length, cacheKeys); assert.strictEqual(eventsCount(b), 0);
  });

  await t('A13 ardıcıllıq zəhərlənməsi: allocate-in "min" parametri ilə barkod/çek ardıcıllığını əbədi sıradan çıxarmaq olmur', () => {
    const b = fresh(); const dk = mkDevice(b, 'dev_cash');
    const ok0 = b.post({ action: 'allocate', key: 'productSeq', count: 10, min: 0, token: dk, device: 'dev_cash' });
    assert.ok(ok0.ok && ok0.to <= 1000);
    for (const key of ['productSeq', 'receiptSeq']) {
      b.post({ action: 'allocate', key, count: 5, min: 9e9, token: dk, device: 'dev_cash' });
      b.post({ action: 'allocate', key, count: 5, min: 9999999999999, token: dk, device: 'dev_cash' });
      b.post({ action: 'allocate', key, count: 5, min: '99999999999999999999', token: dk, device: 'dev_cash' });
      const r = b.post({ action: 'allocate', key, count: 5, min: 0, token: dk, device: 'dev_cash' });
      assert.ok(r.ok && r.to <= 9999999999 - 1000 && r.from < 1e7, key + ' ardıcıllığı zəhərləndi: from=' + r.from + ' (EAN-13 üçün 10 rəqəmdən çox ola bilməz)');
    }
    // sync içində alloc də eyni yoldan keçir
    const s = syncReq(b, dk, 'dev_cash', [], { alloc: [{ key: 'productSeq', count: 1, min: 8e9 }] });
    const blk = (s.blocks || s.alloc || [])[0];
    assert.ok(!blk || blk.from < 1e7, 'sync.alloc ilə də zəhərlənmə: ' + JSON.stringify(blk));
  });

  await t('A14 allocate/sync parametr fuzz: count/min/since/limit/items/alloc tipləri və həddləri çökmə və ya sonsuz yazı yaratmır', () => {
    const b = fresh(); const dk = mkDevice(b, 'dev_cash');
    for (const count of [-5, 0, 1e9, 'abc', null, [], {}, 1.5, NaN, Infinity]) {
      const r = b.post({ action: 'allocate', key: 'productSeq', count, token: dk, device: 'dev_cash' });
      assert.ok(r.ok === false || (r.to - r.from + 1) <= 1000, 'count=' + JSON.stringify(count));
    }
    for (const key of ['__proto__', 'constructor', ['productSeq'], { a: 1 }, null, 7, 'PRODUCTSEQ']) assert.strictEqual(b.post({ action: 'allocate', key, token: dk, device: 'dev_cash' }).ok, false);
    for (const extra of [{ since: 'x' }, { since: -5 }, { since: 1e18 }, { limit: -1 }, { limit: 1e9 }, { limit: 'abc' }, { limit: [] }, { alloc: 5 }, { alloc: 'x' }, { alloc: { length: 1e9 } }, { alloc: [null, 5, 'x', { key: '__proto__' }] }, { items: 'abc' }, { items: { length: 1e9 } }, { items: [null, 5, 'x', [], { id: 5 }] }]) {
      const r = b.post(Object.assign({ action: 'sync', token: dk, device: 'dev_cash', since: 0, items: [], limit: 5 }, extra));
      assert.ok(typeof r === 'object' && r !== null && typeof r.ok === 'boolean', JSON.stringify(extra));
    }
    assert.strictEqual(eventsCount(b), 0, 'yanlış formatlı hadisələrdən heç biri yazılmadı');
  });

  await t('A15 zəhərli hadisələr: __proto__ açarı, nəhəng/dərin data, yanlış tiplər, təkrar id; Events yalnız düzgün hadisəni saxlayır', () => {
    const b = fresh(); const dk = mkDevice(b, 'dev_cash');
    const good = ev({ type: 'noop.test' });
    const raw = JSON.stringify({ action: 'sync', token: dk, device: 'dev_cash', since: 0, limit: 5, items: [good] });
    assert.ok(b.post(raw).ok);
    const proto = '{"action":"sync","token":' + JSON.stringify(dk) + ',"device":"dev_cash","since":0,"limit":5,"items":[{"id":"p1_' + Date.now() + '","at":"2026-10-11T10:00:00.000Z","type":"noop.test","userId":"u","device":"x","data":{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}}]}';
    b.post(proto);
    assert.strictEqual(({}).polluted, undefined); assert.strictEqual(({}).polluted2, undefined);
    let deep = '1'; for (let i = 0; i < 3000; i++) deep = '[' + deep + ']';
    const r1 = b.post('{"action":"sync","token":' + JSON.stringify(dk) + ',"device":"dev_cash","since":0,"items":[{"id":"deep1","at":"2026-10-11T10:00:00.000Z","type":"noop.test","userId":"u","device":"x","data":{"d":' + deep + '}}]}');
    assert.ok(typeof r1.ok === 'boolean');
    const n1 = eventsCount(b);
    const dup = b.post(raw);                             // eyni id təkrar göndərilir (replay)
    assert.ok(dup.ok); assert.strictEqual(eventsCount(b), n1, 'replay yeni sətir yaratmır');
    for (const bad of [{ id: 5 }, { id: {}, at: 'x' }, { id: 'a'.repeat(5000) }, { type: '../../x' }, { type: 'a b' }, { at: 12 }, { userId: {} }, { data: 'str' }, { data: [] }, { data: null }]) {
      const r = syncReq(b, dk, 'dev_cash', [ev(bad)]);
      assert.ok(typeof r.ok === 'boolean');
    }
    for (const row of b.rows('Events')) assert.ok(typeof row[0] === 'string' && row[0].length <= 200, 'saxlanan hadisə id-si düzgündür');
  });

  /* ===================== B) MÜŞTƏRİ ===================== */
  function makeDevice(backend, fetchOverride) {
    const store = {};
    const ctx = {
      console, setTimeout, clearTimeout, TextEncoder, TextDecoder, DOMException, AbortController, Blob, DecompressionStream,
      crypto: nodeCrypto.webcrypto, indexedDB: new IDBFactory(), IDBKeyRange, navigator: { onLine: true }, fetch: fetchOverride || backend.fetch(),
      sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } }
    };
    ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
    ['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
    ctx.Sync.kick = () => {};
    return ctx;
  }
  const loginAs = async (d, name, pin) => d.Services.login((await d.Services.listUsers()).find(x => x.name === name).id, pin);
  const syncAll = async (...ds) => { for (let i = 0; i < 2; i++) for (const d of ds) await d.Sync.cycle(); };

  await t('B1 server ünvanı ilə token oğurluğu: yalnız https://script.google.com/macros/s/<id>/exec qəbul olunur, başqa ünvana heç bir sorğu getmir', async () => {
    const calls = [];
    const spy = (url) => { calls.push(String(url)); return Promise.reject(new TypeError('Failed to fetch')); };
    const d = makeDevice(null, spy); await d.Services.init();
    const evil = ['http://script.google.com/macros/s/AKfy/exec', 'https://script.google.com.evil.com/macros/s/AKfy/exec', 'https://evil.com/?https://script.google.com/macros/s/AKfy/exec',
      'https://script.google.com@evil.com/macros/s/AKfy/exec', 'https://evil.com#@script.google.com/macros/s/AKfy/exec', 'https://script.google.com/macros/s/AKfy/exec?x=1', 'https://script.google.com/macros/s/AKfy/exec#x',
      'https://script.google.com/macros/s/AKfy/exec/', 'https://script.google.com/macros/s/AKfy/exec\n', ' https://script.google.com/macros/s/AKfy/exec', 'https://script.google.com/macros/s/AKfy/exec ',
      'https://script.google.com/macros/s/../../evil/exec', 'https://script.google.com/macros/s/AKfy%2f..%2fx/exec', 'https://script.google.com/macros/s/AKfy/dev', 'javascript:alert(1)', 'data:text/html,x',
      'https://script.google.com/macros/s//exec', 'https://script.google.comevil/macros/s/AKfy/exec', 'HTTPS://SCRIPT.GOOGLE.COM/macros/s/AKfy/exec', 'https://script.google.com:444/macros/s/AKfy/exec', '//evil.com/macros/s/AKfy/exec'];
    const STRICT = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
    const accepted = [];
    for (const u of evil) {
      const n0 = calls.length; let res; try { res = await d.Sync.connect(u, 'SECRET-TOKEN-XYZ'); } catch (e) { res = { error: String(e.message) }; }
      if (calls.length > n0) accepted.push(u);
      // sorğu getdisə, yalnız dəqiq Google ünvanına (kənar boşluq kəsilə bilər)
      for (const c of calls.slice(n0)) assert.ok(STRICT.test(c), 'yad ünvana sorğu: ' + c + ' (daxil edilən: ' + JSON.stringify(u) + ')');
    }
    const lenient = accepted.filter(u => !STRICT.test(u.trim()));
    assert.deepStrictEqual(lenient, [], 'ciddi formaya uyğun olmayan ünvan qəbul olundu: ' + JSON.stringify(lenient));
  });

  async function hostileRun(label, bytes, ms) {
    const f = path.join(os.tmpdir(), 'hack_' + process.pid + '_' + label + '.xlsx');
    fs.writeFileSync(f, bytes);
    const code = 'const I=require(' + JSON.stringify(path.join(JS, 'import.js')) + ');const b=new Uint8Array(require("fs").readFileSync(' + JSON.stringify(f) + '));const t0=Date.now();' +
      'I.readXlsx(b).then(r=>console.log(JSON.stringify({ok:true,rows:r.length,ms:Date.now()-t0})),e=>console.log(JSON.stringify({ok:false,err:String(e.message).slice(0,80),ms:Date.now()-t0})))';
    const r = spawnSync(process.execPath, ['--max-old-space-size=400', '-e', code], { timeout: ms || 8000, encoding: 'utf8' });
    try { fs.unlinkSync(f); } catch (e) { /* */ }
    if (r.error && r.error.code === 'ETIMEDOUT') return { hang: true };
    if (r.status !== 0) return { crash: true, err: (r.stderr || '').split('\n')[0] };
    return JSON.parse(r.stdout.trim().split('\n').pop());
  }
  const enc = s => new TextEncoder().encode(s);
  const WB = '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const RELS = '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const xlsxWith = (sheetXml, shared) => Import.zipStore([{ name: 'xl/workbook.xml', data: enc(WB) }, { name: 'xl/_rels/workbook.xml.rels', data: enc(RELS) }].concat(shared ? [{ name: 'xl/sharedStrings.xml', data: enc(shared) }] : []).concat([{ name: 'xl/worksheets/sheet1.xml', data: enc(sheetXml) }]));
  const SHEET = (inner) => '<?xml version="1.0"?><worksheet><sheetData>' + inner + '</sheetData></worksheet>';

  // deflate-ilə sıxılmış zip (method 8); declared = başlıqda yazılan açılmış ölçü (yalan ola bilər)
  function zipDeflate(files) {
    const zlib = require('zlib'); const chunks = [], central = []; let off = 0;
    for (const f of files) {
      const name = Buffer.from(f.name), comp = zlib.deflateRawSync(f.data, { level: 9 }), crc = zlib.crc32 ? zlib.crc32(f.data) : 0;
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.declared != null ? f.declared : f.data.length, 22); lh.writeUInt16LE(name.length, 26);
      central.push({ name, crc, csize: comp.length, usize: f.declared != null ? f.declared : f.data.length, off }); chunks.push(lh, name, comp); off += 30 + name.length + comp.length;
    }
    const cdStart = off;
    for (const c of central) { const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(c.crc, 16); ch.writeUInt32LE(c.csize, 20); ch.writeUInt32LE(c.usize, 24); ch.writeUInt16LE(c.name.length, 28); ch.writeUInt32LE(c.off, 42); chunks.push(ch, c.name); off += 46 + c.name.length; }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(off - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    chunks.push(end); return Buffer.concat(chunks);
  }

  await t('B2 zip-bomba: 300 MB açılan kiçik fayl (həm doğru, həm də yalan kiçik ölçü bəyanı ilə) rədd olunur, yaddaş/vaxt partlamır', async () => {
    const zeros = Buffer.alloc(300 * 1024 * 1024, 0x20);
    for (const declared of [null, 1000]) {
      const z = zipDeflate([{ name: 'xl/workbook.xml', data: Buffer.from(WB) }, { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS) },
        { name: 'xl/worksheets/sheet1.xml', data: Buffer.concat([Buffer.from('<worksheet><sheetData>'), zeros]), declared }]);
      assert.ok(z.length < 1024 * 1024, 'bomba kiçikdir: ' + z.length);
      const r = await hostileRun('bomb' + declared, z, 20000);
      assert.ok(!r.hang && !r.crash, 'zip-bomba: ' + JSON.stringify(r));
      assert.strictEqual(r.ok, false, 'rədd olunmalıdır: ' + JSON.stringify(r));
    }
  });

  await t('B3 xlsx hücumları: pozulmuş zip, EOCD ofset yalanı, şifrəli, naməlum sıxma, sətir nömrəsi bombası (r="4294967290") qısa vaxtda bitir', async () => {
    const good = xlsxWith(SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>Ad</t></is></c></row>'));
    const cases = {
      truncated: good.subarray(0, good.length - 30), garbage: Buffer.from('PK\x03\x04' + 'x'.repeat(500)), empty: Buffer.from('PK'),
      badOffset: (() => { const c = Buffer.from(good); c.writeUInt32LE(0xfffffff0, c.length - 6); return c; })(),
      hugeCount: (() => { const c = Buffer.from(good); c.writeUInt16LE(60000, c.length - 12); return c; })(),
      rowBomb: xlsxWith(SHEET('<row r="4294967290"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>')),
      rowBomb2: xlsxWith(SHEET('<row r="2000000000"><c r="A1"><v>1</v></c></row><row r="1999999999"><c r="B1"><v>1</v></c></row>')),
      colBomb: xlsxWith(SHEET('<row r="1"><c r="ZZZZZZZZZZ1"><v>1</v></c><c r="XFD1"><v>2</v></c></row>'))
    };
    for (const [k, z] of Object.entries(cases)) {
      const r = await hostileRun(k, z, 7000);
      assert.ok(!r.hang && !r.crash, k + ': ' + JSON.stringify(r));
      if (r.ok) assert.ok(r.rows <= 200000, k + ': sətir sayı ' + r.rows);
    }
  });

  await t('B4 xlsx regex yavaşlatma: bağlanmamış <c , <row , <si , <t teqləri (kvadratik sürət) 40 MB-a qədər faylda belə saniyələrdə bitir', async () => {
    const N = 120000;
    const cases = {
      cFlood: xlsxWith(SHEET('<row r="1">' + '<c '.repeat(N))),
      cNoClose: xlsxWith(SHEET('<row r="1">' + '<c r="A1">'.repeat(40000) + '</row>')),
      rowFlood: xlsxWith(SHEET('<row '.repeat(N))),
      siFlood: xlsxWith(SHEET('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'), '<sst>' + '<si '.repeat(N)),
      tFlood: xlsxWith(SHEET('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'), '<sst><si>' + '<t '.repeat(N) + '</si></sst>')
    };
    for (const [k, z] of Object.entries(cases)) {
      const r = await hostileRun(k, z, 8000);
      assert.ok(!r.hang && !r.crash, k + ' → ' + JSON.stringify(r));
    }
  });

  await t('B5 entity bombası və pozulmuş sayısal entity-lər: genişlənmir, çökmür', async () => {
    const dtd = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>';
    const z = xlsxWith(SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>&lol3;&lol3;&#x110000;&#99999999999;&#0;&#xD800;</t></is></c><c r="B1" t="str"><v>&#x7FFFFFFF;</v></c></row>').replace('<?xml version="1.0"?>', '<?xml version="1.0"?>' + dtd));
    const r = await hostileRun('entity', z, 6000);
    assert.ok(!r.hang && !r.crash && r.ok, JSON.stringify(r));
  });

  await t('B6 prototip çirklənməsi: başlıq/açar adları __proto__, constructor, prototype olan CSV və xlsx Object.prototype-i dəyişmir', async () => {
    const csv = '__proto__;constructor;prototype;Ad;Satış qiyməti\npolluted;polluted;polluted;Oyuncaq;5\n';
    const tbl = Import.parseCsv(csv);
    const m = Import.mapRows(tbl, {});
    assert.ok(m && Array.isArray(m.rows));
    const z = xlsxWith(SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>__proto__</t></is></c><c r="B1" t="inlineStr"><is><t>Ad</t></is></c><c r="C1" t="inlineStr"><is><t>Satış qiyməti</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="B2" t="inlineStr"><is><t>__proto__</t></is></c><c r="C2"><v>3</v></c></row>'));
    const tb2 = await Import.readXlsx(z); Import.mapRows(tb2, {});
    assert.strictEqual(({}).polluted, undefined); assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
    assert.strictEqual(Object.getPrototypeOf({}), Object.prototype);
  });

  await t('B7 CSV hücumları: nəhəng sətir, 2 milyon sətir, tək xanada 20 MB, qoşa dırnaq qeyri-bərabərliyi vaxtında bitir', async () => {
    const t0 = Date.now();
    Import.parseCsv('a;b\n' + '1;2\n'.repeat(1500000));
    Import.parseCsv('"' + 'x'.repeat(20 * 1024 * 1024));
    Import.parseCsv('a;b\n' + '"""'.repeat(3000000));
    assert.ok(Date.now() - t0 < 15000, 'CSV analizi çox yavaşdır: ' + (Date.now() - t0) + ' ms');
  });

  await t('B8 zəhərli hadisə digər cihazı dondurmur: prototip adlı növ, __proto__ data, yanlış formatlı məhsul; sonrakı düzgün hadisə yenə tətbiq olunur', async () => {
    const be = makeBackend({ token: 'secret-token' });
    const A = makeDevice(be), V = makeDevice(be);
    await A.Services.init(); await V.Services.init();
    assert.ok(!(await A.Sync.connect(URL_OK, 'secret-token')).error); assert.ok(!(await V.Sync.connect(URL_OK, 'secret-token')).error);
    await syncAll(A, V);
    await loginAs(A, 'Admin', '1234');
    const poison = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'product.created', 'user.upserted', 'admin.matrix_changed', 'stock.received', 'sale.created', 'approval.decided'];
    const items = poison.map(type => ev({ type, userId: 'evil', device: 'evil_dev', data: JSON.parse('{"__proto__":{"polluted":"yes"},"user":"x","product":{"id":{"$ne":1},"name":"=cmd|\' /C calc\'!A0","price":-5,"storeBarcode":"1"},"matrix":"x","approval":5,"sale":{"lines":"x"},"after":null}') }));
    items.push(ev({ type: 'product.created', data: { product: { id: 'p_evil', name: 'X', price: 1e308 } } }));
    assert.ok(be.post({ action: 'sync', token: 'secret-token', device: 'evil_dev', since: 0, items, limit: 5 }).ok);
    const made = await A.Services.createProduct({ name: 'Düzgün məhsul', price: 12, cost: 5 });
    await syncAll(A, V, A, V);
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(vm.runInContext('({}).polluted', V), undefined, 'qurban cihazın Object.prototype-i çirklənməyib');
    await loginAs(V, 'Admin', '1234');
    const names = (await V.Services.listProducts()).map(p => p.name);
    assert.ok(names.includes('Düzgün məhsul'), 'zəhərli hadisələrdən sonra da düzgün hadisə gəlib çatdı: ' + names.join(','));
    assert.ok(!names.some(n => /cmd/.test(n)), 'saxta məhsul qəbul olunmadı');
    assert.ok(V.Sync.status().ok !== false, 'sinxron sağlamdır');
    assert.ok(made && made.product);
  });

  await t('B9 növbə faylı (importOutbox): yanlış format, 20 001 element, uzun id/növ, prototip növü, yanlış tiplər yoxlanılır; təkrar idxal dublikat yaratmır', async () => {
    const be = makeBackend({ token: 'secret-token' });
    const D = makeDevice(be); await D.Services.init(); await D.Sync.connect(URL_OK, 'secret-token');
    const rej = async (txt) => { let err = null; try { await D.Sync.importOutbox(txt); } catch (e) { err = e; } return err; };
    assert.ok(await rej('not json')); assert.ok(await rej('[]')); assert.ok(await rej('{"format":"x","items":[]}')); assert.ok(await rej('null'));
    const FORMAT = (fs.readFileSync(path.join(JS, 'sync.js'), 'utf8').match(/OUTBOX_FORMAT\s*=\s*'([^']+)'/) || [])[1];
    assert.ok(FORMAT, 'OUTBOX_FORMAT tapılmadı');
    assert.ok(await rej(JSON.stringify({ format: FORMAT, items: new Array(20001).fill({}) })));
    const base = { at: '2026-10-11T10:00:00.000Z', userId: 'u', device: 'old_dev', data: {} };
    const items = [
      Object.assign({}, base, { id: 'ok1', type: 'noop.test' }), Object.assign({}, base, { id: 'ok1', type: 'noop.test' }),
      Object.assign({}, base, { id: 'x'.repeat(201), type: 'noop.test' }), Object.assign({}, base, { id: 'bad_type', type: '../../etc' }), Object.assign({}, base, { id: 'bad_type2', type: 'a b' }),
      Object.assign({}, base, { id: 'p', type: '__proto__' }), Object.assign({}, base, { id: 'nodata', type: 'noop.test', data: 'str' }), Object.assign({}, base, { id: 'arr', type: 'noop.test', data: null }),
      Object.assign({}, base, { id: 5, type: 'noop.test' }), Object.assign({}, base, { id: 'dev_big', type: 'noop.test', device: 'd'.repeat(300) }), null, 5, 'x', []
    ];
    const r1 = await D.Sync.importOutbox(JSON.stringify({ format: FORMAT, items }));
    assert.ok(r1.added <= 3, 'yalnız düzgün elementlər əlavə olunmalıdır: ' + JSON.stringify(r1));
    const r2 = await D.Sync.importOutbox(JSON.stringify({ format: FORMAT, items }));
    assert.strictEqual(r2.added, 0, 'təkrar idxal dublikat yaratmamalıdır');
    assert.strictEqual(({}).polluted, undefined);
  });

  console.log('\n' + passed + ' keçdi, ' + failed + ' uğursuz' + (failed ? ' → real zəifliklər/xətalar: ' + findings.join(' | ') : ''));
  process.exit(failed ? 1 : 0);
})();
