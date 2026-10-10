/* node tests/services.test.js — biznes axınlarını saxta IndexedDB üzərində yoxlayır */
require('fake-indexeddb/auto');
const assert = require('assert');
globalThis.Money = require('../js/money.js');
globalThis.Barcode = require('../js/barcode.js');
globalThis.Rules = require('../js/rules.js');
globalThis.Fifo = require('../js/fifo.js');
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

  await t('mal qəbulu ayrıca icazədir: kassir və mühasib qəbul edə bilmir, qalıq dəyişmir', async () => {
    const before = (await S.listProducts()).find(p => p.id === lego.id).stock;
    for (const role of ['kassir', 'muhasib']) {
      await loginAs(role);
      await rejects(S.receiveStock(lego.id, 5, 900), /icazəniz yoxdur/);
    }
    await loginAs('menecer');
    assert.strictEqual((await S.listProducts()).find(p => p.id === lego.id).stock, before);
    assert.ok(Rules.can(await S.getMatrix(), 'menecer', 'stock.receive'));
    assert.ok(Rules.can(await S.getMatrix(), 'admin', 'stock.receive'));
    assert.ok(!Rules.can(await S.getMatrix(), 'kassir', 'stock.receive'));
  });

  await t('alış qiyməti verilməyəndə (qiyməti görməyən rol) son qiymət götürülür, orta maya pozulmur', async () => {
    const x = (await S.createProduct({ name: 'Sınaq qəbul', price: 500, cost: 120 })).product;
    await S.receiveStock(x.id, 5, 120);
    const p = await S.receiveStock(x.id, 5, null);
    assert.strictEqual(p.stock, 10); assert.strictEqual(p.avgCost, 120); assert.strictEqual(p.lastCost, 120);
    await rejects(S.receiveStock(x.id, 1, -5), /Alış qiyməti səhvdir/);
  });

  await t('mağaza məlumatı dəyişməyibsə hadisə yaranmır (təzə cihaz ilkin mətnləri bütün cihazlara yazmasın)', async () => {
    await loginAs('admin');
    const cur = await S.storeInfo();
    const before = await S.outboxCount();
    await S.setStoreInfo(Object.assign({}, cur));
    assert.strictEqual(await S.outboxCount(), before);
    await S.setStoreInfo(Object.assign({}, cur, { name: '7BOXES' }));
    assert.strictEqual(await S.outboxCount(), before + 1);
    assert.strictEqual((await S.storeInfo()).name, '7BOXES');
    await loginAs('menecer');
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

  await t('növbə: bağlama fərqi izahsız dərhal rədd olunur, qalıqla açılış', async () => {
    await loginAs('menecer');
    const s1 = await S.openShift(5000, 'ilkin');
    const t0 = Date.now();
    await rejects(S.closeShift(4000, ''), /Kassa fərqi var.*İzah yazın/);
    assert.ok(Date.now() - t0 < 500, 'server qoşulmayıbsa dərhal xəta');
    const closed = await S.closeShift(4000, 'Yoxdur: 10 ₼ çatmır');
    assert.strictEqual(closed.countedCash, 4000);
    assert.strictEqual((await S.lastClosedShift()).id, s1.id);
    await rejects(S.openShift(5000, ''), /Əvvəlki növbədən qalıq 40,00 ₼ idi.*izah/);    // 50,00 ≠ 40,00 → izah məcburi
    const s2 = await S.openShift(4000, '');                                              // eyni qalıq: izahsız olar
    assert.strictEqual(s2.prevCash, 4000); assert.strictEqual(s2.openingDiff, 0);
    await S.closeShift(4000, '');
    const s3 = await S.openShift(4500, 'kassada 5 ₼ artıq tapıldı');
    assert.strictEqual(s3.openingDiff, 500); assert.strictEqual(s3.openingNote, 'kassada 5 ₼ artıq tapıldı');
    await S.closeShift(4500, '');
  });

  await t('istehsalçı barkodunda uzunluq/format limiti yoxdur; öz barkodlarımız və boşluq rədd olunur', async () => {
    await loginAs('menecer');
    await DB.put('meta', { key: 'block:productSeq', value: { ranges: [[3000, 3100]] } });
    for (const code of ['12345', 'ABC-123_xyz', '1234567890123456789012345678901234567890', '4006381333931']) {
      const r = await S.createProduct({ name: 'M ' + code.slice(0, 8), price: 100, mfrBarcode: code });
      assert.strictEqual(r.product.mfrBarcode, code);
    }
    await rejects(S.createProduct({ name: 'X', price: 100, mfrBarcode: 'a b' }), /boşluq/);
    const own = (await S.listProducts())[0].storeBarcode;
    await rejects(S.createProduct({ name: 'Y', price: 100, mfrBarcode: own }), /mağaza və ya çek barkodudur/);
    const p = (await S.listProducts()).find(x => x.mfrBarcode === 'ABC-123_xyz');
    const found = await S.lookupForPos('ABC-123_xyz');
    assert.strictEqual(found.kind, 'mfr'); assert.strictEqual(found.products[0].id, p.id);
  });

  await t('qaytarma sayı menecer təsdiqindən ƏVVƏL yoxlanılır (satılandan çox olmaz)', async () => {
    await loginAs('menecer');
    await S.openShift(0, 'x');
    const p = (await S.listProducts()).find(x => x.name === 'Maqnit');
    const sale = await S.checkout([{ productId: p.id, qty: 2 }], null, { method: 'bank', bankType: 'pos' });
    await rejects(S.validateReturn(sale.id, [{ lineIndex: 0, qty: 3 }]), /satılıb 2.*ən çox 2/);
    await rejects(S.validateReturn(sale.id, [{ lineIndex: 0, qty: 0 }]), /Qaytarılacaq say/);
    await rejects(S.validateReturn(sale.id, [{ lineIndex: 0, qty: 1.5 }]), /tam müsbət/);
    assert.strictEqual(await S.validateReturn(sale.id, [{ lineIndex: 0, qty: 2 }]), true);
    const mgr = await userByRole('menecer');
    await S.createReturn(sale.id, [{ lineIndex: 0, qty: 1 }], { id: mgr.id, name: mgr.name });
    await rejects(S.validateReturn(sale.id, [{ lineIndex: 0, qty: 2 }]), /əvvəl qaytarılıb 1.*ən çox 1/);
    assert.strictEqual(await S.validateReturn(sale.id, [{ lineIndex: 0, qty: 1 }]), true);
  });

  await t('sessiya yeniləmədən sonra qalır; PIN dəyişəndə, çıxışda və 12 saatdan sonra silinir', async () => {
    const mem = {}; globalThis.sessionStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
    S._session.user = null;
    const mgr = await userByRole('menecer');
    const u0 = await DB.get('users', mgr.id); u0.mustChangePin = false; await DB.put('users', u0);   // ilk giriş PIN-i dəyişilməyibsə sessiya saxlanmır
    await S.login(mgr.id, '2222');
    assert.ok(mem['mag.session'], 'giriş sessiyanı yazır');
    S._session.user = null;                                  // səhifə yeniləndi: yaddaşdakı sessiya itdi
    const u = await S.restoreSession();
    assert.ok(u && u.id === mgr.id && S.currentUser().id === mgr.id, 'sessiya bərpa olundu');
    // PIN başqa cihazda dəyişdi → köhnə sessiya etibarsızdır
    const rec = await DB.get('users', mgr.id); const keep = rec.pinHash; rec.pinHash = 'f'.repeat(64); await DB.put('users', rec);
    S._session.user = null;
    assert.strictEqual(await S.restoreSession(), null); assert.strictEqual(mem['mag.session'], undefined, 'etibarsız sessiya silinir');
    rec.pinHash = keep; await DB.put('users', rec);
    await S.login(mgr.id, '2222'); S.logout();
    assert.strictEqual(mem['mag.session'], undefined, 'çıxış sessiyanı silir');
    await S.login(mgr.id, '2222');
    const old = JSON.parse(mem['mag.session']); old.at = Date.now() - 13 * 3600000; mem['mag.session'] = JSON.stringify(old);
    S._session.user = null;
    assert.strictEqual(await S.restoreSession(), null, '12 saatdan köhnə sessiya qəbul olunmur');
    delete globalThis.sessionStorage;
  });

  /* ---------- İstifadəçilərin idarəsi ---------- */
  let elvin, elvinPin;
  await t('istifadəçi yaratmaq yalnız Admin-ə məxsusdur', async () => {
    S._session.user = { id: 'u_kassir', name: 'Kassir', role: 'kassir' };     // Kassirin PIN-i əvvəlki testlərdə dəyişib
    await rejects(S.createUser({ name: 'Yeni Ad', role: 'kassir' }), /icazəniz yoxdur/);
    await loginAs('menecer');
    await rejects(S.createUser({ name: 'Yeni Ad', role: 'kassir' }), /icazəniz yoxdur/);
  });

  await t('Admin "Elvin Babayev" (Kassir) yaradır: müvəqqəti PIN, ilk girişdə dəyişməlidir, ad girişdə görünür', async () => {
    await loginAs('admin');
    const r = await S.createUser({ name: '  Elvin   Babayev ', role: 'kassir' });
    elvin = r.user; elvinPin = r.tempPin;
    assert.strictEqual(elvin.name, 'Elvin Babayev');                 // artıq boşluqlar təmizlənir
    assert.ok(/^\d{6}$/.test(elvinPin));
    assert.ok((await S.listUsers()).some(u => u.id === elvin.id && u.name === 'Elvin Babayev' && u.role === 'kassir'));
    const u = await S.login(elvin.id, elvinPin);
    assert.strictEqual(u.mustChangePin, true); assert.strictEqual(u.name, 'Elvin Babayev');
    S.logout();
  });

  await t('ad yoxlaması: təkrar (böyük/kiçik hərf fərqsiz), çox qısa, çox uzun, səhv rol', async () => {
    await loginAs('admin');
    await rejects(S.createUser({ name: 'elvin babayev', role: 'kassir' }), /artıq var/);
    await rejects(S.createUser({ name: 'ELVİN BABAYEV', role: 'kassir' }), /artıq var/);   // az hərfləri: İ → i
    await rejects(S.createUser({ name: 'A', role: 'kassir' }), /ən azı 2/);
    await rejects(S.createUser({ name: 'x'.repeat(41), role: 'kassir' }), /40 simvol/);
    await rejects(S.createUser({ name: 'Yeni Şəxs', role: 'direktor' }), /Rol seçin/);
    await rejects(S.createUser({ name: '   ', role: 'kassir' }), /ən azı 2/);
  });

  await t('yaradılan istifadəçi eyni PIN ilə yeni PIN seçir; sistem hadisəsi "created" kimi yazılır', async () => {
    await S.login(elvin.id, elvinPin);
    await S.changePin(elvinPin, '4817');
    const ob = (await DB.getAll('outbox')).filter(o => o.type === 'user.upserted' && o.data.user.id === elvin.id);
    assert.ok(ob.some(o => o.data.reason === 'created'));
    S.logout();
  });

  await t('Admin adı və rolu dəyişir; eyni adı başqasına verə bilməz; heç nə dəyişməyibsə hadisə yaranmır', async () => {
    await loginAs('admin');
    const before = (await DB.getAll('outbox')).length;
    const same = await S.updateUser(elvin.id, { name: 'Elvin Babayev', role: 'kassir' });
    assert.ok(same.unchanged); assert.strictEqual((await DB.getAll('outbox')).length, before);
    await rejects(S.updateUser(elvin.id, { name: 'Menecer' }), /artıq var/);
    await S.updateUser(elvin.id, { name: 'Elvin B.' });
    assert.ok((await S.listUsers()).some(u => u.name === 'Elvin B.'));
    await S.updateUser(elvin.id, { name: 'Elvin Babayev' });
  });

  await t('rol/ad başqa cihazda dəyişəndə açıq sessiya köhnə səlahiyyətlə işləmir', async () => {
    await S.login(elvin.id, '4817');
    await rejects(S.receiveStock(lego.id, 1, 900), /icazəniz yoxdur/);              // Kassir mal qəbul edə bilmir
    const rec = await DB.get('users', elvin.id);                                    // başqa cihazdan gələn dəyişiklik (replika)
    rec.role = 'menecer'; rec.name = 'Elvin Babayev (müdir)'; rec.updatedAt = new Date().toISOString(); await DB.put('users', rec);
    assert.strictEqual(await S.refreshSession(), 'changed');
    assert.strictEqual(S.currentUser().role, 'menecer'); assert.strictEqual(S.currentUser().name, 'Elvin Babayev (müdir)');
    await S.receiveStock(lego.id, 1, 900);                                          // indi icazə var
    rec.role = 'kassir'; rec.name = 'Elvin Babayev'; await DB.put('users', rec);
    await rejects(S.receiveStock(lego.id, 1, 900), /icazəniz yoxdur/);              // yenilənməni gözləmədən də rol bazadan oxunur
    assert.strictEqual(S.currentUser().role, 'kassir');
  });

  await t('söndürülən istifadəçi: girə bilmir, siyahıda yoxdur, açıq sessiyası dərhal bitir; aktiv edilir', async () => {
    await S.login(elvin.id, '4817');
    S._session.user.id === elvin.id;
    const admin = await DB.get('users', 'u_admin');
    // eyni cihazda Admin söndürür (sessiya dəyişməsi üçün qısa keçid)
    const keep = S.currentUser(); S.logout(); await loginAs('admin');
    await S.updateUser(elvin.id, { active: false });
    assert.ok(!(await S.listUsers()).some(u => u.id === elvin.id));
    await rejects(S.login(elvin.id, '4817'), /tapılmadı/);
    S.logout(); S._session.user = { id: keep.id, name: keep.name, role: keep.role };     // Elvin-in köhnə açıq sessiyası
    assert.strictEqual(await S.refreshSession(), 'gone');
    await rejects(S.requirePerm('pos.sell'), /söndürülüb/);
    S.logout(); await loginAs('admin');
    await S.updateUser(elvin.id, { active: true });
    assert.ok((await S.listUsers()).some(u => u.id === elvin.id));
    assert.ok(admin);
  });

  await t('PIN Admin tərəfindən sıfırlananda açıq sessiya bitir', async () => {
    await S.login(elvin.id, '4817');
    const me = S.currentUser();
    const rec = await DB.get('users', elvin.id); rec.mustChangePin = true; await DB.put('users', rec);   // başqa cihazda sıfırlandı
    assert.strictEqual(await S.refreshSession(), 'gone');
    rec.mustChangePin = false; await DB.put('users', rec); assert.ok(me);
    S.logout();
  });

  await t('son aktiv Admin qorunur; öz hesabını söndürmək olmaz; ikinci Admin ilə rol dəyişmək olur', async () => {
    await loginAs('admin');
    await rejects(S.updateUser('u_admin', { active: false }), /Öz hesabınızı/);
    await rejects(S.updateUser('u_admin', { role: 'menecer' }), /ən azı bir aktiv Admin/);
    const r2 = await S.createUser({ name: 'İkinci Admin', role: 'admin' });
    S.logout(); await S.login(r2.user.id, r2.tempPin);
    await S.updateUser('u_admin', { role: 'menecer' });                              // artıq başqa Admin var
    await rejects(S.updateUser(r2.user.id, { role: 'kassir' }), /ən azı bir aktiv Admin/);
    await rejects(S.updateUser(r2.user.id, { active: false }), /Öz hesabınızı/);
    await S.updateUser('u_admin', { role: 'admin' });
    await S.updateUser('u_admin', { active: false });                                // 2 Admin var idi, biri söndürüldü
    await rejects(S.updateUser(r2.user.id, { role: 'kassir' }), /ən azı bir aktiv Admin/);
    await S.updateUser('u_admin', { active: true });
    S.logout();
  });

  /* ---------- Təchizatçılar və FIFO ---------- */
  let alfa, beta, fp;
  const repRow = (rep, name) => rep.rows.find(r => r.name === name);
  await t('təchizatçı: Menecer yaradır; Kassir yarada bilmir; Mühasib baxır amma dəyişmir; ad təkrarlana bilmir', async () => {
    S._session.user = { id: 'u_kassir', name: 'Kassir', role: 'kassir' };
    await rejects(S.createSupplier({ name: 'Alfa MMC' }), /icazəniz yoxdur/);
    assert.deepStrictEqual(await S.listSuppliers(), []);     // Kassir mal gəldi sorğusunda təchizatçı seçir: adlara baxa bilir, yaradıb dəyişə bilmir
    await loginAs('menecer');
    alfa = await S.createSupplier({ name: ' Alfa  MMC ', phone: '+994 50 111 22 33', note: 'VÖEN 123' });
    beta = await S.createSupplier({ name: 'Beta Toys' });
    assert.strictEqual(alfa.name, 'Alfa MMC');
    await rejects(S.createSupplier({ name: 'alfa mmc' }), /artıq var/);
    await rejects(S.createSupplier({ name: 'A' }), /ən azı 2/);
    S.logout(); S._session.user = { id: 'u_muhasib1', name: 'Mühasib 1', role: 'muhasib' };     // əvvəlki testdə bloklanıb: sessiyanı birbaşa quraq
    assert.strictEqual((await S.listSuppliers()).length, 2);
    await rejects(S.createSupplier({ name: 'Gamma' }), /icazəniz yoxdur/);
    await rejects(S.updateSupplier(alfa.id, { name: 'X Y' }), /icazəniz yoxdur/);
  });

  await t('təchizatçını dəyişmək/söndürmək; söndürülmüş təchizatçıdan qəbul olmur, siyahıda görünmür', async () => {
    await loginAs('menecer');
    const g = await S.createSupplier({ name: 'Gamma Ltd' });
    await rejects(S.updateSupplier(g.id, { name: 'Beta Toys' }), /artıq var/);
    assert.ok((await S.updateSupplier(g.id, { name: 'Gamma Ltd' })).unchanged);
    await S.updateSupplier(g.id, { active: false });
    assert.ok(!(await S.listSuppliers()).some(x => x.id === g.id));
    assert.ok((await S.listSuppliers({ all: true })).some(x => x.id === g.id));
    fp = (await S.createProduct({ name: 'FIFO məhsulu', price: 1000, cost: 100 })).product;
    await rejects(S.receiveStock(fp.id, 1, 100, '', g.id), /söndürülüb/);
    await rejects(S.receiveStock(fp.id, 1, 100, '', 'sup_yoxdur'), /tapılmadı/);
    assert.strictEqual((await S.listProducts()).find(x => x.id === fp.id).stock, 0);     // rədd olunan qəbul qalığa toxunmur
  });

  await t('FIFO: 2 təchizatçıdan qəbul, satış ən köhnədən çıxır, hesabat təchizatçılara bölür', async () => {
    await S.receiveStock(fp.id, 5, 100, 'qaimə 1', alfa.id);
    await S.receiveStock(fp.id, 5, 120, 'qaimə 2', beta.id);
    if (!(await S.currentShift())) await S.openShift(1000);
    await S.checkout([{ productId: fp.id, qty: 7 }], null, { method: 'cash', cashReceived: 7000 });
    const rep = await S.supplierReport({});
    const a = repRow(rep, 'Alfa MMC'), b = repRow(rep, 'Beta Toys');
    assert.strictEqual(a.soldQty, 5); assert.strictEqual(b.soldQty, 2);
    assert.strictEqual(a.cost, 500); assert.strictEqual(b.cost, 240);
    assert.strictEqual(a.revenue, 5000); assert.strictEqual(b.revenue, 2000);
    assert.strictEqual(a.profit, 4500);
    assert.strictEqual(a.onHandQty, 0); assert.strictEqual(b.onHandQty, 3);
    const lots = await S.productLots(fp.id);
    assert.deepStrictEqual(lots.map(l => [l.supplier, l.qty, l.remaining]), [['Alfa MMC', 5, 0], ['Beta Toys', 5, 3]]);
    const bySup = await S.stockBySupplier();
    assert.deepStrictEqual(bySup[fp.id], [{ name: 'Beta Toys', qty: 3 }]);
  });

  await t('qaytarma malı çıxdığı partiyalara qaytarır; növbəti satış yenə ən köhnədən', async () => {
    const sale = (await S.recentSales(1))[0];
    await S.createReturn(sale.id, [{ lineIndex: 0, qty: 3 }], manager);
    let rep = await S.supplierReport({});
    assert.strictEqual(repRow(rep, 'Alfa MMC').returnedQty, 1); assert.strictEqual(repRow(rep, 'Beta Toys').returnedQty, 2);
    assert.strictEqual(repRow(rep, 'Alfa MMC').qty, 4); assert.strictEqual(repRow(rep, 'Beta Toys').qty, 0);
    assert.strictEqual(repRow(rep, 'Alfa MMC').onHandQty, 1); assert.strictEqual(repRow(rep, 'Beta Toys').onHandQty, 5);
    await S.checkout([{ productId: fp.id, qty: 2 }], null, { method: 'cash', cashReceived: 2000 });
    rep = await S.supplierReport({});
    assert.strictEqual(repRow(rep, 'Alfa MMC').onHandQty, 0); assert.strictEqual(repRow(rep, 'Beta Toys').onHandQty, 4);
    const lots = await S.productLots(fp.id);
    assert.strictEqual(lots.reduce((n, l) => n + l.remaining, 0), (await S.listProducts()).find(x => x.id === fp.id).stock);
  });

  await t('mənfi qalıqla satış: qəbul gələnə qədər "təchizatçısız", qəbuldan sonra təchizatçıya aid olur', async () => {
    const np = (await S.createProduct({ name: 'Əvvəl satılan', price: 500, cost: 50 })).product;
    await S.checkout([{ productId: np.id, qty: 2 }], null, { method: 'cash', cashReceived: 1000 });
    let rep = await S.supplierReport({});
    assert.ok(repRow(rep, 'Təchizatçısız (köhnə qalıq / mənfi satış)').products.some(p => p.productId === np.id && p.soldQty === 2));
    await S.receiveStock(np.id, 10, 50, '', alfa.id);
    rep = await S.supplierReport({});
    assert.ok(!repRow(rep, 'Təchizatçısız (köhnə qalıq / mənfi satış)').products.some(p => p.productId === np.id), 'borc partiyaya bağlandı');
    assert.strictEqual(repRow(rep, 'Alfa MMC').products.find(p => p.productId === np.id).soldQty, 2);
    const lots = await S.productLots(np.id);
    assert.strictEqual(lots.reduce((n, l) => n + l.remaining, 0), 8);
  });

  await t('dövr filtri: gələcək dövrdə satış yoxdur; maya yalnız "alış qiymətini görmək" icazəsi olanda göstərilir', async () => {
    const future = await S.supplierReport({ from: '2099-01-01T00:00:00.000Z', to: '2099-02-01T00:00:00.000Z' });
    assert.strictEqual(future.totals.soldQty, 0);
    assert.ok(future.totals.onHandQty > 0, 'qalıq dövrdən asılı deyil');
    S.logout(); S._session.user = { id: 'u_muhasib1', name: 'Mühasib 1', role: 'muhasib' };     // əvvəlki testdə bloklanıb: sessiyanı birbaşa quraq
    assert.strictEqual((await S.supplierReport({})).seeCost, true);
    const m = (await DB.get('meta', 'matrix')).value; const keep = JSON.parse(JSON.stringify(m));
    m.muhasib = m.muhasib.filter(x => x !== 'product.cost.view'); await DB.put('meta', { key: 'matrix', value: m });
    const hidden = await S.supplierReport({});
    assert.strictEqual(hidden.seeCost, false); assert.strictEqual(hidden.rows[0].cost, null); assert.strictEqual(hidden.rows[0].profit, null);
    assert.ok((await S.productLots(fp.id)).every(l => l.unitCost === null));
    await DB.put('meta', { key: 'matrix', value: keep });
  });

  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
