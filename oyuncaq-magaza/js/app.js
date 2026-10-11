/* Tətbiqin girişi: marşrutlar, menyu, status sətri. */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var UI = root.UI, S = root.Services, R = root.Rules;
  var h = UI.h;
  var BUILD = '2026.10.11-3';   // hər buraxılışda artırılır; iki brauzerdə eyni görünməlidir

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
  var shell, nav, main, sysEl, reqSlot, menuWrap, headerEl;      // sysEl: yalnız Admin üçün sistem zolağı (FR-108)
  var installEvt = null;                                            // brauzerin "quraşdır" təklifi (Chrome kompüterdə/Android)

  function allowed() { var u = S.currentUser(); return ROUTES.filter(function (r) { return u && R.can(app.matrix, u.role, r.perm); }); }

  // Ekran açılanda yumşaq giriş animasiyası (sinif təkrar verilir ki, animasiya hər keçiddə yenidən oynasın)
  function animateIn(el, cls) { if (!el) return; var c = cls || 'screen-in'; el.classList.remove(c); void el.offsetWidth; el.classList.add(c); }

  function go(id) {
    var list = allowed();
    var r = list.find(function (x) { return x.id === id; }) || list[0];
    if (!r) { UI.clear(main).appendChild(h('div', { class: 'page' }, h('div', { class: 'card empty' }, _t('Bu rol üçün açıq ekran yoxdur.')))); return; }
    app.route = r.id;
    closeMenu();
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

  function isAdmin(u) { return !!(u && app.matrix && R.can(app.matrix, u.role, 'admin.permissions')); }

  /* ---------- İstifadəçi menyusu (FR-111): Çap, Bildiriş, Dil, Quraşdır, Çıxış bir yerdə ---------- */
  var ICON_MENU = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  var menuPop = null, menuBtn = null;
  function closeMenu() {
    if (menuPop) { menuPop.remove(); menuPop = null; }
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onMenuOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  function onMenuOutside(e) { if (menuPop && !menuPop.contains(e.target) && !(menuBtn && menuBtn.contains(e.target))) closeMenu(); }
  function onMenuKey(e) { if (e.key === 'Escape' && menuPop) { e.stopPropagation(); closeMenu(); if (menuBtn) menuBtn.focus(); } }
  function installed() { return (root.matchMedia && root.matchMedia('(display-mode: standalone)').matches) || root.navigator.standalone === true; }

  function openMenu() {
    if (menuPop) return closeMenu();
    var u = S.currentUser(); if (!u || !menuWrap) return;
    function item(id, label, hint, fn, cls) {
      return h('button', { type: 'button', role: 'menuitem', class: 'menu-item' + (cls ? ' ' + cls : ''), id: id, onclick: function () { closeMenu(); fn(); } },
        h('span', null, label), hint ? h('small', { class: 'muted' }, hint) : null);
    }
    var items = [];
    items.push(item('print-settings', _t('Çap'), _t('Bu cihazın printeri: kağız eni, etiket ölçüsü, test çapı'), function () { root.Print.settingsModal(); }));
    if (app.matrix && root.Notify.wants(u, app.matrix)) items.push(item('notify-btn', _t('Bildiriş'), _t('Təsdiq sorğusu gələndə telefona/brauzerə bildiriş'), function () { root.Notify.modal(); }));
    if (installEvt && !installed()) items.push(item('install-btn', _t('Kompüterə quraşdır'), _t('Tətbiq ayrıca pəncərədə, öz ikonu ilə açılır'), function () {
      var ev = installEvt; installEvt = null;
      ev.prompt(); if (ev.userChoice) ev.userChoice.catch(function () { /* istifadəçi imtina etdi */ });
    }));
    var lang = UI.langSwitch();
    menuPop = h('div', { class: 'menu-pop', role: 'menu', 'aria-label': _t('Menyu') },
      items, lang ? h('div', { class: 'menu-row' }, h('label', { for: 'lang-sel' }, _t('Dil')), lang) : null,
      h('div', { class: 'menu-sep', role: 'separator' }),
      item('logout-btn', _t('Çıxış'), null, logout, 'danger'));
    menuWrap.appendChild(menuPop);
    menuBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onMenuOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    var first = menuPop.querySelector('button,select'); if (first) first.focus();
  }

  // Sistem zolağı (yalnız Admin görür): onlayn/server/versiya/sinxron/saat/növbə/istifadəçi. Digər rollar bunları görmür (FR-108).
  function drawSysbar(u, shift, unsent) {
    var admin = isAdmin(u);
    if (!admin) { if (sysEl) { sysEl.remove(); sysEl = null; } return; }
    if (!sysEl) { sysEl = h('div', { class: 'sysbar', role: 'status', 'aria-label': _t('Sistem vəziyyəti') }); shell.insertBefore(sysEl, headerEl); }
    var online = navigator.onLine, sy = root.Sync.status();
    UI.clear(sysEl);
    sysEl.appendChild(h('b', { class: 'sys-title', title: _t('Bu zolağı yalnız Admin görür') }, _t('Sistem')));
    sysEl.appendChild(h('span', null, h('span', { class: 'dot' + (online ? '' : ' off') }), online ? _t('Onlayn') : _t('Oflayn')));
    if (online && sy.rttAvg) sysEl.appendChild(h('span', { class: 'muted', title: _t('Google Apps Script serverinin orta cavab müddəti. Cihazlar arasında yenilik təxminən bunun 2–3 qatı qədər gecikir') }, _t('Server {0} san', [(sy.rttAvg / 1000).toFixed(1)])));
    sysEl.appendChild(h('span', { class: 'muted', title: _t('Tətbiq versiyası. İki cihazda eyni olmalıdır; fərqlidirsə Ctrl+F5 basın') }, 'v' + BUILD));
    if (unsent) sysEl.appendChild(h('span', { class: 'badge', title: _t('Serverə göndərilməmiş qeydlər') }, _t('{0} sinxron gözləyir', [unsent])));
    if (sy.ok === false) sysEl.appendChild(h('span', { class: 'badge bad', title: sy.error || '' }, _t('Sinxron xətası')));
    if (Math.abs(sy.skewMs || 0) > 120000) sysEl.appendChild(h('span', { class: 'badge bad', title: _t('Bu cihazın saatı serverdən {0} dəq. fərqlənir. Çek tarixləri avtomatik düzəldilir, amma cihazın saatını "avtomatik" rejimə keçirin', [Math.round(Math.abs(sy.skewMs) / 60000)]) }, _t('Saat səhvdir')));
    sysEl.appendChild(h('span', { class: 'sys-end' }, shift ? _t('Növbə açıq · {0}', [UI.fmtTime(shift.openedAt)]) : _t('Növbə bağlı')));
    sysEl.appendChild(h('span', null, u.name + ' · ' + R.ROLE_NAMES[u.role]));
  }

  function refreshStatus() {
    if (!shell || !reqSlot || !S.currentUser()) return;
    Promise.all([S.currentShift(), S.outboxCount(), S.storeInfo(), root.Screens.pendingForMe()]).then(function (r) {
      var u = S.currentUser();
      if (!u || !reqSlot) return;
      drawSysbar(u, r[0], r[1]);
      // Təsdiq edə bilənlər üçün: gözləyən sorğu varsa düymə (funksional, status deyil)
      UI.clear(reqSlot);
      if (r[3].length) reqSlot.appendChild(h('button', { class: 'btn small primary', id: 'req-btn', onclick: function () { root.Screens.approvalsModal(refreshStatus); } }, _t('Sorğular ({0})', [r[3].length])));
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

  function logout() { closeMenu(); UI.abortPending(); UI.closeAllModals(); S.logout(); root.POS.reset(); root.Notify.sync(); start(); }

  // Hərəkətsizlik (kassir 3 s, digərləri 5 s) və ya 12 saat: çıxış, amma yarımçıq çek yaddaşda qalır (FR-106)
  function lockOut(msg) {
    if (!S.currentUser()) return;
    // Notify.sync() çağırılmır: cihaz push-dan çıxarılmasın, menecer hərəkətsizlikdən sonra da bildiriş alsın (açıq çıxışda isə söndürülür)
    closeMenu(); UI.abortPending(); UI.closeAllModals(); S.logout(); root.POS.lock(); start();
    UI.toast(msg, 'warn');
  }
  function checkIdle() { if (S.currentUser() && S.sessionExpired()) lockOut(_t('Uzun müddət fəaliyyət olmadığı üçün çıxış edildi. Yenidən daxil olun')); }
  var lastTouch = 0;
  function activity() { var t = Date.now(); if (t - lastTouch < 30000) return; lastTouch = t; S.touchSession(); }
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) { addEventListener(ev, activity, { capture: true, passive: true }); });
  setInterval(checkIdle, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkIdle(); });     // telefon/kompüter oyanandan sonra dərhal yoxlanılır
  // Başqa tabda çıxış edilib və ya başqa istifadəçi girib: bu tab da çıxır
  addEventListener('storage', function (e) { if (e.key === 'mag.session' && S.currentUser() && S.sessionExpired()) lockOut(_t('Başqa pəncərədə çıxış edildi. Yenidən daxil olun')); });

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
    seenRequests = null; sysEl = null;
    nav = h('nav', { class: 'nav hscroll', 'aria-label': _t('Bölmələr') });
    reqSlot = h('div', { class: 'req-slot' });
    menuBtn = h('button', { type: 'button', class: 'btn small menu-btn', id: 'menu-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': _t('Menyu'), onclick: openMenu });
    menuBtn.innerHTML = ICON_MENU;
    menuBtn.appendChild(h('span', { class: 'menu-label' }, _t('Menyu')));
    menuWrap = h('div', { class: 'menu-wrap' }, menuBtn);
    main = h('main', { id: 'main' });
    headerEl = h('header', { class: 'topbar' }, h('div', { class: 'brand' }, h('b', null, ''), h('span', { class: 'muted' }, '')), nav, h('div', { class: 'top-actions' }, reqSlot, menuWrap));
    shell.appendChild(headerEl);
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

  // Bildirişə klik: sessiya açıqdırsa sorğular pəncərəsi dərhal açılır (təsdiq/rədd bir toxunuşla). Sessiya yoxdursa kod soruşulmadan
  // giriş səhifəsində sorğular siyahısı (yalnız oxumaq) görünür; təsdiq/rədd üçün PIN ilə daxil olmaq lazımdır (FR-106, AS-34).
  function openApprovals() {
    if (!S.currentUser()) { if (location.hash !== '#approvals') history.replaceState(null, '', '#approvals'); return start(); }
    if (UI.modalOpen()) return;
    root.Screens.pendingForMe().then(function (list) { if (list.length) root.Screens.approvalsModal(refreshStatus); });
  }

  function start() {
    var el = document.getElementById('app');
    reqSlot = null; sysEl = null; shell = null; closeMenu();
    root.Screens.login(el, { approvals: location.hash === '#approvals' }, function (user) {
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
  addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; });      // menyuda "Kompüterə quraşdır" göstərilir
  addEventListener('appinstalled', function () { installEvt = null; });
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
