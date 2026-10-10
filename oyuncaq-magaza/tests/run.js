/* node tests/run.js */
const assert = require('assert');
const Money = require('../js/money.js');
globalThis.Money = Money;
const Barcode = require('../js/barcode.js');
const Rules = require('../js/rules.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + e.message); }
}

// Pul
t('parse vergül', () => assert.strictEqual(Money.parse('100,00'), 10000));
t('parse nöqtə', () => assert.strictEqual(Money.parse('2.25'), 225));
t('parse bir onluq', () => assert.strictEqual(Money.parse('14,5'), 1450));
t('parse boşluqlu', () => assert.strictEqual(Money.parse('1 250,00'), 125000));
t('parse səhv', () => assert.strictEqual(Money.parse('12,345'), null));
t('parse hərf', () => assert.strictEqual(Money.parse('abc'), null));
t('format', () => assert.strictEqual(Money.format(125075), '1 250,75'));
t('0.1+0.2 problemi yoxdur', () => assert.strictEqual(Money.parse('0,1') + Money.parse('0,2'), Money.parse('0,3')));

// Barkod
t('məlum EAN-13 yoxlama rəqəmi', () => assert.strictEqual(Barcode.checkDigit('400638133393'), '1'));
t('valid EAN-13', () => assert.ok(Barcode.isValidEan13('4006381333931')));
t('invalid EAN-13', () => assert.ok(!Barcode.isValidEan13('4006381333932')));
t('mağaza barkodu 20 ilə başlayır və validdir (AC-01)', () => {
  const b = Barcode.storeBarcode(17);
  assert.strictEqual(b.length, 13); assert.ok(b.startsWith('20')); assert.ok(Barcode.isValidEan13(b));
  assert.ok(Barcode.isStoreBarcode(b)); assert.ok(!Barcode.isReceiptBarcode(b));
});
t('ardıcıl barkodlar fərqlidir', () => assert.notStrictEqual(Barcode.storeBarcode(1), Barcode.storeBarcode(2)));
t('çek barkodu → nömrə', () => assert.strictEqual(Barcode.receiptNoFromBarcode(Barcode.receiptBarcode(418)), 418));
t('kodlaşdırma 95 modul', () => assert.strictEqual(Barcode.encode('4006381333931').length, 95));
t('SVG yaranır', () => assert.ok(Barcode.svg(Barcode.storeBarcode(5)).startsWith('<svg')));

// Mal qəbulu (orta çəkili maya) — həm lokal, həm başqa cihazdan gələn hadisə üçün eyni funksiya
t('mal qəbulu: orta maya', () => {
  const r = Rules.applyReceipt({ stock: 4, avgCost: 900 }, 6, 1000);
  assert.strictEqual(r.stock, 10); assert.strictEqual(r.avgCost, 960); assert.strictEqual(r.lastCost, 1000); assert.strictEqual(r.negSalesSinceReceipt, 0);
});
t('mal qəbulu: mənfi qalıq orta mayaya təsir etmir', () => {
  const r = Rules.applyReceipt({ stock: -3, avgCost: 500 }, 10, 800);
  assert.strictEqual(r.stock, 7); assert.strictEqual(r.avgCost, 800);
});

