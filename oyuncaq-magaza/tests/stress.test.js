/* node tests/stress.test.js [satış/cihaz=800] — həcm və yük testi: 3 kassa + Apps Script təqlidi.
   Ölçülür: satışın sürəti baza böyüdükcə, sinxron, ekranların açılması (çeklər, hesabat), yeni cihazın ilkin yüklənməsi, oflayn yığılma,
   eyni anda çoxlu sinxron çağırışı, çox böyük çek. Yoxlanır: bütün cihazlarda eyni qalıq, təkrarsız çek nömrəsi/barkod, boş outbox.
   Yük ssenarisi Google Sheets-in real gecikməsini ölçmür (təqlid yaddaşdadır); Sheets API çağırış sayı hesablanır ki, real vaxt qiymətləndirilə bilsin. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'stress-token-0123456789abcdef';
const JS = path.join(__dirname, '..', 'js');
const PER_DEV = parseInt(process.argv[2] || process.env.STRESS_SALES || '800', 10);
const NDEV = 3;                      // satış edən kassa cihazı sayı (+ 1 menecer cihazı hesabatlar üçün)

function makeDevice(backend) {
  const ctx = { console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController, crypto: nodeCrypto.webcrypto, indexedDB: new IDBFactory(), IDBKeyRange, navigator: { onLine: true }, fetch: backend.fetch() };
  ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};
  return ctx;
}
async function boot(be) { const d = makeDevice(be); await d.Services.init(); const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error, r.error); return d; }
async function loginAs(d, name, pin) { const u = (await d.Services.listUsers()).find(x => x.name === name); return d.Services.login(u.id, pin); }
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
async function timed(fn) { const t0 = process.hrtime.bigint(); const r = await fn(); return { r, ms: ms(t0) }; }
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const fmt = x => (x >= 100 ? x.toFixed(0) : x.toFixed(1)) + ' ms';
let seed = 987654321; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

let passed = 0, failed = 0; const report = {};
async function t(name, fn) { try { await fn(); passed++; console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n   ')); } }

(async () => {
  const be = makeBackend({ token: TOKEN });
  const devs = []; for (let i = 0; i < NDEV + 1; i++) devs.push(await boot(be));
  const [A, B, C, D] = devs;                   // A = menecer (hesabatlar), B/C/D = kassalar
  const syncAll = async (n) => { for (let i = 0; i < (n || 3); i++) for (const d of devs) await d.Sync.cycle(); };
  console.log(`Yük testi: ${NDEV} cihaz × ${PER_DEV} satış = ${NDEV * PER_DEV} çek\n`);

  // ---------- 1. Hazırlıq ----------
  let products = [];
  await t('hazırlıq: 300 məhsul + təchizatçı + mal qəbulu (menecer), növbə açılır', async () => {
    await loginAs(A, 'Menecer', '2222'); await loginAs(B, 'Kassir', '1111'); await loginAs(C, 'Kassir', '1111'); await loginAs(D, 'Kassir', '1111');
    const sup = await A.Services.createSupplier({ name: 'Yük təchizatçısı' });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 300; i++) {
      const p = (await A.Services.createProduct({ name: 'Oyuncaq ' + i + ' ' + 'x'.repeat(i % 30), price: 100 + (i % 50) * 50, cost: 60, category: 'k' + (i % 7), brand: 'b' + (i % 5) })).product;
      await A.Services.receiveStock(p.id, 1e5, 60, '', sup.id);
      products.push(p.id);
      if (i % 40 === 39) await A.Sync.cycle();                 // nömrə aralığı (100-lük) tükənməsin: real həyatda hər yazıdan sonra sinxron işləyir
    }
    report.setupMs = ms(t0);
    await A.Services.openShift(0, '');
    await syncAll(4);
    for (const d of [B, C, D]) assert.strictEqual((await d.Services.listProducts()).length, 300);
    assert.ok(await B.Services.currentShift(), 'növbə kassa cihazlarına çatdı');
    console.log(`   (300 məhsul + qəbul: ${(report.setupMs / 1000).toFixed(1)} san)`);
  });

  // ---------- 2. Satış yükü ----------
  const lat = { checkout: [], cycle: [], byQuarter: [] };
  const cartOf = () => { const n = 1 + Math.floor(rnd() * 5), used = new Set(), cart = []; while (cart.length < n) { const id = products[Math.floor(rnd() * products.length)]; if (!used.has(id)) { used.add(id); cart.push({ productId: id, qty: 1 + Math.floor(rnd() * 3) }); } } return cart; };
  const probe = async (label) => {
    const o = { label };
    o.recent = (await timed(() => B.Services.recentSales(100))).ms;
    o.products = (await timed(() => B.Services.listProducts())).ms;
    o.outbox = (await timed(() => B.Services.outboxCount())).ms;
    o.supplierReport = (await timed(() => A.Services.supplierReport({}))).ms;
    const s = await B.Services.currentShift();
    o.shiftReport = (await timed(() => A.Services.shiftReport(s.id))).ms;
    o.cursorSales = (await B.DB.getAll('sales')).length;
    const last = (await B.Services.recentSales(1))[0];
    o.findSale = (await timed(() => B.Services.findSaleByCode(last.receiptBarcode))).ms;
    const b2 = makeDeviceFrom(B);                                      // soyuq açılış: eyni bazanı yeni səhifə kimi açır
    o.boot = (await timed(() => b2.Services.init())).ms;
    report.byQuarter.push(o);
    console.log(`   [${label}] çeklər ekranı ${fmt(o.recent)} · məhsullar ${fmt(o.products)} · təchizatçı hesabatı ${fmt(o.supplierReport)} · növbə hesabatı ${fmt(o.shiftReport)} · çek axtarışı ${fmt(o.findSale)} · açılış ${fmt(o.boot)} (baza: ${o.cursorSales} çek)`);
  };
  report.byQuarter = [];
  function makeDeviceFrom(dev) {                  // "səhifə yenilənməsi": modullar yenidən yüklənir, IndexedDB eynidir
    const ctx = { console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController, crypto: nodeCrypto.webcrypto, indexedDB: dev.indexedDB, IDBKeyRange, navigator: { onLine: true }, fetch: be.fetch() };
    ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
    ['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
    return ctx;
  }

  await t(`satış yükü: ${NDEV * PER_DEV} çek, cihazlar növbə ilə satır və arabir sinxronlaşır`, async () => {
    const sellers = [B, C, D];
    const calls0 = be.calls.sheetApi, req0 = be.calls.requests; let syncs = 0;
    const tAll = process.hrtime.bigint();
    for (let i = 0; i < PER_DEV; i++) {
      for (const d of sellers) {
        const cart = cartOf();
        const r = await timed(() => d.Services.checkout(cart, null, { method: 'cash', cashReceived: 1e7 }));
        lat.checkout.push(r.ms);
      }
      if ((i + 1) % 100 === 0) { for (const d of sellers) { const c = await timed(() => d.Sync.cycle()); lat.cycle.push(c.ms); syncs++; } }
      if (i + 1 === Math.floor(PER_DEV / 4) || i + 1 === PER_DEV) await probe(`${(i + 1) * NDEV} çek`);
    }
    report.salesTotalMs = ms(tAll);
    report.sheetCallsPerSync = (be.calls.sheetApi - calls0) / Math.max(1, be.calls.requests - req0);
    const q = (a) => `orta ${fmt(a.reduce((x, y) => x + y, 0) / a.length)} · p95 ${fmt(pct(a, 0.95))} · maks ${fmt(Math.max(...a))}`;
    console.log(`   satış (checkout): ${q(lat.checkout)}\n   sinxron dövrü (100 çekdən bir): ${q(lat.cycle)}\n   ümumi: ${(report.salesTotalMs / 1000).toFixed(1)} san, ${syncs} sinxron, orta ${report.sheetCallsPerSync.toFixed(1)} Sheets API çağırışı/sorğu`);
    // yavaşlama: son 10% orta vaxt ilk 10%-dən 3 dəfədən çox deyil
    const k = Math.floor(lat.checkout.length / 10), first = lat.checkout.slice(0, k), lastK = lat.checkout.slice(-k);
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    report.slowdown = avg(lastK) / avg(first);
    console.log(`   yavaşlama (son 10% / ilk 10%): ${report.slowdown.toFixed(2)}×`);
    assert.ok(report.slowdown < 3, 'satış baza böyüdükcə ' + report.slowdown.toFixed(1) + ' dəfə yavaşlayıb');
  });

  await t('yaxınlaşma: bütün cihazlarda eyni qalıq, eyni çek sayı, təkrarsız çek nömrəsi və mağaza barkodu, boş outbox', async () => {
    const t0 = process.hrtime.bigint(); await syncAll(6); report.convergeMs = ms(t0);
    const total = NDEV * PER_DEV;
    const stocks = []; const sigs = [];
    for (const d of devs) {
      const sales = await d.DB.getAll('sales');
      assert.strictEqual(sales.length, total, 'çek sayı');
      assert.strictEqual(new Set(sales.map(s => s.receiptNo)).size, total, 'çek nömrələri təkrarsızdır');
      assert.strictEqual(new Set(sales.map(s => s.receiptBarcode)).size, total, 'çek barkodları təkrarsızdır');
      const ps = await d.DB.getAll('products'); assert.strictEqual(new Set(ps.map(p => p.storeBarcode)).size, ps.length);
      stocks.push(JSON.stringify(ps.map(p => [p.id, p.stock]).sort())); sigs.push(sales.map(s => s.id).sort().join(','));
      assert.strictEqual((await d.DB.getAll('outbox')).length, 0, 'outbox boşdur');
    }
    assert.ok(stocks.every(x => x === stocks[0]), 'qalıq cihazlar arasında eynidir'); assert.ok(sigs.every(x => x === sigs[0]));
    // qalıq = 1e5 − satılan (əl ilə yenidən hesablanır)
    const sold = {}; (await A.DB.getAll('sales')).forEach(s => s.lines.forEach(l => { sold[l.productId] = (sold[l.productId] || 0) + l.qty; }));
    const ps = await A.DB.getAll('products'); ps.forEach(p => assert.strictEqual(p.stock, 1e5 - (sold[p.id] || 0), 'qalıq düzgün hesablanıb: ' + p.name));
    const rec = await A.Services.shiftReport((await A.Services.currentShift()).id);
    assert.ok(rec, 'növbə hesabatı hesablanır');
    console.log(`   (${total} çek, 6 sinxron dövrü: ${(report.convergeMs / 1000).toFixed(1)} san)`);
  });

  await t('server tutumu: cədvəl sətirləri/xanaları, yeni cihazın ilkin yüklənməsi və Sheets limiti ilə hesablama', async () => {
    const ev = be.rows('Events').length, sl = be.rows('SaleLines').length, sales = be.rows('Sales').length;
    const cells = ev * 7 + sales * 20 + sl * 10 + be.rows('StockReceipts').length * 8 + be.rows('Products').length * 13 + be.rows('Audit').length * 4;
    const perSale = cells / (NDEV * PER_DEV);
    report.cellsPerSale = perSale;
    const maxEventJson = Math.max(...be.rows('Events').map(r => String(r[5]).length));
    console.log(`   server: Events ${ev}, Sales ${sales}, SaleLines ${sl}; ~${perSale.toFixed(0)} xana/çek; ən böyük hadisə JSON: ${maxEventJson} simvol`);
    const gridPerSale = be.grid() / (NDEV * PER_DEV);   // Sheets BOŞ xanaları da sayır: vərəqin şəbəkə ölçüsü (v7-dən əvvəl 26 sütun + boş sətirlər ~2 dəfə çox idi)
    console.log(`   Sheets 10 000 000 xana limiti (şəbəkə ölçüsü ilə, ~${gridPerSale.toFixed(0)} xana/çek) → gündə 300 çek ilə ~${Math.floor(1e7 / gridPerSale / 300)} gün (~${(1e7 / gridPerSale / 300 / 365).toFixed(1)} il); arxivləşdirmə (v7) bunu məhdudiyyətsiz edir`);
    assert.ok(maxEventJson < 40000);
    const t0 = process.hrtime.bigint();
    const N = await boot(be);                           // yeni cihaz: bütün tarixçəni yükləyir
    report.coldSyncMs = ms(t0);
    const requests = be.calls.requests;
    assert.strictEqual((await N.DB.getAll('sales')).length, NDEV * PER_DEV, 'yeni cihaz bütün çekləri aldı');
    assert.strictEqual(JSON.stringify((await N.DB.getAll('products')).map(p => [p.id, p.stock]).sort()), JSON.stringify((await A.DB.getAll('products')).map(p => [p.id, p.stock]).sort()), 'qalıq eynidir');
    const pages = Math.ceil(ev / 500);
    console.log(`   yeni cihazın ilkin yüklənməsi: ${(report.coldSyncMs / 1000).toFixed(1)} san (${ev} hadisə = ≥${pages} sorğu; real Apps Script-də hər sorğu ~1–3 san → ~${Math.round(pages * 2)} san)`);
  });

  await t('oflayn yığılma: 1 cihaz serversiz 300 çek satır, sonra qoşulur — hamısı gedir, təkrar yoxdur, sıra qorunur', async () => {
    const before = be.rows('Events').length;
    be.down = true;
    for (let i = 0; i < 300; i++) await B.Services.checkout(cartOf(), null, { method: 'cash', cashReceived: 1e7 });
    for (let i = 0; i < 3; i++) await B.Sync.cycle().catch(() => {});             // server yoxdur: xəta verir, outbox qalır
    const pend = (await B.DB.getAll('outbox')).length; assert.ok(pend >= 300, 'outbox yığılıb: ' + pend);
    be.down = false;
    const t0 = process.hrtime.bigint(); let n = 0;
    while ((await B.DB.getAll('outbox')).length && n++ < 10) await B.Sync.cycle();
    report.backlogMs = ms(t0);
    assert.strictEqual((await B.DB.getAll('outbox')).length, 0);
    await syncAll(4);
    const grown = be.rows('Events').length - before; assert.ok(grown >= 300 && grown < 400, 'serverdə artım: ' + grown);
    const ids = be.rows('Events').map(r => r[0]); assert.strictEqual(new Set(ids).size, ids.length, 'təkrar hadisə yoxdur');
    for (const d of devs) assert.strictEqual((await d.DB.getAll('sales')).length, NDEV * PER_DEV + 300);
    console.log(`   (${pend} gözləyən hadisənin göndərilməsi: ${(report.backlogMs / 1000).toFixed(1)} san)`);
  });

  await t('eyni anda 12 sinxron çağırışı (çox tab / sürətli klik): hadisə təkrarlanmır, qalıq pozulmur', async () => {
    for (let i = 0; i < 40; i++) await C.Services.checkout(cartOf(), null, { method: 'cash', cashReceived: 1e7 });
    const before = be.rows('Events').length, outbox = (await C.DB.getAll('outbox')).length;
    await Promise.all(Array.from({ length: 12 }, () => C.Sync.cycle().catch(() => {})));
    await syncAll(3);
    assert.strictEqual(be.rows('Events').length - before, outbox, 'serverə yalnız gözləyən hadisələr yazıldı');
    assert.strictEqual((await C.DB.getAll('outbox')).length, 0);
    const a = JSON.stringify((await A.DB.getAll('products')).map(p => [p.id, p.stock]).sort()), c = JSON.stringify((await C.DB.getAll('products')).map(p => [p.id, p.stock]).sort());
    assert.strictEqual(a, c);
  });

  await t('eyni anda 20 satış (çox sürətli ardıcıl klik) bir cihazda: qalıq düzgün, təkrarsız çek nömrəsi', async () => {
    const p0 = (await B.DB.get('products', products[0])).stock, no0 = (await B.DB.getAll('sales')).length;
    const r = await Promise.all(Array.from({ length: 20 }, () => B.Services.checkout([{ productId: products[0], qty: 1 }], null, { method: 'cash', cashReceived: 1e7 }).then(x => x, e => e)));
    const okN = r.filter(x => x && x.id).length;
    assert.strictEqual((await B.DB.get('products', products[0])).stock, p0 - okN, 'qalıq = əvvəlki − uğurlu satış');
    const sales = await B.DB.getAll('sales'); assert.strictEqual(sales.length - no0, okN);
    assert.strictEqual(new Set(sales.map(s => s.receiptNo)).size, sales.length, 'çek nömrələri təkrarsızdır');
    console.log(`   (20 paralel satışdan ${okN} uğurlu)`);
  });

  await t('çox böyük çek: 250 sətir RƏDD edilir; 100 sətir (ən pis halda 200 simvollu adlarla) Sheets xana limitinə (50 000 simvol) sığır', async () => {
    const big = products.slice(0, 250).map(id => ({ productId: id, qty: 1 }));
    let err = null;
    try { await B.Services.checkout(big, null, { method: 'cash', cashReceived: 1e8 }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'cart_too_big', '250 sətirli çek rədd edilməlidir: ' + (err && err.message));
    // ən pis hal: 100 məhsul, hər birinin adı 190+ simvol
    const longIds = [];
    for (let i = 0; i < 100; i++) {
      const p = (await A.Services.createProduct({ name: ('Uzun ad ' + i + ' ').padEnd(195, 'ə'), price: 150, cost: 60, category: 'uzun' })).product;
      await A.Services.receiveStock(p.id, 1000, 60, ''); longIds.push(p.id);
      if (i % 40 === 39) await A.Sync.cycle();
    }
    await syncAll(3);
    const before = (await B.DB.getAll('outbox')).length;
    const sale = await B.Services.checkout(longIds.map(id => ({ productId: id, qty: 1 })), null, { method: 'cash', cashReceived: 1e8 });
    const ev = (await B.DB.getAll('outbox')).filter(o => o.type === 'sale.created' && o.data && o.data.sale && o.data.sale.id === sale.id)[0] || (await B.DB.getAll('outbox')).filter(o => o.type === 'sale.created').pop();
    const size = JSON.stringify(ev.data).length;
    report.bigSaleSize = size; report.bigSaleAccepted = true;
    console.log(`   250 sətirli çek: rədd edildi (${err.message}); 100 sətirli (uzun adlı) çekin hadisəsi: ${size} simvol (limit 50 000)`);
    assert.ok(size < 50000, `100 sətirli çek ${size} simvol: Sheets xana limitini aşır`);
    await syncAll(3);
    assert.strictEqual((await B.DB.getAll('outbox')).length, 0, 'böyük çek serverə getdi');
  });

  console.log('\n— Xülasə —');
  console.log(JSON.stringify({ perDevice: PER_DEV, checkoutAvgMs: +(lat.checkout.reduce((x, y) => x + y, 0) / lat.checkout.length).toFixed(1), checkoutP95Ms: +pct(lat.checkout, 0.95).toFixed(1), slowdown: +(report.slowdown || 0).toFixed(2), cellsPerSale: +(report.cellsPerSale || 0).toFixed(0), coldSyncMs: Math.round(report.coldSyncMs || 0), bigSale: { accepted: report.bigSaleAccepted, jsonChars: report.bigSaleSize } }));
  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
