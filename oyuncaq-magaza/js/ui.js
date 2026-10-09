/* Kiçik UI köməkçiləri: element yaratma, bildiriş, modal, PIN təsdiqi, çap. */
(function (root) {
  'use strict';

  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function toast(msg, kind) {
    var host = document.querySelector('.toast-host');
    if (!host) { host = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(host); }
    var t = h('div', { class: 'toast ' + (kind || '') }, msg);
    host.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'bad' ? 6000 : 3500);
  }

  // Sadə səs siqnalı (barkod tapılmadıqda və s.)
  var ctx;
  function beep(ok) {
    try {
      ctx = ctx || new (root.AudioContext || root.webkitAudioContext)();
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = ok ? 1200 : 300; g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.06 : 0.25));
    } catch (_) { /* səs olmasa da davam */ }
  }

  // modal({title, body: Node, buttons: [{text, kind, onClick(close) -> Promise|any}], wide})
  function modal(opts) {
    var prevFocus = document.activeElement;
    var back = h('div', { class: 'modal-back' });
    var box = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title });
    function close() { back.remove(); document.removeEventListener('keydown', onKey, true); if (prevFocus && prevFocus.focus) prevFocus.focus(); if (opts.onClose) opts.onClose(); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } }
    var foot = h('div', { class: 'foot' });
    (opts.buttons || [{ text: 'Bağla' }]).forEach(function (b) {
      var btn = h('button', { class: 'btn ' + (b.kind || ''), type: b.submit ? 'submit' : 'button' }, b.text);
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!b.onClick) return close();
        btn.disabled = true;
        Promise.resolve().then(function () { return b.onClick(close); })
          .catch(function (err) { toast(err.message || String(err), 'bad'); })
          .then(function () { btn.disabled = false; });
      });
      foot.appendChild(btn);
    });
    var form = h('form', { style: 'display:flex;flex-direction:column;gap:14px' }, h('h2', null, opts.title), opts.body, foot);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var primary = foot.querySelector('button[type=submit]') || foot.lastChild;
      primary.click();
    });
    box.appendChild(form);
    back.appendChild(box);
    back.addEventListener('mousedown', function (e) { if (e.target === back && !opts.sticky) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    setTimeout(function () { var f = box.querySelector('input,select,textarea,button'); if (f) f.focus(); }, 0);
    return { close: close, el: box };
  }

  // Menecer PIN-i ilə təsdiq. Uğurlu olarsa təsdiqləyən istifadəçini qaytarır.
  function approve(title, detail, perm) {
    return new Promise(function (resolve) {
      var input = h('input', { class: 'input mono', type: 'password', inputmode: 'numeric', autocomplete: 'off', id: 'appr-pin', maxlength: '8' });
      var body = h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
        h('p', { style: 'margin:0' }, detail),
        h('div', { class: 'field' }, h('label', { for: 'appr-pin' }, 'Menecer PIN-i'), input),
        h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, 'İnternet varsa, menecer telefondakı tətbiqdən də təsdiqləyə bilər (növbəti mərhələ).'));
      var done = false;
      modal({
        title: title, body: body, sticky: true,
        onClose: function () { if (!done) resolve(null); },
        buttons: [
          { text: 'İmtina' },
          { text: 'Təsdiqlə', kind: 'primary', submit: true, onClick: function (close) {
            return root.Services.approveWithPin(input.value, perm).then(function (u) { done = true; close(); resolve(u); })
              .catch(function (e) { input.value = ''; input.focus(); throw e; });
          } }
        ]
      });
    });
  }

  function printHtml(html) {
    var area = document.getElementById('print-area');
    if (!area) { area = h('div', { id: 'print-area' }); document.body.appendChild(area); }
    area.innerHTML = html;
    setTimeout(function () { root.print(); }, 50);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function fmtDate(iso) {
    return new Intl.DateTimeFormat('az-AZ', { timeZone: 'Asia/Baku', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  }

  var BANK_TYPE = { pos: 'POS kart', transfer: 'Karta köçürmə' };
  var METHOD = { cash: 'Nağd', bank: 'Bank', mixed: 'Qarışıq' };

  function receiptHtml(sale, store, opts) {
    var M = root.Money;
    var rows = sale.lines.map(function (l) {
      return '<div>' + esc(l.name) + '</div><div class="r"><span>' + l.qty + ' × ' + M.format(l.price) + '</span><span>' + M.format(l.price * l.qty) + '</span></div>';
    }).join('');
    var p = sale.payment;
    var pay = '<div class="r"><span>Ödəniş</span><span>' + METHOD[p.method] + (p.bankType ? ' (' + BANK_TYPE[p.bankType] + ')' : '') + '</span></div>';
    if (p.bankPart) pay += '<div class="r"><span>Bank</span><span>' + M.format(p.bankPart) + '</span></div>';
    if (p.cashPart) pay += '<div class="r"><span>Nağd alınan</span><span>' + M.format(p.cashReceived) + '</span></div><div class="r"><span>Qaytarılan</span><span>' + M.format(p.change) + '</span></div>';
    return '<div class="receipt">' +
      (opts && opts.duplicate ? '<div class="c"><b>DUBLİKAT</b></div>' : '') +
      '<h3>' + esc(store.name) + '</h3><div class="c">VÖEN ' + esc(store.voen) + '</div><div class="c">' + esc(store.address) + '</div><hr>' +
      '<div class="r"><span>Çek №</span><span>' + String(sale.receiptNo).padStart(6, '0') + '</span></div>' +
      '<div class="r"><span>Tarix</span><span>' + fmtDate(sale.at) + '</span></div>' +
      '<div class="r"><span>Kassir</span><span>' + esc(sale.cashierName) + '</span></div><hr>' + rows + '<hr>' +
      '<div class="r"><span>Ara cəm</span><span>' + M.format(sale.totals.subtotal) + '</span></div>' +
      (sale.totals.discount ? '<div class="r"><span>Endirim ' + sale.discount.percent + '%</span><span>−' + M.format(sale.totals.discount) + '</span></div>' : '') +
      '<div class="r" style="font-size:14px;font-weight:700"><span>YEKUN</span><span>' + M.format(sale.totals.total) + ' AZN</span></div>' + pay + '<hr>' +
      '<div class="bc">' + root.Barcode.svg(sale.receiptBarcode, { module: 2, height: 40 }) + '</div>' +
      '<div class="c">Qaytarma ' + root.Rules.RETURN_DAYS + ' gün ərzində, çeklə</div>' +
      '<div class="c">Bu çek fiskal çek deyil</div></div>';
  }

  function returnReceiptHtml(ret, sale, store) {
    var M = root.Money;
    var rows = ret.lines.map(function (l) { return '<div>' + esc(l.name) + '</div><div class="r"><span>' + l.qty + ' × ' + M.format(l.price) + '</span><span>' + M.format(l.price * l.qty) + '</span></div>'; }).join('');
    return '<div class="receipt"><h3>' + esc(store.name) + '</h3><div class="c"><b>QAYTARMA ÇEKİ</b></div><hr>' +
      '<div class="r"><span>İlkin çek №</span><span>' + String(sale.receiptNo).padStart(6, '0') + '</span></div>' +
      '<div class="r"><span>Tarix</span><span>' + fmtDate(ret.at) + '</span></div>' +
      '<div class="r"><span>Təsdiqləyən</span><span>' + esc(ret.approvedByName) + '</span></div><hr>' + rows + '<hr>' +
      '<div class="r" style="font-weight:700"><span>Qaytarılan</span><span>' + M.format(ret.amount) + ' AZN</span></div>' +
      (ret.cashAmount ? '<div class="r"><span>Nağd</span><span>' + M.format(ret.cashAmount) + '</span></div>' : '') +
      (ret.bankAmount ? '<div class="r"><span>' + BANK_TYPE[ret.bankType] + '</span><span>' + M.format(ret.bankAmount) + '</span></div>' : '') + '</div>';
  }

  function labelsHtml(items) {
    // items: [{product, count}]
    var M = root.Money;
    var out = '<div class="labels">';
    items.forEach(function (it) {
      for (var i = 0; i < it.count; i++) {
        out += '<div class="label"><div class="n">' + esc(it.product.name) + '</div><div class="p">' + M.format(it.product.price) + ' ₼</div>' +
          root.Barcode.svg(it.product.storeBarcode, { module: 2, height: 44 }) + '</div>';
      }
    });
    return out + '</div>';
  }

  root.UI = { h: h, clear: clear, toast: toast, beep: beep, modal: modal, approve: approve, printHtml: printHtml, esc: esc, fmtDate: fmtDate,
    receiptHtml: receiptHtml, returnReceiptHtml: returnReceiptHtml, labelsHtml: labelsHtml, BANK_TYPE: BANK_TYPE, METHOD: METHOD };
})(window);
