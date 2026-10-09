/* Kassa ekranı (variant A). Klaviatura: Enter = barkod/təsdiq, F1 Nağd, F2 Bank, F3 Qarışıq, F4 Endirim,
   ↑/↓ sətir seçimi, + / − say, Del sətri sil, Esc çeki ləğv et. */
(function (root) {
  'use strict';
  var UI = root.UI, S = root.Services, M = root.Money, R = root.Rules;
  var h = UI.h;

  var DELETE_LIMIT = 1000; // 10,00 ₼ və yuxarı sətrin silinməsi menecer PIN-i tələb edir (SEC-04)

  var st = null;
  function fresh() {
    return { cart: [], sel: -1, method: null, bankType: 'pos', cash: '', bank: '', discount: null, msg: null, busy: false };
  }

  var refs = {};
  var mountEl = null;

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
      setMsg('"' + p.name + '" qalığı yoxdur və limit (' + R.NEGATIVE_SALE_LIMIT + ' mənfi çek) dolub. Satmaq olmaz — mal qəbulu lazımdır.', 'bad');
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
      if (r.kind === 'product') return addProduct(r.product);
      UI.beep(false);
      if (r.kind === 'mfr') setMsg('Bu istehsalçı barkodudur. Məhsulun üzərindəki mağaza barkodunu oxudun (' + r.products.map(function (p) { return p.name; }).join(', ') + ').', 'bad');
      else if (r.kind === 'receipt') setMsg('Bu çek barkodudur. Qaytarma üçün "Qaytarma" bölməsinə keçin.', 'warn');
      else if (r.kind === 'inactive') setMsg('"' + r.product.name + '" satışdan çıxarılıb.', 'bad');
      else setMsg('Barkod tapılmadı: ' + code, 'bad');
      render();
    });
  }

  function changeQty(i, delta) {
    var line = st.cart[i]; if (!line) return;
    if (delta > 0) { line.qty += delta; st.sel = i; render(); return; }
    removeQty(i, -delta);
  }

  function removeQty(i, n) {
    var line = st.cart[i]; if (!line) return;
    n = Math.min(n, line.qty);
    var value = line.product.price * n;
    var go = value >= DELETE_LIMIT
      ? UI.approve('Sətir silinməsi', line.product.name + ' — ' + n + ' ədəd (' + M.format(value) + ' ₼) çekdən çıxarılır.', 'pos.line.delete')
      : Promise.resolve({ id: null, name: '—' });
    go.then(function (approver) {
      if (!approver) return focusScan();
      S.auditEvent('pos.line_removed', { productId: line.product.id, name: line.product.name, qty: n, value: value, approvedBy: approver.id });
      line.qty -= n;
      if (line.qty <= 0) { st.cart.splice(i, 1); st.sel = Math.min(i, st.cart.length - 1); }
      resetPaymentIfEmpty();
      render(); focusScan();
    });
  }

  function resetPaymentIfEmpty() { if (!st.cart.length) { st.method = null; st.discount = null; st.cash = ''; st.bank = ''; } }

  function cancelSale() {
    if (!st.cart.length) return;
    var value = totals().subtotal;
    UI.approve('Çeki ləğv et', 'Bütün çek (' + M.format(value) + ' ₼) ləğv olunur.', 'pos.line.delete').then(function (a) {
      if (!a) return focusScan();
      S.auditEvent('pos.sale_cancelled', { lines: st.cart.map(function (c) { return { productId: c.product.id, qty: c.qty }; }), value: value, approvedBy: a.id });
      st = fresh(); render(); focusScan();
    });
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
          return UI.approve('Endirimi təsdiqlə', pct + '% endirim: ' + M.format(t.subtotal) + ' → ' + M.format(t.total) + ' ₼', 'pos.discount.approve').then(function (a) {
            S.auditEvent(a ? 'pos.discount_approved' : 'pos.discount_rejected', { percent: pct, subtotal: t.subtotal, approvedBy: a ? a.id : null });
            if (a) { st.discount = { percent: pct, approvedBy: a }; setMsg(pct + '% endirim təsdiqləndi (' + a.name + ')', ''); }
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
        UI.printHtml(UI.receiptHtml(sale, store));
        var last = { receiptNo: sale.receiptNo, change: sale.payment.change, total: sale.totals.total };
        st = fresh();
        st.last = last;
        setMsg('Çek № ' + sale.receiptNo + ' tamamlandı' + (last.change ? ' · qaytarılacaq ' + M.format(last.change) + ' ₼' : ''), '');
        root.App && root.App.refreshStatus();
      });
    }).catch(function (e) {
      setMsg(e.message, 'bad'); UI.beep(false);
      if (e.code === 'negative_blocked') refreshProducts();
    }).then(function () { st.busy = false; render(); focusScan(); });
  }

  // Satışdan sonra qalıqlar dəyişir; səbətdəki məhsul obyektlərini yeniləyirik
  function refreshProducts() {
    return S.listProducts().then(function (ps) {
      var byId = {}; ps.forEach(function (p) { byId[p.id] = p; });
      st.cart.forEach(function (c) { if (byId[c.product.id]) c.product = byId[c.product.id]; });
      render();
    });
  }

  function setMsg(text, kind) { st.msg = text ? { text: text, kind: kind } : null; }
  function focusScan() { if (refs.scan && !document.querySelector('.modal-back')) refs.scan.focus(); }

  /* ---------- Növbə ---------- */
  function renderNoShift(el) {
    var input = h('input', { class: 'input mono', id: 'open-cash', value: '0,00', inputmode: 'decimal' });
    el.appendChild(h('div', { class: 'page' },
      h('div', { class: 'card', style: 'max-width:440px;margin:40px auto;padding:24px;display:flex;flex-direction:column;gap:14px' },
        h('h1', { style: 'margin:0' }, 'Növbə bağlıdır'),
        h('p', { class: 'muted', style: 'margin:0' }, 'Satışa başlamaq üçün kassadakı başlanğıc nağdı sayıb yazın.'),
        h('div', { class: 'field' }, h('label', { for: 'open-cash' }, 'Başlanğıc nağd, ₼'), input),
        h('button', { class: 'btn primary', onclick: function () {
          var v = M.parse(input.value);
          if (v == null) return UI.toast('Məbləğ səhvdir', 'bad');
          S.openShift(v).then(function () { UI.toast('Növbə açıldı'); root.App.refreshStatus(); mount(el); }).catch(function (e) { UI.toast(e.message, 'bad'); });
        } }, 'Növbəni aç'))));
    setTimeout(function () { input.select(); }, 0);
  }

  /* ---------- Render ---------- */
  function render() {
    if (!mountEl || !refs.table) return;
    var t = totals();

    // Mesaj
    refs.msg.className = 'scan-msg ' + (st.msg ? st.msg.kind : '');
    refs.msg.textContent = st.msg ? st.msg.text : '';

    // Cədvəl
    var tbody = UI.clear(refs.tbody);
    if (!st.cart.length) {
      tbody.appendChild(h('tr', null, h('td', { colspan: '6', class: 'empty' }, 'Barkodu oxudun — məhsul burada görünəcək')));
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
            h('button', { class: 'qty-btn', 'aria-label': 'Azalt', onclick: function (e) { e.stopPropagation(); changeQty(i, -1); } }, '−'),
            h('span', { style: 'min-width:24px;display:inline-block;text-align:center' }, String(c.qty)),
            h('button', { class: 'qty-btn', 'aria-label': 'Artır', onclick: function (e) { e.stopPropagation(); changeQty(i, 1); } }, '+'))),
        h('td', { class: 'num' }, M.format(c.product.price)),
        h('td', { class: 'num', style: 'font-weight:600' }, M.format(c.product.price * c.qty)));
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
      panel.appendChild(h('div', { class: 'field' }, h('label', { for: 'pay-cash' }, 'Müştəridən alınan nağd, ₼'), refs.cash));
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
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Məhsul'), h('th', null, 'Mağaza barkodu'), h('th', { class: 'num' }, 'Say'), h('th', { class: 'num' }, 'Qiymət'), h('th', { class: 'num' }, 'Cəm'))),
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
        h('div', { class: 'muted', style: 'font-size:14px' }, '↑/↓ sətir seçimi · + / − say · Del sətri sil. 10 ₼ və yuxarı silinmə menecer PIN-i ilə.')),
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
    if (!mountEl || !document.body.contains(mountEl) || document.querySelector('.modal-back')) return;
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
      else if (e.key === 'Delete' && st.sel >= 0) { e.preventDefault(); removeQty(st.sel, st.cart[st.sel].qty); }
    }
  }
  document.addEventListener('keydown', onKey);

  function mount(el) {
    mountEl = el; UI.clear(el); refs = {};
    if (!st) st = fresh();
    return S.currentShift().then(function (shift) {
      if (!shift) return renderNoShift(el);
      build(el); render(); focusScan();
    });
  }

  root.POS = { mount: mount, _state: function () { return st; } };
})(window);