// Səbət və endirim
const lines = [{ price: 1450, qty: 1 }, { price: 600, qty: 1 }, { price: 225, qty: 2 }];
t('yekun 25,00', () => assert.strictEqual(Rules.cartTotals(lines).total, 2500));
t('5% endirim 23,75', () => assert.strictEqual(Rules.cartTotals(lines, 5).total, 2375));
t('7% endirim qadağan (AC-09)', () => assert.ok(Rules.validateDiscountPercent(7)));
t('mal qəbulu ayrıca icazədir: Menecer və Admin-də var, Kassir və Mühasibdə yox', () => {
  assert.ok(Rules.PERMISSIONS['stock.receive']);
  assert.ok(Rules.can(null, 'menecer', 'stock.receive') && Rules.can(null, 'admin', 'stock.receive'));
  assert.ok(!Rules.can(null, 'kassir', 'stock.receive') && !Rules.can(null, 'muhasib', 'stock.receive'));
});
t('köhnə matris yenilənir: product.edit olan rola stock.receive əlavə olunur, təkrar çağırış dəyişmir, orijinal dəyişmir', () => {
  const old = { menecer: ['product.edit'], kassir: ['pos.sell'], muhasib: ['report.view'] };
  const up = Rules.upgradeMatrix(old);
  assert.deepStrictEqual(up.menecer, ['product.edit', 'stock.receive', 'supplier.manage', 'supplier.view']);   // 4: təchizatçı icazələri
  assert.deepStrictEqual(up.kassir, ['pos.sell', 'stock.request']);      // 5: kassir mal gəldi sorğusu göndərə bilir
  assert.deepStrictEqual(up.muhasib, ['report.view', 'supplier.view']);      // hesabata baxan təchizatçı hesabatını görür, dəyişə bilmir
  assert.deepStrictEqual(old.menecer, ['product.edit']);
  assert.deepStrictEqual(Rules.upgradeMatrix(up), up);
});
t('mal gəldi sorğusu: yalnız Kassirdə (menecer və admin birbaşa qəbul edir), köhnə matrisə Kassir üçün əlavə olunur', () => {
  assert.ok(Rules.PERMISSIONS['stock.request']);
  assert.ok(Rules.can(null, 'kassir', 'stock.request') && !Rules.can(null, 'kassir', 'stock.receive'));
  assert.ok(!Rules.can(null, 'menecer', 'stock.request') && !Rules.can(null, 'muhasib', 'stock.request'));
  assert.ok(Rules.MATRIX_VERSION >= 5);
  const up = Rules.upgradeMatrix({ kassir: ['pos.sell', 'product.view'], menecer: ['product.edit'] });
  assert.ok(up.kassir.includes('stock.request') && !up.menecer.includes('stock.request'));
});
t('5% endirim icazəli', () => assert.strictEqual(Rules.validateDiscountPercent(5), null));

// Ödəniş
t('nağd 25 / 100 → 75 (AC-05)', () => assert.strictEqual(Rules.validatePayment({ method: 'cash', total: 2500, cashReceived: 10000 }).change, 7500));
t('nağd az (AC-06)', () => assert.strictEqual(Rules.validatePayment({ method: 'cash', total: 2500, cashReceived: 2000 }).ok, false));
t('bank (AC-07)', () => { const r = Rules.validatePayment({ method: 'bank', total: 2500, bankType: 'pos' }); assert.ok(r.ok); assert.strictEqual(r.change, 0); });
t('bank növü məcburi', () => assert.strictEqual(Rules.validatePayment({ method: 'bank', total: 2500 }).ok, false));
t('qarışıq 15 köçürmə + 10 nağd, alınan 20 → 10', () => {
  const r = Rules.validatePayment({ method: 'mixed', total: 2500, bankAmount: 1500, bankType: 'transfer', cashReceived: 2000 });
  assert.ok(r.ok); assert.strictEqual(r.cashPart, 1000); assert.strictEqual(r.change, 1000);
});
t('qarışıqda bank ≥ yekun qadağan', () => assert.strictEqual(Rules.validatePayment({ method: 'mixed', total: 2500, bankAmount: 2500, bankType: 'pos', cashReceived: 0 }).ok, false));

// Mənfi qalıq
t('qalıq kifayətdir', () => assert.strictEqual(Rules.negativeStockCheck({ stock: 5, negSalesSinceReceipt: 0 }, 2).needsNegative, false));
t('qalıq 0, 1-ci mənfi çek, 5 ədəd (AC-16)', () => { const r = Rules.negativeStockCheck({ stock: 0, negSalesSinceReceipt: 0 }, 5); assert.ok(r.needsNegative); assert.ok(!r.blocked); assert.strictEqual(r.stockAfter, -5); });
t('3-cü mənfi çek bloklanır (AC-10)', () => assert.ok(Rules.negativeStockCheck({ stock: -2, negSalesSinceReceipt: 2 }, 1).blocked));

// Qaytarma müddəti (Bakı vaxtı)
t('1 okt → 16 okt: bitib (AC-11)', () => assert.ok(Rules.returnWindow('2026-10-01T10:00:00+04:00', '2026-10-16T09:00:00+04:00').expired));
t('1 okt → 15 okt 23:59: olar (AC-12)', () => assert.ok(!Rules.returnWindow('2026-10-01T10:00:00+04:00', '2026-10-15T23:59:00+04:00').expired));
t('gecə yarısı UTC sərhədi: Bakı tarixi istifadə olunur', () => {
  // 2026-10-01 01:00 Bakı = 2026-09-30 21:00 UTC
  assert.strictEqual(Rules.localDate('2026-09-30T21:00:00Z'), '2026-10-01');
});
t('qaytarıla bilən say', () => assert.strictEqual(Rules.returnableQty(2, 1), 1));
t('endirimli çekdən qaytarma', () => assert.strictEqual(Rules.refundAmount([{ price: 600, qty: 1 }], 5), 570));

