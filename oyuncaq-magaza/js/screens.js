/* Digər ekranlar: giriş, məhsullar, qaytarma, növbə, çeklər, admin. */
(function (root) {
  'use strict';
  var UI = root.UI, S = root.Services, M = root.Money, R = root.Rules;
  var h = UI.h;

  function can(perm) { var u = S.currentUser(); return !!(u && root.App.matrix && R.can(root.App.matrix, u.role, perm)); }

  /* ================= Giriş ================= */
  function login(el, onDone) {
    UI.clear(el);
    var chosen = null;
    var pin = h('input', { class: 'input mono', type: 'password', inputmode: 'numeric', id: 'pin', maxlength: '8', autocomplete: 'off', style: 'font-size:22px' });
    var list = h('div', { class: 'users', role: 'group', 'aria-label': 'İstifadəçi' });
    var foot = h('div', { class: 'muted', style: 'font-size:13px' });
    var form = h('form', { class: 'card' },
      h('div', null, h('div', { class: 'muted', style: 'font-size:14px' }, 'Mağaza idarəetmə sistemi'), h('h1', { style: 'margin:4px 0 0;font-size:24px' }, 'Daxil olun')),
      list,
      h('div', { class: 'field' }, h('label', { for: 'pin' }, 'PIN'), pin),
      h('button', { class: 'btn primary', type: 'submit' }, 'Daxil ol'),
      foot);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!chosen) return UI.toast('İstifadəçini seçin', 'bad');
      S.login(chosen, pin.value).then(function (u) { pin.value = ''; onDone(u); }).catch(function (err) { pin.value = ''; pin.focus(); UI.toast(err.message, 'bad'); });
    });
    S.listUsers().then(function (users) {
      users.forEach(function (u) {
        var b = h('button', { type: 'button', 'aria-pressed': 'false', onclick: function () {
          chosen = u.id; Array.prototype.forEach.call(list.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); }); pin.focus();
        } }, u.name, h('small', null, R.ROLE_NAMES[u.role]));
        list.appendChild(b);
      });
    });
    // Yeni cihaz: serverə qoşulub istifadəçiləri və məlumatı yükləmək. Qoşulubsa, dəyişmək yalnız Admin üçün (İcazələr bölməsi).
    root.Sync.endpoint().then(function (url) {
      if (url) { foot.textContent = 'Server qoşulub · istifadəçilər və məlumat avtomatik yenilənir'; return; }
      foot.appendChild(h('button', { type: 'button', class: 'btn small', id: 'connect-btn', onclick: function () { connectForm(function () { login(el, onDone); }); } }, 'Bu cihazı serverə qoş'));
      foot.appendChild(h('div', { style: 'margin-top:6px' }, 'Başqa cihazda artıq işləyirsinizsə, bunu edin: istifadəçilər, məhsullar və çeklər oradan yüklənəcək.'));
    });
    el.appendChild(h('div', { class: 'login' }, form));
  }

  function connectForm(done) {
    var url = h('input', { class: 'input', id: 'c-url', placeholder: 'https://script.google.com/macros/s/…/exec', autocomplete: 'off' });
    var tok = h('input', { class: 'input', id: 'c-tok', type: 'password', autocomplete: 'off' });
    var msg = h('p', { class: 'muted', style: 'margin:0;font-size:13px', role: 'status' }, 'Ünvanı və açarı (SYNC_TOKEN) yazın. Məlumat serverdən yüklənəcək, bir neçə saniyə çəkə bilər.');
    UI.modal({
      title: 'Bu cihazı serverə qoş',
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'field' }, h('label', { for: 'c-url' }, 'Apps Script veb tətbiq ünvanı'), url),
        h('div', { class: 'field' }, h('label', { for: 'c-tok' }, 'Sinxron açarı'), tok), msg),
      buttons: [{ text: 'İmtina' }, { text: 'Qoş və yüklə', kind: 'primary', submit: true, onClick: function (close) {
        msg.textContent = 'Yoxlanılır və yüklənir…';
        return root.Sync.connect(url.value, tok.value).then(function (r) {
          UI.toast('Qoşuldu · ' + r.received + ' qeyd yükləndi');
          close(); done();
        }).catch(function (e) { msg.textContent = e.message; throw e; });
      } }]
    });
  }

  // İlk giriş: yeni PIN. Tam səhifədir, arxa fonda heç bir iş ekranı yoxdur. true = PIN dəyişdi, false = çıxış.
  function forcePinChange(el) {
    return new Promise(function (resolve) {
      UI.clear(el);
      var o = h('input', { class: 'input mono', type: 'password', id: 'op', inputmode: 'numeric', maxlength: '8', autocomplete: 'off' });
      var n1 = h('input', { class: 'input mono', type: 'password', id: 'np1', inputmode: 'numeric', maxlength: '8', autocomplete: 'off' });
      var n2 = h('input', { class: 'input mono', type: 'password', id: 'np2', inputmode: 'numeric', maxlength: '8', autocomplete: 'off' });
      var form = h('form', { class: 'card' },
        h('div', null, h('div', { class: 'muted', style: 'font-size:14px' }, S.currentUser().name), h('h1', { style: 'margin:4px 0 0;font-size:24px' }, 'Yeni PIN təyin edin')),
        h('p', { class: 'muted', style: 'margin:0' }, 'İşə başlamazdan əvvəl yalnız sizə məlum olan 4–8 rəqəmli PIN seçin.'),
        h('div', { class: 'field' }, h('label', { for: 'op' }, 'Hazırkı PIN'), o),
        h('div', { class: 'field' }, h('label', { for: 'np1' }, 'Yeni PIN'), n1),
        h('div', { class: 'field' }, h('label', { for: 'np2' }, 'Yeni PIN təkrar'), n2),
        h('button', { class: 'btn primary', type: 'submit' }, 'Saxla və davam et'),
        h('button', { class: 'btn', type: 'button', id: 'pin-logout', onclick: function () { S.logout(); resolve(false); } }, 'Çıxış'));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (n1.value !== n2.value) return UI.toast('Yeni PIN-lər eyni deyil', 'bad');
        S.changePin(o.value, n1.value).then(function () { UI.toast('PIN dəyişdirildi'); resolve(true); })
          .catch(function (err) { UI.toast(err.message, 'bad'); });
      });
      el.appendChild(h('div', { class: 'login' }, form));
      o.focus();
    });
  }

  /* ================= Təsdiq sorğuları (menecer tərəfi) ================= */
  // Bu istifadəçinin təsdiqləyə biləcəyi gözləyən sorğular
  function pendingForMe() {
    var u = S.currentUser();
    if (!u) return Promise.resolve([]);
    return S.listPendingApprovals().then(function (items) {
      return items.filter(function (a) { return a.requestedBy.id !== u.id && can(a.perm); });
    });
  }

  function approvalsModal(onChange) {
    var list = h('div', { class: 'req-list' });
    UI.modal({ title: 'Təsdiq sorğuları', body: list, buttons: [{ text: 'Bağla' }] });
    function load() {
      return pendingForMe().then(function (items) {
        UI.clear(list);
        if (!items.length) list.appendChild(h('p', { class: 'muted', style: 'margin:0' }, 'Gözləyən sorğu yoxdur.'));
        items.forEach(function (a) {
          function decide(d) {
            return S.decideApproval(a.id, d).then(function () { UI.toast(d === 'approved' ? 'Təsdiqləndi' : 'Rədd edildi'); if (onChange) onChange(); return load(); })
              .catch(function (e) { UI.toast(e.message, 'bad'); return load(); });
          }
          list.appendChild(h('div', { class: 'req-item' },
            h('div', null, h('b', null, a.summary)),
            h('div', { class: 'muted', style: 'font-size:13px' }, a.requestedBy.name + ' · ' + UI.fmtDate(a.at)),
            h('div', { class: 'row', style: 'justify-content:flex-end' },
              h('button', { class: 'btn danger small', type: 'button', onclick: function () { decide('rejected'); } }, 'Rədd et'),
              h('button', { class: 'btn primary small', type: 'button', onclick: function () { decide('approved'); } }, 'Təsdiqlə'))));
        });
      });
    }
    load();
  }

  /* ================= Məhsullar ================= */
  function products(el) {
    UI.clear(el);
    var showCost = can('product.cost.view');
    var q = h('input', { class: 'input', id: 'pq', type: 'search', placeholder: 'Ad, mağaza və ya istehsalçı barkodu', style: 'min-width:280px' });
    var body = h('tbody');
    var all = [];

    function draw() {
      var s = q.value.trim().toLowerCase();
      UI.clear(body);
      var list = all.filter(function (p) { return !s || p.name.toLowerCase().indexOf(s) !== -1 || p.storeBarcode.indexOf(s) !== -1 || (p.mfrBarcode || '').indexOf(s) !== -1; });
      if (!list.length) body.appendChild(h('tr', null, h('td', { colspan: showCost ? '8' : '7', class: 'empty' }, all.length ? 'Uyğun məhsul yoxdur' : 'Hələ məhsul yoxdur')));
      list.forEach(function (p) {
        var low = p.stock <= (p.minStock || 0);
        body.appendChild(h('tr', null,
          h('td', null, h('div', null, p.name), h('div', { class: 'muted', style: 'font-size:13px' }, [p.category, p.ageGroup].filter(Boolean).join(' · '))),
          h('td', { class: 'mono', style: 'font-size:14px' }, p.storeBarcode),
          h('td', { class: 'mono muted', style: 'font-size:14px' }, p.mfrBarcode || '—'),
          h('td', { class: 'num' }, M.format(p.price)),
          showCost ? h('td', { class: 'num muted' }, M.format(p.avgCost)) : null,
          h('td', { class: 'num' }, p.stock < 0 ? h('span', { class: 'warn-text' }, String(p.stock)) : low ? h('span', { class: 'badge' }, String(p.stock)) : String(p.stock)),
          h('td', null, p.active ? h('span', { class: 'badge ok' }, 'Aktiv') : h('span', { class: 'badge off' }, 'Passiv')),
          h('td', { style: 'white-space:nowrap' },
            can('product.edit') ? h('button', { class: 'btn small', onclick: function () { productForm(p, load); } }, 'Dəyiş') : null, ' ',
            can('product.edit') ? h('button', { class: 'btn small', onclick: function () { receiveForm(p, load); } }, 'Qəbul') : null, ' ',
            can('label.print') ? h('button', { class: 'btn small', onclick: function () { labelForm(p); } }, 'Etiket') : null)));
      });
    }
    function load() {
      return S.listProducts().then(function (ps) { all = ps.map(function (p) { return S.sanitizeForRole(p, showCost); }); draw(); });
    }
    root.Screens._refresh = load;     // başqa cihazdan dəyişiklik gələndə siyahı yenilənir
    q.addEventListener('input', draw);

    el.appendChild(h('div', { class: 'page' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:16px' },
        h('h1', { style: 'margin:0' }, 'Məhsullar'),
        h('div', { class: 'row' },
          h('label', { class: 'sr-only', for: 'pq' }, 'Axtarış'), q,
          can('product.edit') ? h('button', { class: 'btn primary', onclick: function () { productForm(null, load); } }, 'Yeni məhsul') : null)),
      h('div', { class: 'card table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Məhsul'), h('th', null, 'Mağaza barkodu'), h('th', null, 'İstehsalçı barkodu'), h('th', { class: 'num' }, 'Satış ₼'),
          showCost ? h('th', { class: 'num' }, 'Orta maya ₼') : null, h('th', { class: 'num' }, 'Qalıq'), h('th', null, 'Status'), h('th', null, ''))),
        body)),
      can('product.edit') ? h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn small', onclick: function () {
        S.seedDemoProducts().then(function () { UI.toast('Nümunə məhsullar əlavə olundu'); load(); }).catch(function (e) { UI.toast(e.message, 'bad'); });
      } }, 'Sınaq üçün nümunə məhsullar əlavə et')) : null));
    load().then(function () { q.focus(); });
  }

  function productForm(p, onSaved) {
    var isNew = !p;
    var canPrice = can('product.price.set');
    function inp(id, label, val, attrs) {
      var i = h('input', Object.assign({ class: 'input', id: id, value: val == null ? '' : val }, attrs || {}));
      return { el: h('div', { class: 'field' }, h('label', { for: id }, label), i), input: i };
    }
    var f = {
      name: inp('f-name', 'Ad *', p && p.name, { required: true }),
      category: inp('f-cat', 'Kateqoriya', p && p.category, { list: 'cats' }),
      brand: inp('f-brand', 'Brend', p && p.brand),
      age: inp('f-age', 'Yaş qrupu', p && p.ageGroup, { placeholder: 'məs. 3+' }),
      mfr: inp('f-mfr', 'İstehsalçı barkodu (nəzarət üçün)', p && p.mfrBarcode, { class: 'input mono', inputmode: 'numeric' }),
      price: inp('f-price', 'Satış qiyməti, ₼ *', p ? M.format(p.price).replace(/\s/g, '') : '', { class: 'input mono', inputmode: 'decimal', disabled: !canPrice }),
      cost: isNew && can('product.cost.view') ? inp('f-cost', 'Alış qiyməti, ₼', '', { class: 'input mono', inputmode: 'decimal' }) : null,
      min: inp('f-min', 'Minimum qalıq', p ? p.minStock : 0, { type: 'number', min: '0' })
    };
    var active = h('input', { type: 'checkbox', id: 'f-active', checked: !p || p.active });
    var body = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'grid2' }, f.name.el, f.category.el, f.brand.el, f.age.el, f.mfr.el, f.price.el, f.cost && f.cost.el, f.min.el),
      !canPrice ? h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, 'Satış qiymətini yalnız Menecer və Admin təyin edir.') : null,
      p ? h('p', { class: 'muted', style: 'margin:0' }, 'Mağaza barkodu: ', h('span', { class: 'mono' }, p.storeBarcode), ' (dəyişmir)') : h('p', { class: 'muted', style: 'margin:0' }, 'Mağaza barkodu yadda saxlayanda avtomatik veriləcək.'),
      p ? h('label', { style: 'display:flex;gap:8px;align-items:center' }, active, 'Satışda aktivdir') : null);

    UI.modal({
      title: isNew ? 'Yeni məhsul' : 'Məhsulu dəyiş', wide: true, body: body,
      buttons: [{ text: 'İmtina' }, { text: 'Yadda saxla', kind: 'primary', submit: true, onClick: function (close) {
        var price = M.parse(f.price.input.value);
        if (price == null) throw new Error('Satış qiyməti səhvdir');
        var data = { name: f.name.input.value, category: f.category.input.value.trim(), brand: f.brand.input.value.trim(), ageGroup: f.age.input.value.trim(),
          mfrBarcode: f.mfr.input.value.trim(), price: price, minStock: parseInt(f.min.input.value, 10) || 0 };
        if (f.cost) { var c = M.parse(f.cost.input.value || '0'); if (c == null) throw new Error('Alış qiyməti səhvdir'); data.cost = c; }
        if (p) data.active = active.checked;
        var op = isNew ? S.createProduct(data) : S.updateProduct(p.id, data);
        return op.then(function (r) {
          r.warnings.forEach(function (w) { UI.toast(w, 'warn'); });
          UI.toast(isNew ? 'Məhsul yaradıldı · ' + r.product.storeBarcode : 'Yadda saxlanıldı');
          close(); onSaved();
          if (isNew) labelForm(r.product);
        });
      } }]
    });
  }

  function receiveForm(p, onSaved) {
    var qty = h('input', { class: 'input', id: 'r-qty', type: 'number', min: '1', value: '1' });
    var cost = h('input', { class: 'input mono', id: 'r-cost', inputmode: 'decimal', value: p.lastCost != null ? M.format(p.lastCost).replace(/\s/g, '') : '' });
    var note = h('input', { class: 'input', id: 'r-note', placeholder: 'Təchizatçı, qaimə №' });
    UI.modal({
      title: 'Mal qəbulu — ' + p.name,
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('p', { class: 'muted', style: 'margin:0' }, 'Hazırkı qalıq: ' + p.stock + '. Tam qəbul sənədi və təchizatçı borcu növbəti mərhələdədir.'),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { for: 'r-qty' }, 'Say'), qty),
          can('product.cost.view') ? h('div', { class: 'field' }, h('label', { for: 'r-cost' }, 'Alış qiyməti (ədəd), ₼'), cost) : null),
        h('div', { class: 'field' }, h('label', { for: 'r-note' }, 'Qeyd'), note)),
      buttons: [{ text: 'İmtina' }, { text: 'Qəbul et', kind: 'primary', submit: true, onClick: function (close) {
        var c = can('product.cost.view') ? M.parse(cost.value) : p.lastCost;
        if (c == null) throw new Error('Alış qiyməti səhvdir');
        var n = parseInt(qty.value, 10);
        return S.receiveStock(p.id, n, c, note.value).then(function (np) {
          UI.toast('Qalıq: ' + np.stock); close(); onSaved();
          labelForm(np, n);
        });
      } }]
    });
  }

  function labelForm(p, count) {
    var n = h('input', { class: 'input', id: 'l-n', type: 'number', min: '1', max: '500', value: String(count || 1) });
    var preview = h('div', { style: 'display:flex;justify-content:center;padding:8px;background:var(--ground);border-radius:8px' });
    preview.innerHTML = UI.labelsHtml([{ product: p, count: 1 }]);
    UI.modal({
      title: 'Etiket çapı',
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, preview, h('div', { class: 'field' }, h('label', { for: 'l-n' }, 'Etiket sayı'), n)),
      buttons: [{ text: 'Bağla' }, { text: 'Çap et', kind: 'primary', submit: true, onClick: function (close) {
        var c = Math.min(500, Math.max(1, parseInt(n.value, 10) || 1));
        UI.printHtml(UI.labelsHtml([{ product: p, count: c }])); close();
      } }]
    });
  }

  /* ================= Qaytarma ================= */
  function returns(el) {
    UI.clear(el);
    var scan = h('input', { class: 'scan', id: 'rscan', inputmode: 'numeric', autocomplete: 'off' });
    var out = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });

    function show(sale) {
      UI.clear(out);
      if (!sale) { out.appendChild(h('div', { class: 'card empty' }, 'Çek tapılmadı')); UI.beep(false); return; }
      var win = R.returnWindow(sale.at, new Date().toISOString());
      return S.returnedQtyBySale(sale.id).then(function (prev) {
        var head = h('div', { class: 'card', style: 'padding:16px 20px;display:flex;flex-wrap:wrap;gap:20px;justify-content:space-between' },
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, 'Çek №'), h('b', { class: 'mono' }, String(sale.receiptNo).padStart(6, '0'))),
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, 'Tarix'), UI.fmtDate(sale.at)),
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, 'Ödəniş'), UI.METHOD[sale.payment.method] + (sale.payment.bankType ? ' · ' + UI.BANK_TYPE[sale.payment.bankType] : '')),
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, 'Yekun'), M.format(sale.totals.total) + ' ₼' + (sale.discount ? ' (' + sale.discount.percent + '% endirim)' : '')),
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, 'Keçən gün'), String(win.daysPassed)));
        out.appendChild(head);
        if (win.expired) {
          UI.beep(false);
          out.appendChild(h('div', { class: 'card', role: 'alert', style: 'padding:18px 20px;background:var(--bad-soft);color:var(--bad);font-weight:600;border-color:#E2B4B4' },
            'Çekin qaytarma müddəti bitib: ' + win.daysPassed + ' gün keçib (limit ' + R.RETURN_DAYS + ' gün).'));
          return;
        }
        var inputs = [];
        var tb = h('tbody');
        sale.lines.forEach(function (l, i) {
          var max = R.returnableQty(l.qty, prev.map[i]);
          var inp = h('input', { class: 'input', type: 'number', min: '0', max: String(max), value: '0', style: 'width:90px', disabled: !max, 'aria-label': 'Qaytarılan say: ' + l.name });
          inputs.push(inp);
          tb.appendChild(h('tr', null, h('td', null, l.name), h('td', { class: 'num' }, String(l.qty)), h('td', { class: 'num muted' }, String(prev.map[i] || 0)),
            h('td', { class: 'num' }, M.format(l.price)), h('td', { class: 'num' }, inp)));
        });
        var reason = h('input', { class: 'input', id: 'rreason', placeholder: 'məs. zədəli, uyğun gəlmədi' });
        out.appendChild(h('div', { class: 'card table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Məhsul'), h('th', { class: 'num' }, 'Satılıb'), h('th', { class: 'num' }, 'Qaytarılıb'), h('th', { class: 'num' }, 'Qiymət'), h('th', { class: 'num' }, 'Qaytarılır'))), tb)));
        out.appendChild(h('div', { class: 'row' },
          h('div', { class: 'field', style: 'flex:1 1 280px' }, h('label', { for: 'rreason' }, 'Səbəb'), reason),
          h('button', { class: 'btn primary', onclick: function () {
            var items = inputs.map(function (inp, i) { return { lineIndex: i, qty: parseInt(inp.value, 10) || 0 }; }).filter(function (x) { return x.qty > 0; });
            if (!items.length) return UI.toast('Qaytarılacaq say yazın', 'bad');
            var amount = R.refundAmount(items.map(function (it) { return { price: sale.lines[it.lineIndex].price, qty: it.qty }; }), sale.discount ? sale.discount.percent : 0);
            var rsum = 'Çek № ' + sale.receiptNo + ' üzrə ' + M.format(amount) + ' ₼ qaytarılır.';
            UI.approve('Qaytarmanı təsdiqlə', rsum, 'pos.return.approve', { kind: 'return', summary: (S.currentUser() ? S.currentUser().name : '') + ' qaytarma istəyir. ' + rsum }).then(function (a) {
              if (!a) return;
              return S.createReturn(sale.id, items, a, reason.value).then(function (ret) {
                return S.storeInfo().then(function (store) {
                  UI.printHtml(UI.returnReceiptHtml(ret, sale, store));
                  UI.toast('Qaytarıldı: ' + M.format(ret.amount) + ' ₼' + (ret.cashAmount ? ' (nağd ' + M.format(ret.cashAmount) + ')' : ''));
                  root.App.refreshStatus();
                  return S.findSaleByCode(String(sale.receiptNo)).then(show);
                });
              });
            }).catch(function (e) { UI.toast(e.message, 'bad'); });
          } }, 'Qaytar')));
      });
    }

    scan.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var v = scan.value; scan.value = '';
      S.findSaleByCode(v).then(show);
    });

    S.requirePerm('pos.return.request').then(function () {
      el.appendChild(h('div', { class: 'page', style: 'max-width:1000px' },
        h('h1', null, 'Qaytarma'),
        h('div', { class: 'field', style: 'margin-bottom:16px' }, h('label', { for: 'rscan' }, 'Çekin barkodunu oxudun və ya çek nömrəsini yazın'), scan),
        out));
      scan.focus();
    }).catch(function (e) { el.appendChild(h('div', { class: 'page' }, h('div', { class: 'card empty' }, e.message))); });
  }

  /* ================= Növbə ================= */
  function shift(el) {
    UI.clear(el);
    S.currentShift().then(function (sh) {
      if (!sh) { el.appendChild(h('div', { class: 'page' }, h('div', { class: 'card empty' }, 'Açıq növbə yoxdur. Kassa ekranından açın.'))); return; }
      return S.shiftReport(sh).then(function (rep) {
        function line(label, v, strong) { return h('div', { style: 'display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line-2)' + (strong ? ';font-weight:700' : '') }, h('span', null, label), h('span', { class: 'mono' }, v)); }
        var counted = h('input', { class: 'input mono', id: 'counted', inputmode: 'decimal', style: 'font-size:22px' });
        var note = h('input', { class: 'input', id: 'cnote' });
        el.appendChild(h('div', { class: 'page', style: 'max-width:900px' },
          h('h1', null, 'Növbə'),
          h('div', { class: 'grid2', style: 'align-items:start' },
            h('div', { class: 'card', style: 'padding:18px 20px' },
              h('div', { class: 'muted', style: 'font-size:14px;margin-bottom:8px' }, 'Açılıb: ' + UI.fmtDate(sh.openedAt) + ' · ' + sh.openedByName),
              line('Çek sayı', String(rep.count)), line('Satış (endirimdən əvvəl)', M.format(rep.gross)), line('Endirim', M.format(rep.discount)),
              line('Nağd satış', M.format(rep.cash)), line('POS kart', M.format(rep.pos)), line('Karta köçürmə', M.format(rep.transfer)),
              line('Qaytarmalar', M.format(rep.returns)), line('Kassaya mədaxil', M.format(rep.cashIn)), line('Kassadan məxaric', M.format(rep.cashOut)),
              line('Başlanğıc nağd', M.format(sh.openingCash)), line('Kassada olmalı nağd', M.format(rep.expectedCash), true)),
            h('div', { class: 'card', style: 'padding:18px 20px;display:flex;flex-direction:column;gap:12px' },
              h('b', null, 'Növbəni bağla'),
              h('div', { class: 'field' }, h('label', { for: 'counted' }, 'Sayılmış nağd, ₼'), counted),
              h('div', { class: 'field' }, h('label', { for: 'cnote' }, 'Fərq varsa izah'), note),
              h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, 'Bank cəmlərini (POS və köçürmə) gün sonu bank çıxarışı ilə tutuşdurun.'),
              h('button', { class: 'btn dark', onclick: function () {
                var v = M.parse(counted.value);
                if (v == null) return UI.toast('Sayılmış məbləği yazın', 'bad');
                S.closeShift(v, note.value.trim()).then(function (closed) {
                  UI.toast('Növbə bağlandı. Fərq: ' + M.format(closed.diff));
                  printZ(closed); root.App.refreshStatus(); shift(el);
                }).catch(function (e) { UI.toast(e.message, 'bad'); });
              } }, 'Bağla və Z hesabatı çap et'),
              h('div', { class: 'row' },
                h('button', { class: 'btn small', onclick: function () { cashMoveForm('in', function () { shift(el); }); } }, 'Kassaya mədaxil'),
                h('button', { class: 'btn small', onclick: function () { cashMoveForm('out', function () { shift(el); }); } }, 'Kassadan məxaric'))))));
      });
    });
  }

  function cashMoveForm(type, done) {
    var amt = h('input', { class: 'input mono', id: 'cm-a', inputmode: 'decimal' });
    var reason = h('input', { class: 'input', id: 'cm-r' });
    UI.modal({
      title: type === 'in' ? 'Kassaya mədaxil' : 'Kassadan məxaric',
      body: h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'cm-a' }, 'Məbləğ, ₼'), amt), h('div', { class: 'field' }, h('label', { for: 'cm-r' }, 'Səbəb'), reason)),
      buttons: [{ text: 'İmtina' }, { text: 'Yadda saxla', kind: 'primary', submit: true, onClick: function (close) {
        var v = M.parse(amt.value); if (v == null) throw new Error('Məbləğ səhvdir');
        var go = type === 'out' ? (close(), UI.approve('Məxarici təsdiqlə', M.format(v) + ' ₼ kassadan çıxarılır: ' + reason.value, 'pos.return.approve',
          { kind: 'cash_out', summary: (S.currentUser() ? S.currentUser().name : '') + ' kassadan məxaric istəyir: ' + M.format(v) + ' ₼ (' + reason.value + ')' })) : Promise.resolve(null);
        return go.then(function (a) {
          if (type === 'out' && !a) return;
          return S.cashMove(type, v, reason.value.trim(), a).then(function () { UI.toast('Qeydə alındı'); if (type === 'in') close(); done(); });
        });
      } }]
    });
  }

  function printZ(s) {
    var r = s.report;
    S.storeInfo().then(function (store) {
      function row(a, b) { return '<div class="r"><span>' + a + '</span><span>' + b + '</span></div>'; }
      UI.printHtml('<div class="receipt"><h3>' + UI.esc(store.name) + '</h3><div class="c"><b>Z HESABATI</b></div><hr>' +
        row('Açılış', UI.fmtDate(s.openedAt)) + row('Bağlanış', UI.fmtDate(s.closedAt)) + '<hr>' +
        row('Çek sayı', r.count) + row('Satış', M.format(r.gross)) + row('Endirim', M.format(r.discount)) + row('Nağd', M.format(r.cash)) +
        row('POS kart', M.format(r.pos)) + row('Köçürmə', M.format(r.transfer)) + row('Qaytarma', M.format(r.returns)) + '<hr>' +
        row('Gözlənilən nağd', M.format(s.expectedCash)) + row('Sayılmış nağd', M.format(s.countedCash)) + row('Fərq', M.format(s.diff)) +
        (s.note ? '<div>İzah: ' + UI.esc(s.note) + '</div>' : '') + '</div>');
    });
  }

  /* ================= Çeklər ================= */
  function sales(el) {
    UI.clear(el);
    var tb = h('tbody');
    el.appendChild(h('div', { class: 'page' }, h('h1', null, 'Çeklər'), h('div', { class: 'card table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, '№'), h('th', null, 'Tarix'), h('th', null, 'Kassir'), h('th', null, 'Ödəniş'), h('th', { class: 'num' }, 'Yekun ₼'), h('th', null, ''), h('th', null, ''))), tb))));
    function loadList() { return S.recentSales(100).then(function (list) { UI.clear(tb); fill(list); }); }
    root.Screens._refresh = loadList;
    loadList();
    function fill(list) {
      if (!list.length) tb.appendChild(h('tr', null, h('td', { colspan: '7', class: 'empty' }, 'Hələ satış yoxdur')));
      list.forEach(function (s) {
        tb.appendChild(h('tr', null, h('td', { class: 'mono' }, String(s.receiptNo).padStart(6, '0')), h('td', null, UI.fmtDate(s.at)), h('td', null, s.cashierName),
          h('td', null, UI.METHOD[s.payment.method] + (s.payment.bankType ? ' · ' + UI.BANK_TYPE[s.payment.bankType] : '')),
          h('td', { class: 'num' }, M.format(s.totals.total)),
          h('td', null, s.offline ? h('span', { class: 'badge' }, 'Oflayn') : null),
          h('td', null, h('button', { class: 'btn small', onclick: function () {
            UI.approve('Dublikat çek', 'Çek № ' + s.receiptNo + ' "DUBLİKAT" qeydi ilə çap olunur.', 'pos.return.approve').then(function (a) {
              if (!a) return;
              S.auditEvent('receipt.duplicate', { saleId: s.id, approvedBy: a.id });
              S.storeInfo().then(function (store) { UI.printHtml(UI.receiptHtml(s, store, { duplicate: true })); });
            });
          } }, 'Dublikat'))));
      });
    }
  }

  /* ================= Admin ================= */
  function admin(el) {
    UI.clear(el);
    S.requirePerm('admin.permissions').then(function () {
      return Promise.all([S.getMatrix(), S.storeInfo()]);
    }).then(function (r) {
      var m = JSON.parse(JSON.stringify(r[0]));
      var roles = Object.keys(R.ROLE_NAMES);
      var tb = h('tbody');
      Object.keys(R.PERMISSIONS).forEach(function (perm) {
        tb.appendChild(h('tr', null, h('td', null, R.PERMISSIONS[perm]), roles.map(function (role) {
          var locked = role === 'admin' && perm === 'admin.permissions';
          var cb = h('input', { type: 'checkbox', checked: (m[role] || []).indexOf(perm) !== -1, disabled: locked, 'aria-label': R.ROLE_NAMES[role] + ': ' + R.PERMISSIONS[perm] });
          cb.addEventListener('change', function () {
            m[role] = m[role] || [];
            if (cb.checked) m[role].push(perm); else m[role] = m[role].filter(function (x) { return x !== perm; });
          });
          return h('td', { style: 'text-align:center' }, cb);
        })));
      });
      el.appendChild(h('div', { class: 'page', style: 'max-width:1000px' },
        h('h1', null, 'Rollar və icazələr'),
        h('p', { class: 'muted' }, 'Hansı rolun hansı əməliyyata icazəsi olduğunu yalnız Admin dəyişir. Hər dəyişiklik audit jurnalına yazılır.'),
        h('div', { class: 'card table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'İcazə'), roles.map(function (role) { return h('th', { style: 'text-align:center' }, R.ROLE_NAMES[role]); }))), tb)),
        h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn primary', onclick: function () {
          S.setMatrix(m).then(function () { root.App.matrix = m; UI.toast('İcazələr yadda saxlanıldı'); root.App.renderNav(); }).catch(function (e) { UI.toast(e.message, 'bad'); });
        } }, 'Yadda saxla')),
        can('admin.users') ? usersCard() : null,
        settingsCard(r[1])));
    }).catch(function (e) { el.appendChild(h('div', { class: 'page' }, h('div', { class: 'card empty' }, e.message))); });
  }

  function settingsCard(store) {
    function f(id, label, val, attrs) { var i = h('input', Object.assign({ class: 'input', id: id, value: val || '' }, attrs || {})); return { i: i, el: h('div', { class: 'field' }, h('label', { for: id }, label), i) }; }
    var name = f('s-name', 'Mağaza adı', store.name), voen = f('s-voen', 'VÖEN', store.voen), addr = f('s-addr', 'Ünvan', store.address), reg = f('s-reg', 'Kassa adı', store.registerName);
    var url = f('s-url', 'Apps Script veb tətbiq ünvanı', '', { placeholder: 'https://script.google.com/macros/s/…/exec' });
    var tok = f('s-tok', 'Sinxron açarı (SYNC_TOKEN)', '', { type: 'password', autocomplete: 'off', placeholder: 'Dəyişmək üçün yazın' });
    var info = h('div', { class: 'muted', style: 'font-size:13px', id: 's-info', role: 'status' });
    var conflicts = h('ul', { class: 'conflicts' });
    root.Sync.endpoint().then(function (u) { url.i.value = u; });
    root.DB.get('meta', 'syncToken').then(function (t) { if (t && t.value) tok.i.placeholder = 'Saxlanılıb · dəyişmək üçün yazın'; });

    function refreshInfo() {
      return Promise.all([root.Sync.endpoint(), S.outboxCount(), S.listConflicts()]).then(function (r) {
        var st = root.Sync.status();
        UI.clear(info);
        info.appendChild(document.createTextNode('Cihaz: ' + String(S.deviceId() || '').slice(-8) + ' · ' + (r[0] ? 'server qoşulub' : 'server qoşulmayıb (yalnız bu cihaz)') +
          (r[1] ? ' · göndərilməmiş: ' + r[1] : '') + (st.lastOk ? ' · son sinxron: ' + UI.fmtDate(st.lastOk).split(', ').pop() : '')));
        if (st.error) info.appendChild(h('div', { class: 'sync-err', style: 'color:var(--bad)' }, 'Son xəta: ' + st.error));
        UI.clear(conflicts);
        r[2].slice(-5).forEach(function (c) { conflicts.appendChild(h('li', null, c.message)); });
      });
    }
    refreshInfo();

    function report(r) {
      UI.toast(r.error ? 'Sinxron alınmadı: ' + r.error : r.skipped ? 'Ünvan yoxdur və ya oflayn' : r.sent + ' qeyd göndərildi, ' + r.received + ' qeyd alındı', r.error ? 'bad' : '');
      root.App.refreshStatus(); return refreshInfo();
    }

    return h('div', { class: 'card', style: 'margin-top:24px;padding:20px;display:flex;flex-direction:column;gap:14px' },
      h('h2', { style: 'margin:0;font-size:18px' }, 'Mağaza və server'),
      h('div', { class: 'grid2' }, name.el, voen.el, addr.el, reg.el, url.el, tok.el),
      h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, 'Ünvan boşdursa, sistem yalnız bu kompyuterdə işləyir. Hər yeni brauzer/cihaz bir dəfə qoşulmalıdır (giriş ekranında "Bu cihazı serverə qoş").'),
      info, conflicts,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: function () {
          var u = url.i.value.trim();
          var bad = u && root.Sync.checkUrl(u);
          if (bad) return UI.toast(bad, 'bad');
          S.setStoreInfo({ name: name.i.value.trim(), voen: voen.i.value.trim(), address: addr.i.value.trim(), registerName: reg.i.value.trim() })
            .then(function () { return root.Sync.setEndpoint(u, tok.i.value); })
            .then(function () { tok.i.value = ''; UI.toast('Yadda saxlanıldı'); return root.Sync.cycle(); })
            .then(report)
            .catch(function (e) { UI.toast(e.message, 'bad'); });
        } }, 'Yadda saxla'),
        h('button', { class: 'btn', onclick: function () {
          root.Sync.test().then(function (msg) { UI.toast(msg); }).catch(function (e) { UI.toast(e.message, 'bad'); });
        } }, 'Bağlantını yoxla'),
        h('button', { class: 'btn', onclick: function () { root.Sync.cycle().then(report); } }, 'İndi sinxronlaşdır')));
  }

  // Admin: istifadəçilər və PIN-in sıfırlanması (unudulmuş PIN üçün)
  function usersCard() {
    var tb = h('tbody');
    function load() {
      return S.listAllUsers().then(function (users) {
        UI.clear(tb);
        users.forEach(function (u) {
          tb.appendChild(h('tr', null, h('td', null, u.name), h('td', null, R.ROLE_NAMES[u.role]),
            h('td', null, u.mustChangePin ? h('span', { class: 'badge' }, 'PIN dəyişməlidir') : h('span', { class: 'badge ok' }, 'Aktiv')),
            h('td', { style: 'text-align:right' }, h('button', { class: 'btn small', type: 'button', onclick: function () { resetPin(u); } }, 'PIN-i sıfırla'))));
        });
      });
    }
    function resetPin(u) {
      UI.modal({
        title: 'PIN-i sıfırla — ' + u.name,
        body: h('p', { style: 'margin:0' }, 'Müvəqqəti PIN yaradılacaq. İstifadəçi ilk girişdə özünün yeni PIN-ini seçəcək. Köhnə PIN dərhal etibarsız olur.'),
        buttons: [{ text: 'İmtina' }, { text: 'Sıfırla', kind: 'danger', submit: true, onClick: function (close) {
          return S.resetPin(u.id).then(function (temp) {
            close();
            UI.modal({ title: 'Müvəqqəti PIN', body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
              h('div', { class: 'pin-reset' }, temp), h('p', { class: 'muted', style: 'margin:0' }, u.name + ' üçün bir dəfə göstərilir. İndi ötürün.')) });
            load();
          });
        } }]
      });
    }
    load();
    return h('div', { class: 'card table-wrap', style: 'margin-top:24px' },
      h('div', { style: 'padding:16px 20px 0' }, h('h2', { style: 'margin:0;font-size:18px' }, 'İstifadəçilər')),
      h('table', null, h('thead', null, h('tr', null, h('th', null, 'Ad'), h('th', null, 'Rol'), h('th', null, 'Vəziyyət'), h('th', null, ''))), tb));
  }

  root.Screens = { login: login, forcePinChange: forcePinChange, products: products, returns: returns, shift: shift, sales: sales, admin: admin,
    pendingForMe: pendingForMe, approvalsModal: approvalsModal, _refresh: null };
})(window);
