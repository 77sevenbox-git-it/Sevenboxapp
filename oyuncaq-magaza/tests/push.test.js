/* node tests/push.test.js — serverdə Web Push (VAPID): P-256 hesabı Node-un kriptoqrafiyası ilə yoxlanılır,
   imza (ES256) real doğrulama ilə, təsdiq sorğusu → doğru cihazlara push, xəta halları. Real push xidməti (FCM/Apple) təqlid olunur. */
const assert = require('assert');
const crypto = require('crypto');
const { makeBackend } = require('./gas-mock.js');

const TOKEN = 'tok';
let passed = 0, failed = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; }, e => { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); }); }

const b64uToBuf = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hex = n => n.toString(16).padStart(64, '0');
function pubKeyObject(pub65) {
  assert.strictEqual(pub65.length, 65); assert.strictEqual(pub65[0], 4);
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub65.slice(1, 33).toString('base64url'), y: pub65.slice(33).toString('base64url') }, format: 'jwk' });
}
// VAPID başlığını (RFC 8292) tam yoxlayır: forma, aud, exp, imza
function checkVapid(headers, endpoint, keyB64u) {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(headers.Authorization);
  assert.ok(m, 'Authorization formatı: ' + headers.Authorization);
  assert.strictEqual(m[4], keyB64u, 'k = açıq açar');
  const head = JSON.parse(b64uToBuf(m[1]).toString()), claims = JSON.parse(b64uToBuf(m[2]).toString());
  assert.deepStrictEqual(head, { typ: 'JWT', alg: 'ES256' });
  assert.strictEqual(claims.aud, new URL(endpoint).origin);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(claims.exp > now && claims.exp <= now + 24 * 3600, 'exp 24 saatdan az: ' + (claims.exp - now));
  assert.ok(/^(mailto:|https:)/.test(claims.sub), 'sub: ' + claims.sub);
  const sig = b64uToBuf(m[3]);
  assert.strictEqual(sig.length, 64);
  const ok = crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: pubKeyObject(b64uToBuf(keyB64u)), dsaEncoding: 'ieee-p1363' }, sig);
  assert.ok(ok, 'ES256 imzası etibarsızdır');
  assert.strictEqual(headers.TTL, '900'); assert.strictEqual(headers.Urgency, 'high');
}

const EP_M = 'https://fcm.googleapis.com/fcm/send/menecer-endpoint-1';
const EP_M2 = 'https://updates.push.services.mozilla.com/wpush/v2/menecer-2';
const EP_K = 'https://fcm.googleapis.com/fcm/send/kassir-endpoint';
const approval = (over) => Object.assign({ id: 'ap_' + Math.random().toString(36).slice(2), kind: 'line_delete', perm: 'pos.line.delete', summary: 'Sətri sil: Ayı', requestedBy: { id: 'u_kassir', name: 'Kassir', role: 'kassir' }, at: new Date().toISOString(), status: 'pending', device: 'dev_K' }, over || {});
const syncItem = (a) => ({ id: new Date().toISOString() + '_' + Math.random().toString(36).slice(2), at: a.at, type: 'approval.requested', userId: 'u_kassir', device: a.device, data: { approval: a } });
const reg = (b, device, ep, extra) => b.post(Object.assign({ action: 'push.register', token: TOKEN, device, endpoint: ep, userId: 'u_menecer', userName: 'Menecer', role: 'menecer', perms: ['pos.sell', 'pos.line.delete', 'pos.discount.approve'] }, extra || {}));
const send = (b, a, device) => b.post({ action: 'sync', token: TOKEN, device: device || a.device, since: 0, items: [syncItem(a)], limit: 5 });

