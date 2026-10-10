/* Biznes qaydaları (BRD v1.2). Saf funksiyalar: verilənlər bazasına və ekrana toxunmur, testlə yoxlanılır. */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var Money = root.Money || (typeof require !== 'undefined' ? require('./money.js') : null);

  var TZ = 'Asia/Baku';
  var MAX_DISCOUNT_PERCENT = 5;     // BR-08
  var NEGATIVE_SALE_LIMIT = 2;      // BR-09: qalıq ≤ 0 olan məhsul mal qəbuluna qədər max 2 çekdə
  var RETURN_DAYS = 14;             // BR-10

  /* ---------- Rollar və icazələr (FR-110..113) ---------- */
  var PERMISSIONS = {
    'pos.sell': _t('Satış etmək'),
    'pos.discount.request': _t('Endirim sorğusu'),
    'pos.discount.approve': _t('Endirimi təsdiqləmək'),
    'pos.line.delete': _t('Çekdən sətir silmək'),
    'pos.return.request': _t('Qaytarma sorğusu'),
    'pos.return.approve': _t('Qaytarmanı təsdiqləmək'),
    'shift.open_close': _t('Növbə açıb bağlamaq'),
    'product.view': _t('Məhsullara baxmaq'),
    'product.edit': _t('Məhsul yaratmaq və dəyişmək'),
    'stock.receive': _t('Mal qəbul etmək (qalığı artırmaq)'),
    'stock.request': _t('Mal qəbulu sorğusu göndərmək (menecer təsdiqləyir)'),
    'product.price.set': _t('Satış qiymətini təyin etmək'),
    'product.cost.view': _t('Alış qiymətini görmək'),
    'label.print': _t('Etiket çap etmək'),
    'report.view': _t('Hesabatlara baxmaq'),
    'supplier.view': _t('Təchizatçılara və təchizatçı hesabatına baxmaq'),
    'supplier.manage': _t('Təchizatçı əlavə etmək və dəyişmək'),
    'admin.users': _t('İstifadəçiləri idarə etmək'),
    'admin.permissions': _t('İcazə matrisini dəyişmək')
  };

  var DEFAULT_MATRIX = {
    admin: Object.keys(PERMISSIONS),
    menecer: ['pos.sell', 'pos.discount.request', 'pos.discount.approve', 'pos.line.delete', 'pos.return.request', 'pos.return.approve',
      'shift.open_close', 'product.view', 'product.edit', 'stock.receive', 'product.price.set', 'product.cost.view', 'label.print', 'report.view', 'supplier.view', 'supplier.manage'],
    kassir: ['pos.sell', 'pos.discount.request', 'pos.return.request', 'shift.open_close', 'product.view', 'label.print', 'stock.request'],
    muhasib: ['product.view', 'product.cost.view', 'report.view', 'supplier.view']
  };

  // İcazə matrisinin versiyası. 3-dən əvvəl "stock.receive" yox idi, mal qəbulu "product.edit" ilə gedirdi.
  // 4: təchizatçı icazələri. "supplier.manage" mal qəbul edən rollara, "supplier.view" mal qəbul edən və ya hesabata baxan rollara verilir.
  // 5: "stock.request" — kassir mal gəldiyini bildirən sorğu göndərir, qalığı menecer təsdiqləyəndə artır (kassirə verilir).
  var MATRIX_VERSION = 5;
  function upgradeMatrix(m) {
    var out = {};
    Object.keys(m || {}).forEach(function (role) {
      var list = (m[role] || []).slice();
      function add(p) { if (list.indexOf(p) === -1) list.push(p); }
      if (list.indexOf('product.edit') !== -1) add('stock.receive');
      if (list.indexOf('stock.receive') !== -1) add('supplier.manage');
      if (list.indexOf('stock.receive') !== -1 || list.indexOf('report.view') !== -1) add('supplier.view');
      if (role === 'kassir') add('stock.request');
      out[role] = list;
    });
    return out;
  }

  // Giriş forması (rol üzrə Admin seçir): 'pin' (4–8 rəqəm) və ya 'password' (böyük + kiçik hərf, rəqəm, işarə; ən azı 8 simvol)
  var AUTH_FORMS = ['pin', 'password'];
  var DEFAULT_AUTH = { admin: 'pin', menecer: 'pin', kassir: 'pin', muhasib: 'pin' };
  var PASSWORD_MIN = 8, PASSWORD_MAX = 128;
  // Parolun qaydaları. Hərf: Unicode (ə, ğ, ı, ö, ü, ş, ç də sayılır). İşarə: hərf, rəqəm və boşluq olmayan istənilən simvol. Boşluq qadağandır (mobil klaviatura səssiz əlavə edə bilər).
  function passwordProblem(p) {
    p = String(p == null ? '' : p);
    if (/\s/.test(p)) return _t('Şifrədə boşluq ola bilməz');
    if (p.length < PASSWORD_MIN) return _t('Şifrə ən azı {0} simvol olmalıdır', [PASSWORD_MIN]);
    if (p.length > PASSWORD_MAX) return _t('Şifrə {0} simvoldan uzun ola bilməz', [PASSWORD_MAX]);
    if (!/\p{Lu}/u.test(p)) return _t('Şifrədə ən azı 1 böyük hərf olmalıdır');
    if (!/\p{Ll}/u.test(p)) return _t('Şifrədə ən azı 1 kiçik hərf olmalıdır');
    if (!/[0-9]/.test(p)) return _t('Şifrədə ən azı 1 rəqəm olmalıdır');
    if (!/[^\p{L}\p{N}\s]/u.test(p)) return _t('Şifrədə ən azı 1 işarə olmalıdır (məs. ! ? . # $ %)');
    return null;
  }
  // Siyasət: yalnız tanınan rollar və formalar; çatışmayan rol "pin" sayılır
  function normalizeAuth(p) {
    var out = Object.assign({}, DEFAULT_AUTH);
    if (p && typeof p === 'object') Object.keys(DEFAULT_AUTH).forEach(function (r) { if (AUTH_FORMS.indexOf(p[r]) !== -1) out[r] = p[r]; });
    return out;
  }
  var ROLE_NAMES = { admin: _t('Admin'), menecer: _t('Menecer'), kassir: _t('Kassir'), muhasib: _t('Mühasib') };

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
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return _t('Endirim faizi 0-dan böyük olmalıdır');
    if (p > MAX_DISCOUNT_PERCENT) return _t('Endirim {0}%-dən çox ola bilməz', [MAX_DISCOUNT_PERCENT]);
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
    if (!(total > 0)) return { ok: false, error: _t('Çek boşdur') };

    if (p.method === 'cash') {
      if (p.cashReceived == null) return { ok: false, error: _t('Alınan məbləği yazın') };
      if (p.cashReceived < total) return { ok: false, error: _t('Alınan məbləğ yekundan azdır') };
      return { ok: true, cashPart: total, bankPart: 0, cashReceived: p.cashReceived, change: p.cashReceived - total };
    }

    if (p.method === 'bank') {
      if (p.bankType !== 'pos' && p.bankType !== 'transfer') return { ok: false, error: _t('POS kart və ya köçürmə seçin') };
      return { ok: true, cashPart: 0, bankPart: total, cashReceived: 0, change: 0 };
    }

    if (p.method === 'mixed') {
      if (p.bankType !== 'pos' && p.bankType !== 'transfer') return { ok: false, error: _t('Bank hissəsinin növünü seçin') };
      if (!(p.bankAmount > 0)) return { ok: false, error: _t('Bank hissəsini yazın') };
      if (p.bankAmount >= total) return { ok: false, error: _t('Bank hissəsi yekundan az olmalıdır, əks halda "Bank" seçin') };
      var cashPart = total - p.bankAmount;
      // Alınan nağd yazılmayıbsa, nağd hissə dəqiq alınıb sayılır (qalıq verilmir)
      var recv = p.cashReceived == null ? cashPart : p.cashReceived;
      if (recv < cashPart) return { ok: false, error: _t('Nağd alınan məbləğ nağd hissədən azdır') };
      return { ok: true, cashPart: cashPart, bankPart: p.bankAmount, cashReceived: recv, change: recv - cashPart };
    }
    return { ok: false, error: _t('Ödəniş üsulu seçilməyib') };
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
    PERMISSIONS: PERMISSIONS, DEFAULT_MATRIX: DEFAULT_MATRIX, MATRIX_VERSION: MATRIX_VERSION, upgradeMatrix: upgradeMatrix, ROLE_NAMES: ROLE_NAMES, can: can,
    AUTH_FORMS: AUTH_FORMS, DEFAULT_AUTH: DEFAULT_AUTH, PASSWORD_MIN: PASSWORD_MIN, passwordProblem: passwordProblem, normalizeAuth: normalizeAuth,
    cartTotals: cartTotals, validateDiscountPercent: validateDiscountPercent, negativeStockCheck: negativeStockCheck, applyReceipt: applyReceipt,
    validatePayment: validatePayment, localDate: localDate, returnWindow: returnWindow, returnableQty: returnableQty,
    refundAmount: refundAmount, expectedCash: expectedCash, shiftSummary: shiftSummary
  };
  root.Rules = Rules;
  if (typeof module !== 'undefined') module.exports = Rules;
})(typeof window !== 'undefined' ? window : globalThis);
