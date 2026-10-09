/* node tests/notify.test.js — js/notify.js məntiqi: brauzer API-ləri (service worker, Push, Notification) təqlid olunur, server isə Code.gs-in özüdür. */
const assert = require('assert');
const crypto = require('crypto');
const { makeBackend } = require('./gas-mock.js');

const TOKEN = 'tok';
let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); } }

function env(over) {
  over = over || {};
  const be = over.be || makeBackend({ token: TOKEN });
  const shown = [], calls = { subscribe: 0, unsubscribe: 0, requests: [] };
  let sub = null, permission = over.permission || 'default';
  const reg = {
    active: { postMessage() {} },
    pushManager: {
      getSubscription: async () => sub,
      subscribe: async (o) => {
        calls.subscribe++;
        assert.strictEqual(o.userVisibleOnly, true);
        sub = { endpoint: over.endpoint || 'https://fcm.googleapis.com/fcm/send/ep-' + crypto.randomBytes(4).toString('hex'), options: { applicationServerKey: o.applicationServerKey.buffer.slice(o.applicationServerKey.byteOffset, o.applicationServerKey.byteOffset + o.applicationServerKey.byteLength) }, unsubscribe: async () => { calls.unsubscribe++; sub = null; return true; } };
        return sub;
      }
    },
    showNotification: async (title, o) => { shown.push({ title, ...o }); }
  };
  const store = {};
  const user = { current: over.user === undefined ? { id: 'u_menecer', name: 'Menecer', role: 'menecer' } : over.user };
  const matrix = { menecer: ['pos.sell', 'pos.line.delete', 'pos.discount.approve', 'pos.return.approve'], kassir: ['pos.sell'], admin: ['pos.sell', 'pos.line.delete'] };
  const ctx = {
    navigator: over.noSw ? { userAgent: over.ua || '' } : { userAgent: over.ua || 'Chrome', serviceWorker: { getRegistration: async () => (over.noReg ? undefined : reg), addEventListener() {} } },
    Notification: { get permission() { return permission; }, requestPermission: async () => { permission = over.grant === false ? 'denied' : 'granted'; return permission; } },
    PushManager: over.noPush ? undefined : function () {}, isSecureContext: true,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    Services: { currentUser: () => user.current, getMatrix: async () => matrix },
    Sync: {
      api: async (action, extra) => {
        if (over.oldServer) throw new Error('Naməlum əməliyyat');
        calls.requests.push(action);
        const r = be.post(Object.assign({ action, token: TOKEN, device: 'dev_1' }, extra || {}));
        if (!r.ok) throw new Error(r.error || 'Server xətası');
        return r;
      }
    }
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  const vm = require('vm'); vm.createContext(ctx);
  vm.runInContext(require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'notify.js'), 'utf8'), ctx, { filename: 'notify.js' });
  return { N: ctx.Notify, be, shown, calls, user, store, getSub: () => sub, setPermission: p => { permission = p; } };
}

