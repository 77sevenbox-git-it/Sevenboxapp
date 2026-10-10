/* Kiçik UI köməkçiləri: element yaratma, bildiriş, modal, PIN təsdiqi, çap. */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;

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
    var t = h('div', { class: 'toast ' + (kind || ''), role: kind === 'bad' ? 'alert' : null }, msg);
    host.appendChild(t);
    while (host.children.length > 3) host.removeChild(host.firstChild);      // köhnələr yığılıb ekranı örtməsin
    // Xəta mesajı yuxarıda göstərilir (ekran klaviaturası aşağını örtür); xətalar uzun qalır
    setTimeout(function () { t.remove(); }, kind === 'bad' ? 7000 : 3500);
  }

  // Təsdiq sorğusunun mətni: summary həmişə Azərbaycanca saxlanılır (köhnə cihazlar üçün), tk/tp isə şablon və dəyərlərdir ki,
  // menecer sorğunu öz interfeys dilində görsün (kassir rusca, menecer azərbaycanca işləyə bilər).
  function req(kind, key, params) { return { kind: kind, summary: _t(key, params, 'az'), tk: key, tp: params }; }
  function reqText(a) { return a && a.tk ? _t(a.tk, a.tp) : (a && a.summary) || ''; }

  // Dil seçimi (cihaza aiddir). Dəyişəndə səhifə yenilənir: giriş (sessionStorage) və yarımçıq çek saxlanılır.
  function langSwitch() {
    var I = root.I18n; if (!I) return null;
    var sel = h('select', { class: 'input lang-sel', id: 'lang-sel', 'aria-label': 'Language / Язык / Dil / Dil', title: 'Language / Язык / Dil' },
      I.langs.map(function (l) { return h('option', { value: l.code, selected: l.code === I.lang(), title: l.name }, l.abbr || l.name); }));
    sel.addEventListener('change', function () { if (I.setLang(sel.value)) root.location.reload(); });
    return sel;
  }

  // Gözləyən təsdiq sorğuları üçün daimi zolaq (pəncərə bağlansa da görünür). Qaytarır: {remove}
  function pendingBanner(text, onCancel) {
    var host = document.querySelector('.pending-host');
    if (!host) { host = h('div', { class: 'pending-host', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(host); }
    var cancel = onCancel ? h('button', { class: 'btn small', type: 'button', onclick: function () { onCancel(); } }, _t('Ləğv et')) : null;
    var el = h('div', { class: 'pending' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', { class: 'grow' }, text), cancel);
    host.appendChild(el);
    return { remove: function () { el.remove(); } };
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
    var errBox = h('div', { class: 'modal-err', role: 'alert', hidden: true });
    (opts.buttons || [{ text: _t('Bağla') }]).forEach(function (b) {
      var btn = h('button', { class: 'btn ' + (b.kind || ''), type: b.submit ? 'submit' : 'button' }, b.text);
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!b.onClick) return close();
        btn.disabled = true; errBox.hidden = true;
        Promise.resolve().then(function () { return b.onClick(close); })
          .catch(function (err) {
            // Xəta pəncərənin İÇİNDƏ (düymələrin yanında) göstərilir: klaviatura toast-u örtsə də görünsün
            errBox.textContent = err.message || String(err); errBox.hidden = false;
            toast(err.message || String(err), 'bad');
          })
          .then(function () { if (!btn.hasAttribute('data-locked')) btn.disabled = false; });
      });
      foot.appendChild(btn);
    });
    var form = h('form', { style: 'display:flex;flex-direction:column;gap:14px' }, h('h2', null, opts.title), opts.body, errBox, foot);
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

  // Gözləyən sorğular: çıxışda (istifadəçi dəyişəndə) hamısı ləğv olunur ki, başqasının ekranında əməliyyat tətbiq olunmasın
  var pendingHandles = [];
  function abortPending() { pendingHandles.slice().forEach(function (hd) { hd.abort(); }); }

  // Menecer təsdiqi: PIN ilə dərhal, və ya (server qoşulubsa) menecerin cihazına sorğu göndərməklə.
  // req = {kind, summary} verilərsə "sorğu göndər" düyməsi çıxır. Uğurlu olarsa təsdiqləyən istifadəçini qaytarır, imtina olarsa null.
  // Sorğu göndəriləndə pəncərə BAĞLANIR, yuxarıda "gözlənilir" zolağı qalır; cavab gələndə qaytarılan söz yerinə yetir (çağıran əməliyyatı davam etdirir).
  function approve(title, detail, perm, req) {
    var S = root.Services, Sync = root.Sync;
    var cfg = req && Sync ? Sync.endpoint() : Promise.resolve('');
    // Təsdiq edə bilən şəxslərdən kimsə şifrə formasındadırsa sahə həm PIN, həm şifrə qəbul edir (rəqəm klaviaturası və 8 simvol limiti olmadan)
    var formP = S.approverForm ? S.approverForm(perm).catch(function () { return 'pin'; }) : Promise.resolve('pin');
    return Promise.all([cfg, formP]).then(function (cf) {
      var url = cf[0], any = cf[1] === 'any';
      return new Promise(function (resolve) {
        var canRequest = !!(req && url);
        var input = h('input', { class: 'input mono', type: 'password', inputmode: any ? 'text' : 'numeric', autocomplete: 'off', id: 'appr-pin', maxlength: any ? null : '8' });
        var status = h('p', { class: 'muted', style: 'margin:0;font-size:13px', role: 'status', id: 'appr-status' },
          any ? (canRequest ? _t('Menecerin PIN-ini və ya şifrəsini yazın, ya da sorğu göndərin: menecer öz cihazında təsdiqləyəcək.') : _t('Menecerin PIN-ini və ya şifrəsini yazın.'))
            : canRequest ? _t('Menecer PIN-ini yazın və ya sorğu göndərin: menecer öz cihazında təsdiqləyəcək.') : _t('Menecer PIN-ini yazın.'));
        var body = h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
          h('p', { style: 'margin:0' }, detail),
          h('div', { class: 'field' }, h('label', { for: 'appr-pin' }, any ? _t('Menecer PIN-i və ya şifrəsi') : _t('Menecer PIN-i')), input), status);
        var done = false, detached = false, pendingId = null, poll = null, banner = null, m = null;
        var handle = { abort: function () { if (pendingId && !done) S.cancelApproval(pendingId); end(null, null); } };

        function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }
        function end(user, msg, kind) {
          if (done) return; done = true; stopPoll();
          var at = pendingHandles.indexOf(handle); if (at !== -1) pendingHandles.splice(at, 1);
          if (banner) { banner.remove(); banner = null; }
          if (!detached && m) m.close();
          if (msg) toast(msg, kind === undefined ? 'bad' : kind);
          resolve(user);
        }

        function startPoll() {
          Sync.fast(300000);
          poll = setInterval(function () {
            S.checkApproval(pendingId).then(function (c) {
              if (done) return;
              if (c.state === 'approved') end(c.approver, _t('Menecer təsdiqlədi'), '');
              else if (c.state === 'rejected') end(null, _t('Menecer sorğunu rədd etdi'), 'bad');
              else if (c.state === 'cancelled') end(null, null);
              else if (c.state !== 'pending') end(null, _t('Sorğunun vaxtı bitdi'), 'bad');
            }).catch(function () { /* şəbəkə xətası: növbəti yoxlamada təkrar */ });
          }, 1000);
        }

        var buttons = [{ text: _t('İmtina') }];
        if (canRequest) {
          buttons.push({ text: _t('Menecerə sorğu göndər'), onClick: function () {
            if (pendingId) return;
            if (root.navigator && root.navigator.onLine === false) throw new Error(_t('Sorğu üçün internet lazımdır. Menecer PIN-i ilə təsdiqləyin'));
            return S.requestApproval(req.kind, perm, req.summary, req.tk, req.tp).then(function (rec) {
              pendingId = rec.id;
              detached = true; pendingHandles.push(handle);
              m.close();                                   // pəncərə getsin, yerinə "göndərildi" mesajı və gözləmə zolağı
              banner = pendingBanner(_t('Sorğu menecerə göndərildi, cavab gözlənilir: {0}', [reqText(req)]), function () {
                S.cancelApproval(pendingId); end(null, _t('Sorğu ləğv edildi'), '');
              });
              toast(_t('Sorğu menecerə göndərildi'), '');
              startPoll();
            });
          } });
        }
        buttons.push({ text: _t('Təsdiqlə'), kind: 'primary', submit: true, onClick: function (close) {
          return S.approveWithPin(input.value, perm).then(function (u) {
            done = true; stopPoll();
            if (pendingId) S.cancelApproval(pendingId);
            close(); resolve(u);
          }).catch(function (e) { input.value = ''; input.focus(); throw e; });
        } });

        m = modal({
          title: title, body: body, sticky: true, buttons: buttons,
          onClose: function () {
            if (done || detached) return;
            stopPoll();
            resolve(null); done = true;
          }
        });
      });
    });
  }

  // Çap (js/print.js): kind = 'receipt' (termo çek) | 'label' (etiket). Kağız ölçüsü və printer ayarları cihaza məxsusdur.
  function printHtml(html, kind) { return root.Print.print(html, kind || 'receipt'); }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function locale(lang) { return root.I18n ? root.I18n.locale(lang) : 'az-AZ'; }
  function fmtDate(iso, lang) {
    return new Intl.DateTimeFormat(locale(lang), { timeZone: 'Asia/Baku', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  }
  function fmtTime(iso, lang) {
    return new Intl.DateTimeFormat(locale(lang), { timeZone: 'Asia/Baku', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  }

  var BANK_TYPE = { pos: _t('POS kart'), transfer: _t('Karta köçürmə') };
  var METHOD = { cash: _t('Nağd'), bank: _t('Bank'), mixed: _t('Qarışıq') };

  function receiptHtml(sale, store, opts) { return root.Print.receiptHtml(sale, store, opts); }
  function returnReceiptHtml(ret, sale, store) { return root.Print.returnReceiptHtml(ret, sale, store); }
  function labelsHtml(items, opts) { return root.Print.labelsHtml(items, opts); }
  function receiptWrap(inner) { return root.Print.wrap(inner); }

  root.UI = { h: h, clear: clear, toast: toast, pendingBanner: pendingBanner, abortPending: abortPending, beep: beep, modal: modal, approve: approve, printHtml: printHtml, esc: esc, fmtDate: fmtDate, fmtTime: fmtTime, req: req, reqText: reqText, langSwitch: langSwitch,
    receiptHtml: receiptHtml, returnReceiptHtml: returnReceiptHtml, labelsHtml: labelsHtml, receiptWrap: receiptWrap, BANK_TYPE: BANK_TYPE, METHOD: METHOD };
})(window);
