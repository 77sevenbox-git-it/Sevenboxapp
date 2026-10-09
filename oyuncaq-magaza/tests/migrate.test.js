/* node tests/migrate.test.js — köhnə (v1) brauzer bazası yeni sxemə keçəndə məlumat itmir:
   təsadüfi istifadəçi id-ləri sabit id-lərlə əvəzlənir, dəyişdirilmiş PIN serverə çatır və 2-ci brauzerdə işləyir. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec', TOKEN = 'secret-token';
const JS = path.join(__dirname, '..', 'js');
const sha = (salt, pin) => nodeCrypto.createHash('sha256').update(salt + ':' + pin).digest('hex');

function load(backend, idb) {
  const ctx = { console, setTimeout, clearTimeout, TextEncoder, DOMException, crypto: nodeCrypto.webcrypto, indexedDB: idb, IDBKeyRange, navigator: { onLine: true }, fetch: backend.fetch() };
  ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx));
  ctx.Sync.kick = () => {};
  return ctx;
}

// v1 sxemi (indi silinən kodun eyni quruluşu): sales.receiptNo UNİKAL idi, "approvals" cədvəli yox idi
function buildV1(idb, seed) {
  return new Promise((resolve, reject) => {
    const req = idb.open('magaza', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const mk = (n, key, idx) => { const os = db.createObjectStore(n, { keyPath: key }); (idx || []).forEach(i => os.createIndex(i[0], i[0], { unique: i[1] })); };
      mk('products', 'id', [['storeBarcode', true], ['mfrBarcode', false]]); mk('sales', 'id', [['receiptNo', true], ['shiftId', false]]);
      mk('returns', 'id', [['saleId', false], ['shiftId', false]]); mk('shifts', 'id', [['status', false]]); mk('users', 'id');
      mk('stockMoves', 'id', [['productId', false]]); mk('priceHistory', 'id', [['productId', false]]); mk('cashMoves', 'id', [['shiftId', false]]);
      mk('audit', 'id'); mk('outbox', 'id'); mk('meta', 'key');
    };
    req.onsuccess = () => {
      const db = req.result;
      const stores = ['users', 'meta', 'sales', 'outbox', 'audit'];
      const tx = db.transaction(stores, 'readwrite');
      seed(tx);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); } }

(async () => {
  const be = makeBackend({ token: TOKEN });
  const idb = new IDBFactory();
  const adminSalt = 'abc123', adminHash = sha(adminSalt, '8426');   // köhnə brauzerdə Admin PIN-i 8426-ya dəyişib
  await buildV1(idb, tx => {
    tx.objectStore('users').put({ id: 'u_9f1c-random-1', name: 'Admin', role: 'admin', salt: adminSalt, pinHash: adminHash, active: true, mustChangePin: false });
    tx.objectStore('users').put({ id: 'u_7aa2-random-2', name: 'Menecer', role: 'menecer', salt: 's2', pinHash: sha('s2', '2222'), active: true, mustChangePin: true });
    tx.objectStore('users').put({ id: 'u_55b0-random-3', name: 'Kassir', role: 'kassir', salt: 's3', pinHash: sha('s3', '1111'), active: true, mustChangePin: true });
    tx.objectStore('meta').put({ key: 'initialized', value: '2026-10-01T00:00:00.000Z' });
    tx.objectStore('meta').put({ key: 'matrix', value: { admin: ['admin.permissions'], menecer: [], kassir: [], muhasib: [] } });
    tx.objectStore('meta').put({ key: 'store', value: { name: 'Köhnə mağaza', voen: '1', address: 'x', registerName: 'Kassa 1' } });
    tx.objectStore('sales').put({ id: 's_old1', receiptNo: 1, at: '2026-10-02T10:00:00.000Z', shiftId: 'sh1', lines: [], totals: { total: 100 }, payment: { method: 'cash' } });
    tx.objectStore('outbox').put({ id: '2026-10-02T10:00:00.000Z_a_legacy1', at: '2026-10-02T10:00:00.000Z', type: 'auth.login', data: {}, userId: null });
    tx.objectStore('outbox').put({ id: '2026-10-02T11:00:00.000Z_a_legacy2', at: '2026-10-02T11:00:00.000Z', type: 'admin.store_changed', data: { store: { name: 'Köhnə mağaza', voen: '1', address: 'x', registerName: 'Kassa 1' } }, userId: null });
  });

  const A = load(be, idb);
  await t('köhnə baza açılır: istifadəçilər sabit id alır, PIN və çek saxlanılır', async () => {
    await A.Services.init();
    const users = await A.DB.getAll('users');
    assert.deepStrictEqual(users.map(u => u.id).sort(), ['u_admin', 'u_kassir', 'u_menecer']);
    const admin = users.find(u => u.id === 'u_admin');
    assert.strictEqual(admin.pinHash, adminHash);
    assert.notStrictEqual(admin.updatedAt, A.Services.EPOCH, 'dəyişdirilmiş PIN yenilik sayılır');
    assert.strictEqual(users.find(u => u.id === 'u_menecer').updatedAt, A.Services.EPOCH, 'toxunulmamış istifadəçi sınaq vəziyyətindədir');
    assert.strictEqual((await A.DB.getAll('sales')).length, 1);
    assert.strictEqual((await A.DB.get('meta', 'schema')).value, 2);
    assert.ok(A.Services.deviceId());
  });

  await t('sales.receiptNo indeksi artıq unikal deyil (eyni nömrəli iki çek yazıla bilir)', async () => {
    await A.DB.put('sales', { id: 's_old2', receiptNo: 1, at: '2026-10-03T10:00:00.000Z', shiftId: 'sh1', lines: [], totals: { total: 50 }, payment: { method: 'cash' } });
    assert.strictEqual((await A.DB.byIndex('sales', 'receiptNo', 1)).length, 2);
  });

  await t('yenidən açılış təkrar miqrasiya etmir', async () => {
    const before = (await A.DB.getAll('outbox')).length;
    A.DB.reset(); await A.Services.init();
    assert.strictEqual((await A.DB.getAll('outbox')).length, before);
  });

  await t('köhnə brauzer serverə qoşulur: köhnə PIN bazaya yazılır', async () => {
    await A.Sync.connect(URL_OK, TOKEN);
    const admin = be.rows('Users').find(r => r[0] === 'u_admin');
    assert.strictEqual(admin[7], adminHash);
    assert.strictEqual(admin[4], false);
    assert.ok(be.rows('Events').some(r => r[0] === '2026-10-02T10:00:00.000Z_a_legacy1'), 'köhnə növbə hadisəsi də göndərilib');
    assert.strictEqual((await A.Services.outboxCount()), 0);
  });

  await t('yeni brauzer qoşulur: köhnə brauzerin PIN-i və icazələri orada işləyir; köhnə hadisə öz brauzerində təkrar tətbiq olunmur', async () => {
    const B = load(be, new IDBFactory());
    await B.Services.init(); await B.Sync.connect(URL_OK, TOKEN);
    const u = (await B.Services.listUsers()).find(x => x.name === 'Admin');
    const s = await B.Services.login(u.id, '8426');
    assert.strictEqual(s.role, 'admin');
    assert.ok(!s.mustChangePin);
    assert.strictEqual((await B.Services.storeInfo()).name, 'Köhnə mağaza', 'köhnə brauzerin mağaza məlumatı yeni brauzerə gəlib');
  });

  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
