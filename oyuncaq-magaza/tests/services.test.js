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

  await t('nümunə istifadəçilərin id-ləri sabitdir (bütün brauzerlərdə eyni)', async () => {
    const ids = (await S.listUsers()).map(u => u.id).sort();
    assert.deepStrictEqual(ids, ['u_admin', 'u_kassir', 'u_menecer', 'u_muhasib1', 'u_muhasib2']);
  });

  await t('PIN dəyişmə qaydaları: köhnə ilə eyni, sadə, qısa PIN rədd olunur', async () => {
    await loginAs('kassir');
    await rejects(S.changePin('1111', '1111'), /köhnə PIN ilə eyni/);
    await rejects(S.changePin('1111', '2222'), /sadə/);   // təkrarlanan rəqəmlər
    await rejects(S.changePin('1111', '123'), /4–8 rəqəm/);
    await rejects(S.changePin('1111', '4321'), /sadə/);
    await rejects(S.changePin('1111', '9876'), /sadə/);
    await rejects(S.changePin('0000', '4827'), /Köhnə PIN səhvdir/);
  });

  await t('PIN dəyişəndə mustChangePin silinir, "user.upserted" hadisəsi outbox-a düşür', async () => {
    const before = (await DB.getAll('outbox')).length;
    await S.changePin('1111', '4827');
    const outbox = await DB.getAll('outbox');
    assert.strictEqual(outbox.length, before + 1);
    const ev = outbox.find(o => o.type === 'user.upserted' && o.data.reason === 'pin_changed');
    assert.ok(ev && ev.data.user.pinHash && ev.data.user.salt && !ev.data.user.pin, 'hash və duz var, düz PIN yoxdur');
    assert.strictEqual(ev.data.user.mustChangePin, false);
    assert.strictEqual((await loginAs('kassir').catch(e => e)).message, 'PIN səhvdir');
    const u = await S.login((await userByRole('kassir')).id, '4827');
    assert.strictEqual(u.mustChangePin, false);
  });

  await t('PIN sıfırlama: yalnız admin; müvəqqəti PIN işləyir, köhnə PIN yox, yenidən dəyişmək tələb olunur', async () => {
    await S.login((await userByRole('menecer')).id, '2222');
    await rejects(S.resetPin((await userByRole('kassir')).id), /icazəniz yoxdur/);
    await loginAs('admin');
    const temp = await S.resetPin((await userByRole('kassir')).id);
    assert.ok(/^\d{6}$/.test(temp));
    await rejects(S.login((await userByRole('kassir')).id, '4827'), /PIN səhvdir/);
    const u = await S.login((await userByRole('kassir')).id, temp);
    assert.strictEqual(u.mustChangePin, true);
  });

  await t('nömrə aralığı: aralıqdan götürür, bitəndə aydın xəta verir (toqquşma əvəzinə)', async () => {
    await loginAs('menecer');
    await DB.put('meta', { key: 'block:productSeq', value: { ranges: [[500, 501]] } });
    const a = (await S.createProduct({ name: 'B1', price: 100 })).product, b = (await S.createProduct({ name: 'B2', price: 100 })).product;
    assert.strictEqual(a.storeBarcode, Barcode.storeBarcode(500)); assert.strictEqual(b.storeBarcode, Barcode.storeBarcode(501));
    const e = await rejects(S.createProduct({ name: 'B3', price: 100 }), /Nömrə ehtiyatı bitib/);
    assert.strictEqual(e.code, 'seq_exhausted');
    assert.strictEqual((await S.listProducts()).filter(p => p.name === 'B3').length, 0, 'uğursuz yaratma heç nə yazmır');
    await DB.put('meta', { key: 'block:productSeq', value: { ranges: [[900, 899], [700, 700]] } });   // boş aralıq atlanır
    assert.strictEqual((await S.createProduct({ name: 'B4', price: 100 })).product.storeBarcode, Barcode.storeBarcode(700));
  });

  await t('iki açıq növbə (iki kassada eyni anda açılıb): ən əvvəl açılan cari sayılır', async () => {
    await loginAs('menecer');
    await DB.put('shifts', { id: 'sh_late', status: 'open', openedAt: '2030-01-01T10:00:05.000Z', openedBy: 'x', openedByName: 'x', openingCash: 0 });
    await DB.put('shifts', { id: 'sh_early', status: 'open', openedAt: '2030-01-01T10:00:01.000Z', openedBy: 'x', openedByName: 'x', openingCash: 0 });
    assert.strictEqual((await S.currentShift()).id, 'sh_early');
    await rejects(S.openShift(0), /Artıq açıq növbə/);
    for (const id of ['sh_late', 'sh_early']) { const sh = await DB.get('shifts', id); sh.status = 'closed'; await DB.put('shifts', sh); }
    assert.strictEqual(await S.currentShift(), null);
  });

  await t('təsdiq sorğusu (lokal): yaradılır, öz sorğusunu təsdiqləmək olmur, vaxtı keçəndə düşür', async () => {
    await loginAs('menecer');
    // menecerin PIN-i hələ dəyişdirilməyib, amma təsdiq üçün bunun əhəmiyyəti yoxdur
    const rq = await S.requestApproval('line_delete', 'pos.line.delete', 'sınaq');
    assert.strictEqual((await S.listPendingApprovals()).length, 1);
    await rejects(S.decideApproval(rq.id, 'approved'), /Öz sorğunuzu/);
    const rec = await DB.get('approvals', rq.id);
    rec.at = new Date(Date.now() - 11 * 60000).toISOString(); await DB.put('approvals', rec);
    assert.strictEqual((await S.listPendingApprovals()).length, 0);
    assert.strictEqual((await S.checkApproval(rq.id)).state, 'expired');
    await rejects(S.decideApproval(rq.id, 'approved'), /Öz sorğunuzu|vaxtı bitib/);
  });

  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
