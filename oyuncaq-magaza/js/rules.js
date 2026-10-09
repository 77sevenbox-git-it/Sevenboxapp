/* Biznes qaydaları (BRD v1.2). Saf funksiyalar: verilənlər bazasına və ekrana toxunmur, testlə yoxlanılır. */
(function (root) {
  'use strict';
  var Money = root.Money || (typeof require !== 'undefined' ? require('./money.js') : null);

  var TZ = 'Asia/Baku';
  var MAX_DISCOUNT_PERCENT = 5;     // BR-08
  var NEGATIVE_SALE_LIMIT = 2;      // BR-09: qalıq ≤ 0 olan məhsul mal qəbuluna qədər max 2 çekdə
  var RETURN_DAYS = 14;             // BR-10

  /* ---------- Rollar və icazələr (FR-110..113) ---------- */
  var PERMISSIONS = {
    'pos.sell': 'Satış etmək',
    'pos.discount.request': 'Endirim sorğusu',
    'pos.discount.approve': 'Endirimi təsdiqləmək',
    'pos.line.delete': 'Çekdən sətir silmək',
    'pos.return.request': 'Qaytarma sorğusu',
    'pos.return.approve': 'Qaytarmanı təsdiqləmək',
    'shift.open_close': 'Növbə açıb bağlamaq',
    'product.view': 'Məhsullara baxmaq',
    'product.edit': 'Məhsul yaratmaq və dəyişmək',
    'product.price.set': 'Satış qiymətini təyin etmək',
    'product.cost.view': 'Alış qiymətini görmək',
    'label.print': 'Etiket çap etmək',
    'report.view': 'Hesabatlara baxmaq',
    'admin.users': 'İstifadəçiləri idarə etmək',
    'admin.permissions': 'İcazə matrisini dəyişmək'
  };

  var DEFAULT_MATRIX = {
    admin: Object.keys(PERMISSIONS),
    menecer: ['pos.sell', 'pos.discount.request', 'pos.discount.approve', 'pos.line.delete', 'pos.return.request', 'pos.return.approve',
      'shift.open_close', 'product.view', 'product.edit', 'product.price.set', 'product.cost.view', 'label.print', 'report.view'],
    kassir: ['pos.sell', 'pos.discount.request', 'pos.return.request', 'shift.open_close', 'product.view', 'label.print'],
    muhasib: ['product.view', 'product.cost.view', 'report.view']
  };

  var ROLE_NAMES = { admin: 'Admin', menecer: 'Menecer', kassir: 'Kassir', muhasib: 'Mühasib' };

  function can(matrix, role, perm) {
    var list = (matrix || DEFAULT_MATRIX)[role];
    return !!(list && list.indexOf(perm) !== -1);
  }

  /* ---------- Səbət ---------- */
  // lines: [{productId, price (qəpik), qty}]
  function cartTotals(lines, discountPercent) {
    var subtotal = 0, count = 0;
    lines.forEach(function (l) { subtotal += l.price * l.qty; count += l.qty; });
    var discount = discountPercent ? Money.percentOf(subtotal, discountPercent) : 0;
    return { subtotal: subtotal, discount: discount, total: subtotal - discount, itemCount: count };
  }

  function validateDiscountPercent(p) {
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return 'Endirim faizi 0-dan böyük olmalıdır';
    if (p > MAX_DISCOUNT_PERCENT) return 'Endirim ' + MAX_DISCOUNT_PERCENT + '%-dən çox ola bilməz';
    return null;
  }

  /* ---------- Mənfi qalıq (FR-59, BR-09) ---------- */
  // product: {stock, negSalesSinceReceipt}; qty: səbətdəki say
  function negativeStockCheck(product, qty) {
    var needsNegative = qty > product.stock;
    var used = product.negSalesSinceReceipt || 0;
    return {
      needsNegative: needsNegative,
      used: used,
      blocked: needsNegative && used >= NEGATIVE_SALE_LIMIT,
      stockAfter: product.stock - qty
    };
  }

  /* ---------- Mal qəbulu (FR-24): orta çəkili maya ---------- */
  // Mənfi qalıq orta mayaya təsir etmir (yalnız mövcud mal çəkilir). Qaytarır: yeni sahələr.
  function applyReceipt(product, qty, unitCost) {
    var base = Math.max(product.stock, 0);
    var avg = base + qty > 0 ? Math.round((base * product.avgCost + qty * unitCost) / (base + qty)) : unitCost;
    return { stock: product.stock + qty, avgCost: avg, lastCost: unitCost, negSalesSinceReceipt: 0 };
  }

  /* ---------- Ödəniş (FR-54, FR-55, BR-05, BR-06) ---------- */
  // p: {method: 'cash'|'bank'|'mixed', total, cashReceived, bankAmount, bankType: 'pos'|'transfer'}
  function validatePayment(p) {
    var total = p.total;
    if (!(total > 0)) return { ok: false, error: 'Çek boşdur' };

    if (p.method === 'cash') {
      if (p.cashReceived == null) return { ok: false, error: 'Alınan məbləği yazın' };
      if (p.cashReceived < total) return { ok: false, error: 'Alınan məbləğ yekundan azdır' };
      return { ok: true, cashPart: total, bankPart: 0, cashReceived: p.cashReceived, change: p.cashReceived - total };
    }

    if (p.method === 'bank') {
      if (p.bankType !== 'pos' && p.bankType !== 'transfer') return { ok: false, error: 'POS kart və ya köçürmə seçin' };
      return { ok: true, cashPart: 0, bankPart: total, cashReceived: 0, change: 0 };
    }

    if (p.method === 'mixed') {
      if (p.bankType !== 'pos' && p.bankType !== 'transfer') return { ok: false, error: 'Bank hissəsinin növünü seçin' };
      if (!(p.bankAmount > 0)) return { ok: false, error: 'Bank hissəsini yazın' };
      if (p.bankAmount >= total) return { ok: false, error: 'Bank hissəsi yekundan az olmalıdır, əks halda "Bank" seçin' };
      var cashPart = total - p.bankAmount;
      if (p.cashReceived == null || p.cashReceived < cashPart) return { ok: false, error: 'Nağd alınan məbləğ nağd hissədən azdır' };
      return { ok: true, cashPart: cashPart, bankPart: p.bankAmount, cashReceived: p.cashReceived, change: p.cashReceived - cashPart };
    }
    return { ok: false, error: 'Ödəniş üsulu seçilməyib' };
  }

  /* ---------- Tarix (Asia/Baku) ---------- */
  function localDate(d) {
    // "YYYY-MM-DD" Bakı vaxtı ilə
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  }
  function dayIndex(d) {
    var parts = localDate(d).split('-').map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000;
  }

  /* ---------- Qaytarma (FR-70..73, BR-10) ---------- */
  // Təqvim günü ilə: satış günü 0-cı gün. 14-cü gün daxil olmaqla qaytarmaq olar.
  function returnWindow(saleAt, now) {
    var days = dayIndex(now) - dayIndex(saleAt);
    return { daysPassed: days, expired: days > RETURN_DAYS };
  }

  // Bir çek sətri üzrə hələ qaytarıla bilən say
  function returnableQty(soldQty, alreadyReturnedQty) {
    return Math.max(0, soldQty - (alreadyReturnedQty || 0));
  }

  // Qaytarılacaq pul: sətir endirimi çekin endirim faizi ilə mütənasib çıxılır
  function refundAmount(lines, discountPercent) {
    var gross = 0;
    lines.forEach(function (l) { gross += l.price * l.qty; });
    return gross - (discountPercent ? Money.percentOf(gross, discountPercent) : 0);
  }

  /* ---------- Növbə (FR-80) ---------- */
  function expectedCash(shift, sales, returns, cashMoves) {
    var cash = shift.openingCash;
    sales.forEach(function (s) { cash += s.payment.cashPart; });
    returns.forEach(function (r) { cash -= r.cashAmount || 0; });
    (cashMoves || []).forEach(function (m) { cash += m.type === 'in' ? m.amount : -m.amount; });
    return cash;
  }

  function shiftSummary(sales, returns) {
    var s = { count: sales.length, gross: 0, discount: 0, cash: 0, pos: 0, transfer: 0, returns: 0 };
    sales.forEach(function (x) {
      s.gross += x.totals.subtotal; s.discount += x.totals.discount; s.cash += x.payment.cashPart;
      if (x.payment.bankPart) s[x.payment.bankType] += x.payment.bankPart;
    });
    returns.forEach(function (r) { s.returns += r.amount; });
    return s;
  }

  var Rules = {
    TZ: TZ, MAX_DISCOUNT_PERCENT: MAX_DISCOUNT_PERCENT, NEGATIVE_SALE_LIMIT: NEGATIVE_SALE_LIMIT, RETURN_DAYS: RETURN_DAYS,
    PERMISSIONS: PERMISSIONS, DEFAULT_MATRIX: DEFAULT_MATRIX, ROLE_NAMES: ROLE_NAMES, can: can,
    cartTotals: cartTotals, validateDiscountPercent: validateDiscountPercent, negativeStockCheck: negativeStockCheck, applyReceipt: applyReceipt,
    validatePayment: validatePayment, localDate: localDate, returnWindow: returnWindow, returnableQty: returnableQty,
    refundAmount: refundAmount, expectedCash: expectedCash, shiftSummary: shiftSummary
  };
  root.Rules = Rules;
  if (typeof module !== 'undefined') module.exports = Rules;
})(typeof window !== 'undefined' ? window : globalThis);
