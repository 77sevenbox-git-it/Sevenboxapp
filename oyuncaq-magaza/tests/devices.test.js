/* node tests/devices.test.js — cihaz açarları (Code.gs v9, FR-101): hər cihazın öz açarı, ADMIN_KEY ilə idarə, ləğv/bərpa/yeniləmə,
   köhnə ümumi açarın (SYNC_TOKEN) keçid pəncərəsi, kilidlənmədən qorunma. Server Node-da təqlid olunur (tests/gas-mock.js). */
const assert = require('assert');
const crypto = require('crypto');
const { makeBackend } = require('./gas-mock.js');

const LEGACY = 'legacy-shared-token-0123456789';
let passed = 0, failed = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; }, e => { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n   ')); }); }

const ping = (b, token, device) => b.post({ action: 'ping', token, device });
const sync = (b, token, device, items) => b.post({ action: 'sync', token, device, since: 0, items: items || [], limit: 5 });
const admin = (b, over) => b.post(Object.assign({ token: LEGACY, device: 'admin_pc', adminKey: b.adminKey }, over));
function fresh(withKey) {
  const b = makeBackend({ token: LEGACY });
  if (withKey !== false) b.adminKey = b.sandbox.setupAdminKey();
  return b;
}
const ev = (n) => { const at = new Date().toISOString(); return { id: at + '_' + String(n).padStart(6, '0') + '_a_t' + n, at, type: 'noop.test', userId: 'u1', device: 'x', data: { n } }; };

(async () => {
  await t('köhnə ümumi açar hələ işləyir (heç bir cihaz açarı yoxdur): məhdudiyyət başlamayıb', () => {
    const b = fresh();
    const r = ping(b, LEGACY, 'any_device_1');
    assert.ok(r.ok); assert.strictEqual(r.kind, 'legacy'); assert.strictEqual(r.version, 9);
    assert.strictEqual(r.legacyUntil, null, 'son tarix hələ yoxdur');
    assert.ok(sync(b, LEGACY, 'any_device_1').ok);
    assert.strictEqual(ping(b, 'səhv', 'any_device_1').code, 'denied');
    assert.strictEqual(ping(b, '', 'any_device_1').ok, false);
  });

  await t('ADMIN_KEY təyin olunmayıbsa cihaz idarəsi bağlıdır; setupAdminKey təkrar işləsə açarı dəyişmir', () => {
    const b = fresh(false);
    const r = b.post({ action: 'devices.list', token: LEGACY, device: 'admin_pc', adminKey: 'x' });
    assert.strictEqual(r.code, 'adminkey_unset');
    const k = b.sandbox.setupAdminKey();
    assert.ok(/^[0-9a-f]{64}$/.test(k));
    assert.strictEqual(b.sandbox.setupAdminKey(), null, 'təkrar işə salma mövcud açarı əvəz etmir');
    assert.strictEqual(b.store.props.ADMIN_KEY, k);
    assert.ok(b.logs.some(l => l.includes(k)), 'açar jurnalda göstərilir');
  });

  await t('ADMIN_KEY: səhv açar rədd, 5 səhvdən sonra düzgün açar da bağlanır, gözləmədən sonra açılır', () => {
    const b = fresh();
    for (let i = 0; i < 5; i++) assert.strictEqual(b.post({ action: 'devices.list', token: LEGACY, device: 'a_pc', adminKey: 'yanlış' + i }).code, 'adminkey_bad');
    assert.strictEqual(admin(b, { action: 'devices.list' }).code, 'adminkey_locked');
    delete b.store.cache.adm_fail;                       // keşin müddəti bitdi
    assert.ok(admin(b, { action: 'devices.list' }).ok);
    assert.strictEqual(b.store.cache.adm_fail, undefined, 'uğurlu giriş sayğacı sıfırlayır');
    assert.strictEqual(b.post({ action: 'devices.list', token: LEGACY, device: 'a_pc' }).code, 'adminkey_bad', 'açar göndərilməyib');
    assert.strictEqual(b.post({ action: 'devices.list', token: LEGACY, device: 'a_pc', adminKey: 5 }).code, 'adminkey_bad', 'sətir olmayan açar');
  });

  await t('ADMIN_KEY tək kifayət etmir: əsas açar (cihaz/ümumi) da lazımdır', () => {
    const b = fresh();
    const r = b.post({ action: 'devices.list', token: 'səhv', device: 'a_pc', adminKey: b.adminKey });
    assert.strictEqual(r.code, 'denied');
    assert.strictEqual(b.post({ action: 'devices.list', adminKey: b.adminKey }).code, 'denied');
  });

  await t('cihaz yarat: açar bir dəfə qaytarılır, Script Properties-də yalnız hash; hamısı cihaz id-sinə bağlı', () => {
    const b = fresh();
    const c = admin(b, { action: 'devices.create', id: 'dev_kassa1', name: 'Kassa 1' });
    assert.ok(c.ok, c.error); assert.ok(/^[0-9a-f]{64}$/.test(c.token));
    const stored = b.store.props.DEV_dev_kassa1;
    assert.ok(stored && !stored.includes(c.token), 'açarın özü saxlanmır');
    assert.ok(!Object.values(b.store.props).some(v => String(v).includes(c.token)), 'heç bir property açarı daşımır');
    assert.ok(!JSON.stringify(b.rows('Audit')).includes(c.token), 'Audit-də açar yoxdur');
    assert.ok(b.rows('Audit').some(r => r[1] === 'device.created'), 'Audit-də qeyd var');
    // yalnız öz id-si ilə işləyir
    const ok = ping(b, c.token, 'dev_kassa1'); assert.ok(ok.ok); assert.strictEqual(ok.kind, 'device');
    assert.strictEqual(ping(b, c.token, 'dev_kassa2').code, 'denied', 'başqa id ilə işləmir');
    assert.strictEqual(ping(b, c.token, '').code, 'denied', 'id-siz işləmir');
    assert.strictEqual(ping(b, c.token + 'x', 'dev_kassa1').code, 'denied');
    assert.ok(sync(b, c.token, 'dev_kassa1', [ev(1)]).ok);
    // təkrar yaratmaq olmaz (yeni açar üçün rotate)
    assert.strictEqual(admin(b, { action: 'devices.create', id: 'dev_kassa1' }).code, 'exists');
    // id səhvi
    assert.strictEqual(admin(b, { action: 'devices.create', id: 'a b' }).code, 'bad');
    assert.strictEqual(admin(b, { action: 'devices.create', id: 'ab' }).code, 'bad');
    assert.strictEqual(admin(b, { action: 'devices.create', id: 'x'.repeat(65) }).code, 'bad');
    assert.strictEqual(admin(b, { action: 'devices.create', id: ['dev_kassa9'] }).code, 'bad');
  });

  await t('keçid pəncərəsi ilk cihaz açarı ilə başlayır (14 gün); müddəti bitəndə ümumi açar bağlanır, cihaz açarı işləyir', () => {
    const b = fresh();
    assert.strictEqual(b.store.props.LEGACY_UNTIL, undefined);
    const c = admin(b, { action: 'devices.create', id: 'dev_one' });
    const until = Number(b.store.props.LEGACY_UNTIL);
    const days = (until - Date.now()) / 86400000;
    assert.ok(days > 13.99 && days <= 14, 'təxminən 14 gün: ' + days);
    assert.ok(c.legacy.active && c.legacy.started);
    assert.strictEqual(ping(b, LEGACY, 'old_dev').kind, 'legacy');
    assert.ok(ping(b, LEGACY, 'old_dev').legacyUntil, 'köhnə açarla gələn cihaz son tarixi görür');
    b.store.props.LEGACY_UNTIL = String(Date.now() - 1000); b.tick(121);   // Properties-i əllə dəyişmək keş müddəti (PROP_TTL=120 san) qədər gecikir
    assert.strictEqual(ping(b, LEGACY, 'old_dev').code, 'legacy_off');
    assert.strictEqual(ping(b, LEGACY, 'dev_one').code, 'legacy_off', 'qeydiyyatlı cihaz da ümumi açarla girə bilməz');
    assert.ok(ping(b, c.token, 'dev_one').ok, 'öz açarı işləyir');
  });

  await t('ümumi açarı söndürmək: cihaz açarı yoxdursa və ya sorğu ümumi açarla gəlirsə rədd (hamı kilidlənməsin)', () => {
    const b = fresh();
    assert.strictEqual(admin(b, { action: 'legacy.set', mode: 'off' }).code, 'no_devices');
    const c = admin(b, { action: 'devices.create', id: 'dev_admin_pc' });
    assert.strictEqual(admin(b, { action: 'legacy.set', mode: 'off' }).code, 'self_legacy', 'admin kompüteri özü hələ ümumi açarla işləyir');
    const own = (over) => b.post(Object.assign({ token: c.token, device: 'dev_admin_pc', adminKey: b.adminKey }, over));
    const off = own({ action: 'legacy.set', mode: 'off' });
    assert.ok(off.ok, off.error); assert.strictEqual(off.legacy.active, false);
    assert.strictEqual(ping(b, LEGACY, 'old_dev').code, 'legacy_off');
    // yenidən 3 günlüyə aç
    const on = own({ action: 'legacy.set', mode: 'on', days: 3 });
    assert.ok(on.ok && on.legacy.active);
    assert.ok(Math.abs((Date.parse(on.legacy.until) - Date.now()) / 86400000 - 3) < 0.01);
    assert.ok(ping(b, LEGACY, 'old_dev').ok);
    assert.strictEqual(own({ action: 'legacy.set', mode: 'on', days: 0 }).code, 'bad');
    assert.strictEqual(own({ action: 'legacy.set', mode: 'on', days: 91 }).code, 'bad');
    assert.strictEqual(own({ action: 'legacy.set', mode: 'bəlkə' }).code, 'bad');
  });

  await t('ləğv: cihaz bağlanır (həm öz açarı, həm ümumi açar), başqası "icazə yoxdur" alır, məlumat silinmir; bərpa edilir', () => {
    const b = fresh();
    const c = admin(b, { action: 'devices.create', id: 'dev_lost', name: 'İtmiş' });
    assert.ok(sync(b, c.token, 'dev_lost', [ev(1), ev(2)]).ok);
    const evBefore = b.rows('Events').length; assert.strictEqual(evBefore, 2);
    const r = admin(b, { action: 'devices.revoke', id: 'dev_lost', reason: 'oğurlanıb' });
    assert.ok(r.ok);
    const bad = ping(b, c.token, 'dev_lost'); assert.strictEqual(bad.code, 'revoked'); assert.strictEqual(bad.ok, false);
    assert.strictEqual(sync(b, c.token, 'dev_lost', [ev(3)]).code, 'revoked');
    assert.strictEqual(b.post({ action: 'allocate', token: c.token, device: 'dev_lost', key: 'productSeq', count: 5, min: 0 }).code, 'revoked');
    assert.strictEqual(ping(b, LEGACY, 'dev_lost').code, 'revoked', 'ümumi açarla da girə bilməz');
    assert.strictEqual(ping(b, 'başqası', 'dev_lost').code, 'denied', 'ləğv statusu yalnız açarı bilənə bildirilir');
    assert.strictEqual(b.rows('Events').length, evBefore, 'serverdəki hadisələr silinmir, ləğvdən sonra yeni hadisə qəbul edilmir');
    assert.ok(b.rows('Audit').some(x => x[1] === 'device.revoked' && x[3].includes('oğurlanıb')));
    // sorğuya yeni cihaz id-si ilə girmək: yeni id üçün açar yoxdur
    assert.strictEqual(ping(b, c.token, 'dev_other').code, 'denied');
    // bərpa
    assert.strictEqual(admin(b, { action: 'devices.create', id: 'dev_lost' }).code, 'dev_revoked', 'ləğv olunmuş cihaza yeni açar yaradılmır');
    assert.ok(admin(b, { action: 'devices.restore', id: 'dev_lost' }).ok);
    assert.ok(ping(b, c.token, 'dev_lost').ok, 'bərpadan sonra köhnə açarı yenə işləyir');
    assert.strictEqual(admin(b, { action: 'devices.restore', id: 'tapilmayan' }).code, 'missing');
  });

  await t('tanınmayan cihaz (ümumi açarla işləyən) ləğv edilə bilər və siyahıda "tanınmayan" görünür', () => {
    const b = fresh();
    assert.ok(sync(b, LEGACY, 'dev_old_pc').ok);
    const l = admin(b, { action: 'devices.list' });
    assert.ok(l.ok); assert.deepStrictEqual(l.unknown.map(u => u.id).sort(), ['admin_pc', 'dev_old_pc']);
    assert.strictEqual(l.unknown.find(u => u.id === 'dev_old_pc').lastKind, 'legacy');
    assert.ok(admin(b, { action: 'devices.revoke', id: 'dev_old_pc' }).ok);
    assert.strictEqual(ping(b, LEGACY, 'dev_old_pc').code, 'revoked');
    const l2 = admin(b, { action: 'devices.list' });
    assert.ok(!l2.unknown.some(u => u.id === 'dev_old_pc'));
    const d = l2.devices.find(x => x.id === 'dev_old_pc');
    assert.strictEqual(d.status, 'revoked'); assert.strictEqual(d.hasToken, false);
  });

  await t('yeni açar (rotate): köhnəsi dərhal dayanır; ad dəyişmək', () => {
    const b = fresh();
    const c = admin(b, { action: 'devices.create', id: 'dev_rot', name: 'Kassa 2' });
    const r = admin(b, { action: 'devices.rotate', id: 'dev_rot' });
    assert.ok(r.ok && r.token !== c.token);
    assert.strictEqual(ping(b, c.token, 'dev_rot').code, 'denied');
    assert.ok(ping(b, r.token, 'dev_rot').ok);
    assert.strictEqual(admin(b, { action: 'devices.rotate', id: 'yoxdur_id' }).code, 'missing');
    assert.ok(admin(b, { action: 'devices.rename', id: 'dev_rot', name: '  Anbar  ' }).ok);
    const l = admin(b, { action: 'devices.list' });
    const d = l.devices.find(x => x.id === 'dev_rot');
    assert.strictEqual(d.name, 'Anbar'); assert.ok(d.rotatedAt); assert.strictEqual(d.status, 'active'); assert.strictEqual(d.hasToken, true);
  });

  await t('"son görünmə" yazılır (seyrək), siyahıda cihazın növü və vaxtı görünür', () => {
    const b = fresh();
    const c = admin(b, { action: 'devices.create', id: 'dev_seen' });
    assert.ok(sync(b, c.token, 'dev_seen').ok);
    const w0 = b.store.props.ls_dev_seen; assert.ok(w0);
    for (let i = 0; i < 5; i++) sync(b, c.token, 'dev_seen');
    assert.strictEqual(b.store.props.ls_dev_seen, w0, '5 dəqiqə ərzində təkrar yazılmır');
    const d = admin(b, { action: 'devices.list' }).devices.find(x => x.id === 'dev_seen');
    assert.strictEqual(d.lastKind, 'device'); assert.ok(Date.now() - Date.parse(d.lastSeen) < 5000);
  });

  await t('sync cavabında açarın növü var (cihaz ümumi açarla işlədiyini görsün)', () => {
    const b = fresh();
    assert.strictEqual(sync(b, LEGACY, 'dev_x1').kind, 'legacy');
    const c = admin(b, { action: 'devices.create', id: 'dev_x1' });
    assert.strictEqual(sync(b, c.token, 'dev_x1').kind, 'device');
  });

  await t('doGet: yalnız cihaz açarları qalıbsa (SYNC_TOKEN silinib) tokenSet=true; heç biri yoxdursa false', () => {
    const b = fresh();
    admin(b, { action: 'devices.create', id: 'dev_only' });
    delete b.store.props.SYNC_TOKEN; b.tick(121);
    assert.strictEqual(b.get().tokenSet, true);
    const b2 = makeBackend({ token: '' });
    delete b2.store.props.SYNC_TOKEN; b2.tick(121);
    assert.strictEqual(b2.get().tokenSet, false);
    assert.strictEqual(ping(b2, '', 'dev_abc').ok, false, 'açar təyin olunmayıbsa heç nə keçmir');
  });

  await t('SYNC_TOKEN silinibsə cihaz açarı ilə işləmək davam edir; boş açarla heç kim keçmir', () => {
    const b = fresh();
    const c = admin(b, { action: 'devices.create', id: 'dev_solo' });
    delete b.store.props.SYNC_TOKEN; b.tick(121);
    assert.ok(sync(b, c.token, 'dev_solo').ok);
    assert.strictEqual(ping(b, '', 'dev_solo').ok, false);
    assert.strictEqual(ping(b, undefined, 'dev_solo').ok, false);
    assert.strictEqual(ping(b, LEGACY, 'dev_solo').code, 'denied');
  });

  await t('ləğv olunmuş cihaza bildiriş getmir', () => {
    const b = fresh();
    const mk = (id) => { const c = admin(b, { action: 'devices.create', id }); return c.token; };
    const tm = mk('dev_mgr'), tk = mk('dev_cash');
    const EP = 'https://fcm.googleapis.com/fcm/send/mgr-endpoint';
    b.post({ action: 'push.key', token: tm, device: 'dev_mgr' });
    assert.ok(b.post({ action: 'push.register', token: tm, device: 'dev_mgr', endpoint: EP, userId: 'u_menecer', userName: 'M', role: 'menecer', perms: ['pos.line.delete'] }).ok);
    const ap = () => { const a = { id: 'ap_' + Math.random().toString(36).slice(2), kind: 'line_delete', perm: 'pos.line.delete', summary: 's', requestedBy: { id: 'u_kassir', name: 'K', role: 'kassir' }, at: new Date().toISOString(), status: 'pending', device: 'dev_cash' }; return { id: new Date().toISOString() + '_' + Math.random().toString(36).slice(2), at: a.at, type: 'approval.requested', userId: 'u_kassir', device: 'dev_cash', data: { approval: a } }; };
    assert.ok(sync(b, tk, 'dev_cash', [ap()]).ok);
    assert.strictEqual(b.pushLog.filter(p => p.url === EP).length, 1, 'ləğvdən əvvəl bildiriş gedir');
    assert.ok(admin(b, { action: 'devices.revoke', id: 'dev_mgr' }).ok);
    assert.ok(sync(b, tk, 'dev_cash', [ap()]).ok);
    assert.strictEqual(b.pushLog.filter(p => p.url === EP).length, 1, 'ləğvdən sonra yeni bildiriş getmir');
    assert.strictEqual(b.post({ action: 'push.register', token: tm, device: 'dev_mgr', endpoint: EP, userId: 'u', userName: 'M', role: 'menecer', perms: [] }).code, 'revoked');
  });

  await t('cihaz açarı başqa cihazın adından hadisə/bildiriş qeydiyyatı göndərə bilmir (id açara bağlıdır)', () => {
    const b = fresh();
    const a = admin(b, { action: 'devices.create', id: 'dev_aaa' }).token;
    admin(b, { action: 'devices.create', id: 'dev_bbb' });
    // dev_aaa açarı ilə dev_bbb adından push qeydiyyatı
    assert.strictEqual(b.post({ action: 'push.register', token: a, device: 'dev_bbb', endpoint: 'https://fcm.googleapis.com/x/y', userId: 'u', userName: 'n', role: 'menecer', perms: [] }).code, 'denied');
    assert.strictEqual(sync(b, a, 'dev_bbb', [ev(9)]).code, 'denied');
    assert.strictEqual(b.rows('Events').length, 0);
  });

  /* 11.10: «Açar yarat» → «server cavab vermədi». Server açarı yaratmışdı (jurnalda device.created), cavab isə müştərinin 25 san gözləməsindən
     sonra çatdı: açar yalnız cavabda olduğu üçün itdi. Düzəliş: açarı Admin-in cihazı yaradır (newKey), təkrar sorğu eyni nəticəni qaytarır. */
  const HEX = () => crypto.randomBytes(32).toString('hex');

  await t('newKey: Admin cihazı açarı özü göndərir; serverdə yalnız hash, açar həmin cihazda işləyir', () => {
    const b = fresh(), key = HEX();
    const c = admin(b, { action: 'devices.create', id: 'dev_nk1', name: 'NK', newKey: key });
    assert.ok(c.ok, c.error); assert.strictEqual(c.token, key); assert.ok(!c.replay);
    assert.ok(!Object.values(b.store.props).some(v => String(v).includes(key)), 'açarın özü heç yerdə saxlanmır');
    assert.ok(!JSON.stringify(b.rows('Audit')).includes(key), 'Audit-də açar yoxdur');
    assert.strictEqual(ping(b, key, 'dev_nk1').kind, 'device');
    assert.strictEqual(ping(b, key, 'dev_nk2').code, 'denied', 'başqa id ilə işləmir');
  });

  await t('itmiş cavab: eyni newKey ilə təkrar sorğu açarı geri verir, ikinci yazı və ikinci jurnal sətri yoxdur', () => {
    const b = fresh(), key = HEX();
    const first = admin(b, { action: 'devices.create', id: 'dev_lost1', name: 'L', newKey: key });   // cavab müştəriyə çatmadı (təqlid: nəticə atılır)
    assert.ok(first.ok);
    const writes = b.calls.propWrite, audits = b.rows('Audit').filter(r => r[1] === 'device.created').length;
    const again = admin(b, { action: 'devices.create', id: 'dev_lost1', name: 'L', newKey: key });
    assert.ok(again.ok, again.error); assert.strictEqual(again.token, key); assert.strictEqual(again.replay, true);
    assert.strictEqual(b.calls.propWrite, writes, 'təkrar sorğu Properties-ə yazmır');
    assert.strictEqual(b.rows('Audit').filter(r => r[1] === 'device.created').length, audits, 'təkrar sorğu yeni jurnal sətri yazmır');
    assert.strictEqual(ping(b, key, 'dev_lost1').kind, 'device');
    // başqa açarla (yeni cəhd) yenə "artıq var"
    assert.strictEqual(admin(b, { action: 'devices.create', id: 'dev_lost1', newKey: HEX() }).code, 'exists');
  });

  await t('itmiş cavab: devices.rotate da eyni newKey ilə təkrar olunanda təhlükəsizdir (köhnə açar yalnız bir dəfə ləğv olunur)', () => {
    const b = fresh();
    const old = admin(b, { action: 'devices.create', id: 'dev_lost2' }).token, key = HEX();
    assert.ok(admin(b, { action: 'devices.rotate', id: 'dev_lost2', newKey: key }).ok);
    const again = admin(b, { action: 'devices.rotate', id: 'dev_lost2', newKey: key });
    assert.ok(again.ok && again.replay && again.token === key);
    assert.strictEqual(ping(b, old, 'dev_lost2').code, 'denied', 'köhnə açar dayanıb');
    assert.strictEqual(ping(b, key, 'dev_lost2').kind, 'device');
    assert.strictEqual(b.rows('Audit').filter(r => r[1] === 'device.rotated').length, 1);
  });

  await t('təkrar sorğu başqasının açarını açmır: yanlış newKey ilə "exists", ləğv olunmuş cihazda replay işləmir', () => {
    const b = fresh(), key = HEX();
    assert.ok(admin(b, { action: 'devices.create', id: 'dev_rp', newKey: key }).ok);
    assert.strictEqual(admin(b, { action: 'devices.create', id: 'dev_rp', newKey: key.replace(/./, c => c === 'a' ? 'b' : 'a') }).code, 'exists');
    assert.ok(admin(b, { action: 'devices.revoke', id: 'dev_rp' }).ok);
    assert.strictEqual(admin(b, { action: 'devices.create', id: 'dev_rp', newKey: key }).code, 'dev_revoked');
    assert.strictEqual(ping(b, key, 'dev_rp').code, 'revoked');
  });

  await t('newKey formatı yoxlanır: qısa/böyük hərf/obyekt/massiv rədd; boş göndərilməyibsə server özü yaradır', () => {
    const b = fresh();
    for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), '0'.repeat(63), '0'.repeat(65), 123, {}, ['0'.repeat(64)], true]) {
      const r = admin(b, { action: 'devices.create', id: 'dev_fmt', newKey: bad });
      assert.strictEqual(r.code, 'bad', 'rədd olunmalı: ' + JSON.stringify(bad));
    }
    assert.ok(!b.store.props.DEV_dev_fmt, 'səhv sorğu heç nə yazmır');
    const ok = admin(b, { action: 'devices.create', id: 'dev_fmt' });
    assert.ok(ok.ok && /^[0-9a-f]{64}$/.test(ok.token), 'newKey olmadan köhnə davranış');
    assert.ok(admin(b, { action: 'devices.create', id: 'dev_fmt2', newKey: null }).ok, 'null = göndərilməyib');
  });

  await t('Admin əməliyyatı kilidi müştərinin gözləməsindən (40 san) qısa gözləyir; kilid məşğulsa "busy", heç nə yazılmır', () => {
    const b = fresh();
    b.calls.lockWaits.length = 0;
    assert.ok(admin(b, { action: 'devices.create', id: 'dev_lk1' }).ok);
    assert.ok(b.calls.lockWaits.length > 0 && b.calls.lockWaits.every(ms => ms <= 15000), 'admin kilid gözləməsi ≤ 15 san: ' + b.calls.lockWaits);
    b.lockBusy = true;
    const props = JSON.stringify(b.store.props), audits = b.rows('Audit').length;
    for (const a of ['devices.create', 'devices.rotate', 'devices.revoke', 'devices.restore', 'devices.rename']) {
      const r = admin(b, { action: a, id: 'dev_lk1', newKey: HEX() });
      assert.strictEqual(r.code, 'busy', a);
    }
    assert.strictEqual(admin(b, { action: 'legacy.set', mode: 'on', days: 5 }).code, 'busy');
    b.lockBusy = false;
    b.tick(121);
    assert.strictEqual(JSON.stringify(b.store.props).replace(/"ls_[^}]*}"/g, ''), props.replace(/"ls_[^}]*}"/g, ''), 'busy cavab Properties-i dəyişmir (son görünmədən başqa)');
    assert.strictEqual(b.rows('Audit').length, audits);
  });

  await t('Audit vərəqi yazılmasa belə açar yaradılır və qaytarılır (açar itmir); bir dəfəlik xəta təkrar cəhdlə sağalır', () => {
    const b = fresh(), key = HEX(), key2 = HEX();
    b.store.sheets.Audit.failWrites = 99;                                  // Sheets yazmır
    const c = admin(b, { action: 'devices.create', id: 'dev_au1', newKey: key });
    assert.ok(c.ok, 'audit xətası əməliyyatı yıxmır: ' + JSON.stringify(c)); assert.strictEqual(c.token, key);
    assert.strictEqual(ping(b, key, 'dev_au1').kind, 'device');
    assert.ok(b.logs.some(l => /Audit yazılmadı/.test(l)), 'xəta Logger-də qalır');
    b.store.sheets.Audit.failWrites = 2;                                   // bir yazma + heal uğursuz, ikinci cəhd alınır
    const c2 = admin(b, { action: 'devices.create', id: 'dev_au2', newKey: key2 });
    assert.ok(c2.ok);
    assert.ok(b.rows('Audit').some(r => r[1] === 'device.created' && String(r[3]).includes('dev_au2')), 'təkrar cəhd jurnala yazdı');
  });

  console.log(`\nCihaz açarları: ${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
