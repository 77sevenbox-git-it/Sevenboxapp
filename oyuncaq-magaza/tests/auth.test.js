/* node tests/auth.test.js — rol üzrə giriş forması: PIN və ya şifrə (böyük + kiçik hərf, rəqəm, işarə).
   Admin rol üçün formanı seçir; dəyişəndən sonra həmin roldakılar öz HAZIRKI kodu ilə daxil olur, sonra yenisini seçməlidirlər.
   Cihazlar ayrı vm kontekstləridir (öz IndexedDB-si), backend: tests/gas-mock.js (Code.gs-in özü). */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'secret-token';
const JS = path.join(__dirname, '..', 'js');

function makeDevice(backend, withSession) {
  const store = {};
  const ctx = {
    console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController,
    crypto: nodeCrypto.webcrypto, indexedDB: new IDBFactory(), IDBKeyRange,
    navigator: { onLine: true }, fetch: backend.fetch()
  };
  if (withSession !== false) ctx.sessionStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};
  return ctx;
}
async function boot(be) { const d = makeDevice(be); await d.Services.init(); const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error); return d; }
async function uid(d, name) { return (await d.Services.listUsers()).find(x => x.name === name).id; }
async function loginAs(d, name, secret) { return d.Services.login(await uid(d, name), secret); }
async function rejects(p, re) {
  try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('Gözlənilməyən xəta: ' + e.message + ' (gözlənilən ' + re + ')'); return e; }
  throw new Error('Xəta gözlənilirdi');
}
const sync = async (...ds) => { for (let i = 0; i < 2; i++) for (const d of ds) await d.Sync.cycle(); };
const J = x => JSON.parse(JSON.stringify(x));          // vm kontekstinin obyektləri başqa "realm"dır: müqayisə JSON ilə
const credOf = async (d, name) => (await d.Services.listUsers()).find(x => x.name === name).cred;

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); }
}