// İcazələr
t('kassir endirimi təsdiqləyə bilmir', () => assert.ok(!Rules.can(null, 'kassir', 'pos.discount.approve')));
t('kassir alış qiymətini görmür', () => assert.ok(!Rules.can(null, 'kassir', 'product.cost.view')));
t('mühasib qiymət dəyişə bilmir (AC-15)', () => assert.ok(!Rules.can(null, 'muhasib', 'product.price.set')));
t('menecer qiyməti təyin edir', () => assert.ok(Rules.can(null, 'menecer', 'product.price.set')));

// Çap üçün barkod (svgMm): zolaq eni printer nöqtəsinin tam sayıdır, ölçü sahəyə sığır
function rectsOf(svg) { return [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="(\d+)"/g)].map(m => ({ x: +m[1], w: +m[2], h: +m[3] })); }
t('svgMm: zolaqlar modulun tam misillərində, sxem EAN-13 ilə eyni', () => {
  for (const dpi of [203, 300]) for (const maxW of [27, 36, 44, 54, 70]) {
    const code = Barcode.storeBarcode(12345), r = Barcode.svgMm(code, { dpi, maxWidthMm: maxW, heightMm: 12 });
    const rects = rectsOf(r.svg), bits = Barcode.encode(code), left = 7 * r.mod;
    assert.ok(rects.every(x => x.x % r.mod === 0 && x.w % r.mod === 0), 'qeyri-tam zolaq');
    const painted = new Array(bits.length).fill('0');
    rects.forEach(x => { for (let i = x.x - left; i < x.x - left + x.w; i += r.mod) painted[i / r.mod] = '1'; });
    assert.strictEqual(painted.join(''), bits, 'zolaq sxemi EAN-13 deyil');
  }
});
t('svgMm: sahəyə sığır; geniş etiketdə zolaq qalınlaşır, dar etiketdə xəbərdarlıq (ok=false)', () => {
  const code = Barcode.storeBarcode(1);
  for (const maxW of [26.2, 36, 54]) { const r = Barcode.svgMm(code, { dpi: 203, maxWidthMm: maxW, heightMm: 12 }); assert.ok(r.widthMm <= maxW + 1e-6, maxW + ' mm sahəyə sığmır: ' + r.widthMm); assert.ok(r.ok); }
  assert.strictEqual(Barcode.svgMm(code, { dpi: 203, maxWidthMm: 26.2, heightMm: 12 }).mod, 2);
  assert.strictEqual(Barcode.svgMm(code, { dpi: 203, maxWidthMm: 54, heightMm: 12 }).mod, 4);
  assert.strictEqual(Barcode.svgMm(code, { dpi: 203, maxWidthMm: 20, heightMm: 12 }).ok, false);
  assert.strictEqual(Barcode.svgMm(code, { dpi: 300, maxWidthMm: 20, heightMm: 12 }).ok, false);
});
t('svgMm: 12 rəqəm yazılır, ölçü mm ilə verilir', () => {
  const code = Barcode.storeBarcode(99), r = Barcode.svgMm(code, { dpi: 203, maxWidthMm: 50, heightMm: 12 });
  assert.strictEqual((r.svg.match(/<text /g) || []).length, 13);
  assert.ok(/width="[\d.]+mm" height="12\.0\d*mm"/.test(r.svg) || /height="1[12]\.\d+mm"/.test(r.svg));
  assert.ok(!/<text /.test(Barcode.svgMm(code, { dpi: 203, maxWidthMm: 50, heightMm: 12, text: false }).svg));
});

// Növbə
t('gözlənilən nağd', () => {
  const sales = [{ payment: { cashPart: 2500 } }, { payment: { cashPart: 0 } }];
  const returns = [{ amount: 600, cashAmount: 600 }];
  assert.strictEqual(Rules.expectedCash({ openingCash: 5000 }, sales, returns, [{ type: 'out', amount: 1000 }]), 5900);
});

console.log(`\n${passed} keçdi, ${failed} uğursuz`);
process.exit(failed ? 1 : 0);
