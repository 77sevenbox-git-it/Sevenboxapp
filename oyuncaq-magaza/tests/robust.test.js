/* node tests/robust.test.js — sinxronun "ilişməməsi": Sheets-in 50 000 simvol/xana həddi və yeni sütunları olmayan (setup() işlədilməmiş) cədvəl.
   1) Cihaz: çox böyük əməliyyat YAZILMIR (geri qaytarılır), ən böyük real çek sığır; məhsul sahələrinin uzunluğu məhdud.
   2) Server (Code.gs təqlidi, Sheets-in xana həddi ilə): sığmayan hadisə növbəni ilişdirmir; köhnə sütunlu vərəq özü sağalır. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'secret-token';
const JS = path.join(__dirname, '..', 'js');
let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n   ')); } }
async function rejects(p, re) {
  try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('Gözlənilməyən xəta: ' + e.message + ' (gözlənilən ' + re + ')'); return e; }
  throw new Error('Xəta gözlənilirdi');
}

function makeDevice(backend) {
  const ctx = {
    console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController,
    crypto: nodeCrypto.webcrypto, indexedDB: new IDBFactory(), IDBKeyRange, navigator: { onLine: true }, fetch: backend.fetch()
  };
  ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};
  return ctx;
}
const boot = async be => { const d = makeDevice(be); await d.Services.init(); const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error, r.error); return d; };
const loginAs = async (d, name, pin) => d.Services.login((await d.Services.listUsers()).find(x => x.name === name).id, pin);
const sync = async (...ds) => { for (let i = 0; i < 3; i++) for (const d of ds) await d.Sync.cycle(); };

(async () => {
  const be = makeBackend({ token: TOKEN });
  const A = await boot(be), B = await boot(be);
  await loginAs(A, 'Admin', '1234');
  const SHEETS = vm.runInContext('SHEETS', be.sandbox);
  let evN = 0;
  const forge = (type, data) => { const at = new Date().toISOString(); return { id: at + '_' + String(++evN).padStart(6, '0') + '_a_rb' + evN, at, type, userId: 'u_admin', device: 'rb_dev', data }; };
  const post = items => be.post({ action: 'sync', token: TOKEN, device: 'rb_dev', since: 0, items, limit: 1 });
  const evRow = id => be.rows('Events').find(r => r[0] === id);

  /* ============ 1. Cihaz ============ */
  await t('cihaz: Sheets xanasına sığmayan əməliyyat yazılmır (geri qaytarılır), növbə və mağaza məlumatı dəyişmir', async () => {
    const outBefore = (await A.DB.getAll('outbox')).length, auditBefore = (await A.DB.getAll('audit')).length;
    const storeBefore = JSON.stringify((await A.DB.get('meta', 'store')) || null);
    const e = await rejects(A.Services.setStoreInfo({ address: 'x'.repeat(50000) }), /çox böyükdür/);
    assert.strictEqual(e.code, 'event_too_big');
    assert.strictEqual((await A.DB.getAll('outbox')).length, outBefore);
    assert.strictEqual((await A.DB.getAll('audit')).length, auditBefore);
    assert.strictEqual(JSON.stringify((await A.DB.get('meta', 'store')) || null), storeBefore, 'yerli yazı geri qaytarılıb');
    await A.Services.setStoreInfo({ address: 'y'.repeat(1000) });          // normal əməliyyat yenə işləyir
  });

  await t('cihaz: məhsulun kateqoriya/marka/yaş qrupu 200, istehsalçı barkodu 500 simvolla məhdud', async () => {
    const ok = { name: 'Limit', price: 100 };
    await rejects(A.Services.createProduct(Object.assign({}, ok, { category: 'k'.repeat(201) })), /200 simvoldan/);
    await rejects(A.Services.createProduct(Object.assign({}, ok, { brand: 'k'.repeat(201) })), /200 simvoldan/);
    await rejects(A.Services.createProduct(Object.assign({}, ok, { ageGroup: 'k'.repeat(201) })), /200 simvoldan/);
    await rejects(A.Services.createProduct(Object.assign({}, ok, { mfrBarcode: '7'.repeat(501) })), /500 simvoldan/);
    const p = (await A.Services.createProduct(Object.assign({}, ok, { name: 'Limit-ok', category: 'k'.repeat(200), brand: 'b'.repeat(200), ageGroup: 'a'.repeat(200), mfrBarcode: '7'.repeat(500) }))).product;
    assert.strictEqual(p.category.length, 200);
  });

  await t('cihaz: ən böyük real çek (100 sətir, 200 simvollu adlar, sətir endirimi) həddə sığır', async () => {
    const MAX = A.Services.MAX_CART_LINES;
    assert.strictEqual(A.Services.EVENT_MAX_CHARS, 45000);
    const cart = [];
    for (let i = 0; i < MAX; i++) {
      const p = (await A.Services.createProduct({ name: String(i).padStart(3, '0') + 'N'.repeat(197), price: 1000, cost: 500, maxDiscount: 10, category: 'c'.repeat(200) })).product;
      await A.Services.receiveStock(p.id, 5, 500);
      cart.push({ productId: p.id, qty: 1 });
    }
    await A.Services.openShift(100000);
    const mgr = await A.Services.approveWithPin('2222', 'pos.discount.approve');
    cart.forEach(l => { l.discount = { type: 'percent', percent: 10, approvedBy: mgr }; });
    const sale = await A.Services.checkout(cart, { type: 'percent', percent: 5, approvedBy: mgr }, { method: 'cash', cashReceived: 10000000 });
    const ev = (await A.DB.getAll('outbox')).find(o => o.type === 'sale.created' && o.data.sale && o.data.sale.id === sale.id);
    assert.ok(ev, 'sale.created hadisəsi outbox-dadır');
    const size = JSON.stringify(ev.data).length;
    console.log('   ən böyük çek hadisəsi: ' + size + ' simvol (hədd ' + A.Services.EVENT_MAX_CHARS + ', Sheets xanası 50000)');
    assert.ok(size < A.Services.EVENT_MAX_CHARS, 'çek hadisəsi həddi aşır: ' + size);
  });

  /* ============ 2. Server ============ */
  await sync(A, B);
  await t('server: sığmayan hadisə qəbul olunur (növbə ilişmir), Events-də işarə və Audit-də qeyd qalır, sonrakılar gəlir', async () => {
    const big = forge('audit.note', { x: 'Z'.repeat(60000) });
    const after = forge('audit.note', { x: 'normal' });
    const r = post([big, after]);
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual(r.acked, [big.id, after.id], 'hər ikisi təsdiqlənib: cihaz növbəsi boşalır');
    assert.deepStrictEqual(JSON.parse(evRow(big.id)[5]), { _tooBig: JSON.stringify({ x: 'Z'.repeat(60000) }).length });
    assert.deepStrictEqual(JSON.parse(evRow(after.id)[5]), { x: 'normal' });
    const au = be.rows('Audit').find(row => row[1] === 'server.event_too_big');
    assert.ok(au, 'Audit-də server.event_too_big var');
    const info = JSON.parse(au[3]); assert.strictEqual(info.id, big.id); assert.strictEqual(info.type, 'audit.note');
    const again = post([big]); assert.ok(again.ok); assert.deepStrictEqual(again.acked, [big.id]);       // təkrar göndəriş ikiqat yazmır
    assert.strictEqual(be.rows('Events').filter(row => row[0] === big.id).length, 1);
  });

  await t('server: işarəli hadisəni çəkən cihaz çökmür, sinxron davam edir', async () => {
    await sync(A, B);
    const p = (await A.Services.createProduct({ name: 'Sonrakı', price: 300 })).product;
    await sync(A, B);
    assert.ok(await B.DB.get('products', p.id), 'işarədən sonrakı hadisə B-yə çatdı');
    assert.strictEqual((await A.DB.getAll('outbox')).length, 0);
  });

  await t('server: bir xanası 50 000-dən uzun cədvəl sətri yazını yıxmır — mətn kəsilir', async () => {
    const e = forge('product.created', { product: { id: 'p_huge', name: 'H'.repeat(60000), price: 100, stock: 0, active: true, category: '', brand: '', ageGroup: '', storeBarcode: '2999999999999', mfrBarcode: '', avgCost: 0, lastCost: 0, minStock: 0, updatedAt: new Date().toISOString() } });
    const next = forge('audit.note', { x: 'sonra' });
    const r = post([e, next]);
    assert.ok(r.ok, r.error); assert.deepStrictEqual(r.acked, [e.id, next.id]);
    const row = be.rows('Products').find(x => x[0] === 'p_huge');
    assert.ok(row, 'sətir yazılıb'); assert.ok(row[1].length <= 49000 && row[1].endsWith('…[kəsildi]'), 'ad kəsilib: ' + row[1].length);
    assert.ok(evRow(next.id), 'sonrakı hadisə də yazılıb');
  });

  await t('server: yeni sütunlar olmayan (setup() işlədilməmiş) vərəqlər özü sağalır — sinxron xəta ilə ilişmir', async () => {
    const OLD = { Sales: 20, SaleLines: 10, Products: 13 };
    const ss = be.store.spreadsheets['ss-main'];
    for (const name of Object.keys(OLD)) {                        // əvvəlki buraxılışın vərəqləri: az sütun, köhnə başlıq
      let sh = ss.getSheetByName(name);
      if (!sh) { sh = ss.insertSheet(name); sh.appendRow(SHEETS[name]); }
      sh.rows[0] = SHEETS[name].slice(0, OLD[name]);
      sh.deleteColumns(OLD[name] + 1, sh.getMaxColumns() - OLD[name]);
      assert.strictEqual(sh.getMaxColumns(), OLD[name]);
    }
    const prod = (await A.Services.createProduct({ name: 'Sağalma', price: 2000, cost: 1000, maxDiscount: 10 })).product;
    await A.Services.receiveStock(prod.id, 5, 1000);
    const mgr = await A.Services.approveWithPin('2222', 'pos.discount.approve');
    const sale = await A.Services.checkout([{ productId: prod.id, qty: 2, discount: { type: 'amount', amount: 100, approvedBy: mgr } }], null, { method: 'cash', cashReceived: 10000 });
    const errsBefore = be.rows('Audit').filter(r => r[1] === 'server.project_error').length;
    await sync(A, B);
    assert.strictEqual((await A.DB.getAll('outbox')).length, 0, 'növbə boşalıb (ilişmə yoxdur)');
    for (const name of Object.keys(OLD)) {
      const sh = ss.getSheetByName(name);
      assert.deepStrictEqual(sh.rows[0].slice(0, SHEETS[name].length), SHEETS[name], name + ': başlıq tam bərpa olunub');
      assert.ok(sh.getMaxColumns() >= SHEETS[name].length, name + ': sütunlar əlavə olunub');
    }
    const col = (sheet, n) => SHEETS[sheet].indexOf(n);
    const srow = be.rows('Sales').find(r => r[0] === sale.id);
    assert.ok(srow, 'Sales sətri yazılıb'); assert.strictEqual(srow[col('Sales', 'lineDiscount')], 1);            // Sheets-də məbləğlər ₼ ilə (100 qəpik = 1)
    assert.strictEqual(be.rows('SaleLines').find(r => r[0] === sale.id)[col('SaleLines', 'discount')], 1);
    assert.strictEqual(be.rows('Products').find(r => r[0] === prod.id)[col('Products', 'maxDiscount')], 10);
    assert.strictEqual(be.rows('Audit').filter(r => r[1] === 'server.project_error').length, errsBefore, 'proyeksiya xətası yoxdur');
    assert.ok(await B.DB.get('sales', sale.id), 'B cihazı çeki aldı');
  });

  console.log('\n' + passed + ' keçdi, ' + failed + ' uğursuz');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
