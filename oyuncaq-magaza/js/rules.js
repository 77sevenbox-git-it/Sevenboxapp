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
    'supplier.pay': _t('Təchizatçıya ödəniş etmək (nağd olarsa kassadan çıxır)'),
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
  // 6: "supplier.pay" — təchizatçıya ödəniş və borc hesabı. Yalnız Admin-ə verilir (pul kassadan çıxır); Admin başqa rola özü verə bilər.
  var MATRIX_VERSION = 6;
  function upgradeMatrix(m) {
    var out = {};
    Object.keys(m || {}).forEach(function (role) {
      var list = (m[role] || []).slice();
      function add(p) { if (list.indexOf(p) === -1) list.push(p); }
      if (list.indexOf('product.edit') !== -1) add('stock.receive');
      if (list.indexOf('stock.receive') !== -1) add('supplier.manage');
      if (list.indexOf('stock.receive') !== -1 || list.indexOf('report.view') !== -1) add('supplier.view');
      if (role === 'kassir') add('stock.request');
      if (role === 'admin') add('supplier.pay');
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

  /* ---------- Endirim ----------
     Endirim iki yerə tətbiq olunur: ayrıca məhsul sətrinə (hədd: məhsulun "max endirim %"-i) və bütün çekə (hədd: Admin təyin edir, həm faiz, həm məbləğ).
     Təsvir: {type:'percent', percent} | {type:'amount', amount (qəpik)}. Köhnə çeklərdə yalnız {percent} var: o, faiz sayılır. */
  var DEFAULT_DISCOUNT_CAPS = { percent: MAX_DISCOUNT_PERCENT, amount: 10000 };      // çek üzrə ilkin hədd: 5% və 100 ₼ (Admin dəyişir)
  var IMAGE_MAX_CHARS = 12000;                                                       // məhsul şəkli (data URL): hadisə Sheets xanasına (50 000 simvol) sığmalıdır
  var MAX_LINE_DISCOUNT = 100;

  function discountKind(d) { return d && d.type === 'amount' ? 'amount' : 'percent'; }

  // base: endirimdən əvvəlki məbləğ (qəpik). Endirim heç vaxt base-dən çox olmur.
  function discountValue(base, d) {
    if (!d || !(base > 0)) return 0;
    var v = discountKind(d) === 'amount' ? d.amount : Money.percentOf(base, d.percent);
    if (!(v > 0)) return 0;
    return Math.min(v, base);
  }

  // Ortaq yoxlama: faiz 0-dan böyük, məbləğ müsbət tam qəpik olmalıdır
  function discountShape(d) {
    if (!d || typeof d !== 'object') return _t('Endirim səhvdir');
    if (discountKind(d) === 'amount') {
      if (typeof d.amount !== 'number' || !Number.isInteger(d.amount) || d.amount <= 0) return _t('Endirim məbləği 0-dan böyük olmalıdır');
    } else if (typeof d.percent !== 'number' || !Number.isFinite(d.percent) || d.percent <= 0) return _t('Endirim faizi 0-dan böyük olmalıdır');
    return null;
  }

  // Bir məhsul sətri: gross = qiymət × say. maxPercent — məhsulun icazə verilən ən çox endirim faizi (0 = endirim yoxdur)
  function validateLineDiscount(gross, d, maxPercent) {
    var bad = discountShape(d); if (bad) return bad;
    var max = maxPercent > 0 ? maxPercent : 0;
    if (!(max > 0)) return _t('Bu məhsula endirim verilmir');
    var limit = Money.percentOf(gross, max);
    if (discountKind(d) === 'percent') {
      if (d.percent > max) return _t('Bu məhsula ən çox {0}% endirim olar', [max]);
      if (discountValue(gross, d) <= 0) return _t('Endirim çox kiçikdir');
      return null;
    }
    if (d.amount > limit) return _t('Bu sətirə ən çox {0} ₼ endirim olar ({1}%)', [Money.format(limit), max]);
    return null;
  }

  // Bütün çek: net — sətir endirimlərindən sonrakı məbləğ. caps: {percent, amount}. Həm faiz, həm məbləğ həddi gözlənilməlidir.
  function validateReceiptDiscount(net, d, caps) {
    var bad = discountShape(d); if (bad) return bad;
    caps = caps || DEFAULT_DISCOUNT_CAPS;
    if (!(caps.percent > 0) || !(caps.amount > 0)) return _t('Çek üzrə endirim bağlıdır (Admin həddi 0 qoyub)');
    var value = discountValue(net, d), byPercent = Money.percentOf(net, caps.percent);
    if (discountKind(d) === 'percent' && d.percent > caps.percent) return _t('Çek üzrə endirim ən çox {0}% ola bilər', [caps.percent]);
    if (value <= 0) return _t('Endirim çox kiçikdir');
    if (discountKind(d) === 'amount' && d.amount >= net) return _t('Endirim çekin məbləğindən az olmalıdır');
    if (value > caps.amount) return _t('Çek üzrə endirim ən çox {0} ₼ ola bilər', [Money.format(caps.amount)]);
    if (value > byPercent) return _t('Çek üzrə endirim ən çox {0}% ({1} ₼) ola bilər', [caps.percent, Money.format(byPercent)]);
    return null;
  }

  // Mağaza ayarlarından çek həddi (səhv/yoxdursa ilkin)
  function discountCaps(store) {
    var p = store && store.discountMaxPercent, a = store && store.discountMaxAmount;
    return {
      percent: typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 100 ? p : DEFAULT_DISCOUNT_CAPS.percent,
      amount: typeof a === 'number' && Number.isInteger(a) && a >= 0 && a <= 1e10 ? a : DEFAULT_DISCOUNT_CAPS.amount
    };
  }

  // Məhsul şəkli: boş və ya kiçik data URL (jpeg/png/webp). Yalnız bu format <img src>-yə verilir.
  function imageProblem(s) {
    if (s == null || s === '') return null;
    if (typeof s !== 'string' || s.length > IMAGE_MAX_CHARS) return _t('Şəkil çox böyükdür');
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/]+={0,2}$/.test(s)) return _t('Şəkil formatı səhvdir');
    return null;
  }
  function safeImage(s) { return typeof s === 'string' && s !== '' && !imageProblem(s) ? s : ''; }

  function maxDiscountProblem(v) {
    if (v == null || v === '') return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_LINE_DISCOUNT || Math.round(v * 100) !== v * 100) return _t('Maksimum endirim 0 ilə 100 arasında olmalıdır');
    return null;
  }

  /* ---------- Səbət ---------- */
  // lines: [{price (qəpik), qty, discount (qəpik, sətir endirimi, ixtiyari)}], receiptDiscount: Endirim təsvirinə uyğun, ya da köhnə rəqəm (faiz)
  function cartTotals(lines, receiptDiscount) {
    var subtotal = 0, count = 0, lineDiscount = 0;
    lines.forEach(function (l) {
      var gross = l.price * l.qty;
      subtotal += gross; count += l.qty;
      lineDiscount += Math.min(Math.max(l.discount || 0, 0), gross);
    });
    if (typeof receiptDiscount === 'number') receiptDiscount = receiptDiscount ? { type: 'percent', percent: receiptDiscount } : null;
    var net = subtotal - lineDiscount;
    var discount = discountValue(net, receiptDiscount);
    return { subtotal: subtotal, lineDiscount: lineDiscount, discount: discount, total: net - discount, itemCount: count };
  }

  // Köhnə (yalnız faiz) yoxlama: 5% həddi ilə. Yeni kod validateReceiptDiscount / validateLineDiscount istifadə edir.
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

  // Qaytarılacaq pul (köhnə sadə forma: yalnız çek faizi). Yeni kod refundFor istifadə edir.
  function refundAmount(lines, discountPercent) {
    var gross = 0;
    lines.forEach(function (l) { gross += l.price * l.qty; });
    return gross - (discountPercent ? Money.percentOf(gross, discountPercent) : 0);
  }

  // Çekin hər sətri üçün müştərinin faktiki ödədiyi pul (qəpik): əvvəl sətir endirimi çıxılır, sonra çek endirimi sətirlərə mütənasib bölünür
  // (qəpik qalıqları ən böyük kəsr qaydası ilə paylanır). Cəm həmişə çekin yekununa bərabərdir.
  function paidPerLine(sale) {
    var nets = sale.lines.map(function (l) { return l.price * l.qty - (l.discount || 0); });
    var D = (sale.totals && sale.totals.discount) || 0, net = nets.reduce(function (a, b) { return a + b; }, 0);
    if (!(D > 0) || !(net > 0)) return nets;
    var alloc = [], frac = [], used = 0;
    nets.forEach(function (n, i) { var exact = n * D / net, fl = Math.floor(exact); alloc.push(fl); frac.push({ i: i, f: exact - fl }); used += fl; });
    var rest = D - used;
    frac.sort(function (a, b) { return b.f - a.f || a.i - b.i; });
    for (var k = 0; rest > 0 && k < frac.length; k++, rest--) alloc[frac[k].i]++;
    for (k = 0; rest < 0 && k < alloc.length; k++) { var j = alloc.length - 1 - k; if (alloc[j] > 0) { alloc[j]--; rest++; } }
    return nets.map(function (n, i) { return n - alloc[i]; });
  }

  // Qaytarma: items [{lineIndex, qty}], prev {lineIndex: əvvəl qaytarılan say}. Hər sətir üçün məbləğ KÜMULYATİV hesablanır:
  // sətrin bütün sayı qayıdanda cəm dəqiq həmin sətrin ödənişinə bərabər olur (hissə-hissə qaytarmada qəpik itmir).
  // Qaytarır: {amount, lines: [{lineIndex, refund}]}
  function refundFor(sale, items, prev) {
    var paid = paidPerLine(sale), out = [], amount = 0;
    items.forEach(function (it) {
      var l = sale.lines[it.lineIndex]; if (!l || !(it.qty > 0)) return;
      var before = (prev && prev[it.lineIndex]) || 0, after = Math.min(l.qty, before + it.qty);
      var p = paid[it.lineIndex];
      var r = (after >= l.qty ? p : Math.round(p * after / l.qty)) - (before >= l.qty ? p : Math.round(p * before / l.qty));
      out.push({ lineIndex: it.lineIndex, refund: r }); amount += r;
    });
    return { amount: amount, lines: out };
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
      // "Endirim" = sətir endirimləri + çek endirimi: satış − endirim − qaytarma həmişə kassanın cəmi ilə uzlaşır
      s.gross += x.totals.subtotal; s.discount += (x.totals.lineDiscount || 0) + (x.totals.discount || 0); s.cash += x.payment.cashPart;
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
    DEFAULT_DISCOUNT_CAPS: DEFAULT_DISCOUNT_CAPS, IMAGE_MAX_CHARS: IMAGE_MAX_CHARS, discountKind: discountKind, discountValue: discountValue, validateLineDiscount: validateLineDiscount,
    validateReceiptDiscount: validateReceiptDiscount, discountCaps: discountCaps, imageProblem: imageProblem, safeImage: safeImage, maxDiscountProblem: maxDiscountProblem,
    validatePayment: validatePayment, localDate: localDate, returnWindow: returnWindow, returnableQty: returnableQty,
    refundAmount: refundAmount, paidPerLine: paidPerLine, refundFor: refundFor, expectedCash: expectedCash, shiftSummary: shiftSummary
  };
  root.Rules = Rules;
  if (typeof module !== 'undefined') module.exports = Rules;
})(typeof window !== 'undefined' ? window : globalThis);
