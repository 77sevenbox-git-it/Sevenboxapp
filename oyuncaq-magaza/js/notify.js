/* Bildirişlər: menecerə təsdiq sorğusu gələndə telefona / brauzerə bildiriş (tətbiq bağlı olsa belə).
   İki yol var:
   • Web Push (server göndərir): hər cihaz bir dəfə "Bildiriş" düyməsi ilə abunə olur; abunə Apps Script-dəki "Push" vərəqinə yazılır.
     Təsdiq sorğusu serverə çatanda server səlahiyyəti olan başqa cihazlara push göndərir; service worker (sw.js) bildirişi göstərir.
   • Yerli bildiriş: tətbiq açıqdır, amma tab/pəncərə arxa plandadır — səhifə özü bildiriş göstərir (push lazım deyil).
   Cihazın bildiriş seçimi yalnız bu cihazın localStorage-ındadır (mag.notify). Çıxış edəndə və ya rol təsdiq icazəsini itirəndə cihaz serverdə söndürülür. */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var PREF = 'mag.notify';
  var APPROVAL_PERMS = ['pos.line.delete', 'pos.discount.approve', 'pos.return.approve'];   // bu icazələrdən biri olan rol təsdiq sorğusu alır
  var ICON = 'icons/icon-192.png', BADGE = 'icons/badge-96.png';
  var lastSig = '';

  function S() { return root.Services; }
  function Sy() { return root.Sync; }
  function nav() { return root.navigator || {}; }
  function pref() { try { return JSON.parse(root.localStorage.getItem(PREF)) || {}; } catch (e) { return {}; } }
  function setPref(p) { try { root.localStorage.setItem(PREF, JSON.stringify(p)); } catch (e) { /* məhdud rejim: seçim yadda qalmır */ } }

  function support() {
    var n = nav(), ios = /iPad|iPhone|iPod/.test(n.userAgent || '');
    var reason = null;
    if (root.isSecureContext === false) reason = 'insecure';
    else if (!('serviceWorker' in n) || !root.Notification) reason = ios ? 'ios' : 'nosw';
    else if (!root.PushManager) reason = ios ? 'ios' : 'nopush';
    return { ok: !reason, reason: reason, ios: ios };
  }
  function supportMessage(sp) {
    if (sp.reason === 'insecure') return _t('Bildiriş yalnız təhlükəsiz (https) ünvanda işləyir');
    if (sp.reason === 'ios') return _t('iPhone/iPad-də bildiriş yalnız tətbiq ana ekrana əlavə edilibsə işləyir: Safari → Paylaş → "Ana ekrana əlavə et", sonra oradan açın (iOS 16.4 və yuxarı)');
    return _t('Bu brauzer bildirişi dəstəkləmir. Chrome, Edge və ya Firefox-un yeni versiyasından istifadə edin');
  }
  function permission() { return root.Notification ? root.Notification.permission : 'denied'; }
  function wants(user, matrix) {
    var list = user && matrix ? matrix[user.role] || [] : [];
    return APPROVAL_PERMS.some(function (p) { return list.indexOf(p) !== -1; });
  }

  function b64uToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = root.atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function sameKey(sub, bytes) {
    var cur = sub && sub.options && sub.options.applicationServerKey;
    if (!cur) return false;
    var a = new Uint8Array(cur);
    if (a.length !== bytes.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== bytes[i]) return false;
    return true;
  }

  function registration() {
    return Promise.resolve(nav().serviceWorker.getRegistration()).then(function (r) {
      if (!r) throw new Error(_t('Xidmət işçisi (service worker) işləmir. Səhifəni yeniləyin (Ctrl+F5); tətbiq https ünvanından açılmalıdır'));
      return r;
    });
  }

  // Server cavabındakı texniki xətaları başa düşülən mətnə çevirir
  function friendly(e) {
    var m = (e && e.message) || String(e);
    if (/Naməlum əməliyyat/.test(m)) return _t('Server skripti köhnədir: Code.gs-in v6 versiyasını yapışdırın, setup() işlədin və "New version" deploy edin');
    if (/BigInt/.test(m)) return _t('Apps Script-də V8 runtime aktiv deyil (BigInt yoxdur): Project Settings → "Chrome V8 runtime" seçin, sonra New version deploy edin. Sinxron təsirlənmir, yalnız bildiriş işləmir');
    if (/UrlFetchApp|permission|authoriz/i.test(m)) return _t('Apps Script-ə xarici sorğu icazəsi verilməyib: redaktorda setup() işlədin, "Connect to an external service" icazəsini təsdiqləyin və yenidən "New version" deploy edin');
    if (/Server qoşulmayıb/.test(m)) return _t('Əvvəl serveri qoşun (İcazələr → Mağaza və server)');
    return m;
  }

  function api(action, extra) { return Sy().api(action, extra); }

  function subscribe(reg) {
    return api('push.key').then(function (r) {
      var key = b64uToBytes(r.key);
      return reg.pushManager.getSubscription().then(function (old) {
        if (old && sameKey(old, key)) return old;
        return (old ? old.unsubscribe() : Promise.resolve()).then(function () { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); });
      });
    });
  }

  // Cari istifadəçi üçün abunəni serverə yazır (səhvdə istisna atır)
  function ensureRegistered(checkKey) {
    var u = S().currentUser();
    return S().getMatrix().then(function (m) {
      if (!u || !wants(u, m)) {
        if (lastSig === 'off') return 'off';
        return api('push.unregister').then(function () { lastSig = 'off'; return 'unregistered'; });
      }
      return registration().then(function (reg) {
        // Açıq aktiv etmədə serverin açarı ilə uyğunluq yoxlanılır (açar dəyişibsə köhnə abunə ləğv olunur); adi sync() mövcud abunədən istifadə edir
        return checkKey ? subscribe(reg) : reg.pushManager.getSubscription().then(function (sub) { return sub || subscribe(reg); });
      }).then(function (sub) {
        var perms = m[u.role] || [];
        var sig = [u.id, u.role, perms.join(','), sub.endpoint].join('|');
        if (sig === lastSig) return 'ok';
        return api('push.register', { endpoint: sub.endpoint, userId: u.id, userName: u.name, role: u.role, perms: perms }).then(function () { lastSig = sig; return 'registered'; });
      });
    });
  }

  // Giriş / çıxış / rol dəyişəndə çağırılır; səssizdir (xəta tətbiqi pozmur)
  function sync() {
    if (!support().ok || !pref().on || permission() !== 'granted') return Promise.resolve('off');
    return ensureRegistered().catch(function (e) { return 'error: ' + friendly(e); });
  }

  function enable() {
    var sp = support();
    if (!sp.ok) return Promise.reject(new Error(supportMessage(sp)));
    if (!S().currentUser()) return Promise.reject(new Error(_t('Daxil olun')));
    // requestPermission istifadəçi klikindən dərhal sonra çağırılmalıdır (başqa gözləmədən əvvəl)
    var asked = permission() === 'granted' ? Promise.resolve('granted') : Promise.resolve(root.Notification.requestPermission());
    return asked.then(function (p) {
      if (p !== 'granted') throw new Error(p === 'denied' ? _t('Bildiriş bloklanıb. Brauzerin ünvan sətrindəki qıfıl işarəsi → Bildirişlər → "İcazə ver", sonra yenidən basın') : _t('Bildiriş icazəsi verilmədi'));
      return S().getMatrix();
    }).then(function (m) {
      if (!wants(S().currentUser(), m)) throw new Error(_t('Bu rolun təsdiq sorğusu almaq icazəsi yoxdur'));
      lastSig = '';
      setPref({ on: true });
      return ensureRegistered(true);
    }).catch(function (e) { setPref({ on: false }); throw new Error(friendly(e)); });     // alınmadısa "aktiv" qalmır
  }

  function disable() {
    setPref({ on: false });
    lastSig = 'off';
    return registration().then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) { return sub ? sub.unsubscribe() : null; })
      .catch(function () { /* abunə yoxdur */ })
      .then(function () { return api('push.unregister'); })
      .catch(function () { /* server əlçatmazdırsa yerli söndürmə yenə qüvvədədir */ });
  }

  function show(reg, title, body, tag, extra) {
    return reg.showNotification(title, Object.assign({ body: body, icon: ICON, badge: BADGE, tag: tag, renotify: true, lang: 'az', data: { url: './index.html#approvals' } }, extra || {}));
  }

  // Tətbiq açıqdır, amma ekranda deyil: yerli bildiriş (push lazım deyil)
  function localAlert(summary) {
    if (!support().ok || permission() !== 'granted' || !pref().on) return Promise.resolve(false);
    return registration().then(function (reg) { return show(reg, _t('Təsdiq sorğusu'), summary || _t('Kassadan menecer təsdiqi gözlənilir'), 'approval', { requireInteraction: true, vibrate: [200, 100, 200] }).then(function () { return true; }); })
      .catch(function () { return false; });
  }

  // Test: (1) bu cihazda bildiriş göstərilir (icazə + ikon), (2) server push xidməti vasitəsilə göndərir (bütün zəncir)
  function test() {
    var res = { local: false, localError: null, server: null, serverError: null };
    return registration().then(function (reg) {
      return show(reg, _t('Mağaza İS — test'), _t('Bildirişlər bu cihazda işləyir.'), 'test', { requireInteraction: false })
        .then(function () { res.local = true; }, function (e) { res.localError = e.message; })
        .then(function () { return reg.pushManager.getSubscription(); })
        .then(function (sub) {
          if (!sub) { res.serverError = _t('Bu cihaz push üçün qoşulmayıb. "Aktiv et" düyməsini basın'); return; }
          try { if (reg.active) reg.active.postMessage({ type: 'expect-push' }); } catch (e) { /* mühüm deyil */ }
          return api('push.test').then(function (r) { res.server = { ok: !!r.sent, status: r.status, detail: r.detail }; }, function (e) { res.serverError = friendly(e); });
        });
    }, function (e) { res.localError = e.message; }).then(function () { return res; });
  }

  function state() {
    var sp = support(), u = S().currentUser();
    return Promise.resolve(S().getMatrix()).then(function (m) {
      var base = { support: sp, permission: permission(), on: !!pref().on, wants: wants(u, m), subscribed: false };
      if (!sp.ok) return base;
      return registration().then(function (reg) { return reg.pushManager.getSubscription(); })
        .then(function (sub) { base.subscribed = !!sub; return base; }, function () { return base; });
    });
  }

  // Bildirişə klik: service worker açıq pəncərəyə xəbər verir
  function onOpen(fn) {
    if (!nav().serviceWorker || !nav().serviceWorker.addEventListener) return;
    nav().serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'open-approvals') fn(); });
  }

  function modal() {
    var UI = root.UI, h = UI.h;
    var box = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
    var out = h('div', { id: 'nt-out', style: 'display:flex;flex-direction:column;gap:6px;font-size:14px' });
    var buttons = h('div', { class: 'row' });
    function line(ok, text) { return h('div', { class: ok === false ? 'warn-text' : ok ? '' : 'muted', style: 'display:flex;gap:8px' }, h('span', { style: 'width:1.2em' }, ok === true ? '✓' : ok === false ? '✗' : '·'), h('span', null, text)); }

    function render() {
      return state().then(function (st) {
        UI.clear(box); UI.clear(out); UI.clear(buttons);
        box.appendChild(h('p', { class: 'muted', style: 'margin:0' }, _t('Kassir təsdiq sorğusu göndərəndə (sətir silmə, endirim, qaytarma) bu cihaza bildiriş gəlsin. Hər menecer cihazında bir dəfə aktiv edilir.')));
        box.appendChild(out);
        box.appendChild(buttons);
        if (!st.support.ok) { out.appendChild(line(false, supportMessage(st.support))); return; }
        out.appendChild(line(st.permission === 'granted' ? true : st.permission === 'denied' ? false : null, st.permission === 'granted' ? _t('Brauzer icazəsi verilib') : st.permission === 'denied' ? _t('Brauzer bildirişi bloklayıb (ünvan sətrindəki qıfıldan açın)') : _t('Brauzer icazəsi hələ verilməyib')));
        out.appendChild(line(st.on && st.subscribed, st.on && st.subscribed ? _t('Bu cihaz bildirişə qoşulub') : _t('Bu cihaz bildirişə qoşulmayıb')));
        if (!st.wants) out.appendChild(line(false, _t('Bu rolun təsdiq sorğusu almaq icazəsi yoxdur (Menecer və ya Admin daxil olmalıdır)')));
        if (st.on && st.subscribed) {
          buttons.appendChild(h('button', { class: 'btn', type: 'button', id: 'nt-test', onclick: runTest }, _t('Test bildirişi göndər')));
          buttons.appendChild(h('button', { class: 'btn danger', type: 'button', id: 'nt-off', onclick: function () { disable().then(render); } }, _t('Söndür')));
        } else if (st.wants) {
          buttons.appendChild(h('button', { class: 'btn primary', type: 'button', id: 'nt-on', onclick: function (ev) {
            var b = ev.currentTarget; b.disabled = true;
            enable().then(function () { UI.toast(_t('Bildiriş aktiv edildi'), ''); return render(); }, function (e) { UI.toast(e.message, 'bad'); out.appendChild(line(false, e.message)); b.disabled = false; });
          } }, _t('Aktiv et')));
        }
      });
    }
    function runTest(ev) {
      var b = ev.currentTarget; b.disabled = true; b.textContent = _t('Göndərilir…');
      test().then(function (r) {
        b.disabled = false; b.textContent = _t('Test bildirişi göndər');
        out.appendChild(line(r.local, r.local ? _t('Bu cihazda bildiriş göstərildi (ikon və səs yoxlanılır)') : _t('Bu cihazda bildiriş göstərilmədi: {0}', [(r.localError || _t('naməlum səbəb'))])));
        if (r.server) out.appendChild(line(r.server.ok, r.server.ok ? _t('Server push xidmətinə göndərdi (cavab {0}). 5–15 saniyəyə "Təsdiq sorğusu" bildirişi gəlməlidir; tətbiqi başqa tabə keçirin', [r.server.status]) : _t('Push xidməti rədd etdi (cavab {0}): {1}. Söndürüb yenidən aktiv edin', [r.server.status, (r.server.detail || '')])));
        else if (r.serverError) out.appendChild(line(false, r.serverError));
      });
    }
    UI.modal({ title: _t('Bildirişlər'), body: box, buttons: [{ text: _t('Bağla') }] });
    render();
  }

  root.Notify = { support: support, permission: permission, wants: wants, state: state, enable: enable, disable: disable, sync: sync, test: test, localAlert: localAlert,
    onOpen: onOpen, modal: modal, friendly: friendly, _reset: function () { lastSig = ''; } };
  if (typeof module !== 'undefined') module.exports = root.Notify;
})(typeof window !== 'undefined' ? window : globalThis);
