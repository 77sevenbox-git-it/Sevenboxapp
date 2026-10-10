/* node tests/supplier.test.js — tədarükçü borcu, ödənişlər, kassaya təsir, hesabat sənədi.
   1) Fifo.supplierStatement saf funksiyası (hər iki əsas, ləğv, dövr kəsiyi); 2) iki cihaz + Code.gs təqlidi ilə uçdan-uca. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');
const Fifo = require('../js/fifo.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'secret-token';
const JS = path.join(__dirname, '..', 'js');

function makeDevice(backend, extra) {
  const store = {};
  const ctx = {
    console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController,
    crypto: nodeCrypto.webcrypto, indexedDB: new IDBFactory(), IDBKeyRange,
    navigator: { onLine: true }, fetch: backend.fetch(),
    sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } }
  };
  if (extra) { ctx.localStorage = { getItem: () => null, setItem() {} }; ctx.document = { documentElement: {} }; }
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  const files = (extra ? ['i18n', 'lang-ru', 'lang-en', 'lang-tr'] : []).concat(['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync']).concat(extra ? ['ui', 'print'] : []);
  files.forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};
  return ctx;
}
async function boot(be, extra) { const d = makeDevice(be, extra); await d.Services.init(); const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error); return d; }
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
  /* ============ 1. Saf funksiya: Fifo.supplierStatement ============ */
  // Təchizatçı S1 (alınan mal əsası), S2 (satılan mal). Zaman: gün 1..4
  const D = n => '2026-10-0' + n + 'T10:00:00.000Z';
  const lots = [
    { id: 'l1', productId: 'p1', supplierId: 'S1', qty: 10, unitCost: 500, at: D(1) },
    { id: 'l2', productId: 'p1', supplierId: 'S1', qty: 4, unitCost: 600, at: D(3) },
    { id: 'l3', productId: 'p2', supplierId: 'S2', qty: 10, unitCost: 400, at: D(1) },
    { id: 'l0', productId: 'p3', supplierId: 'S1', qty: 5, unitCost: 0, at: D(1) }          // qiymətsiz partiya
  ];
  const sales = [
    { id: 's1', receiptNo: 1, at: D(2), totals: { subtotal: 2200, discount: 0, total: 2200 }, lines: [{ productId: 'p1', name: 'A', qty: 2, price: 800 }, { productId: 'p2', name: 'B', qty: 1, price: 600 }] },
    { id: 's2', receiptNo: 2, at: D(3), totals: { subtotal: 1600, discount: 160, total: 1440 }, lines: [{ productId: 'p1', name: 'A', qty: 2, price: 800 }] }
  ];
  const returns = [{ id: 'r1', saleId: 's1', receiptNo: 1, at: D(4), amount: 800, lines: [{ lineIndex: 0, productId: 'p1', name: 'A', qty: 1, price: 800 }] }];
  const stock = { p1: 10 + 4 - 4 + 1, p2: 9, p3: 5 };
  const res = Fifo.replay({ lots, sales, returns, stock, avgCost: {} });
  const S1 = { id: 'S1', openingDebt: 10000, debtBasis: 'received' }, S2 = { id: 'S2', openingDebt: 0, debtBasis: 'sold' };
  const pays = [
    { id: 'y1', supplierId: 'S1', amount: 3000, method: 'cash', at: D(2) },
    { id: 'y2', supplierId: 'S1', amount: 1000, method: 'bank', at: D(3), voidedAt: D(4) },     // 4-cü gündə ləğv
    { id: 'y3', supplierId: 'S2', amount: 100, method: 'bank', at: D(3) }
  ];
  const st = (sup, p, from, to) => Fifo.supplierStatement({ sup, lots, pays: p.filter(x => x.supplierId === sup.id), res, sales, returns, from: from || '', to: to || '' });

  await t('alınan mal əsası: borc = açılış + partiyalar − ödənişlər (ləğv edilən çıxılır); qiymətsiz partiya sayılır', () => {
    const a = st(S1, pays);
    assert.strictEqual(a.accrued, 10 * 500 + 4 * 600 + 0);         // 5000 + 2400
    assert.strictEqual(a.closing, 10000 + 7400 - 3000);            // y2 ləğv edilib
    assert.strictEqual(a.opening, 10000);
    assert.strictEqual(a.unpricedLots, 1);
    assert.strictEqual(Fifo.debtAt(S1, lots, pays.filter(p => p.supplierId === 'S1'), res, sales, returns, ''), a.closing);
  });

  await t('satılan mal əsası: yalnız satılanın FIFO maya dəyəri (qaytarma çıxılır)', () => {
    const b = st(S2, pays);
    assert.strictEqual(b.accrued, 1 * 400);        // B: 1 ədəd × 4,00
    assert.strictEqual(b.closing, 400 - 100);
    const c = st(Object.assign({}, S1, { debtBasis: 'sold' }), pays);
    // p1: FIFO l1-dən (5,00): s1-də 2, s2-də 2, qaytarma 1 → xalis 3 × 500
    assert.strictEqual(c.accrued, 3 * 500);
  });

  await t('dövr kəsiyi: opening + accrued − paid + reversed = closing (hər sərhəddə), ləğv dövr içində "reversed" olur', () => {
    for (const [f, tt] of [['', ''], [D(2), D(4)], [D(3), D(5)], [D(4), ''], ['', D(3)], [D(1), D(2)]]) {
      for (const sup of [S1, S2, Object.assign({}, S1, { debtBasis: 'sold' })]) {
        const x = st(sup, pays, f, tt);
        assert.strictEqual(x.opening + x.accrued - x.paidTotal + x.reversedTotal, x.closing, `${sup.id}/${sup.debtBasis} [${f}..${tt})`);
      }
    }
    const x = st(S1, pays, D(4), D(5));      // y2 4-cü gündə ləğv: əvvəl ödənmişdi → "reversed"
    assert.strictEqual(x.reversedTotal, 1000); assert.strictEqual(x.paidTotal, 0);
    const y = st(S1, pays, D(3), D(5));      // y2 həm yazılıb, həm ləğv edilib → heç yerdə görünmür
    assert.ok(!y.payments.some(p => p.id === 'y2'));
  });

  await t('çek siyahısı: yalnız bu təchizatçının hissəsi; qaytarma mənfi; cəmlər supplierReport ilə uyğundur (yuvarlaqlaşma ≤ sətir sayı)', () => {
    const x = st(S1, pays);
    const rep = Fifo.supplierReport(res, sales, returns, '', '')['S1'];
    assert.strictEqual(x.receipts.filter(r => r.kind === 'ret').length, 1);
    assert.ok(x.receipts.find(r => r.kind === 'ret').qty < 0);
    assert.strictEqual(x.sales.qty, rep.qty);
    assert.ok(Math.abs(x.sales.revenue - rep.revenue) <= x.receipts.reduce((n, r) => n + r.lines.length, 0), `${x.sales.revenue} vs ${rep.revenue}`);
    assert.strictEqual(x.sales.cost, rep.cost);
    const s1r = x.receipts.find(r => r.id === 's1'); assert.deepStrictEqual(s1r.lines.map(l => l.productId), ['p1']);      // B (S2-nin malı) bu çekdə görünmür
    assert.strictEqual(Fifo.supplierReceipts(res, sales, returns, 'S2', '', '').find(r => r.id === 's1').lines[0].productId, 'p2');
  });

  /* ============ 2. Uçdan-uca ============ */
  const be = makeBackend({ token: TOKEN });
  const A = await boot(be), B = await boot(be);
  await loginAs(A, 'Admin', '1234');
  let s1, s2, prodA, prodB, saleX;

  await t('hazırlıq: təchizatçılar (açılış borcu, əsas), məhsullar, mal qəbulu, növbə, 2 çek', async () => {
    s1 = await A.Services.createSupplier({ name: 'Alfa MMC', phone: '+994501112233', openingDebt: 100000, debtBasis: 'received' });
    s2 = await A.Services.createSupplier({ name: 'Beta Toys', debtBasis: 'sold' });
    assert.strictEqual(s1.openingDebt, 100000); assert.strictEqual(s2.debtBasis, 'sold');
    prodA = (await A.Services.createProduct({ name: 'Maşın', price: 800, cost: 500 })).product;
    prodB = (await A.Services.createProduct({ name: 'Kukla', price: 600, cost: 400 })).product;
    await A.Services.receiveStock(prodA.id, 10, 500, '', s1.id);      // borc +50,00
    await A.Services.receiveStock(prodB.id, 10, 400, '', s2.id);
    await A.Services.openShift(500000);
    saleX = await A.Services.checkout([{ productId: prodA.id, qty: 3 }, { productId: prodB.id, qty: 2 }], null, { method: 'cash', cashReceived: 5000 });
    await A.Services.checkout([{ productId: prodA.id, qty: 1 }], null, { method: 'bank', bankType: 'pos' });
    const bal = (await A.Services.supplierBalances()).balances;
    assert.strictEqual(bal[s1.id].debt, 100000 + 5000);                   // açılış + 10×5,00
    assert.strictEqual(bal[s2.id].debt, 2 * 400);                          // yalnız satılan 2 × 4,00
  });

  await t('nağd ödəniş: kassadan məxaric kimi yazılır → gözlənilən nağd azalır, Z-də "təchizatçılara"; hadisələr: cash.out + supplier.paid', async () => {
    const before = (await A.Services.shiftReport(await A.Services.currentShift())).expectedCash;
    const r = await A.Services.paySupplier(s1.id, 20000, 'cash', 'oktyabr 9');
    assert.strictEqual(r.move.type, 'out'); assert.strictEqual(r.move.supplierPayId, r.pay.id); assert.strictEqual(r.pay.cashMoveId, r.move.id);
    const rep = await A.Services.shiftReport(await A.Services.currentShift());
    assert.strictEqual(rep.expectedCash, before - 20000);
    assert.strictEqual(rep.cashOut, 20000); assert.strictEqual(rep.supplierPaid, 20000);
    const types = (await A.DB.getAll('outbox')).map(e => e.type);
    assert.ok(types.includes('supplier.paid') && types.includes('cash.out'));
    assert.strictEqual((await A.Services.supplierBalances()).balances[s1.id].debt, 105000 - 20000);
  });

  await t('bank ödənişi kassaya toxunmur; ödənişlər siyahısı (yenidən köhnəyə)', async () => {
    const before = (await A.Services.shiftReport(await A.Services.currentShift())).expectedCash;
    const r = await A.Services.paySupplier(s1.id, 5000, 'bank', '');
    assert.strictEqual(r.move, null); assert.strictEqual(r.pay.cashMoveId, undefined);
    assert.strictEqual((await A.Services.shiftReport(await A.Services.currentShift())).expectedCash, before);
    const list = await A.Services.listSupplierPays(s1.id);
    assert.deepStrictEqual(list.map(p => p.method), ['bank', 'cash']);
  });

  await t('yoxlamalar: məbləğ/üsul/qeyd; borcdan çox → "overpay" (təsdiqlə keçir); təchizatçı yoxdur', async () => {
    await rejects(A.Services.paySupplier(s1.id, 0, 'cash'), /Məbləğ səhvdir/);
    await rejects(A.Services.paySupplier(s1.id, 10.5, 'cash'), /Məbləğ səhvdir/);
    await rejects(A.Services.paySupplier(s1.id, 100, 'çek'), /üsulunu/);
    await rejects(A.Services.paySupplier(s1.id, 2e9, 'bank'), /çox böyük/);
    await rejects(A.Services.paySupplier(s1.id, 100, 'bank', 'x'.repeat(201)), /200/);
    await rejects(A.Services.paySupplier('yox', 100, 'bank'), /tapılmadı/);
    const cashNow = (await A.Services.shiftReport(await A.Services.currentShift())).expectedCash;
    const nc = await rejects(A.Services.paySupplier(s1.id, cashNow + 1, 'cash', '', { confirmOver: true }), /Kassada kifayət qədər nağd yoxdur/); assert.strictEqual(nc.code, 'no_cash');    // kassada olmayan pul çıxmır
    await A.Services.paySupplier(s1.id, 1, 'bank', 'bank kassadakı limitdən asılı deyil');
    const e = await rejects(A.Services.paySupplier(s2.id, 100000, 'bank'), /borcdan/); assert.strictEqual(e.code, 'overpay');
    const r = await A.Services.paySupplier(s2.id, 100000, 'bank', 'avans', { confirmOver: true });
    assert.ok((await A.Services.supplierBalances()).balances[s2.id].debt < 0);
    await A.Services.voidSupplierPay(r.pay.id, 'səhv yazılıb');
    assert.strictEqual((await A.Services.supplierBalances()).balances[s2.id].debt, 800);
  });

  await t('ləğv: nağd ödəniş kassaya geri mədaxil olur; təkrar ləğv və qeydsiz ləğv rədd olunur', async () => {
    const rep0 = await A.Services.shiftReport(await A.Services.currentShift());
    const r = await A.Services.paySupplier(s1.id, 1000, 'cash', '');
    await rejects(A.Services.voidSupplierPay(r.pay.id, ''), /Səbəbi yazın/);
    await A.Services.voidSupplierPay(r.pay.id, 'səhv məbləğ');
    const rep1 = await A.Services.shiftReport(await A.Services.currentShift());
    assert.strictEqual(rep1.expectedCash, rep0.expectedCash, 'ləğvdən sonra kassa əvvəlki kimidir');
    assert.strictEqual(rep1.supplierPaid, rep0.supplierPaid, 'təchizatçılara xalis ödəniş dəyişmir');
    await rejects(A.Services.voidSupplierPay(r.pay.id, 'yenə'), /artıq ləğv/);
    await rejects(A.Services.voidSupplierPay('yox', 'səbəb'), /tapılmadı/);
  });

  await t('növbə açıq deyilsə nağd ödəniş rədd olunur (kod no_shift), bank işləyir', async () => {
    const C = await boot(be); await sync(A, C); await loginAs(C, 'Admin', '1234');
    const sh = await C.Services.currentShift(); assert.ok(sh);       // A-nın növbəsi C-yə çatıb
    const cnt = await C.Services.shiftReport(sh);
    await C.Services.closeShift(cnt.expectedCash, '');
    const e = await rejects(C.Services.paySupplier(s1.id, 100, 'cash'), /növbə açıq olmalıdır/); assert.strictEqual(e.code, 'no_shift');
    await C.Services.paySupplier(s1.id, 100, 'bank', 'növbəsiz');
    await sync(C, A);
    await A.Services.openShift(cnt.expectedCash);          // sonrakı testlər üçün yeni növbə (əvvəlki növbənin sayılmış nağdı ilə)
  });

  await t('icazələr: Kassir ödəniş/borc görə bilmir; Menecer borcu görür, ödəyə bilmir və açılış borcu qoya bilmir; Admin icazə verəndən sonra ödəyə bilir', async () => {
    await sync(A, B);
    await loginAs(B, 'Kassir', '1111');
    await rejects(B.Services.supplierBalances(), /icazəniz yoxdur/); await rejects(B.Services.paySupplier(s1.id, 100, 'bank'), /icazəniz yoxdur/);
    await rejects(B.Services.supplierStatement(s1.id, {}), /icazəniz yoxdur/); await rejects(B.Services.voidSupplierPay('x', 'sebeb'), /icazəniz yoxdur/);
    await loginAs(B, 'Menecer', '2222');
    const bal = await B.Services.supplierBalances(); assert.strictEqual(bal.canPay, false); assert.ok(bal.balances[s1.id]);
    await rejects(B.Services.paySupplier(s1.id, 100, 'bank'), /icazəniz yoxdur/);
    await rejects(B.Services.createSupplier({ name: 'Gamma', openingDebt: 500 }), /icazəniz yoxdur/);
    await rejects(B.Services.updateSupplier(s1.id, { debtBasis: 'sold' }), /icazəniz yoxdur/);
    await B.Services.updateSupplier(s1.id, { phone: '+994509998877' });           // adi redaktə işləyir
    assert.strictEqual((await B.Services.listSuppliers({ all: true })).find(x => x.id === s1.id).debtBasis, 'received', 'borc əsası toxunulmaz qalır');
    await loginAs(A, 'Admin', '1234');
    const m = J(await A.Services.getMatrix()); m.menecer.push('supplier.pay'); await A.Services.setMatrix(m); await sync(A, B);
    await loginAs(B, 'Menecer', '2222');
    const r = await B.Services.paySupplier(s1.id, 100, 'bank', 'menecer');
    assert.strictEqual(r.pay.userName, 'Menecer');
  });

  await t('sinxron: B cihazı eyni borcu, ödənişləri və kassa hərəkətlərini görür; gözlənilən nağd A ilə eynidir; Sheets vərəqləri', async () => {
    await sync(A, B);
    const a = (await A.Services.supplierBalances()).balances, b = (await B.Services.supplierBalances()).balances;
    assert.deepStrictEqual(J(b), J(a));
    const sa = await A.Services.currentShift(), sb = await B.Services.currentShift();
    assert.strictEqual(sa.id, sb.id);
    assert.strictEqual((await A.Services.shiftReport(sa)).expectedCash, (await B.Services.shiftReport(sb)).expectedCash);
    const rows = be.rows('SupplierPayments');
    assert.ok(rows.length >= 5, 'SupplierPayments: ' + rows.length);
    const cash = rows.find(r => r[5] === 'cash' && r[4] === 200);
    assert.ok(cash && cash[6] && cash[7], 'nağd ödənişdə növbə və kassa hərəkəti id-si yazılıb: ' + JSON.stringify(cash));
    assert.ok(rows.some(r => r[10]), 'ləğv edilənin voidedAt sütunu dolu');
    assert.ok(be.rows('CashMoves').some(r => r[2] === 'out' && r[4].indexOf('Tədarükçüyə ödəniş') === 0), 'kassa hərəkəti CashMoves-da');
    const su = be.rows('Suppliers').find(r => r[1] === 'Alfa MMC'); assert.strictEqual(su[6], 'received'); assert.strictEqual(su[7], 1000);
    assert.ok(!be.rows('Audit').some(r => r[1] === 'supplier.paid'), 'ödənişlər öz vərəqindədir, Audit-də təkrarlanmır');
    assert.ok(be.rows('Events').some(r => r[2] === 'supplier.paid'));
  });

  await t('iki cihaz eyni ödənişi eyni anda ləğv edir → kassaya yalnız BİR mədaxil, ödəniş bir dəfə ləğv olunur', async () => {
    await loginAs(A, 'Admin', '1234'); await loginAs(B, 'Menecer', '2222');
    const r = await A.Services.paySupplier(s1.id, 700, 'cash', 'ikiqat');
    await sync(A, B);
    const exp0 = (await A.Services.shiftReport(await A.Services.currentShift())).expectedCash;
    await Promise.all([A.Services.voidSupplierPay(r.pay.id, 'A ləğv'), B.Services.voidSupplierPay(r.pay.id, 'B ləğv')]);
    await sync(A, B); await sync(A, B);
    const sa = await A.Services.currentShift();
    assert.strictEqual((await A.DB.getAll('cashMoves')).filter(m => m.id === 'cm_void_' + r.pay.id).length, 1);
    assert.strictEqual((await A.Services.shiftReport(sa)).expectedCash, exp0 + 700);
    assert.strictEqual((await B.Services.shiftReport(await B.Services.currentShift())).expectedCash, exp0 + 700);
    const pa = (await A.DB.get('supplierPays', r.pay.id)), pb = (await B.DB.get('supplierPays', r.pay.id));
    assert.strictEqual(pa.voidReason, pb.voidReason, 'iki cihazda eyni qalib ləğv');
  });

  await t('saxta hadisələr: mənfi/sıfır məbləğ, naməlum üsul, nağd ödənişdə kassa id-si olmayan, nəhəng sətir → rədd; mövcud olmayan ödənişin ləğvi → atılır; sinxron donmur', async () => {
    const dev = await boot(be);
    const at = new Date(Date.now() + 1000).toISOString();
    const mk = (type, data) => ({ id: at + '_000000_x_' + nodeCrypto.randomUUID(), at, type, userId: '', device: 'forger', data });
    const base = { id: 'fk_1', supplierId: s1.id, supplierName: 'Alfa MMC', amount: 100, method: 'bank', at, userName: 'X', note: '', updatedAt: at };
    const bad = [
      mk('supplier.paid', { pay: Object.assign({}, base, { id: 'fk_a', amount: -500 }) }),
      mk('supplier.paid', { pay: Object.assign({}, base, { id: 'fk_b', amount: 0 }) }),
      mk('supplier.paid', { pay: Object.assign({}, base, { id: 'fk_c', method: 'kripto' }) }),
      mk('supplier.paid', { pay: Object.assign({}, base, { id: 'fk_d', amount: 1.5 }) }),
      mk('supplier.paid', { pay: Object.assign({}, base, { id: 'fk_e', note: 'x'.repeat(600) }) }),
      mk('supplier.paid', { pay: Object.assign({}, base, { id: 'fk_f', amount: 1e12 }) }),
      mk('supplier.paid', {}),
      mk('supplier.pay_voided', { id: 'yox', at, reason: 'x'.repeat(900) }),
      mk('supplier.upserted', { supplier: { id: 'sup_fk', name: 'Saxta', active: true, updatedAt: at, debtBasis: 'kripto' } }),
      mk('supplier.upserted', { supplier: { id: 'sup_fk2', name: 'Saxta2', active: true, updatedAt: at, openingDebt: 1.5 } })
    ];
    const good = [mk('supplier.pay_voided', { id: 'mövcud-deyil', at, reason: 'yoxdur' })];
    assert.ok(be.post({ action: 'sync', token: TOKEN, device: 'forger', items: bad.concat(good) }).ok);
    await sync(dev);
    const pays = await dev.DB.getAll('supplierPays');
    assert.ok(!pays.some(p => /^fk_/.test(p.id)), 'saxta ödənişlər qəbul olunmayıb');
    const sup = await dev.DB.getAll('suppliers'); assert.ok(!sup.some(x => /^sup_fk/.test(x.id)));
    assert.ok((await dev.DB.get('meta', 'conflicts')).value.filter(c => c.kind === 'rejected').length >= 9);
    await loginAs(A, 'Admin', '1234'); await A.Services.paySupplier(s1.id, 100, 'bank', 'sinxron yaşayır'); await sync(A, dev);
    assert.ok((await dev.DB.getAll('supplierPays')).some(p => p.note === 'sinxron yaşayır'));
  });

  await t('Replica.backfill: köhnə cihazın ötürdüyü supplier.paid/pay_voided yenidən oxunur və təkrar tətbiqdə dəyişmir', async () => {
    const dev = await boot(be);
    const evs = be.rows('Events').filter(r => r[2] === 'supplier.paid' || r[2] === 'supplier.pay_voided').map(r => ({ id: r[0], at: r[1], type: r[2], userId: r[3], data: JSON.parse(r[5]) }));
    assert.ok(evs.length >= 6);
    await dev.DB.clear ? dev.DB.clear('supplierPays') : null;
    const s0 = await dev.Replica.backfill(evs); const n0 = (await dev.DB.getAll('supplierPays')).length;
    const s1_ = await dev.Replica.backfill(evs); const n1 = (await dev.DB.getAll('supplierPays')).length;
    assert.strictEqual(n0, n1); assert.ok(s0.applied === s1_.applied && s0.applied >= 6);
    const voided = (await dev.DB.getAll('supplierPays')).filter(p => p.voidedAt).length;
    assert.ok(voided >= 3, 'ləğvlər tətbiq olunub: ' + voided);
  });

  await t('hesabat sənədi: çek siyahısı, hesablaşma, borc; 4 dildə HTML və mətn; XSS-ə qarşı ad ekranlanır; borc sənəddəki "QALIQ" ilə eynidir', async () => {
    const P = await boot(be, true); await sync(P); await loginAs(P, 'Admin', '1234');
    const evil = await A.Services.createSupplier({ name: '<img src=x onerror=alert(1)> MMC' });
    await sync(A, P);
    const bal = (await P.Services.supplierBalances()).balances;
    const stm = await P.Services.supplierStatement(s1.id, {});
    assert.strictEqual(stm.closing, bal[s1.id].debt);
    assert.strictEqual(stm.opening + stm.accrued - stm.paidTotal + stm.reversedTotal, stm.closing);
    assert.strictEqual(stm.supplier.name, 'Alfa MMC');
    assert.ok(stm.receipts.length >= 2, 'ən azı 2 çek'); assert.ok(stm.receipts.every(r => r.lines.every(l => l.productId === prodA.id)), 'yalnız Alfa-nın malı');
    const M = P.Money;
    for (const lang of ['az', 'ru', 'en', 'tr']) {
      const html = P.Print.statementHtml(stm, lang), text = P.Print.statementText(stm, lang);
      assert.ok(html.indexOf(M.format(stm.closing)) !== -1 && text.indexOf(M.format(stm.closing)) !== -1, lang + ': qalıq borc sənəddədir');
      assert.ok(html.indexOf('Alfa MMC') !== -1 && html.indexOf('Maşın') !== -1);
      assert.ok(!/\{\d+\}/.test(html) && !/\{\d+\}/.test(text), lang + ': yer tutucu qalıb');
    }
    const ru = P.Print.statementHtml(stm, 'ru'); assert.ok(/ОТЧЁТ ПО ПОСТАВЩИКУ/.test(ru) && /ОСТАТОК ДОЛГА/.test(ru));
    const stmE = await P.Services.supplierStatement(evil.id, {});
    const htmlE = P.Print.statementHtml(stmE, 'az'); assert.ok(htmlE.indexOf('<img') === -1 && htmlE.indexOf('&lt;img') !== -1, 'ad ekranlanıb');
    // satılan mal əsası: "Alış dəyəri" sütunu çıxır, alınan mal siyahısı yoxdur
    const stm2 = await P.Services.supplierStatement(s2.id, {}); const h2 = P.Print.statementHtml(stm2, 'az');
    assert.ok(h2.indexOf('Alış dəyəri') !== -1 && h2.indexOf('4. Alınan mal') === -1);
    assert.ok(h2.indexOf('4. Alınan mal') === -1 && P.Print.statementHtml(stm, 'az').indexOf('4. Alınan mal') !== -1);
  });

  await t('dövr filtri: bugünkü sənəd bugünkü çekləri göstərir, dünənki boşdur; "bütün vaxt" hamısını', async () => {
    const day = new Date().toISOString().slice(0, 10), next = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const today = await A.Services.supplierStatement(s1.id, { from: day + 'T00:00:00.000Z', to: next + 'T00:00:00.000Z', fromDay: day, toDay: day });
    assert.ok(today.receipts.length >= 2);
    const past = await A.Services.supplierStatement(s1.id, { from: '2020-01-01T00:00:00.000Z', to: '2020-01-02T00:00:00.000Z' });
    assert.strictEqual(past.receipts.length, 0); assert.strictEqual(past.accrued, 0);
    assert.strictEqual(past.closing, past.opening, 'ötən dövrdə hərəkət yoxdur');
    assert.strictEqual(past.closing, 100000, 'o vaxta qədər yalnız açılış borcu');
  });

  console.log(passed + ' keçdi, ' + failed + ' uğursuz');
  process.exit(failed ? 1 : 0);
})();
