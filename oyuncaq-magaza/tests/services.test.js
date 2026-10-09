/* node tests/services.test.js — biznes axınlarını saxta IndexedDB üzərində yoxlayır */
require('fake-indexeddb/auto');
const assert = require('assert');
globalThis.Money = require('../js/money.js');
globalThis.Barcode = require('../js/barcode.js');
globalThis.Rules = require('../js/rules.js');
globalThis.DB = require('../js/db.js');
const S = require('../js/services.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); }
}
async function rejects(p, re) {
  try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('Gözlənilməyən xəta: ' + e.message); return e; }
  throw new Error('Xəta gözlənilirdi');
}
async function userByRole(role) { return (await S.listUsers()).find(u => u.role === role && u.name !== 'Mühasib 2'); }
async function loginAs(role) {
  const pins = { admin: '1234', menecer: '2222', kassir: '1111', muhasib: '3333' };
  return S.login((await userByRole(role)).id, pins[role]);
}

(async () => {
  await S.init();
  let bear, lego, magnet, manager;

  await t('kassir məhsul yarada bilmir', async () => {
    await loginAs('kassir');
    await rejects(S.createProduct({ name: 'X', price: 100 }), /icazəniz yoxdur/);
  });

  await t('menecer məhsul yaradır, mağaza barkodu verilir (AC-01)', async () => {
    await loginAs('menecer');
    lego = (await S.createProduct({ name: 'Konstruktor', price: 1450, cost: 900, mfrBarcode: '4006381333931' })).product;
    bear = (await S.createProduct({ name: 'Ayı', price: 600, cost: 350 })).product;
    magnet = (await S.createProduct({ name: 'Maqnit', price: 225, cost: 90 })).product;
    assert.ok(Barcode.isStoreBarcode(lego.storeBarcode));
    assert.notStrictEqual(lego.storeBarcode, bear.storeBarcode);
  });

  await t('təkrar istehsalçı barkodu xəbərdarlıq verir, bloklamır (AC-02)', async () => {
    const r = await S.createProduct({ name: 'Konstruktor qırmızı', price: 1450, mfrBarcode: '4006381333931' });
    assert.strictEqual(r.warnings.length, 1);
  });

  await t('mağaza barkodu istehsalçı barkodu kimi yazıla bilməz', async () => {
    await rejects(S.createProduct({ name: 'Y', price: 100, mfrBarcode: lego.storeBarcode }), /mağaza və ya çek barkodudur/);
  });

  await t('kassada istehsalçı barkodu məhsul əlavə etmir (AC-03)', async () => {
    const r = await S.lookupForPos('4006381333931');
    assert.strictEqual(r.kind, 'mfr');
    assert.strictEqual((await S.lookupForPos(lego.storeBarcode)).kind, 'product');
  });

  await t('mal qəbulu: qalıq və orta maya', async () => {
    await S.receiveStock(lego.id, 4, 900);
    const p = await S.receiveStock(lego.id, 6, 1000);
    assert.strictEqual(p.stock, 10); assert.strictEqual(p.avgCost, 960);
    await S.receiveStock(magnet.id, 40, 90);
  });

  await t('növbə olmadan satış olmur', async () => {
    await loginAs('kassir');
    await rejects(S.checkout([{ productId: magnet.id, qty: 1 }], null, { method: 'cash', cashReceived: 1000 }), /növbəni açın/);
  });

  let sale1;
  await t('25,00 nağd, 100 verildi → 75 qaytarılır; qalıq azalır', async () => {
    await S.openShift(5000);
    sale1 = await S.checkout(
      [{ productId: lego.id, qty: 1 }, { productId: bear.id, qty: 1 }, { productId: magnet.id, qty: 2 }],
      null, { method: 'cash', cashReceived: 10000 });
    assert.strictEqual(sale1.totals.total, 2500);
    assert.strictEqual(sale1.payment.change, 7500);
    assert.strictEqual(sale1.receiptNo, 1);
    assert.ok(Barcode.isReceiptBarcode(sale1.receiptBarcode));
    const p = (await S.listProducts()).find(x => x.id === magnet.id);
    assert.strictEqual(p.stock, 38);
  });

  await t('ayı qalığı 0 idi: 1-ci mənfi çek sayıldı', async () => {
    const p = (await S.listProducts()).find(x => x.id === bear.id);
    assert.strictEqual(p.stock, -1); assert.strictEqual(p.negSalesSinceReceipt, 1);
    assert.ok(sale1.lines[1].negative);
  });

  await t('2-ci mənfi çek keçir, 3-cü bloklanır (AC-10)', async () => {
    await S.checkout([{ productId: bear.id, qty: 3 }], null, { method: 'bank', bankType: 'pos' });
    await rejects(S.checkout([{ productId: bear.id, qty: 1 }], null, { method: 'bank', bankType: 'pos' }), /mənfi çekdə/);
  });

  await t('bloklanmış satış heç nəyi dəyişmir (atomiklik)', async () => {
    const p = (await S.listProducts()).find(x => x.id === bear.id);
    assert.strictEqual(p.stock, -4); assert.strictEqual(p.negSalesSinceReceipt, 2);
    const sales = await S.recentSales();
    assert.strictEqual(sales.length, 2);
  });

  await t('mal qəbulu mənfi sayğacı sıfırlayır', async () => {
    await loginAs('menecer');
    const p = await S.receiveStock(bear.id, 10, 350);
    assert.strictEqual(p.stock, 6); assert.strictEqual(p.negSalesSinceReceipt, 0);
  });

  await t('endirim: kassir PIN-i ilə təsdiq olmur, menecer PIN-i ilə olur', async () => {
    await loginAs('kassir');
    await rejects(S.approveWithPin('1111', 'pos.discount.approve'), /PIN yanlışdır/);
    manager = await S.approveWithPin('2222', 'pos.discount.approve');
    assert.strictEqual(manager.role, 'menecer');
  });

  await t('5% endirim: 25,00 → 23,75; 7% rədd', async () => {
    const s = await S.checkout([{ productId: lego.id, qty: 1 }, { productId: bear.id, qty: 1 }, { productId: magnet.id, qty: 2 }],
      { percent: 5, approvedBy: manager }, { method: 'mixed', bankType: 'transfer', bankAmount: 1500, cashReceived: 1000 });
    assert.strictEqual(s.totals.total, 2375); assert.strictEqual(s.payment.cashPart, 875); assert.strictEqual(s.payment.change, 125);
    await rejects(S.checkout([{ productId: magnet.id, qty: 1 }], { percent: 7, approvedBy: manager }, { method: 'cash', cashReceived: 1000 }), /5%/);
  });

  await t('nağd az olanda satış olmur (AC-06)', async () => {
    await rejects(S.checkout([{ productId: lego.id, qty: 1 }], null, { method: 'cash', cashReceived: 1000 }), /azdır/);
  });

  await t('qaytarma: çek barkodu ilə tapılır, say limiti, qalıq artır', async () => {
    const found = await S.findSaleByCode(sale1.receiptBarcode);
    assert.strictEqual(found.id, sale1.id);
    await rejects(S.createReturn(sale1.id, [{ lineIndex: 2, qty: 1 }], null), /menecer təsdiqi/);
    const before = (await S.listProducts()).find(x => x.id === magnet.id).stock;
    const r = await S.createReturn(sale1.id, [{ lineIndex: 2, qty: 1 }], manager);
    assert.strictEqual(r.amount, 225); assert.strictEqual(r.cashAmount, 225);
    const after = (await S.listProducts()).find(x => x.id === magnet.id).stock;
    assert.strictEqual(after, before + 1);
    await rejects(S.createReturn(sale1.id, [{ lineIndex: 2, qty: 2 }], manager), /ən çox 1/);
  });

  await t('müddəti keçmiş çek qaytarılmır (AC-11)', async () => {
    const old = await S.findSaleByCode(sale1.receiptBarcode);
    old.at = new Date(Date.now() - 16 * 86400000).toISOString();
    await DB.put('sales', old);
    await rejects(S.createReturn(sale1.id, [{ lineIndex: 0, qty: 1 }], manager), /müddəti bitib/);
  });

  await t('növbə bağlanışı: fərq varsa izah tələb olunur', async () => {
    const shift = await S.currentShift();
    const rep = await S.shiftReport(shift);
    // 5000 açılış + 2500 + 875 nağd − 225 qaytarma
    assert.strictEqual(rep.expectedCash, 5000 + 2500 + 875 - 225);
    await rejects(S.closeShift(rep.expectedCash - 100), /İzah yazın/);
    const closed = await S.closeShift(rep.expectedCash - 100, 'Xırda pul');
    assert.strictEqual(closed.diff, -100);
  });

  await t('mühasib qiyməti dəyişə bilmir (AC-15)', async () => {
    await loginAs('muhasib');
    await rejects(S.updateProduct(lego.id, { price: 1 }), /icazəniz yoxdur/);
  });

  await t('admin icazə matrisini dəyişir, kassir qaytarma icazəsini itirir (AC-17)', async () => {
    await loginAs('admin');
    const m = JSON.parse(JSON.stringify(await S.getMatrix()));
    m.kassir = m.kassir.filter(p => p !== 'pos.return.request');
    await S.setMatrix(m);
    await loginAs('kassir');
    await rejects(S.requirePerm('pos.return.request'), /icazəniz yoxdur/);
  });

  await t('5 səhv PIN cəhdindən sonra blok (SEC-06)', async () => {
    const u = await userByRole('muhasib');
    for (let i = 0; i < 5; i++) await rejects(S.login(u.id, '0000'), /PIN səhvdir/);
    await rejects(S.login(u.id, '3333'), /gözləyin/);
  });

  await t('hər əməliyyat outbox-a yazılıb (sinxron üçün)', async () => {
    assert.ok((await S.outboxCount()) > 10);
  });

  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
