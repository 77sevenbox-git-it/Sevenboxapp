/* Digər ekranlar: giriş, məhsullar, qaytarma, növbə, çeklər, admin. */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var UI = root.UI, S = root.Services, M = root.Money, R = root.Rules;
  var h = UI.h;

  function can(perm) { var u = S.currentUser(); return !!(u && root.App.matrix && R.can(root.App.matrix, u.role, perm)); }

  /* ================= Giriş ================= */
  // opts.approvals: bildiriş kliki ilə açılıb, gözləyən sorğular (yalnız oxumaq üçün) göstərilir
  function login(el, opts, onDone) {
    if (typeof opts === 'function') { onDone = opts; opts = {}; }
    opts = opts || {};
    UI.clear(el);
    var chosen = null;
    var pin = h('input', { class: 'input mono', type: 'password', inputmode: 'numeric', id: 'pin', maxlength: '8', autocomplete: 'off', style: 'font-size:22px' });
    var pinLabel = h('label', { for: 'pin' }, _t('PIN'));
    var creds = {};          // istifadəçi id → hazırkı giriş forması ('pin' | 'password')
    // Seçilmiş istifadəçinin hazırkı formasına görə sahə: PIN (rəqəm klaviaturası, ≤8) və ya şifrə (mətn klaviaturası, uzunluq limiti yoxdur)
    function setForm(cred) {
      var pw = cred === 'password';
      pin.setAttribute('inputmode', pw ? 'text' : 'numeric');
      if (pw) pin.removeAttribute('maxlength'); else pin.setAttribute('maxlength', '8');
      pinLabel.textContent = pw ? _t('Şifrə') : _t('PIN');
      pin.value = '';
    }
    var list = h('div', { class: 'users', role: 'group', 'aria-label': _t('İstifadəçi') });
    var foot = h('div', { class: 'muted', style: 'font-size:13px' });
    var submitBtn = h('button', { class: 'btn primary', type: 'submit' }, _t('Daxil ol'));
    // Kassir cihazda həmişə açıq qalır (növbə boyu); digər rollar yalnız "bu mənim cihazımdır" seçsələr (FR-106)
    var remember = h('input', { type: 'checkbox', id: 'remember-dev' });
    var rememberRow = h('label', { class: 'check-row', hidden: true }, remember, h('span', null, _t('Bu mənim cihazımdır: tətbiqi bağlayıb açanda çıxış olmasın')));
    var roles = {};
    // Gözləyən təsdiq sorğuları (bildirişə klik): kod soruşulmadan görünür, təsdiq üçün aşağıda daxil olmaq lazımdır
    var gate = h('div', { class: 'card gate', id: 'approval-gate', hidden: true });
    if (opts.approvals) {
      S.listPendingApprovals().then(function (reqs) {
        if (!reqs.length) return;
        gate.hidden = false;
        gate.appendChild(h('h2', { style: 'margin:0;font-size:18px' }, _t('Təsdiq sorğusu gözləyir')));
        reqs.slice(0, 5).forEach(function (a) {
          gate.appendChild(h('div', { class: 'gate-item' }, h('div', null, UI.reqText(a)), h('div', { class: 'muted', style: 'font-size:13px' }, a.requestedBy.name + ' · ' + UI.fmtTime(a.at))));
        });
        gate.appendChild(h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Təsdiq etmək və ya rədd etmək üçün aşağıda daxil olun.')));
      }).catch(function () { /* vacib deyil */ });
    }
    var form = h('form', { class: 'card' },
      h('div', { class: 'lang-row' }, UI.langSwitch()),
      h('div', null, h('div', { class: 'muted', style: 'font-size:14px' }, h('b', { class: 'wordmark' }, '7BOXS'), ' · ', _t('Mağaza idarəetmə sistemi')), h('h1', { style: 'margin:4px 0 0;font-size:24px' }, _t('Daxil olun'))),
      list,
      h('div', { class: 'field' }, pinLabel, pin),
      rememberRow,
      submitBtn,
      foot);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!chosen) return UI.toast(_t('İstifadəçini seçin'), 'bad');
      // Səhv PIN-də PIN-in başqa cihazda dəyişib-dəyişmədiyi serverdən yoxlanılır (2–3 san): bu müddətdə düymə "Yoxlanılır…" göstərir
      submitBtn.disabled = true; submitBtn.textContent = _t('Yoxlanılır…');
      function ready() { submitBtn.disabled = false; submitBtn.textContent = _t('Daxil ol'); }
      S.login(chosen, pin.value, { remember: !rememberRow.hidden && remember.checked }).then(function (u) {
        pin.value = ''; ready();
        try { root.localStorage.setItem('mag.lastUser', u.id); } catch (e) { /* yaddaş bağlıdırsa davam */ }
        onDone(u);
      }).catch(function (err) {
        ready(); pin.value = ''; pin.focus(); UI.toast(err.message, 'bad');
        // Giriş forması başqa cihazda dəyişmiş ola bilər (PIN ↔ şifrə): siyahı yenilənir ki, sahə düzgün növdə olsun
        S.listUsers().then(function (us) { us.forEach(function (x) { creds[x.id] = x.cred; }); if (chosen && creds[chosen]) { var was = pinLabel.textContent; setForm(creds[chosen]); if (pinLabel.textContent !== was) UI.toast(_t('Bu istifadəçinin giriş forması dəyişib. Yeni formada yazın'), 'bad'); } });
      });
    });
    S.listUsers().then(function (users) {
      var last = null; try { last = root.localStorage.getItem('mag.lastUser'); } catch (e) { last = null; }
      var lastBtn = null;
      users.forEach(function (u) {
        creds[u.id] = u.cred; roles[u.id] = u.role;
        var b = h('button', { type: 'button', 'aria-pressed': 'false', onclick: function () {
          chosen = u.id; Array.prototype.forEach.call(list.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); }); setForm(creds[u.id]);
          rememberRow.hidden = u.role === 'kassir'; pin.focus();
        } }, u.name, h('small', null, R.ROLE_NAMES[u.role]));
        list.appendChild(b);
        if (u.id === last) lastBtn = b;
      });
      if (lastBtn) lastBtn.click();       // bu cihazda sonuncu daxil olan seçilir: yalnız PIN yazmaq qalır
    });
    // Yeni cihaz: serverə qoşulub istifadəçiləri və məlumatı yükləmək. Qoşulubsa, dəyişmək yalnız Admin üçün (İcazələr bölməsi).
    root.Sync.endpoint().then(function (url) {
      if (url) { foot.textContent = _t('Server qoşulub · istifadəçilər və məlumat avtomatik yenilənir'); return; }
      foot.appendChild(h('button', { type: 'button', class: 'btn small', id: 'connect-btn', onclick: function () { connectForm(function () { login(el, opts, onDone); }); } }, _t('Bu cihazı serverə qoş')));
      foot.appendChild(h('div', { style: 'margin-top:6px' }, _t('Başqa cihazda artıq işləyirsinizsə, bunu edin: istifadəçilər, məhsullar və çeklər oradan yüklənəcək.')));
    });
    el.appendChild(h('div', { class: 'login' }, h('div', { class: 'login-col' }, gate, form)));
  }

  function connectForm(done) {
    var url = h('input', { class: 'input', id: 'c-url', placeholder: 'https://script.google.com/macros/s/…/exec', autocomplete: 'off' });
    var tok = h('input', { class: 'input', id: 'c-tok', type: 'password', autocomplete: 'off' });
    var msg = h('p', { class: 'muted', style: 'margin:0;font-size:13px', role: 'status' }, _t('Ünvanı və bu cihaz üçün Admin-in verdiyi açarı yazın. Məlumat serverdən yüklənəcək, bir neçə saniyə çəkə bilər.'));
    UI.modal({
      title: _t('Bu cihazı serverə qoş'),
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'field' }, h('label', { for: 'c-url' }, _t('Apps Script veb tətbiq ünvanı')), url),
        h('div', { class: 'field' }, h('label', { for: 'c-tok' }, _t('Sinxron açarı')), tok), msg,
        deviceIdLine()),
      buttons: [{ text: _t('İmtina') }, { text: _t('Qoş və yüklə'), kind: 'primary', submit: true, onClick: function (close) {
        msg.textContent = _t('Yoxlanılır və yüklənir…');
        return root.Sync.connect(url.value, tok.value).then(function (r) {
          UI.toast(_t('Qoşuldu · {0} qeyd yükləndi', [r.received]));
          close(); done();
        }).catch(function (e) { msg.textContent = e.message; throw e; });
      } }]
    });
  }

  // Məcburi kod dəyişməsi: ilk giriş, Admin müvəqqəti kod verib, və ya rolun giriş forması dəyişib (PIN ↔ şifrə). Tam səhifədir, arxa fonda heç bir iş ekranı yoxdur.
  // true = kod dəyişdi, false = çıxış.
  function forcePinChange(el) {
    return S.myCredTarget().then(function (tg) { return new Promise(function (resolve) {
      var toPw = tg.form === 'password', fromPw = tg.current === 'password';
      UI.clear(el);
      function field(id, pw) { return h('input', { class: 'input mono', type: 'password', id: id, inputmode: pw ? 'text' : 'numeric', maxlength: pw ? null : '8', autocomplete: 'off' }); }
      var o = field('op', fromPw), n1 = field('np1', toPw), n2 = field('np2', toPw);
      var form = h('form', { class: 'card' },
        h('div', null, h('div', { class: 'muted', style: 'font-size:14px' }, S.currentUser().name), h('h1', { style: 'margin:4px 0 0;font-size:24px' }, toPw ? _t('Yeni şifrə təyin edin') : _t('Yeni PIN təyin edin'))),
        h('p', { class: 'muted', style: 'margin:0' }, toPw ? _t('İşə başlamazdan əvvəl yalnız sizə məlum olan şifrə seçin: ən azı {0} simvol, 1 böyük hərf, 1 kiçik hərf, 1 rəqəm və 1 işarə.', [R.PASSWORD_MIN]) : _t('İşə başlamazdan əvvəl yalnız sizə məlum olan 4–8 rəqəmli PIN seçin.')),
        tg.current !== tg.form ? h('p', { class: 'muted', id: 'form-changed', style: 'margin:0' }, _t('Administrator bu rol üçün giriş formasını dəyişib. Hazırkı kodunuzla daxil oldunuz, indi yenisini seçin.')) : null,
        h('div', { class: 'field' }, h('label', { for: 'op' }, fromPw ? _t('Hazırkı şifrə') : _t('Hazırkı PIN')), o),
        h('div', { class: 'field' }, h('label', { for: 'np1' }, toPw ? _t('Yeni şifrə') : _t('Yeni PIN')), n1),
        h('div', { class: 'field' }, h('label', { for: 'np2' }, toPw ? _t('Yeni şifrə təkrar') : _t('Yeni PIN təkrar')), n2),
        h('button', { class: 'btn primary', type: 'submit' }, _t('Saxla və davam et')),
        h('button', { class: 'btn', type: 'button', id: 'pin-logout', onclick: function () { S.logout(); resolve(false); } }, _t('Çıxış')));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (n1.value !== n2.value) return UI.toast(toPw ? _t('Yeni şifrələr eyni deyil') : _t('Yeni PIN-lər eyni deyil'), 'bad');
        S.changeCredential(o.value, n1.value).then(function () { UI.toast(toPw ? _t('Şifrə dəyişdirildi') : _t('PIN dəyişdirildi')); resolve(true); })
          .catch(function (err) { UI.toast(err.message, 'bad'); });
      });
      el.appendChild(h('div', { class: 'login' }, form));
      o.focus();
    }); });
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
    var canImport = can('product.edit') && can('product.price.set') && can('stock.receive');          // toplu yükləmə: Menecer və Admin (AS-43)
    var myBox = h('div', { class: 'card', id: 'my-requests', style: 'margin-top:16px;display:none' });
    var q = h('input', { class: 'input', id: 'pq', type: 'search', placeholder: _t('Ad, mağaza və ya istehsalçı barkodu'), style: 'min-width:min(280px, 100%)' });
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
      var toks = R.foldAz(q.value).split(/\s+/).filter(Boolean);       // hərf fərqi və Azərbaycan hərfləri nəzərə alınmır; hər söz tapılmalıdır
      UI.clear(body);
      var list = all.filter(function (p) {
        if (!toks.length) return true;
        var hay = R.foldAz([p.name, p.brand, p.category, p.ageGroup, p.storeBarcode, p.mfrBarcode].join(' '));
        return toks.every(function (t) { return hay.indexOf(t) !== -1; });
      });
      if (!list.length) body.appendChild(h('tr', null, h('td', { colspan: showCost ? '9' : '8', class: 'empty' }, all.length ? _t('Uyğun məhsul yoxdur') : _t('Hələ məhsul yoxdur'))));
      list.forEach(function (p) {
        var low = p.stock <= (p.minStock || 0);
        body.appendChild(h('tr', null,
          h('td', null, h('div', { class: 'pname' }, UI.thumb(p, 36), h('div', { class: 'ptext' }, h('div', null, p.name),
            h('div', { class: 'muted', style: 'font-size:13px' }, [p.category, p.ageGroup, p.maxDiscount > 0 ? _t('max endirim {0}%', [p.maxDiscount]) : ''].filter(Boolean).join(' · '))))),
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
          canImport ? h('button', { class: 'btn', id: 'imp-open', type: 'button', onclick: function () { importModal(load); } }, _t('Excel-dən yüklə')) : null,
          can('product.edit') ? h('button', { class: 'btn primary', onclick: function () { productForm(null, load); } }, _t('Yeni məhsul')) : null)),
      h('div', { class: 'card table-wrap', tabindex: '0' }, h('table', { class: 'cards' },
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
      min: inp('f-min', _t('Minimum qalıq'), p ? p.minStock : 0, { type: 'number', min: '0' }),
      maxd: inp('f-maxd', _t('Bu məhsula max endirim, %'), p && p.maxDiscount ? p.maxDiscount : 0, { type: 'number', min: '0', max: '100', step: '0.5', inputmode: 'decimal', disabled: !canPrice })
    };
    var active = h('input', { type: 'checkbox', id: 'f-active', checked: !p || p.active });

    // Şəkil: kamera və ya qalereya. Kiçildilib məhsulun özündə saxlanır; kassada sətrin solunda ikon kimi görünür, çekdə çap olunmur.
    var image = p && R.safeImage(p.image) ? p.image : '';
    var preview = h('div', { id: 'f-img-prev' });
    var shoot = h('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'f-img-cam', hidden: true });
    var pick = h('input', { type: 'file', accept: 'image/*', id: 'f-img-file', hidden: true });
    var imgErr = h('div', { class: 'muted', style: 'font-size:13px;color:var(--bad)', hidden: true, role: 'alert' });
    var rmBtn = h('button', { class: 'btn small', type: 'button', id: 'f-img-rm', onclick: function () { image = ''; drawImg(); } }, _t('Şəkli sil'));
    function drawImg() {
      UI.clear(preview); preview.appendChild(UI.thumb({ name: f.name.input.value, image: image }));
      rmBtn.hidden = !image;
    }
    function onFile(inp) {
      var file = inp.files && inp.files[0]; inp.value = '';
      if (!file) return;
      imgErr.hidden = true;
      UI.shrinkImage(file).then(function (url) { image = url; drawImg(); })
        .catch(function (e) { imgErr.textContent = e.message; imgErr.hidden = false; });
    }
    shoot.addEventListener('change', function () { onFile(shoot); });
    pick.addEventListener('change', function () { onFile(pick); });
    f.name.input.addEventListener('input', function () { if (!image) drawImg(); });
    drawImg();
    var imgBox = h('div', { class: 'field' }, h('label', null, _t('Məhsulun şəkli')),
      h('div', { class: 'imgpick' }, preview,
        h('div', { style: 'display:flex;flex-direction:column;gap:8px;align-items:flex-start' },
          h('div', { class: 'row' },
            h('button', { class: 'btn small', type: 'button', id: 'f-img-take', onclick: function () { shoot.click(); } }, _t('Şəkil çək')),
            h('button', { class: 'btn small', type: 'button', id: 'f-img-choose', onclick: function () { pick.click(); } }, _t('Qalereyadan seç')), rmBtn),
          h('span', { class: 'muted', style: 'font-size:13px' }, _t('Kassada məhsul sətrinin solunda ikon kimi görünür. Çekdə çap olunmur.')), imgErr),
        shoot, pick));

    var body = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      imgBox,
      h('div', { class: 'grid2' }, f.name.el, f.category.el, f.brand.el, f.age.el, f.mfr.el, f.price.el, f.cost && f.cost.el, f.min.el, f.maxd.el),
      h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Max endirim: kassir bu məhsula bundan çox endirim edə bilməz (0 = endirim verilmir). Endirim yenə menecer təsdiqi ilə olur.')),
      !canPrice ? h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Satış qiymətini yalnız Menecer və Admin təyin edir.')) : null,
      p ? h('p', { class: 'muted', style: 'margin:0' }, _t('Mağaza barkodu: '), h('span', { class: 'mono' }, p.storeBarcode), _t(' (dəyişmir)')) : h('p', { class: 'muted', style: 'margin:0' }, _t('Mağaza barkodu yadda saxlayanda avtomatik veriləcək.')),
      p ? h('label', { style: 'display:flex;gap:8px;align-items:center' }, active, _t('Satışda aktivdir')) : null);

    UI.modal({
      title: isNew ? _t('Yeni məhsul') : _t('Məhsulu dəyiş'), wide: true, body: body,
      buttons: [{ text: _t('İmtina') }, { text: _t('Yadda saxla'), kind: 'primary', submit: true, onClick: function (close) {
        var price = M.parse(f.price.input.value);
        if (price == null) throw new Error(_t('Satış qiyməti səhvdir'));
        var data = { name: f.name.input.value, category: f.category.input.value.trim(), brand: f.brand.input.value.trim(), ageGroup: f.age.input.value.trim(),
          mfrBarcode: f.mfr.input.value.trim(), price: price, minStock: parseInt(f.min.input.value, 10) || 0, image: image };
        // Max endirim yalnız qiymət təyin edə bilən rolda dəyişir; başqası forma göndərəndə dəyər toxunulmaz qalır
        if (canPrice) {
          var md = f.maxd.input.value.trim() === '' ? 0 : Number(String(f.maxd.input.value).replace(',', '.'));
          var mdBad = R.maxDiscountProblem(md); if (mdBad) throw new Error(mdBad);
          data.maxDiscount = md;
        }
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

  /* ---------- Excel / CSV-dən toplu yükləmə (FR-113) ---------- */
  function blobDownload(name, blob) {
    var a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function importModal(onDone) {
    var Imp = root.Import, showCost = can('product.cost.view');
    var file = h('input', { type: 'file', id: 'imp-file', accept: '.xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var dup = h('input', { type: 'checkbox', id: 'imp-dup' });
    var dupRow = h('label', { class: 'check-row', hidden: true }, dup, h('span', null, _t('Təkrar sətirləri də yüklə (eyni ad və istehsalçı barkodu ilə məhsul artıq var)')));
    var out = h('div', { id: 'imp-out', 'aria-live': 'polite' });
    var existing = [], res = null, goBtn = null;
    function fieldLabel(k) { return { name: _t('Ad *'), price: _t('Satış qiyməti *') }[k] || k; }
    function say(text, cls) { UI.clear(out); out.appendChild(h('p', { class: cls || 'muted', role: cls ? 'alert' : null, style: 'margin:0' }, text)); }

    function setGo() {
      var n = res && !res.empty && !res.tooMany && !res.missing.length ? Imp.summary(res.rows).new : 0;
      if (!goBtn) return;
      goBtn.disabled = !n; goBtn.textContent = n ? _t('{0} məhsulu yüklə', [n]) : _t('Yüklə');
    }

    function draw() {
      if (!res) return;
      UI.clear(out); dupRow.hidden = true;
      if (res.empty) return say(_t('Faylda məlumat tapılmadı'), 'warn-text');
      if (res.missing.length) return say(_t('Məcburi sütun tapılmadı: {0}. Şablonu yükləyib başlıqları yoxlayın', [res.missing.map(fieldLabel).join(', ')]), 'warn-text');
      if (res.tooMany) return say(_t('Faylda {0}-dən çox məhsul sətri var. Faylı hissələrə bölüb ayrı-ayrı yükləyin', [Imp.MAX_ROWS]), 'warn-text');
      Imp.classify(res.rows, existing, dup.checked);
      var sm = Imp.summary(res.rows);
      dupRow.hidden = !res.rows.some(function (d) { return d.dup; });
      out.appendChild(h('div', { class: 'imp-sum' },
        h('span', { class: 'badge ok' }, _t('Yüklənəcək: {0}', [sm.new])),
        sm.skip ? h('span', { class: 'badge off' }, _t('Atlanacaq: {0}', [sm.skip])) : null,
        sm.error ? h('span', { class: 'badge bad' }, _t('Səhvli: {0}', [sm.error])) : null,
        sm.opening ? h('span', { class: 'badge' }, _t('Açılış qalığı ilə: {0}', [sm.opening])) : null));
      if (res.unknown.length) out.appendChild(h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:13px' }, _t('Tanınmayan sütunlar (yüklənmir): {0}', [res.unknown.join(', ')])));
      var STATUS = { new: [_t('Yüklənəcək'), 'ok'], skip: [_t('Atlanacaq'), 'off'], error: [_t('Səhv'), 'bad'] };
      out.appendChild(h('div', { class: 'table-wrap imp-table', tabindex: '0' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, _t('Məhsul')), h('th', { class: 'num' }, _t('Satış ₼')), showCost ? h('th', { class: 'num' }, _t('Alış ₼')) : null,
          h('th', null, _t('İstehsalçı barkodu')), h('th', { class: 'num' }, _t('Qalıq')), h('th', null, _t('Nəticə')))),
        h('tbody', null, res.rows.map(function (d) {
          var st = STATUS[d.status], msgs = d.errors.concat(d.notes || [], d.warnings);
          return h('tr', { 'data-line': String(d.line), 'data-state': d.status },
            h('td', { class: 'muted' }, String(d.line)), h('td', null, d.name),
            h('td', { class: 'num' }, d.price != null ? M.format(d.price) : ''), showCost ? h('td', { class: 'num muted' }, d.cost ? M.format(d.cost) : '') : null,
            h('td', { class: 'mono' }, d.mfrBarcode), h('td', { class: 'num' }, d.opening ? String(d.opening) : ''),
            h('td', null, h('span', { class: 'badge ' + st[1] }, st[0]), msgs.map(function (m) { return h('div', { class: 'muted', style: 'font-size:12px' }, m); })));
        })))));
    }

    function pick() {
      var f = file.files && file.files[0]; if (!f) return;
      dup.checked = false; res = null; setGo(); say(_t('Fayl oxunur…'));
      Promise.all([Imp.readFile(f), S.listProducts()]).then(function (r) {
        existing = r[1];
        res = Imp.mapRows(r[0], { validate: S.validateProductInput, canCost: showCost });
        draw(); setGo();
      }).catch(function (e) { res = null; setGo(); say(e.message || String(e), 'warn-text'); });
    }
    file.addEventListener('change', pick);
    dup.addEventListener('change', function () { draw(); setGo(); });

    var body = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('p', { class: 'muted', style: 'margin:0;font-size:14px' }, _t('Fayl .xlsx və ya .csv olmalıdır, ilk sətir başlıqdır, ən çox {0} sətir. Ad və satış qiyməti məcburidir. Mağaza barkodları avtomatik verilir.', [Imp.MAX_ROWS])),
      h('p', { class: 'muted', style: 'margin:0;font-size:14px' }, _t('"Açılış qalığı" sütunu doldurulubsa qalıq təchizatçısız yazılır: təchizatçı borcu yaranmır. İstehsalçı barkodunu Excel-də "Mətn" formatında yazın (uzun rəqəmlər elmi yazıya keçməsin).')),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', id: 'imp-tpl', onclick: function () {
          blobDownload('mehsullar-sablon.xlsx', new Blob([Imp.templateXlsx()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        } }, _t('Şablonu yüklə (.xlsx)')),
        h('label', { class: 'sr-only', for: 'imp-file' }, _t('Fayl seçin')), file),
      dupRow, out);

    var m = UI.modal({
      title: _t('Məhsulları Excel-dən yüklə'), wide: true, noGuard: true, body: body,
      buttons: [{ text: _t('İmtina') }, { text: _t('Yüklə'), kind: 'primary', submit: true, onClick: function (close) {
        if (!res) throw new Error(_t('Fayl seçin'));
        var sm = Imp.summary(res.rows);
        return S.importProducts(res.rows).then(function (r) {
          UI.toast(_t('{0} məhsul yükləndi, {1}-də açılış qalığı yazıldı', [r.created, r.opening]));
          if (sm.skip || sm.error) UI.toast(_t('Atlandı: {0}, səhvli: {1}', [sm.skip, sm.error]), 'warn');
          close(); onDone();
        });
      } }]
    });
    goBtn = m.el.querySelector('.foot button[type=submit]'); if (goBtn) goBtn.disabled = true;
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

  // "1 250,50" / "-300" → qəpik (mənfi ola bilər: avans). Boş = 0, səhv = null
  function parseSigned(v) {
    v = String(v == null ? '' : v).trim(); if (!v) return 0;
    var neg = /^[-−–]/.test(v), m = M.parse(v.replace(/^[-−–]\s*/, ''));
    return m == null ? null : (neg ? -m : m);
  }

  // Təchizatçı əlavə etmək / dəyişmək. onDone(supplier). Borc əsası və açılış borcu yalnız "supplier.pay" icazəsi olana göstərilir.
  function supplierForm(sp, onDone) {
    var name = h('input', { class: 'input', id: 'sp-name', maxlength: '60', autocomplete: 'off', value: sp ? sp.name : '', placeholder: _t('Şirkət və ya şəxs adı') });
    var phone = h('input', { class: 'input', id: 'sp-phone', maxlength: '40', autocomplete: 'off', value: sp ? sp.phone : '' });
    var note = h('input', { class: 'input', id: 'sp-note', maxlength: '300', autocomplete: 'off', value: sp ? sp.note : '', placeholder: _t('VÖEN, ünvan, şərtlər…') });
    var canDebt = can('supplier.pay'), cur = sp ? (sp.debtBasis || 'received') : 'received';
    var basis = canDebt ? h('select', { class: 'input', id: 'sp-basis' },
      h('option', { value: 'received', selected: cur === 'received' }, _t('Alınan mal (təchizatçıdan gələn)')), h('option', { value: 'sold', selected: cur === 'sold' }, _t('Satılan mal (yalnız satılan hissə)'))) : null;
    var open = canDebt ? h('input', { class: 'input mono', id: 'sp-open', inputmode: 'decimal', autocomplete: 'off', value: sp && sp.openingDebt ? M.format(sp.openingDebt) : '' }) : null;
    UI.modal({
      title: sp ? _t('Təchizatçını dəyiş') : _t('Yeni təchizatçı'),
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'field' }, h('label', { for: 'sp-name' }, _t('Ad *')), name),
        h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'sp-phone' }, _t('Telefon')), phone), h('div', { class: 'field' }, h('label', { for: 'sp-note' }, _t('Qeyd')), note)),
        canDebt ? h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'sp-basis' }, _t('Borc nəyə görə hesablanır')), basis), h('div', { class: 'field' }, h('label', { for: 'sp-open' }, _t('Açılış borcu, ₼')), open)) : null,
        canDebt ? h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Açılış borcu — sistemdən əvvəl təchizatçıya olan borc (avans üçün mənfi yazın). Əsası sonradan dəyişmək keçmiş borcu da yenidən hesablayır.')) : null),
      buttons: [{ text: _t('İmtina') }, { text: _t('Yadda saxla'), kind: 'primary', submit: true, onClick: function (close) {
        var d = { name: name.value, phone: phone.value, note: note.value };
        if (canDebt) {
          var ov = parseSigned(open.value); if (ov == null) throw new Error(_t('Açılış borcu səhvdir'));
          d.debtBasis = basis.value; d.openingDebt = ov;
        }
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

  /* ================= Təchizatçı hesabı: borc, ödəniş, hesabat sənədi ================= */
  function debtLine(v) { return v < 0 ? M.format(-v) + ' ₼ (' + _t('avans') + ')' : M.format(v) + ' ₼'; }

  // Ödəniş formu. Nağd olarsa məbləğ AÇIQ növbənin kassasından çıxır; borcdan çox yazılsa əvvəl təsdiq tələb olunur.
  function payForm(sp, debt, done) {
    var amt = h('input', { class: 'input mono', id: 'pay-a', inputmode: 'decimal', autocomplete: 'off' });
    var method = h('select', { class: 'input', id: 'pay-m' }, h('option', { value: 'cash' }, _t('Nağd (kassadan çıxır)')), h('option', { value: 'bank' }, _t('Bank köçürməsi (kassaya toxunmur)')));
    var note = h('input', { class: 'input', id: 'pay-n', maxlength: '200', autocomplete: 'off', placeholder: _t('məs. 12 oktyabr üçün') });
    var over = h('input', { type: 'checkbox', id: 'pay-over' });
    var overRow = h('label', { class: 'warn-text', style: 'display:flex;gap:8px;align-items:center', hidden: true }, over, _t('Borcdan çox ödənişi (avans) təsdiqləyirəm'));
    var hint = h('p', { class: 'muted', style: 'margin:0;font-size:13px', role: 'status' });
    function sync() { hint.textContent = method.value === 'cash' ? _t('Məbləğ açıq növbənin kassasından çıxır: kassada olmalı nağd azalır və Z hesabatında "təchizatçılara" sətri görünür.') : _t('Bank ödənişi kassadakı nağdı dəyişmir.'); }
    method.addEventListener('change', sync); sync();
    var full = debt > 0 ? h('button', { class: 'btn small', type: 'button', id: 'pay-full', onclick: function () { amt.value = M.format(debt).replace(/\s/g, ''); amt.focus(); } }, _t('Bütün borc: {0} ₼', [M.format(debt)])) : null;
    UI.modal({
      title: _t('Ödəniş — {0}', [sp.name]),
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'muted' }, _t('Hazırkı borc: {0}', [debtLine(debt)])),
        h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'pay-a' }, _t('Məbləğ, ₼')), amt), h('div', { class: 'field' }, h('label', { for: 'pay-m' }, _t('Üsul')), method)),
        full, h('div', { class: 'field' }, h('label', { for: 'pay-n' }, _t('Qeyd')), note), hint, overRow),
      buttons: [{ text: _t('İmtina') }, { text: _t('Ödə'), kind: 'primary', submit: true, onClick: function (close) {
        var v = M.parse(amt.value); if (v == null || v <= 0) throw new Error(_t('Məbləğ səhvdir'));
        return S.paySupplier(sp.id, v, method.value, note.value, { confirmOver: over.checked }).then(function () {
          close(); UI.toast(_t('Ödəniş qeydə alındı')); if (done) done();
        }).catch(function (e) { if (e.code === 'overpay') overRow.hidden = false; throw e; });
      } }]
    });
  }

  function voidPayForm(p, done) {
    var why = h('input', { class: 'input', id: 'void-r', maxlength: '200', autocomplete: 'off' });
    UI.modal({
      title: _t('Ödənişi ləğv et'),
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', null, UI.fmtDate(p.at) + ' · ' + M.format(p.amount) + ' ₼ · ' + (p.method === 'cash' ? _t('Nağd') : _t('Bank'))),
        h('div', { class: 'field' }, h('label', { for: 'void-r' }, _t('Səbəb *')), why),
        h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, p.method === 'cash' ? _t('Nağd ödəniş ləğv olunanda məbləğ açıq növbənin kassasına geri mədaxil yazılır.') : _t('Bank ödənişi ləğv olunur, kassaya toxunulmur.'))),
      buttons: [{ text: _t('İmtina') }, { text: _t('Ləğv et'), kind: 'danger', submit: true, onClick: function (close) {
        return S.voidSupplierPay(p.id, why.value).then(function () { close(); UI.toast(_t('Ödəniş ləğv edildi')); if (done) done(); });
      } }]
    });
  }

  function copyText(text) {
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) return root.navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = h('textarea', { style: 'position:fixed;left:-9999px' }); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (e) { reject(e); } finally { ta.remove(); }
    });
  }

  // Günün sonunda təchizatçıya göndəriləcək sənəd: öncəbaxış + çap/PDF + paylaş/kopyala
  function statementDialog(sp) {
    var preset = h('select', { class: 'input', id: 'st-preset' }, [['today', _t('Bu gün')], ['yesterday', _t('Dünən')], ['month', _t('Bu ay')], ['prev', _t('Keçən ay')], ['all', _t('Bütün vaxt')], ['custom', _t('Seçilmiş tarixlər')]].map(function (o) { return h('option', { value: o[0] }, o[1]); }));
    var from = h('input', { class: 'input', id: 'st-from', type: 'date' }), to = h('input', { class: 'input', id: 'st-to', type: 'date' });
    var lang = h('select', { class: 'input', id: 'st-lang' }, (root.I18n ? root.I18n.langs : []).map(function (l) { return h('option', { value: l.code, selected: l.code === root.Print.settings().receipt.lang }, l.name); }));
    var preview = h('div', { class: 'sdoc-preview', id: 'st-preview', tabindex: '0' });
    var warn = h('div', { class: 'warn-text', id: 'st-warn', role: 'alert', hidden: true, style: 'font-size:14px' });
    var cur = null, seq = 0;
    function range() {
      var t = todayBaku(), v = preset.value, f = '', e = '';
      if (v === 'today') { f = t; e = addDays(t, 1); }
      else if (v === 'yesterday') { f = addDays(t, -1); e = t; }
      else if (v === 'month') { f = monthStart(t, 0); e = monthStart(t, 1); }
      else if (v === 'prev') { f = monthStart(t, -1); e = monthStart(t, 0); }
      else if (v === 'custom') { f = from.value; e = to.value ? addDays(to.value, 1) : ''; }
      if (v !== 'custom') { from.value = f; to.value = e ? addDays(e, -1) : ''; }
      return { from: dayIso(f), to: dayIso(e), fromDay: f, toDay: e ? addDays(e, -1) : '' };
    }
    function build() {
      var my = ++seq;
      return S.supplierStatement(sp.id, range()).then(function (stm) {
        if (my !== seq) return;
        cur = stm; render();
        warn.hidden = !stm.unpricedLots;
        warn.textContent = stm.unpricedLots ? _t('Diqqət: {0} partiyanın alış qiyməti 0-dır, borca daxil olmayıb. Qiyməti mal qəbulunda yazın.', [stm.unpricedLots]) : '';
      }).catch(function (e) { UI.toast(e.message, 'bad'); });
    }
    function render() { if (cur) preview.innerHTML = root.Print.statementHtml(cur, lang.value); }
    preset.addEventListener('change', build);
    [from, to].forEach(function (c) { c.addEventListener('change', function () { preset.value = 'custom'; build(); }); });
    lang.addEventListener('change', render);
    UI.modal({
      title: _t('Hesabat sənədi — {0}', [sp.name]), wide: true,
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'st-preset' }, _t('Dövr')), preset), h('div', { class: 'field' }, h('label', { for: 'st-from' }, _t('Başlanğıc')), from), h('div', { class: 'field' }, h('label', { for: 'st-to' }, _t('Son')), to), h('div', { class: 'field' }, h('label', { for: 'st-lang' }, _t('Sənədin dili')), lang)),
        warn, preview),
      buttons: [{ text: _t('Bağla') },
        { text: _t('Kopyala'), onClick: function () { if (!cur) return; return copyText(root.Print.statementText(cur, lang.value)).then(function () { UI.toast(_t('Mətn kopyalandı: mesajlaşma proqramına yapışdırın')); }, function () { throw new Error(_t('Kopyalamaq alınmadı')); }); } },
        { text: _t('Paylaş'), onClick: function () {
          if (!cur) return;
          var text = root.Print.statementText(cur, lang.value);
          if (root.navigator && root.navigator.share) return root.navigator.share({ title: _t('Təchizatçı hesabatı', null, lang.value) + ' — ' + sp.name, text: text }).catch(function (e) { if (e && e.name !== 'AbortError') throw e; });
          return copyText(text).then(function () { UI.toast(_t('Paylaşma bu cihazda yoxdur: mətn kopyalandı')); });
        } },
        { text: _t('Çap et / PDF'), kind: 'primary', submit: true, onClick: function () { if (!cur) return; return UI.printHtml(root.Print.statementHtml(cur, lang.value), 'doc'); } }]
    });
    range(); build();
  }

  // Hesab pəncərəsi: borc, ödəniş, ödənişlər siyahısı, hesabat sənədi
  function supplierAccount(sp, onChange) {
    var box = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
    UI.modal({ title: _t('Hesab — {0}', [sp.name]), wide: true, body: box, buttons: [{ text: _t('Bağla') }], onClose: function () { if (onChange) onChange(); } });
    function load() {
      return Promise.all([S.supplierBalances(), S.listSupplierPays(sp.id), S.listSuppliers({ all: true })]).then(function (r) {
        var cur = r[2].filter(function (x) { return x.id === sp.id; })[0] || sp, b = r[0].balances[sp.id] || { debt: 0 }, canPay = r[0].canPay, debt = b.debt;
        UI.clear(box);
        box.appendChild(h('div', { class: 'card', id: 'acc-debt', style: 'padding:14px 18px' },
          h('div', { class: 'muted' }, debt < 0 ? _t('Avans (təchizatçı mağazaya borcludur)') : _t('Təchizatçıya borcumuz')),
          h('div', { style: 'font-size:28px;font-weight:700' }, M.format(Math.abs(debt)) + ' ₼'),
          h('div', { class: 'muted', style: 'font-size:13px' }, (cur.debtBasis === 'sold' ? _t('Hesablama: satılan malın alış qiyməti ilə') : _t('Hesablama: alınan malın alış qiyməti ilə')) + (cur.openingDebt ? ' · ' + _t('açılış borcu {0} ₼', [M.format(cur.openingDebt)]) : ''))));
        box.appendChild(h('div', { class: 'row' },
          canPay ? h('button', { class: 'btn primary', type: 'button', id: 'acc-pay', onclick: function () { payForm(cur, debt, load); } }, _t('Ödəniş et')) : null,
          h('button', { class: 'btn', type: 'button', id: 'acc-doc', onclick: function () { statementDialog(cur); } }, _t('Hesabat sənədi (çek siyahısı + borc)'))));
        var tb = h('tbody');
        if (!r[1].length) tb.appendChild(h('tr', null, h('td', { colspan: '6', class: 'empty' }, _t('Hələ ödəniş yoxdur'))));
        r[1].forEach(function (p) {
          tb.appendChild(h('tr', { class: p.voidedAt ? 'inactive' : '', 'data-pay': p.id }, h('td', null, UI.fmtDate(p.at)), h('td', null, p.method === 'cash' ? _t('Nağd') : _t('Bank')), h('td', { class: 'num' }, M.format(p.amount)),
            h('td', null, p.userName || ''), h('td', { class: 'muted' }, p.voidedAt ? _t('Ləğv: {0}', [p.voidReason || '']) : (p.note || '')),
            h('td', { style: 'text-align:right' }, canPay && !p.voidedAt ? h('button', { class: 'btn small danger', type: 'button', 'data-act': 'void', onclick: function () { voidPayForm(p, load); } }, _t('Ləğv et')) : null)));
        });
        box.appendChild(h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'pay-table' }, h('thead', null, h('tr', null, h('th', null, _t('Tarix')), h('th', null, _t('Üsul')), h('th', { class: 'num' }, _t('Məbləğ ₼')), h('th', null, _t('Kim')), h('th', null, _t('Qeyd')), h('th', null, ''))), tb)));
      }).catch(function (e) { UI.clear(box); box.appendChild(h('div', { class: 'muted' }, e.message)); });
    }
    return load();
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

  /* ================= Alış qaimələri və təchizatçıya qaytarma (FR-104/105) ================= */
  function preventEnter(input, then) {
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (then) then(); } });     // Enter pəncərənin "Yadda saxla"sını işə salmasın
  }

  // Yeni alış qaiməsi: təchizatçı, qaimə nömrəsi/tarixi, məhsul sətirləri (say + alış qiyməti). Barkod oxuyucu axtarış sahəsinə yazır.
  function purchaseForm(onSaved) {
    var sup = h('select', { class: 'input', id: 'pf-sup' });
    var invNo = h('input', { class: 'input', id: 'pf-inv', maxlength: '60', autocomplete: 'off' });
    var invDate = h('input', { class: 'input', id: 'pf-date', type: 'date', value: todayBaku() });
    var note = h('input', { class: 'input', id: 'pf-note', maxlength: '200', autocomplete: 'off' });
    var q = h('input', { class: 'input', id: 'pf-q', type: 'search', autocomplete: 'off', placeholder: _t('Məhsul adı və ya barkod') });
    var found = h('div', { class: 'pf-found', id: 'pf-found' });
    var body = h('tbody'), totalEl = h('b', { id: 'pf-total' }, '0,00');
    var lines = [], hits = [], seq = 0;

    function recalc() {
      var total = 0;
      lines.forEach(function (l) {
        var qn = parseInt(l.qty.value, 10), c = M.parse(l.cost.value);
        var sum = qn > 0 && c != null ? Math.round(qn * c) : 0; total += sum;
        l.sum.textContent = sum ? M.format(sum) : '—';
        var prev = l.p.lastCost || 0;
        l.hint.textContent = prev && c != null && c !== prev ? _t('əvvəlki alış: {0}', [M.format(prev)]) : '';
      });
      totalEl.textContent = M.format(total);
    }
    function addLine(p) {
      var ex = lines.filter(function (l) { return l.p.id === p.id; })[0];
      if (ex) { ex.qty.value = String((parseInt(ex.qty.value, 10) || 0) + 1); recalc(); ex.qty.focus(); return; }
      var l = { p: p };
      l.qty = h('input', { class: 'input', type: 'number', min: '1', max: '100000', value: '1', 'aria-label': _t('Say') });
      l.cost = h('input', { class: 'input mono', inputmode: 'decimal', autocomplete: 'off', value: p.lastCost ? M.format(p.lastCost).replace(/\s/g, '') : '', 'aria-label': _t('Alış qiyməti, ₼') });
      l.hint = h('div', { class: 'muted', style: 'font-size:12px' });
      l.sum = h('td', { class: 'num' }, '—');
      [l.qty, l.cost].forEach(function (i) { i.addEventListener('input', recalc); preventEnter(i, function () { q.focus(); }); });
      l.row = h('tr', { 'data-pid': p.id }, h('td', null, h('div', null, p.name), h('div', { class: 'muted mono', style: 'font-size:12px' }, p.storeBarcode)), h('td', null, l.qty), h('td', null, l.cost, l.hint), l.sum,
        h('td', null, h('button', { class: 'btn small', type: 'button', 'aria-label': _t('Sil'), onclick: function () { lines = lines.filter(function (x) { return x !== l; }); l.row.remove(); recalc(); } }, '✕')));
      lines.push(l); body.appendChild(l.row); recalc();
      (l.p.lastCost ? l.qty : l.cost).focus(); (l.p.lastCost ? l.qty : l.cost).select();
    }
    function pickHit(p) { addLine(p); q.value = ''; UI.clear(found); hits = []; }
    function search() {
      var my = ++seq, v = q.value.trim();
      if (!v) { UI.clear(found); hits = []; return Promise.resolve(); }
      return S.searchProducts(v, 8).then(function (list) {
        if (my !== seq) return;
        hits = list; UI.clear(found);
        if (!list.length) found.appendChild(h('div', { class: 'muted', style: 'font-size:14px' }, _t('Məhsul tapılmadı')));
        list.forEach(function (p) {
          found.appendChild(h('button', { class: 'btn small pf-hit', type: 'button', 'data-pid': p.id, onclick: function () { pickHit(p); } }, p.name, ' ', h('span', { class: 'muted mono' }, p.storeBarcode)));
        });
      });
    }
    q.addEventListener('input', search);
    preventEnter(q, function () {
      search().then(function () {
        var v = q.value.trim(), exact = hits.filter(function (p) { return p.storeBarcode === v || p.mfrBarcode === v; });
        if (exact.length === 1 || hits.length === 1) pickHit(exact[0] || hits[0]);
        else if (exact.length > 1) UI.toast(_t('Bu barkodla bir neçə məhsul var: siyahıdan seçin'), 'warn');
      });
    });
    [invNo, note, invDate].forEach(function (i) { preventEnter(i, function () { q.focus(); }); });

    var tableBox = h('div', { class: 'table-wrap pf-table', tabindex: '0' }, h('table', { id: 'pf-lines' },
      h('thead', null, h('tr', null, h('th', null, _t('Məhsul')), h('th', { style: 'width:110px' }, _t('Say')), h('th', { style: 'width:150px' }, _t('Alış qiyməti, ₼')), h('th', { class: 'num', style: 'width:110px' }, _t('Məbləğ ₼')), h('th', { style: 'width:48px' }, ''))),
      body, h('tfoot', null, h('tr', null, h('th', { colspan: '3' }, _t('Cəmi')), h('th', { class: 'num' }, totalEl), h('th', null, '')))));
    var form = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', { for: 'pf-sup' }, _t('Təchizatçı *')), sup),
        h('div', { class: 'field' }, h('label', { for: 'pf-inv' }, _t('Qaimə nömrəsi')), invNo),
        h('div', { class: 'field' }, h('label', { for: 'pf-date' }, _t('Qaimə tarixi')), invDate),
        h('div', { class: 'field' }, h('label', { for: 'pf-note' }, _t('Qeyd')), note)),
      h('div', { class: 'field' }, h('label', { for: 'pf-q' }, _t('Məhsul əlavə et')), q), found,
      tableBox,
      h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Qaimə yadda saxlananda qalıq artır və borc (alınan mal əsasında) hesablanır. Satış qiyməti avtomatik dəyişmir: alış qiyməti dəyişibsə sonda xatırladılacaq. Saxlanmış qaimə dəyişdirilmir: səhv olarsa ləğv edin və ya təchizatçıya qaytarın.')));
    S.listSuppliers().then(function (list) {
      if (!list.length) { UI.clear(form); form.appendChild(h('p', { class: 'warn-text', role: 'alert' }, _t('Əvvəl təchizatçı əlavə edin'))); return; }
      list.forEach(function (s) { sup.appendChild(h('option', { value: s.id }, s.name)); });
    });
    UI.modal({
      title: _t('Yeni alış qaiməsi'), wide: true, body: form,
      buttons: [{ text: _t('İmtina') }, { text: _t('Qaiməni yadda saxla'), kind: 'primary', submit: true, onClick: function (close) {
        if (!lines.length) throw new Error(_t('Qaiməyə ən azı bir məhsul əlavə edin'));
        var items = lines.map(function (l) { return { productId: l.p.id, qty: parseInt(l.qty.value, 10), unitCost: M.parse(l.cost.value) }; });
        return S.createPurchase({ supplierId: sup.value, invoiceNo: invNo.value, invoiceDate: invDate.value, note: note.value, lines: items }).then(function (r) {
          close(); UI.toast(_t('Qaimə yadda saxlanıldı: {0} sətir, {1} ₼', [r.doc.lines.length, M.format(r.doc.total)]));
          if (onSaved) onSaved();
          if (r.suggestions.length) priceSuggestions(r.suggestions);
        });
      } }]
    });
  }

  // Alış qiyməti dəyişən məhsullar: satış qiyməti avtomatik dəyişmir, menecer özü qərar verir (AS-30)
  function priceSuggestions(list) {
    var tb = h('tbody');
    list.forEach(function (x) {
      var margin = x.price > 0 ? Math.round((x.price - x.newCost) * 1000 / x.price) / 10 : 0;
      tb.appendChild(h('tr', { 'data-pid': x.productId }, h('td', null, x.name), h('td', { class: 'num muted' }, M.format(x.oldCost)), h('td', { class: 'num' }, M.format(x.newCost)), h('td', { class: 'num' }, M.format(x.price)),
        h('td', { class: 'num' }, margin < 0 ? h('span', { class: 'warn-text' }, margin + '%') : margin + '%'),
        h('td', null, can('product.price.set') ? h('button', { class: 'btn small', type: 'button', 'data-act': 'reprice', onclick: function () { S.listProducts().then(function (ps) { var p = ps.filter(function (y) { return y.id === x.productId; })[0]; if (p) productForm(p, function () {}); }); } }, _t('Satış qiymətini dəyiş')) : null)));
    });
    UI.modal({
      title: _t('Alış qiyməti dəyişib'), wide: true, buttons: [{ text: _t('Bağla') }],
      body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
        h('p', { class: 'muted', style: 'margin:0' }, _t('Bu məhsulların alış qiyməti əvvəlkindən fərqlidir. Satış qiyməti dəyişmədi: lazım bilsəniz yeniləyin.')),
        h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'sug-table' },
          h('thead', null, h('tr', null, h('th', null, _t('Məhsul')), h('th', { class: 'num' }, _t('Əvvəlki alış ₼')), h('th', { class: 'num' }, _t('Yeni alış ₼')), h('th', { class: 'num' }, _t('Satış ₼')), h('th', { class: 'num' }, _t('Marja')), h('th', null, ''))), tb)))
    });
  }

  // Qaimənin baxışı: sətirlər, hər partiyanın qalığı; ləğv və ya təchizatçıya qaytarma
  function purchaseView(doc, canManage, onChange) {
    var seeCost = doc.total != null;
    var tb = h('tbody');
    doc.lines.forEach(function (l) {
      tb.appendChild(h('tr', { 'data-lot': l.lotId }, h('td', null, l.name), h('td', { class: 'num' }, String(l.qty)), seeCost ? h('td', { class: 'num' }, M.format(l.unitCost)) : null,
        h('td', { class: 'num' }, l.remaining == null ? '—' : String(l.remaining)), h('td', { class: 'num' }, l.returned ? String(l.returned) : '')));
    });
    var info = [
      [_t('Təchizatçı'), doc.supplierName || '—'], [_t('Qaimə nömrəsi'), doc.invoiceNo || '—'], [_t('Qaimə tarixi'), doc.invoiceDate || '—'], [_t('Daxil edildi'), UI.fmtDate(doc.at)],
      [_t('Yaradan'), doc.createdBy ? doc.createdBy.name : '—'], [_t('Təsdiq edən'), doc.approvedBy ? doc.approvedBy.name : '—'],
      [_t('Mənbə'), doc.source === 'request' ? _t('Kassirin «Mal gəldi» sorğusu') : _t('Alış qaiməsi')]
    ];
    if (doc.note) info.push([_t('Qeyd'), doc.note]);
    var body = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      doc.status === 'cancelled' ? h('div', { class: 'badge off', style: 'align-self:flex-start' }, _t('Ləğv edilib') + (doc.cancel && doc.cancel.reason ? ': ' + doc.cancel.reason : '')) : null,
      h('div', { class: 'kv' }, info.map(function (x) { return h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, x[0]), h('div', null, x[1])); })),
      h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'pv-lines' },
        h('thead', null, h('tr', null, h('th', null, _t('Məhsul')), h('th', { class: 'num' }, _t('Say')), seeCost ? h('th', { class: 'num' }, _t('Alış qiyməti, ₼')) : null, h('th', { class: 'num' }, _t('Qalıq (bu partiyadan)')), h('th', { class: 'num' }, _t('Qaytarılıb')))), tb,
        seeCost ? h('tfoot', null, h('tr', null, h('th', { colspan: '2' }, _t('Cəmi')), h('th', { class: 'num' }, M.format(doc.total)), h('th', { colspan: '2' }, ''))) : null)));
    var btns = [{ text: _t('Bağla') }];
    if (canManage && doc.status === 'approved') {
      if (doc.canCancel) btns.push({ text: _t('Qaiməni ləğv et'), kind: 'danger', onClick: function (close) { close(); cancelPurchaseForm(doc, onChange); return null; } });
      if (doc.supplierId && doc.lines.some(function (l) { return l.remaining > 0; })) btns.push({ text: _t('Təchizatçıya qaytar'), kind: 'primary', onClick: function (close) { close(); returnForm({ supplierId: doc.supplierId, docId: doc.id }, onChange); return null; } });
    }
    UI.modal({ title: _t('Alış qaiməsi'), wide: true, body: body, buttons: btns });
  }

  function cancelPurchaseForm(doc, onDone) {
    var why = h('input', { class: 'input', id: 'cp-why', maxlength: '200', autocomplete: 'off' });
    UI.modal({
      title: _t('Qaiməni ləğv et'),
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', null, (doc.supplierName || '—') + ' · ' + (doc.invoiceNo || UI.fmtDate(doc.at))),
        h('div', { class: 'field' }, h('label', { for: 'cp-why' }, _t('Səbəb *')), why),
        h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Qaimədəki mal qalıqdan çıxarılır, borc həmin məbləğdə azalır. Yalnız bu qaimədən heç nə satılmayıbsa mümkündür.'))),
      buttons: [{ text: _t('İmtina') }, { text: _t('Ləğv et'), kind: 'danger', submit: true, onClick: function (close) {
        return S.cancelPurchase(doc.id, why.value).then(function () { close(); UI.toast(_t('Qaimə ləğv edildi')); if (onDone) onDone(); });
      } }]
    });
  }

  // Təchizatçıya qaytarma: təchizatçı → qaimə (və ya qaiməsiz köhnə qəbullar) → qaytarılan say. pre: {supplierId, docId}
  function returnForm(pre, onSaved) {
    pre = pre || {};
    var sup = h('select', { class: 'input', id: 'rf-sup' }), src = h('select', { class: 'input', id: 'rf-src' });
    var note = h('input', { class: 'input', id: 'rf-note', maxlength: '200', autocomplete: 'off' });
    var tb = h('tbody'), hint = h('p', { class: 'muted', id: 'rf-hint', style: 'margin:0;font-size:14px' }), totalEl = h('b', { id: 'rf-total' }, '0,00');
    var sups = [], docs = [], lots = [], rows = [], seeCost = true;
    function supplier() { return sups.filter(function (s) { return s.id === sup.value; })[0]; }
    function recalc() {
      var total = 0;
      rows.forEach(function (r) {
        var qn = parseInt(r.qty.value, 10) || 0, c = r.cost ? M.parse(r.cost.value) : r.lot.unitCost;
        var sum = qn > 0 && c != null ? Math.round(qn * c) : 0; total += sum; r.sum.textContent = sum ? M.format(sum) : '—';
        if (r.cost) r.cost.classList.toggle('changed', c != null && c !== r.lot.unitCost);
      });
      totalEl.textContent = M.format(total);
      var s = supplier();
      hint.textContent = !s ? '' : s.debtBasis === 'sold' ? _t('Bu təchizatçı üçün borc satılan mal əsasında hesablanır: qaytarma yalnız qalığı azaldır, borca təsir etmir.') : total ? _t('Təchizatçıya borc {0} ₼ azalacaq (alınan mal əsasında).', [M.format(total)]) : _t('Qaytarma təchizatçıya borcu azaldır (alınan mal əsasında).');
    }
    function draw() {
      UI.clear(tb); rows = [];
      var want = src.value === '' ? '' : src.value;
      var list = lots.filter(function (l) { return (l.docId || '') === want; });
      if (!list.length) tb.appendChild(h('tr', null, h('td', { colspan: seeCost ? '5' : '4', class: 'empty' }, _t('Bu mənbədən qaytarıla bilən mal yoxdur'))));
      list.forEach(function (lot) {
        var r = { lot: lot };
        r.qty = h('input', { class: 'input', type: 'number', min: '0', max: String(lot.remaining), value: '0', 'aria-label': _t('Qaytarılan say') });
        r.cost = seeCost && lot.unitCost != null ? h('input', { class: 'input mono', inputmode: 'decimal', autocomplete: 'off', value: M.format(lot.unitCost).replace(/\s/g, ''), 'aria-label': _t('Alış qiyməti, ₼') }) : null;
        r.sum = h('td', { class: 'num' }, '—');
        [r.qty, r.cost].forEach(function (i) { if (i) { i.addEventListener('input', recalc); preventEnter(i); } });
        r.row = h('tr', { 'data-lot': lot.lotId }, h('td', null, h('div', null, lot.name), h('div', { class: 'muted', style: 'font-size:12px' }, UI.fmtDate(lot.at))), h('td', { class: 'num' }, String(lot.qty)), h('td', { class: 'num' }, h('b', null, String(lot.remaining))),
          h('td', null, r.qty), seeCost ? h('td', null, r.cost) : null, r.sum);
        rows.push(r); tb.appendChild(r.row);
      });
      recalc();
    }
    function fillSrc() {
      UI.clear(src);
      var mine = docs.filter(function (d) { return d.supplierId === sup.value && d.status === 'approved'; });
      mine.forEach(function (d) { src.appendChild(h('option', { value: d.id }, UI.fmtDate(d.at) + ' · ' + (d.invoiceNo ? '№ ' + d.invoiceNo + ' · ' : '') + _t('{0} sətir', [d.lines.length]))); });
      src.appendChild(h('option', { value: '' }, _t('Qaiməsiz (köhnə qəbullar)')));
      var withLots = {}; lots.forEach(function (l) { withLots[l.docId || ''] = true; });
      var pick = pre.docId && mine.some(function (d) { return d.id === pre.docId; }) ? pre.docId : (mine.filter(function (d) { return withLots[d.id]; })[0] || {}).id || (withLots[''] ? '' : (mine[0] ? mine[0].id : ''));
      src.value = pick; pre.docId = null;
    }
    function loadSupplier() {
      return S.returnableLots(sup.value).then(function (l) { lots = l; seeCost = !l.length || l[0].unitCost != null; fillSrc(); draw(); });
    }
    sup.addEventListener('change', loadSupplier); src.addEventListener('change', draw); preventEnter(note);
    var form = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('label', { for: 'rf-sup' }, _t('Təchizatçı *')), sup), h('div', { class: 'field' }, h('label', { for: 'rf-src' }, _t('Hansı qaimədən')), src)),
      h('div', { class: 'table-wrap pf-table', tabindex: '0' }, h('table', { id: 'rf-lines' },
        h('thead', null, h('tr', null, h('th', null, _t('Məhsul')), h('th', { class: 'num' }, _t('Alınıb')), h('th', { class: 'num' }, _t('Qaytarıla bilər')), h('th', { style: 'width:110px' }, _t('Qaytarılan say')), h('th', { style: 'width:150px', class: 'rf-cost' }, _t('Qaytarma qiyməti, ₼')), h('th', { class: 'num', style: 'width:110px' }, _t('Məbləğ ₼')))), tb,
        h('tfoot', null, h('tr', null, h('th', { colspan: '5' }, _t('Cəmi')), h('th', { class: 'num' }, totalEl))))),
      h('div', { class: 'field' }, h('label', { for: 'rf-note' }, _t('Qeyd')), note), hint,
      h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Yalnız partiyanın qalığı qədər qaytarmaq olar: satılan hissə qaytarılmır. Qiymət partiyanın alış qiymətidir; fərqli qiymət yazsanız borc həmin qiymətlə azalır və bu qeyd olunur.')));
    Promise.all([S.listSuppliers({ all: true }), S.listPurchases()]).then(function (r) {
      sups = r[0]; docs = r[1].docs;
      var used = {}; docs.forEach(function (d) { if (d.supplierId) used[d.supplierId] = true; });
      sups.forEach(function (s) { sup.appendChild(h('option', { value: s.id }, s.name + (s.active ? '' : ' (' + _t('Söndürülüb') + ')'))); });
      if (pre.supplierId) sup.value = pre.supplierId;
      if (!sups.length) { UI.clear(form); form.appendChild(h('p', { class: 'warn-text' }, _t('Əvvəl təchizatçı əlavə edin'))); return; }
      return loadSupplier();
    }).catch(function (e) { UI.toast(e.message, 'bad'); });
    UI.modal({
      title: _t('Təchizatçıya qaytarma'), wide: true, body: form,
      buttons: [{ text: _t('İmtina') }, { text: _t('Qaytar'), kind: 'primary', submit: true, onClick: function (close) {
        var items = [];
        rows.forEach(function (r) {
          var qn = parseInt(r.qty.value, 10) || 0; if (qn <= 0) return;
          var it = { lotId: r.lot.lotId, qty: qn };
          if (r.cost) { var c = M.parse(r.cost.value); if (c == null) throw new Error(_t('Alış qiyməti səhvdir')); if (c !== r.lot.unitCost) it.unitCost = c; }
          items.push(it);
        });
        if (!items.length) throw new Error(_t('Qaytarılacaq mal seçin'));
        return S.createSupplierReturn({ supplierId: sup.value, docId: src.value, note: note.value, lines: items }).then(function (ret) {
          close(); UI.toast(_t('Qaytarma yazıldı: {0} sətir, {1} ₼', [ret.lines.length, M.format(ret.total)])); if (onSaved) onSaved();
        });
      } }]
    });
  }

  function suppliers(el) {
    UI.clear(el);
    var canManage = can('supplier.manage'), canDebt = can('supplier.pay') || (can('supplier.view') && can('product.cost.view'));
    var tb = h('tbody'), repBody = h('tbody'), repFoot = h('tfoot'), repHead = h('thead');
    var preset = h('select', { class: 'input', id: 'rp-preset' }, [['month', _t('Bu ay')], ['today', _t('Bu gün')], ['yesterday', _t('Dünən')], ['prev', _t('Keçən ay')], ['all', _t('Bütün vaxt')], ['custom', _t('Seçilmiş tarixlər')]].map(function (o) { return h('option', { value: o[0] }, o[1]); }));
    var from = h('input', { class: 'input', id: 'rp-from', type: 'date' }), to = h('input', { class: 'input', id: 'rp-to', type: 'date' });
    var last = null, warnBox = h('div', { id: 'rp-warn', class: 'warn-text', role: 'alert', hidden: true, style: 'font-size:14px' });
    var canPurchase = can('stock.receive'), docTb = h('tbody'), retTb = h('tbody'), docHead = h('thead'), retHead = h('thead');

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
      return Promise.all([S.listSuppliers({ all: true }), S.supplierReport({}), canDebt ? S.supplierBalances().catch(function () { return null; }) : Promise.resolve(null)]).then(function (r) {
        var hand = {}; r[1].rows.forEach(function (x) { hand[x.supplierId || ''] = x; });
        var bal = r[2] ? r[2].balances : {};
        UI.clear(tb);
        if (!r[0].length) tb.appendChild(h('tr', null, h('td', { colspan: canDebt ? '7' : '6', class: 'empty' }, _t('Hələ təchizatçı yoxdur'))));
        r[0].forEach(function (sp) {
          var x = hand[sp.id], b = bal[sp.id];
          tb.appendChild(h('tr', { 'data-sup': sp.name, class: sp.active ? '' : 'inactive' }, h('td', null, sp.name), h('td', null, sp.phone || '—'), h('td', { class: 'muted' }, sp.note || ''),
            h('td', { class: 'num' }, String(x ? x.onHandQty : 0)),
            canDebt ? h('td', { class: 'num', 'data-debt': b ? String(b.debt) : '' }, b ? (b.debt < 0 ? h('span', { class: 'muted' }, M.format(b.debt) + ' (' + _t('avans') + ')') : h('b', null, M.format(b.debt))) : '—') : null,
            h('td', null, sp.active ? h('span', { class: 'badge ok' }, _t('Aktiv')) : h('span', { class: 'badge off' }, _t('Söndürülüb'))),
            h('td', { style: 'text-align:right;white-space:nowrap' },
              canDebt ? [h('button', { class: 'btn small', type: 'button', 'data-act': 'account', onclick: function () { supplierAccount(sp, loadAll); } }, _t('Hesab')), ' '] : null,
              canManage ? [
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
    // Alış qaimələri və təchizatçıya qaytarmalar (FR-104/105)
    function loadDocs() {
      return Promise.all([S.listPurchases(), S.listSupplierReturns()]).then(function (r) {
        var res = r[0], cost = res.seeCost;
        var byDoc = {}; res.docs.forEach(function (d) { byDoc[d.id] = d; });
        UI.clear(docHead); UI.clear(docTb); UI.clear(retHead); UI.clear(retTb);
        retHead.appendChild(h('tr', null, h('th', null, _t('Tarix')), h('th', null, _t('Təchizatçı')), h('th', null, _t('Növ')), h('th', null, _t('Məhsullar')), cost ? h('th', { class: 'num' }, _t('Məbləğ ₼')) : null, h('th', null, _t('Qeyd'))));
        docHead.appendChild(h('tr', null, h('th', null, _t('Daxil edildi')), h('th', null, _t('Təchizatçı')), h('th', null, _t('Qaimə nömrəsi')), h('th', null, _t('Məhsullar')), cost ? h('th', { class: 'num' }, _t('Məbləğ ₼')) : null, h('th', null, _t('Vəziyyət')), h('th', null, '')));
        if (!res.docs.length) docTb.appendChild(h('tr', null, h('td', { colspan: cost ? '7' : '6', class: 'empty' }, _t('Hələ alış qaiməsi yoxdur'))));
        res.docs.slice(0, 50).forEach(function (d) {
          docTb.appendChild(h('tr', { 'data-doc': d.id, 'data-state': d.status, class: d.status === 'cancelled' ? 'inactive' : '' },
            h('td', null, UI.fmtDate(d.at)), h('td', null, d.supplierName || '—'), h('td', null, d.invoiceNo || '—'),
            h('td', null, d.lines.map(function (l) { return l.name + ' × ' + l.qty; }).join(', ')),
            cost ? h('td', { class: 'num' }, M.format(d.total)) : null,
            h('td', null, d.status === 'cancelled' ? h('span', { class: 'badge off' }, _t('Ləğv edilib')) : d.source === 'request' ? h('span', { class: 'badge' }, _t('«Mal gəldi» sorğusu')) : h('span', { class: 'badge ok' }, _t('Təsdiqlənib'))),
            h('td', { style: 'text-align:right' }, h('button', { class: 'btn small', type: 'button', 'data-act': 'doc', onclick: function () { purchaseView(d, res.canManage, loadAll); } }, _t('Bax')))));
        });
        if (!r[1].length) retTb.appendChild(h('tr', null, h('td', { colspan: cost ? '6' : '5', class: 'empty' }, _t('Hələ təchizatçıya qaytarma yoxdur'))));
        r[1].slice(0, 30).forEach(function (x) {
          var d = byDoc[x.docId];
          retTb.appendChild(h('tr', { 'data-ret': x.id },
            h('td', null, UI.fmtDate(x.at)), h('td', null, x.supplierName || '—'),
            h('td', null, x.cancel ? h('span', { class: 'badge off' }, _t('Qaimənin ləğvi')) : h('span', { class: 'badge' }, _t('Qaytarma')), d && d.invoiceNo ? h('div', { class: 'muted', style: 'font-size:12px' }, '№ ' + d.invoiceNo) : null),
            h('td', null, x.lines.map(function (l) { return (l.productName || '') + ' × ' + l.qty + (l.priceChanged ? ' ⚠' : ''); }).join(', ')),
            cost ? h('td', { class: 'num' }, M.format(x.total)) : null, h('td', { class: 'muted' }, x.cancel ? (x.reason || '') : (x.note || ''))));
        });
      });
    }
    function loadAll() { return Promise.all([loadSuppliers(), loadReport(), loadDocs()]).catch(function (e) { UI.toast(e.message, 'bad'); }); }

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
        h('div', { class: 'row' },
          canPurchase ? h('button', { class: 'btn', id: 'pur-add', type: 'button', onclick: function () { purchaseForm(loadAll); } }, _t('Yeni alış qaiməsi')) : null,
          canPurchase ? h('button', { class: 'btn', id: 'ret-add', type: 'button', onclick: function () { returnForm({}, loadAll); } }, _t('Təchizatçıya qaytarma')) : null,
          canManage ? h('button', { class: 'btn primary', id: 'sup-add', type: 'button', onclick: function () { supplierForm(null, loadAll); } }, _t('+ Yeni təchizatçı')) : null)),
      h('div', { class: 'card table-wrap', tabindex: '0' }, h('table', { id: 'sup-table', class: 'cards' }, h('thead', null, h('tr', null, h('th', null, _t('Ad')), h('th', null, _t('Telefon')), h('th', null, _t('Qeyd')), h('th', { class: 'num' }, _t('Qalıq (ədəd)')), canDebt ? h('th', { class: 'num' }, _t('Borc ₼')) : null, h('th', null, _t('Vəziyyət')), h('th', null, ''))), tb)),
      h('div', { class: 'card', style: 'margin-top:24px' },
        h('div', { style: 'padding:16px 20px 8px' }, h('h2', { style: 'margin:0;font-size:18px' }, _t('Alış qaimələri')),
          h('p', { class: 'muted', style: 'margin:4px 0 0;font-size:13px' }, _t('Təchizatçıdan mal qəbulu. Satış olmayıbsa qaimə ləğv edilir, olubsa təchizatçıya qaytarma yazılır.'))),
        h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'doc-table', class: 'cards' }, docHead, docTb))),
      h('div', { class: 'card', style: 'margin-top:24px' },
        h('div', { style: 'padding:16px 20px 8px' }, h('h2', { style: 'margin:0;font-size:18px' }, _t('Təchizatçıya qaytarmalar'))),
        h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'sret-table', class: 'cards' },
          retHead, retTb))),
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

  // Çekin endirimi haqqında qısa mətn: sətir endirimləri və çek endirimi (faiz və ya məbləğ)
  function saleDiscountText(sale) {
    var parts = [];
    if (sale.totals.lineDiscount) parts.push(_t('sətir endirimi {0}', [M.format(sale.totals.lineDiscount)]));
    if (sale.discount) parts.push(sale.discount.type === 'amount' || sale.discount.percent == null ? _t('çek endirimi {0}', [M.format(sale.totals.discount)]) : _t('çek endirimi {0}%', [sale.discount.percent]));
    return parts.length ? ' (' + parts.join(', ') + ')' : '';
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
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, _t('Yekun')), M.format(sale.totals.total) + ' ₼' + saleDiscountText(sale)),
          h('div', null, h('div', { class: 'muted', style: 'font-size:13px' }, _t('Keçən gün')), String(win.daysPassed)));
        out.appendChild(head);
        if (win.expired) {
          UI.beep(false);
          out.appendChild(h('div', { class: 'card', role: 'alert', style: 'padding:18px 20px;background:var(--bad-soft);color:var(--bad);font-weight:600;border-color:#E2B4B4' },
            _t('Çekin qaytarma müddəti bitib: {0} gün keçib (limit {1} gün).', [win.daysPassed, R.RETURN_DAYS])));
          return;
        }
        var inputs = [], maxes = [];
        var paidLines = R.paidPerLine(sale);                      // sətir və çek endirimi çıxıldıqdan sonra müştərinin həqiqətən ödədiyi pul
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
            h('td', { class: 'num' }, M.format(l.price), paidLines[i] !== l.price * l.qty ? h('div', { class: 'muted', style: 'font-size:12px' }, _t('ödənilib: {0}', [M.format(paidLines[i])])) : null), h('td', { class: 'num' }, inp)));
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
            var amount = R.refundFor(sale, items, prev.map).amount;
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
              line(_t('Qaytarmalar'), M.format(rep.returns)), line(_t('Kassaya mədaxil'), M.format(rep.cashIn)), line(_t('Kassadan məxaric'), M.format(rep.cashOut)), rep.supplierPaid ? line(_t('o cümlədən təchizatçılara'), M.format(rep.supplierPaid)) : null,
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
      rowNZ(_t('Kassaya mədaxil'), r.cashIn); rowNZ(_t('Kassadan məxaric'), r.cashOut); rowNZ(_t('o cümlədən təchizatçılara'), r.supplierPaid);
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
    var PAGE = 100, lim = PAGE, seq = 0, timer = null;
    var q = h('input', { class: 'input', id: 'sq', type: 'search', autocomplete: 'off', style: 'min-width:300px', placeholder: _t('Çek №, kassir, məhsul, tarix (gg.aa.iiii) və ya məbləğ') });
    var info = h('div', { class: 'muted', id: 'sq-info', role: 'status', style: 'font-size:14px' });
    var more = h('button', { class: 'btn', id: 'sq-more', type: 'button', hidden: true, onclick: function () { lim += PAGE; run(); } }, _t('Daha çox göstər'));
    el.appendChild(h('div', { class: 'page' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:12px' }, h('h1', { style: 'margin:0' }, _t('Çeklər')),
        h('div', { class: 'row' }, h('label', { class: 'sr-only', for: 'sq' }, _t('Axtarış')), q)),
      info,
      h('div', { class: 'card table-wrap', tabindex: '0', style: 'margin-top:8px' }, h('table', { class: 'cards' },
        h('thead', null, h('tr', null, h('th', null, '№'), h('th', null, _t('Tarix')), h('th', null, _t('Kassir')), h('th', null, _t('Məhsullar')), h('th', null, _t('Ödəniş')), h('th', { class: 'num' }, _t('Yekun ₼')), h('th', null, ''), h('th', null, ''))), tb)),
      h('div', { style: 'margin-top:12px' }, more)));

    // Hər açılışda bütün çeklər axtarılır (yalnız son 100 yox): söz-söz, hamısı uyğun gəlməlidir
    function run() {
      var my = ++seq, query = q.value.trim();
      return S.searchSales(query, lim).then(function (r) {
        if (my !== seq) return;                                         // daha yeni axtarış gedir: köhnə cavab ekranı pozmasın
        UI.clear(tb); fill(r.list, !!query);
        info.textContent = !r.total ? '' : r.total > r.list.length ? _t('{0} çekdən {1} göstərilir', [r.total, r.list.length]) : (query ? _t('{0} çek tapıldı', [r.total]) : '');
        more.hidden = r.total <= r.list.length;
      });
    }
    function loadList() { return run(); }
    root.Screens._refresh = loadList;
    q.addEventListener('input', function () { lim = PAGE; clearTimeout(timer); timer = setTimeout(run, 200); });
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); lim = PAGE; run(); } });
    run().then(function () { q.focus(); });

    function discountOf(s) { return (s.totals.lineDiscount || 0) + (s.totals.discount || 0); }
    function fill(list, searching) {
      if (!list.length) tb.appendChild(h('tr', null, h('td', { colspan: '8', class: 'empty' }, searching ? _t('Uyğun çek tapılmadı') : _t('Hələ satış yoxdur'))));
      list.forEach(function (s) {
        var names = s.lines.map(function (l) { return l.name; }).join(', ');
        tb.appendChild(h('tr', { 'data-no': String(s.receiptNo) }, h('td', { class: 'mono' }, String(s.receiptNo).padStart(6, '0')), h('td', null, UI.fmtDate(s.at)), h('td', null, s.cashierName),
          h('td', { title: names, style: 'max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px' }, names),
          h('td', null, UI.METHOD[s.payment.method] + (s.payment.bankType ? ' · ' + UI.BANK_TYPE[s.payment.bankType] : '')),
          h('td', { class: 'num' }, M.format(s.totals.total), discountOf(s) ? h('div', { class: 'muted', style: 'font-size:12px' }, _t('endirim −{0}', [M.format(discountOf(s))])) : null),
          h('td', null, s.offline ? h('span', { class: 'badge' }, _t('Oflayn')) : null),
          h('td', null, h('button', { class: 'btn small', 'data-act': 'reprint', onclick: function () {
            UI.approve(_t('Çeki yenidən çap et'), _t('Çek № {0} "YENİDƏN ÇAP" qeydi ilə çap olunur.', [s.receiptNo]), 'pos.return.approve').then(function (a) {
              if (!a) return;
              S.auditEvent('receipt.reprinted', { saleId: s.id, approvedBy: a.id });
              S.storeInfo().then(function (store) { UI.printHtml(UI.receiptHtml(s, store, { reprint: true })); });
            });
          } }, _t('Yenidən çap et')))));
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
        authPolicyCard(),
        can('admin.users') ? usersCard() : null,
        can('admin.users') ? discountCapsCard(r[1]) : null,
        settingsCard(r[1]),
        devicesCard(),
        archiveCard()));
    }).catch(function (e) { el.appendChild(h('div', { class: 'page' }, h('div', { class: 'card empty' }, e.message))); });
  }

  // Admin: bütün çek üçün endirim həddi (həm faiz, həm məbləğ). Məhsul üzrə hədd məhsulun kartındadır.
  function discountCapsCard(store) {
    var caps = R.discountCaps(store);
    var pct = h('input', { class: 'input mono', id: 'dc-pct', inputmode: 'decimal', value: String(caps.percent).replace('.', ',') });
    var amt = h('input', { class: 'input mono', id: 'dc-amt', inputmode: 'decimal', value: M.format(caps.amount).replace(/\s/g, '') });
    return h('div', { class: 'card', id: 'dc-card', style: 'margin-top:24px;padding:20px;display:flex;flex-direction:column;gap:14px' },
      h('h2', { style: 'margin:0;font-size:18px' }, _t('Çek üzrə endirim həddi')),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', { for: 'dc-pct' }, _t('Ən çox endirim, %')), pct),
        h('div', { class: 'field' }, h('label', { for: 'dc-amt' }, _t('Ən çox endirim məbləği, ₼')), amt)),
      h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Kassir bütün çekə bu hədlərdən çox endirim edə bilməz. Həm faiz, həm məbləğ həddi eyni anda gözlənilir (hansı kiçikdirsə o). 0 yazsanız çek üzrə endirim bağlanır. Hər məhsula endirim həddi isə məhsulun kartında təyin olunur.')),
      h('div', null, h('button', { class: 'btn primary', id: 'dc-save', type: 'button', onclick: function () {
        var p = Number(String(pct.value).trim().replace(',', '.')), a = M.parse(amt.value);
        if (pct.value.trim() === '' || !Number.isFinite(p) || p < 0 || p > 100) return UI.toast(_t('Endirim faizi 0 ilə 100 arasında olmalıdır'), 'bad');
        if (a == null) return UI.toast(_t('Endirim məbləği səhvdir'), 'bad');
        S.setStoreInfo({ discountMaxPercent: p, discountMaxAmount: a }).then(function () { UI.toast(_t('Yadda saxlanıldı')); }).catch(function (e) { UI.toast(e.message, 'bad'); });
      } }, _t('Yadda saxla'))));
  }

  function settingsCard(store) {
    function f(id, label, val, attrs) { var i = h('input', Object.assign({ class: 'input', id: id, value: val || '' }, attrs || {})); return { i: i, el: h('div', { class: 'field' }, h('label', { for: id }, label), i) }; }
    var name = f('s-name', _t('Mağaza adı'), store.name), voen = f('s-voen', _t('VÖEN'), store.voen), addr = f('s-addr', _t('Ünvan'), store.address), reg = f('s-reg', _t('Kassa adı'), store.registerName);
    var url = f('s-url', _t('Apps Script veb tətbiq ünvanı'), '', { placeholder: 'https://script.google.com/macros/s/…/exec' });
    var tok = f('s-tok', _t('Bu cihazın sinxron açarı'), '', { type: 'password', autocomplete: 'off', placeholder: _t('Dəyişmək üçün yazın') });
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
        if (st.kind) info.appendChild(h('div', { id: 's-kind' }, st.kind === 'legacy' ? _t('Açar: köhnə ümumi açar (Admin-dən bu cihaz üçün ayrıca açar alın)') : _t('Açar: bu cihaza məxsusdur')));
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
      info, deviceIdLine(), conflicts,
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

  // Admin: Google Sheets tutumu və arxivləşdirmə (Code.gs v7). Sheets bir faylda 10 milyon xanaya icazə verir (boş xanalar da sayılır): dolanda sinxron dayanır.
  function archiveCard() {
    var body = h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, h('div', { class: 'muted' }, _t('Yüklənir…')));
    function num(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

    function runModal(st) {
      var prog = h('p', { class: 'muted', id: 'arch-prog', hidden: true, role: 'status', style: 'margin:0' }, _t('Arxivləşdirilir… 1–5 dəqiqə çəkə bilər, pəncərəni bağlamayın.'));
      UI.modal({
        title: _t('Arxivləşdirmə'), sticky: true,
        body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
          h('p', { style: 'margin:0' }, _t('Son {0} gündən köhnə qeydlər Drive-da yeni arxiv faylına köçürüləcək. 1–5 dəqiqə çəkə bilər: bu müddətdə kassa işləyir, amma sinxron gecikə bilər. İş saatından sonra edin.', [st.keepDays])),
          prog),
        buttons: [{ text: _t('Ləğv et') }, { text: _t('Arxivləşdir'), kind: 'primary', submit: true, onClick: function (close) {
          prog.hidden = false;
          return root.Sync.cycle().catch(function () { /* bu cihazın göndərilməmiş qeydləri əvvəl getsin; alınmasa da arxivləşdirmə təhlükəsizdir */ })
            .then(function () { return root.Sync.archiveRun(); })
            .then(function (r) {
              close();
              if (!r.archived) UI.toast(_t('Arxivləşdirməyə dəyər köhnə qeyd yoxdur: {0} gündən köhnə kifayət qədər qeyd yoxdur', [st.keepDays]));
              else UI.toast(_t('Arxivləşdirildi: {0} hadisə köçürüldü. Cədvəl tutumu: {1}%', [num(r.removed.Events), Math.round(r.cells / st.limit * 1000) / 10]), r.warnings && r.warnings.length ? 'bad' : '');
              load();
            });
        } }]
      });
    }

    function show(st) {
      UI.clear(body);
      var hot = st.pct >= 70;
      body.appendChild(h('div', null,
        h('div', { id: 'arch-cap', class: hot ? 'warn-text' : '' }, _t('Cədvəl tutumu: {0}% ({1} / {2} xana)', [st.pct, num(st.cells), num(st.limit)])),
        h('div', { class: 'meter' + (hot ? ' hot' : ''), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(st.pct)), 'aria-label': _t('Cədvəl tutumu') }, h('i', { style: 'width:' + Math.min(Math.max(st.pct, 0.5), 100) + '%' }))));
      body.appendChild(h('div', { class: 'muted', style: 'font-size:14px' },
        _t('Hadisə: canlı {0} · arxivdə {1} · cəmi {2}', [num(st.live), num(st.base), num(st.total)]), ' · ',
        st.last ? _t('Son arxivləşdirmə: {0}', [UI.fmtDate(st.last)]) : _t('Hələ arxivləşdirilməyib')));
      if (hot) body.appendChild(h('div', { class: 'warn-text', style: 'font-size:14px' }, _t('Tutum dolmağa yaxınlaşır. İş saatından sonra arxivləşdirin.')));
      body.appendChild(h('p', { class: 'muted', style: 'margin:0;font-size:13px' },
        _t('Arxivləşdirmə son {0} gündən köhnə qeydləri Drive-da yeni arxiv faylına köçürür, cədvəldə yalnız yeni qeydləri saxlayır. Heç nə itmir, cihazlar heç nə etmir.', [st.keepDays])));
      body.appendChild(h('div', { class: 'row' },
        h('button', { class: 'btn primary', id: 'arch-run', type: 'button', onclick: function () { runModal(st); } }, _t('Köhnə qeydləri arxivləşdir')),
        h('button', { class: 'btn', type: 'button', onclick: load }, _t('Yenilə'))));
      if (st.segs && st.segs.length) {
        body.appendChild(h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'arch-files' },
          h('thead', null, h('tr', null, h('th', null, _t('Tarix')), h('th', null, _t('Hadisələr')), h('th', { class: 'num' }, _t('Köçürülən')), h('th', null, _t('Fayl')))),
          h('tbody', null, st.segs.slice().reverse().map(function (g) {
            return h('tr', null, h('td', null, UI.fmtDate(g.at)), h('td', { class: 'mono' }, '#' + num(g.from + 1) + '–' + num(g.to)), h('td', { class: 'num' }, num(g.moved)),
              h('td', null, h('a', { href: g.url, target: '_blank', rel: 'noopener noreferrer' }, _t('Aç'))));
          })))));
        body.appendChild(h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Arxiv fayllarını silməyin. Onları Drive-da başqa qovluğa köçürə bilərsiniz.')));
      }
    }

    function load() {
      return root.Sync.archiveStatus().then(show).catch(function (e) {
        UI.clear(body);
        var old = e.message === _t('Naməlum əməliyyat');
        body.appendChild(h('div', { class: 'muted', id: 'arch-err' }, old ? _t('Skript köhnədir: yeni Code.gs (v7) yerləşdirin, setup() işlədin və Deploy → New version edin.') : _t('Arxiv məlumatı alınmadı: {0}', [e.message])));
      });
    }
    load();
    return h('div', { class: 'card', id: 'archive-card', style: 'margin-top:24px;padding:20px;display:flex;flex-direction:column;gap:14px' },
      h('h2', { style: 'margin:0;font-size:18px' }, _t('Arxiv (Google Sheets tutumu)')), body);
  }

  // Admin: rola görə giriş forması. PIN (4–8 rəqəm) və ya şifrə (≥8 simvol, böyük+kiçik hərf, rəqəm, işarə). Dəyişəndə həmin roldakılar öz hazırkı kodu ilə daxil olur, sonra yenisini seçməlidirlər.
  function authPolicyCard() {
    var body = h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, h('div', { class: 'muted' }, _t('Yüklənir…')));
    var ROLE_ORDER = ['admin', 'menecer', 'kassir', 'muhasib'];
    function load() {
      return Promise.all([S.getAuthPolicy(), S.listAllUsers().catch(function () { return []; })]).then(function (r) {
        var pol = r[0], users = r[1], sels = {};
        var tb = h('tbody');
        ROLE_ORDER.forEach(function (role) {
          var sel = h('select', { class: 'input', id: 'ap-' + role, 'aria-label': R.ROLE_NAMES[role] },
            h('option', { value: 'pin', selected: pol[role] === 'pin' }, _t('PIN (4–8 rəqəm)')),
            h('option', { value: 'password', selected: pol[role] === 'password' }, _t('Şifrə (hərf, rəqəm, işarə)')));
          sels[role] = sel;
          var pending = users.filter(function (u) { return u.active && u.role === role && u.cred !== pol[role]; }).length;
          tb.appendChild(h('tr', { 'data-role': role }, h('td', null, R.ROLE_NAMES[role]), h('td', null, sel),
            h('td', { class: 'muted' }, pending ? _t('{0} nəfər növbəti girişdə dəyişəcək', [pending]) : '')));
        });
        UI.clear(body);
        body.appendChild(h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'auth-policy' }, h('thead', null, h('tr', null, h('th', null, _t('Rol')), h('th', null, _t('Giriş forması')), h('th', null, ''))), tb)));
        body.appendChild(h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Şifrə qaydası: ən azı {0} simvol, 1 böyük hərf, 1 kiçik hərf, 1 rəqəm, 1 işarə. Forma dəyişəndə həmin roldakılar öz hazırkı kodu ilə daxil olur və dərhal yenisini seçməlidir. Açıq sessiyalar bağlanmır, məcburi dəyişmə növbəti girişdə olur.', [R.PASSWORD_MIN])));
        body.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn primary', id: 'ap-save', type: 'button', onclick: function () {
          var next = {}; ROLE_ORDER.forEach(function (role) { next[role] = sels[role].value; });
          S.setAuthPolicy(next).then(function (res) {
            UI.toast(res.unchanged ? _t('Dəyişiklik yoxdur') : _t('Yadda saxlanıldı'));
            load(); if (root.Screens._refresh) root.Screens._refresh();
          }).catch(function (e) { UI.toast(e.message, 'bad'); });
        } }, _t('Yadda saxla'))));
      }).catch(function (e) { UI.clear(body); body.appendChild(h('div', { class: 'muted' }, e.message)); });
    }
    load();
    return h('div', { class: 'card', id: 'auth-policy-card', style: 'margin-top:24px;padding:20px;display:flex;flex-direction:column;gap:14px' },
      h('h2', { style: 'margin:0;font-size:18px' }, _t('Giriş forması (rol üzrə)')), body);
  }

  // Admin: istifadəçilər — yaratmaq, ad/rol dəyişmək, söndürmək, PIN sıfırlamaq
  function usersCard() {
    var tb = h('tbody');
    var ROLE_ORDER = ['admin', 'menecer', 'kassir', 'muhasib'];
    var me = S.currentUser();

    function tempPinModal(title, name, temp, form) {
      UI.modal({ title: title, body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
        h('div', { class: 'pin-reset', id: 'temp-pin' }, temp),
        h('p', { class: 'muted', style: 'margin:0' }, form === 'password' ? _t('{0} üçün müvəqqəti şifrə bir dəfə göstərilir. İndi ötürün: ilk girişdə özünün yeni şifrəsini seçəcək.', [name]) : _t('{0} üçün müvəqqəti PIN bir dəfə göstərilir. İndi ötürün: ilk girişdə özünün yeni PIN-ini seçəcək.', [name]))) });
    }

    function load() {
      return S.listAllUsers().then(function (users) {
        users.sort(function (a, b) {
          return (b.active - a.active) || (ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)) || a.name.localeCompare(b.name, 'az');
        });
        UI.clear(tb);
        users.forEach(function (u) {
          var state = !u.active ? h('span', { class: 'badge off' }, _t('Söndürülüb')) : u.mustChange ? h('span', { class: 'badge' }, u.target === 'password' ? _t('Şifrə dəyişməlidir') : _t('PIN dəyişməlidir')) : h('span', { class: 'badge ok' }, _t('Aktiv'));
          var formTxt = (u.cred === 'password' ? _t('Şifrə') : _t('PIN')) + (u.cred !== u.target ? ' → ' + (u.target === 'password' ? _t('Şifrə') : _t('PIN')) : '');
          var isMe = me && u.id === me.id;
          tb.appendChild(h('tr', { 'data-user': u.name, class: u.active ? '' : 'inactive' },
            h('td', null, u.name, isMe ? h('span', { class: 'muted' }, ' (siz)') : null), h('td', null, R.ROLE_NAMES[u.role]), h('td', { class: 'muted' }, formTxt), h('td', null, state),
            h('td', { style: 'text-align:right;white-space:nowrap' },
              h('button', { class: 'btn small', type: 'button', 'data-act': 'edit', onclick: function () { edit(u); } }, _t('Redaktə')), ' ',
              u.active ? h('button', { class: 'btn small', type: 'button', 'data-act': 'reset', onclick: function () { resetPin(u); } }, u.target === 'password' ? _t('Şifrəni sıfırla') : _t('PIN-i sıfırla')) : null, ' ',
              isMe ? null : h('button', { class: 'btn small' + (u.active ? ' danger' : ''), type: 'button', 'data-act': 'toggle', onclick: function () { toggle(u); } }, u.active ? _t('Söndür') : _t('Aktiv et')))));
        });
      });
    }

    function roleSelect(val) {
      var sel = h('select', { class: 'input', id: 'u-role' }, ROLE_ORDER.map(function (r) { return h('option', { value: r, selected: r === val }, R.ROLE_NAMES[r]); }));
      return sel;
    }

    function create() {
      S.getAuthPolicy().then(function (pol) {
        var name = h('input', { class: 'input', id: 'u-name', maxlength: '40', autocomplete: 'off', placeholder: _t('Məs. Elvin Babayev') });
        var role = roleSelect('kassir');
        var hint = h('p', { class: 'muted', style: 'margin:0;font-size:13px', id: 'u-hint' });
        function setHint() { hint.textContent = pol[role.value] === 'password' ? _t('Müvəqqəti şifrə yaradılacaq; istifadəçi ilk girişdə öz şifrəsini seçir.') : _t('Müvəqqəti PIN yaradılacaq; istifadəçi ilk girişdə öz PIN-ini seçir.'); }
        role.addEventListener('change', setHint); setHint();
        UI.modal({
          title: _t('Yeni istifadəçi'),
          body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
            h('div', { class: 'field' }, h('label', { for: 'u-name' }, _t('Ad və soyad')), name),
            h('div', { class: 'field' }, h('label', { for: 'u-role' }, _t('Rol')), role), hint),
          buttons: [{ text: _t('İmtina') }, { text: _t('Yarat'), kind: 'primary', submit: true, onClick: function (close) {
            return S.createUser({ name: name.value, role: role.value }).then(function (r) {
              close(); load();
              tempPinModal(_t('İstifadəçi yaradıldı'), r.user.name, r.tempPin, r.cred);
            });
          } }]
        });
      });
    }

    function edit(u) {
      S.getAuthPolicy().then(function (pol) { editModal(u, pol); });
    }
    function editModal(u, pol) {
      var name = h('input', { class: 'input', id: 'u-name', maxlength: '40', autocomplete: 'off', value: u.name });
      var role = roleSelect(u.role);
      if (me && u.id === me.id) role.disabled = true;           // öz rolunu dəyişmək Admini sistemdən kənarlaşdıra bilər
      var formHint = h('p', { class: 'muted', style: 'margin:0;font-size:13px', id: 'u-form-hint', hidden: true }, _t('Bu rolun giriş forması fərqlidir: istifadəçi növbəti girişdə öz hazırkı kodu ilə daxil olub yenisini seçəcək.'));
      function setFormHint() { formHint.hidden = (pol[role.value] || 'pin') === u.cred; }
      role.addEventListener('change', setFormHint); setFormHint();
      UI.modal({
        title: _t('Redaktə — {0}', [u.name]),
        body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
          h('div', { class: 'field' }, h('label', { for: 'u-name' }, _t('Ad və soyad')), name),
          h('div', { class: 'field' }, h('label', { for: 'u-role' }, _t('Rol')), role),
          me && u.id === me.id ? h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Öz rolunuzu dəyişə bilməzsiniz.')) :
            h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Rol dəyişəndə istifadəçinin açıq cihazında menyu və icazələr bir neçə saniyəyə yenilənir.')), formHint),
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
      var pw = u.target === 'password';
      UI.modal({
        title: pw ? _t('Şifrəni sıfırla — {0}', [u.name]) : _t('PIN-i sıfırla — {0}', [u.name]),
        body: h('p', { style: 'margin:0' }, pw ? _t('Müvəqqəti şifrə yaradılacaq. İstifadəçi ilk girişdə özünün yeni şifrəsini seçəcək. Köhnə kod dərhal etibarsız olur.') : _t('Müvəqqəti PIN yaradılacaq. İstifadəçi ilk girişdə özünün yeni PIN-ini seçəcək. Köhnə PIN dərhal etibarsız olur.')),
        buttons: [{ text: _t('İmtina') }, { text: _t('Sıfırla'), kind: 'danger', submit: true, onClick: function (close) {
          return S.resetPin(u.id).then(function (temp) { close(); tempPinModal(pw ? _t('Müvəqqəti şifrə') : _t('Müvəqqəti PIN'), u.name, temp, u.target); load(); });
        } }]
      });
    }

    load();
    root.Screens._refresh = load;     // başqa cihazdan istifadəçi dəyişikliyi gələndə siyahı yenilənir
    return h('div', { class: 'card table-wrap', tabindex: '0', style: 'margin-top:24px', id: 'users-card' },
      h('div', { style: 'padding:16px 20px 0;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap' },
        h('h2', { style: 'margin:0;font-size:18px' }, _t('İstifadəçilər')),
        h('button', { class: 'btn primary small', type: 'button', id: 'user-add', onclick: create }, _t('+ Yeni istifadəçi'))),
      h('table', null, h('thead', null, h('tr', null, h('th', null, _t('Ad')), h('th', null, _t('Rol')), h('th', null, _t('Giriş forması')), h('th', null, _t('Vəziyyət')), h('th', null, ''))), tb));
  }

  /* ================= Cihaz açarları (Code.gs v9, FR-101) ================= */
  function shortId(id) { return String(id || '').slice(-8); }

  // Bu cihazın tam ID-si (Admin onu "Cihazlar" kartında yazır) + kopyala
  function deviceIdLine() {
    var id = S.deviceId() || '';
    return h('div', { class: 'device-id', id: 'device-id-line' },
      h('span', { class: 'muted' }, _t('Bu cihazın ID-si')), ' ',
      h('code', { class: 'mono', id: 'device-id' }, id), ' ',
      h('button', { class: 'btn small', type: 'button', id: 'device-id-copy', onclick: function () {
        copyText(id).then(function () { UI.toast(_t('Kopyalandı')); }, function () { UI.toast(id); });
      } }, _t('Kopyala')));
  }

  // Açar yaradılanda yalnız bir dəfə göstərilir (serverdə yalnız hash saxlanılır: itirilibsə "Yeni açar" yaradılır)
  function tokenModal(r, done) {
    var tok = h('input', { class: 'input mono', id: 'dev-token', readonly: true, value: r.token, 'aria-label': _t('Cihaz açarı'), onfocus: function () { this.select(); } });
    var mine = r.id === S.deviceId();
    var buttons = [{ text: _t('Kopyala'), onClick: function () { return copyText(r.token).then(function () { UI.toast(_t('Kopyalandı')); }); } }];
    if (mine) buttons.push({ text: _t('Bu cihaza tətbiq et'), onClick: function (close) {
      return root.Sync.endpoint().then(function (u) { return root.Sync.setEndpoint(u, r.token); }).then(function () { return root.Sync.cycle(); })
        .then(function () { UI.toast(_t('Bu cihazın açarı yeniləndi')); close(); });
    } });
    buttons.push({ text: _t('Bağla'), kind: 'primary' });
    UI.modal({
      title: _t('Cihaz açarı'), sticky: true, onClose: done,
      body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
        h('p', { style: 'margin:0' }, _t('«{0}» cihazı üçün açar yaradıldı. Açar yalnız indi göstərilir: kopyalayın.', [r.name || shortId(r.id)])),
        tok,
        h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Həmin cihazda "Rollar və icazələr → Mağaza və server" bölməsindəki açar sahəsinə (və ya giriş ekranında "Bu cihazı serverə qoş"a) yazın. Açar itərsə, yeni açar yaradılır; köhnəsi dayanır.'))),
      buttons: buttons
    });
  }

  // Admin: cihazlar, onların açarları, bloklama (Code.gs v9). ADMIN_KEY hər dəfə əl ilə yazılır, yalnız yaddaşda qalır (ekran bağlananda itir).
  function devicesCard() {
    var adminKey = '';
    var body = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
    function call(action, extra) { return root.Sync.api(action, Object.assign({ adminKey: adminKey }, extra || {})); }
    function nice(e) { return e && e.message === _t('Naməlum əməliyyat') ? new Error(_t('Cihaz açarları üçün Code.gs v9 lazımdır: yeni kodu yapışdırıb "New version" deploy edin')) : e; }
    function bad(e) { UI.toast(nice(e).message, 'bad'); }

    function askKey(note) {
      UI.clear(body);
      var inp = h('input', { class: 'input mono', id: 'dev-key', type: 'password', autocomplete: 'off' });
      var form = h('form', { class: 'row', style: 'gap:8px;align-items:flex-end;flex-wrap:wrap' },
        h('div', { class: 'field', style: 'flex:1;min-width:220px' }, h('label', { for: 'dev-key' }, _t('Admin açarı (ADMIN_KEY)')), inp),
        h('button', { class: 'btn primary', id: 'dev-open', type: 'submit' }, _t('Cihazları göstər')));
      form.addEventListener('submit', function (e) { e.preventDefault(); adminKey = inp.value.trim(); inp.value = ''; if (adminKey) load(); });
      body.appendChild(h('p', { class: note ? 'warn-text' : 'muted', id: 'dev-msg', role: 'status', style: 'margin:0;font-size:13px' },
        note || _t('Cihazları idarə etmək üçün Admin açarını yazın. O yalnız Apps Script-də (Script properties → ADMIN_KEY) saxlanılır; bu cihazda saxlanmır.')));
      body.appendChild(form);
    }

    function load() {
      UI.clear(body); body.appendChild(h('div', { class: 'muted' }, _t('Yüklənir…')));
      return call('devices.list').then(show, function (e) { adminKey = ''; askKey(nice(e).message); });
    }
    function reload() { return call('devices.list').then(show, function (e) { adminKey = ''; askKey(nice(e).message); }); }

    function nameModal(title, initial, okText, fn) {
      var inp = h('input', { class: 'input', id: 'dev-name', maxlength: '60', value: initial || '' });
      UI.modal({ title: title, body: h('div', { class: 'field' }, h('label', { for: 'dev-name' }, _t('Cihazın adı (məs. Kassa 2, Anbar)')), inp),
        buttons: [{ text: _t('İmtina') }, { text: okText, kind: 'primary', submit: true, onClick: function (close) { return fn(inp.value.trim()).then(function () { close(); }); } }] });
    }
    function create(id, name, rotate) {
      return call(rotate ? 'devices.rotate' : 'devices.create', { id: id, name: name }).then(function (r) { tokenModal(r, reload); reload(); });
    }
    function revokeModal(d) {
      var why = h('input', { class: 'input', id: 'dev-why', maxlength: '60' });
      UI.modal({ title: _t('Cihazı blokla'), sticky: true,
        body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
          h('p', { style: 'margin:0' }, _t('«{0}» serverə qoşula bilməyəcək, tətbiq həmin cihazda kilidlənəcək. Məlumat silinmir; cihaz sonra bərpa edilə bilər.', [d.name || shortId(d.id)])),
          h('div', { class: 'field' }, h('label', { for: 'dev-why' }, _t('Səbəb (istəyə bağlı)')), why)),
        buttons: [{ text: _t('İmtina') }, { text: _t('Blokla'), kind: 'danger', submit: true, onClick: function (close) {
          return call('devices.revoke', { id: d.id, name: d.name, reason: why.value.trim() }).then(function () { close(); UI.toast(_t('Cihaz bloklandı')); reload(); });
        } }] });
    }
    function legacyBlock(lg) {
      var row = h('div', { class: 'row', id: 'dev-legacy', style: 'gap:8px;align-items:center;flex-wrap:wrap' });
      var txt;
      if (!lg.tokenSet) txt = _t('Köhnə ümumi açar (SYNC_TOKEN) təyin olunmayıb.');
      else if (lg.active && lg.until) txt = _t('Köhnə ümumi açar hələ işləyir, son tarix: {0}. Bütün cihazlara öz açarını verəndən sonra söndürün.', [UI.fmtDate(lg.until)]);
      else if (lg.active) txt = _t('Köhnə ümumi açar hələ işləyir. İlk cihaz açarı yaradılandan 14 gün sonra bağlanacaq.');
      else txt = _t('Köhnə ümumi açar söndürülüb.');
      row.appendChild(h('span', { class: lg.active ? 'warn-text' : 'muted', style: 'font-size:14px' }, txt));
      if (lg.tokenSet && lg.active) {
        row.appendChild(h('button', { class: 'btn small danger', type: 'button', id: 'dev-legacy-off', onclick: function () {
          UI.modal({ title: _t('Ümumi açarı söndür'), sticky: true, body: h('p', { style: 'margin:0' }, _t('Hələ öz açarı olmayan cihazlar serverə qoşula bilməyəcək (qeydləri cihazda qalır). Davam edək?')),
            buttons: [{ text: _t('İmtina') }, { text: _t('Söndür'), kind: 'danger', submit: true, onClick: function (close) { return call('legacy.set', { mode: 'off' }).then(function () { close(); reload(); }); } }] });
        } }, _t('Söndür')));
        if (lg.until) row.appendChild(h('button', { class: 'btn small', type: 'button', id: 'dev-legacy-ext', onclick: function () { call('legacy.set', { mode: 'on', days: 14 }).then(function () { UI.toast(_t('14 gün uzadıldı')); reload(); }).catch(bad); } }, _t('14 gün uzat')));
      } else if (lg.tokenSet) {
        row.appendChild(h('button', { class: 'btn small', type: 'button', id: 'dev-legacy-on', onclick: function () { call('legacy.set', { mode: 'on', days: 14 }).then(function () { reload(); }).catch(bad); } }, _t('14 gün aç')));
      }
      return row;
    }
    function kindText(d) { return !d.hasToken ? _t('açarı yoxdur') : d.lastKind === 'legacy' ? _t('ümumi açar (köhnə)') : d.lastKind === 'device' ? _t('öz açarı') : '—'; }
    function deviceTable(list) {
      if (!list.length) return h('p', { class: 'muted', id: 'dev-empty', style: 'margin:0;font-size:14px' }, _t('Hələ heç bir cihaza ayrıca açar verilməyib.'));
      return h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'dev-table' },
        h('thead', null, h('tr', null, h('th', null, _t('Cihaz')), h('th', null, _t('Açar')), h('th', null, _t('Son görünmə')), h('th', null, _t('Vəziyyət')), h('th', null, ''))),
        h('tbody', null, list.map(function (d) {
          var me = d.id === S.deviceId();
          return h('tr', { 'data-id': d.id },
            h('td', null, h('b', null, d.name || shortId(d.id)), ' ', h('span', { class: 'mono muted', title: d.id }, shortId(d.id)), me ? [' ', h('span', { class: 'badge' }, _t('Bu cihaz'))] : null),
            h('td', null, kindText(d)),
            h('td', null, d.lastSeen ? UI.fmtDate(d.lastSeen) : '—'),
            h('td', null, d.status === 'revoked' ? h('span', { class: 'badge bad', title: d.reason || '' }, _t('Bloklanıb')) : _t('Aktiv')),
            h('td', null, h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
              d.status === 'revoked'
                ? h('button', { class: 'btn small', type: 'button', 'data-act': 'restore', onclick: function () { call('devices.restore', { id: d.id }).then(function () { UI.toast(_t('Cihaz bərpa edildi')); reload(); }).catch(bad); } }, _t('Bərpa et'))
                : [h('button', { class: 'btn small', type: 'button', 'data-act': 'rotate', onclick: function () {
                    UI.modal({ title: _t('Yeni açar'), sticky: true, body: h('p', { style: 'margin:0' }, _t('Köhnə açar dərhal dayanacaq; cihaza yeni açar yazılana qədər o, serverə qoşula bilməyəcək. Davam edək?')),
                      buttons: [{ text: _t('İmtina') }, { text: _t('Yeni açar yarat'), kind: 'primary', submit: true, onClick: function (close) { return create(d.id, d.name, true).then(close); } }] });
                  } }, d.hasToken ? _t('Yeni açar') : _t('Açar yarat')),
                  h('button', { class: 'btn small', type: 'button', 'data-act': 'rename', onclick: function () { nameModal(_t('Cihazın adı'), d.name, _t('Yadda saxla'), function (n) { return call('devices.rename', { id: d.id, name: n }).then(reload); }); } }, _t('Ad')),
                  h('button', { class: 'btn small danger', type: 'button', 'data-act': 'revoke', disabled: me, title: me ? _t('Admin kompüterinin özünü bloklamaq olmaz') : null, onclick: function () { revokeModal(d); } }, _t('Blokla'))])));
        }))));
    }
    function unknownTable(list) {
      return h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
        h('h3', { style: 'margin:0;font-size:15px' }, _t('Ümumi açarla işləyən tanınmayan cihazlar')),
        h('div', { class: 'table-wrap', tabindex: '0' }, h('table', { id: 'dev-unknown' },
          h('thead', null, h('tr', null, h('th', null, _t('Cihaz ID')), h('th', null, _t('Son görünmə')), h('th', null, ''))),
          h('tbody', null, list.map(function (u) {
            return h('tr', { 'data-id': u.id },
              h('td', null, h('span', { class: 'mono', title: u.id }, shortId(u.id)), u.id === S.deviceId() ? [' ', h('span', { class: 'badge' }, _t('Bu cihaz'))] : null),
              h('td', null, u.lastSeen ? UI.fmtDate(u.lastSeen) : '—'),
              h('td', null, h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
                h('button', { class: 'btn small primary', type: 'button', 'data-act': 'create', onclick: function () {
                  nameModal(_t('Cihaz üçün açar yarat'), '', _t('Açar yarat'), function (n) { return create(u.id, n, false); });
                } }, _t('Açar yarat')),
                h('button', { class: 'btn small danger', type: 'button', 'data-act': 'revoke', disabled: u.id === S.deviceId(), onclick: function () { revokeModal({ id: u.id, name: '' }); } }, _t('Blokla')))));
          })))));
    }
    function addForm(list) {
      var known = list.some(function (d) { return d.id === S.deviceId(); });
      var id = h('input', { class: 'input mono', id: 'dev-new-id', autocomplete: 'off', value: known ? '' : (S.deviceId() || '') });
      var nm = h('input', { class: 'input', id: 'dev-new-name', maxlength: '60', autocomplete: 'off' });
      var form = h('form', { style: 'display:flex;flex-direction:column;gap:8px' },
        h('h3', { style: 'margin:0;font-size:15px' }, _t('Yeni cihaz üçün açar')),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { for: 'dev-new-id' }, _t('Cihaz ID')), id),
          h('div', { class: 'field' }, h('label', { for: 'dev-new-name' }, _t('Cihazın adı (məs. Kassa 2, Anbar)')), nm)),
        h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Cihazın ID-sini həmin cihazda "Mağaza və server" bölməsində (və ya qoşulma pəncərəsində) görə bilərsiniz.') + (known ? '' : ' ' + _t('Bu cihazın ID-si hazır yazılıb.'))),
        h('div', null, h('button', { class: 'btn primary', id: 'dev-new-go', type: 'submit' }, _t('Açar yarat'))));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        create(id.value.trim(), nm.value.trim(), false).catch(bad);
      });
      return form;
    }
    // Bloklanmış cihazdan çıxarılmış qeydləri qəbul edir: bu cihazın göndərmə növbəsinə qoyulur
    function importBlock() {
      var file = h('input', { type: 'file', accept: '.json,application/json', id: 'dev-import', 'aria-label': _t('Növbə faylı') });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0]; if (!f) return;
        f.text().then(function (txt) { return root.Sync.importOutbox(txt); })
          .then(function (r) { UI.toast(_t('{0} qeyd göndərmə növbəsinə qoyuldu ({1} artıq var idi)', [r.added, r.skipped])); })
          .catch(bad).then(function () { file.value = ''; });
      });
      return h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
        h('h3', { style: 'margin:0;font-size:15px' }, _t('Bloklanmış cihazdan qeydlər')),
        h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Bloklanmış cihazın serverə göndərilməmiş qeydləri varsa, o cihazın ekranından fayla yüklənir. Faylı buradan seçin: qeydlər bu cihazdan serverə göndəriləcək.')),
        file);
    }

    function show(res) {
      UI.clear(body);
      body.appendChild(h('div', { class: 'row', style: 'justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap' },
        h('span', { class: 'muted', style: 'font-size:13px' }, _t('Admin açarı qəbul edildi')),
        h('button', { class: 'btn small', id: 'dev-lock', type: 'button', onclick: function () { adminKey = ''; askKey(); } }, _t('Kilidlə'))));
      body.appendChild(legacyBlock(res.legacy));
      body.appendChild(deviceTable(res.devices));
      if (res.unknown.length) body.appendChild(unknownTable(res.unknown));
      body.appendChild(addForm(res.devices));
      body.appendChild(importBlock());
    }

    askKey();
    return h('div', { class: 'card', id: 'dev-card', style: 'margin-top:24px;padding:20px;display:flex;flex-direction:column;gap:14px' },
      h('h2', { style: 'margin:0;font-size:18px' }, _t('Cihazlar və sinxron açarları')),
      h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, _t('Hər kompüter və telefon öz açarı ilə qoşulur. Cihaz itərsə və ya işçi getsə, onu burada bloklayın: məlumat silinmir, amma cihaz serverə qoşula bilməz.')),
      body);
  }

  // Admin cihazı bloklayıb (Code.gs v9). Tətbiq kilidlənir, məlumat cihazda qalır; göndərilməmiş qeydləri Admin kodu ilə fayla çıxarmaq olar.
  function revokedLock(el, onUnlock) {
    UI.clear(el);
    var timer = null;
    var count = h('p', { class: 'muted', id: 'rv-count', style: 'margin:0' });
    var code = h('input', { class: 'input mono', id: 'rv-code', type: 'password', autocomplete: 'off' });
    var tok = h('input', { class: 'input mono', id: 'rv-tok', type: 'password', autocomplete: 'off' });
    var msg = h('p', { class: 'muted', id: 'rv-msg', role: 'status', style: 'margin:0;font-size:13px' });
    var exportBox = h('div', { class: 'field', id: 'rv-export-box', hidden: true },
      h('label', { for: 'rv-code' }, _t('Admin PIN / şifrəsi')), code,
      h('button', { class: 'btn', id: 'rv-export', type: 'button', style: 'margin-top:8px', onclick: function () {
        S.verifyAdminCode(code.value).then(function () { return root.Sync.exportOutbox(); }).then(function (r) {
          blobDownload('7boxs-novbe-' + shortId(S.deviceId()) + '-' + new Date().toISOString().slice(0, 10) + '.json', new Blob([r.text], { type: 'application/json' }));
          code.value = '';
          msg.textContent = _t('{0} qeyd faylda saxlanıldı. Admin faylı İcazələr → Cihazlar bölməsindən işləyən cihaza yükləsin.', [r.count]);
        }).catch(function (e) { msg.textContent = e.message; });
      } }, _t('Qeydləri fayla yüklə')));
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function check(manual) {
      var t = tok.value.trim();
      if (manual) msg.textContent = _t('Yoxlanılır…');
      var p = t ? root.Sync.endpoint().then(function (u) { return root.Sync.connect(u, t).then(function () { return true; }); }) : root.Sync.recheck();
      return p.then(function (ok) {
        if (ok) { stop(); onUnlock(); return; }
        if (manual) msg.textContent = _t('Cihaz hələ də bloklu qalır. Admin ilə əlaqə saxlayın.');
      }, function (e) { if (manual) msg.textContent = e.message; });
    }
    S.outboxCount().then(function (n) {
      count.textContent = n ? _t('Serverə göndərilməmiş qeyd: {0}. Onlar cihazda qalır.', [n]) : _t('Serverə göndərilməmiş qeyd yoxdur.');
      exportBox.hidden = !n;
    });
    var card = h('div', { class: 'card', id: 'revoked-card', style: 'display:flex;flex-direction:column;gap:12px' },
      h('h1', { style: 'margin:0;font-size:24px' }, _t('Bu cihaz bloklanıb')),
      h('p', { style: 'margin:0' }, _t('Administrator bu cihazı serverdən ayırıb. Tətbiqdən istifadə etmək olmaz, amma cihazdakı məlumat silinməyib. Cihaz sizindirsə, Administratorla əlaqə saxlayın.')),
      deviceIdLine(), count, exportBox,
      h('div', { class: 'field' }, h('label', { for: 'rv-tok' }, _t('Yeni açar (Administrator veribsə)')), tok),
      h('button', { class: 'btn primary', id: 'rv-recheck', type: 'button', onclick: function () { check(true); } }, _t('Yenidən yoxla')),
      msg);
    el.appendChild(h('div', { class: 'login' }, card));
    timer = setInterval(function () { check(false); }, 60000);
    return stop;
  }

  root.Screens = { login: login, revokedLock: revokedLock, forcePinChange: forcePinChange, products: products, suppliers: suppliers, returns: returns, shift: shift, sales: sales, admin: admin,
    pendingForMe: pendingForMe, approvalsModal: approvalsModal, _refresh: null };
})(window);
