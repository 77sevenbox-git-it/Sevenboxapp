/* Tətbiqin girişi: marşrutlar, menyu, status sətri. */
(function (root) {
  'use strict';
  var UI = root.UI, S = root.Services, R = root.Rules;
  var h = UI.h;

  var ROUTES = [
    { id: 'pos', label: 'Kassa', perm: 'pos.sell', render: function (el) { return root.POS.mount(el); } },
    { id: 'returns', label: 'Qaytarma', perm: 'pos.return.request', render: function (el) { root.Screens.returns(el); } },
    { id: 'products', label: 'Məhsullar', perm: 'product.view', render: function (el) { root.Screens.products(el); } },
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

  function refreshStatus() {
    if (!statusEl) return;
    Promise.all([S.currentShift(), S.outboxCount(), S.storeInfo()]).then(function (r) {
      var online = navigator.onLine;
      var u = S.currentUser();
      UI.clear(statusEl);
      statusEl.appendChild(h('span', null, h('span', { class: 'dot' + (online ? '' : ' off') }), online ? 'Onlayn' : 'Oflayn'));
      if (r[1]) statusEl.appendChild(h('span', { class: 'badge', title: 'Serverə göndərilməmiş qeydlər' }, r[1] + ' sinxron gözləyir'));
      statusEl.appendChild(h('span', null, r[0] ? 'Növbə açıq · ' + UI.fmtDate(r[0].openedAt).split(', ').pop() : 'Növbə bağlı'));
      statusEl.appendChild(h('span', null, u.name + ' · ' + R.ROLE_NAMES[u.role]));
      statusEl.appendChild(h('button', { class: 'btn small', onclick: logout }, 'Çıxış'));
      document.querySelector('.brand b').textContent = r[2].name;
      document.querySelector('.brand .muted').textContent = r[2].registerName;
    });
  }

  function logout() { S.logout(); start(); }

  function startShell() {
    shell = document.getElementById('app');
    UI.clear(shell);
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
    root.Screens.login(el, function (user) {
      S.getMatrix().then(function (m) {
        app.matrix = m;
        startShell();
        if (user.mustChangePin) root.Screens.forcePinChange();
      });
    });
  }

  app.go = go; app.renderNav = renderNav; app.refreshStatus = refreshStatus;
  root.App = app;

  addEventListener('online', refreshStatus);
  addEventListener('offline', refreshStatus);
  setInterval(function () { if (S.currentUser()) root.Sync.flush().then(refreshStatus); }, 30000);

  S.init().then(start).catch(function (e) {
    document.getElementById('app').textContent = 'Başlatma xətası: ' + e.message;
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:' && !root.__NO_SW__) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* oflayn rejim olmadan davam */ });
  }
})(window);