(async () => {
  const be = makeBackend({ token: TOKEN });
  const A = await boot(be), B = await boot(be);          // A: Admin cihazı, B: kassa cihazı
  const PW = 'Qara-Ayı7!x', PW2 = 'Yeni_Şifrə2?';

  await t('hazırlıq: demo PIN-lər dəyişdirilir; ilkin siyasət: hamı PIN, listUsers yalnız forma göstərir (hash/duz yox)', async () => {
    let u = await loginAs(A, 'Admin', '1234'); assert.strictEqual(u.mustChangePin, true); await A.Services.changeCredential('1234', '5821');
    await loginAs(A, 'Menecer', '2222'); await A.Services.changeCredential('2222', '7342');
    await loginAs(A, 'Kassir', '1111'); await A.Services.changeCredential('1111', '2468');
    await loginAs(A, 'Admin', '5821');
    assert.deepStrictEqual(J(await A.Services.getAuthPolicy()), { admin: 'pin', menecer: 'pin', kassir: 'pin', muhasib: 'pin' });
    const us = await A.Services.listUsers();
    us.forEach(x => { assert.deepStrictEqual(Object.keys(x).sort(), ['cred', 'id', 'name', 'role']); assert.strictEqual(x.cred, 'pin'); });
    await sync(A, B);
  });

  await t('siyasəti yalnız icazəsi olan dəyişir; səhv dəyərlər və naməlum rol rədd olunur; dəyişiklik yoxdursa hadisə yaranmır', async () => {
    await loginAs(A, 'Kassir', '2468');
    await rejects(A.Services.setAuthPolicy({ kassir: 'password' }), /icazəniz yoxdur/);
    await loginAs(A, 'Admin', '5821');
    await rejects(A.Services.setAuthPolicy({ kassir: 'zzz' }), /Giriş forması səhvdir/);
    await rejects(A.Services.setAuthPolicy({ direktor: 'pin' }), /Giriş forması səhvdir/);
    await rejects(A.Services.setAuthPolicy(null), /Giriş forması səhvdir/);
    const before = await A.Services.outboxCount();
    const r = await A.Services.setAuthPolicy({ admin: 'pin', menecer: 'pin', kassir: 'pin', muhasib: 'pin' });
    assert.strictEqual(r.unchanged, true); assert.strictEqual(await A.Services.outboxCount(), before);
  });

  await t('girişsiz siyasət oxunmur (təsdiq/siyasət funksiyaları girişi tələb edir)', async () => {
    const d = await boot(be);
    await rejects(d.Services.getAuthPolicy(), /Daxil olun/); await rejects(d.Services.approverForm('pos.return.approve'), /Daxil olun/);
    await rejects(d.Services.myCredTarget(), /Daxil olun/); await rejects(d.Services.setAuthPolicy({ kassir: 'password' }), /Daxil olun/);
  });

  await t('Admin Kassir üçün "şifrə" seçir → server cədvəlində "Settings" və Audit-də görünür, B cihazı alır', async () => {
    await A.Services.setAuthPolicy({ kassir: 'password' });
    await sync(A, B);
    assert.deepStrictEqual(JSON.parse(be.rows('Settings').find(r => r[0] === 'authPolicy')[1]), { admin: 'pin', menecer: 'pin', kassir: 'password', muhasib: 'pin' });
    assert.ok(be.rows('Audit').some(r => r[1] === 'admin.auth_policy_changed'));
    await loginAs(B, 'Menecer', '7342');
    assert.strictEqual((await B.Services.getAuthPolicy()).kassir, 'password');
    assert.strictEqual(await B.Services.approverForm('pos.return.approve'), 'pin');       // təsdiq edənlər hələ PIN-dədir
  });

  await t('Kassir öz KÖHNƏ PIN-i ilə daxil olur, amma yeni forma tələb olunur (mustChangePin); sessiya brauzer yenilənməsində bərpa olunmur', async () => {
    assert.strictEqual(await credOf(B, 'Kassir'), 'pin');                                  // hələ PIN
    const u = await loginAs(B, 'Kassir', '2468');
    assert.strictEqual(u.mustChangePin, true);
    assert.deepStrictEqual(J(await B.Services.myCredTarget()), { form: 'password', current: 'pin' });
    B.Services.logout(); assert.strictEqual(await B.Services.restoreSession(), null);
  });

  await t('şifrə qaydaları: qısa / böyük hərfsiz / kiçik hərfsiz / rəqəmsiz / işarəsiz / boşluqlu; Azərbaycan hərfləri sayılır', async () => {
    await loginAs(B, 'Kassir', '2468');
    const cases = [['Ab1!', /ən azı 8 simvol/], ['qarabayi7!x', /1 böyük hərf/], ['QARABAYI7!X', /1 kiçik hərf/], ['Qara-Ayı!x', /1 rəqəm/], ['QaraAyı77x', /1 işarə/], ['Qara Ayı7!x', /boşluq/], ['x'.repeat(129) + 'A1!', /128/]];
    for (const [pw, re] of cases) await rejects(B.Services.changeCredential('2468', pw), re);
    await rejects(B.Services.changeCredential('9999', PW), /Köhnə PIN səhvdir/);           // qaydalara uyğundur, amma köhnə kod yanlışdır
    const R = B.Rules;
    ['Şifrə123!', 'Əli1!asdf', 'Üzüm-9kök'].forEach(p => assert.strictEqual(R.passwordProblem(p), null, p));
  });

  await t('uğurlu keçid: PBKDF2 hash (p1$310000$…, Node pbkdf2 ilə eyni), mustChangePin=false, sessiya bərpa olunur', async () => {
    await B.Services.changeCredential('2468', PW);
    assert.strictEqual(B.Services.currentUser().mustChangePin, false);
    const u = await B.DB.get('users', 'u_kassir');
    assert.ok(/^p1\$310000\$[0-9a-f]{64}$/.test(u.pinHash), u.pinHash);
    const ref = nodeCrypto.pbkdf2Sync(PW, u.salt, 310000, 32, 'sha256').toString('hex');
    assert.strictEqual(u.pinHash, 'p1$310000$' + ref, 'WebCrypto və Node PBKDF2 eyni nəticə verməlidir (başqa implementasiya yoxlaya bilsin)');
    assert.strictEqual(u.mustChangePin, false);
    assert.strictEqual(await credOf(B, 'Kassir'), 'password');
    const rs = await B.Services.restoreSession(); assert.ok(rs && rs.name === 'Kassir');
  });

  await t('server: Users vərəqində cred=password, Audit-də hash/duz yoxdur; hash cihazlara yayılır', async () => {
    await sync(B, A);
    const row = be.rows('Users').find(r => r[0] === 'u_kassir');
    assert.strictEqual(row[8], 'password'); assert.ok(/^p1\$/.test(row[7]));
    const audit = be.rows('Audit').map(r => r.join(' ')).join('\n');   // (Audit-in 4-cü xanası JSON mətndir)
    assert.ok(!audit.includes('p1$') && !audit.includes(row[6]), 'Audit-də hash/duz görünməməlidir');
    assert.ok(audit.includes('"cred":"password"'));
    assert.strictEqual(await credOf(A, 'Kassir'), 'password');
  });

  await t('A cihazında: köhnə PIN artıq keçmir ("Şifrə səhvdir"), yeni şifrə keçir və yenidən məcburi dəyişmə yoxdur', async () => {
    await rejects(loginAs(A, 'Kassir', '2468'), /Şifrə səhvdir/);
    const u = await loginAs(A, 'Kassir', PW);
    assert.strictEqual(u.mustChangePin, false);
    assert.ok(await A.Services.restoreSession());
    await rejects(loginAs(A, 'Kassir', PW.toLowerCase()), /Şifrə səhvdir/);
  });

  await t('yanlış şifrə sayğacı şifrə üçün də işləyir: 5 səhv cəhd → blok, düzgün şifrə də bloklanır', async () => {
    const id = await uid(B, 'Kassir');
    for (let i = 0; i < 5; i++) await rejects(B.Services.login(id, 'Yanlis-1' + i), /Şifrə səhvdir/);
    await rejects(B.Services.login(id, PW), /Çox səhv cəhd/);
    await B.DB.del('meta', 'authFail');                                                         // (sonrakı testlər üçün blok götürülür; 5 dəqiqə gözləmək olmaz)
  });

  await t('PIN-də qalan rollar toxunulmazdır: Menecer köhnə qaydada, məcburi dəyişmə yox', async () => {
    const u = await loginAs(A, 'Menecer', '7342'); assert.strictEqual(u.mustChangePin, false);
    assert.strictEqual(await credOf(A, 'Menecer'), 'pin');
  });

  await t('Menecer üçün də şifrə: təsdiq pəncərəsi "any" olur, təsdiq şifrə ilə işləyir; PIN-dəki Admin PIN ilə təsdiqləyə bilir', async () => {
    await loginAs(A, 'Admin', '5821');
    await A.Services.setAuthPolicy({ menecer: 'password' });
    await sync(A, B);
    await loginAs(B, 'Menecer', '7342');
    assert.strictEqual(B.Services.currentUser().mustChangePin, true);
    await B.Services.changeCredential('7342', PW2);
    await sync(B, A);
    await loginAs(B, 'Kassir', '2468').catch(() => {});                                  // bloklu/yanlış: sessiya Menecerdə qalmasın deyə
    await loginAs(B, 'Menecer', PW2);
    assert.strictEqual(await B.Services.approverForm('pos.return.approve'), 'any');
    const m = await B.Services.approveWithPin(PW2, 'pos.return.approve'); assert.strictEqual(m.name, 'Menecer');
    await rejects(B.Services.approveWithPin('7342', 'pos.return.approve'), /yanlışdır/);                 // köhnə PIN artıq keçmir
    const ad = await B.Services.approveWithPin('5821', 'pos.return.approve'); assert.strictEqual(ad.name, 'Admin');   // Admin hələ PIN-dədir
  });

  await t('Admin müvəqqəti kod verir: şifrə rolunda 12 simvollu qaydalara uyğun şifrə, PIN rolunda 6 rəqəm; ilk girişdə dəyişmək məcburidir', async () => {
    await loginAs(A, 'Admin', '5821');
    const tmpPw = await A.Services.resetPin(await uid(A, 'Kassir'));
    assert.strictEqual(tmpPw.length, 12); assert.strictEqual(A.Rules.passwordProblem(tmpPw), null, tmpPw);
    assert.strictEqual(await credOf(A, 'Kassir'), 'password');
    await sync(A, B);
    await rejects(loginAs(B, 'Kassir', PW), /Şifrə səhvdir/);                      // əvvəlki kod dərhal etibarsız
    const u = await loginAs(B, 'Kassir', tmpPw); assert.strictEqual(u.mustChangePin, true);
    assert.strictEqual(B.Services.currentUser().mustChangePin, true);
    await rejects(B.Services.changeCredential(tmpPw, tmpPw), /ən azı|eyni/);       // yenə eyni olmaz (qayda və ya eyni kod)
    await B.Services.changeCredential(tmpPw, PW);
    assert.strictEqual((await loginAs(B, 'Kassir', PW)).mustChangePin, false);
    // PIN rolu (Mühasib) üçün müvəqqəti kod 6 rəqəmdir
    await loginAs(A, 'Admin', '5821');
    const tmpPin = await A.Services.resetPin(await uid(A, 'Mühasib 1')); assert.ok(/^\d{6}$/.test(tmpPin));
  });

  await t('Yeni istifadəçi: müvəqqəti kod rolun formasında verilir (şifrə / PIN) və ilk girişdə dəyişir', async () => {
    await loginAs(A, 'Admin', '5821');
    const r = await A.Services.createUser({ name: 'Leyla Əliyeva', role: 'kassir' });
    assert.strictEqual(r.cred, 'password'); assert.strictEqual(A.Rules.passwordProblem(r.tempPin), null);
    const u = await loginAs(A, 'Leyla Əliyeva', r.tempPin); assert.strictEqual(u.mustChangePin, true);
    await A.Services.changeCredential(r.tempPin, 'Leyla-2026!a');
    assert.strictEqual((await loginAs(A, 'Leyla Əliyeva', 'Leyla-2026!a')).mustChangePin, false);
    await loginAs(A, 'Admin', '5821');
    const r2 = await A.Services.createUser({ name: 'Rəşad Orucov', role: 'muhasib' });
    assert.strictEqual(r2.cred, 'pin'); assert.ok(/^\d{6}$/.test(r2.tempPin));
  });

  await t('rol dəyişəndə forma uyğunsuzluğu: PIN-li işçi Kassir (şifrə) olur → öz PIN-i ilə girir, yeni şifrə seçməlidir', async () => {
    await loginAs(A, 'Admin', '5821');
    const r = await A.Services.createUser({ name: 'Vüqar Hüseynov', role: 'muhasib' });
    await loginAs(A, 'Vüqar Hüseynov', r.tempPin); await A.Services.changeCredential(r.tempPin, '4815');
    await loginAs(A, 'Admin', '5821');
    await A.Services.updateUser(await uid(A, 'Vüqar Hüseynov'), { role: 'kassir' });
    const list = await A.Services.listAllUsers(); const x = list.find(u => u.name === 'Vüqar Hüseynov');
    assert.deepStrictEqual([x.cred, x.target, x.mustChange], ['pin', 'password', true]);
    const u = await loginAs(A, 'Vüqar Hüseynov', '4815'); assert.strictEqual(u.mustChangePin, true);
    assert.deepStrictEqual(J(await A.Services.myCredTarget()), { form: 'password', current: 'pin' });
    await A.Services.changeCredential('4815', 'Vuqar-4815?');
    assert.strictEqual((await loginAs(A, 'Vüqar Hüseynov', 'Vuqar-4815?')).mustChangePin, false);
  });

  await t('siyasət şifrədən PIN-ə qayıdır: şifrəli istifadəçi şifrəsi ilə girir, yeni PIN seçməlidir (PIN qaydaları işləyir)', async () => {
    await loginAs(A, 'Admin', '5821');
    await A.Services.setAuthPolicy({ kassir: 'pin' });
    await sync(A, B);
    const u = await loginAs(B, 'Kassir', PW); assert.strictEqual(u.mustChangePin, true);
    assert.deepStrictEqual(J(await B.Services.myCredTarget()), { form: 'pin', current: 'password' });
    await rejects(B.Services.changeCredential(PW, '1111'), /sadə/);
    await rejects(B.Services.changeCredential(PW, '12'), /4–8 rəqəm/);
    await rejects(B.Services.changeCredential('səhv', '3917'), /Köhnə şifrə səhvdir/);
    await B.Services.changeCredential(PW, '3917');
    assert.strictEqual(await credOf(B, 'Kassir'), 'pin');
    assert.ok(!/^p1\$/.test((await B.DB.get('users', 'u_kassir')).pinHash));
    assert.strictEqual((await loginAs(B, 'Kassir', '3917')).mustChangePin, false);
  });

  await t('açıq sessiya siyasət dəyişəndə bağlanmır, amma brauzer yenilənəndə (restoreSession) yeni formaya məcbur edir', async () => {
    await loginAs(B, 'Kassir', '3917');
    assert.ok(await B.Services.restoreSession());
    await loginAs(A, 'Admin', '5821'); await A.Services.setAuthPolicy({ kassir: 'password' }); await sync(A, B);
    assert.strictEqual(B.Services.currentUser().name, 'Kassir');                              // sessiya açıq qalır
    assert.strictEqual(await B.Services.refreshSession(), 'same');
    assert.strictEqual(await B.Services.restoreSession(), null);                              // yenilənəndə yenidən daxil olmalıdır
    const u = await loginAs(B, 'Kassir', '3917'); assert.strictEqual(u.mustChangePin, true);
  });

  await t('siyasət "son yazan qalib": köhnə damğalı hadisə yeninin üstünü əzmir, saxta forma/qeyri-adi təkrar sayı rədd olunur', async () => {
    const dev = await boot(be);
    const cur = await dev.DB.get('meta', 'authPolicy');
    const old = new Date(Date.now() - 3600000).toISOString();
    const mk = (type, data, at) => ({ id: at + '_000000_x_' + nodeCrypto.randomUUID(), at, type, userId: '', device: 'forger', data });
    const pol = { admin: 'pin', menecer: 'pin', kassir: 'pin', muhasib: 'pin' };
    const bad1 = mk('admin.auth_policy_changed', { after: { kassir: 'zzz' } }, new Date(Date.now() + 5000).toISOString());                 // tanınmayan forma
    const bad2 = mk('admin.auth_policy_changed', { after: { direktor: 'password' } }, new Date(Date.now() + 5000).toISOString());           // tanınmayan rol
    const older = mk('admin.auth_policy_changed', { after: pol }, old);                                                                      // köhnə damğa
    const adm = Object.assign({}, await dev.DB.get('users', 'u_kassir'));
    const bomb = mk('user.upserted', { user: Object.assign({}, adm, { pinHash: 'p1$99999999$' + 'a'.repeat(64), updatedAt: new Date(Date.now() + 9000).toISOString() }), reason: 'x' }, new Date(Date.now() + 9000).toISOString());
    const r = be.post({ action: 'sync', token: TOKEN, device: 'forger', items: [bad1, bad2, older, bomb] }); assert.ok(r.ok);
    await sync(dev);
    const after = await dev.DB.get('meta', 'authPolicy');
    assert.deepStrictEqual(after.value, cur.value, 'saxta/köhnə hadisə siyasəti dəyişməməlidir');
    assert.ok(!/p1\$99999999/.test((await dev.DB.get('users', 'u_kassir')).pinHash), 'partlayıcı təkrar sayı olan hash qəbul olunmamalıdır');
    // sinxron donmayıb: sonrakı düzgün hadisə işləyir
    await loginAs(A, 'Admin', '5821'); await A.Services.setAuthPolicy({ muhasib: 'password' }); await sync(A, dev);
    assert.strictEqual((await dev.DB.get('meta', 'authPolicy')).value.muhasib, 'password');
  });

  await t('Admin-in öz rolu üçün şifrə: Admin öz PIN-i ilə girir, yeni şifrə seçməlidir; break-glass (PIN) də məcburi şifrəyə aparır', async () => {
    await loginAs(A, 'Admin', '5821');
    await A.Services.setAuthPolicy({ admin: 'password' });
    await sync(A, B);
    const u = await loginAs(B, 'Admin', '5821'); assert.strictEqual(u.mustChangePin, true);
    await B.Services.changeCredential('5821', 'Admin-Güclü9!');
    await sync(B, A);
    assert.strictEqual(await credOf(A, 'Admin'), 'password');
    await rejects(loginAs(A, 'Admin', '5821'), /Şifrə səhvdir/);
    assert.strictEqual((await loginAs(A, 'Admin', 'Admin-Güclü9!')).mustChangePin, false);
    // Code.gs-in təcili bərpası PIN verir (formada deyil): daxil olur, şifrə seçməyə məcburdur
    const pin = be.sandbox.resetAdminPin(); await sync(A, B);
    assert.strictEqual(await credOf(A, 'Admin'), 'pin');
    const bu = await loginAs(A, 'Admin', pin); assert.strictEqual(bu.mustChangePin, true);
    await A.Services.changeCredential(pin, 'Admin-Güclü9!z');
    assert.strictEqual((await loginAs(A, 'Admin', 'Admin-Güclü9!z')).mustChangePin, false);
  });

  await t('şifrəli giriş vaxtı: PBKDF2 (310 min təkrar) bir girişdə ~yüzlərlə ms, 2 saniyədən az (məlumat üçün çap olunur)', async () => {
    const id = await uid(A, 'Admin'); const t0 = Date.now();
    await A.Services.login(id, 'Admin-Güclü9!z');
    const ms = Date.now() - t0;
    console.log('  (məlumat) bir şifrəli giriş: ' + ms + ' ms (Node; brauzerdə oxşar və ya sürətli)');
    assert.ok(ms < 2000, ms + ' ms');
  });

  console.log(passed + ' keçdi, ' + failed + ' uğursuz');
  process.exit(failed ? 1 : 0);
})();
