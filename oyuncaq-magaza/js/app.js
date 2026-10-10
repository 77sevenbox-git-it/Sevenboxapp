/* Tətbiqin girişi: marşrutlar, menyu, status sətri. */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var UI = root.UI, S = root.Services, R = root.Rules;
  var h = UI.h;
  var BUILD = '2026.10.10-12';   // hər buraxılışda artırılır; iki brauzerdə eyni görünməlidir

  var ROUTES = [
    { id: 'pos', label: _t('Kassa'), perm: 'pos.sell', render: function (el) { return root.POS.mount(el); } },
    { id: 'returns', label: _t('Qaytarma'), perm: 'pos.return.request', render: function (el) { root.Screens.returns(el); } },
    { id: 'products', label: _t('Məhsullar'), perm: 'product.view', render: function (el) { root.Screens.products(el); } },
    { id: 'suppliers', label: _t('Təchizatçılar'), perm: 'supplier.view', render: function (el) { root.Screens.suppliers(el); } },
    { id: 'sales', label: _t('Çeklər'), perm: 'report.view', render: function (el) { root.Screens.sales(el); } },
    { id: 'shift', label: _t('Növbə'), perm: 'shift.open_close', render: function (el) { root.Screens.shift(el); } },
    { id: 'admin', label: _t('İcazələr'), perm: 'admin.permissions', render: function (el) { root.Screens.admin(el); } }
  ];

  var app = { matrix: null, route: null };
  var shell, nav, main, statusEl;

  function allowed() { var u = S.currentUser(); return ROUTES.filter(function (r) { return u && R.can(app.matrix, u.role, r.perm); }); }

  // Ekran açılanda yumşaq giriş animasiyası (sinif təkrar verilir ki, animasiya hər keçiddə yenidən oynasın)
  function animateIn(el, cls) { if (!el) return; var c = cls || 'screen-in'; el.classList.remove(c); void el.offsetWidth; el.classList.add(c); }

  function go(id) {
    var list = allowed();
    var r = list.find(function (x) { return x.id === id; }) || list[0];
    if (!r) { UI.clear(main).appendChild(h('div', { class: 'page' }, h('div', { class: 'card empty' }, _t('Bu rol üçün açıq ekran yoxdur.')))); return; }
    app.route = r.id;
    root.Screens._refresh = null;
    if (location.hash !== '#' + r.id) history.replaceState(null, '', '#' + r.id);
    renderNav();
    UI.clear(main);
    animateIn(main);
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
      statusEl.appendChild(h('span', null, h('span', { class: 'dot' + (online ? '' : ' off') }), online ? _t('Onlayn') : _t('Oflayn')));
      if (online && sy.rttAvg) statusEl.appendChild(h('span', { class: 'muted', title: _t('Google Apps Script serverinin orta cavab müddəti. Cihazlar arasında yenilik təxminən bunun 2–3 qatı qədər gecikir') }, _t('Server {0} san', [(sy.rttAvg / 1000).toFixed(1)])));
      statusEl.appendChild(h('span', { class: 'muted', title: _t('Tətbiq versiyası. İki cihazda eyni olmalıdır; fərqlidirsə Ctrl+F5 basın') }, 'v' + BUILD));
      if (r[1]) statusEl.appendChild(h('span', { class: 'badge', title: _t('Serverə göndərilməmiş qeydlər') }, _t('{0} sinxron gözləyir', [r[1]])));
      if (sy.ok === false) statusEl.appendChild(h('span', { class: 'badge bad', title: sy.error || '' }, _t('Sinxron xətası')));
      if (Math.abs(sy.skewMs || 0) > 120000) statusEl.appendChild(h('span', { class: 'badge bad', title: _t('Bu cihazın saatı serverdən {0} dəq. fərqlənir. Çek tarixləri avtomatik düzəldilir, amma cihazın saatını "avtomatik" rejimə keçirin', [Math.round(Math.abs(sy.skewMs) / 60000)]) }, _t('Saat səhvdir')));
      if (r[3].length) statusEl.appendChild(h('button', { class: 'btn small primary', id: 'req-btn', onclick: function () { root.Screens.approvalsModal(refreshStatus); } }, _t('Sorğular ({0})', [r[3].length])));
      statusEl.appendChild(h('span', null, r[0] ? _t('Növbə açıq · {0}', [UI.fmtTime(r[0].openedAt)]) : _t('Növbə bağlı')));
      statusEl.appendChild(h('span', null, u.name + ' · ' + R.ROLE_NAMES[u.role]));
      if (app.matrix && root.Notify.wants(u, app.matrix)) statusEl.appendChild(h('button', { class: 'btn small', id: 'notify-btn', title: _t('Təsdiq sorğusu gələndə telefona/brauzerə bildiriş'), onclick: function () { root.Notify.modal(); } }, _t('Bildiriş')));
      statusEl.appendChild(h('button', { class: 'btn small', id: 'print-settings', title: _t('Bu cihazın printeri: kağız eni, etiket ölçüsü, test çapı'), onclick: function () { root.Print.settingsModal(); } }, _t('Çap')));
      statusEl.appendChild(h('button', { class: 'btn small', onclick: logout }, _t('Çıxış')));
      document.querySelector('.brand b').textContent = r[2].name;
      document.querySelector('.brand .muted').textContent = r[2].registerName;

      // Yeni təsdiq sorğusu gələndə səs + bildiriş
      var ids = {}; r[3].forEach(function (a) { ids[a.id] = a; });
      if (seenRequests) {
        var fresh = r[3].filter(function (a) { return !seenRequests[a.id]; });
        if (fresh.length) {
          UI.toast(_t('Yeni təsdiq sorğusu: {0}', [UI.reqText(fresh[0])])); UI.beep(true);
          if (document.hidden) root.Notify.localAlert(UI.reqText(fresh[0]));       // pəncərə arxa plandadır: sistem bildirişi
        }
      }
      seenRequests = ids;
    });
  }

  function logout() { UI.abortPending(); S.logout(); root.POS.reset(); root.Notify.sync(); start(); }

  // Başqa cihazdan gələn dəyişikliklər: icazələr, istifadəçilər, qalıq, çeklər, sorğular
  function onApplied(t) {
    if (!S.currentUser()) return;
    var chain = Promise.resolve(true);
    if (t.users) {
      // Hesab söndürülübsə / PIN sıfırlanıbsa bu cihazda dərhal çıxış; ad və ya rol dəyişibsə menyu yenilənir
      chain = S.refreshSession().then(function (st) {
        if (st === 'gone') { UI.toast(_t('Hesabınız dəyişdirilib və ya söndürülüb. Yenidən daxil olun'), 'bad'); logout(); return false; }
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
      if (t.matrix || t.users) root.Notify.sync();
      refreshStatus();
      if (document.querySelector('.modal-back')) return;       // açıq pəncərəni pozmuruq
      if ((t.products || t.sales) && app.route === 'pos') root.POS.refresh();
      else if ((t.products || t.sales || t.users || (t.approvals && app.route === 'products')) && root.Screens._refresh) root.Screens._refresh();
    });
  }

  function startShell() {
    shell = document.getElementById('app');
    UI.clear(shell);
    seenRequests = null;
    nav = h('nav', { class: 'nav', 'aria-label': _t('Bölmələr') });
    statusEl = h('div', { class: 'status' });
    main = h('main', { id: 'main' });
    shell.appendChild(h('header', { class: 'topbar' }, h('div', { class: 'brand' }, h('b', null, ''), h('span', { class: 'muted', style: 'font-size:14px' }, '')), nav, statusEl, UI.langSwitch()));
    shell.appendChild(main);
    animateIn(shell.firstChild, 'fade-in');
    refreshStatus();
    // Sheets tutumu dolmağa yaxınlaşırsa Admin xəbərdar olur (sinxron 10 milyon xanada dayanır). Köhnə skript və ya oflayn: səssiz keçilir
    if (app.matrix && S.currentUser() && R.can(app.matrix, S.currentUser().role, 'admin.permissions')) {
      root.Sync.archiveStatus().then(function (st) {
        if (st && st.pct >= 70) UI.toast(_t('Cədvəl tutumunun {0}%-i dolub. Rollar və icazələr → Arxiv bölməsində arxivləşdirin', [st.pct]), 'bad');
      }).catch(function () { /* vacib deyil */ });
    }
    var wantApprovals = location.hash === '#approvals';       // bildirişə klikdən açılıb
    go(wantApprovals ? 'pos' : location.hash.slice(1) || 'pos');
    root.Notify.sync();
    if (wantApprovals) openApprovals();
  }

  function openApprovals() {
    if (!S.currentUser() || document.querySelector('.modal-back')) return;
    root.Screens.pendingForMe().then(function (list) { if (list.length) root.Screens.approvalsModal(refreshStatus); });
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

  root.Notify.onOpen(openApprovals);
  addEventListener('online', refreshStatus);
  addEventListener('offline', refreshStatus);
  setInterval(refreshStatus, 15000);   // sorğuların vaxtı bitməsi və növbə vəziyyəti üçün (lokal, şəbəkəsiz)
  root.Sync.on(function (kind, data) { if (kind === 'applied') onApplied(data); else refreshStatus(); });

  document.title = _t('7BOXS — Kassa');
  // Başqa saytın <iframe>-i içində açılıbsa (clickjacking) işləmir: GitHub Pages X-Frame-Options göndərmir, <meta> CSP isə frame-ancestors-u dəstəkləmir
  if (root.top !== root.self) { document.getElementById('app').textContent = _t('Bu səhifə çərçivə içində açıla bilməz'); return; }
  if (root.I18n) root.I18n.remember(root.I18n.lang());   // service worker bildirişi bu dildə göstərsin
  S.init().then(function () {
    root.Sync.start();
    // Yeniləmə çıxış etdirməsin: sessiya hələ etibarlıdırsa birbaşa işçi ekrana qayıdırıq
    return S.restoreSession().then(function (u) {
      if (!u) return start();
      return S.getMatrix().then(function (m) { app.matrix = m; startShell(); });
    });
  }).catch(function (e) {
    document.getElementById('app').textContent = _t('Başlatma xətası: {0}', [e.message]);
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:' && !root.__NO_SW__) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* oflayn rejim olmadan davam */ });
  }
})(window);
