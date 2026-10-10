/* node tests/discount.test.js — məhsul şəkli, məhsul/çek endirimi (faiz və məbləğ, hədlər), qaytarma, çek axtarışı, "yenidən çap".
   1) Rules saf funksiyaları; 2) Services (bir cihaz); 3) iki cihaz + Code.gs təqlidi + saxta hadisələr + çek mətni. */
require('fake-indexeddb/auto');
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

globalThis.Money = require('../js/money.js');
globalThis.Barcode = require('../js/barcode.js');
globalThis.Rules = require('../js/rules.js');
globalThis.Fifo = require('../js/fifo.js');
globalThis.DB = require('../js/db.js');
const S = require('../js/services.js');

const JS = path.join(__dirname, '..', 'js');
const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'secret-token';
const J = x => JSON.parse(JSON.stringify(x));
let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); } }
async function rejects(p, re) {
  try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('Gözlənilməyən xəta: ' + e.message + ' (gözlənilən ' + re + ')'); return e; }
  throw new Error('Xəta gözlənilirdi');
}
const OK_IMG = 'data:image/jpeg;base64,' + 'QUJD'.repeat(60);        // kiçik, düzgün formatlı
const PINS = { admin: '1234', menecer: '2222', kassir: '1111' };
async function loginAs(role) { const u = (await S.listUsers()).find(x => x.role === role && x.name !== 'Mühasib 2'); return S.login(u.id, PINS[role]); }
const R = globalThis.Rules, M = globalThis.Money;

