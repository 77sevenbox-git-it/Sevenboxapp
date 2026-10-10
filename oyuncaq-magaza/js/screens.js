/* Digər ekranlar: giriş, məhsullar, qaytarma, növbə, çeklər, admin. */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var UI = root.UI, S = root.Services, M = root.Money, R = root.Rules;
  var h = UI.h;

  function can(perm) { var u = S.currentUser(); return !!(u && root.App.matrix && R.can(root.App.matrix, u.role, perm)); }

  /* ================= Giriş ================= */
  function login(el, onDone) {
    UI.clear(el);
    var chosen = null;
    var pin = h('input', { class: 'input mono', type: 'password', inputmode: 'numeric', id: 'pin', maxlength: '8', autocomplete: 'off', style: 'font-size:22px' });
    var list = h('div', { class: 'users', role: 'group', 'aria-label': _t('İstifadəçi') });
    var foot = h('div', { class: 'muted', style: 'font-size:13px' });
    var submitBtn = h('button', { class: 'btn primary', type: 'submit' }, _t('Daxil ol'));
    var form = h('form', { class: 'card' },
      h('div', { class: 'lang-row' }, UI.langSwitch()),
      h('div', null, h('div', { class: 'muted', style: 'font-size:14px' }, _t('Mağaza idarəetmə sistemi')), h('h1', { style: 'margin:4px 0 0;font-size:24px' }, _t('Daxil olun'))),
      list,
      h('div', { class: 'field' }, h('label', { for: 'pin' }, _t('PIN')), pin),
      submitBtn,
      foot);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!chosen) return UI.toast(_t('İstifadəçini seçin'), 'bad');
      // Səhv PIN-də PIN-in başqa cihazda dəyişib-dəyişmədiyi serverdən yoxlanılır (2–3 san): bu müddətdə düymə "Yoxlanılır…" göstərir
      submitBtn.disabled = true; submitBtn.textContent = _t('Yoxlanılır…');
      function ready() { submitBtn.disabled = false; submitBtn.textContent = _t('Daxil ol'); }
      S.login(chosen, pin.value).then(function (u) { pin.value = ''; ready(); onDone(u); }).catch(function (err) { ready(); pin.value = ''; pin.focus(); UI.toast(err.message, 'bad'); });
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
      if (url) { foot.textContent = _t('Server qoşulub · istifadəçilər və məlumat avtomatik yenilənir'); return; }
      foot.appendChild(h('button', { type: 'button', class: 'btn small', id: 'connect-btn', onclick: function () { connectForm(function () { login(el, onDone); }); } }, _t('Bu cihazı serverə qoş')));
      foot.appendChild(h('div', { style: 'margin-top:6px' }, _t('Başqa cihazda artıq işləyirsinizsə, bunu edin: istifadəçilər, məhsullar və çeklər oradan yüklənəcək.')));
    });
    el.appendChild(h('div', { class: 'login' }, form));
  }

  function connectForm(done) {
    var url = h('input', { class: 'input', id: 'c-url', placeholder: 'https://script.google.com/macros/s/…/exec', autocomplete: 'off' });
    var tok = h('input', { class: 'input', id: 'c-tok', type: 'password', autocomplete: 'off' });
    var msg = h('p', { class: 'muted', style: 'margin:0;font-size:13px', role: 'status' }, _t('Ünvanı və açarı (SYNC_TOKEN) yazın. Məlumat serverdən yüklənəcək, bir neçə saniyə çəkə bilər.'));
    UI.modal({
      title: _t('Bu cihazı serverə qoş'),
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'field' }, h('label', { for: 'c-url' }, _t('Apps Script veb tətbiq ünvanı')), url),
        h('div', { class: 'field' }, h('label', { for: 'c-tok' }, _t('Sinxron açarı')), tok), msg),
      buttons: [{ text: _t('İmtina') }, { text: _t('Qoş və yüklə'), kind: 'primary', submit: true, onClick: function (close) {
        msg.textContent = _t('Yoxlanılır və yüklənir…');
        return root.Sync.connect(url.value, tok.value).then(function (r) {
          UI.toast(_t('Qoşuldu · {0} qeyd yükləndi', [r.received]));
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
        h('div', null, h('div', { class: 'muted', style: 'font-size:14px' }, S.currentUser().name), h('h1', { style: 'margin:4px 0 0;font-size:24px' }, _t('Yeni PIN təyin edin'))),
        h('p', { class: 'muted', style: 'margin:0' }, _t('İşə başlamazdan əvvəl yalnız sizə məlum olan 4–8 rəqəmli PIN seçin.')),
        h('div', { class: 'field' }, h('label', { for: 'op' }, _t('Hazırkı PIN')), o),
        h('div', { class: 'field' }, h('label', { for: 'np1' }, _t('Yeni PIN')), n1),
        h('div', { class: 'field' }, h('label', { for: 'np2' }, _t('Yeni PIN təkrar')), n2),
        h('button', { class: 'btn primary', type: 'submit' }, _t('Saxla və davam et')),
        h('button', { class: 'btn', type: 'button', id: 'pin-logout', onclick: function () { S.logout(); resolve(false); } }, _t('Çıxış')));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (n1.value !== n2.value) return UI.toast(_t('Yeni PIN-lər eyni deyil'), 'bad');
        S.changePin(o.value, n1.value).then(function () { UI.toast(_t('PIN dəyişdirildi')); resolve(true); })
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
    UI.modal({ title: _t('Təsdiq sorğuları'), body: list, buttons: [{ text: _t('Bağla') }] });
    // Enter bu pəncərədəki sahələrdə pəncərəni bağlamasın (təsdiq yalnız düymə ilə)
    function noEnter(e) { if (e.key === 'Enter') e.preventDefault(); }

    // Mal qəbulu sorğusu: təsdiq edən sayı, təchizatçını və alış qiymətini yoxlayıb düzəldə bilər, sonra qalıq artır
    function stockItem(a, products, suppliers, decide) {
      var pl = a.payload || {}, p = products.filter(function (x) { return x.id === pl.productId; })[0];
      var qty = h('input', { class: 'input', type: 'number', min: '1', step: '1', value: String(pl.qty), 'data-f': 'qty', 'aria-label': _t('Say'), style: 'width:90px', onkeydown: noEnter });
      var sup = h('select', { class: 'input', 'data-f': 'sup', 'aria-label': _t('Təchizatçı'), onkeydown: noEnter },
        h('option', { value: '' }, suppliers.length ? _t('— təchizatçı seçin —') : _t('— təchizatçı yoxdur —')),
        suppliers.map(function (x) { return h('option', { value: x.id, selected: x.id === pl.supplierId }, x.name); }));
      var showCost = can('product.cost.view');
      var cost = showCost ? h('input', { class: 'input mono', inputmode: 'decimal', 'data-f': 'cost', 'aria-label': _t('Alış qiyməti (ədəd), ₼'), style: 'width:110px', onkeydown: noEnter,
        value: p && p.lastCost != null ? M.format(p.lastCost).replace(/\s/g, '') : '' }) : null;
      function go() {
        var n = parseInt(qty.value, 10), c = null;
        try {
          if (cost) { c = M.parse(cost.value); if (c == null) throw new Error(_t('Alış qiyməti səhvdir')); }
          if (suppliers.length && !sup.value) throw new Error(_t('Təchizatçını seçin'));
        } catch (e) { UI.toast(e.message, 'bad'); return; }
        decide('approved', { qty: n, supplierId: sup.value || null, unitCost: c }, _t('Qəbul təsdiqləndi, qalıq artırıldı: {0} ədəd', [n]));
      }
      return h('div', { class: 'req-item', 'data-kind': 'stock.receive', 'data-ap': a.id },
        h('div', null, h('b', null, UI.reqText(a))),
        h('div', { class: 'muted', style: 'font-size:13px' }, a.requestedBy.name + ' · ' + UI.fmtDate(a.at) + (p ? ' · ' + _t('Hazırkı qalıq: {0}', [p.stock]) : '')),
        pl.note ? h('div', { class: 'muted', style: 'font-size:13px' }, _t('Qeyd') + ': ' + pl.note) : null,
        h('div', { class: 'row', style: 'align-items:flex-end;flex-wrap:wrap' },
          h('div', { class: 'field' }, h('label', null, _t('Say')), qty),
          h('div', { class: 'field', style: 'flex:1;min-width:140px' }, h('label', null, _t('Təchizatçı')), sup),
          cost ? h('div', { class: 'field' }, h('label', null, _t('Alış qiyməti (ədəd), ₼')), cost) : null),
        h('div', { class: 'row', style: 'justify-content:flex-end' },
          h('button', { class: 'btn danger small', type: 'button', 'data-act': 'reject', onclick: function () { decide('rejected'); } }, _t('Rədd et')),
          h('button', { class: 'btn primary small', type: 'button', 'data-act': 'approve', onclick: go }, _t('Təsdiqlə və qəbul et'))));
    }

    function load() {
      return Promise.all([pendingForMe(), S.listProducts(), S.listSuppliers().catch(function () { return []; })]).then(function (r) {
        var items = r[0], products = r[1], suppliers = r[2];
        UI.clear(list);
        if (!items.length) list.appendChild(h('p', { class: 'muted', style: 'margin:0' }, _t('Gözləyən sorğu yoxdur.')));
        items.forEach(function (a) {
          function decide(d, opts, okMsg) {
            return S.decideApproval(a.id, d, opts).then(function () { UI.toast(d === 'approved' ? (okMsg || _t('Təsdiqləndi')) : _t('Rədd edildi')); if (onChange) onChange(); if (root.Screens._refresh) root.Screens._refresh(); return load(); })
              .catch(function (e) { UI.toast(e.message, 'bad'); return load(); });
          }
          if (a.kind === 'stock.receive' && a.payload) { list.appendChild(stockItem(a, products, suppliers, decide)); return; }
          list.appendChild(h('div', { class: 'req-item' },
            h('div', null, h('b', null, UI.reqText(a))),
            h('div', { class: 'muted', style: 'font-size:13px' }, a.requestedBy.name + ' · ' + UI.fmtDate(a.at)),
            h('div', { class: 'row', style: 'justify-content:flex-end' },
              h('button', { class: 'btn danger small', type: 'button', onclick: function () { decide('rejected'); } }, _t('Rədd et')),
              h('button', { class: 'btn primary small', type: 'button', onclick: function () { decide('approved'); } }, _t('Təsdiqlə')))));
        });
      });
    }
    load();
  }

  /* ================= Məhsullar ================= */
  function products(el) {
    UI.clear(el);
    var showCost = can('product.cost.view');
    var canAsk = can('stock.request') && !can('stock.receive');         // kassir: qalığı özü artıra bilmir, menecerə sorğu göndərir
    var myBox = h('div', { class: 'card', id: 'my-requests', style: 'margin-top:16px;display:none' });
    var q = h('input', { class: 'input', id: 'pq', type: 'search', placeholder: _t('Ad, mağaza və ya istehsalçı barkodu'), style: 'min-width:280px' });
    var body = h('tbody');
    var all = [], bySup = {};
    // Nümunə məhsullar yalnız siyahı boş olanda təklif olunur (təkrar basanda dublikat yaranırdı)
    var seedBtn = h('button', { class: 'btn small', onclick: function () {
      seedBtn.disabled = true;
      S.seedDemoProducts().then(function () { UI.toast(_t('Nümunə məhsullar əlavə olundu')); return load(); }).catch(function (e) { UI.toast(e.message, 'bad'); seedBtn.disabled = false; });
    } }, _t('Sınaq üçün nümunə məhsullar əlavə et'));
    var seedBox = h('div', { style: 'margin-top:12px;display:none' }, seedBtn);

    function draw() {
      seedBox.style.display = all.length ? 'none' : '';
      var s = q.value.trim().toLowerCase();
      UI.clear(body);
      var list = all.filter(function (p) { return !s || p.name.toLowerCase().indexOf(s) !== -1 || p.storeBarcode.indexOf(s) !== -1 || (p.mfrBarcode || '').indexOf(s) !== -1; });
      if (!list.length) body.appendChild(h('tr', null, h('td', { colspan: showCost ? '9' : '8', class: 'empty' }, all.length ? _t('Uyğun məhsul yoxdur') : _t('Hələ məhsul yoxdur'))));
      list.forEach(function (p) {
        var low = p.stock <= (p.minStock || 0);
        body.appendChild(h('tr', null,
          h('td', null, h('div', null, p.name), h('div', { class: 'muted', style: 'font-size:13px' }, [p.category, p.ageGroup].filter(Boolean).join(' · '))),
          h('td', { class: 'mono', style: 'font-size:14px' }, p.storeBarcode),
          h('td', { class: 'mono muted', style: 'font-size:14px' }, p.mfrBarcode || '—'),
          h('td', { class: 'num' }, M.format(p.price)),
          showCost ? h('td', { class: 'num muted' }, M.format(p.avgCost)) : null,
          h('td', { class: 'num' }, p.stock < 0 ? h('span', { class: 'warn-text' }, String(p.stock)) : low ? h('span', { class: 'badge' }, String(p.stock)) : String(p.stock)),
          h('td', { style: 'font-size:13px', 'data-sup': p.id }, (bySup[p.id] || []).map(function (x) { return h('div', null, (x.name || _t('köhnə qalıq')) + ' · ' + x.qty); })),
          h('td', null, p.active ? h('span', { class: 'badge ok' }, _t('Aktiv')) : h('span', { class: 'badge off' }, _t('Passiv'))),
          h('td', { style: 'white-space:nowrap' },
            can('product.edit') ? h('button', { class: 'btn small', onclick: function () { productForm(p, load); } }, _t('Dəyiş')) : null, ' ',
            can('stock.receive') ? h('button', { class: 'btn small', onclick: function () { receiveForm(p, load); } }, _t('Qəbul')) : null,
            canAsk ? h('button', { class: 'btn small', 'data-act': 'ask-receive', title: _t('Mal gəldi: menecerə təsdiq sorğusu göndər'), onclick: function () { requestReceiveForm(p, load); } }, _t('Mal gəldi')) : null, ' ',
            can('supplier.view') ? h('button', { class: 'btn small', 'data-act': 'lots', onclick: function () { lotsModal(p); } }, _t('Partiyalar')) : null, ' ',
            can('label.print') ? h('button', { class: 'btn small', onclick: function () { labelForm(p); } }, _t('Etiket')) : null)));
      });
    }
    var REQ_STATE = { pending: _t('Gözləyir'), approved: _t('Təsdiqləndi'), rejected: _t('Rədd edildi'), cancelled: _t('Ləğv edildi'), expired: _t('Vaxtı bitib') };
    function drawMine(reqs) {
      myBox.style.display = reqs.length ? '' : 'none';
      UI.clear(myBox);
      if (!reqs.length) return;
      myBox.appendChild(h('h2', { style: 'margin:0 0 4px;font-size:18px' }, _t('Mal qəbulu sorğularım')));
      myBox.appendChild(h('p', { class: 'muted', style: 'margin:0 0 8px;font-size:13px' }, _t('Qalıq menecer təsdiqləyəndən sonra artır.')));
      myBox.appendChild(h('div', { class: 'table-wrap', tabindex: '0' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, _t('Vaxt')), h('th', null, _t('Məhsul')), h('th', { class: 'num' }, _t('Say')), h('th', null, _t('Təchizatçı')), h('th', null, _t('Status')), h('th', null, ''))),
        h('tbody', null, reqs.slice(0, 15).map(function (a) {
          var pl = a.payload || {}, got = a.result && a.result.qty != null && a.result.qty !== pl.qty ? ' → ' + a.result.qty : '';
          return h('tr', { 'data-ap': a.id, 'data-state': a.state },
            h('td', null, UI.fmtDate(a.at)), h('td', null, pl.productName || ''), h('td', { class: 'num' }, String(pl.qty) + got), h('td', null, pl.supplierName || '—'),
            h('td', null, h('span', { class: 'badge' + (a.state === 'approved' ? ' ok' : a.state === 'pending' ? '' : ' off') }, REQ_STATE[a.state] || a.state),
              a.state === 'rejected' && a.decidedBy ? h('div', { class: 'muted', style: 'font-size:12px' }, a.decidedBy.name) : null),
            h('td', null, a.state === 'pending' ? h('button', { class: 'btn small', type: 'button', 'data-act': 'cancel-req', onclick: function () {
              S.cancelApproval(a.id).then(function () { UI.toast(_t('Sorğu ləğv edildi')); return load(); }).catch(function (e) { UI.toast(e.message, 'bad'); });
            } }, _t('Ləğv et')) : null));
        })))));
    }
    function load() {
      return Promise.all([S.listProducts(), S.stockBySupplier().catch(function () { return {}; }), canAsk ? S.listMyStockRequests() : Promise.resolve([])]).then(function (r) {
        all = r[0].map(function (p) { return S.sanitizeForRole(p, showCost); }); bySup = r[1]; draw(); drawMine(r[2]);
      });
    }
    root.Screens._refresh = load;     // başqa cihazdan dəyişiklik gələndə siyahı yenilənir
    q.addEventListener('input', draw);

    el.appendChild(h('div', { class: 'page' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:16px' },
        h('h1', { style: 'margin:0' }, _t('Məhsullar')),
        h('div', { class: 'row' },
          h('label', { class: 'sr-only', for: 'pq' }, _t('Axtarış')), q,
          can('product.edit') ? h('button', { class: 'btn primary', onclick: function () { productForm(null, load); } }, _t('Yeni məhsul')) : null)),
      h('div', { class: 'card table-wrap', tabindex: '0' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, _t('Məhsul')), h('th', null, _t('Mağaza barkodu')), h('th', null, _t('İstehsalçı barkodu')), h('th', { class: 'num' }, _t('Satış ₼')),
          showCost ? h('th', { class: 'num' }, _t('Orta maya ₼')) : null, h('th', { class: 'num' }, _t('Qalıq')), h('th', null, _t('Təchizatçı (qalıq)')), h('th', null, _t('Status')), h('th', null, ''))),
        body)),
      myBox,
      can('product.edit') && can('stock.receive') ? seedBox : null));
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
      name: inp('f-name', _t('Ad *'), p && p.name, { required: true }),
      category: inp('f-cat', _t('Kateqoriya'), p && p.category, { list: 'cats' }),
      brand: inp('f-brand', _t('Brend'), p && p.brand),
      age: inp('f-age', _t('Yaş qrupu'), p && p.ageGroup, { placeholder: _t('məs. 3+') }),
      mfr: inp('f-mfr', _t('İstehsalçı barkodu (nəzarət üçün, uzunluq məhdud deyil)'), p && p.mfrBarcode, { class: 'input mono', autocomplete: 'off' }),
      price: inp('f-price', _t('Satış qiyməti, ₼ *'), p ? M.format(p.price).replace(/\s/g, '') : '', { class: 'input mono', inputmode: 'decimal', disabled: !canPrice }),
      cost: isNew && can('product.cost.view') ? inp('f-cost', _t('Alış qiyməti, ₼'), '', { class: 'input mono', inputmode: 'decimal' }) : null,
      min: inp('f-min', _t('Minimum qalıq'), p ? p.minStock : 0, { type: 'number', min: '0' })
    };
    var active = h('input', { type: 'checkbox', id: 'f-active', checked: !p || p.active });
    var body = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'grid2' }, f.name.el, f.category.el, f.brand.el, f.age.el, f.mfr.el, f.price.el, f.cost && f.cost.el, f.min.el),
      !canPrice ? h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Satış qiymətini yalnız Menecer və Admin təyin edir.')) : null,
      p ? h('p', { class: 'muted', style: 'margin:0' }, _t('Mağaza barkodu: '), h('span', { class: 'mono' }, p.storeBarcode), _t(' (dəyişmir)')) : h('p', { class: 'muted', style: 'margin:0' }, _t('Mağaza barkodu yadda saxlayanda avtomatik veriləcək.')),
      p ? h('label', { style: 'display:flex;gap:8px;align-items:center' }, active, _t('Satışda aktivdir')) : null);

    UI.modal({
      title: isNew ? _t('Yeni məhsul') : _t('Məhsulu dəyiş'), wide: true, body: body,
      buttons: [{ text: _t('İmtina') }, { text: _t('Yadda saxla'), kind: 'primary', submit: true, onClick: function (close) {
        var price = M.parse(f.price.input.value);
        if (price == null) throw new Error(_t('Satış qiyməti səhvdir'));
        var data = { name: f.name.input.value, category: f.category.input.value.trim(), brand: f.brand.input.value.trim(), ageGroup: f.age.input.value.trim(),
          mfrBarcode: f.mfr.input.value.trim(), price: price, minStock: parseInt(f.min.input.value, 10) || 0 };
        if (f.cost) { var c = M.parse(f.cost.input.value || '0'); if (c == null) throw new Error(_t('Alış qiyməti səhvdir')); data.cost = c; }
        if (p) data.active = active.checked;
        var op = isNew ? S.createProduct(data) : S.updateProduct(p.id, data);
        return op.then(function (r) {
          r.warnings.forEach(function (w) { UI.toast(w, 'warn'); });
          UI.toast(isNew ? _t('Məhsul yaradıldı · {0}', [r.product.storeBarcode]) : _t('Yadda saxlanıldı'));
          close(); onSaved();
          if (isNew) labelForm(r.product);
        });
      } }]
    });
  }

  function receiveForm(p, onSaved) {
    var qty = h('input', { class: 'input', id: 'r-qty', type: 'number', min: '1', value: '1' });
    var cost = h('input', { class: 'input mono', id: 'r-cost', inputmode: 'decimal', value: p.lastCost != null ? M.format(p.lastCost).replace(/\s/g, '') : '' });
    var note = h('input', { class: 'input', id: 'r-note', placeholder: _t('Qaimə №, izah') });
    var sup = h('select', { class: 'input', id: 'r-sup' });
    var supHint = h('div', { class: 'muted', style: 'font-size:13px', id: 'r-sup-hint' });
    var hasSuppliers = false;
    function loadSuppliers(selectId) {
      return S.listSuppliers().then(function (list) {
        hasSuppliers = list.length > 0;
        UI.clear(sup);
        sup.appendChild(h('option', { value: '' }, hasSuppliers ? _t('— təchizatçı seçin —') : _t('— təchizatçı yoxdur —')));
        list.forEach(function (x) { sup.appendChild(h('option', { value: x.id, selected: x.id === selectId }, x.name)); });
        supHint.textContent = hasSuppliers ? _t('FIFO: hər satış ən köhnə partiyadan çıxır, hesabatda təchizatçıya görə görünür.') : _t('Hələ təchizatçı yoxdur. Yeni təchizatçı əlavə edin; təchizatçısız qəbul "köhnə qalıq" kimi sayılır.');
      });
    }
    loadSuppliers();
    var addBtn = can('supplier.manage') ? h('button', { class: 'btn small', type: 'button', id: 'r-sup-add', onclick: function () { supplierForm(null, function (s2) { loadSuppliers(s2.id); }); } }, _t('+ Yeni təchizatçı')) : null;
    UI.modal({
      title: _t('Mal qəbulu — {0}', [p.name]),
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('p', { class: 'muted', style: 'margin:0' }, _t('Hazırkı qalıq: {0}. Hər qəbul ayrıca partiyadır (təchizatçı, say, alış qiyməti).', [p.stock])),
        h('div', { class: 'field' }, h('label', { for: 'r-sup' }, _t('Təchizatçı')), h('div', { class: 'row', style: 'align-items:stretch;flex-wrap:nowrap' }, h('div', { style: 'flex:1' }, sup), addBtn), supHint),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { for: 'r-qty' }, _t('Say')), qty),
          can('product.cost.view') ? h('div', { class: 'field' }, h('label', { for: 'r-cost' }, _t('Alış qiyməti (ədəd), ₼')), cost) : null),
        h('div', { class: 'field' }, h('label', { for: 'r-note' }, _t('Qeyd')), note)),
      buttons: [{ text: _t('İmtina') }, { text: _t('Qəbul et'), kind: 'primary', submit: true, onClick: function (close) {
        var c = can('product.cost.view') ? M.parse(cost.value) : null;     // qiyməti görməyən rol üçün server son qiyməti götürür
        if (can('product.cost.view') && c == null) throw new Error(_t('Alış qiyməti səhvdir'));
        if (hasSuppliers && !sup.value) throw new Error(_t('Təchizatçını seçin'));
        var n = parseInt(qty.value, 10);
        return S.receiveStock(p.id, n, c, note.value, sup.value || null).then(function (np) {
          UI.toast(_t('Qalıq: {0}', [np.stock])); close(); onSaved();
          labelForm(np, n);
        });
      } }]
    });
  }

  // Kassir: "mal gəldi" sorğusu. Alış qiymətini kassir görmür və yazmır; qalığı menecer təsdiqləyəndə artır.
  function requestReceiveForm(p, onSaved) {
    var qty = h('input', { class: 'input', id: 'q-qty', type: 'number', min: '1', step: '1', value: '1' });
    var note = h('input', { class: 'input', id: 'q-note', maxlength: '200', autocomplete: 'off', placeholder: _t('Qaimə №, izah') });
    var sup = h('select', { class: 'input', id: 'q-sup' });
    S.listSuppliers().then(function (list) {
      UI.clear(sup);
      sup.appendChild(h('option', { value: '' }, list.length ? _t('— bilmirəm / menecer seçəcək —') : _t('— təchizatçı yoxdur —')));
      list.forEach(function (x) { sup.appendChild(h('option', { value: x.id }, x.name)); });
    }).catch(function () { /* siyahı olmasa təchizatçısız sorğu göndərilir */ });
    UI.modal({
      title: _t('Mal gəldi — {0}', [p.name]),
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('p', { class: 'muted', style: 'margin:0' }, _t('Gələn malın sayını yazın. Sorğu menecerə gedir; qalıq menecer təsdiqləyəndən sonra artacaq (hazırkı qalıq: {0}).', [p.stock])),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { for: 'q-qty' }, _t('Say')), qty),
          h('div', { class: 'field' }, h('label', { for: 'q-sup' }, _t('Təchizatçı')), sup)),
        h('div', { class: 'field' }, h('label', { for: 'q-note' }, _t('Qeyd')), note)),
      buttons: [{ text: _t('İmtina') }, { text: _t('Menecerə göndər'), kind: 'primary', submit: true, onClick: function (close) {
        var n = parseInt(qty.value, 10);
        return root.Sync.endpoint().then(function (url) {
          if (!url) throw new Error(_t('Server qoşulmayıb: sorğu menecerin cihazına çata bilməz. Mal qəbulunu menecer özü etməlidir'));
          return S.requestStockReceipt(p.id, n, sup.value || null, note.value);
        }).then(function () { close(); UI.toast(_t('Sorğu menecerə göndərildi')); if (onSaved) onSaved(); });
      } }]
    });
  }

  // Təchizatçı əlavə etmək / dəyişmək. onDone(supplier)
  function supplierForm(sp, onDone) {
    var name = h('input', { class: 'input', id: 'sp-name', maxlength: '60', autocomplete: 'off', value: sp ? sp.name : '', placeholder: _t('Şirkət və ya şəxs adı') });
    var phone = h('input', { class: 'input', id: 'sp-phone', maxlength: '40', autocomplete: 'off', value: sp ? sp.phone : '' });
    var note = h('input', { class: 'input', id: 'sp-note', maxlength: '300', autocomplete: 'off', value: sp ? sp.note : '', placeholder: _t('VÖEN, ünvan, şərtlər…') });
    UI.modal({
      title: sp ? _t('Təchizatçını dəyiş') : _t('Yeni təchizatçı'),
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'field' }, h('label', { for: 'sp-name' }, _t('Ad *')), name),
        h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'sp-phone' }, _t('Telefon')), phone), h('div', { class: 'field' }, h('label', { for: 'sp-note' }, _t('Qeyd')), note))),
      buttons: [{ text: _t('İmtina') }, { text: _t('Yadda saxla'), kind: 'primary', submit: true, onClick: function (close) {
        var d = { name: name.value, phone: phone.value, note: note.value };
        var op = sp ? S.updateSupplier(sp.id, d) : S.createSupplier(d);
        return op.then(function (r) { close(); UI.toast(_t('Yadda saxlanıldı')); if (onDone) onDone(r.supplier || r); });
      } }]
    });
  }

  // Bir məhsulun partiyaları (FIFO sırası)
  function lotsModal(p) {
    var box = h('div', { class: 'table-wrap', tabindex: '0' });
    UI.modal({ title: _t('Partiyalar (FIFO) — {0}', [p.name]), wide: true, body: box, buttons: [{ text: _t('Bağla') }] });
    S.productLots(p.id).then(function (lots) {
      var seeCost = lots.some(function (l) { return l.unitCost != null; });
      if (!lots.length) return box.appendChild(h('p', { class: 'muted' }, _t('Bu məhsul üzrə qəbul yoxdur.')));
      box.appendChild(h('table', { id: 'lots-table' }, h('thead', null, h('tr', null, h('th', null, _t('Qəbul tarixi')), h('th', null, _t('Təchizatçı')), h('th', { class: 'num' }, _t('Qəbul')), h('th', { class: 'num' }, _t('Qalıq')),
        seeCost ? h('th', { class: 'num' }, _t('Alış ₼')) : null)),
        h('tbody', null, lots.map(function (l) {
          return h('tr', { class: l.remaining ? '' : 'inactive' }, h('td', null, l.opening ? _t('Köhnə qalıq') : UI.fmtDate(l.at)), h('td', null, l.supplier || (l.opening ? '—' : _t('Təchizatçısız'))),
            h('td', { class: 'num' }, String(l.qty)), h('td', { class: 'num' }, String(l.remaining)), seeCost ? h('td', { class: 'num' }, M.format(l.unitCost)) : null);
        }))));
      box.appendChild(h('p', { class: 'muted', style: 'font-size:13px;margin:10px 0 0' }, _t('Satış ən köhnə partiyadan çıxır. "Qalıq" sütunu hələ satılmamış hissədir.')));
    }).catch(function (e) { box.appendChild(h('p', { class: 'warn-text' }, e.message)); });
  }

  function labelForm(p, count) {
    var n = h('input', { class: 'input', id: 'l-n', type: 'number', min: '1', max: '500', value: String(count || 1) });
    var preview = h('div', { style: 'display:flex;justify-content:center;padding:8px;background:var(--ground);border-radius:8px;overflow:auto' });
    var info = h('div', { class: 'muted', style: 'font-size:13px', id: 'l-info' });
    function draw() {
      var L = root.Print.settings().label, b = root.Print.barcodeInfo();
      preview.innerHTML = UI.labelsHtml([{ product: p, count: 1 }]);
      info.textContent = _t('Etiket {0} × {1} mm · {2} dpi · barkod zolağı {3} mm{4}', [L.w, L.h, L.dpi, b.modMm.toFixed(2), (b.ok ? '' : _t(' — etiket dardır, barkod oxunmaya bilər'))]);
      info.className = b.ok ? 'muted' : 'warn-text';
    }
    draw();
    UI.modal({
      title: _t('Etiket çapı'),
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, preview, info,
        h('div', { class: 'field' }, h('label', { for: 'l-n' }, _t('Etiket sayı')), n),
        h('div', null, h('button', { class: 'btn small', type: 'button', id: 'l-settings', onclick: function () {
          root.Print.settingsModal(draw);
        } }, _t('Çap ayarları')))),
      buttons: [{ text: _t('Bağla') }, { text: _t('Çap et'), kind: 'primary', submit: true, onClick: function (close) {
        var c = Math.min(500, Math.max(1, parseInt(n.value, 10) || 1));
        UI.printHtml(UI.labelsHtml([{ product: p, count: c }]), 'label'); close();
      } }]
    });
  }

  /* ================= Təchizatçılar ================= */
  var BAKU = 'Asia/Baku';
  function todayBaku() { return new Intl.DateTimeFormat('en-CA', { timeZone: BAKU, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  function addDays(ds, n) { var d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function monthStart(ds, k) { var d = new Date(ds.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 10); }
  function dayIso(ds) { return ds ? new Date(ds + 'T00:00:00+04:00').toISOString() : ''; }          // Bakı vaxtı UTC+4 (yay vaxtı yoxdur)

  // CSV-də =, +, -, @ ilə başlayan mətn Excel-də düstur kimi işləyir (məs. təchizatçı adı =HYPERLINK(...)): əvvəlinə ' qoyulur. Ədəd / telefon kimi görünənlər (rəqəm, boşluq, vergül, nöqtə) toxunulmaz qalır.
  function csvSafe(c) {
    c = c == null ? '' : String(c);
    return /^[=+\-@\t\r]/.test(c) && !/^[+-]?[\d\s.,]*$/.test(c) ? "'" + c : c;
  }
  function csvDownload(name, rows) {
    var text = '\ufeff' + rows.map(function (r) { return r.map(function (c) { c = csvSafe(c); return /[";\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(';'); }).join('\r\n');
    var a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })), download: name });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function suppliers(el) {
    UI.clear(el);
    var canManage = can('supplier.manage');
    var tb = h('tbody'), repBody = h('tbody'), repFoot = h('tfoot'), repHead = h('thead');
    var preset = h('select', { class: 'input', id: 'rp-preset' }, [['month', _t('Bu ay')], ['today', _t('Bu gün')], ['yesterday', _t('Dünən')], ['prev', _t('Keçən ay')], ['all', _t('Bütün vaxt')], ['custom', _t('Seçilmiş tarixlər')]].map(function (o) { return h('option', { value: o[0] }, o[1]); }));
    var from = h('input', { class: 'input', id: 'rp-from', type: 'date' }), to = h('input', { class: 'input', id: 'rp-to', type: 'date' });
    var last = null, warnBox = h('div', { id: 'rp-warn', class: 'warn-text', role: 'alert', hidden: true, style: 'font-size:14px' });

    function range() {
      var t = todayBaku(), v = preset.value, f = '', e = '';
      if (v === 'today') { f = t; e = addDays(t, 1); }
      else if (v === 'yesterday') { f = addDays(t, -1); e = t; }
      else if (v === 'month') { f = monthStart(t, 0); e = monthStart(t, 1); }
      else if (v === 'prev') { f = monthStart(t, -1); e = monthStart(t, 0); }
      else if (v === 'custom') { f = from.value; e = to.value ? addDays(to.value, 1) : ''; }
      if (v !== 'custom') { from.value = f; to.value = e ? addDays(e, -1) : ''; }
      return { from: dayIso(f), to: dayIso(e) };
    }

    function loadSuppliers() {
      return Promise.all([S.listSuppliers({ all: true }), S.supplierReport({})]).then(function (r) {
        var hand = {}; r[1].rows.forEach(function (x) { hand[x.supplierId || ''] = x; });
        UI.clear(tb);
        if (!r[0].length) tb.appendChild(h('tr', null, h('td', { colspan: '6', class: 'empty' }, _t('Hələ təchizatçı yoxdur'))));
        r[0].forEach(function (sp) {
          var x = hand[sp.id];
          tb.appendChild(h('tr', { 'data-sup': sp.name, class: sp.active ? '' : 'inactive' }, h('td', null, sp.name), h('td', null, sp.phone || '—'), h('td', { class: 'muted' }, sp.note || ''),
            h('td', { class: 'num' }, String(x ? x.onHandQty : 0)), h('td', null, sp.active ? h('span', { class: 'badge ok' }, _t('Aktiv')) : h('span', { class: 'badge off' }, _t('Söndürülüb'))),
            h('td', { style: 'text-align:right;white-space:nowrap' }, canManage ? [
              h('button', { class: 'btn small', type: 'button', 'data-act': 'edit', onclick: function () { supplierForm(sp, loadAll); } }, _t('Redaktə')), ' ',
              h('button', { class: 'btn small' + (sp.active ? ' danger' : ''), type: 'button', 'data-act': 'toggle', onclick: function () {
                S.updateSupplier(sp.id, { active: !sp.active }).then(function () { UI.toast(sp.active ? _t('Söndürüldü') : _t('Aktiv edildi')); loadAll(); }).catch(function (e) { UI.toast(e.message, 'bad'); });
              } }, sp.active ? _t('Söndür') : _t('Aktiv et'))] : null)));
        });
      });
    }

    function loadReport() {
      return S.supplierReport(range()).then(function (rep) {
        last = rep;
        var cost = rep.seeCost;
        warnBox.hidden = !rep.excessReturnQty;
        warnBox.textContent = rep.excessReturnQty ? _t('Diqqət: {0} ədəd mal satılandan artıq qaytarılıb (məsələn, iki cihaz eyni çekin eyni sətrini oflayn qaytarıb). Qaytarmalar bölməsində həmin çeki yoxlayın; pul iki dəfə qaytarılmış ola bilər.', [rep.excessReturnQty]) : '';
        UI.clear(repHead); UI.clear(repBody); UI.clear(repFoot);
        repHead.appendChild(h('tr', null, h('th', null, _t('Təchizatçı')), h('th', { class: 'num' }, _t('Satılan')), h('th', { class: 'num' }, _t('Qaytarılan')), h('th', { class: 'num' }, _t('Xalis ədəd')), h('th', { class: 'num' }, _t('Gəlir ₼')),
          cost ? [h('th', { class: 'num' }, _t('Maya (FIFO) ₼')), h('th', { class: 'num' }, _t('Mənfəət ₼'))] : null, h('th', { class: 'num' }, _t('Qalıq (ədəd)')), cost ? h('th', { class: 'num' }, _t('Qalığın dəyəri ₼')) : null, h('th', null, '')));
        if (!rep.rows.length) repBody.appendChild(h('tr', null, h('td', { colspan: cost ? '10' : '7', class: 'empty' }, _t('Bu dövrdə məlumat yoxdur'))));
        rep.rows.forEach(function (x) {
          repBody.appendChild(h('tr', { 'data-rep': x.name }, h('td', null, x.name), h('td', { class: 'num' }, String(x.soldQty)), h('td', { class: 'num' }, String(x.returnedQty)), h('td', { class: 'num' }, h('b', null, String(x.qty))),
            h('td', { class: 'num' }, M.format(x.revenue)), cost ? [h('td', { class: 'num muted' }, M.format(x.cost)), h('td', { class: 'num' }, M.format(x.profit))] : null,
            h('td', { class: 'num' }, String(x.onHandQty)), cost ? h('td', { class: 'num muted' }, M.format(x.onHandValue)) : null,
            h('td', null, x.products.length ? h('button', { class: 'btn small', type: 'button', 'data-act': 'detail', onclick: function () { detail(x); } }, _t('Məhsullar')) : null)));
        });
        var t = rep.totals;
        repFoot.appendChild(h('tr', null, h('th', null, _t('Cəmi')), h('th', { class: 'num' }, String(t.soldQty)), h('th', { class: 'num' }, String(t.returnedQty)), h('th', { class: 'num' }, String(t.qty)), h('th', { class: 'num' }, M.format(t.revenue)),
          cost ? [h('th', { class: 'num' }, M.format(t.cost)), h('th', { class: 'num' }, M.format(t.profit))] : null, h('th', { class: 'num' }, String(t.onHandQty)), cost ? h('th', { class: 'num' }, M.format(t.onHandValue)) : null, h('th', null, '')));
      });
    }
    function loadAll() { return Promise.all([loadSuppliers(), loadReport()]).catch(function (e) { UI.toast(e.message, 'bad'); }); }

    function detail(x) {
      var cost = last && last.seeCost;
      UI.modal({ title: _t('{0} — məhsullar', [x.name]), wide: true, buttons: [{ text: _t('Bağla') }], body: h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'detail-table' },
        h('thead', null, h('tr', null, h('th', null, _t('Məhsul')), h('th', { class: 'num' }, _t('Satılan')), h('th', { class: 'num' }, _t('Qaytarılan')), h('th', { class: 'num' }, _t('Xalis')), h('th', { class: 'num' }, _t('Gəlir ₼')),
          cost ? [h('th', { class: 'num' }, _t('Maya ₼')), h('th', { class: 'num' }, _t('Mənfəət ₼'))] : null)),
        h('tbody', null, x.products.map(function (p) {
          return h('tr', null, h('td', null, p.name), h('td', { class: 'num' }, String(p.soldQty)), h('td', { class: 'num' }, String(p.returnedQty)), h('td', { class: 'num' }, String(p.qty)), h('td', { class: 'num' }, M.format(p.revenue)),
            cost ? [h('td', { class: 'num muted' }, M.format(p.cost)), h('td', { class: 'num' }, M.format(p.profit))] : null);
        })))) });
    }

    function exportCsv() {
      if (!last) return;
      var cost = last.seeCost;
      var rows = [[_t('Təchizatçı'), _t('Məhsul'), _t('Satılan'), _t('Qaytarılan'), _t('Xalis ədəd'), _t('Gəlir'), cost ? _t('Maya (FIFO)') : null, cost ? _t('Mənfəət') : null].filter(function (c) { return c !== null; })];
      function num(q) { return (q / 100).toFixed(2).replace('.', ','); }
      last.rows.forEach(function (x) {
        x.products.forEach(function (p) { rows.push([x.name, p.name, p.soldQty, p.returnedQty, p.qty, num(p.revenue)].concat(cost ? [num(p.cost), num(p.profit)] : [])); });
      });
      csvDownload('techizatci-hesabati.csv', rows);
    }

    [preset, from, to].forEach(function (c) { c.addEventListener('change', function () { if (c !== preset && preset.value !== 'custom') preset.value = 'custom'; loadReport().catch(function (e) { UI.toast(e.message, 'bad'); }); }); });
    root.Screens._refresh = loadAll;     // başqa cihazdan qəbul/satış gələndə yenilənir

    el.appendChild(h('div', { class: 'page' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:16px' }, h('h1', { style: 'margin:0' }, _t('Təchizatçılar')),
        canManage ? h('button', { class: 'btn primary', id: 'sup-add', type: 'button', onclick: function () { supplierForm(null, loadAll); } }, _t('+ Yeni təchizatçı')) : null),
      h('div', { class: 'card table-wrap', tabindex: '0' }, h('table', { id: 'sup-table' }, h('thead', null, h('tr', null, h('th', null, _t('Ad')), h('th', null, _t('Telefon')), h('th', null, _t('Qeyd')), h('th', { class: 'num' }, _t('Qalıq (ədəd)')), h('th', null, _t('Vəziyyət')), h('th', null, ''))), tb)),
      h('div', { class: 'card', style: 'margin-top:24px' },
        h('div', { style: 'padding:16px 20px;display:flex;flex-direction:column;gap:12px' },
          h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { style: 'margin:0;font-size:18px' }, _t('Hansı təchizatçının malından nə qədər satılıb')),
            h('button', { class: 'btn small', type: 'button', id: 'rp-csv', onclick: exportCsv }, _t('Excel üçün CSV'))),
          warnBox,
          h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'rp-preset' }, _t('Dövr')), preset), h('div', { class: 'field' }, h('label', { for: 'rp-from' }, _t('Başlanğıc')), from), h('div', { class: 'field' }, h('label', { for: 'rp-to' }, _t('Son')), to)),
          h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Satış FIFO ilədir: hər çek ən köhnə partiyadan çıxır. Gəlir endirimdən sonrakı məbləğdir, qaytarmalar çıxılır. "Təchizatçısız" — sistemə köçməzdən əvvəlki qalıq və ya qəbuldan əvvəl (mənfi qalıqla) satılan mal. Oflayn cihaz sonra sinxronlaşanda bölgü təchizatçılar arasında düzələ bilər, cəmlər dəyişmir.'))),
        h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'rep-table' }, repHead, repBody, repFoot)))));
    range(); loadAll();
  }

  /* ================= Qaytarma ================= */
  function returns(el) {
    UI.clear(el);
    var scan = h('input', { class: 'scan', id: 'rscan', inputmode: 'numeric', autocomplete: 'off' });
    var out = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });

    function show(sale) {
      UI.clear(out);
      if (!sale) { out.appendChild(h('div', { class: 'card empty' }, _t('Çek tapılmadı'))); UI.beep(false); return; }
      var win = R.returnWindow(sale.at, new Date().toISOString());
      return S.returnedQtyBySale(sale.id).then(function (prev) {
        var head = h('div', { class: 'card', style: 'padding:16px 20px;display:flex;flex-wrap:wrap;gap:20px;justify-content:space-between' },
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, _t('Çek №')), h('b', { class: 'mono' }, String(sale.receiptNo).padStart(6, '0'))),
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, _t('Tarix')), UI.fmtDate(sale.at)),
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, _t('Ödəniş')), UI.METHOD[sale.payment.method] + (sale.payment.bankType ? ' · ' + UI.BANK_TYPE[sale.payment.bankType] : '')),
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, _t('Yekun')), M.format(sale.totals.total) + ' ₼' + (sale.discount ? _t(' ({0}% endirim)', [sale.discount.percent]) : '')),
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, _t('Keçən gün')), String(win.daysPassed)));
        out.appendChild(head);
        if (win.expired) {
          UI.beep(false);
          out.appendChild(h('div', { class: 'card', role: 'alert', style: 'padding:18px 20px;background:var(--bad-soft);color:var(--bad);font-weight:600;border-color:#E2B4B4' },
            _t('Çekin qaytarma müddəti bitib: {0} gün keçib (limit {1} gün).', [win.daysPassed, R.RETURN_DAYS])));
          return;
        }
        var inputs = [], maxes = [];
        var tb = h('tbody');
        var errBox = h('div', { class: 'modal-err', role: 'alert', hidden: true });
        function showErr(msg) { errBox.textContent = msg; errBox.hidden = false; UI.toast(msg, 'bad'); UI.beep(false); }
        sale.lines.forEach(function (l, i) {
          var max = R.returnableQty(l.qty, prev.map[i]);
          maxes.push(max);
          var inp = h('input', { class: 'input', type: 'number', min: '0', max: String(max), value: '0', style: 'width:90px', disabled: !max, 'aria-label': _t('Qaytarılan say: {0}', [l.name]) });
          // Yazanda yuxarı hədd (satılan − əvvəl qaytarılan) aşılırsa dərhal xəbərdarlıq
          inp.addEventListener('input', function () {
            var v = parseInt(inp.value, 10) || 0;
            if (v > max) { inp.value = String(max); showErr(_t('"{0}": ən çox {1} ədəd qaytarmaq olar (satılıb {2})', [l.name, max, l.qty])); }
            else if (v < 0) inp.value = '0';
          });
          inputs.push(inp);
          tb.appendChild(h('tr', null, h('td', null, l.name), h('td', { class: 'num' }, String(l.qty)), h('td', { class: 'num muted' }, String(prev.map[i] || 0)),
            h('td', { class: 'num' }, M.format(l.price)), h('td', { class: 'num' }, inp)));
        });
        var reason = h('input', { class: 'input', id: 'rreason', placeholder: _t('məs. zədəli, uyğun gəlmədi') });
        out.appendChild(h('div', { class: 'card table-wrap', tabindex: '0' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, _t('Məhsul')), h('th', { class: 'num' }, _t('Satılıb')), h('th', { class: 'num' }, _t('Qaytarılıb')), h('th', { class: 'num' }, _t('Qiymət')), h('th', { class: 'num' }, _t('Qaytarılır')))), tb)));
        out.appendChild(h('div', { class: 'row' },
          h('div', { class: 'field', style: 'flex:1 1 280px' }, h('label', { for: 'rreason' }, _t('Səbəb')), reason),
          h('button', { class: 'btn primary', onclick: function () {
            var items = inputs.map(function (inp, i) { return { lineIndex: i, qty: parseInt(inp.value, 10) || 0 }; }).filter(function (x) { return x.qty > 0; });
            if (!items.length) return showErr(_t('Qaytarılacaq say yazın'));
            // Sayı menecer təsdiqindən ƏVVƏL yoxlanır: satılandan (və əvvəl qaytarılandan) çox olmasın
            for (var k = 0; k < items.length; k++) {
              var mx = maxes[items[k].lineIndex], ln = sale.lines[items[k].lineIndex];
              if (items[k].qty > mx) { inputs[items[k].lineIndex].focus(); return showErr(_t('"{0}": satılıb {1}, əvvəl qaytarılıb {2} — ən çox {3} ədəd qaytarmaq olar', [ln.name, ln.qty, (prev.map[items[k].lineIndex] || 0), mx])); }
            }
            errBox.hidden = true;
            var amount = R.refundAmount(items.map(function (it) { return { price: sale.lines[it.lineIndex].price, qty: it.qty }; }), sale.discount ? sale.discount.percent : 0);
            var rsum = _t('Çek № {0} üzrə {1} ₼ qaytarılır.', [sale.receiptNo, M.format(amount)]);
            S.validateReturn(sale.id, items).then(function () {
              return UI.approve(_t('Qaytarmanı təsdiqlə'), rsum, 'pos.return.approve', UI.req('return', '{0} qaytarma istəyir. Çek № {1} üzrə {2} ₼ qaytarılır.', [S.currentUser() ? S.currentUser().name : '', sale.receiptNo, M.format(amount)]));
            }).then(function (a) {
              if (!a) return;
              return S.createReturn(sale.id, items, a, reason.value).then(function (ret) {
                return S.storeInfo().then(function (store) {
                  UI.printHtml(UI.returnReceiptHtml(ret, sale, store));
                  UI.toast(_t('Qaytarıldı: {0} ₼{1}', [M.format(ret.amount), (ret.cashAmount ? _t(' (nağd {0})', [M.format(ret.cashAmount)]) : '')]));
                  root.App.refreshStatus();
                  return S.findSaleByCode(String(sale.receiptNo)).then(show);
                });
              });
            }).catch(function (e) { showErr(e.message); });
          } }, _t('Qaytar'))));
        out.appendChild(errBox);
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
        h('h1', null, _t('Qaytarma')),
        h('div', { class: 'field', style: 'margin-bottom:16px' }, h('label', { for: 'rscan' }, _t('Çekin barkodunu oxudun və ya çek nömrəsini yazın')), scan),
        out));
      scan.focus();
    }).catch(function (e) { el.appendChild(h('div', { class: 'page' }, h('div', { class: 'card empty' }, e.message))); });
  }

  /* ================= Növbə ================= */
  function shift(el) {
    UI.clear(el);
    S.currentShift().then(function (sh) {
      if (!sh) { el.appendChild(h('div', { class: 'page' }, h('div', { class: 'card empty' }, _t('Açıq növbə yoxdur. Kassa ekranından açın.')))); return; }
      return S.shiftReport(sh).then(function (rep) {
        function line(label, v, strong) { return h('div', { style: 'display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line-2)' + (strong ? ';font-weight:700' : '') }, h('span', null, label), h('span', { class: 'mono' }, v)); }
        var counted = h('input', { class: 'input mono', id: 'counted', inputmode: 'decimal', style: 'font-size:22px' });
        var note = h('input', { class: 'input', id: 'cnote' });
        var closeErr = h('div', { class: 'modal-err', role: 'alert', hidden: true });
        var closeBtn = h('button', { class: 'btn dark', id: 'close-shift', onclick: function () {
          var v = M.parse(counted.value);
          closeErr.hidden = true;
          if (v == null) { closeErr.textContent = _t('Sayılmış məbləği yazın'); closeErr.hidden = false; return; }
          if (closeBtn.disabled) return;
          // Server yoxlaması bir neçə saniyə çəkə bilər: düymə dayanır və gözləmə göstərilir
          closeBtn.disabled = true; closeBtn.innerHTML = ''; closeBtn.appendChild(h('span', { class: 'spin', 'aria-hidden': 'true' })); closeBtn.appendChild(document.createTextNode(_t(' Növbə yoxlanılır və bağlanır…')));
          S.closeShift(v, note.value.trim()).then(function (closed) {
            UI.toast(_t('Növbə bağlandı. Fərq: {0} ₼', [M.format(closed.diff)]));
            printZ(closed); root.App.refreshStatus(); shift(el);
          }).catch(function (e) {
            closeErr.textContent = e.message; closeErr.hidden = false; UI.toast(e.message, 'bad');
            closeBtn.disabled = false; closeBtn.textContent = _t('Bağla və Z hesabatı çap et');
            if (/izah/i.test(e.message)) note.focus();
          });
        } }, _t('Bağla və Z hesabatı çap et'));
        el.appendChild(h('div', { class: 'page', style: 'max-width:900px' },
          h('h1', null, _t('Növbə')),
          h('div', { class: 'grid2', style: 'align-items:start' },
            h('div', { class: 'card', style: 'padding:18px 20px' },
              h('div', { class: 'muted', style: 'font-size:14px;margin-bottom:8px' }, _t('Açılıb: {0} · {1}', [UI.fmtDate(sh.openedAt), sh.openedByName])),
              line(_t('Çek sayı'), String(rep.count)), line(_t('Satış (endirimdən əvvəl)'), M.format(rep.gross)), line(_t('Endirim'), M.format(rep.discount)),
              line(_t('Nağd satış'), M.format(rep.cash)), line(_t('POS kart'), M.format(rep.pos)), line(_t('Karta köçürmə'), M.format(rep.transfer)),
              line(_t('Qaytarmalar'), M.format(rep.returns)), line(_t('Kassaya mədaxil'), M.format(rep.cashIn)), line(_t('Kassadan məxaric'), M.format(rep.cashOut)),
              line(_t('Başlanğıc nağd'), M.format(sh.openingCash)), line(_t('Kassada olmalı nağd'), M.format(rep.expectedCash), true)),
            h('div', { class: 'card', style: 'padding:18px 20px;display:flex;flex-direction:column;gap:12px' },
              h('b', null, _t('Növbəni bağla')),
              h('div', { class: 'field' }, h('label', { for: 'counted' }, _t('Sayılmış nağd, ₼')), counted),
              h('div', { class: 'field' }, h('label', { for: 'cnote' }, _t('Fərq varsa izah')), note),
              h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Bank cəmlərini (POS və köçürmə) gün sonu bank çıxarışı ilə tutuşdurun.')),
              closeErr,
              closeBtn,
              h('div', { class: 'row' },
                h('button', { class: 'btn small', onclick: function () { cashMoveForm('in', function () { shift(el); }); } }, _t('Kassaya mədaxil')),
                h('button', { class: 'btn small', onclick: function () { cashMoveForm('out', function () { shift(el); }); } }, _t('Kassadan məxaric')))))));
      });
    });
  }

  function cashMoveForm(type, done) {
    var amt = h('input', { class: 'input mono', id: 'cm-a', inputmode: 'decimal' });
    var reason = h('input', { class: 'input', id: 'cm-r' });
    UI.modal({
      title: type === 'in' ? _t('Kassaya mədaxil') : _t('Kassadan məxaric'),
      body: h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'cm-a' }, _t('Məbləğ, ₼')), amt), h('div', { class: 'field' }, h('label', { for: 'cm-r' }, _t('Səbəb')), reason)),
      buttons: [{ text: _t('İmtina') }, { text: _t('Yadda saxla'), kind: 'primary', submit: true, onClick: function (close) {
        var v = M.parse(amt.value); if (v == null) throw new Error(_t('Məbləğ səhvdir'));
        var go = type === 'out' ? (close(), UI.approve(_t('Məxarici təsdiqlə'), _t('{0} ₼ kassadan çıxarılır: {1}', [M.format(v), reason.value]), 'pos.return.approve',
          UI.req('cash_out', '{0} kassadan məxaric istəyir: {1} ₼ ({2})', [S.currentUser() ? S.currentUser().name : '', M.format(v), reason.value]))) : Promise.resolve(null);
        return go.then(function (a) {
          if (type === 'out' && !a) return;
          return S.cashMove(type, v, reason.value.trim(), a).then(function () { UI.toast(_t('Qeydə alındı')); if (type === 'in') close(); if (!root.App || root.App.route === 'shift') done(); });
        });
      } }]
    });
  }

  function printZ(s) {
    var r = s.report, _t = root.Print.rt(), lang = root.Print.settings().receipt.lang;    // çek interfeys dilindən asılı olmayaraq Çap ayarlarındakı dildə çıxır
    S.storeInfo().then(function (store) {
      var out = '';
      function row(a, b) { out += '<div class="r"><span>' + a + '</span><span>' + b + '</span></div>'; }
      function rowNZ(a, v) { if (v) row(a, M.format(v)); }          // sıfır olan sətirlər çekdə görünmür
      out += '<div class="r"><span>' + _t('Açılış') + '</span><span>' + UI.fmtDate(s.openedAt, lang) + '</span></div><div class="r"><span>' + _t('Bağlanış') + '</span><span>' + UI.fmtDate(s.closedAt, lang) + '</span></div><hr>';
      row(_t('Çek sayı'), String(r.count));
      rowNZ(_t('Satış'), r.gross); rowNZ(_t('Endirim'), r.discount); rowNZ(_t('Nağd'), r.cash); rowNZ(_t('POS kart'), r.pos); rowNZ(_t('Köçürmə'), r.transfer); rowNZ(_t('Qaytarma'), r.returns);
      rowNZ(_t('Kassaya mədaxil'), r.cashIn); rowNZ(_t('Kassadan məxaric'), r.cashOut);
      out += '<hr>';
      rowNZ(_t('Başlanğıc nağd'), s.openingCash);
      row(_t('Gözlənilən nağd'), M.format(s.expectedCash)); row(_t('Sayılmış nağd'), M.format(s.countedCash));
      if (s.diff) row(_t('Fərq'), M.format(s.diff));
      if (s.note) out += '<div>' + _t('İzah') + ': ' + UI.esc(s.note) + '</div>';
      UI.printHtml(UI.receiptWrap('<h3>' + UI.esc(store.name) + '</h3><div class="c"><b>' + _t('Z HESABATI') + '</b></div><hr>' + out));
    });
  }

  /* ================= Çeklər ================= */
  function sales(el) {
    UI.clear(el);
    var tb = h('tbody');
    el.appendChild(h('div', { class: 'page' }, h('h1', null, _t('Çeklər')), h('div', { class: 'card table-wrap', tabindex: '0' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, '№'), h('th', null, _t('Tarix')), h('th', null, _t('Kassir')), h('th', null, _t('Ödəniş')), h('th', { class: 'num' }, _t('Yekun ₼')), h('th', null, ''), h('th', null, ''))), tb))));
    function loadList() { return S.recentSales(100).then(function (list) { UI.clear(tb); fill(list); }); }
    root.Screens._refresh = loadList;
    loadList();
    function fill(list) {
      if (!list.length) tb.appendChild(h('tr', null, h('td', { colspan: '7', class: 'empty' }, _t('Hələ satış yoxdur'))));
      list.forEach(function (s) {
        tb.appendChild(h('tr', null, h('td', { class: 'mono' }, String(s.receiptNo).padStart(6, '0')), h('td', null, UI.fmtDate(s.at)), h('td', null, s.cashierName),
          h('td', null, UI.METHOD[s.payment.method] + (s.payment.bankType ? ' · ' + UI.BANK_TYPE[s.payment.bankType] : '')),
          h('td', { class: 'num' }, M.format(s.totals.total)),
          h('td', null, s.offline ? h('span', { class: 'badge' }, _t('Oflayn')) : null),
          h('td', null, h('button', { class: 'btn small', onclick: function () {
            UI.approve(_t('Dublikat çek'), _t('Çek № {0} "DUBLİKAT" qeydi ilə çap olunur.', [s.receiptNo]), 'pos.return.approve').then(function (a) {
              if (!a) return;
              S.auditEvent('receipt.duplicate', { saleId: s.id, approvedBy: a.id });
              S.storeInfo().then(function (store) { UI.printHtml(UI.receiptHtml(s, store, { duplicate: true })); });
            });
          } }, _t('Dublikat')))));
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
        h('h1', null, _t('Rollar və icazələr')),
        h('p', { class: 'muted' }, _t('Hansı rolun hansı əməliyyata icazəsi olduğunu yalnız Admin dəyişir. Hər dəyişiklik audit jurnalına yazılır.')),
        h('div', { class: 'card table-wrap', tabindex: '0' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, _t('İcazə')), roles.map(function (role) { return h('th', { style: 'text-align:center' }, R.ROLE_NAMES[role]); }))), tb)),
        h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn primary', onclick: function () {
          S.setMatrix(m).then(function () { root.App.matrix = m; UI.toast(_t('İcazələr yadda saxlanıldı')); root.App.renderNav(); }).catch(function (e) { UI.toast(e.message, 'bad'); });
        } }, _t('Yadda saxla'))),
        can('admin.users') ? usersCard() : null,
        settingsCard(r[1])));
    }).catch(function (e) { el.appendChild(h('div', { class: 'page' }, h('div', { class: 'card empty' }, e.message))); });
  }

  function settingsCard(store) {
    function f(id, label, val, attrs) { var i = h('input', Object.assign({ class: 'input', id: id, value: val || '' }, attrs || {})); return { i: i, el: h('div', { class: 'field' }, h('label', { for: id }, label), i) }; }
    var name = f('s-name', _t('Mağaza adı'), store.name), voen = f('s-voen', _t('VÖEN'), store.voen), addr = f('s-addr', _t('Ünvan'), store.address), reg = f('s-reg', _t('Kassa adı'), store.registerName);
    var url = f('s-url', _t('Apps Script veb tətbiq ünvanı'), '', { placeholder: 'https://script.google.com/macros/s/…/exec' });
    var tok = f('s-tok', _t('Sinxron açarı (SYNC_TOKEN)'), '', { type: 'password', autocomplete: 'off', placeholder: _t('Dəyişmək üçün yazın') });
    var info = h('div', { class: 'muted', style: 'font-size:13px', id: 's-info', role: 'status' });
    var conflicts = h('ul', { class: 'conflicts' });
    root.Sync.endpoint().then(function (u) { url.i.value = u; });
    root.DB.get('meta', 'syncToken').then(function (t) { if (t && t.value) tok.i.placeholder = _t('Saxlanılıb · dəyişmək üçün yazın'); });

    function refreshInfo() {
      return Promise.all([root.Sync.endpoint(), S.outboxCount(), S.listConflicts()]).then(function (r) {
        var st = root.Sync.status();
        UI.clear(info);
        info.appendChild(document.createTextNode('Cihaz: ' + String(S.deviceId() || '').slice(-8) + ' · ' + (r[0] ? _t('server qoşulub') : _t('server qoşulmayıb (yalnız bu cihaz)')) +
          (r[1] ? _t(' · göndərilməmiş: {0}', [r[1]]) : '') + (st.lastOk ? _t(' · son sinxron: {0}', [UI.fmtTime(st.lastOk)]) : '')));
        if (st.error) info.appendChild(h('div', { class: 'sync-err', style: 'color:var(--bad)' }, _t('Son xəta: {0}', [st.error])));
        UI.clear(conflicts);
        r[2].slice(-5).forEach(function (c) { conflicts.appendChild(h('li', null, c.message)); });
      });
    }
    refreshInfo();

    function report(r) {
      UI.toast(r.error ? _t('Sinxron alınmadı: {0}', [r.error]) : r.skipped ? _t('Ünvan yoxdur və ya oflayn') : _t('{0} qeyd göndərildi, {1} qeyd alındı', [r.sent, r.received]), r.error ? 'bad' : '');
      root.App.refreshStatus(); return refreshInfo();
    }

    return h('div', { class: 'card', style: 'margin-top:24px;padding:20px;display:flex;flex-direction:column;gap:14px' },
      h('h2', { style: 'margin:0;font-size:18px' }, _t('Mağaza və server')),
      h('div', { class: 'grid2' }, name.el, voen.el, addr.el, reg.el, url.el, tok.el),
      h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Ünvan boşdursa, sistem yalnız bu kompyuterdə işləyir. Hər yeni brauzer/cihaz bir dəfə qoşulmalıdır (giriş ekranında "Bu cihazı serverə qoş").')),
      info, conflicts,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: function () {
          var u = url.i.value.trim();
          var bad = u && root.Sync.checkUrl(u);
          if (bad) return UI.toast(bad, 'bad');
          S.setStoreInfo({ name: name.i.value.trim(), voen: voen.i.value.trim(), address: addr.i.value.trim(), registerName: reg.i.value.trim() })
            .then(function () { return root.Sync.setEndpoint(u, tok.i.value); })
            .then(function () { tok.i.value = ''; UI.toast(_t('Yadda saxlanıldı')); return root.Sync.cycle(); })
            .then(report)
            .catch(function (e) { UI.toast(e.message, 'bad'); });
        } }, _t('Yadda saxla')),
        h('button', { class: 'btn', onclick: function () {
          root.Sync.test().then(function (msg) { UI.toast(msg); }).catch(function (e) { UI.toast(e.message, 'bad'); });
        } }, _t('Bağlantını yoxla')),
        h('button', { class: 'btn', onclick: function () { root.Sync.cycle().then(report); } }, _t('İndi sinxronlaşdır'))));
  }

  // Admin: istifadəçilər — yaratmaq, ad/rol dəyişmək, söndürmək, PIN sıfırlamaq
  function usersCard() {
    var tb = h('tbody');
    var ROLE_ORDER = ['admin', 'menecer', 'kassir', 'muhasib'];
    var me = S.currentUser();

    function tempPinModal(title, name, temp) {
      UI.modal({ title: title, body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
        h('div', { class: 'pin-reset', id: 'temp-pin' }, temp),
        h('p', { class: 'muted', style: 'margin:0' }, _t('{0} üçün müvəqqəti PIN bir dəfə göstərilir. İndi ötürün: ilk girişdə özünün yeni PIN-ini seçəcək.', [name]))) });
    }

    function load() {
      return S.listAllUsers().then(function (users) {
        users.sort(function (a, b) {
          return (b.active - a.active) || (ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)) || a.name.localeCompare(b.name, 'az');
        });
        UI.clear(tb);
        users.forEach(function (u) {
          var state = !u.active ? h('span', { class: 'badge off' }, _t('Söndürülüb')) : u.mustChangePin ? h('span', { class: 'badge' }, _t('PIN dəyişməlidir')) : h('span', { class: 'badge ok' }, _t('Aktiv'));
          var isMe = me && u.id === me.id;
          tb.appendChild(h('tr', { 'data-user': u.name, class: u.active ? '' : 'inactive' },
            h('td', null, u.name, isMe ? h('span', { class: 'muted' }, ' (siz)') : null), h('td', null, R.ROLE_NAMES[u.role]), h('td', null, state),
            h('td', { style: 'text-align:right;white-space:nowrap' },
              h('button', { class: 'btn small', type: 'button', 'data-act': 'edit', onclick: function () { edit(u); } }, _t('Redaktə')), ' ',
              u.active ? h('button', { class: 'btn small', type: 'button', 'data-act': 'reset', onclick: function () { resetPin(u); } }, _t('PIN-i sıfırla')) : null, ' ',
              isMe ? null : h('button', { class: 'btn small' + (u.active ? ' danger' : ''), type: 'button', 'data-act': 'toggle', onclick: function () { toggle(u); } }, u.active ? _t('Söndür') : _t('Aktiv et')))));
        });
      });
    }

    function roleSelect(val) {
      var sel = h('select', { class: 'input', id: 'u-role' }, ROLE_ORDER.map(function (r) { return h('option', { value: r, selected: r === val }, R.ROLE_NAMES[r]); }));
      return sel;
    }

    function create() {
      var name = h('input', { class: 'input', id: 'u-name', maxlength: '40', autocomplete: 'off', placeholder: _t('Məs. Elvin Babayev') });
      var role = roleSelect('kassir');
      UI.modal({
        title: _t('Yeni istifadəçi'),
        body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
          h('div', { class: 'field' }, h('label', { for: 'u-name' }, _t('Ad və soyad')), name),
          h('div', { class: 'field' }, h('label', { for: 'u-role' }, _t('Rol')), role),
          h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Müvəqqəti PIN yaradılacaq; istifadəçi ilk girişdə öz PIN-ini seçir.'))),
        buttons: [{ text: _t('İmtina') }, { text: _t('Yarat'), kind: 'primary', submit: true, onClick: function (close) {
          return S.createUser({ name: name.value, role: role.value }).then(function (r) {
            close(); load();
            tempPinModal(_t('İstifadəçi yaradıldı'), r.user.name, r.tempPin);
          });
        } }]
      });
    }

    function edit(u) {
      var name = h('input', { class: 'input', id: 'u-name', maxlength: '40', autocomplete: 'off', value: u.name });
      var role = roleSelect(u.role);
      if (me && u.id === me.id) role.disabled = true;           // öz rolunu dəyişmək Admini sistemdən kənarlaşdıra bilər
      UI.modal({
        title: _t('Redaktə — {0}', [u.name]),
        body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
          h('div', { class: 'field' }, h('label', { for: 'u-name' }, _t('Ad və soyad')), name),
          h('div', { class: 'field' }, h('label', { for: 'u-role' }, _t('Rol')), role),
          me && u.id === me.id ? h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Öz rolunuzu dəyişə bilməzsiniz.')) :
            h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Rol dəyişəndə istifadəçinin açıq cihazında menyu və icazələr bir neçə saniyəyə yenilənir.'))),
        buttons: [{ text: _t('İmtina') }, { text: _t('Yadda saxla'), kind: 'primary', submit: true, onClick: function (close) {
          return S.updateUser(u.id, { name: name.value, role: role.value }).then(function (r) {
            close(); load(); UI.toast(r.unchanged ? _t('Dəyişiklik yoxdur') : _t('Yadda saxlanıldı'));
            root.App.refreshStatus();
          });
        } }]
      });
    }

    function toggle(u) {
      var off = u.active;
      UI.modal({
        title: (off ? _t('Söndür') : _t('Aktiv et')) + ' — ' + u.name,
        body: h('p', { style: 'margin:0' }, off ? _t('İstifadəçi artıq daxil ola bilməyəcək, açıq cihazlarda isə bir neçə saniyəyə çıxış edəcək. Keçmiş çeklər və hesabatlar saxlanılır.') : _t('İstifadəçi yenidən daxil ola biləcək (PIN dəyişməyibsə köhnə PIN ilə).')),
        buttons: [{ text: _t('İmtina') }, { text: off ? _t('Söndür') : _t('Aktiv et'), kind: off ? 'danger' : 'primary', submit: true, onClick: function (close) {
          return S.updateUser(u.id, { active: !off }).then(function () { close(); load(); UI.toast(off ? _t('Söndürüldü') : _t('Aktiv edildi')); });
        } }]
      });
    }

    function resetPin(u) {
      UI.modal({
        title: _t('PIN-i sıfırla — {0}', [u.name]),
        body: h('p', { style: 'margin:0' }, _t('Müvəqqəti PIN yaradılacaq. İstifadəçi ilk girişdə özünün yeni PIN-ini seçəcək. Köhnə PIN dərhal etibarsız olur.')),
        buttons: [{ text: _t('İmtina') }, { text: _t('Sıfırla'), kind: 'danger', submit: true, onClick: function (close) {
          return S.resetPin(u.id).then(function (temp) { close(); tempPinModal(_t('Müvəqqəti PIN'), u.name, temp); load(); });
        } }]
      });
    }

    load();
    root.Screens._refresh = load;     // başqa cihazdan istifadəçi dəyişikliyi gələndə siyahı yenilənir
    return h('div', { class: 'card table-wrap', tabindex: '0', style: 'margin-top:24px', id: 'users-card' },
      h('div', { style: 'padding:16px 20px 0;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap' },
        h('h2', { style: 'margin:0;font-size:18px' }, _t('İstifadəçilər')),
        h('button', { class: 'btn primary small', type: 'button', id: 'user-add', onclick: create }, _t('+ Yeni istifadəçi'))),
      h('table', null, h('thead', null, h('tr', null, h('th', null, _t('Ad')), h('th', null, _t('Rol')), h('th', null, _t('Vəziyyət')), h('th', null, ''))), tb));
  }

  root.Screens = { login: login, forcePinChange: forcePinChange, products: products, suppliers: suppliers, returns: returns, shift: shift, sales: sales, admin: admin,
    pendingForMe: pendingForMe, approvalsModal: approvalsModal, _refresh: null };
})(window);
