/* Kassa ekranı (variant A). Klaviatura: Enter = barkod/təsdiq, F1 Nağd, F2 Bank, F3 Qarışıq, F4 Endirim,
   ↑/↓ sətir seçimi, + / − say (azaltmaq sərbəstdir, 1-dən aşağı yox), Del və ya zibil ikonu = sətri sil (menecer təsdiqi), Esc çeki ləğv et. */
(function (root) {
  'use strict';
  var UI = root.UI, S = root.Services, M = root.Money, R = root.Rules;
  var h = UI.h;

  var st = null;
  function fresh() {
    return { cart: [], sel: -1, method: null, bankType: 'pos', cash: '', bank: '', discount: null, msg: null, busy: false };
  }

  var refs = {};
  var mountEl = null;

  // Yarımçıq çek brauzer tabında saxlanılır: səhifəni yeniləmək səbəti silməsin (çıxışda və başqa istifadəçi girəndə silinir)
  var CART_KEY = 'mag.cart';
  function ses() { try { return root.sessionStorage || null; } catch (e) { return null; } }
  function saveCart() {
    var ss = ses(); if (!ss || !st) return;
    try {
      var u = S.currentUser();
      if (!u || (!st.cart.length && !st.discount)) ss.removeItem(CART_KEY);
      else ss.setItem(CART_KEY, JSON.stringify({ u: u.id, cart: st.cart.map(function (c) { return { id: c.product.id, qty: c.qty }; }), discount: st.discount }));
    } catch (e) { /* yaddaş bağlıdırsa davam */ }
  }
  function loadCart() {
    var ss = ses(), u = S.currentUser(); if (!ss || !u) return Promise.resolve();
    var raw = null;
    try { raw = JSON.parse(ss.getItem(CART_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || raw.u !== u.id || !raw.cart || !raw.cart.length) return Promise.resolve();
    return S.listProducts().then(function (ps) {
      var byId = {}; ps.forEach(function (p) { byId[p.id] = p; });
      raw.cart.forEach(function (c) { if (byId[c.id] && byId[c.id].active && c.qty > 0) st.cart.push({ product: byId[c.id], qty: c.qty }); });
      if (st.cart.length) { st.sel = 0; st.discount = raw.discount || null; setMsg('Yarımçıq çek bərpa olundu (' + st.cart.length + ' sətir)', 'warn'); }
    });
  }
  function reset() { st = null; pendingDel = {}; pendingCancel = false; var ss = ses(); if (ss) { try { ss.removeItem(CART_KEY); } catch (e) { /* */ } } }

  function totals() {
    return R.cartTotals(st.cart.map(function (c) { return { price: c.product.price, qty: c.qty }; }), st.discount ? st.discount.percent : 0);
  }

  function paymentInput() {
    var t = totals().total;
    var p = { method: st.method, bankType: st.bankType, total: t };
    if (st.method === 'cash') p.cashReceived = M.parse(st.cash);
    if (st.method === 'mixed') { p.bankAmount = M.parse(st.bank); p.cashReceived = M.parse(st.cash); }
    return p;
  }

  /* ---------- Səbət əməliyyatları ---------- */
  function addProduct(p) {
    var i = st.cart.findIndex(function (c) { return c.product.id === p.id; });
    if (i === -1) { st.cart.push({ product: p, qty: 1 }); i = st.cart.length - 1; } else st.cart[i].qty++;
    st.sel = i;
    var chk = R.negativeStockCheck(p, st.cart[i].qty);
    if (chk.blocked) {
      setMsg('"' + p.name + '" qalığı yoxdur və limit (' + R.NEGATIVE_SALE_LIMIT + ' mənfi çek) dolub. Satmaq olmaz — mal qəbulu lazımdır (qəbulu menecer edir).', 'bad');
      UI.beep(false);
    } else if (chk.needsNegative) {
      setMsg('Diqqət: "' + p.name + '" qalığı ' + p.stock + '. Mənfi qalıqla satış ' + (chk.used + 1) + '/' + R.NEGATIVE_SALE_LIMIT + ' çek.', 'warn');
      UI.beep(true);
    } else { setMsg(p.name + ' əlavə olundu', ''); UI.beep(true); }
    render();
  }

  function onScan(code) {
    code = String(code).trim();
    if (!code) return;
    S.lookupForPos(code).then(function (r) {
      if (!st) return;                      // axtarış gedəndə çıxış / sıfırlama olub: yeni istifadəçinin səbətinə yazmırıq
      if (r.kind === 'product') return addProduct(r.product);
      UI.beep(false);
      if (r.kind === 'mfr') setMsg('Bu istehsalçı barkodudur. Məhsulun üzərindəki mağaza barkodunu oxudun (' + r.products.map(function (p) { return p.name; }).join(', ') + ').', 'bad');
      else if (r.kind === 'receipt') setMsg('Bu çek barkodudur. Qaytarma üçün "Qaytarma" bölməsinə keçin.', 'warn');
      else if (r.kind === 'inactive') setMsg('"' + r.product.name + '" satışdan çıxarılıb.', 'bad');
      else setMsg('Barkod tapılmadı: ' + code, 'bad');
      render();
    });
  }

  // Sayı azaltmaq kassirə sərbəstdir (1-ə qədər); sətri tam silmək isə yalnız menecer təsdiqi ilə (SEC-04)
  function changeQty(i, delta) {
    var line = st.cart[i]; if (!line) return;
    if (delta > 0) { line.qty += delta; st.sel = i; render(); return; }
    if (line.qty <= 1) {
      setMsg('Sayı 1-dən azaltmaq olmaz. Sətri silmək üçün zibil ikonuna basın (menecer təsdiqi lazımdır).', 'warn');
      UI.beep(false); render(); return;
    }
    var from = line.qty;
    line.qty = Math.max(1, line.qty + delta);
    S.auditEvent('pos.qty_decreased', { productId: line.product.id, name: line.product.name, from: from, to: line.qty }).catch(function () { /* jurnal xətası satışı dayandırmasın */ });
    render(); focusScan();
  }

  // Menecer cavabı gec gələ bilər (pəncərə bağlıdır, kassir işləyir): təsdiq YALNIZ sorğu göndərilən vəziyyətə tətbiq olunur
  var pendingDel = {};      // məhsul id → bu sətir üçün sorğu gözlənilir
  var pendingCancel = false;
  function cartSig() { return st.cart.map(function (c) { return c.product.id + ':' + c.qty; }).sort().join('|'); }

  // Sətir silmə: PIN ilə dərhal və ya menecerə sorğu ilə. Təsdiq gələndə sorğuda göstərilən say silinir (arada əlavə olunan ədədlər qalır).
  function deleteLine(i) {
    var line = st.cart[i]; if (!line) return;
    var pid = line.product.id;
    if (pendingDel[pid]) { UI.toast('Bu sətir üçün sorğu artıq göndərilib, menecer cavabı gözlənilir', 'warn'); return; }
    var qty = line.qty;
    var value = line.product.price * qty;
    var summary = line.product.name + ' × ' + qty + ' = ' + M.format(value) + ' ₼';
    var who = S.currentUser() ? S.currentUser().name : '';
    pendingDel[pid] = true;
    UI.approve('Sətri çekdən sil', summary + ' çekdən çıxarılır.', 'pos.line.delete', { kind: 'line_delete', summary: who + ' sətir silmək istəyir: ' + summary })
      .then(function (approver) {
        delete pendingDel[pid];
        if (!st) return;
        if (!approver) { render(); return focusScan(); }
        var idx = st.cart.findIndex(function (c) { return c.product.id === pid; });
        if (idx === -1) { render(); return focusScan(); }
        var l = st.cart[idx];
        var removeQty = Math.min(qty, l.qty);
        return S.auditEvent('pos.line_removed', { productId: pid, name: l.product.name, qty: removeQty, value: l.product.price * removeQty, approvedBy: approver.id, approvedByName: approver.name })
          .then(function () {
            if (l.qty > removeQty) {
              l.qty -= removeQty;
              setMsg('Təsdiq olunan ' + removeQty + ' ədəd silindi, sətirdə ' + l.qty + ' qaldı (' + approver.name + ' təsdiqlədi)', '');
            } else {
              st.cart.splice(idx, 1); st.sel = Math.min(idx, st.cart.length - 1);
              resetPaymentIfEmpty();
              setMsg('Sətir silindi (' + approver.name + ' təsdiqlədi)', '');
            }
            render(); focusScan();
          });
      }).catch(function (e) { delete pendingDel[pid]; render(); UI.toast(e.message, 'bad'); });
    render();
  }

  function resetPaymentIfEmpty() { if (!st.cart.length) { st.method = null; st.discount = null; st.cash = ''; st.bank = ''; } }

  function cancelSale() {
    if (!st.cart.length) return;
    if (pendingCancel) { UI.toast('Çekin ləğvi üçün sorğu artıq göndərilib', 'warn'); return; }
    var value = totals().subtotal, sig = cartSig();
    pendingCancel = true;
    UI.approve('Çeki ləğv et', 'Bütün çek (' + M.format(value) + ' ₼) ləğv olunur.', 'pos.line.delete',
      { kind: 'sale_cancel', summary: (S.currentUser() ? S.currentUser().name : '') + ' çeki ləğv etmək istəyir: ' + M.format(value) + ' ₼' }).then(function (a) {
      pendingCancel = false;
      if (!st) return;
      if (!a) return focusScan();
      if (cartSig() !== sig) { setMsg('Çek arada dəyişdi, təsdiq olunmuş ləğv tətbiq edilmədi', 'warn'); render(); return focusScan(); }
      S.auditEvent('pos.sale_cancelled', { lines: st.cart.map(function (c) { return { productId: c.product.id, qty: c.qty }; }), value: value, approvedBy: a.id });
      st = fresh(); render(); focusScan();
    }).catch(function (e) { pendingCancel = false; UI.toast(e.message, 'bad'); });
  }

  function requestDiscount() {
    if (!st.cart.length) return;
    var input = h('input', { class: 'input', id: 'disc', type: 'number', min: '1', max: String(R.MAX_DISCOUNT_PERCENT), step: '0.5', value: st.discount ? st.discount.percent : '5' });
    UI.modal({
      title: 'Endirim sorğusu',
      body: h('div', { class: 'field' }, h('label', { for: 'disc' }, 'Endirim, % (ən çox ' + R.MAX_DISCOUNT_PERCENT + '%)'), input),
      buttons: [
        st.discount ? { text: 'Endirimi götür', kind: 'danger', onClick: function (close) { st.discount = null; close(); render(); } } : null,
        { text: 'İmtina' },
        { text: 'Menecerə göndər', kind: 'primary', submit: true, onClick: function (close) {
          var pct = parseFloat(String(input.value).replace(',', '.'));
          var v = R.validateDiscountPercent(pct); if (v) throw new Error(v);
          close();
          var t = R.cartTotals(st.cart.map(function (c) { return { price: c.product.price, qty: c.qty }; }), pct);
          var dsum = pct + '% endirim: ' + M.format(t.subtotal) + ' → ' + M.format(t.total) + ' ₼';
          var sig = cartSig();
          return UI.approve('Endirimi təsdiqlə', dsum, 'pos.discount.approve', { kind: 'discount', summary: (S.currentUser() ? S.currentUser().name : '') + ' endirim istəyir: ' + dsum }).then(function (a) {
            if (!st) return;
            S.auditEvent(a ? 'pos.discount_approved' : 'pos.discount_rejected', { percent: pct, subtotal: t.subtotal, approvedBy: a ? a.id : null });
            if (a && cartSig() !== sig) setMsg('Çek arada dəyişdi, təsdiqlənmiş endirim tətbiq edilmədi. Yenidən sorğu göndərin', 'warn');
            else if (a) { st.discount = { percent: pct, approvedBy: a }; setMsg(pct + '% endirim təsdiqləndi (' + a.name + ')', ''); }
            else setMsg('Endirim təsdiqlənmədi', 'warn');
            render(); focusScan();
          });
        } }
      ].filter(Boolean)
    });
  }

  function setMethod(m) {
    if (!st.cart.length) return;
    st.method = m;
    if (m === 'bank') { st.cash = ''; st.bank = ''; }
    render();
    setTimeout(function () {
      var f = m === 'cash' ? refs.cash : m === 'mixed' ? refs.bank : refs.confirm;
      if (f) f.focus();
    }, 0);
  }

  function confirmSale() {
    if (st.busy || !st.cart.length) return;
    var pay = R.validatePayment(paymentInput());
    if (!pay.ok) { setMsg(pay.error, 'bad'); UI.beep(false); render(); return; }
    st.busy = true; render();
    var cart = st.cart.map(function (c) { return { productId: c.product.id, qty: c.qty }; });
    var input = paymentInput(); delete input.total;
    S.checkout(cart, st.discount, input).then(function (sale) {
      return S.storeInfo().then(function (store) {
        var printErr = null;
        try { UI.printHtml(UI.receiptHtml(sale, store)); } catch (pe) { printErr = pe; }      // çap xətası satışı geri qaytarmır və səbəti açıq saxlamır (təkrar satış riski)
        var last = { receiptNo: sale.receiptNo, change: sale.payment.change, total: sale.totals.total };
        st = fresh();
        st.last = last;
        setMsg('Çek № ' + sale.receiptNo + ' tamamlandı' + (last.change ? ' · qaytarılacaq ' + M.format(last.change) + ' ₼' : '') + (printErr ? ' · ÇEK ÇAP OLUNMADI (' + printErr.message + '): Çeklər bölməsindən təkrar çap edin' : ''), printErr ? 'warn' : '');
        root.App && root.App.refreshStatus();
      });
    }).catch(function (e) {
      setMsg(e.message, 'bad'); UI.beep(false);
      if (e.code === 'negative_blocked') refreshProducts();
    }).then(function () { if (!st) return; st.busy = false; render(); focusScan(); });
  }

  // Satışdan sonra qalıqlar dəyişir; səbətdəki məhsul obyektlərini yeniləyirik
  function refreshProducts() {
    return S.listProducts().then(function (ps) {
      var byId = {}; ps.forEach(function (p) { byId[p.id] = p; });
      if (!st) return;                      // arada çıxış / sıfırlama olub
      st.cart.forEach(function (c) { if (byId[c.product.id]) c.product = byId[c.product.id]; });
      render();
    });
  }

  function setMsg(text, kind) { if (!st) return; st.msg = text ? { text: text, kind: kind } : null; }
  function focusScan() { if (refs.scan && !document.querySelector('.modal-back')) refs.scan.focus(); }

  /* ---------- Növbə ---------- */
  function renderNoShift(el) {
    return S.lastClosedShift().then(function (prev) {
      var prevCash = prev && prev.countedCash != null ? prev.countedCash : null;
      var input = h('input', { class: 'input mono', id: 'open-cash', value: M.format(prevCash == null ? 0 : prevCash).replace(/\s/g, ''), inputmode: 'decimal' });
      var note = h('input', { class: 'input', id: 'open-note', placeholder: 'məs. say səhv idi, sayım nəticəsi' });
      var noteField = h('div', { class: 'field', hidden: true }, h('label', { for: 'open-note' }, 'Fərqin izahı (əvvəlki növbənin qalığından fərqlidir)'), note);
      function syncNote() { var v = M.parse(input.value); noteField.hidden = prevCash == null || v == null || v === prevCash; }
      input.addEventListener('input', syncNote);
      var btn = h('button', { class: 'btn primary', id: 'open-shift', onclick: function () {
        var v = M.parse(input.value);
        if (v == null) return UI.toast('Məbləğ səhvdir', 'bad');
        if (btn.disabled) return;
        btn.disabled = true; btn.textContent = 'Yoxlanılır…';
        // Açmazdan əvvəl digər cihazın artıq növbə açıb-açmadığına baxılır (iki cihazda iki ayrı növbə yaranmasın)
        root.Sync.pullNow(4000).catch(function () {}).then(function () { return S.openShift(v, note.value); })
          .then(function () { UI.toast('Növbə açıldı'); root.App.refreshStatus(); mount(el); })
          .catch(function (e) {
            UI.toast(e.message, 'bad'); btn.disabled = false; btn.textContent = 'Növbəni aç';
            S.currentShift().then(function (s) { if (s) { root.App.refreshStatus(); mount(el); } });
          });
      } }, 'Növbəni aç');
      el.appendChild(h('div', { class: 'page' },
        h('div', { class: 'card', style: 'max-width:440px;margin:40px auto;padding:24px;display:flex;flex-direction:column;gap:14px' },
          h('h1', { style: 'margin:0' }, 'Növbə bağlıdır'),
          h('p', { class: 'muted', style: 'margin:0' }, prevCash == null
            ? 'Satışa başlamaq üçün kassadakı başlanğıc nağdı sayıb yazın.'
            : 'Əvvəlki növbədən kassada qalan nağd: ' + M.format(prevCash) + ' ₼ (' + UI.fmtDate(prev.closedAt) + '). Növbə bu məbləğlə başlayır; kassanı sayıb fərqli çıxsa dəyişin və izah yazın.'),
          h('div', { class: 'field' }, h('label', { for: 'open-cash' }, 'Başlanğıc nağd, ₼'), input),
          noteField, btn)));
      setTimeout(function () { input.select(); }, 0);
    });
  }

  /* ---------- Render ---------- */
  function render() {
    if (!st || !mountEl || !refs.table) return;
    saveCart();
    var t = totals();

    // Mesaj
    refs.msg.className = 'scan-msg ' + (st.msg ? st.msg.kind : '');
    refs.msg.textContent = st.msg ? st.msg.text : '';

    // Cədvəl
    var tbody = UI.clear(refs.tbody);
    if (!st.cart.length) {
      tbody.appendChild(h('tr', null, h('td', { colspan: '7', class: 'empty' }, 'Barkodu oxudun — məhsul burada görünəcək')));
    }
    st.cart.forEach(function (c, i) {
      var chk = R.negativeStockCheck(c.product, c.qty);
      var tr = h('tr', { class: (i === st.sel ? 'selected ' : '') + (chk.needsNegative ? 'neg' : ''), onclick: function () { st.sel = i; render(); focusScan(); } },
        h('td', { class: 'muted' }, String(i + 1)),
        h('td', null, h('div', null, c.product.name),
          chk.needsNegative ? h('div', { class: 'warn-text', style: 'font-size:13px' }, chk.blocked ? 'Qalıq yoxdur, limit dolub — satılmaz' : 'Qalıq ' + c.product.stock + ' · mənfi qalıqla satış ' + (chk.used + 1) + '/' + R.NEGATIVE_SALE_LIMIT) : null),
        h('td', { class: 'mono muted', style: 'font-size:14px' }, c.product.storeBarcode),
        h('td', { class: 'num' },
          h('div', { style: 'display:inline-flex;align-items:center;gap:8px' },
            h('button', { class: 'qty-btn', 'aria-label': 'Azalt', title: c.qty <= 1 ? 'Sətri silmək üçün zibil ikonu (menecer təsdiqi)' : 'Sayı azalt', disabled: c.qty <= 1, onclick: function (e) { e.stopPropagation(); changeQty(i, -1); } }, '−'),
            h('span', { style: 'min-width:24px;display:inline-block;text-align:center' }, String(c.qty)),
            h('button', { class: 'qty-btn', 'aria-label': 'Artır', onclick: function (e) { e.stopPropagation(); changeQty(i, 1); } }, '+'))),
        h('td', { class: 'num' }, M.format(c.product.price)),
        h('td', { class: 'num', style: 'font-weight:600' }, M.format(c.product.price * c.qty)),
        h('td', { class: 'del' }, trashButton(i, c.product.name, !!pendingDel[c.product.id])));
      tbody.appendChild(tr);
    });

    // Yekunlar
    refs.subtotal.textContent = M.format(t.subtotal);
    refs.discount.textContent = st.discount ? '−' + M.format(t.discount) + ' (' + st.discount.percent + '%)' : '0,00';
    refs.total.textContent = M.format(t.total) + ' ₼';
    refs.count.textContent = t.itemCount ? t.itemCount + ' ədəd' : '';

    // Ödəniş üsulları
    ['cash', 'bank', 'mixed'].forEach(function (m) {
      refs['m_' + m].setAttribute('aria-pressed', String(st.method === m));
      refs['m_' + m].disabled = !st.cart.length;
    });
    refs.discBtn.disabled = !st.cart.length;
    refs.cancelBtn.disabled = !st.cart.length;

    // Ödəniş paneli
    var panel = UI.clear(refs.panel);
    refs.panel.classList.toggle('hidden', !st.method || !st.cart.length);
    if (st.method && st.cart.length) buildPanel(panel, t);
  }

  var TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';
  function trashButton(i, name, pending) {
    var b = h('button', { type: 'button', class: 'icon-btn', disabled: pending, title: pending ? 'Menecer cavabı gözlənilir' : 'Sətri sil (menecer təsdiqi lazımdır)', 'aria-label': 'Sətri sil: ' + name, onclick: function (e) { e.stopPropagation(); deleteLine(i); } });
    b.innerHTML = TRASH;
    return b;
  }

  function buildPanel(panel, t) {
    var title = { cash: 'Nağd ödəniş', bank: 'Bank ödənişi', mixed: 'Qarışıq ödəniş' }[st.method];
    panel.appendChild(h('div', { style: 'font-size:14px;font-weight:600;color:var(--ink-2)' }, title));

    if (st.method !== 'cash') {
      var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Bank növü' });
      [['pos', 'POS kart'], ['transfer', 'Karta köçürmə']].forEach(function (o) {
        seg.appendChild(h('button', { type: 'button', 'aria-pressed': String(st.bankType === o[0]), onclick: function () { st.bankType = o[0]; render(); } }, o[1]));
      });
      panel.appendChild(seg);
    }

    if (st.method === 'mixed') {
      refs.bank = h('input', { class: 'input mono', id: 'pay-bank', inputmode: 'decimal', value: st.bank, style: 'font-size:22px',
        oninput: function (e) { st.bank = e.target.value; updateChange(); } });
      panel.appendChild(h('div', { class: 'field' }, h('label', { for: 'pay-bank' }, 'Bank hissəsi, ₼'), refs.bank));
    }

    if (st.method === 'cash' || st.method === 'mixed') {
      refs.cash = h('input', { class: 'input mono', id: 'pay-cash', inputmode: 'decimal', value: st.cash, style: 'font-size:26px',
        oninput: function (e) { st.cash = e.target.value; updateChange(); } });
      refs.cashDue = st.method === 'mixed' ? h('div', { class: 'muted', style: 'font-size:15px', 'aria-live': 'polite' }) : null;
      panel.appendChild(h('div', { class: 'field' },
        h('label', { for: 'pay-cash' }, st.method === 'mixed' ? 'Müştəridən alınan nağd, ₼ (boş qoysanız — dəqiq nağd hissə)' : 'Müştəridən alınan nağd, ₼'), refs.cash, refs.cashDue));
      var quick = h('div', { class: 'quick' });
      [5, 10, 20, 50, 100].forEach(function (v) {
        quick.appendChild(h('button', { type: 'button', onclick: function () { st.cash = v + ',00'; refs.cash.value = st.cash; updateChange(); refs.confirm.focus(); } }, String(v)));
      });
      panel.appendChild(quick);
      panel.appendChild(h('button', { type: 'button', class: 'btn small', onclick: function () {
        var need = st.method === 'mixed' ? t.total - (M.parse(st.bank) || 0) : t.total;
        st.cash = M.format(Math.max(need, 0)).replace(/\s/g, ''); refs.cash.value = st.cash; updateChange(); refs.confirm.focus();
      } }, 'Dəqiq məbləğ'));
      refs.change = h('div', { class: 'change', 'aria-live': 'polite' });
      panel.appendChild(refs.change);
    } else {
      refs.change = null;
      panel.appendChild(h('p', { class: 'muted', style: 'margin:0' }, 'Terminalda / bank tətbiqində ' + M.format(t.total) + ' ₼ ödənişin keçdiyini yoxlayın, sonra təsdiqləyin.'));
    }

    refs.confirm = h('button', { class: 'btn dark', style: 'padding:16px;font-size:18px', disabled: st.busy, onclick: confirmSale }, st.busy ? 'Yazılır…' : 'Təsdiqlə və çek çap et (Enter)');
    panel.appendChild(refs.confirm);
    updateChange();
  }

  function updateChange() {
    if (!refs.change) return;
    var r = R.validatePayment(paymentInput());
    if (refs.cashDue) {
      var bankV = M.parse(st.bank), tot = totals().total;
      refs.cashDue.textContent = bankV > 0 && bankV < tot ? 'Nağd hissə: ' + M.format(tot - bankV) + ' ₼' : '';
    }
    UI.clear(refs.change);
    if (r.ok) {
      refs.change.className = 'change';
      refs.change.appendChild(h('span', null, 'Qaytarılacaq'));
      refs.change.appendChild(h('b', null, M.format(r.change) + ' ₼'));
    } else {
      refs.change.className = 'change bad';
      refs.change.appendChild(h('span', { style: 'font-size:15px' }, r.error));
    }
  }

  function build(el) {
    refs = {};
    refs.scan = h('input', { class: 'scan', id: 'scan', autocomplete: 'off', inputmode: 'numeric', 'aria-describedby': 'scan-msg' });
    refs.scan.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var v = refs.scan.value; refs.scan.value = '';
        if (v.trim()) onScan(v);
        else if (st.method) confirmSale();
      }
    });
    refs.msg = h('div', { class: 'scan-msg', id: 'scan-msg', role: 'status' });
    refs.tbody = h('tbody');
    refs.table = h('div', { class: 'card table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Məhsul'), h('th', null, 'Mağaza barkodu'), h('th', { class: 'num' }, 'Say'), h('th', { class: 'num' }, 'Qiymət'), h('th', { class: 'num' }, 'Cəm'), h('th', { class: 'del' }, h('span', { class: 'sr-only' }, 'Sil')))),
      refs.tbody));

    refs.subtotal = h('span'); refs.discount = h('span'); refs.total = h('b'); refs.count = h('span', { class: 'muted', style: 'font-size:14px' });
    function mbtn(m, label, key) { refs['m_' + m] = h('button', { type: 'button', 'aria-pressed': 'false', onclick: function () { setMethod(m); } }, label, h('small', null, key)); return refs['m_' + m]; }
    refs.panel = h('div', { class: 'card pay-panel hidden' });
    refs.discBtn = h('button', { class: 'btn', onclick: requestDiscount }, 'Endirim (F4)');
    refs.cancelBtn = h('button', { class: 'btn danger', onclick: cancelSale }, 'Ləğv (Esc)');

    el.appendChild(h('div', { class: 'pos' },
      h('section', { class: 'pos-main', 'aria-label': 'Çek' },
        h('div', { class: 'field' }, h('label', { for: 'scan' }, 'Mağaza barkodu'), refs.scan),
        refs.msg, refs.table,
        h('div', { class: 'muted', style: 'font-size:14px' }, '↑/↓ sətir seçimi · + / − say · Del və ya zibil ikonu: sətri silmək (menecer təsdiqi: PIN və ya sorğu).')),
      h('aside', { class: 'pos-side', 'aria-label': 'Ödəniş' },
        h('div', { class: 'card totals' },
          h('div', { class: 'line' }, h('span', null, 'Ara cəm'), refs.subtotal),
          h('div', { class: 'line muted' }, h('span', null, 'Endirim'), refs.discount),
          h('div', { class: 'grand' }, h('span', null, h('span', { style: 'font-size:18px;font-weight:600' }, 'Yekun '), refs.count), refs.total)),
        h('div', { class: 'pay-methods' }, mbtn('cash', 'Nağd', 'F1'), mbtn('bank', 'Bank', 'F2'), mbtn('mixed', 'Qarışıq', 'F3')),
        refs.panel,
        h('div', { class: 'actions' }, refs.discBtn, refs.cancelBtn))));
  }

  /* ---------- Klaviatura ---------- */
  var burst = { buf: '', last: 0 };
  function onKey(e) {
    if (!st || !mountEl || !document.body.contains(mountEl) || document.querySelector('.modal-back')) return;
    var tgt = e.target;
    var inOther = tgt && tgt !== refs.scan && /INPUT|TEXTAREA/.test(tgt.tagName);

    // Skaner başqa sahəyə yazanda (məs. nağd sahəsi) sürətli rəqəm axınını tutub barkod kimi işləyirik
    var t = performance.now();
    if (inOther && /^\d$/.test(e.key)) {
      burst.buf = (t - burst.last < 35) ? burst.buf + e.key : e.key;
      burst.last = t;
    } else if (inOther && e.key === 'Enter' && burst.buf.length >= 8 && t - burst.last < 60) {
      e.preventDefault();
      var code = burst.buf; burst.buf = '';
      tgt.value = tgt.value.slice(0, Math.max(0, tgt.value.length - code.length));
      tgt.dispatchEvent(new Event('input'));
      onScan(code);
      return;
    }

    if (e.key === 'F1') { e.preventDefault(); setMethod('cash'); }
    else if (e.key === 'F2') { e.preventDefault(); setMethod('bank'); }
    else if (e.key === 'F3') { e.preventDefault(); setMethod('mixed'); }
    else if (e.key === 'F4') { e.preventDefault(); requestDiscount(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelSale(); }
    else if (e.key === 'Enter' && inOther && st.method) { e.preventDefault(); confirmSale(); }
    else if (!inOther) {
      if (e.key === 'ArrowDown' && st.cart.length) { e.preventDefault(); st.sel = Math.min(st.sel + 1, st.cart.length - 1); render(); }
      else if (e.key === 'ArrowUp' && st.cart.length) { e.preventDefault(); st.sel = Math.max(st.sel - 1, 0); render(); }
      else if ((e.key === '+' || e.key === 'Add') && st.sel >= 0) { e.preventDefault(); changeQty(st.sel, 1); }
      else if ((e.key === '-' || e.key === 'Subtract') && st.sel >= 0) { e.preventDefault(); changeQty(st.sel, -1); }
      else if (e.key === 'Delete' && st.sel >= 0) { e.preventDefault(); deleteLine(st.sel); }
    }
  }
  document.addEventListener('keydown', onKey);

  function mount(el) {
    mountEl = el; UI.clear(el); refs = {};
    var first = !st;
    if (!st) st = fresh();
    return S.currentShift().then(function (shift) {
      if (!shift) return renderNoShift(el);
      return (first ? loadCart() : Promise.resolve()).then(function () { build(el); render(); focusScan(); });
    });
  }

  // Başqa cihazdan qalıq dəyişəndə açıq çekdəki məhsulları yeniləyir (səbət toxunulmaz qalır)
  function refresh() { return st && mountEl && refs.table ? refreshProducts() : Promise.resolve(); }

  root.POS = { mount: mount, refresh: refresh, reset: reset, _state: function () { return st; } };
})(window);