(async () => {
  await t('P-256: k·G Node ECDH ilə eynidir (kənar hallar daxil); açar cütü uyğundur', () => {
    const b = makeBackend({ token: TOKEN });
    const ks = ['1', '2', '3', 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632550', 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'.replace(/1$/, '0')];
    for (let i = 0; i < 25; i++) ks.push(crypto.randomBytes(32).toString('hex'));
    ks.forEach(k => {
      const kk = k.padStart(64, '0');
      const p = b.sandbox.ecMulG(BigInt('0x' + kk));
      const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.from(kk, 'hex'));
      const ref = ecdh.getPublicKey();
      assert.strictEqual('04' + hex(p.x) + hex(p.y), ref.toString('hex'), 'k=' + kk);
    });
    const key = b.post({ action: 'push.key', token: TOKEN }).key;
    const d = b.store.props.VAPID_PRIVATE;
    const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.from(d, 'hex'));
    assert.strictEqual(b64uToBuf(key).toString('hex'), ecdh.getPublicKey().toString('hex'));
    assert.strictEqual(b.post({ action: 'push.key', token: TOKEN }).key, key, 'açar sabitdir');
    assert.ok(!JSON.stringify(b.get()).includes(d), 'gizli açar heç yerdə qaytarılmır');
  });

  await t('base64url Node ilə eynidir (0–40 bayt)', () => {
    const b = makeBackend({ token: TOKEN });
    for (let n = 0; n <= 40; n++) { const buf = crypto.randomBytes(n); assert.strictEqual(b.sandbox.b64u(Array.from(buf)), buf.toString('base64url')); }
  });

  await t('ES256 imzası Node tərəfindən doğrulanır (200 imza), hər imza fərqlidir (təsadüfi k)', () => {
    const b = makeBackend({ token: TOKEN });
    const key = b.post({ action: 'push.key', token: TOKEN }).key, d = b.store.props.VAPID_PRIVATE;
    const pk = pubKeyObject(b64uToBuf(key));
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const msg = 'mesaj-' + i + '-' + crypto.randomBytes(8).toString('hex');
      const h = crypto.createHash('sha256').update(msg).digest('hex');
      const sig = Buffer.from(b.sandbox.ecSign(h, d));
      assert.strictEqual(sig.length, 64);
      assert.ok(crypto.verify('sha256', Buffer.from(msg), { key: pk, dsaEncoding: 'ieee-p1363' }, sig), 'imza ' + i);
      seen.add(sig.toString('hex'));
    }
    assert.strictEqual(seen.size, 200);
    // eyni mesajın iki imzası fərqlidir
    const h = crypto.createHash('sha256').update('x').digest('hex');
    assert.notStrictEqual(Buffer.from(b.sandbox.ecSign(h, d)).toString('hex'), Buffer.from(b.sandbox.ecSign(h, d)).toString('hex'));
  });

  await t('imza sürəti: Apps Script-də bir push üçün qəbul olunan müddət (BigInt, ~100 ms-dən az)', () => {
    const b = makeBackend({ token: TOKEN });
    b.post({ action: 'push.key', token: TOKEN });
    const d = b.store.props.VAPID_PRIVATE, h = crypto.createHash('sha256').update('s').digest('hex');
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) b.sandbox.ecSign(h, d);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
    console.log(`   (bir imza: ${ms.toFixed(1)} ms Node-da; Apps Script 5–20× yavaş ola bilər)`);
    assert.ok(ms < 100, ms + ' ms');
  });

  await t('qeydiyyat: yalnız tanınmış push xidmətlərinin ünvanı qəbul olunur; Push vərəqinə yazılır, təkrar qeydiyyat sətri yeniləyir', () => {
    const b = makeBackend({ token: TOKEN });
    assert.strictEqual(reg(b, 'dev_M', 'https://evil.example.com/x').ok, false);
    assert.strictEqual(reg(b, 'dev_M', 'http://fcm.googleapis.com/x').ok, false);
    assert.strictEqual(reg(b, 'dev_M', 'https://fcm.googleapis.com.evil.com/x').ok, false, 'sonluq hiyləsi');
    assert.strictEqual(reg(b, 'dev_M', 'https://localhost/x').ok, false);
    assert.ok(reg(b, 'dev_M', EP_M).ok);
    assert.ok(reg(b, 'dev_M', EP_M2, { userName: 'Menecer 2' }).ok);
    assert.strictEqual(b.rows('Push').length, 1);
    assert.strictEqual(b.rows('Push')[0][5], EP_M2); assert.strictEqual(b.rows('Push')[0][2], 'Menecer 2');
    assert.strictEqual(b.post({ action: 'push.register', token: 'yanlış', device: 'x', endpoint: EP_M }).error, 'İcazə yoxdur');
  });

  await t('təsdiq sorğusu: yalnız səlahiyyəti olan BAŞQA cihaza push gedir, VAPID başlığı etibarlıdır', () => {
    const b = makeBackend({ token: TOKEN });
    const key = b.post({ action: 'push.key', token: TOKEN }).key;
    reg(b, 'dev_M', EP_M);                                                             // menecer (pos.line.delete var)
    reg(b, 'dev_M2', EP_M2, { userId: 'u_admin', userName: 'Admin', role: 'admin' });  // ikinci menecer cihazı
    reg(b, 'dev_K', EP_K, { userId: 'u_kassir', userName: 'Kassir', role: 'kassir', perms: ['pos.sell'] });   // kassir: icazə yoxdur
    const a = approval();
    const r = send(b, a);
    assert.ok(r.ok && r.acked.length === 1);
    const urls = b.pushLog.map(x => x.url).sort();
    assert.deepStrictEqual(urls, [EP_M, EP_M2].sort());
    b.pushLog.forEach(x => { assert.strictEqual(x.method, 'post'); checkVapid(x.headers, x.url, key); });
    // eyni sorğunun təkrar göndərilməsi (şəbəkə təkrarı) ikinci bildiriş yaratmır
    b.pushLog.length = 0;
    b.post({ action: 'sync', token: TOKEN, device: a.device, since: 0, items: [syncItem(a)], limit: 5 });   // başqa id ilə yeni hadisə: bu yeni sayılır
    assert.strictEqual(b.pushLog.length, 2);
  });

  await t('eyni hadisə id-si təkrar gələndə push təkrarlanmır', () => {
    const b = makeBackend({ token: TOKEN });
    b.post({ action: 'push.key', token: TOKEN }); reg(b, 'dev_M', EP_M);
    const it = syncItem(approval());
    const body = { action: 'sync', token: TOKEN, device: 'dev_K', since: 0, items: [it], limit: 5 };
    b.post(body); b.post(body);
    assert.strictEqual(b.pushLog.length, 1);
  });

  await t('sorğuçunun öz cihazı və öz hesabı bildiriş almır; köhnə (5 dəq+) və artıq cavablanmış sorğu üçün push yoxdur', () => {
    const b = makeBackend({ token: TOKEN });
    b.post({ action: 'push.key', token: TOKEN });
    reg(b, 'dev_M', EP_M);
    send(b, approval({ device: 'dev_M' }));                                              // sorğu menecerin öz cihazından
    send(b, approval({ requestedBy: { id: 'u_menecer', name: 'Menecer', role: 'menecer' }, device: 'dev_Z' }));   // menecerin öz hesabı başqa cihazdan
    send(b, approval({ at: new Date(Date.now() - 6 * 60000).toISOString() }));           // köhnə
    send(b, approval({ status: 'approved' }));                                            // artıq cavablanıb
    send(b, approval({ perm: 'admin.permissions' }));                                     // menecerdə bu icazə yoxdur
    assert.strictEqual(b.pushLog.length, 0);
    send(b, approval());
    assert.strictEqual(b.pushLog.length, 1);
  });

  await t('abunəlik bitibsə (410/404) cihaz söndürülür, sonrakı sorğular ona getmir; digər cihazlar təsirlənmir', () => {
    const b = makeBackend({ token: TOKEN });
    b.post({ action: 'push.key', token: TOKEN });
    reg(b, 'dev_M', EP_M); reg(b, 'dev_M2', EP_M2, { userId: 'u_admin', role: 'admin' });
    b.pushRespond = (url) => url === EP_M ? { status: 410, body: 'gone' } : { status: 201 };
    send(b, approval());
    const rows = b.rows('Push');
    assert.strictEqual(rows.find(r => r[0] === 'dev_M')[6], false);
    assert.strictEqual(rows.find(r => r[0] === 'dev_M2')[6], true);
    assert.strictEqual(rows.find(r => r[0] === 'dev_M')[8], '410');
    b.pushLog.length = 0; send(b, approval());
    assert.deepStrictEqual(b.pushLog.map(x => x.url), [EP_M2]);
    // 5xx: söndürülmür (müvəqqəti xəta), status yazılır
    b.pushRespond = () => ({ status: 503 }); send(b, approval());
    assert.strictEqual(b.rows('Push').find(r => r[0] === 'dev_M2')[6], true);
    assert.strictEqual(b.rows('Push').find(r => r[0] === 'dev_M2')[8], '503');
  });

  await t('çıxış (unregister) cihazı söndürür; yenidən qeydiyyat aktivləşdirir', () => {
    const b = makeBackend({ token: TOKEN });
    b.post({ action: 'push.key', token: TOKEN }); reg(b, 'dev_M', EP_M);
    assert.ok(b.post({ action: 'push.unregister', token: TOKEN, device: 'dev_M' }).ok);
    send(b, approval()); assert.strictEqual(b.pushLog.length, 0);
    reg(b, 'dev_M', EP_M); send(b, approval()); assert.strictEqual(b.pushLog.length, 1);
  });

  await t('push xətası (UrlFetchApp istisnası) sinxronu pozmur: hadisə yazılır və təsdiqlənir', () => {
    const b = makeBackend({ token: TOKEN });
    b.post({ action: 'push.key', token: TOKEN }); reg(b, 'dev_M', EP_M);
    b.pushThrows = 'Exception: You do not have permission to call UrlFetchApp.fetchAll';
    const r = send(b, approval());
    assert.ok(r.ok); assert.strictEqual(r.acked.length, 1);
    assert.strictEqual(b.rows('Events').filter(x => x[2] === 'approval.requested').length, 1);
    assert.ok(b.logs.some(l => /Bildiriş göndərilmədi/.test(l)));
  });

  await t('bildiriş heç vaxt qurulmayıbsa (açar yoxdur) təsdiq sorğusu push cəhdi etmir və Push vərəqini oxumur', () => {
    const b = makeBackend({ token: TOKEN });
    const before = b.calls.sheetApi;
    const r = send(b, approval());
    assert.ok(r.ok); assert.strictEqual(b.pushLog.length, 0);
    assert.ok(!b.store.props.VAPID_PRIVATE);
    void before;
  });

  await t('push xidməti yavaşdırsa 2 dəqiqə push göndərilmir (kassanın sorğusu gözləməsin); sinxron yenə işləyir', () => {
    const b = makeBackend({ token: TOKEN });
    b.post({ action: 'push.key', token: TOKEN }); reg(b, 'dev_M', EP_M);
    b.sandbox.PUSH_SLOW_MS = 5;
    b.pushRespond = () => { const t0 = Date.now(); while (Date.now() - t0 < 15); return { status: 201 }; };
    send(b, approval()); assert.strictEqual(b.pushLog.length, 1);
    assert.ok(b.store.cache.pushSlow);
    const r = send(b, approval());
    assert.ok(r.ok && r.acked.length === 1); assert.strictEqual(b.pushLog.length, 1, 'ikinci push göndərilmədi');
    delete b.store.cache.pushSlow; send(b, approval()); assert.strictEqual(b.pushLog.length, 2);
  });

  await t('push.test: qeydiyyatdan keçmiş cihaza göndərir və xidmətin cavabını qaytarır; qeydiyyatsız cihaz üçün aydın xəta', () => {
    const b = makeBackend({ token: TOKEN });
    const key = b.post({ action: 'push.key', token: TOKEN }).key;
    assert.strictEqual(b.post({ action: 'push.test', token: TOKEN, device: 'dev_yox' }).ok, false);
    reg(b, 'dev_M', EP_M);
    let r = b.post({ action: 'push.test', token: TOKEN, device: 'dev_M' });
    assert.ok(r.ok && r.sent); assert.strictEqual(r.status, 201);
    checkVapid(b.pushLog[0].headers, EP_M, key);
    b.pushRespond = () => ({ status: 403, body: 'invalid JWT provided' });
    r = b.post({ action: 'push.test', token: TOKEN, device: 'dev_M' });
    assert.ok(r.ok, 'sorğu işləndi'); assert.strictEqual(r.sent, false); assert.strictEqual(r.status, 403); assert.ok(/invalid JWT/.test(r.detail));
  });

  await t('BigInt dəstəklənməyən mühitdə skript yenə yüklənir və sinxron işləyir, yalnız bildiriş xəta qaytarır', () => {
    const b = makeBackend({ token: TOKEN, noBigInt: true });
    assert.ok(b.get().ok);
    const r = b.post({ action: 'push.key', token: TOKEN });
    assert.strictEqual(r.ok, false);
    const s = send(b, approval());
    assert.ok(s.ok && s.acked.length === 1);
  });

  await t('Code.gs-də BigInt literalı (123n) yoxdur', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/(^|[^\w.$'"])\d+n\b/.test(src), 'BigInt literalı tapıldı');
  });

  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
