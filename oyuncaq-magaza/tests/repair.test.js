/* node tests/repair.test.js — Excel idxalının açılış qalığı digər cihazlarda (2026-11-08 xətası).
   Köhnə versiya "product.created" hadisəsini açılış qalığından (stock.received) SONRA vaxtla yazırdı: digər cihazlar qəbulu məhsuldan əvvəl alıb atırdı,
   telefonda/digər kompüterdə qalıq 0 görünürdü. Yoxlanılır: 1) indi hadisələr düzgün sırada gedir; 2) səhv sırada gələn qəbul gözlədilir və məhsul gələndə
   tətbiq olunur; 3) artıq zədələnmiş cihaz yenilənəndə (schema 9) doldurma qalığı bərpa edir, təkrar işə düşəndə ikiqat saymır. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'secret-token';
const ADMIN_KEY = 'a'.repeat(64);
const JS = path.join(__dirname, '..', 'js');

function makeDevice(backend) {
  const store = {};
  const ctx = {
    console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController,
    crypto: nodeCrypto.webcrypto, indexedDB: new IDBFactory(), IDBKeyRange,
    navigator: { onLine: true }, fetch: backend.fetch(),
    sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } }
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'fifo', 'import', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};
  return ctx;
}
async function boot(be) { const d = makeDevice(be); await d.Services.init(); const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error, r.error); return d; }
async function loginAs(d, name, secret) { const u = (await d.Services.listUsers()).find(x => x.name === name); return d.Services.login(u.id, secret); }
async function rejects(p, re) {
  try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error('Gözlənilməyən xəta: ' + e.message + ' (gözlənilən ' + re + ')'); return e; }
  throw new Error('Xəta gözlənilirdi');
}
const sync = async (...ds) => { for (let i = 0; i < 2; i++) for (const d of ds) await d.Sync.cycle(); };
const J = x => JSON.parse(JSON.stringify(x));
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); }
}

(async () => {
  const be = makeBackend({ token: TOKEN });
  const A = await boot(be), B = await boot(be);
  await loginAs(A, 'Admin', '1234');
  await A.Services.createSupplier({ name: 'Alfa' });
  const mk = (line, name, supplier, opening) => ({ line, name, price: 900, cost: 500, opening, supplier, errors: [] });
  const stocks = async d => Object.fromEntries((await d.Services.listProducts()).map(x => [x.name, x.stock]));
  const importOn = async (d, names) => {
    const sups = await d.Services.listSuppliers({ all: true });
    return d.Services.importProducts(d.Import.classify(names.map((n, i) => mk(i + 2, n[0], n[1], n[2])), [], false, { list: sups, create: true }));
  };

  await t('idxal: hadisələr sırası məhsul → qəbul; digər cihazlarda və yeni cihazda qalıq eynidir', async () => {
    await importOn(A, [['X1', 'Alfa', 5], ['X2', '', 7], ['X3', 'Yeni', 3]]);
    const ob = (await A.DB.getAll('outbox')).sort((a, b) => a.id < b.id ? -1 : 1).map(x => x.type + ':' + (x.data.product ? x.data.product.name : (x.data.productId || '')));
    const pIdx = ob.findIndex(x => x.startsWith('product.created')), sIdx = ob.findIndex(x => x.startsWith('stock.received'));
    assert.ok(pIdx >= 0 && pIdx < sIdx, ob.join(', '));
    await sync(A, B);
    const C = await boot(be);
    const want = { X1: 5, X2: 7, X3: 3 };
    for (const d of [A, B, C]) { const s = await stocks(d); for (const k in want) assert.strictEqual(s[k], want[k], k); }
  });

  await t('səhv sırada gələn qəbul (köhnə versiyadan) atılmır: məhsul gələndə tətbiq olunur', async () => {
    await importOn(A, [['Y1', '', 4]]);
    const items = (await A.DB.getAll('outbox')).sort((a, b) => a.id < b.id ? -1 : 1);
    const pc = items.filter(x => x.type === 'product.created'), rest = items.filter(x => x.type !== 'product.created');
    const r = be.post({ action: 'sync', token: TOKEN, device: 'oldver', since: 0, items: rest.concat(pc).map(x => ({ id: x.id, at: x.at, type: x.type, userId: x.userId, data: x.data })) });
    assert.ok(r.ok, JSON.stringify(r).slice(0, 200));
    await B.Sync.cycle(); await B.Sync.cycle();
    assert.strictEqual((await stocks(B)).Y1, 4);
    assert.ok(!(await B.DB.getAll('meta')).some(m => String(m.key).startsWith('orphan:')), 'gözləyən qalmadı');
    await A.Sync.cycle(); assert.strictEqual((await stocks(A)).Y1, 4, 'idxal edən cihazda ikiqat yoxdur');
  });

  await t('zədələnmiş cihaz (qəbulu atmış) yenilənəndə doldurma qalığı bərpa edir; təkrar doldurma ikiqat saymır; idxal edən cihaz dəyişmir', async () => {
    // B-ni köhnə xətanın vəziyyətinə salırıq: X1 və X3-ün qəbulu atılıb (partiya, hərəkət, qalıq yoxdur)
    const ps = await B.DB.getAll('products');
    for (const name of ['X1', 'X3']) {
      const p = ps.find(x => x.name === name);
      for (const l of (await B.DB.getAll('lots')).filter(l => l.productId === p.id)) await B.DB.del('lots', l.id);
      for (const m of (await B.DB.getAll('stockMoves')).filter(m => m.productId === p.id && m.type === 'receipt')) await B.DB.del('stockMoves', m.id);
      p.stock = 0; await B.DB.put('products', p);
    }
    const p1 = ps.find(x => x.name === 'X1');
    await loginAs(B, 'Admin', '1234'); await B.Services.openShift(0);
    await B.Services.checkout([{ productId: p1.id, qty: 2 }], null, { method: 'cash', cashReceived: 5000 });
    assert.strictEqual((await stocks(B)).X1, -2, 'zədəli vəziyyət: satışdan sonra mənfi');
    await B.DB.put('meta', { key: 'schema', value: 8 });
    await B.Services.init();
    const bf = await B.DB.get('meta', 'backfill'); assert.ok(bf && !bf.value.done, 'doldurma başladı');
    await B.Sync.cycle(); await B.Sync.cycle();
    const s = await stocks(B);
    assert.strictEqual(s.X1, 3); assert.strictEqual(s.X3, 3); assert.strictEqual(s.X2, 7);
    assert.ok((await B.DB.getAll('lots')).some(l => l.productId === p1.id), 'partiya bərpa olundu');
    await B.DB.put('meta', { key: 'backfill', value: { upTo: (await B.DB.get('meta', 'syncCursor')).value, next: 0, done: false } });
    await B.Sync.cycle(); await B.Sync.cycle();
    assert.deepStrictEqual(J(await stocks(B)), J(s), 'ikinci doldurma heç nəyi dəyişmir');
    await A.Sync.cycle();
    await A.DB.put('meta', { key: 'backfill', value: { upTo: (await A.DB.get('meta', 'syncCursor')).value, next: 0, done: false } });
    await A.Sync.cycle(); await A.Sync.cycle();
    assert.strictEqual((await stocks(A)).X1, 3, 'A: 5 − 2');
    assert.strictEqual((await stocks(A)).X3, 3);
  });

  console.log((failed ? '✗ ' : '✓ ') + passed + ' keçdi' + (failed ? ', ' + failed + ' uğursuz' : ''));
  process.exit(failed ? 1 : 0);
})();