(async () => {
  await t('Menecer aktiv edir: icazə soruşulur, serverin açarı ilə abunə olunur, Push vərəqinə perms ilə yazılır', async () => {
    const e = env();
    assert.strictEqual(e.N.permission(), 'default');
    const r = await e.N.enable();
    assert.strictEqual(r, 'registered');
    assert.strictEqual(e.N.permission(), 'granted');
    const serverKey = Buffer.from(e.be.post({ action: 'push.key', token: TOKEN }).key, 'base64url');
    assert.strictEqual(Buffer.from(e.getSub().options.applicationServerKey).toString('hex'), serverKey.toString('hex'), 'applicationServerKey = serverin açıq açarı');
    const row = e.be.rows('Push')[0];
    assert.strictEqual(row[0], 'dev_1'); assert.strictEqual(row[1], 'u_menecer'); assert.strictEqual(row[3], 'menecer');
    assert.ok(row[4].split(',').includes('pos.line.delete'));
    assert.ok(/^https:\/\/fcm\.googleapis\.com\//.test(row[5])); assert.strictEqual(row[6], true);
    const st = await e.N.state();
    assert.ok(st.on && st.subscribed && st.wants);
  });

  await t('Kassir aktiv edə bilmir (təsdiq icazəsi yoxdur), serverə heç nə yazılmır', async () => {
    const e = env({ user: { id: 'u_kassir', name: 'Kassir', role: 'kassir' } });
    await assert.rejects(e.N.enable(), /icazəsi yoxdur/);
    assert.strictEqual(e.be.rows('Push').length, 0);
  });

  await t('icazə rədd edilib: aydın xəta, abunə yoxdur', async () => {
    const e = env({ grant: false });
    await assert.rejects(e.N.enable(), /bloklanıb/);
    assert.strictEqual(e.calls.subscribe, 0);
  });

  await t('brauzer dəstəkləmir: səbəbə görə mesaj (iPhone ayrıca izah olunur)', async () => {
    let e = env({ noPush: true });
    assert.strictEqual(e.N.support().ok, false);
    await assert.rejects(e.N.enable(), /dəstəkləmir/);
    e = env({ noPush: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4)' });
    await assert.rejects(e.N.enable(), /Ana ekrana əlavə et/);
    e = env({ noSw: true });
    assert.strictEqual(e.N.support().ok, false);
  });

  await t('service worker qeydiyyatda deyil: başa düşülən xəta', async () => {
    const e = env({ noReg: true });
    await assert.rejects(e.N.enable(), /service worker/);
  });

  await t('köhnə server skripti: "Code.gs v6" xəbərdarlığı; uğursuz aktivləşdirmə cihazı "aktiv" saxlamır', async () => {
    const e = env({ oldServer: true });
    await assert.rejects(e.N.enable(), /v6/);
    assert.strictEqual((await e.N.state()).on, false);
    assert.strictEqual(await e.N.sync(), 'off');
  });

  await t('sync(): giriş/çıxış/rol dəyişəndə serverdə cihaz aktivləşir/söndürülür; dəyişiklik yoxdursa təkrar sorğu yoxdur', async () => {
    const e = env();
    assert.strictEqual(await e.N.sync(), 'off', 'aktiv edilməyibsə heç nə etmir');
    assert.deepStrictEqual(e.calls.requests, []);
    await e.N.enable();
    const n = e.calls.requests.length;
    assert.strictEqual(await e.N.sync(), 'ok'); assert.strictEqual(e.calls.requests.length, n, 'dəyişiklik yoxdur: sorğu yoxdur');
    e.user.current = null;                                   // çıxış
    assert.strictEqual(await e.N.sync(), 'unregistered');
    assert.strictEqual(e.be.rows('Push')[0][6], false);
    assert.strictEqual(await e.N.sync(), 'off'); // təkrar çıxış sorğusu yoxdur
    e.user.current = { id: 'u_kassir', name: 'Kassir', role: 'kassir' };    // kassir girir: təsdiq icazəsi yoxdur
    assert.strictEqual(await e.N.sync(), 'off');
    assert.strictEqual(e.be.rows('Push')[0][6], false);
    e.user.current = { id: 'u_admin', name: 'Admin', role: 'admin' };       // admin: təsdiq icazəsi var → yenidən aktiv, istifadəçi adı yenilənir
    assert.strictEqual(await e.N.sync(), 'registered');
    assert.strictEqual(e.be.rows('Push')[0][6], true); assert.strictEqual(e.be.rows('Push')[0][1], 'u_admin');
  });

  await t('abunəlik itibsə (brauzer sildi) sync() səssiz yenidən abunə olur', async () => {
    const e = env();
    await e.N.enable();
    const first = e.getSub().endpoint;
    e.getSub().unsubscribe();                                // brauzer abunəni silib
    assert.strictEqual(await e.N.sync(), 'registered');
    assert.notStrictEqual(e.getSub().endpoint, first);
    assert.strictEqual(e.be.rows('Push')[0][5], e.getSub().endpoint, 'server yeni ünvanı bilir');
  });

  await t('serverin açarı dəyişibsə (köhnə abunə başqa açarla) köhnə abunə ləğv edilib yenisi yaradılır', async () => {
    const e = env();
    await e.N.enable();
    const sub = e.getSub(); sub.options.applicationServerKey = new Uint8Array(65).buffer;   // başqa açar
    const before = e.calls.unsubscribe;
    await e.N.enable();                                       // yenidən aktiv etmə açarı yoxlayır
    assert.strictEqual(e.calls.unsubscribe, before + 1);
    assert.notStrictEqual(e.getSub(), sub);
  });

  await t('Söndür: yerli abunə silinir, server cihazı söndürür, sync() yenidən aktivləşdirmir', async () => {
    const e = env();
    await e.N.enable();
    await e.N.disable();
    assert.strictEqual(e.getSub(), null);
    assert.strictEqual(e.be.rows('Push')[0][6], false);
    assert.strictEqual(await e.N.sync(), 'off');
    const st = await e.N.state(); assert.strictEqual(st.on, false);
  });

  await t('Test: yerli bildiriş ikon+badge ilə göstərilir, server push göndərir; xidmət rədd edərsə səbəb görünür', async () => {
    const e = env();
    await e.N.enable();
    let r = await e.N.test();
    assert.ok(r.local); assert.ok(r.server.ok); assert.strictEqual(r.server.status, 201);
    const n = e.shown.find(x => x.tag === 'test');
    assert.ok(n.icon.endsWith('icon-192.png') && n.badge.endsWith('badge-96.png'), 'ikon və badge göstərilir');
    e.be.pushRespond = () => ({ status: 403, body: 'invalid JWT provided' });
    r = await e.N.test();
    assert.strictEqual(r.server.ok, false); assert.strictEqual(r.server.status, 403); assert.ok(/invalid JWT/.test(r.server.detail));
    e.be.pushRespond = () => ({ status: 410, body: '' });
    r = await e.N.test(); assert.strictEqual(r.server.status, 410);
  });

  await t('Test: abunə olmayan cihaz üçün aydın mesaj', async () => {
    const e = env(); e.setPermission('granted');
    const r = await e.N.test();
    assert.ok(r.local); assert.strictEqual(r.server, null); assert.ok(/Aktiv et/.test(r.serverError));
  });

  await t('localAlert: yalnız icazə verilib və cihaz aktivdirsə göstərir; mətn sorğunun xülasəsidir, ikon+badge var', async () => {
    const e = env();
    assert.strictEqual(await e.N.localAlert('x'), false);
    await e.N.enable();
    assert.strictEqual(await e.N.localAlert('Elvin sətir silmək istəyir'), true);
    const n = e.shown.find(x => x.tag === 'approval');
    assert.strictEqual(n.title, 'Təsdiq sorğusu'); assert.strictEqual(n.body, 'Elvin sətir silmək istəyir');
    assert.ok(n.icon && n.badge && n.renotify && n.requireInteraction);
    await e.N.disable();
    assert.strictEqual(await e.N.localAlert('y'), false);
  });

  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