(async () => {
  /* ============ 1. Rules ============ */
  await t('discountValue: faiz, məbləğ, həddən artıq məbləğ kəsilir, boş/0, köhnə forma', () => {
    assert.strictEqual(R.discountValue(1000, { type: 'percent', percent: 5 }), 50);
    assert.strictEqual(R.discountValue(1000, { type: 'amount', amount: 300 }), 300);
    assert.strictEqual(R.discountValue(1000, { type: 'amount', amount: 5000 }), 1000);
    assert.strictEqual(R.discountValue(1000, null), 0);
    assert.strictEqual(R.discountValue(0, { type: 'percent', percent: 5 }), 0);
    assert.strictEqual(R.discountValue(1000, { percent: 5 }), 50);                       // köhnə {percent}
  });

  await t('cartTotals: sətir endirimi + çek endirimi (faiz/məbləğ), köhnə rəqəm arqumenti', () => {
    const lines = [{ price: 1000, qty: 2, discount: 200 }, { price: 500, qty: 1 }];
    const a = R.cartTotals(lines, { type: 'percent', percent: 5 });
    assert.deepStrictEqual(J(a), { subtotal: 2500, lineDiscount: 200, discount: 115, total: 2185, itemCount: 3 });
    assert.strictEqual(R.cartTotals(lines, { type: 'amount', amount: 300 }).total, 2000);
    assert.strictEqual(R.cartTotals(lines, 5).total, 2185);
    assert.strictEqual(R.cartTotals(lines).total, 2300);
    assert.strictEqual(R.cartTotals([{ price: 100, qty: 1, discount: 9999 }]).total, 0, 'sətir endirimi sətrin cəmindən çox ola bilməz');
  });

  await t('validateLineDiscount: max 0 → verilmir; faiz və məbləğ həddi', () => {
    const V = R.validateLineDiscount;
    assert.match(V(10000, { type: 'percent', percent: 5 }, 0), /endirim verilmir/);
    assert.strictEqual(V(10000, { type: 'percent', percent: 10 }, 10), null);
    assert.match(V(10000, { type: 'percent', percent: 10.5 }, 10), /ən çox 10%/);
    assert.strictEqual(V(10000, { type: 'amount', amount: 1000 }, 10), null);
    assert.match(V(10000, { type: 'amount', amount: 1001 }, 10), /ən çox 10,00 ₼/);
    [{ type: 'amount', amount: 0 }, { type: 'amount', amount: 1.5 }, { type: 'percent', percent: -1 }, { type: 'percent', percent: NaN }, { type: 'percent', percent: '5' }, null].forEach(d => assert.ok(V(10000, d, 10), JSON.stringify(d)));
  });

  await t('validateReceiptDiscount: həm faiz, həm məbləğ həddi; 0 = bağlı; məbləğ yekundan az', () => {
    const V = R.validateReceiptDiscount, caps = { percent: 5, amount: 10000 };
    assert.strictEqual(V(100000, { type: 'percent', percent: 5 }, caps), null);
    assert.match(V(100000, { type: 'percent', percent: 6 }, caps), /ən çox 5%/);
    assert.match(V(300000, { type: 'percent', percent: 5 }, caps), /ən çox 100,00 ₼/, '5% = 150 ₼ > 100 ₼ həddi');
    assert.strictEqual(V(100000, { type: 'amount', amount: 5000 }, caps), null);
    assert.match(V(100000, { type: 'amount', amount: 5001 }, caps), /5% \(50,00 ₼\)/, 'məbləğ faiz həddini keçir');
    assert.match(V(1000000, { type: 'amount', amount: 10001 }, caps), /ən çox 100,00 ₼/);
    assert.match(V(3000, { type: 'amount', amount: 3000 }, { percent: 100, amount: 99999 }), /az olmalıdır/);
    assert.match(V(100000, { type: 'percent', percent: 1 }, { percent: 0, amount: 10000 }), /bağlıdır/);
    assert.match(V(100000, { type: 'percent', percent: 1 }, { percent: 5, amount: 0 }), /bağlıdır/);
    assert.deepStrictEqual(J(R.discountCaps(null)), { percent: 5, amount: 10000 });
    assert.deepStrictEqual(J(R.discountCaps({ discountMaxPercent: 10, discountMaxAmount: 25000 })), { percent: 10, amount: 25000 });
    assert.deepStrictEqual(J(R.discountCaps({ discountMaxPercent: 'x', discountMaxAmount: -4 })), { percent: 5, amount: 10000 });
  });

  await t('şəkil: yalnız kiçik jpeg/png/webp data URL; script/svg/uzun/cırıq format rədd; maxDiscount sərhədləri', () => {
    [null, undefined, '', OK_IMG].forEach(x => assert.strictEqual(R.imageProblem(x), null));
    ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,AAAA', 'data:image/jpeg;base64,AA" onerror="x', 'http://evil/x.jpg', 123, {}, 'data:image/jpeg;base64,' + 'A'.repeat(13000)]
      .forEach(x => assert.ok(R.imageProblem(x), String(x).slice(0, 40)));
    assert.strictEqual(R.safeImage(OK_IMG), OK_IMG); assert.strictEqual(R.safeImage('javascript:1'), ''); assert.strictEqual(R.safeImage(undefined), '');
    [0, 10, 12.5, 100, null, undefined, ''].forEach(x => assert.strictEqual(R.maxDiscountProblem(x), null, String(x)));
    [100.5, -1, 'a', NaN, 0.333, Infinity].forEach(x => assert.ok(R.maxDiscountProblem(x), String(x)));
  });

  await t('paidPerLine/refundFor: cəm həmişə yekuna bərabər; hissə-hissə qaytarmada qəpik itmir', () => {
    const sale = { lines: [{ price: 333, qty: 3 }, { price: 101, qty: 7, discount: 57 }, { price: 999, qty: 1 }], totals: { discount: 133 } };
    const nets = [999, 650, 999], paid = R.paidPerLine(sale);
    assert.strictEqual(paid.reduce((a, b) => a + b, 0), 2648 - 133);
    paid.forEach((p, i) => assert.ok(p >= 0 && p <= nets[i]));
    assert.strictEqual(R.refundFor(sale, [{ lineIndex: 0, qty: 3 }, { lineIndex: 1, qty: 7 }, { lineIndex: 2, qty: 1 }], {}).amount, 2515);
    for (const li of [0, 1]) {
      let got = 0, prev = {}; const q = sale.lines[li].qty;
      for (let k = 0; k < q; k++) { const r = R.refundFor(sale, [{ lineIndex: li, qty: 1 }], prev).amount; assert.ok(r >= 0); got += r; prev[li] = (prev[li] || 0) + 1; }
      assert.strictEqual(got, paid[li], 'sətir ' + li);
    }
    assert.strictEqual(R.refundFor({ lines: [{ price: 600, qty: 1 }], totals: { discount: 0 } }, [{ lineIndex: 0, qty: 1 }], {}).amount, 600);
  });

  await t('shiftSummary: "endirim" sətir və çek endirimlərinin cəmidir (satış − endirim = yekunlar)', () => {
    const sales = [{ totals: { subtotal: 1000, lineDiscount: 100, discount: 50, total: 850 }, payment: { cashPart: 850, bankPart: 0 } }, { totals: { subtotal: 500, discount: 0, total: 500 }, payment: { cashPart: 0, bankPart: 500, bankType: 'pos' } }];
    const s = R.shiftSummary(sales, []);
    assert.strictEqual(s.gross, 1500); assert.strictEqual(s.discount, 150); assert.strictEqual(s.gross - s.discount, 850 + 500);
  });

  /* ============ 2. Services (bir cihaz) ============ */
  await S.init();
  let car, doll, villa, manager, sale1, sale2, sale3;

  await t('məhsul: şəkil və max endirim saxlanır; kobud şəkil, səhv max və çox uzun ad rədd olunur', async () => {
    await loginAs('menecer');
    car = (await S.createProduct({ name: 'Maşın', price: 1000, cost: 600, image: OK_IMG, maxDiscount: 10 })).product;
    doll = (await S.createProduct({ name: 'Kukla', price: 500, cost: 300 })).product;
    villa = (await S.createProduct({ name: 'Villa', price: 5000000, cost: 100 })).product;
    assert.strictEqual(car.image, OK_IMG); assert.strictEqual(car.maxDiscount, 10);
    assert.strictEqual(doll.image, ''); assert.strictEqual(doll.maxDiscount, 0);
    await rejects(S.createProduct({ name: 'X', price: 100, image: 'javascript:alert(1)' }), /Şəkil formatı səhvdir/);
    await rejects(S.createProduct({ name: 'X', price: 100, image: 'data:image/jpeg;base64,' + 'A'.repeat(13000) }), /Şəkil çox böyükdür/);
    await rejects(S.createProduct({ name: 'X', price: 100, maxDiscount: 150 }), /0 ilə 100/);
    await rejects(S.createProduct({ name: 'A'.repeat(201), price: 100 }), /200 simvol/);
    await S.receiveStock(car.id, 30, 600); await S.receiveStock(doll.id, 30, 300);
  });

  await t('updateProduct: şəkil/max dəyişir; "before"-da şəkil yoxdur (hadisə kiçik qalır); maxDiscount üçün qiymət təyin icazəsi lazımdır', async () => {
    await S.updateProduct(car.id, { image: '', maxDiscount: 12.5 });
    let p = await DB.get('products', car.id); assert.strictEqual(p.image, ''); assert.strictEqual(p.maxDiscount, 12.5);
    await S.updateProduct(car.id, { image: OK_IMG, maxDiscount: 10 });
    const ev = (await DB.getAll('outbox')).filter(e => e.type === 'product.updated').pop();
    assert.strictEqual(ev.data.after.image, OK_IMG); assert.notStrictEqual(ev.data.before.image, OK_IMG, 'köhnə şəkil hadisəyə yazılmır');
    assert.ok(JSON.stringify(ev.data).length < 20000, 'hadisə Sheets xanasına (50 000) sığır: ' + JSON.stringify(ev.data).length);
    await rejects(S.updateProduct(car.id, { image: 'x' }), /Şəkil formatı səhvdir/);
    // Menecerdən "qiymət təyin et" icazəsini götürürük: endirim həddini dəyişə bilməz, şəkli dəyişə bilər
    await loginAs('admin');
    const m0 = J(await S.getMatrix()), m1 = J(m0); m1.menecer = m1.menecer.filter(x => x !== 'product.price.set');
    await S.setMatrix(m1); await loginAs('menecer');
    await rejects(S.updateProduct(car.id, { maxDiscount: 50 }), /yalnız Menecer və Admin/);
    await S.updateProduct(car.id, { image: '' }); await S.updateProduct(car.id, { image: OK_IMG });
    await loginAs('admin'); await S.setMatrix(m0); await loginAs('menecer');
    p = await DB.get('products', car.id); assert.strictEqual(p.maxDiscount, 10);
  });

  await t('kassir: sətir endirimi (faiz) hədd daxilində keçir, sətirdə məbləğ və faiz yazılır', async () => {
    manager = await S.approveWithPin('2222', 'pos.discount.approve');
    await loginAs('kassir'); await S.openShift(100000);
    sale1 = await S.checkout([{ productId: car.id, qty: 2, discount: { type: 'percent', percent: 10, approvedBy: manager } }], null, { method: 'cash', cashReceived: 5000 });
    const l = sale1.lines[0];
    assert.strictEqual(l.discount, 200); assert.strictEqual(l.discountPercent, 10); assert.strictEqual(l.discountBy, manager.id);
    assert.deepStrictEqual(J(sale1.totals), { subtotal: 2000, lineDiscount: 200, discount: 0, total: 1800, itemCount: 2 });
    assert.strictEqual(sale1.discount, null);
    assert.strictEqual(sale1.payment.cashPart, 1800); assert.strictEqual(sale1.payment.change, 3200);
  });

  await t('sətir endirimi: hədd aşılanda, max 0 olanda, təsdiqsiz, səhv formada rədd olunur (ad ilə)', async () => {
    const pay = { method: 'cash', cashReceived: 90000 };
    await rejects(S.checkout([{ productId: car.id, qty: 1, discount: { type: 'percent', percent: 10.5, approvedBy: manager } }], null, pay), /"Maşın": Bu məhsula ən çox 10% endirim olar/);
    await rejects(S.checkout([{ productId: car.id, qty: 1, discount: { type: 'amount', amount: 101, approvedBy: manager } }], null, pay), /"Maşın".*ən çox 1,00 ₼/);
    await rejects(S.checkout([{ productId: doll.id, qty: 1, discount: { type: 'percent', percent: 1, approvedBy: manager } }], null, pay), /"Kukla": Bu məhsula endirim verilmir/);
    await rejects(S.checkout([{ productId: car.id, qty: 1, discount: { type: 'percent', percent: 5 } }], null, pay), /menecer tərəfindən təsdiqlənməyib/);
    await rejects(S.checkout([{ productId: car.id, qty: 1, discount: { type: 'amount', amount: -5, approvedBy: manager } }], null, pay), /0-dan böyük/);
    assert.strictEqual((await DB.getAll('sales')).length, 1, 'rədd olunan çeklər yazılmayıb');
    const a = await S.checkout([{ productId: car.id, qty: 3, discount: { type: 'amount', amount: 300, approvedBy: manager } }, { productId: doll.id, qty: 1 }], null, pay);       // 3000-in 10%-i = 300: sərhəddə keçir
    assert.strictEqual(a.lines[0].discount, 300); assert.strictEqual(a.lines[0].discountPercent, undefined, 'məbləğ növündə faiz yazılmır');
    assert.strictEqual(a.totals.total, 3000 - 300 + 500);
  });

  await t('çek endirimi: ilkin hədd 5% və 100 ₼; faiz və məbləğ; sətir endirimi ilə birgə', async () => {
    const pay = { method: 'cash', cashReceived: 90000000 };
    sale2 = await S.checkout([{ productId: car.id, qty: 2, discount: { type: 'percent', percent: 10, approvedBy: manager } }, { productId: doll.id, qty: 1 }], { type: 'percent', percent: 5, approvedBy: manager }, pay);
    assert.deepStrictEqual(J(sale2.totals), { subtotal: 2500, lineDiscount: 200, discount: 115, total: 2185, itemCount: 3 });
    assert.deepStrictEqual(J(sale2.discount), { type: 'percent', percent: 5, approvedBy: manager.id, approvedByName: manager.name });
    assert.strictEqual(sale2.totals.subtotal - sale2.totals.lineDiscount - sale2.totals.discount, sale2.totals.total);
    sale3 = await S.checkout([{ productId: doll.id, qty: 4 }], { type: 'amount', amount: 100, approvedBy: manager }, pay);       // 2000-in 5%-i = 100
    assert.deepStrictEqual(J(sale3.discount), { type: 'amount', amount: 100, approvedBy: manager.id, approvedByName: manager.name }); assert.strictEqual(sale3.totals.total, 1900);
    await rejects(S.checkout([{ productId: doll.id, qty: 4 }], { type: 'amount', amount: 101, approvedBy: manager }, pay), /5% \(1,00 ₼\)/);
    await rejects(S.checkout([{ productId: doll.id, qty: 4 }], { type: 'percent', percent: 6, approvedBy: manager }, pay), /ən çox 5%/);
    await rejects(S.checkout([{ productId: villa.id, qty: 1 }], { type: 'percent', percent: 5, approvedBy: manager }, pay), /ən çox 100,00 ₼/);       // 5% = 2500 ₼ > 100 ₼
    await rejects(S.checkout([{ productId: doll.id, qty: 1 }], { type: 'percent', percent: 5 }, pay), /menecer tərəfindən təsdiqlənməyib/);
    const legacy = await S.checkout([{ productId: doll.id, qty: 2 }], { percent: 5, approvedBy: manager }, pay);                       // köhnə forma {percent, approvedBy}
    assert.strictEqual(legacy.totals.discount, 50); assert.strictEqual(legacy.discount.type, 'percent');
  });

  await t('Admin hədləri: mağaza adı qalır; yalnız Admin dəyişir; səhv dəyər rədd; yeni hədd dərhal işləyir', async () => {
    const before = await S.storeInfo();
    await rejects(S.setStoreInfo({ discountMaxPercent: 10 }), /icazəniz yoxdur/);                         // kassir
    await loginAs('admin');
    await rejects(S.setStoreInfo({ discountMaxPercent: 101 }), /0 ilə 100/);
    await rejects(S.setStoreInfo({ discountMaxPercent: -1 }), /0 ilə 100/);
    await rejects(S.setStoreInfo({ discountMaxAmount: -5 }), /Endirim məbləği səhvdir/);
    await rejects(S.setStoreInfo({ discountMaxAmount: 1.5 }), /Endirim məbləği səhvdir/);
    await S.setStoreInfo({ discountMaxPercent: 10, discountMaxAmount: 500000 });
    const after = await S.storeInfo();
    assert.strictEqual(after.name, before.name); assert.strictEqual(after.voen, before.voen); assert.strictEqual(after.discountMaxPercent, 10); assert.strictEqual(after.discountMaxAmount, 500000);
    const n = (await DB.getAll('outbox')).filter(e => e.type === 'admin.store_changed').length;
    await S.setStoreInfo({ discountMaxPercent: 10 });                                                       // dəyişiklik yoxdur: hadisə yaranmır
    assert.strictEqual((await DB.getAll('outbox')).filter(e => e.type === 'admin.store_changed').length, n);
    await S.setStoreInfo({ name: 'Yeni ad' }); assert.strictEqual((await S.storeInfo()).discountMaxPercent, 10, 'ad formu hədləri silmir');
    await loginAs('kassir');
    const pay = { method: 'cash', cashReceived: 90000000 };
    const v = await S.checkout([{ productId: villa.id, qty: 1 }], { type: 'percent', percent: 8, approvedBy: manager }, pay);       // 8% = 4000 ₼ ≤ 5000 ₼ (yeni məbləğ həddi)
    assert.strictEqual(v.totals.discount, 400000);
    await rejects(S.checkout([{ productId: villa.id, qty: 1 }], { type: 'percent', percent: 11, approvedBy: manager }, pay), /ən çox 10%/);
    await loginAs('admin'); await S.setStoreInfo({ discountMaxPercent: 0 }); await loginAs('kassir');
    await rejects(S.checkout([{ productId: doll.id, qty: 1 }], { type: 'percent', percent: 1, approvedBy: manager }, pay), /bağlıdır/);
    await loginAs('admin'); await S.setStoreInfo({ discountMaxPercent: 5, discountMaxAmount: 10000 }); await loginAs('kassir');
  });

  await t('qaytarma: sətir endirimi nəzərə alınır, hissə-hissə qaytarma cəmi sətrin ödənişinə bərabərdir, "refund" sətirdə yazılır', async () => {
    const r1 = await S.createReturn(sale1.id, [{ lineIndex: 0, qty: 1 }], manager, 'a');
    assert.strictEqual(r1.amount, 900); assert.strictEqual(r1.lines[0].refund, 900);
    const r2 = await S.createReturn(sale1.id, [{ lineIndex: 0, qty: 1 }], manager, 'b');
    assert.strictEqual(r2.amount, 900);
    await rejects(S.createReturn(sale1.id, [{ lineIndex: 0, qty: 1 }], manager, 'c'), /ən çox 0 ədəd/);
  });

  await t('qaytarma: çek endirimi sətirlərə bölünür; cəm yekuna bərabər; təkrar sətir göndərmək artıq qaytarma açmır', async () => {
    const dup = await rejects(S.createReturn(sale2.id, [{ lineIndex: 0, qty: 2 }, { lineIndex: 0, qty: 2 }], manager, 'x'), /ən çox 2 ədəd/);
    await rejects(S.validateReturn(sale2.id, [{ lineIndex: 0, qty: 2 }, { lineIndex: 0, qty: 1 }]), /ən çox 2 ədəd/);
    const all = await S.createReturn(sale2.id, [{ lineIndex: 0, qty: 1 }, { lineIndex: 0, qty: 1 }, { lineIndex: 1, qty: 1 }], manager, 'hamısı');
    assert.strictEqual(all.lines.length, 2, 'təkrar sətir birləşdirilir');
    assert.strictEqual(all.amount, sale2.totals.total, 'hamısı qayıdanda müştərinin ödədiyi qədər');
    assert.strictEqual(all.lines.reduce((a, l) => a + l.refund, 0), all.amount);
    assert.strictEqual(all.lines.find(l => l.lineIndex === 1).refund, 475);              // 500 − 115·500/2300 (25)
  });

  await t('növbə hesabatı: endirim = sətir + çek endirimləri; satış − endirim = çeklərin yekunu', async () => {
    const rep = await S.shiftReport(await S.currentShift());
    const sales = await DB.getAll('sales');
    assert.strictEqual(rep.gross - rep.discount, sales.reduce((a, s) => a + s.totals.total, 0));
    assert.strictEqual(rep.discount, sales.reduce((a, s) => a + (s.totals.lineDiscount || 0) + (s.totals.discount || 0), 0));
  });

  await t('çek axtarışı: nömrə, kassir, məhsul, məbləğ, tarix, barkod; sözlər "VƏ" ilə; limit və say', async () => {
    const all = await S.searchSales('');
    const total = (await DB.getAll('sales')).length;
    assert.strictEqual(all.total, total); assert.strictEqual(all.list.length, total);
    assert.ok(all.list[0].at >= all.list[all.list.length - 1].at, 'ən yeni əvvəl');
    const nos = r => r.list.map(s => s.receiptNo);
    assert.ok(nos(await S.searchSales(String(sale1.receiptNo))).includes(sale1.receiptNo));
    assert.deepStrictEqual(nos(await S.searchSales(String(sale1.receiptNo).padStart(6, '0'))).filter(n => n === sale1.receiptNo), [sale1.receiptNo], 'sıfırlı nömrə');
    assert.ok((await S.searchSales('kassir')).total === total, 'kassir adı');
    const byProd = await S.searchSales('kukla'); assert.ok(byProd.list.every(s => s.lines.some(l => l.name === 'Kukla')) && byProd.total >= 3);
    assert.ok((await S.searchSales('MAŞIN')).list.some(s => s.id === sale1.id), 'böyük hərf');
    for (const q of ['18', '18,00', '18.00']) assert.ok((await S.searchSales(q)).list.some(s => s.id === sale1.id), 'məbləğ ' + q);
    const day = R.localDate(sale1.at), [y, mo, d] = day.split('-');
    for (const q of [day, `${d}.${mo}.${y}`, `${d}.${mo}`, `${mo}.${y}`]) assert.strictEqual((await S.searchSales(q)).total, total, 'tarix ' + q);
    assert.strictEqual((await S.searchSales('01.01.2000')).total, 0);
    assert.ok((await S.searchSales(sale1.receiptBarcode)).list.every(s => s.id === sale1.id) && (await S.searchSales(sale1.receiptBarcode)).total === 1, 'çek barkodu');
    assert.ok((await S.searchSales(car.storeBarcode)).list.every(s => s.lines.some(l => l.productId === car.id)), 'məhsul barkodu');
    const both = await S.searchSales('kassir maşın 18'); assert.ok(both.list.some(s => s.id === sale1.id) && both.list.every(s => s.lines.some(l => l.name === 'Maşın')));
    assert.strictEqual((await S.searchSales('kassir maşın zzzz')).total, 0);
    assert.strictEqual((await S.searchSales('   ')).total, total);
    const lim = await S.searchSales('', 2); assert.strictEqual(lim.list.length, 2); assert.strictEqual(lim.total, total);
  });

  /* ============ 3. İki cihaz, Code.gs təqlidi, saxta hadisələr, çek mətni ============ */
  function makeDevice(backend) {
    const store = {};
    const ctx = {
      console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController,
      crypto: nodeCrypto.webcrypto, indexedDB: new IDBFactory(), IDBKeyRange, navigator: { onLine: true }, fetch: backend.fetch(),
      sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
      localStorage: { getItem: () => null, setItem() {} }, document: { documentElement: {} }
    };
    ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
    ['i18n', 'lang-ru', 'lang-en', 'lang-tr', 'money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync', 'ui', 'print'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
    ctx.Sync.kick = () => {};
    return ctx;
  }
  const boot = async be => { const d = makeDevice(be); await d.Services.init(); const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error); return d; };
  const loginD = async (d, name, pin) => d.Services.login((await d.Services.listUsers()).find(x => x.name === name).id, pin);
  const sync = async (...ds) => { for (let i = 0; i < 3; i++) for (const d of ds) await d.Sync.cycle(); };
  const be = makeBackend({ token: TOKEN });
  const A = await boot(be), B = await boot(be);
  let pa, sa, ra;

  await t('A: şəkilli məhsul, Admin həddi, endirimli çek və qaytarma → B-də eyni; Sheets-də endirim sütunları', async () => {
    await loginD(A, 'Admin', '1234');
    pa = (await A.Services.createProduct({ name: 'Robot', price: 2000, cost: 1000, image: OK_IMG, maxDiscount: 15 })).product;
    await A.Services.receiveStock(pa.id, 10, 1000);
    await A.Services.setStoreInfo({ discountMaxPercent: 7, discountMaxAmount: 20000 });
    await A.Services.openShift(100000);
    const mgr = await A.Services.approveWithPin('2222', 'pos.discount.approve');
    sa = await A.Services.checkout([{ productId: pa.id, qty: 3, discount: { type: 'percent', percent: 15, approvedBy: mgr } }], { type: 'amount', amount: 100, approvedBy: mgr }, { method: 'cash', cashReceived: 10000 });
    assert.deepStrictEqual(J(sa.totals), { subtotal: 6000, lineDiscount: 900, discount: 100, total: 5000, itemCount: 3 });
    ra = await A.Services.createReturn(sa.id, [{ lineIndex: 0, qty: 1 }], mgr, 'test');
    assert.strictEqual(ra.amount, Math.round(5000 / 3));
    await sync(A, B);
    const pb = await B.DB.get('products', pa.id);
    assert.strictEqual(pb.image, OK_IMG); assert.strictEqual(pb.maxDiscount, 15);
    assert.strictEqual((await B.Services.storeInfo()).discountMaxPercent, 7);
    const sb = await B.DB.get('sales', sa.id);
    assert.deepStrictEqual(J(sb.totals), J(sa.totals)); assert.strictEqual(sb.lines[0].discount, 900); assert.strictEqual(sb.discount.type, 'amount');
    const rb = (await B.DB.getAll('returns'))[0]; assert.strictEqual(rb.lines[0].refund, ra.lines[0].refund);
    // Sheets (Code.gs təqlidi): Sales/SaleLines/Products yeni sütunlar
    const col = (sheet, name) => be.store.sheets[sheet].rows[0].indexOf(name);
    const srow = be.rows('Sales').find(r => r[0] === sa.id);
    assert.strictEqual(srow[col('Sales', 'lineDiscount')], 9); assert.strictEqual(srow[col('Sales', 'discount')], 1); assert.strictEqual(srow[col('Sales', 'discountType')], 'amount'); assert.strictEqual(srow[col('Sales', 'discountPercent')], '');
    const lrow = be.rows('SaleLines').find(r => r[0] === sa.id);
    assert.strictEqual(lrow[col('SaleLines', 'discount')], 9); assert.strictEqual(lrow[col('SaleLines', 'discountPercent')], 15);
    const prow = be.rows('Products').find(r => r[0] === pa.id);
    assert.strictEqual(prow[col('Products', 'maxDiscount')], 15);
    assert.ok(!JSON.stringify(be.rows('Products')).includes('base64'), 'şəkil Products vərəqinə yazılmır');
  });

  await t('saxta hadisələr: <img src>-yə script/svg qoymaq, nəhəng max, səhv endirim tipi, mənfi məbləğ → rədd, məhsul pozulmur', async () => {
    const at = new Date(Date.now() + 60000).toISOString(); let n = 0;
    const forge = (type, data) => ({ id: at + '_' + String(++n).padStart(6, '0') + '_a_evil' + n, at, type, userId: 'u_admin', device: 'evil_dev', data });
    const base = J(await B.DB.get('products', pa.id));
    const bads = [
      forge('product.updated', { id: pa.id, after: Object.assign({}, base, { image: 'javascript:alert(1)' }) }),
      forge('product.updated', { id: pa.id, after: Object.assign({}, base, { image: 'data:image/svg+xml;base64,PHN2Zz4=' }) }),
      forge('product.updated', { id: pa.id, after: Object.assign({}, base, { image: 'data:image/jpeg;base64,' + 'A'.repeat(20000) }) }),
      forge('product.updated', { id: pa.id, after: Object.assign({}, base, { maxDiscount: 5000 }) }),
      forge('product.updated', { id: pa.id, after: Object.assign({}, base, { maxDiscount: 'çox' }) }),
      forge('product.created', { product: Object.assign({}, base, { id: 'p_evil', storeBarcode: '2099999999992', image: '" onerror="alert(1)' }) }),
      forge('sale.created', { sale: Object.assign(J(sa), { id: 's_evil1', receiptNo: 990001, discount: { type: 'weird', amount: 5, approvedByName: 'x' } }) }),
      forge('sale.created', { sale: Object.assign(J(sa), { id: 's_evil2', receiptNo: 990002, lines: [Object.assign({}, sa.lines[0], { discount: 'abc' })] }) }),
      forge('sale.created', { sale: Object.assign(J(sa), { id: 's_evil3', receiptNo: 990003, totals: Object.assign({}, sa.totals, { lineDiscount: -5 }) }) }),
      forge('admin.store_changed', { store: { name: 'x', discountMaxPercent: { $gt: 1 } } })
    ];
    const r = be.post({ action: 'sync', token: TOKEN, device: 'evil_dev', since: 0, items: bads, limit: 1 });
    assert.strictEqual(r.ok, true, r.error);
    await sync(A, B);
    for (const d of [A, B]) {
      const p = await d.DB.get('products', pa.id);
      assert.strictEqual(p.image, OK_IMG); assert.strictEqual(p.maxDiscount, 15);
      assert.ok(!(await d.DB.get('products', 'p_evil')), 'saxta məhsul yazılmayıb');
      for (const id of ['s_evil1', 's_evil2', 's_evil3']) assert.ok(!(await d.DB.get('sales', id)), id + ' yazılmayıb');
      assert.strictEqual(typeof (await d.Services.storeInfo()).discountMaxPercent, 'number');
    }
    const conf = (await B.DB.get('meta', 'conflicts')).value.filter(c => c.kind === 'rejected');
    assert.ok(conf.length >= 9, 'rədd edilənlər qeyd olunub: ' + conf.length);
  });

  await t('çek mətni: şəkil və data URL yoxdur; sətir/çek endirimi çıxır; "YENİDƏN ÇAP" (dublikat sözü yoxdur); qaytarma çekində endirimli məbləğ', async () => {
    const store = await A.Services.storeInfo();
    const html = A.Print.receiptHtml(sa, store, { reprint: true });
    assert.ok(!/<img|data:image|base64/i.test(html), 'çekdə şəkil olmamalıdır (barkod SVG-dir, o şəkil deyil)');
    assert.ok(html.includes('YENİDƏN ÇAP'), 'yenidən çap qeydi'); assert.ok(!/DUBL/i.test(html));
    assert.ok(html.includes('Endirim 15%') && html.includes('−9,00'), 'sətir endirimi');
    assert.ok(html.includes('Sətir endirimləri') && html.includes('−1,00'), 'cəmlərdə sətir və çek endirimi');
    assert.ok(html.includes('50,00 AZN'));
    assert.ok(!A.Print.receiptHtml(sa, store).includes('YENİDƏN ÇAP'), 'adi çekdə qeyd yoxdur');
    const ret = A.Print.returnReceiptHtml(ra, sa, store); assert.ok(ret.includes(M.format(ra.lines[0].refund)) && !/<img|base64/.test(ret));
    // köhnə formatlı çek (type/lineDiscount yoxdur) də düzgün çap olunur
    const old = { id: 's_old', receiptNo: 5, receiptBarcode: sa.receiptBarcode, at: sa.at, cashierName: 'K', lines: [{ name: 'Köhnə', qty: 1, price: 1000 }], totals: { subtotal: 1000, discount: 50, total: 950 }, discount: { percent: 5 }, payment: { method: 'cash', cashPart: 950, bankPart: 0, cashReceived: 1000, change: 50 } };
    const oh = A.Print.receiptHtml(old, store); assert.ok(oh.includes('Endirim 5%') && !oh.includes('Sətir endirimləri'));
    // dillər: ru/en/tr qeyd mətnləri
    for (const [lang, word] of [['ru', 'ПОВТОРНАЯ ПЕЧАТЬ'], ['en', 'REPRINT'], ['tr', 'YENİDEN YAZDIRMA']]) assert.strictEqual(A.I18n.t('YENİDƏN ÇAP', null, lang), word);
  });

  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
