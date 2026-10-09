/* Tətbiqin girişi: marşrutlar, menyu, status sətri. */
(function (root) {
  'use strict';
  var UI = root.UI, S = root.Services, R = root.Rules;
  var h = UI.h;
  var BUILD = '2026.10.10-3';   // hər buraxılışda artırılır; iki brauzerdə eyni görünməlidir

  var ROUTES = [
    { id: 'pos', label: 'Kassa', perm: 'pos.sell', render: function (el) { return root.POS.mount(el); } },
    { id: 'returns', label: 'Qaytarma', perm: 'pos.return.request', render: function (el) { root.Screens.returns(el); } },
    { id: 'products', label: 'Məhsullar', perm: 'product.view', render: function (el) { root.Screens.products(el); } },
    { id: 'suppliers', label: 'Təchizatçılar', perm: 'supplier.view', render: function (el) { root.Screens.suppliers(el); } },
    { id: 'sales', label: 'Çeklər', perm: 'report.view', render: function (el) { root.Screens.sales(el); } },
    { id: 'shift', label: 'Növbə', perm: 'shift.open_close', render: function (el) { root.Screens.shift(el); } },
    { id: 'admin', label: 'İcazələr', perm: 'admin.permissions', render: function (el) { root.Screens.admin(el); } }
  ];

  var app = { matrix: null, route: null };
  var shell, nav, main, statusEl;

  function allowed() { var u = S.currentUser(); return ROUTES.filter(function (r) { return u && R.can(app.matrix, u.role, r.perm); }); }

  function go(id) {
    var list = allowed();
    var r = list.find(function (x) { return x.id === id; }) || list[0];
    if (!r) { UI.clear(main).appendChild(h('div', { class: 'page' }, h('div', { class: 'card empty' }, 'Bu rol üçün açıq ekran yoxdur.'))); return; }
    app.route = r.id;
    root.Screens._refresh = null;
    if (location.hash !== '#' + r.id) history.replaceState(null, '', '#' + r.id);
    renderNav();
    UI.clear(main);
    r.render(main);
  }

  function renderNav() {
    UI.clear(nav);
    allowed().forEach(function (r) {
      nav.appendChild(h('button', { 'aria-current': app.route === r.id ? 'page' : null, onclick: function () { go(r.id); } }, r.label));
    });
  }

  var seenRequests = null;   // artıq görülmüş təsdiq sorğularının id-ləri (yenisi gələndə xəbərdarlıq üçün)

  function refreshStatus() {
    if (!statusEl || !S.currentUser()) return;
    Promise.all([S.currentShift(), S.outboxCount(), S.storeInfo(), root.Screens.pendingForMe()]).then(function (r) {
      var u = S.currentUser();
      if (!u || !statusEl) return;
      var online = navigator.onLine;
      var sy = root.Sync.status();
      UI.clear(statusEl);
      statusEl.appendChild(h('span', null, h('span', { class: 'dot' + (online ? '' : ' off') }), online ? 'Onlayn' : 'Oflayn'));
      if (online && sy.rttAvg) statusEl.appendChild(h('span', { class: 'muted', title: 'Google Apps Script serverinin orta cavab müddəti. Cihazlar arasında yenilik təxminən bunun 2–3 qatı qədər gecikir' }, 'Server ' + (sy.rttAvg / 1000).toFixed(1) + ' san'));
      statusEl.appendChild(h('span', { class: 'muted', title: 'Tətbiq versiyası. İki cihazda eyni olmalıdır; fərqlidirsə Ctrl+F5 basın' }, 'v' + BUILD));
      if (r[1]) statusEl.appendChild(h('span', { class: 'badge', title: 'Serverə göndərilməmiş qeydlər' }, r[1] + ' sinxron gözləyir'));
      if (sy.ok === false) statusEl.appendChild(h('span', { class: 'badge bad', title: sy.error || '' }, 'Sinxron xətası'));
      if (r[3].length) statusEl.appendChild(h('button', { class: 'btn small primary', id: 'req-btn', onclick: function () { root.Screens.approvalsModal(refreshStatus); } }, 'Sorğular (' + r[3].length + ')'));
      statusEl.appendChild(h('span', null, r[0] ? 'Növbə açıq · ' + UI.fmtDate(r[0].openedAt).split(', ').pop() : 'Növbə bağlı'));
      statusEl.appendChild(h('span', null, u.name + ' · ' + R.ROLE_NAMES[u.role]));
      statusEl.appendChild(h('button', { class: 'btn small', id: 'print-settings', title: 'Bu cihazın printeri: kağız eni, etiket ölçüsü, test çapı', onclick: function () { root.Print.settingsModal(); } }, 'Çap'));
      statusEl.appendChild(h('button', { class: 'btn small', onclick: logout }, 'Çıxış'));
      document.querySelector('.brand b').textContent = r[2].name;
      document.querySelector('.brand .muted').textContent = r[2].registerName;

      // Yeni təsdiq sorğusu gələndə səs + bildiriş
      var ids = {}; r[3].forEach(function (a) { ids[a.id] = a; });
      if (seenRequests) {
        var fresh = r[3].filter(function (a) { return !seenRequests[a.id]; });
        if (fresh.length) { UI.toast('Yeni təsdiq sorğusu: ' + fresh[0].summary); UI.beep(true); }
      }
      seenRequests = ids;
    });
  }

  function logout() { UI.abortPending(); S.logout(); root.POS.reset(); start(); }

  // Başqa cihazdan gələn dəyişikliklər: icazələr, istifadəçilər, qalıq, çeklər, sorğular
  function onApplied(t) {
    if (!S.currentUser()) return;
    var chain = Promise.resolve(true);
    if (t.users) {
      // Hesab söndürülübsə / PIN sıfırlanıbsa bu cihazda dərhal çıxış; ad və ya rol dəyişibsə menyu yenilənir
      chain = S.refreshSession().then(function (st) {
        if (st === 'gone') { UI.toast('Hesabınız dəyişdirilib və ya söndürülüb. Yenidən daxil olun', 'bad'); logout(); return false; }
        if (st === 'changed') t.matrix = true;
        return true;
      });
    }
    chain = chain.then(function (ok) {
      if (!ok) return false;
      if (!t.matrix) return true;
      return S.getMatrix().then(function (m) {
        app.matrix = m;
        renderNav();
        if (!allowed().some(function (r) { return r.id === app.route; })) go('');
        return true;
      });
    });
    chain.then(function (ok) {
      if (!ok) return;
      refreshStatus();
      if (document.querySelector('.modal-back')) return;       // açıq pəncərəni pozmuruq
      if ((t.products || t.sales) && app.route === 'pos') root.POS.refresh();
      else if ((t.products || t.sales || t.users) && root.Screens._refresh) root.Screens._refresh();
    });
  }

  function startShell() {
    shell = document.getElementById('app');
    UI.clear(shell);
    seenRequests = null;
    nav = h('nav', { class: 'nav', 'aria-label': 'Bölmələr' });
    statusEl = h('div', { class: 'status' });
    main = h('main', { id: 'main' });
    shell.appendChild(h('header', { class: 'topbar' }, h('div', { class: 'brand' }, h('b', null, ''), h('span', { class: 'muted', style: 'font-size:14px' }, '')), nav, statusEl));
    shell.appendChild(main);
    refreshStatus();
    go(location.hash.slice(1) || 'pos');
  }

  function start() {
    var el = document.getElementById('app');
    statusEl = null;
    root.Screens.login(el, function (user) {
      S.getMatrix().then(function (m) {
        app.matrix = m;
        // İlk giriş: yalnız yeni PIN səhifəsi görünür, kassa ekranı PIN dəyişənə qədər qurulmur
        if (user.mustChangePin) {
          return root.Screens.forcePinChange(el).then(function (ok) { if (ok) startShell(); else start(); });
        }
        startShell();
      });
    });
  }

  app.go = go; app.renderNav = renderNav; app.refreshStatus = refreshStatus;
  root.App = app;

  addEventListener('online', refreshStatus);
  addEventListener('offline', refreshStatus);
  setInterval(refreshStatus, 15000);   // sorğuların vaxtı bitməsi və növbə vəziyyəti üçün (lokal, şəbəkəsiz)
  root.Sync.on(function (kind, data) { if (kind === 'applied') onApplied(data); else refreshStatus(); });

  S.init().then(function () {
    root.Sync.start();
    // Yeniləmə çıxış etdirməsin: sessiya hələ etibarlıdırsa birbaşa işçi ekrana qayıdırıq
    return S.restoreSession().then(function (u) {
      if (!u) return start();
      return S.getMatrix().then(function (m) { app.matrix = m; startShell(); });
    });
  }).catch(function (e) {
    document.getElementById('app').textContent = 'Başlatma xətası: ' + e.message;
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:' && !root.__NO_SW__) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* oflayn rejim olmadan davam */ });
  }
})(window);
