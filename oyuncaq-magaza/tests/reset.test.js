/* node tests/reset.test.js — İş məlumatının sıfırlanması (Ayarlar → «İş məlumatını sil», Code.gs data.reset).
   Server: ehtiyat nüsxə, yalnız user/admin/auth hadisələri qalır (arxiv faylındakılar da), törəmə vərəqlər boşalır, nömrə sayğacları geri düşmür.
   Cihazlar: yeni dövrü görəndə yerli iş məlumatını silir, göndərilməmiş iş qeydlərini atır, istifadəçi/ayar qalır; köhnə tətbiq yaza bilmir. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'secret-token';
const ADMIN_KEY = 'a'.repeat(64);
const JS = path.join(__dirname, '..', 'js');

function makeDevice(backend) {
  const store = {};
  const ctx = {
    console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController,
    crypto: nodeCrypto.webcrypto, indexedDB: new IDBFactory(), IDBKeyRange,
    navigator: { onLine: true }, fetch: backend.fetch(),
    sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } }
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'fifo', 'import', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};
  return ctx;
}
async function boot(be) { const d = makeDevice(be); await d.Services.init(); const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error, r.error); return d; }
async function loginAs(d, name, secret) { const u = (await d.Services.listUsers()).find(x => x.name === name); return d.Services.login(u.id, secret); }
async function rejects(p, re) {
  try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('Gözlənilməyən xəta: ' + e.message + ' (gözlənilən ' + re + ')'); return e; }
  throw new Error('Xəta gözlənilirdi');
}
const sync = async (...ds) => { for (let i = 0; i < 2; i++) for (const d of ds) await d.Sync.cycle(); };
const J = x => JSON.parse(JSON.stringify(x));
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); }
}

(async () => {
  const be = makeBackend({ token: TOKEN });
  be.store.props.ADMIN_KEY = ADMIN_KEY;
  be.sandbox.SEEN_WINDOW = 8; be.sandbox.ARCHIVE_MIN_CUT = 3;
  const A = await boot(be), B = await boot(be);
  const mgr = { id: 'u_menecer', name: 'Menecer' };
  let sup, p1, p2, newUserId, oldBarcode, oldReceipt;

  await t('hazırlıq: məhsul, təchizatçı, mal qəbulu, növbə, satış, ödəniş; yeni istifadəçi və icazə dəyişikliyi; bir hissəsi arxivdə', async () => {
    await loginAs(A, 'Admin', '1234');
    sup = await A.Services.createSupplier({ name: 'Alfa MMC' });
    p1 = (await A.Services.createProduct({ name: 'Maşın', price: 800, cost: 500 })).product;
    p2 = (await A.Services.createProduct({ name: 'Kukla', price: 600, cost: 400 })).product;
    oldBarcode = p2.storeBarcode;
    await A.Services.receiveStock(p1.id, 10, 500, '', sup.id);
    await A.Services.openShift(10000);
    const s = await A.Services.checkout([{ productId: p1.id, qty: 2 }], null, { method: 'cash', cashReceived: 2000 });
    oldReceipt = s.receiptNo;
    await A.Services.paySupplier(sup.id, 500, 'bank', '');
    const u = await A.Services.createUser({ name: 'Leyla', role: 'kassir', pin: '5678' }); newUserId = u.id || (u.user && u.user.id);
    const m = J(await A.Services.getMatrix()); m.kassir = m.kassir.filter(p => p !== 'tab.returns'); await A.Services.setMatrix(m);
    await sync(A, B);
    const r = be.sandbox.archiveRun({ force: true, keepDays: 0 });
    assert.ok(r.archived, 'arxiv yaradıldı: ' + JSON.stringify(r));
    await A.Services.createProduct({ name: 'Top', price: 300, cost: 100 });       // arxivdən sonra canlı cədvəldə
    await sync(A, B);
    assert.strictEqual((await B.Services.listProducts()).length, 3);
    assert.ok(be.rows('Products').length >= 3);
  });

  let tempPin;
  await t('B oflayn: göndərilməmiş məhsul (atılmalıdır) və PIN dəyişikliyi (qalmalıdır)', async () => {
    be.down = true;
    await loginAs(B, 'Admin', '1234');
    await B.Services.createProduct({ name: 'Oflayn məhsul', price: 100, cost: 50 }).catch(() => {});
    const leyla = (await B.Services.listUsers()).find(x => x.name === 'Leyla');
    tempPin = await B.Services.resetPin(leyla.id);
    const ob = await B.DB.getAll('outbox');
    assert.ok(ob.some(x => x.type === 'product.created') && ob.some(x => x.type === 'user.upserted'), 'outbox: ' + ob.map(x => x.type));
    be.down = false;
  });

  let res;
  await t('server: yanlış açar və təsdiqsiz sorğu rədd olunur, heç nə silinmir', async () => {
    await rejects(A.Sync.resetData('b'.repeat(64)), /Admin açarı səhvdir|açar/i);
    const r = be.post({ action: 'data.reset', token: TOKEN, device: 'x', adminKey: ADMIN_KEY });
    assert.strictEqual(r.ok, false);
    assert.ok(be.rows('Products').length >= 3); assert.ok(!be.store.props.EPOCH);
  });

  await t('server: sıfırlama — ehtiyat nüsxə, Events-də yalnız user/admin/auth (arxivdəkilər də), iş vərəqləri boş', async () => {
    const before = be.rows('Events').length;
    res = await A.Sync.resetData(ADMIN_KEY, 'Admin');
    assert.ok(res.ok && res.epoch && res.backup && /Ehtiyat/.test(res.backup.name));
    const copy = be.store.spreadsheets[res.backup.id];
    assert.ok(copy && copy.getSheetByName('Events').rows.length - 1 === before, 'nüsxədə bütün canlı hadisələr var');
    const ev = be.rows('Events');
    assert.strictEqual(ev.length, res.kept);
    assert.ok(ev.length > 0 && ev.every(r => /^(user|admin|auth)\./.test(String(r[2]))), 'yalnız saxlanan növlər: ' + [...new Set(ev.map(r => r[2]))]);
    assert.ok(ev.some(r => r[2] === 'admin.matrix_changed'), 'icazə dəyişikliyi qalıb');
    assert.ok(ev.some(r => r[2] === 'user.upserted' && String(r[5]).includes('Leyla')), 'yeni istifadəçi qalıb');
    assert.strictEqual(new Set(ev.map(r => r[0])).size, ev.length, 'təkrarsız');
    ['Sales', 'SaleLines', 'Products', 'Suppliers', 'StockReceipts', 'Shifts', 'CashMoves', 'SupplierPayments'].forEach(n => assert.strictEqual(be.rows(n).length, 0, n + ' boşdur'));
    assert.ok(be.rows('Users').length >= 5, 'Users vərəqi qalır');
    const st = JSON.parse(be.store.props.ARCHIVE); assert.strictEqual(st.base, 0); assert.strictEqual(st.segs.length, 0);
    assert.ok(Number(be.store.props.receiptSeq || 0) >= oldReceipt || st.maxReceipt >= oldReceipt, 'çek nömrəsi geri düşmür');
    assert.ok(be.rows('Audit').some(r => r[1] === 'server.data_reset'));
  });

  await t('köhnə tətbiq (epoch göndərmir) yaza bilmir: "tətbiqi yeniləyin"', async () => {
    const n = be.rows('Events').length;
    const r = be.post({ action: 'sync', token: TOKEN, device: 'old', since: 0, items: [{ id: 'ev_old1', at: new Date().toISOString(), type: 'product.created', userId: 'u_admin', data: { product: { id: 'p_old' } } }] });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'update');
    assert.strictEqual(be.rows('Events').length, n);
  });

  await t('A (Admin cihazı): növbəti sinxronda yerli iş məlumatı silinir, istifadəçilər və icazələr qalır', async () => {
    let ev = null; A.Sync.on((k, d) => { if (k === 'reset') ev = d; });
    const r = await A.Sync.cycle();
    assert.ok(r.reset && ev, 'reset hadisəsi');
    assert.strictEqual((await A.Services.listProducts()).length, 0);
    assert.strictEqual((await A.DB.getAll('sales')).length, 0); assert.strictEqual((await A.DB.getAll('suppliers')).length, 0);
    assert.strictEqual((await A.DB.getAll('shifts')).length, 0); assert.strictEqual((await A.DB.getAll('lots')).length, 0);
    assert.ok((await A.Services.listUsers()).some(u => u.name === 'Leyla'));
    const m = await A.Services.getMatrix(); assert.ok(!m.kassir.includes('tab.returns'), 'icazə dəyişikliyi qalıb');
    assert.strictEqual((await A.DB.get('meta', 'epoch')).value, res.epoch);
    const again = await A.Sync.cycle(); assert.ok(!again.reset, 'ikinci dəfə sıfırlanmır');
  });

  let p3;
  await t('A yeni iş başlayır: yeni barkod köhnə ilə toqquşmur, yeni məhsul serverə gedir', async () => {
    await loginAs(A, 'Admin', '1234');
    p3 = (await A.Services.createProduct({ name: 'Yeni məhsul', price: 900, cost: 300 })).product;
    assert.notStrictEqual(p3.storeBarcode, oldBarcode);
    await A.Sync.cycle();
    assert.strictEqual(be.rows('Products').length, 1);
  });

  await t('B (oflayn idi): qayıdanda təmizlənir, göndərilməmiş məhsul atılır, PIN dəyişikliyi gedir, A-nın yeni məhsulu gəlir', async () => {
    let ev = null; B.Sync.on((k, d) => { if (k === 'reset') ev = d; });
    await B.Sync.cycle(); await B.Sync.cycle();
    assert.ok(ev && ev.dropped === 1, 'atılan qeyd sayı: ' + JSON.stringify(ev));
    const names = (await B.Services.listProducts()).map(p => p.name);
    assert.deepStrictEqual(J(names), ['Yeni məhsul']);
    assert.ok(!be.rows('Products').some(r => r[1] === 'Oflayn məhsul'), 'köhnə qeyd serverə düşmədi');
    await sync(A, B);
    await loginAs(A, 'Leyla', tempPin);       // B-nin oflayn PIN dəyişikliyi qalıb və serverə gedib
  });

  await t('sonradan qoşulan yeni cihaz yalnız yeni dövrü görür', async () => {
    const C = await boot(be);
    assert.deepStrictEqual(J((await C.Services.listProducts()).map(p => p.name)), ['Yeni məhsul']);
    assert.ok((await C.Services.listUsers()).some(u => u.name === 'Leyla'));
    assert.strictEqual((await C.DB.get('meta', 'epoch')).value, res.epoch);
  });

  await t('təkrar sıfırlama təhlükəsizdir: istifadəçilər yenə qalır, yeni məhsul silinir', async () => {
    const r2 = await A.Sync.resetData(ADMIN_KEY, 'Admin');
    assert.ok(r2.epoch !== res.epoch);
    assert.ok(be.rows('Events').every(r => /^(user|admin|auth)\./.test(String(r[2]))));
    await A.Sync.cycle();
    assert.strictEqual((await A.Services.listProducts()).length, 0);
    assert.ok((await A.Services.listUsers()).some(u => u.name === 'Leyla'));
  });

  console.log((failed ? '✗ ' : '✓ ') + passed + ' keçdi' + (failed ? ', ' + failed + ' uğursuz' : ''));
  process.exit(failed ? 1 : 0);
})();
