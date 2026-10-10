/* node tests/clock.test.js — cihaz saatı səhvdirsə nə olur? (3 cihaz: ikisi düzgün, biri +2 gün irəli / 20 dəq. geri).
   Yoxlanır: server vaxtından fərqin ölçülməsi (Sync.status().skewMs), hadisə damğalarının server saatına görə düzəldilməsi (Services.setClockOffset),
   təsdiq sorğusunun vaxtı, "son yazan qalib" qaydası. Düzəlişsiz halda saatı irəli cihaz bütün dəyişiklik davalarında qalib gəlirdi və digər cihazların damğalarını zəhərləyirdi. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'clock-token-0123456789';
const JS = path.join(__dirname, '..', 'js');
function makeDevice(be) {
  const ctx = { console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController, crypto: nodeCrypto.webcrypto, indexedDB: new IDBFactory(), IDBKeyRange, navigator: { onLine: true }, fetch: be.fetch() };
  ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};
  return ctx;
}
function shiftClock(d, ms) { vm.runInContext(`(function () { var DateOrig = Date; var off = ${ms}; var o = DateOrig.now; Date.now = function () { return o() + off; };
  var P = function () { var a = arguments; if (a.length === 0) return new DateOrig(o() + off); return new (Function.prototype.bind.apply(DateOrig, [null].concat([].slice.call(a))))(); };
  P.prototype = DateOrig.prototype; P.now = Date.now; P.parse = DateOrig.parse; P.UTC = DateOrig.UTC; Date = P; })()`, d); }
async function boot(be, skew) { const d = makeDevice(be); if (skew) shiftClock(d, skew); await d.Services.init(); const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error, r.error); return d; }
async function loginAs(d, name, pin) { const u = (await d.Services.listUsers()).find(x => x.name === name); return d.Services.login(u.id, pin); }
async function sync(...ds) { for (let i = 0; i < 3; i++) for (const d of ds) await d.Sync.cycle(); }
const wait = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0; const notes = [];
async function t(name, fn) { try { await fn(); passed++; console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n   ')); } }

(async () => {
  const be = makeBackend({ token: TOKEN });
  const G = await boot(be, 0), H = await boot(be, 0), F = await boot(be, 2 * 86400000), L = await boot(be, -20 * 60000);
  await loginAs(G, 'Menecer', '2222'); await loginAs(H, 'Admin', '1234'); await loginAs(F, 'Menecer', '2222'); await loginAs(L, 'Menecer', '2222');
  const toy = (await G.Services.createProduct({ name: 'Saat sınağı', price: 1000, cost: 500 })).product;
  await sync(G, H, F, L);

  await t('server saatından fərq ölçülür: +2 gün irəli cihaz ≈ +172800 san, 20 dəq. geri cihaz ≈ −1200 san, düzgün cihaz ≈ 0', async () => {
    const sk = d => d.Sync.status().skewMs;
    // skew = server − cihaz: irəli cihazda mənfi
    assert.ok(Math.abs(sk(G)) < 2000, 'G: ' + sk(G));
    assert.ok(Math.abs(sk(F) + 2 * 86400000) < 5000, 'F: ' + sk(F));
    assert.ok(Math.abs(sk(L) - 20 * 60000) < 5000, 'L: ' + sk(L));
  });

  await t('server saatına görə düzəliş: saatı 2 gün irəli cihazın hadisələri real vaxtla damğalanır (±2 dəq.), offset yerli bazada saxlanır', async () => {
    const real = Date.now();
    await F.Services.updateProduct(toy.id, { price: 1111 });
    await L.Services.updateProduct(toy.id, { price: 1112 });
    const near = async (d, label) => {
      const a = (await d.DB.getAll('audit')).filter(x => x.type === 'product.updated').sort((x, y) => (x.at < y.at ? -1 : 1));
      const dt = Math.abs(Date.parse(a[a.length - 1].at) - real);
      assert.ok(dt < 120000, label + ': damğa real vaxtdan ' + Math.round(dt / 1000) + ' san fərqlənir');
    };
    await near(F, 'F (+2 gün)'); await near(L, 'L (−20 dəq.)');
    const off = await F.DB.get('meta', 'clockOffset');
    assert.ok(off && Math.abs(off.value + 2 * 86400000) < 5000, 'offset saxlanıb: ' + JSON.stringify(off));
    const offG = await G.DB.get('meta', 'clockOffset');
    assert.ok(!offG || offG.value === 0, 'düzgün saatlı cihazda düzəliş yoxdur');
    notes.push('yanlış saatlı cihazların hadisələri artıq real vaxtla damğalanır (offset = server − cihaz, 1 dəq.-dən böyükdürsə tətbiq olunur)');
  });

  await t('sonrakı düzəliş qalib gəlir: F-in dəyişikliyini görüb düzəldən G qalib gəlir, bütün cihazlar eyni qiymətdə birləşir', async () => {
    await sync(G, H, F, L);
    await wait(5);
    await G.Services.updateProduct(toy.id, { price: 2222 });
    await sync(G, H, F, L);
    const prices = [];
    for (const d of [G, H, F, L]) prices.push((await d.DB.get('products', toy.id)).price);
    assert.ok(prices.every(x => x === prices[0]), 'cihazlar eyni qiymətdədir: ' + prices);
    assert.strictEqual(prices[0], 2222, 'sonrakı düzəliş qalib gəlməlidir');
  });

  await t('SAAT ZƏHƏRLƏNMƏSİ aradan qalxıb: F-in qeydini redaktə edən G-nin yeni damğaları real vaxtdan fərqlənmir', async () => {
    const audit = (await G.DB.getAll('audit')).filter(a => a.type === 'product.updated').sort((x, y) => (x.at < y.at ? -1 : 1));
    const aheadMin = (Date.parse(audit[audit.length - 1].at) - Date.now()) / 60000;
    console.log('   → G-nin son qeydi real vaxtdan ' + aheadMin.toFixed(2) + ' dəq. irəlidir');
    notes.push('saat zəhərlənməsi: G-nin damğası real vaxtdan ' + aheadMin.toFixed(1) + ' dəq. fərqlənir');
    assert.ok(Math.abs(aheadMin) < 2, 'damğa real vaxta yaxın olmalıdır: ' + aheadMin);
  });

  await t('təsdiq sorğusu: saatı yanlış menecerlər üçün vaxt (10 dəq. TTL) server saatına görə hesablanır — həm irəli, həm geri saatlı menecer sorğunu görür', async () => {
    await loginAs(G, 'Kassir', '1111');
    const ap = await G.Services.requestApproval('line_delete', 'pos.line.delete', 'x', null, null);
    await sync(G, H, F, L);
    const seenL = (await L.Services.listPendingApprovals()).some(a => a.id === ap.id);
    const seenF = (await F.Services.listPendingApprovals()).some(a => a.id === ap.id);
    assert.ok(seenL && seenF, 'L: ' + seenL + ', F: ' + seenF);
    const r = await L.Services.decideApproval(ap.id, 'approved').then(x => 'təsdiqləndi', e => 'rədd: ' + e.message);
    assert.strictEqual(r, 'təsdiqləndi');
    notes.push('təsdiq sorğusu: saatı 20 dəq. geri və 2 gün irəli menecer eyni cür görür və təsdiqləyə bilir');
  });

  await t('saxta/səhv server cavabı: 30 gündən böyük, NaN və ya mətn fərqi tətbiq olunmur (damğalar qaçmır)', async () => {
    const X = await boot(be, 0);
    for (const bad of [1e12, -1e12, NaN, Infinity, '99999999', null, undefined, {}]) await X.Services.setClockOffset(bad);
    const off = await X.DB.get('meta', 'clockOffset');
    assert.ok(!off || off.value === 0, 'offset dəyişməməlidir: ' + JSON.stringify(off));
    await X.Services.setClockOffset(5 * 86400000);                       // ağlabatan (5 gün) fərq tətbiq olunur
    assert.strictEqual((await X.DB.get('meta', 'clockOffset')).value, 5 * 86400000);
    await X.Services.setClockOffset(30000);                              // 1 dəq.-dən kiçik fərq → 0
    assert.strictEqual((await X.DB.get('meta', 'clockOffset')).value, 0);
  });

  console.log('\n— Nəticə —\n' + notes.map(x => ' • ' + x).join('\n'));
  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
