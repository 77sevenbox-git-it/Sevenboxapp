/* node tests/reports.test.js — Hesabatlar bölməsi (məhsul üzrə satış, stok, gəlir-xərc), bölmə icazələri, bölmələrin sırası, Excel idxalında təchizatçı.
   1) Fifo.productReport saf funksiyası; 2) xidmət səviyyəsində hesabatlar və icazələr; 3) bölmə icazələri / sıra (iki cihaz, sinxron); 4) idxalda təchizatçı. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');
const Fifo = require('../js/fifo.js');
const Rules = require('../js/rules.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'secret-token';
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
async function boot(be) { const d = makeDevice(be); await d.Services.init(); const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error); return d; }
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
  /* ============ 1. Saf funksiya: Fifo.productReport ============ */
  const D = n => '2026-10-0' + n + 'T10:00:00.000Z';
  const lots = [{ id: 'l1', productId: 'p1', supplierId: 'S1', qty: 10, unitCost: 500, at: D(1) }, { id: 'l2', productId: 'p2', supplierId: 'S2', qty: 5, unitCost: 400, at: D(1) }];
  const sales = [
    { id: 's1', receiptNo: 1, at: D(2), totals: { subtotal: 2200, discount: 0, total: 2200 }, lines: [{ productId: 'p1', name: 'Maşın', storeBarcode: '2000000000015', qty: 2, price: 800 }, { productId: 'p2', name: 'Kukla', qty: 1, price: 600 }] },
    { id: 's2', receiptNo: 2, at: D(3), totals: { subtotal: 1600, discount: 160, total: 1440 }, lines: [{ productId: 'p1', name: 'Maşın', qty: 2, price: 800 }] }
  ];
  const returns = [{ id: 'r1', saleId: 's1', receiptNo: 1, at: D(3), amount: 800, lines: [{ lineIndex: 0, productId: 'p1', name: 'Maşın', qty: 1, price: 800, refund: 800 }] }];
  const res = Fifo.replay({ lots, sales, returns, stock: { p1: 10 - 4 + 1, p2: 4 }, avgCost: {} });

  await t('productReport: satış və qaytarma ayrı toplanır, endirim və FIFO maya düzgündür', () => {
    const r = Fifo.productReport(res, sales, returns, '', '');
    assert.strictEqual(r.p1.soldQty, 4); assert.strictEqual(r.p1.soldRevenue, 1600 + 1440); assert.strictEqual(r.p1.soldCost, 4 * 500);
    assert.strictEqual(r.p1.retQty, 1); assert.strictEqual(r.p1.retRevenue, 800); assert.strictEqual(r.p1.retCost, 500);
    assert.strictEqual(r.p1.name, 'Maşın'); assert.strictEqual(r.p1.barcode, '2000000000015');
    assert.strictEqual(r.p2.soldQty, 1); assert.strictEqual(r.p2.retQty, 0);
  });

  await t('productReport: dövr kəsiyi — satış və qaytarma öz vaxtı ilə düşür', () => {
    const d2 = Fifo.productReport(res, sales, returns, D(2), D(3));       // yalnız 2-ci gün: s1
    assert.strictEqual(d2.p1.soldQty, 2); assert.strictEqual(d2.p1.retQty || 0, 0);
    const d3 = Fifo.productReport(res, sales, returns, D(3), D(4));       // 3-cü gün: s2 + r1
    assert.strictEqual(d3.p1.soldQty, 2); assert.strictEqual(d3.p1.retQty, 1); assert.ok(!d3.p2);
    const only = Fifo.productReport(res, sales, returns, D(3) , D(3).replace('10:00', '10:00'));   // boş aralıq
    assert.strictEqual(Object.keys(only).length, 0);
  });

  await t('productReport: cəmlər Təchizatçı hesabatı ilə uzlaşır (gəlir və maya)', () => {
    const pr = Fifo.productReport(res, sales, returns, '', ''), sr = Fifo.supplierReport(res, sales, returns, '', '');
    const sum = (o, f) => Object.keys(o).reduce((a, k) => a + f(o[k]), 0);
    assert.strictEqual(sum(pr, x => x.soldRevenue - x.retRevenue), sum(sr, x => x.revenue));
    assert.strictEqual(sum(pr, x => x.soldCost - x.retCost), sum(sr, x => x.cost));
  });

  /* ============ 2. Xidmət: məhsul üzrə satış, stok, gəlir-xərc ============ */
  const be = makeBackend({ token: TOKEN });
  const A = await boot(be), B = await boot(be);
  await loginAs(A, 'Admin', '1234');
  let s1, s2, pa, pb, pc, pd, sale1, sale2;
  const mgr = { id: 'u_menecer', name: 'Menecer' };

  await t('hazırlıq: təchizatçılar, 4 məhsul, mal qəbulu, növbə, 2 çek, 1 qaytarma, kassa məxarici, 2 təchizatçı ödənişi', async () => {
    s1 = await A.Services.createSupplier({ name: 'Alfa MMC' }); s2 = await A.Services.createSupplier({ name: 'Beta Toys' });
    pa = (await A.Services.createProduct({ name: 'Maşın', price: 800, cost: 500, minStock: 3 })).product;
    pb = (await A.Services.createProduct({ name: 'Kukla', price: 600, cost: 400 })).product;
    pc = (await A.Services.createProduct({ name: 'Top', price: 300, cost: 100 })).product;       // qalığı olmayacaq
    pd = (await A.Services.createProduct({ name: 'Puzzle', price: 500, cost: 200 })).product;    // mənfi qalığa satılacaq
    await A.Services.receiveStock(pa.id, 10, 500, '', s1.id);
    await A.Services.receiveStock(pb.id, 10, 400, '', s2.id);
    await A.Services.openShift(500000);
    sale1 = await A.Services.checkout([{ productId: pa.id, qty: 3 }, { productId: pb.id, qty: 2 }], null, { method: 'cash', cashReceived: 5000 });
    sale2 = await A.Services.checkout([{ productId: pa.id, qty: 1 }, { productId: pd.id, qty: 1 }], null, { method: 'bank', bankType: 'pos' });
    await A.Services.createReturn(sale1.id, [{ lineIndex: 0, qty: 1 }], mgr, 'xarab');
    await A.Services.cashMove('out', 1500, 'Nahar', mgr);
    await A.Services.cashMove('in', 700, 'Xırda pul');
    await A.Services.paySupplier(s1.id, 2000, 'cash', 'nağd');
    await A.Services.paySupplier(s2.id, 3000, 'bank', 'bank');
  });

  await t('məhsul üzrə satış: hər məhsul üçün satış sətri, qaytarma ayrıca (mənfi) sətir; cəmlər uyğun gəlir', async () => {
    const r = await A.Services.productSalesReport({});
    const rows = r.rows.filter(x => x.productId === pa.id);
    assert.deepStrictEqual(J(rows.map(x => x.kind)), ['sale', 'ret'], 'qaytarma satış sətrindən dərhal sonra ayrı sətirdir');
    assert.strictEqual(rows[0].qty, 4); assert.strictEqual(rows[0].revenue, 4 * 800);
    assert.strictEqual(rows[1].qty, -1); assert.strictEqual(rows[1].revenue, -800);
    assert.strictEqual(rows[1].cost, -500); assert.strictEqual(rows[1].profit, -(800 - 500));
    assert.ok(!r.rows.some(x => x.productId === pb.id && x.kind === 'ret'), 'qaytarması olmayan məhsulda qaytarma sətri yoxdur');
    assert.ok(!r.rows.some(x => x.productId === pc.id), 'satılmayan məhsul hesabatda yoxdur');
    const tot = r.totals;
    assert.strictEqual(tot.soldQty, 4 + 2 + 1); assert.strictEqual(tot.retQty, 1);
    assert.strictEqual(tot.netRevenue, tot.soldRevenue - tot.retRevenue);
    assert.strictEqual(tot.netRevenue, r.rows.reduce((a, x) => a + x.revenue, 0), 'sətirlərin cəmi = yekun');
    assert.strictEqual(tot.netProfit, r.rows.reduce((a, x) => a + x.profit, 0));
    const rep = await A.Services.supplierReport({});
    assert.strictEqual(tot.netRevenue, rep.totals.revenue, 'Təchizatçılar hesabatı ilə eyni gəlir');
  });

  await t('məhsul üzrə satış: dövr seçimi ([from, to)) və boş dövr', async () => {
    const future = await A.Services.productSalesReport({ from: '2999-01-01T00:00:00.000Z' });
    assert.strictEqual(future.rows.length, 0); assert.strictEqual(future.totals.netRevenue, 0);
    const past = await A.Services.productSalesReport({ to: '2000-01-01T00:00:00.000Z' });
    assert.strictEqual(past.rows.length, 0);
  });

  await t('stok hesabatı: qalıq, vəziyyət (ok/low/out/neg), FIFO dəyəri və təchizatçı bölgüsü', async () => {
    const r = await A.Services.stockReport();
    const by = n => r.rows.find(x => x.name === n);
    assert.strictEqual(by('Maşın').qty, 10 - 4 + 1 - 0); assert.strictEqual(by('Maşın').status, 'ok');
    assert.strictEqual(by('Maşın').costValue, 7 * 500); assert.strictEqual(by('Maşın').retailValue, 7 * 800);
    assert.deepStrictEqual(J(by('Maşın').suppliers), [{ name: 'Alfa MMC', qty: 7 }]);
    assert.strictEqual(by('Kukla').qty, 8);
    assert.strictEqual(by('Top').status, 'out'); assert.strictEqual(by('Top').qty, 0);
    assert.strictEqual(by('Puzzle').status, 'neg'); assert.strictEqual(by('Puzzle').qty, -1);
    assert.strictEqual(r.totals.neg, 1); assert.strictEqual(r.totals.out, 1);
    assert.strictEqual(r.totals.qty, 7 + 8); assert.strictEqual(r.totals.costValue, 7 * 500 + 8 * 400);
  });

  await t('stok hesabatı: minimum qalığa çatanda "low"', async () => {
    await A.Services.checkout([{ productId: pa.id, qty: 4 }], null, { method: 'bank', bankType: 'pos' });       // 7 → 3 (min 3)
    const r = await A.Services.stockReport();
    assert.strictEqual(r.rows.find(x => x.name === 'Maşın').status, 'low'); assert.strictEqual(r.totals.low, 1);
    await A.Services.createReturn((await A.Services.recentSales(1))[0].id, [{ lineIndex: 0, qty: 4 }], mgr, 'geri');   // 3 → 7 (sonrakı testlər üçün)
  });

  await t('gəlir-xərc: xalis gəlir, maya, mənfəət; təchizatçı ödənişi mənfəətə girmir, kassa məxarici girir; pul hərəkəti ayrıca', async () => {
    const f = await A.Services.financeReport({});
    const ps = await A.Services.productSalesReport({});
    assert.strictEqual(f.netRevenue, ps.totals.netRevenue, 'məhsul hesabatı ilə eyni xalis gəlir');
    assert.strictEqual(f.cost, ps.totals.netCost);
    assert.strictEqual(f.grossProfit, f.netRevenue - f.cost);
    assert.strictEqual(f.expense, 1500, 'yalnız kassa məxarici (təchizatçı ödənişinin kassa hərəkəti məxaric sayılmır)');
    assert.strictEqual(f.netProfit, f.grossProfit - 1500);
    assert.strictEqual(f.supplierPaid.total, 5000); assert.strictEqual(f.supplierPaid.cash, 2000); assert.strictEqual(f.supplierPaid.bank, 3000);
    assert.strictEqual(f.cashIn, 700, 'təchizatçı ləğvi olmayan mədaxil');
    assert.strictEqual(f.flow.net, f.sales.total - f.returns.total - 1500 - 5000 + 700);
    assert.strictEqual(f.items.filter(x => x.kind === 'expense').length, 1); assert.strictEqual(f.items.filter(x => x.kind === 'supplier').length, 2);
  });

  await t('gəlir-xərc: ləğv edilmiş təchizatçı ödənişi hesabata girmir (və ləğvin kassa mədaxili "mədaxil" sayılmır)', async () => {
    const pays = await A.Services.listSupplierPays(s1.id);
    await A.Services.voidSupplierPay(pays[0].id, 'səhv yazılıb');
    const f = await A.Services.financeReport({});
    assert.strictEqual(f.supplierPaid.total, 3000); assert.strictEqual(f.supplierPaid.cash, 0);
    assert.strictEqual(f.cashIn, 700); assert.strictEqual(f.expense, 1500);
  });

  await t('icazələr: Kassir hesabatları görə bilmir; Mühasib maya görür; alış qiyməti icazəsi alınsa maya/mənfəət null', async () => {
    await sync(A, B); await loginAs(B, 'Kassir', '1111');
    await rejects(B.Services.productSalesReport({}), /icazəniz yoxdur/); await rejects(B.Services.financeReport({}), /icazəniz yoxdur/);
    const sr = await B.Services.stockReport(); assert.ok(sr.rows.length); assert.strictEqual(sr.seeCost, false); assert.strictEqual(sr.rows[0].costValue, null); assert.strictEqual(sr.totals.costValue, null);
    await loginAs(B, 'Mühasib 1', '3333');
    const ps = await B.Services.productSalesReport({}); assert.strictEqual(ps.seeCost, true); assert.ok(ps.totals.netProfit != null);
    await loginAs(A, 'Admin', '1234');
    const m = J(await A.Services.getMatrix()); m.muhasib = m.muhasib.filter(p => p !== 'product.cost.view'); await A.Services.setMatrix(m); await sync(A, B);
    await loginAs(B, 'Mühasib 1', '3333');
    const ps2 = await B.Services.productSalesReport({});
    assert.strictEqual(ps2.seeCost, false); assert.strictEqual(ps2.totals.netProfit, null); assert.ok(ps2.rows.every(x => x.cost === null && x.profit === null));
    await rejects(B.Services.financeReport({}), /icazəniz yoxdur/);          // maya olmadan gəlir-xərc açılmır
    m.muhasib.push('product.cost.view'); await A.Services.setMatrix(m); await sync(A, B);
  });

  /* ============ 3. Bölmə icazələri və sıra ============ */
  await t('bölmə icazələri: ilkin matris — Kassir hesabatlar/təchizatçı/icazə bölməsini görmür, Mühasib görür; Admin hamısını', () => {
    const D0 = Rules.DEFAULT_MATRIX;
    assert.ok(Rules.can(D0, 'admin', 'tab.settings') && Rules.can(D0, 'admin', 'tab.permissions') && Rules.can(D0, 'admin', 'tab.reports'));
    assert.ok(!Rules.can(D0, 'kassir', 'tab.reports') && !Rules.can(D0, 'kassir', 'tab.suppliers') && !Rules.can(D0, 'kassir', 'tab.permissions') && !Rules.can(D0, 'kassir', 'tab.settings'));
    assert.ok(Rules.can(D0, 'kassir', 'tab.pos') && Rules.can(D0, 'kassir', 'tab.shift') && Rules.can(D0, 'kassir', 'tab.returns'));
    assert.ok(Rules.can(D0, 'muhasib', 'tab.reports') && Rules.can(D0, 'muhasib', 'tab.sales') && !Rules.can(D0, 'muhasib', 'tab.pos') && !Rules.can(D0, 'muhasib', 'tab.settings'));
    assert.ok(Rules.can(D0, 'menecer', 'tab.reports') && !Rules.can(D0, 'menecer', 'tab.permissions'));
  });

  await t('köhnə matris (bölmə icazəsi yoxdur) yenilənəndə əvvəl açılan bölmələr saxlanılır; Admin-in bilərəkdən sildiyi bölmə geri qayıtmır', () => {
    const old = { kassir: ['pos.sell', 'shift.open_close', 'product.view'], menecer: ['pos.sell', 'report.view'] };
    const up = Rules.upgradeMatrix(old);
    assert.deepStrictEqual(J(up.kassir.filter(p => p.startsWith('tab.')).sort()), ['tab.pos', 'tab.products', 'tab.shift']);
    assert.ok(up.menecer.includes('tab.reports') && up.menecer.includes('tab.sales') && up.menecer.includes('tab.suppliers'));
    const chosen = { kassir: ['pos.sell', 'product.view', 'tab.pos'] };           // Admin Məhsullar bölməsini kassirdən götürüb
    assert.ok(!Rules.upgradeMatrix(chosen).kassir.includes('tab.products'), 'təkrar yeniləmə seçimi pozmur');
    assert.deepStrictEqual(J(Rules.upgradeMatrix(Rules.upgradeMatrix(old))), J(up), 'yeniləmə idempotentdir');
  });

  await t('bölmələrin sırası: ilkin sıra, Admin dəyişir, sinxron olur; naməlum/yeni bölmələr düzgün; Kassir dəyişə bilmir', async () => {
    await loginAs(A, 'Admin', '1234'); await loginAs(B, 'Kassir', '1111');
    const def = Rules.TABS.map(x => x.id);
    assert.deepStrictEqual(J(await B.Services.getTabOrder()), def);
    await rejects(B.Services.setTabOrder(['shift', 'pos']), /icazəniz yoxdur/);
    await rejects(A.Services.setTabOrder(['pos', 'yoxdur']), /səhvdir/); await rejects(A.Services.setTabOrder('pos'), /səhvdir/);
    const r = await A.Services.setTabOrder(['reports', 'pos', 'pos', 'shift']);
    assert.deepStrictEqual(J(r.order), ['reports', 'pos', 'shift'].concat(def.filter(x => !['reports', 'pos', 'shift'].includes(x))), 'təkrar atılır, çatmayanlar ilkin sıra ilə sonda');
    const n = (await A.DB.getAll('outbox')).filter(e => e.type === 'admin.tab_order_changed').length;
    await A.Services.setTabOrder(r.order);                                                  // eyni sıra: hadisə yaranmır
    assert.strictEqual((await A.DB.getAll('outbox')).filter(e => e.type === 'admin.tab_order_changed').length, n);
    await sync(A, B);
    assert.deepStrictEqual(J(await B.Services.getTabOrder()), J(r.order), 'başqa cihaz eyni sırani görür');
    await loginAs(B, 'Admin', '1234'); await new Promise(res => setTimeout(res, 5));
    await B.Services.setTabOrder(['settings']); await sync(B, A);
    assert.strictEqual((await A.Services.getTabOrder())[0], 'settings', 'son yazan qalib');
  });

  // Saxta / köhnə cihaz hadisələri AYRI serverdə sınanır: gələcək vaxtlı hadisə əsas testlərin son-yazan-qalib sırasını pozmasın
  const inject = (d, type, data, at) => d.DB.atomic(['meta', 'outbox', 'audit'], async tx => { await tx.put('outbox', { id: at + '_000001_inj', at, type, data, userId: 'u_admin', device: 'old-device' }); });

  await t('köhnə versiyalı cihazdan gələn matris (v6) yeni cihazda bölmə icazələri ilə tamamlanır', async () => {
    const be2 = makeBackend({ token: TOKEN }), X = await boot(be2), Y = await boot(be2);
    await sync(X, Y);
    const legacy = J(await X.Services.getMatrix()); Object.keys(legacy).forEach(r => { legacy[r] = legacy[r].filter(p => !p.startsWith('tab.')); });
    await inject(X, 'admin.matrix_changed', { before: null, after: legacy, v: 6 }, new Date().toISOString());      // v6 cihazın yazdığı hadisə: bölmə icazəsi yoxdur
    await sync(X, Y);
    const my = await Y.Services.getMatrix();
    assert.ok(Rules.can(my, 'muhasib', 'tab.reports') && Rules.can(my, 'kassir', 'tab.pos') && !Rules.can(my, 'kassir', 'tab.reports'), 'bölmə icazələri əvvəlki əməliyyat icazələrindən çıxarılıb');
  });

  await t('bölmələrin sırası: saxta hadisə (səhv format) qəbul edilmir', async () => {
    const be3 = makeBackend({ token: TOKEN }), X = await boot(be3), Y = await boot(be3);
    await sync(X, Y); await loginAs(Y, 'Admin', '1234');
    const before = J(await Y.Services.getTabOrder());
    await inject(X, 'admin.tab_order_changed', { before: [], after: [{ x: 1 }, '<script>'] }, new Date().toISOString());
    await sync(X, Y);
    assert.deepStrictEqual(J(await Y.Services.getTabOrder()), before);
  });

  /* ============ 4. Excel idxalında təchizatçı ============ */
  const mk = (line, name, supplier, opening) => ({ line, name, price: 900, cost: 500, opening, supplier, errors: [] });
  await t('idxal: təchizatçı sütunu — mövcud ad (hərf fərqi nəzərə alınmır) bağlanır, olmayan icazə olmadan səhvdir, icazə ilə yeni yaradılır', async () => {
    const sups = await A.Services.listSuppliers({ all: true });
    const c = A.Import.classify([mk(2, 'Lego A', 'alfa mmc', 4), mk(3, 'Lego B', 'Yoxdur MMC', 1)], [], false, { list: sups, create: false });
    assert.strictEqual(c[0].supplierId, s1.id); assert.strictEqual(c[0].status, 'new');
    assert.strictEqual(c[1].status, 'error'); assert.ok(c[1].supplierMissing);
    const c2 = A.Import.classify([mk(2, 'Lego C', 'Yoxdur MMC', 3)], [], false, { list: sups, create: true });
    assert.strictEqual(c2[0].supplierNew, 'Yoxdur MMC'); assert.strictEqual(c2[0].status, 'new');
    const eff = A.Import.supplierEffect(c2, sups);
    assert.strictEqual(eff.length, 1); assert.strictEqual(eff[0].isNew, true); assert.strictEqual(eff[0].amount, 3 * 500);
  });

  await t('idxal: faylda təchizatçı → partiya təchizatçıya bağlanır, yeni təchizatçı bir dəfə yaranır, borc alış qiymətinə görə artır', async () => {
    await loginAs(A, 'Admin', '1234');
    const before = (await A.Services.supplierBalances()).balances[s1.id].debt;
    const sups = await A.Services.listSuppliers({ all: true });
    const rows = A.Import.classify([mk(2, 'Lego A', 'Alfa MMC', 4), mk(3, 'Lego C', 'Yeni Təchizatçı', 3), mk(4, 'Lego D', 'yeni təchizatçı', 2)], [], false, { list: sups, create: true });
    const r = await A.Services.importProducts(rows);
    assert.strictEqual(r.created, 3); assert.strictEqual(r.suppliers, 1, 'eyni yeni ad (böyük/kiçik hərf fərqi) bir təchizatçı yaradır');
    const all = await A.Services.listSuppliers({ all: true });
    const neu = all.filter(x => x.name === 'Yeni Təchizatçı'); assert.strictEqual(neu.length, 1);
    const bal = (await A.Services.supplierBalances()).balances;
    assert.strictEqual(bal[s1.id].debt - before, 4 * 500); assert.strictEqual(bal[neu[0].id].debt, 5 * 500);
    const lots = await A.Services.productLots((await A.Services.listProducts()).find(p => p.name === 'Lego A').id);
    assert.strictEqual(lots[0].supplier, 'Alfa MMC');
  });

  await t('idxal: yeni təchizatçı yaratmaq üçün supplier.manage lazımdır (Menecer-də var; icazəsiz rol idxal edə bilmir)', async () => {
    const m = J(await A.Services.getMatrix()); const keep = m.menecer.slice();
    m.menecer = m.menecer.filter(p => p !== 'supplier.manage'); await A.Services.setMatrix(m); await sync(A, B);
    await loginAs(B, 'Menecer', '2222');
    const sups = await B.Services.listSuppliers({ all: true });
    const rows = B.Import.classify([mk(2, 'Lego Z', 'Tamam Yeni', 1)], [], false, { list: sups, create: true });
    await rejects(B.Services.importProducts(rows), /icazəniz yoxdur/);
    m.menecer = keep; await A.Services.setMatrix(m); await sync(A, B);
  });

  console.log((failed ? '✗ ' : '✓ ') + passed + ' keçdi' + (failed ? ', ' + failed + ' uğursuz' : ''));
  process.exit(failed ? 1 : 0);
})();
