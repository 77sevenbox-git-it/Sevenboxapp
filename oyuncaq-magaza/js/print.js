/* Çap: termo çek printeri (Xprinter XP-80 / XP-58 tipli, 80 və 58 mm) və yapışqanlı etiket printeri (XP-365B / XP-420B tipli).
   Printer brauzerdən, Windows/Chrome çap sürücüsü ilə işləyir. Kağız ölçüsü @page ilə dəqiq verilir, barkodun zolaq eni isə
   printerin nöqtəsinin (dot) tam sayıdır. Ayarlar cihaza aiddir (localStorage): hər kassanın öz printeri var, serverə getmir. */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var KEY = 'mag.print';
  var PAPER = { 80: { content: 72, fs: 3.1 }, 58: { content: 48, fs: 2.9 } };   // kağız eni → çap sahəsi (mm) və şrift (mm)
  var LABEL_PRESETS = [[30, 20], [40, 30], [50, 30], [58, 40], [60, 40], [70, 50], [100, 50], [100, 100]];
  var DEFAULTS = { receipt: { paper: 80, mode: 'exact', dpi: 203, feedMm: 8, lang: 'az' }, label: { w: 58, h: 40, dpi: 203, mode: 'exact' } };

  function clamp(n, lo, hi, d) { n = Number(n); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
  function sanitize(s) {
    s = s || {}; var r = s.receipt || {}, l = s.label || {};
    return {
      receipt: { paper: Number(r.paper) === 58 ? 58 : 80, mode: r.mode === 'driver' ? 'driver' : 'exact', dpi: Number(r.dpi) === 300 ? 300 : 203, feedMm: Math.round(clamp(r.feedMm, 0, 40, DEFAULTS.receipt.feedMm)), lang: ['az', 'ru', 'en', 'tr'].indexOf(r.lang) !== -1 ? r.lang : 'az' },
      label: { w: Math.round(clamp(l.w, 20, 120, DEFAULTS.label.w) * 10) / 10, h: Math.round(clamp(l.h, 12, 200, DEFAULTS.label.h) * 10) / 10, dpi: Number(l.dpi) === 300 ? 300 : 203, mode: l.mode === 'driver' ? 'driver' : 'exact' }
    };
  }
  var cache = null;
  function settings() {
    if (cache) return cache;
    var raw = null;
    try { raw = JSON.parse(root.localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    cache = sanitize(raw);
    return cache;
  }
  function save(s) {
    cache = sanitize(s);
    try { root.localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* yaddaş bağlıdırsa ayar yalnız bu səhifə açıq olana qədər qalır */ }
    return cache;
  }

  function U() { return root.UI; }
  function esc(s) { return U().esc(s); }

  // Çekin dili interfeys dilindən ayrıdır (Çap ayarları → "Çekin dili"). rt(cfg) çekdəki mətnləri həmin dildə qaytaran _t verir.
  function rt(cfg) {
    var lang = (cfg || settings()).receipt.lang;
    return function (key, params) { return root.I18n ? root.I18n.t(key, params, lang) : _t(key, params); };
  }

  /* ---------- Çek ---------- */
  function wrap(inner, cfg) {
    var r = (cfg || settings()).receipt, p = PAPER[r.paper];
    return '<div class="receipt" style="width:' + p.content + 'mm;font-size:' + p.fs + 'mm">' + inner + '</div>';
  }

  function receiptBarcode(code, cfg) {
    var r = cfg.receipt, p = PAPER[r.paper];
    return '<div class="bc">' + root.Barcode.svgMm(code, { dpi: r.dpi, maxWidthMm: p.content - 2, heightMm: 12, maxMod: 4 }).svg + '</div>';
  }

  function receiptHtml(sale, store, opts) {
    var M = root.Money, cfg = settings(), _t = rt(cfg), lang = cfg.receipt.lang;
    var METHOD = { cash: _t('Nağd'), bank: _t('Bank'), mixed: _t('Qarışıq') }, BANK = { pos: _t('POS kart'), transfer: _t('Karta köçürmə') };
    // Çekdə şəkil YOXDUR: yalnız mətn (məhsul şəkli kassa ekranı üçündür, sətirlərə yazılmır)
    var rows = sale.lines.map(function (l) {
      return '<div class="nm">' + esc(l.name) + '</div><div class="r"><span>' + l.qty + ' × ' + M.format(l.price) + '</span><span>' + M.format(l.price * l.qty) + '</span></div>' +
        (l.discount ? '<div class="r"><span>' + (l.discountPercent ? _t('Endirim {0}%', [l.discountPercent]) : _t('Endirim')) + '</span><span>−' + M.format(l.discount) + '</span></div>' : '');
    }).join('');
    var p = sale.payment;
    var pay = '<div class="r"><span>' + _t('Ödəniş') + '</span><span>' + METHOD[p.method] + (p.bankType ? ' (' + BANK[p.bankType] + ')' : '') + '</span></div>';
    if (p.bankPart) pay += '<div class="r"><span>' + _t('Bank') + '</span><span>' + M.format(p.bankPart) + '</span></div>';
    if (p.cashPart) pay += '<div class="r"><span>' + _t('Nağd alınan') + '</span><span>' + M.format(p.cashReceived) + '</span></div><div class="r"><span>' + _t('Qaytarılan@@change') + '</span><span>' + M.format(p.change) + '</span></div>';
    return wrap(
      (opts && opts.reprint ? '<div class="c"><b>' + _t('YENİDƏN ÇAP') + '</b></div>' : '') +
      '<h3>' + esc(store.name) + '</h3><div class="c">' + _t('VÖEN') + ' ' + esc(store.voen) + '</div><div class="c">' + esc(store.address) + '</div><hr>' +
      '<div class="r"><span>' + _t('Çek №') + '</span><span>' + String(sale.receiptNo).padStart(6, '0') + '</span></div>' +
      '<div class="r"><span>' + _t('Tarix') + '</span><span>' + U().fmtDate(sale.at, lang) + '</span></div>' +
      '<div class="r"><span>' + _t('Kassir') + '</span><span>' + esc(sale.cashierName) + '</span></div><hr>' + rows + '<hr>' +
      '<div class="r"><span>' + _t('Ara cəm') + '</span><span>' + M.format(sale.totals.subtotal) + '</span></div>' +
      (sale.totals.lineDiscount ? '<div class="r"><span>' + _t('Sətir endirimləri') + '</span><span>−' + M.format(sale.totals.lineDiscount) + '</span></div>' : '') +
      (sale.totals.discount ? '<div class="r"><span>' + (sale.discount && sale.discount.type !== 'amount' && sale.discount.percent ? _t('Endirim {0}%', [sale.discount.percent]) : _t('Endirim')) + '</span><span>−' + M.format(sale.totals.discount) + '</span></div>' : '') +
      '<div class="r big"><span>' + _t('YEKUN') + '</span><span>' + M.format(sale.totals.total) + ' AZN</span></div>' + pay + '<hr>' +
      receiptBarcode(sale.receiptBarcode, cfg) +
      '<div class="c">' + _t('Qaytarma {0} gün ərzində, çeklə', [root.Rules.RETURN_DAYS]) + '</div>' +
      '<div class="c">' + _t('Bu çek fiskal çek deyil') + '</div>', cfg);
  }

  function returnReceiptHtml(ret, sale, store) {
    var M = root.Money, cfg = settings(), _t = rt(cfg), lang = cfg.receipt.lang;
    var BANK = { pos: _t('POS kart'), transfer: _t('Karta köçürmə') };
    // Sətirin məbləği endirimdən sonra müştəriyə qaytarılan puldur (yeni qaytarmalarda "refund"), köhnələrdə qiymət × say
    var rows = ret.lines.map(function (l) { return '<div class="nm">' + esc(l.name) + '</div><div class="r"><span>' + l.qty + ' × ' + M.format(l.price) + '</span><span>' + M.format(l.refund != null ? l.refund : l.price * l.qty) + '</span></div>'; }).join('');
    return wrap('<h3>' + esc(store.name) + '</h3><div class="c"><b>' + _t('QAYTARMA ÇEKİ') + '</b></div><hr>' +
      '<div class="r"><span>' + _t('İlkin çek №') + '</span><span>' + String(sale.receiptNo).padStart(6, '0') + '</span></div>' +
      '<div class="r"><span>' + _t('Tarix') + '</span><span>' + U().fmtDate(ret.at, lang) + '</span></div>' +
      '<div class="r"><span>' + _t('Təsdiqləyən') + '</span><span>' + esc(ret.approvedByName) + '</span></div><hr>' + rows + '<hr>' +
      '<div class="r big"><span>' + _t('Qaytarılan') + '</span><span>' + M.format(ret.amount) + ' AZN</span></div>' +
      (ret.cashAmount ? '<div class="r"><span>' + _t('Nağd') + '</span><span>' + M.format(ret.cashAmount) + '</span></div>' : '') +
      (ret.bankAmount ? '<div class="r"><span>' + BANK[ret.bankType] + '</span><span>' + M.format(ret.bankAmount) + '</span></div>' : ''), cfg);
  }

  /* ---------- Təchizatçı hesabat sənədi (A4) ----------
     Günün sonunda təchizatçıya göndərilir: onun malının satıldığı çeklər, ödənişlər və qalıq borc. Dil ayrıca seçilir (təchizatçı başqa dildə oxuya bilər). */
  // Sənədin dili interfeys dilindən ayrıdır: "_t" adı QƏSDƏN saxlanılıb (tərcümə açarlarını tarayıcı bu adla tapır)
  function stmT(lang) { return function (key, params) { return root.I18n ? root.I18n.t(key, params, lang) : String(key).replace(/\{(\d+)\}/g, function (m, i) { return params && params[i] != null ? params[i] : m; }); }; }
  function dayText(ds) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ds || ''); return m ? m[3] + '.' + m[2] + '.' + m[1] : ''; }
  function periodText(stm, _t) {
    var a = dayText(stm.range && stm.range.fromDay), b = dayText(stm.range && stm.range.toDay);
    if (a && b) return a === b ? a : a + ' – ' + b;
    if (a) return _t('{0} tarixindən', [a]);
    if (b) return _t('{0} tarixinə qədər', [b]);
    return _t('Bütün vaxt');
  }
  function stmLabels(stm, _t) {
    var sold = stm.basis === 'sold';
    return { accrued: sold ? _t('Satılan malın alış dəyəri') : _t('Alınan mal'), basisNote: sold ? _t('Borc yalnız satılmış malın alış qiyməti ilə hesablanır.') : _t('Borc təchizatçıdan alınan malın alış qiyməti ilə hesablanır.') };
  }
  function methodText(m, _t) { return m === 'cash' ? _t('Nağd') : _t('Bank'); }

  function statementHtml(stm, lang) {
    var M = root.Money, _t = stmT(lang), sold = stm.basis === 'sold', L = stmLabels(stm, _t);
    var store = stm.store || {};
    function money(v) { return M.format(v); }
    function row(a, b, cls) { return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + a + '</td><td class="n">' + b + '</td></tr>'; }
    var out = '<div class="sdoc"><div class="sd-head"><h1>' + esc(store.name || '') + '</h1><div>' + (store.voen ? _t('VÖEN') + ' ' + esc(store.voen) + ' · ' : '') + esc(store.address || '') + '</div></div>' +
      '<h2>' + _t('TƏCHİZATÇI HESABATI') + '</h2>' +
      '<table class="sd-meta"><tr><td>' + _t('Təchizatçı') + '</td><td><b>' + esc(stm.supplier.name) + '</b></td></tr><tr><td>' + _t('Dövr') + '</td><td>' + esc(periodText(stm, _t)) + '</td></tr>' +
      '<tr><td>' + _t('Hazırlandı') + '</td><td>' + esc(U().fmtDate(stm.at, lang)) + ' · ' + esc(stm.by) + '</td></tr></table>';

    out += '<h3>' + _t('1. Satış çekləri (bu təchizatçının malı)') + '</h3>';
    if (!stm.receipts.length) out += '<p class="sd-empty">' + _t('Bu dövrdə bu təchizatçının malı satılmayıb') + '</p>';
    else {
      out += '<table class="sd-tab"><thead><tr><th>' + _t('Çek №') + ' / ' + _t('Tarix') + '</th><th>' + _t('Məhsul') + '</th><th class="n">' + _t('Say') + '</th><th class="n">' + _t('Qiymət') + '</th><th class="n">' + _t('Məbləğ') + '</th>' + (sold ? '<th class="n">' + _t('Alış dəyəri') + '</th>' : '') + '</tr></thead><tbody>';
      stm.receipts.forEach(function (r) {
        var head = (r.kind === 'ret' ? _t('Qaytarma') + ' · ' : '') + String(r.receiptNo || '').padStart(6, '0') + ' · ' + U().fmtDate(r.at, lang);
        r.lines.forEach(function (ln, i) {
          out += '<tr class="' + (i === 0 ? 'first' : '') + '"><td>' + (i === 0 ? esc(head) : '') + '</td><td>' + esc(ln.name) + '</td><td class="n">' + ln.qty + '</td><td class="n">' + money(ln.price) + '</td><td class="n">' + money(ln.revenue) + '</td>' + (sold ? '<td class="n">' + money(ln.cost) + '</td>' : '') + '</tr>';
        });
      });
      out += '</tbody><tfoot><tr><th colspan="2">' + _t('Cəmi') + '</th><th class="n">' + stm.sales.qty + '</th><th></th><th class="n">' + money(stm.sales.revenue) + '</th>' + (sold ? '<th class="n">' + money(stm.sales.cost) + '</th>' : '') + '</tr></tfoot></table>';
    }

    out += '<h3>' + _t('2. Hesablaşma') + '</h3><table class="sd-acc">' +
      row(_t('Əvvəlki borc'), money(stm.opening)) +
      row('+ ' + L.accrued, money(stm.accrued)) +
      row('− ' + _t('Ödənişlər'), money(stm.paidTotal)) +
      (stm.reversedTotal ? row('+ ' + _t('Ləğv edilmiş ödənişlər'), money(stm.reversedTotal)) : '') +
      row(stm.closing < 0 ? _t('Qalıq (avans: təchizatçı mağazaya borcludur)') : _t('QALIQ BORC'), money(stm.closing) + ' AZN', 'total') + '</table>' +
      '<p class="sd-note">' + esc(L.basisNote) + '</p>';

    if (stm.payments.length || stm.reversed.length) {
      out += '<h3>' + _t('3. Ödənişlər') + '</h3><table class="sd-tab"><thead><tr><th>' + _t('Tarix') + '</th><th>' + _t('Üsul') + '</th><th>' + _t('Qeyd') + '</th><th class="n">' + _t('Məbləğ') + '</th></tr></thead><tbody>';
      stm.payments.forEach(function (p) { out += '<tr><td>' + esc(U().fmtDate(p.at, lang)) + '</td><td>' + methodText(p.method, _t) + '</td><td>' + esc(p.note || '') + '</td><td class="n">' + money(p.amount) + '</td></tr>'; });
      stm.reversed.forEach(function (p) { out += '<tr><td>' + esc(U().fmtDate(p.voidedAt, lang)) + '</td><td>' + _t('Ləğv') + '</td><td>' + esc(U().fmtDate(p.at, lang)) + ' · ' + esc(p.voidReason || '') + '</td><td class="n">−' + money(p.amount) + '</td></tr>'; });
      out += '</tbody></table>';
    }
    if (!sold && stm.accruedItems.length) {
      out += '<h3>' + _t('4. Alınan mal') + '</h3><table class="sd-tab"><thead><tr><th>' + _t('Tarix') + '</th><th>' + _t('Məhsul') + '</th><th class="n">' + _t('Say') + '</th><th class="n">' + _t('Alış qiyməti') + '</th><th class="n">' + _t('Məbləğ') + '</th></tr></thead><tbody>';
      stm.accruedItems.forEach(function (it) { out += '<tr><td>' + esc(U().fmtDate(it.at, lang)) + '</td><td>' + esc(it.name) + '</td><td class="n">' + it.qty + '</td><td class="n">' + money(it.unitCost) + '</td><td class="n">' + money(it.amount) + '</td></tr>'; });
      out += '</tbody></table>';
    }
    out += '<div class="sd-sign"><div>' + _t('Təhvil verdi') + ': ____________________</div><div>' + _t('Qəbul etdi') + ': ____________________</div></div></div>';
    return out;
  }

  // Mətn forması (mesajlaşma proqramına yapışdırmaq / paylaşmaq üçün)
  function statementText(stm, lang) {
    var M = root.Money, _t = stmT(lang), sold = stm.basis === 'sold', L = stmLabels(stm, _t), store = stm.store || {};
    var o = [(store.name || ''), _t('TƏCHİZATÇI HESABATI') + ': ' + stm.supplier.name, _t('Dövr') + ': ' + periodText(stm, _t), ''];
    if (!stm.receipts.length) o.push(_t('Bu dövrdə bu təchizatçının malı satılmayıb'));
    stm.receipts.forEach(function (r) {
      o.push((r.kind === 'ret' ? _t('Qaytarma') + ' ' : _t('Çek №') + ' ') + String(r.receiptNo || '').padStart(6, '0') + ' (' + U().fmtDate(r.at, lang) + ')');
      r.lines.forEach(function (ln) { o.push('  ' + ln.name + ' × ' + ln.qty + ' = ' + M.format(ln.revenue) + (sold ? ' [' + _t('Alış dəyəri') + ' ' + M.format(ln.cost) + ']' : '')); });
    });
    if (stm.receipts.length) o.push('', _t('Satış cəmi') + ': ' + stm.sales.qty + ' ' + _t('ədəd') + ', ' + M.format(stm.sales.revenue) + ' AZN');
    o.push('', _t('Əvvəlki borc') + ': ' + M.format(stm.opening), '+ ' + L.accrued + ': ' + M.format(stm.accrued), '− ' + _t('Ödənişlər') + ': ' + M.format(stm.paidTotal));
    if (stm.reversedTotal) o.push('+ ' + _t('Ləğv edilmiş ödənişlər') + ': ' + M.format(stm.reversedTotal));
    o.push((stm.closing < 0 ? _t('Qalıq (avans: təchizatçı mağazaya borcludur)') : _t('QALIQ BORC')) + ': ' + M.format(stm.closing) + ' AZN');
    stm.payments.forEach(function (p) { o.push('  ' + U().fmtDate(p.at, lang) + ' ' + methodText(p.method, _t) + ' ' + M.format(p.amount) + (p.note ? ' (' + p.note + ')' : '')); });
    return o.join('\n');
  }

  /* ---------- Etiket ---------- */
  // Etiketin ölçüsünə görə yerləşmə (mm): ad (1–2 sətir), qiymət, barkod. Kiçik etiketdə kənar boşluq azalır ki, barkod 0,25 mm zolaqla sığsın.
  function labelLayout(w, h) {
    var padX = w < 34 ? 1.2 : 2, padY = h < 25 ? 1 : 1.5;
    var fsName = clamp(h * 0.085, 2.0, 3.3, 2.6), lines = h >= 28 ? 2 : 1;
    var fsPrice = clamp(h * 0.13, 3.0, 5.8, 4);
    var nameH = lines * fsName * 1.15, priceH = fsPrice * 1.1;
    var barH = clamp(h - 2 * padY - nameH - priceH - 1.6, 6, 20, 10);
    return { padX: padX, padY: padY, fsName: fsName, lines: lines, nameH: nameH, fsPrice: fsPrice, barH: barH, barW: w - 2 * padX };
  }

  function barcodeInfo() {
    var L = settings().label, lay = labelLayout(L.w, L.h);
    var b = root.Barcode.svgMm(root.Barcode.storeBarcode(1), { dpi: L.dpi, maxWidthMm: lay.barW, heightMm: lay.barH, maxMod: 4 });
    return { mod: b.mod, modMm: b.modMm, widthMm: b.widthMm, ok: b.ok };
  }

  function labelsHtml(items, opts) {
    var M = root.Money, L = settings().label, lay = labelLayout(L.w, L.h), frame = opts && opts.frame;
    var out = '<div class="labels">';
    items.forEach(function (it) {
      var bc = root.Barcode.svgMm(it.product.storeBarcode, { dpi: L.dpi, maxWidthMm: lay.barW, heightMm: lay.barH, maxMod: 4 }).svg;
      for (var i = 0; i < it.count; i++) {
        out += '<div class="label' + (frame ? ' frame' : '') + '" style="width:' + L.w + 'mm;height:' + (L.h - 0.4) + 'mm;padding:' + lay.padY + 'mm ' + lay.padX + 'mm">' +
          '<div class="n" style="font-size:' + lay.fsName.toFixed(2) + 'mm;max-height:' + lay.nameH.toFixed(2) + 'mm;-webkit-line-clamp:' + lay.lines + '">' + esc(it.product.name) + '</div>' +
          '<div class="p" style="font-size:' + lay.fsPrice.toFixed(2) + 'mm">' + M.format(it.product.price) + ' ₼</div>' +
          '<div class="bc">' + bc + '</div></div>';
      }
    });
    return out + '</div>';
  }

  /* ---------- Çap ---------- */
  function pageStyle() {
    var st = document.getElementById('print-page-css');
    if (!st) { st = document.createElement('style'); st.id = 'print-page-css'; document.head.appendChild(st); }
    return st;
  }

  // Çekin hündürlüyü məzmuna görə ölçülür: sürücüdə "sonsuz" kağız yoxdursa printer lazımsız boş kağız çəkməsin
  function measureMm(html, widthMm) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;width:' + widthMm + 'mm';
    box.innerHTML = html; document.body.appendChild(box);
    var px = box.getBoundingClientRect().height;
    box.remove();
    return px * 25.4 / 96;
  }

  // kind: 'receipt' | 'label'
  function print(html, kind) {
    var cfg = settings(), css;
    var area = document.getElementById('print-area');
    if (!area) { area = document.createElement('div'); area.id = 'print-area'; document.body.appendChild(area); }
    area.innerHTML = html;
    if (kind === 'doc') {
      css = '@page{size:A4;margin:12mm}';
    } else if (kind === 'label') {
      css = cfg.label.mode === 'driver' ? '@page{margin:0}' : '@page{size:' + cfg.label.w + 'mm ' + cfg.label.h + 'mm;margin:0}';
    } else if (cfg.receipt.mode === 'driver') {
      css = '@page{margin:0}';
    } else {
      var hmm = Math.ceil(measureMm(html, cfg.receipt.paper)) + 1 + cfg.receipt.feedMm;
      css = '@page{size:' + cfg.receipt.paper + 'mm ' + hmm + 'mm;margin:0}';
    }
    pageStyle().textContent = css;
    // Düzülüş bitsin deyə iki kadr gözlənilir
    return new Promise(function (resolve) {
      var raf = root.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
      raf(function () { raf(function () { root.print(); resolve(css); }); });
    });
  }

  /* ---------- Sınaq çapı və ayarlar ---------- */
  function testReceiptHtml() {
    var cfg = settings(), p = PAPER[cfg.receipt.paper], M = root.Money, _t = rt(cfg);
    return wrap('<div class="c"><b>' + _t('ÇAP SINAĞI') + '</b></div><div class="frame-box">' +
      '<div class="c">' + _t('Kağız {0} mm · çap sahəsi {1} mm', [cfg.receipt.paper, p.content]) + '</div>' +
      '<div class="r"><span>Konstruktor dəsti, 120 hissə</span><span>' + M.format(1450) + '</span></div>' +
      '<div class="r"><span>ƏÖÜĞŞİÇ əöüğşıç</span><span>12,50</span></div></div>' +
      '<div class="c">' + _t('← bütün çərçivə görünməlidir →') + '</div>' +
      receiptBarcode(root.Barcode.receiptBarcode(1), cfg) +
      '<div class="c">' + _t('{0} dpi · zolaq {1} mm', [cfg.receipt.dpi, root.Barcode.svgMm(root.Barcode.receiptBarcode(1), { dpi: cfg.receipt.dpi, maxWidthMm: p.content - 2, heightMm: 12, maxMod: 4 }).modMm.toFixed(3)]) + '</div>', cfg);
  }
  function testLabelHtml() {
    return labelsHtml([{ product: { name: 'Sınaq məhsulu — uzun ad nümunəsi ƏÖÜĞŞİÇ', price: 1250, storeBarcode: root.Barcode.storeBarcode(1) }, count: 1 }], { frame: true });
  }

  function settingsModal(onClose) {
    var h = U().h, cur = settings();
    function sel(id, opts, val) { return h('select', { class: 'input', id: id }, opts.map(function (o) { return h('option', { value: String(o[0]), selected: String(o[0]) === String(val) }, o[1]); })); }
    function num(id, val, min, max, step) { return h('input', { class: 'input mono', id: id, type: 'number', min: String(min), max: String(max), step: String(step || 1), value: String(val) }); }
    function fld(label, el, id) { return h('div', { class: 'field' }, h('label', { for: id }, label), el); }

    var paper = sel('pr-paper', [[80, _t('80 mm (XP-80, XP-N160 …)')], [58, _t('58 mm (XP-58 …)')]], cur.receipt.paper);
    var rdpi = sel('pr-rdpi', [[203, _t('203 dpi (adətən)')], [300, _t('300 dpi')]], cur.receipt.dpi);
    var rmode = sel('pr-rmode', [['exact', _t('Tətbiq kağız ölçüsünü verir (tövsiyə)')], ['driver', _t('Çap sürücüsünün ölçüsü')]], cur.receipt.mode);
    var feed = num('pr-feed', cur.receipt.feedMm, 0, 40);
    var rlang = sel('pr-lang', (root.I18n ? root.I18n.langs : [{ code: 'az', name: 'Azərbaycanca' }]).map(function (l) { return [l.code, l.name]; }), cur.receipt.lang);
    var preset = sel('pl-preset', LABEL_PRESETS.map(function (p) { return [p[0] + 'x' + p[1], p[0] + ' × ' + p[1] + ' mm']; }).concat([['custom', _t('Digər ölçü…')]]),
      LABEL_PRESETS.some(function (p) { return p[0] === cur.label.w && p[1] === cur.label.h; }) ? cur.label.w + 'x' + cur.label.h : 'custom');
    var lw = num('pl-w', cur.label.w, 20, 120, 0.5), lh = num('pl-h', cur.label.h, 12, 200, 0.5);
    var ldpi = sel('pl-dpi', [[203, _t('203 dpi (XP-365B, XP-420B …)')], [300, _t('300 dpi')]], cur.label.dpi);
    var lmode = sel('pl-mode', [['exact', _t('Tətbiq etiket ölçüsünü verir (tövsiyə)')], ['driver', _t('Çap sürücüsünün ölçüsü')]], cur.label.mode);
    var info = h('div', { class: 'muted', style: 'font-size:13px', id: 'pl-info', role: 'status' });
    var customRow = h('div', { class: 'grid2' }, fld(_t('En, mm'), lw, 'pl-w'), fld(_t('Hündürlük, mm'), lh, 'pl-h'));

    function sync() {
      var isCustom = preset.value === 'custom';
      customRow.hidden = !isCustom;
      if (!isCustom) { var p = preset.value.split('x'); lw.value = p[0]; lh.value = p[1]; }
    }
    function collect() {
      return { receipt: { paper: Number(paper.value), dpi: Number(rdpi.value), mode: rmode.value, feedMm: Number(feed.value), lang: rlang.value },
        label: { w: Number(lw.value), h: Number(lh.value), dpi: Number(ldpi.value), mode: lmode.value } };
    }
    function refreshInfo() {
      var keep = cache; cache = sanitize(collect());
      var b = barcodeInfo(); cache = keep;
      info.textContent = _t('Etiketdə barkod zolağı: {0} mm ({1} nöqtə), eni {2} mm.{3}', [b.modMm.toFixed(3), b.mod, b.widthMm.toFixed(1), (b.ok ? '' : _t(' Etiket çox dardır: barkod oxunmaya bilər, daha geniş etiket seçin.'))]);
      info.className = b.ok ? 'muted' : 'warn-text'; info.style.fontSize = '13px';
    }
    [preset, lw, lh, ldpi, lmode].forEach(function (e) { e.addEventListener('change', function () { sync(); refreshInfo(); }); e.addEventListener('input', refreshInfo); });
    sync(); refreshInfo();

    function persist() { save(collect()); }
    var m = U().modal({
      title: _t('Çap ayarları (bu cihaz üçün)'), wide: true, onClose: onClose,
      body: h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
        h('div', { class: 'card', style: 'padding:14px;display:flex;flex-direction:column;gap:12px' }, h('b', null, _t('Çek printeri (termo)')),
          h('div', { class: 'grid2' }, fld(_t('Kağız eni'), paper, 'pr-paper'), fld(_t('Çap sıxlığı'), rdpi, 'pr-rdpi'), fld(_t('Kağız ölçüsü'), rmode, 'pr-rmode'), fld(_t('Çekdən sonra boşluq, mm'), feed, 'pr-feed'), fld(_t('Çekin dili'), rlang, 'pr-lang')),
          h('div', null, h('button', { class: 'btn small', type: 'button', id: 'pr-test', onclick: function () { persist(); print(testReceiptHtml(), 'receipt'); } }, _t('Test çeki çap et')))),
        h('div', { class: 'card', style: 'padding:14px;display:flex;flex-direction:column;gap:12px' }, h('b', null, _t('Etiket printeri')),
          h('div', { class: 'grid2' }, fld(_t('Etiket ölçüsü'), preset, 'pl-preset'), fld(_t('Çap sıxlığı'), ldpi, 'pl-dpi'), fld(_t('Kağız ölçüsü'), lmode, 'pl-mode')), customRow, info,
          h('div', null, h('button', { class: 'btn small', type: 'button', id: 'pl-test', onclick: function () { persist(); print(testLabelHtml(), 'label'); } }, _t('Test etiketi çap et')))),
        h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Çap pəncərəsində: Printer — Xprinter, Miqyas — 100%, Kənar boşluqlar — Yoxdur, Başlıq və sonluq — söndürülü. Test çapında çərçivə tam görünmürsə, kənar boşluğu və ya "Kağız ölçüsü" seçimini dəyişin.'))),
      buttons: [{ text: _t('Bağla') }, { text: _t('Yadda saxla'), kind: 'primary', submit: true, onClick: function (close) { persist(); close(); U().toast(_t('Çap ayarları yadda saxlanıldı')); } }]
    });
    return m;
  }

  root.Print = { rt: rt, settings: settings, save: save, sanitize: sanitize, receiptHtml: receiptHtml, returnReceiptHtml: returnReceiptHtml, statementHtml: statementHtml, statementText: statementText, labelsHtml: labelsHtml, wrap: wrap,
    print: print, settingsModal: settingsModal, barcodeInfo: barcodeInfo, labelLayout: labelLayout, testReceiptHtml: testReceiptHtml, testLabelHtml: testLabelHtml,
    LABEL_PRESETS: LABEL_PRESETS, PAPER: PAPER, _reset: function () { cache = null; } };
  if (typeof module !== 'undefined') module.exports = root.Print;
})(typeof window !== 'undefined' ? window : globalThis);
