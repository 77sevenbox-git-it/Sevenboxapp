/* node tests/stockreq.test.js — kassirin "mal gəldi" sorğusu → menecer təsdiqi → qalıq/partiya. Çoxcihazlı (kassir, menecer, admin) + Apps Script təqlidi.
   Yoxlanır: icazələr, yoxlamalar, düzəlişlərlə təsdiq, rədd/ləğv, vaxt (24 saat, kassa əməliyyatlarında 10 dəq), iki menecerin eyni anda təsdiqi (qalıq ikiqat artmır,
   cihazlar eyni nəticəyə gəlir), qeyri-aktiv təchizatçı, icazənin Admin tərəfindən alınması. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'secret-token';
const JS = path.join(__dirname, '..', 'js');

function makeDevice(backend) {
  const ctx = {
    console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController,
    crypto: require('crypto').webcrypto, indexedDB: new IDBFactory(), IDBKeyRange,
    navigator: { onLine: true }, fetch: backend.fetch()
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};
  return ctx;
}
async function boot(backend) {
  const d = makeDevice(backend);
  await d.Services.init();
  const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error);
  return d;
}
async function loginAs(d, name, pin) {
  const u = (await d.Services.listUsers()).find(x => x.name === name);
  return d.Services.login(u.id, pin);
}
async function rejects(p, re) {
  try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('Gözlənilməyən xəta: ' + e.message); return e; }
  throw new Error('Xəta gözlənilirdi');
}
async function sync(...ds) { for (let i = 0; i < 3; i++) for (const d of ds) await d.Sync.cycle(); }     // hər kəs hamının hadisəsini alsın
const stockOf = async (d, name) => (await d.Services.listProducts()).find(p => p.name === name).stock;
const approvalOf = async (d, id) => d.DB.get('approvals', id);
const lotsOf = async (d, productId) => (await d.DB.getAll('lots')).filter(l => l.productId === productId).sort((a, b) => (a.id < b.id ? -1 : 1));
function shiftClock(d, ms) { vm.runInContext(`(function () { var o = Date.now; Date.now = function () { return o() + ${ms}; }; })()`, d); }

let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); } }

(async () => {
  const be = makeBackend({ token: TOKEN });
  const K = await boot(be), M = await boot(be), C = await boot(be);      // K — kassir, M — menecer, C — admin
  let s1, s2, toy, bear;

  await t('hazırlıq: menecer məhsul və 2 təchizatçı yaradır, hamıya çatır', async () => {
    await loginAs(M, 'Menecer', '2222');
    toy = (await M.Services.createProduct({ name: 'Konstruktor', price: 1450, cost: 900 })).product;
    bear = (await M.Services.createProduct({ name: 'Ayı', price: 600, cost: 350 })).product;
    s1 = await M.Services.createSupplier({ name: 'Alfa MMC' });
    s2 = await M.Services.createSupplier({ name: 'Beta Toys' });
    await M.Services.receiveStock(toy.id, 5, 900, '', s1.id);
    await loginAs(K, 'Kassir', '1111'); await loginAs(C, 'Admin', '1234');
    await sync(M, K, C);
    assert.strictEqual(await stockOf(K, 'Konstruktor'), 5);
    assert.strictEqual(await stockOf(C, 'Konstruktor'), 5);
  });

  await t('kassir qalığı birbaşa artıra bilmir; sorğu göndərə bilir, qalıq dəyişmir', async () => {
    await rejects(K.Services.receiveStock(toy.id, 10, 100), /icazəniz yoxdur/);
    const ap = await K.Services.requestStockReceipt(toy.id, 10, s1.id, 'Qaimə 77');
    assert.strictEqual(ap.kind, 'stock.receive'); assert.strictEqual(ap.perm, 'stock.receive'); assert.strictEqual(ap.status, 'pending');
    assert.deepStrictEqual({ q: ap.payload.qty, s: ap.payload.supplierId, n: ap.payload.note, p: ap.payload.productId }, { q: 10, s: s1.id, n: 'Qaimə 77', p: toy.id });
    assert.ok(/Kassir.*Konstruktor.*10/.test(ap.summary), ap.summary);
    assert.strictEqual(ap.tk, '{0} mal qəbulu istəyir: «{1}», {2} ədəd'); assert.deepStrictEqual(Array.from(ap.tp), ['Kassir', 'Konstruktor', 10]);
    assert.strictEqual(await stockOf(K, 'Konstruktor'), 5);
    const mine = await K.Services.listMyStockRequests();
    assert.strictEqual(mine.length, 1); assert.strictEqual(mine[0].state, 'pending');
    await sync(K, M);
    const pend = await M.Services.listPendingApprovals();
    assert.ok(pend.some(a => a.id === ap.id), 'menecerin cihazına çatdı');
    assert.strictEqual(await stockOf(M, 'Konstruktor'), 5, 'təsdiqə qədər qalıq artmır');
    K._ap1 = ap;
  });

  await t('yoxlamalar: say, qeyd, naməlum məhsul, qeyri-aktiv təchizatçı, təkrar sorğu, menecerin sorğu icazəsi yoxdur', async () => {
    for (const q of [0, -3, 1.5, NaN, 100001]) await rejects(K.Services.requestStockReceipt(bear.id, q, null, ''), /Say/);
    await rejects(K.Services.requestStockReceipt(bear.id, 2, null, 'x'.repeat(201)), /200 simvol/);
    await rejects(K.Services.requestStockReceipt('p_yoxdur', 2, null, ''), /Məhsul tapılmadı/);
    await rejects(K.Services.requestStockReceipt(bear.id, 2, 'sup_yoxdur', ''), /Təchizatçı/);
    await rejects(K.Services.requestStockReceipt(toy.id, 3, null, ''), /artıq menecerin cavabını gözləyir/);     // Konstruktor üçün sorğu var
    await rejects(M.Services.requestStockReceipt(bear.id, 2, null, ''), /icazəniz yoxdur/);                       // menecer birbaşa qəbul edir
    assert.strictEqual((await K.DB.getAll('approvals')).filter(a => a.kind === 'stock.receive').length, 1, 'uğursuz sorğular qeyd olunmayıb');
  });

  await t('kassir sorğunu təsdiqləyə bilmir; menecer sayı, təchizatçını və alış qiymətini düzəldərək təsdiqləyir: qalıq, partiya, maya bir yerdə', async () => {
    const ap = K._ap1;
    await rejects(K.Services.decideApproval(ap.id, 'approved'), /icazəniz yoxdur/);
    await rejects(M.Services.decideApproval(ap.id, 'approved', { qty: 0 }), /Say/);
    await rejects(M.Services.decideApproval(ap.id, 'approved', { qty: 10, unitCost: -5 }), /Alış qiyməti/);
    assert.strictEqual((await approvalOf(M, ap.id)).status, 'pending', 'uğursuz cəhdlər sorğunu dəyişmir');
    assert.strictEqual(await stockOf(M, 'Konstruktor'), 5);
    const done = await M.Services.decideApproval(ap.id, 'approved', { qty: 12, supplierId: s2.id, unitCost: 500 });
    assert.strictEqual(done.status, 'approved'); assert.strictEqual(done.decidedBy.name, 'Menecer');
    assert.deepStrictEqual({ q: done.result.qty, c: done.result.unitCost, s: done.result.supplierId, l: done.result.lotId }, { q: 12, c: 500, s: s2.id, l: 'lot_' + ap.id });
    assert.strictEqual(await stockOf(M, 'Konstruktor'), 17);
    const lot = (await lotsOf(M, toy.id)).find(l => l.id === 'lot_' + ap.id);
    assert.deepStrictEqual({ q: lot.qty, c: lot.unitCost, s: lot.supplierId, u: lot.userId, a: lot.approvalId }, { q: 12, c: 500, s: s2.id, u: 'u_menecer', a: ap.id });
    const p = (await M.Services.listProducts()).find(x => x.id === toy.id);
    assert.strictEqual(p.lastCost, 500); assert.strictEqual(p.avgCost, Math.round((5 * 900 + 12 * 500) / 17));
    const audit = (await M.DB.getAll('audit')).filter(a => a.type === 'stock.received' && a.data.approvalId === ap.id);
    assert.strictEqual(audit.length, 1); assert.strictEqual(audit[0].userId, 'u_menecer'); assert.strictEqual(audit[0].data.requestedBy.name, 'Kassir');
    await rejects(M.Services.decideApproval(ap.id, 'approved'), /artıq cavab verilib/);                       // ikinci klik qalığı artırmır
    assert.strictEqual(await stockOf(M, 'Konstruktor'), 17);
    await sync(M, K, C);
    assert.strictEqual(await stockOf(K, 'Konstruktor'), 17); assert.strictEqual(await stockOf(C, 'Konstruktor'), 17);
    const mine = (await K.Services.listMyStockRequests())[0];
    assert.strictEqual(mine.state, 'approved'); assert.strictEqual(mine.result.qty, 12);
    const rep = await M.Services.supplierReport({});
    const row = rep.rows.find(r => r.name === 'Beta Toys'); assert.strictEqual(row.onHandQty, 12, 'FIFO hesabatında təchizatçı Beta-dır');
  });

  await t('rədd: qalıq dəyişmir; kassir görür; kassir gözləyən sorğunu ləğv edir, menecer artıq cavab verə bilmir', async () => {
    const a = await K.Services.requestStockReceipt(bear.id, 6, null, '');
    await sync(K, M);
    await M.Services.decideApproval(a.id, 'rejected');
    assert.strictEqual(await stockOf(M, 'Ayı'), 0);
    await sync(M, K);
    assert.strictEqual((await K.Services.listMyStockRequests()).find(x => x.id === a.id).state, 'rejected');
    assert.strictEqual(await stockOf(K, 'Ayı'), 0);
    const b = await K.Services.requestStockReceipt(bear.id, 4, null, '');       // rədd edilmişdən sonra yeni sorğu mümkündür
    await K.Services.cancelApproval(b.id);
    await sync(K, M);
    assert.strictEqual((await K.Services.listMyStockRequests()).find(x => x.id === b.id).state, 'cancelled');
    await rejects(M.Services.decideApproval(b.id, 'approved'), /artıq cavab verilib/);
    assert.strictEqual(await stockOf(M, 'Ayı'), 0);
    assert.ok(!(await M.Services.listPendingApprovals()).some(x => x.id === b.id), 'ləğv olunan sorğu menecerin siyahısında yoxdur');
  });

  await t('vaxt: mal qəbulu sorğusu 11 dəqiqədən sonra da təsdiqlənir (kassadakı əməliyyat üçün 10 dəq.), 24 saatdan sonra yox', async () => {
    const a = await K.Services.requestStockReceipt(bear.id, 3, null, '');
    const line = await K.Services.requestApproval('line_delete', 'pos.line.delete', 'x', null, null);       // kassadakı əməliyyat
    await sync(K, M);
    const late = makeDevice(be); await late.Services.init(); await late.Sync.connect(URL_OK, TOKEN); await loginAs(late, 'Menecer', '2222');
    await sync(late);
    shiftClock(late, 11 * 60000);
    await rejects(late.Services.decideApproval(line.id, 'approved'), /vaxtı bitib/);
    assert.ok((await late.Services.listPendingApprovals()).some(x => x.id === a.id), 'stok sorğusu 11 dəq. sonra hələ gözləyir');
    assert.ok(!(await late.Services.listPendingApprovals()).some(x => x.id === line.id));
    shiftClock(late, 25 * 3600000);
    await rejects(late.Services.decideApproval(a.id, 'approved'), /vaxtı bitib/);
    assert.strictEqual((await K.Services.listMyStockRequests()).find(x => x.id === a.id).state, 'pending');
    shiftClock(K, 25 * 3600000);
    assert.strictEqual((await K.Services.listMyStockRequests()).find(x => x.id === a.id).state, 'expired');
    shiftClock(K, -25 * 3600000);
    await K.Services.cancelApproval(a.id); await K.Services.cancelApproval(line.id); await sync(K, M);
  });

  await t('qeyri-aktiv təchizatçı: təsdiq xəta verir və qalıq/sorğu dəyişmir; menecer başqasını seçib təsdiqləyir', async () => {
    const a = await K.Services.requestStockReceipt(bear.id, 5, s1.id, '');
    await sync(K, M);
    await M.Services.updateSupplier(s1.id, { active: false });
    await rejects(M.Services.decideApproval(a.id, 'approved'), /Təchizatçı tapılmadı və ya söndürülüb/);
    assert.strictEqual((await approvalOf(M, a.id)).status, 'pending'); assert.strictEqual(await stockOf(M, 'Ayı'), 0);
    assert.strictEqual((await lotsOf(M, bear.id)).length, 0, 'yarımçıq partiya qalmayıb (tranzaksiya geri qaytarılıb)');
    await M.Services.decideApproval(a.id, 'approved', { supplierId: s2.id });
    assert.strictEqual(await stockOf(M, 'Ayı'), 5);
    assert.strictEqual((await M.DB.get('lots', 'lot_' + a.id)).supplierId, s2.id);
    assert.strictEqual((await M.DB.get('lots', 'lot_' + a.id)).unitCost, 350 * 0 + ((await M.Services.listProducts()).find(x => x.id === bear.id).lastCost), 'qiymət yazılmayıbsa son qiymət');
    await M.Services.updateSupplier(s1.id, { active: true });
    await sync(M, K, C);
    assert.strictEqual(await stockOf(K, 'Ayı'), 5);
  });

  async function race(first, second, qtyFirst, qtySecond, label) {
    // iki cihaz eyni sorğunu sinxrondan əvvəl təsdiqləyir: "first" daha erkən
    const a = await K.Services.requestStockReceipt(toy.id, 4, null, label);
    await sync(K, M, C);
    const base = await stockOf(K, 'Konstruktor');
    await first.Services.decideApproval(a.id, 'approved', { qty: qtyFirst, unitCost: 700 });
    await new Promise(r => setTimeout(r, 15));
    await second.Services.decideApproval(a.id, 'approved', { qty: qtySecond, unitCost: 800 });
    await sync(M, C, K, M, C);
    const want = base + qtyFirst;
    for (const [n, d] of [['M', M], ['C', C], ['K', K]]) {
      assert.strictEqual(await stockOf(d, 'Konstruktor'), want, `${label}: ${n} cihazında qalıq ${want} olmalıdır`);
      const lots = (await lotsOf(d, toy.id)).filter(l => l.approvalId === a.id);
      assert.strictEqual(lots.length, 1, `${label}: ${n} cihazında bu sorğunun tək partiyası var`);
      assert.deepStrictEqual({ q: lots[0].qty, c: lots[0].unitCost }, { q: qtyFirst, c: 700 }, `${label}: ${n} cihazında partiya qalibin sayı/qiymətidir`);
      assert.strictEqual((await approvalOf(d, a.id)).decidedBy.id, first === M ? 'u_menecer' : 'u_admin', `${label}: ${n} cihazında qalib qərar`);
      assert.strictEqual((await approvalOf(d, a.id)).result.qty, qtyFirst);
    }
  }
  await t('iki menecer eyni sorğunu eyni anda təsdiqləyir (eyni say): qalıq bir dəfə artır, hər cihazda eynidir', async () => { await race(M, C, 4, 4, 'eyni say'); });
  await t('iki menecer fərqli say yazır, menecer əvvəl: bütün cihazlar menecerin qərarına gəlir', async () => { await race(M, C, 6, 9, 'menecer əvvəl'); });
  await t('iki menecer fərqli say yazır, admin əvvəl: bütün cihazlar adminin qərarına gəlir (əks sıra)', async () => { await race(C, M, 3, 8, 'admin əvvəl'); });

  await t('Admin kassirdən "mal qəbulu sorğusu" icazəsini alır: sinxrondan sonra kassir sorğu göndərə bilmir', async () => {
    const m = await C.Services.getMatrix();
    assert.ok(m.kassir.includes('stock.request'), 'defolt: kassirdə var');
    m.kassir = m.kassir.filter(p => p !== 'stock.request');
    await C.Services.setMatrix(m);
    await sync(C, K, M);
    await rejects(K.Services.requestStockReceipt(bear.id, 1, null, ''), /icazəniz yoxdur/);
    m.kassir.push('stock.request'); await C.Services.setMatrix(m); await sync(C, K);
    const ok = await K.Services.requestStockReceipt(bear.id, 1, null, ''); await K.Services.cancelApproval(ok.id);
  });

  await t('qeyri-sənədli təsdiq növü: payload olmayan köhnə tip sorğu təsdiq edilsə qalıq dəyişmir (yalnız cavab yazılır)', async () => {
    const before = await stockOf(M, 'Konstruktor');
    const x = await K.Services.requestApproval('stock.receive', 'stock.receive', 'köhnə sorğu', null, null);      // payload yoxdur
    await sync(K, M);
    const r = await M.Services.decideApproval(x.id, 'approved');
    assert.strictEqual(r.status, 'approved'); assert.strictEqual(r.result, undefined);
    assert.strictEqual(await stockOf(M, 'Konstruktor'), before);
  });

  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
