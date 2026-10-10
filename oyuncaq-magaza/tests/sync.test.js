/* node tests/sync.test.js — iki (və daha çox) "brauzer" + Apps Script təqlidi ilə çoxcihazlı sinxronun uçdan-uca yoxlanması.
   Hər cihaz ayrı vm kontekstidir: öz IndexedDB-si, öz Services/Sync nüsxəsi var (real iki brauzer kimi). Backend: tests/gas-mock.js (Code.gs-in özü). */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const TOKEN = 'secret-token';
const JS = path.join(__dirname, '..', 'js');

function makeDevice(backend, idb) {
  const ctx = {
    console, setTimeout, clearTimeout, TextEncoder, DOMException, AbortController,
    crypto: require('crypto').webcrypto, indexedDB: idb || new IDBFactory(), IDBKeyRange,
    navigator: { onLine: true }, fetch: backend.fetch()
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};   // fon dövrləri testi qarışdırmasın (kick ayrıca yoxlanılır)
  return ctx;
}
async function boot(backend, connect) {
  const d = makeDevice(backend);
  await d.Services.init();
  if (connect !== false) { const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error); }
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
const products = d => d.Services.listProducts();
const byName = async (d, n) => (await products(d)).find(p => p.name === n);

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); }
}

(async () => {
  const be = makeBackend({ token: TOKEN });
  let A, B;

  await t('qoşulmamış cihaz sinxronu atlayır, yerli işləyir', async () => {
    const d = await boot(be, false);
    const r = await d.Sync.cycle();
    assert.ok(r.skipped);
    assert.ok((await d.Services.outboxCount()) >= 5);   // nümunə istifadəçilər növbədə gözləyir
  });

  await t('yanlış açar: aydın xəta, cihaz qoşulmur', async () => {
    const d = await boot(be, false);
    await rejects(d.Sync.connect(URL_OK, 'yanlis'), /Açar uyğun gəlmir/);
    assert.strictEqual(await d.Sync.endpoint(), '');
  });

  await t('yanlış ünvan formatı rədd olunur', async () => {
    const d = await boot(be, false);
    await rejects(d.Sync.connect('https://script.google.com/macros/s/ABC/dev', TOKEN), /\/dev/);
  });

  await t('A qoşulur: 5 nümunə istifadəçi "Users" vərəqinə düşür', async () => {
    A = await boot(be);
    assert.strictEqual(be.rows('Users').length, 5);
    assert.strictEqual(await A.Services.outboxCount(), 0);
  });

  let adminHashA;
  await t('PIN dəyişəndə bazada ("Users" vərəqi) dəyişir', async () => {
    await loginAs(A, 'Admin', '1234');
    await rejects(A.Services.changePin('1234', '1234'), /köhnə PIN ilə eyni/);
    await rejects(A.Services.changePin('1234', '9876'), /sadə/);
    await A.Services.changePin('1234', '5821');
    await A.Sync.cycle();
    const row = be.rows('Users').find(r => r[0] === 'u_admin');
    assert.strictEqual(row.length, 9);                      // 9-cu sütun: cred (pin|password)
    assert.strictEqual(row[4], false);                       // mustChangePin
    assert.notStrictEqual(row[5], A.Services.EPOCH);         // updatedAt yenilənib
    adminHashA = (await A.DB.get('users', 'u_admin')).pinHash;
    assert.strictEqual(row[7], adminHashA);                  // bazadakı hash lokalla eynidir
    assert.ok(be.rows('Audit').some(r => r[1] === 'user.upserted' && !/pinHash|salt/.test(r[3])), 'Audit jurnalında hash olmamalıdır');
  });

  await t('B (təzə brauzer) qoşulur → A-nın yeni PIN-i B-də işləyir, köhnə sınaq PIN-i yox', async () => {
    B = await boot(be);
    assert.strictEqual((await B.DB.get('users', 'u_admin')).pinHash, adminHashA);
    await rejects(loginAs(B, 'Admin', '1234'), /PIN səhvdir/);
    const u = await loginAs(B, 'Admin', '5821');
    assert.strictEqual(u.mustChangePin, false);
  });

  await t('B-nin sınaq PIN-i ilə girişi A-nın dəyişikliyini əzmir (server seed-i ignor edir)', async () => {
    const row = be.rows('Users').find(r => r[0] === 'u_admin');
    assert.strictEqual(row[7], adminHashA);
  });

  await t('B qoşulmamışdan əvvəl PIN dəyişib: login zamanı pull edilib yeni PIN qəbul olunur', async () => {
    const C = await boot(be);                                    // bu qoşuldu və hamısını aldı
    await loginAs(A, 'Menecer', '2222');
    await A.Services.changePin('2222', '7342');
    await A.Sync.cycle();
    // C hələ pull etməyib: lokal Menecer hələ 2222-dir. Yeni PIN ilə giriş cəhdi serverdən yeniləyib uğur qazanmalıdır
    const u = await loginAs(C, 'Menecer', '7342');
    assert.strictEqual(u.role, 'menecer');
  });

  let lego, bear;
  await t('A məhsul yaradır və mal qəbul edir → B-də eyni məhsul, eyni barkod, eyni qalıq', async () => {
    await loginAs(A, 'Menecer', '7342');
    lego = (await A.Services.createProduct({ name: 'Konstruktor', price: 1450, cost: 900 })).product;
    bear = (await A.Services.createProduct({ name: 'Ayı', price: 600, cost: 350 })).product;
    await A.Services.receiveStock(lego.id, 10, 900);
    await A.Services.receiveStock(lego.id, 10, 1100);
    await A.Sync.cycle();
    await B.Sync.cycle();
    const bl = await byName(B, 'Konstruktor');
    assert.ok(bl, 'məhsul B-yə gəlməyib');
    assert.strictEqual(bl.storeBarcode, lego.storeBarcode);
    assert.strictEqual(bl.stock, 20);
    assert.strictEqual(bl.avgCost, (await byName(A, 'Konstruktor')).avgCost);
  });

  await t('barkod və çek nömrələri cihazlara ayrı aralıqla verilir: toqquşma yoxdur', async () => {
    await loginAs(B, 'Menecer', '7342');
    const pb = (await B.Services.createProduct({ name: 'Maqnit', price: 225, cost: 90 })).product;
    const pa = (await A.Services.createProduct({ name: 'Puzzl', price: 1200, cost: 700 })).product;
    assert.notStrictEqual(pb.storeBarcode, pa.storeBarcode);
    assert.notStrictEqual(pb.storeBarcode, lego.storeBarcode);
    await B.Services.receiveStock(pb.id, 40, 90);
    await A.Services.receiveStock(pa.id, 5, 700);
    await A.Sync.cycle(); await B.Sync.cycle(); await A.Sync.cycle();
    assert.strictEqual((await products(A)).length, 4);
    assert.strictEqual((await products(B)).length, 4);
    assert.strictEqual((await A.Services.listConflicts()).length, 0);
    assert.strictEqual((await B.Services.listConflicts()).length, 0);
  });

  let saleB;
  await t('A növbə açır; B (kassir) həmin növbədə satır; A satışı və qalığı görür', async () => {
    await A.Services.openShift(5000);
    await A.Sync.cycle(); await B.Sync.cycle();
    await loginAs(B, 'Kassir', '1111');
    saleB = await B.Services.checkout([{ productId: lego.id, qty: 2 }, { productId: (await byName(B, 'Maqnit')).id, qty: 3 }], null, { method: 'cash', cashReceived: 10000 });
    await B.Sync.cycle(); await A.Sync.cycle();
    const onA = await A.DB.get('sales', saleB.id);
    assert.ok(onA, 'satış A-ya gəlməyib');
    assert.strictEqual((await byName(A, 'Konstruktor')).stock, 18);
    assert.strictEqual((await byName(A, 'Maqnit')).stock, 37);
    assert.strictEqual((await byName(B, 'Konstruktor')).stock, 18);
  });

  await t('iki cihaz paralel satır: çek nömrələri fərqlidir, qalıqlar hər iki yerdə eyni olur', async () => {
    await loginAs(A, 'Kassir', '1111');
    const sa = await A.Services.checkout([{ productId: lego.id, qty: 1 }], null, { method: 'bank', bankType: 'pos' });
    const sb = await B.Services.checkout([{ productId: lego.id, qty: 1 }], null, { method: 'bank', bankType: 'pos' });
    assert.notStrictEqual(sa.receiptNo, sb.receiptNo);
    await A.Sync.cycle(); await B.Sync.cycle(); await A.Sync.cycle();
    assert.strictEqual((await byName(A, 'Konstruktor')).stock, 16);
    assert.strictEqual((await byName(B, 'Konstruktor')).stock, 16);
    assert.strictEqual((await A.Services.recentSales(50)).length, 3);
    assert.strictEqual((await B.Services.recentSales(50)).length, 3);
  });

  await t('B-də satılan çeki A-da barkodla tapıb qaytarmaq olur; B qalığı geri alır', async () => {
    await loginAs(A, 'Menecer', '7342');
    const found = await A.Services.findSaleByCode(saleB.receiptBarcode);
    assert.strictEqual(found.id, saleB.id);
    const mgr = await A.Services.approveWithPin('7342', 'pos.return.approve');
    await A.Services.createReturn(saleB.id, [{ lineIndex: 0, qty: 1 }], mgr, 'sınaq');
    await A.Sync.cycle(); await B.Sync.cycle();
    assert.strictEqual((await byName(B, 'Konstruktor')).stock, 17);
    assert.strictEqual((await byName(A, 'Konstruktor')).stock, 17);
    const prev = await B.Services.returnedQtyBySale(saleB.id);
    assert.strictEqual(prev.map[0], 1);
  });

  await t('məhsulun qiyməti A-da dəyişir → B-də də dəyişir; köhnə redaktə yeninin üstünü əzmir', async () => {
    await A.Services.updateProduct(bear.id, { price: 700 });
    await A.Sync.cycle(); await B.Sync.cycle();
    assert.strictEqual((await byName(B, 'Ayı')).price, 700);
  });

  await t('icazə matrisi və mağaza məlumatı cihazlararası yayılır', async () => {
    await loginAs(A, 'Admin', '5821');
    const m = JSON.parse(JSON.stringify(await A.Services.getMatrix()));
    m.kassir = m.kassir.filter(p => p !== 'label.print');
    await A.Services.setMatrix(m);
    await A.Services.setStoreInfo({ name: 'Oyuncaq dünyası', voen: '1234567890', address: 'Bakı', registerName: 'Kassa 1' });
    await A.Sync.cycle(); await B.Sync.cycle();
    assert.ok(!(await B.Services.getMatrix()).kassir.includes('label.print'));
    assert.strictEqual((await B.Services.storeInfo()).name, 'Oyuncaq dünyası');
  });

  await t('icazə matrisi: köhnə versiyalı cihazdan gələn (v yoxdur) "stock.receive" ilə tamamlanır; yeni versiyalı olduğu kimi qalır', async () => {
    const D = await boot(be, false);
    const all = Object.keys(D.Rules.PERMISSIONS).filter(p => p !== 'stock.receive');
    const old = { admin: all, menecer: ['pos.sell', 'product.edit'], kassir: ['pos.sell'], muhasib: [] };
    const ev = (n, at, data) => ({ seq: n, id: 'ts_00000' + n + '_x' + n, at, type: 'admin.matrix_changed', device: 'other', data });
    await D.Replica.apply([ev(1, '2099-01-01T00:00:00.000Z', { after: old })], 1);
    let m = await D.Services.getMatrix();
    assert.ok(m.menecer.includes('stock.receive'), 'product.edit olan rola verilir');
    assert.ok(!m.kassir.includes('stock.receive'), 'Kassirə verilmir');
    assert.ok(!m.muhasib.includes('stock.receive'));
    // yeni versiyada admin Menecerdən qəbul icazəsini qəsdən alıb: bu qərar saxlanılır
    const fresh = { admin: all.concat('stock.receive'), menecer: ['pos.sell', 'product.edit'], kassir: [], muhasib: [] };
    await D.Replica.apply([ev(2, '2099-01-02T00:00:00.000Z', { after: fresh, v: D.Rules.MATRIX_VERSION })], 2);
    m = await D.Services.getMatrix();
    assert.ok(!m.menecer.includes('stock.receive'));
    assert.ok(m.admin.includes('stock.receive'));
  });

  await t('təsdiq sorğusu: kassir göndərir → menecer görür və təsdiqləyir → kassir cavabı alır', async () => {
    await loginAs(B, 'Kassir', '1111');
    const rq = await B.Services.requestApproval('line_delete', 'pos.line.delete', 'Ayı × 2 = 14,00 ₼');
    assert.strictEqual((await B.Services.checkApproval(rq.id)).state, 'pending');
    await B.Sync.cycle(); await A.Sync.cycle();
    await loginAs(A, 'Menecer', '7342');
    const pend = await A.Services.listPendingApprovals();
    assert.strictEqual(pend.length, 1);
    assert.strictEqual(pend[0].requestedBy.name, 'Kassir');
    await A.Services.decideApproval(rq.id, 'approved');
    await A.Sync.cycle(); await B.Sync.cycle();
    const c = await B.Services.checkApproval(rq.id);
    assert.strictEqual(c.state, 'approved');
    assert.strictEqual(c.approver.name, 'Menecer');
    assert.strictEqual((await A.Services.listPendingApprovals()).length, 0);
  });

  await t('kassir öz sorğusunu təsdiqləyə bilmir; rədd olunmuş sorğu "rejected" qaytarır; ləğv', async () => {
    await loginAs(B, 'Kassir', '1111');
    const r1 = await B.Services.requestApproval('line_delete', 'pos.line.delete', 'x');
    await rejects(B.Services.decideApproval(r1.id, 'approved'), /icazəniz yoxdur/);
    await B.Sync.cycle(); await A.Sync.cycle();
    await loginAs(A, 'Menecer', '7342');
    await A.Services.decideApproval(r1.id, 'rejected');
    await A.Sync.cycle(); await B.Sync.cycle();
    assert.strictEqual((await B.Services.checkApproval(r1.id)).state, 'rejected');
    const r2 = await B.Services.requestApproval('line_delete', 'pos.line.delete', 'y');
    await B.Services.cancelApproval(r2.id);
    assert.strictEqual((await B.Services.checkApproval(r2.id)).state, 'cancelled');
    await B.Sync.cycle(); await A.Sync.cycle();
    await rejects(A.Services.decideApproval(r2.id, 'approved'), /artıq cavab/);
  });

  await t('iki menecer eyni sorğuya eyni anda fərqli cavab verir → bütün cihazlarda eyni nəticə (ilk cavab)', async () => {
    await loginAs(B, 'Kassir', '1111');
    const rq = await B.Services.requestApproval('line_delete', 'pos.line.delete', 'iki menecer');
    await B.Sync.cycle(); await A.Sync.cycle();
    const C = await boot(be);
    await loginAs(A, 'Menecer', '7342'); await loginAs(C, 'Menecer', '7342');
    await A.Services.decideApproval(rq.id, 'approved');
    await new Promise(r => setTimeout(r, 8));
    await C.Services.decideApproval(rq.id, 'rejected');       // C hələ A-nın cavabını almayıb
    for (let i = 0; i < 2; i++) { await A.Sync.cycle(); await C.Sync.cycle(); await B.Sync.cycle(); }
    const st = await Promise.all([A, B, C].map(async d => (await d.DB.get('approvals', rq.id)).status));
    assert.deepStrictEqual(st, ['approved', 'approved', 'approved'], 'üç cihaz: ' + st.join(','));
  });

  await t('saxta təsdiq: səlahiyyəti olmayan şəxsin "təsdiqi" qəbul olunmur', async () => {
    await loginAs(B, 'Kassir', '1111');
    const r = await B.Services.requestApproval('line_delete', 'pos.line.delete', 'z');
    const a = await B.DB.get('approvals', r.id);
    a.status = 'approved'; a.decidedBy = { id: 'u_kassir', name: 'Kassir', role: 'kassir' };
    await B.DB.put('approvals', a);
    assert.strictEqual((await B.Services.checkApproval(r.id)).state, 'rejected');
  });

  await t('cavab itsə də təkrar göndəriş dublikat yaratmır (idempotent), mal qəbulu iki dəfə yazılmır', async () => {
    await loginAs(A, 'Menecer', '7342');
    const p = await byName(A, 'Maqnit');
    await A.Services.receiveStock(p.id, 7, 90);
    const before = be.rows('Events').length;
    const pending = await A.Services.outboxCount();
    const realFetch = A.fetch;
    // 1-ci cəhd: server yazır, amma cavab itir
    A.fetch = (url, o) => realFetch(url, o).then(() => { throw new TypeError('Failed to fetch'); });
    const r1 = await A.Sync.cycle();
    assert.ok(r1.error);
    assert.ok(await A.Services.outboxCount() > 0, 'cavab gəlmədiyi üçün növbədə qalmalıdır');
    A.fetch = realFetch;
    const r2 = await A.Sync.cycle();
    assert.ok(!r2.error);
    assert.strictEqual(be.rows('Events').length, before + pending, 'hadisə iki dəfə yazılıb');
    await B.Sync.cycle();
    assert.strictEqual((await byName(B, 'Maqnit')).stock, (await byName(A, 'Maqnit')).stock);
    assert.strictEqual(be.rows('StockReceipts').filter(r => r[2] === 7).length, 1);
  });

  await t('oflayn satış: internet qayıdanda göndərilir və A-da görünür', async () => {
    B.navigator.onLine = false;
    await loginAs(B, 'Kassir', '1111');
    const s = await B.Services.checkout([{ productId: lego.id, qty: 1 }], null, { method: 'bank', bankType: 'transfer' });
    assert.ok(s.offline);
    const r = await B.Sync.cycle();
    assert.ok(r.skipped);
    B.navigator.onLine = true;
    await B.Sync.cycle(); await A.Sync.cycle();
    assert.ok(await A.DB.get('sales', s.id));
  });

  await t('boş sorğu (yeni hadisə yoxdur) cədvəli açmır: sürətli yol', async () => {
    await A.Sync.cycle();
    const opened = be.calls.openById, api = be.calls.sheetApi;
    for (let i = 0; i < 5; i++) await A.Sync.cycle();
    assert.strictEqual(be.calls.openById, opened);
    assert.strictEqual(be.calls.sheetApi, api);
  });

  await t('10 satışlıq paket: Sheets API çağırışları az (toplu yazı)', async () => {
    await loginAs(A, 'Menecer', '7342');
    await A.Services.receiveStock(bear.id, 50, 350);
    await loginAs(A, 'Kassir', '1111');
    for (let i = 0; i < 10; i++) await A.Services.checkout([{ productId: lego.id, qty: 1 }, { productId: bear.id, qty: 1 }], null, { method: 'bank', bankType: 'pos' });
    const api = be.calls.sheetApi;
    await A.Sync.cycle();
    const used = be.calls.sheetApi - api;
    console.log('   (10 satış üçün Sheets API çağırışı: ' + used + ')');
    assert.ok(used <= 25, 'Sheets API çağırışı çoxdur: ' + used);
  });

  await t('pozuq hadisə növbəni dayandırmır: səhv jurnala yazılır, qalanlar işlənir', async () => {
    const out = be.post({ action: 'sync', token: TOKEN, device: 'dX', since: 0, limit: 1, items: [
      { id: '2030-01-01T00:00:00.000Z_000001_a_bad', at: '2030-01-01T00:00:00.000Z', type: 'sale.created', userId: 'u', data: {} },
      { id: '2030-01-01T00:00:00.000Z_000002_a_ok', at: '2030-01-01T00:00:00.000Z', type: 'auth.login', userId: 'u', data: {} }] });
    assert.strictEqual(out.acked.length, 2);
    assert.ok(be.rows('Audit').some(r => r[1] === 'server.project_error'));
    assert.ok(be.rows('Events').some(r => r[0] === '2030-01-01T00:00:00.000Z_000002_a_ok'));
  });

  await t('çox hadisə: səhifələmə ilə yeni cihaz hamısını alır', async () => {
    const items = [];
    for (let i = 0; i < 300; i++) items.push({ id: '2031-01-01T00:00:00.000Z_' + String(i).padStart(6, '0') + '_a_bulk' + i, at: '2031-01-01T00:00:00.000Z', type: 'auth.login', userId: 'u', data: {} });
    be.post({ action: 'sync', token: TOKEN, device: 'dY', since: 0, limit: 1, items });
    be.post({ action: 'sync', token: TOKEN, device: 'dY', since: 0, limit: 1, items: items.map(x => Object.assign({}, x, { id: x.id + 'b' })) });
    assert.ok(be.rows('Events').length > 600);
    const D = await boot(be);
    assert.strictEqual(await D.Replica.cursor(), be.rows('Events').length);
    assert.strictEqual((await products(D)).length, 4);
    assert.strictEqual((await D.Services.recentSales(500)).length, (await A.Services.recentSales(500)).length);
  });

  await t('eyni mağaza barkodu iki cihazda (köhnə, aralıqsız rejim): toqquşma qeyd olunur, sinxron dayanmır', async () => {
    const be2 = makeBackend({ token: TOKEN });
    const X = await boot(be2, false), Y = await boot(be2, false);
    await loginAs(X, 'Menecer', '2222'); await loginAs(Y, 'Menecer', '2222');
    const px = (await X.Services.createProduct({ name: 'X-məhsul', price: 100 })).product;
    const py = (await Y.Services.createProduct({ name: 'Y-məhsul', price: 100 })).product;
    assert.strictEqual(px.storeBarcode, py.storeBarcode);     // lokal sayğaclar eyni nömrə verib
    await X.Sync.connect(URL_OK, TOKEN); await Y.Sync.connect(URL_OK, TOKEN); await X.Sync.cycle();
    assert.strictEqual((await X.Services.listConflicts()).length, 1);
    assert.strictEqual((await Y.Services.listConflicts()).length, 1);
    assert.strictEqual((await products(X)).length, 1);
    // qoşulandan sonra yeni məhsullar toqquşmur
    const pz = (await Y.Services.createProduct({ name: 'Z', price: 100 })).product;
    assert.notStrictEqual(pz.storeBarcode, px.storeBarcode);
    // heç biri 3-cü cihazdakı yeni barkodla toqquşmur
    const W = await boot(be2); await loginAs(W, 'Menecer', '2222');
    const pw = (await W.Services.createProduct({ name: 'W', price: 100 })).product;
    assert.ok(![px.storeBarcode, pz.storeBarcode].includes(pw.storeBarcode));
  });

  await t('aralıq mövcud məhsul barkodlarının üstündən başlayır (köhnə məlumatı olan server)', async () => {
    const be3 = makeBackend({ token: TOKEN });
    const X = await boot(be3, false); await loginAs(X, 'Menecer', '2222');
    for (let i = 0; i < 12; i++) await X.Services.createProduct({ name: 'K' + i, price: 100 });   // lokal 1..12
    await X.Sync.connect(URL_OK, TOKEN);                                                           // server cədvəli 12-ni görür
    const Y = await boot(be3); await loginAs(Y, 'Menecer', '2222');
    const p = (await Y.Services.createProduct({ name: 'Yeni', price: 100 })).product;
    assert.ok(parseInt(p.storeBarcode.slice(2, 12), 10) > 12, 'Y 12-dən yuxarı nömrə almalıdır: ' + p.storeBarcode);
  });

  await t('çox köhnə təkrar göndəriş (pəncərədən kənar) dəqiq axtarışla tapılır, dublikat yazılmır', async () => {
    const be8 = makeBackend({ token: TOKEN });
    be8.sandbox.SEEN_WINDOW = 5;
    const mk = (i) => ({ id: '2032-01-01T00:00:00.' + String(i).padStart(3, '0') + 'Z_000001_a_w' + i, at: '2032-01-01T00:00:00.' + String(i).padStart(3, '0') + 'Z', type: 'auth.login', userId: 'u', data: {} });
    be8.post({ action: 'sync', token: TOKEN, device: 'd1', since: 0, items: Array.from({ length: 20 }, (_, i) => mk(i)) });
    assert.strictEqual(be8.rows('Events').length, 20);
    const r = be8.post({ action: 'sync', token: TOKEN, device: 'd1', since: 20, items: [mk(2), mk(3), mk(19), mk(99)] });
    assert.strictEqual(r.acked.length, 4);
    assert.strictEqual(be8.rows('Events').length, 21, 'yalnız yeni hadisə (99) yazılmalıdır');
  });

  await t('eyni brauzerin iki tabı eyni səhifəni eyni anda alsa da qalıq iki dəfə dəyişmir', async () => {
    const be9 = makeBackend({ token: TOKEN });
    const M = await boot(be9); await loginAs(M, 'Menecer', '2222');
    const p = (await M.Services.createProduct({ name: 'Tab-məhsul', price: 100, cost: 50 })).product;
    await M.Services.receiveStock(p.id, 10, 50);
    await M.Sync.cycle();
    const idb = new IDBFactory();
    const T1 = makeDevice(be9, idb); await T1.Services.init(); await T1.Sync.connect(URL_OK, TOKEN);
    const T2 = makeDevice(be9, idb); await T2.Services.init(); T2.Sync.kick = () => {};
    assert.strictEqual((await T1.Services.listProducts())[0].stock, 10);
    await M.Services.receiveStock(p.id, 5, 50);
    await M.Services.receiveStock(p.id, 3, 50);
    await M.Sync.cycle();
    await Promise.all([T1.Sync.cycle(), T2.Sync.cycle(), T1.Sync.cycle(), T2.Sync.cycle()]);
    assert.strictEqual((await T1.Services.listProducts())[0].stock, 18, 'qalıq 10+5+3=18 olmalıdır');
    assert.strictEqual((await T2.Services.listProducts())[0].stock, 18);
  });

  await t('kompüterin saatı serverdən fərqlənirsə, fərq ölçülür', async () => {
    const be10 = makeBackend({ token: TOKEN });
    const X = await boot(be10);
    await X.Sync.cycle();
    assert.ok(Math.abs(X.Sync.status().skewMs) < 1500, 'normal saat: fərq ~0');
    vm.runInContext('(function(){ var real = Date.now; Date.now = function () { return real() + 3600000; }; })()', X);   // bu cihazın saatı 1 saat irəlidədir
    await loginAs(X, 'Menecer', '2222');     // yeni hadisə → yeni dövr
    await X.Sync.cycle();
    assert.ok(X.Sync.status().skewMs < -3000000, 'saat fərqi ~-1 saat olmalıdır: ' + X.Sync.status().skewMs);
  });

  await t('növbə bağlananda digər kassanın satışı da hesabata düşür (əvvəlcə serverdən yenilənir)', async () => {
    const be11 = makeBackend({ token: TOKEN });
    const A1 = await boot(be11), B1 = await boot(be11);
    await loginAs(A1, 'Menecer', '2222');
    const p = (await A1.Services.createProduct({ name: 'N', price: 1000, cost: 500 })).product;
    await A1.Services.receiveStock(p.id, 20, 500);
    await A1.Services.openShift(5000);
    await A1.Sync.cycle(); await B1.Sync.cycle();
    await loginAs(B1, 'Kassir', '1111');
    await B1.Services.checkout([{ productId: p.id, qty: 2 }], null, { method: 'cash', cashReceived: 2000 });
    await B1.Sync.cycle();                    // A1 hələ bilmir
    assert.strictEqual((await A1.Services.recentSales(10)).length, 0);
    const closed = await A1.Services.closeShift(5000 + 2000);
    assert.strictEqual(closed.expectedCash, 7000);
    assert.strictEqual(closed.diff, 0);
    await A1.Sync.cycle(); await B1.Sync.cycle();
    assert.strictEqual(await B1.Services.currentShift(), null, 'bağlanmış növbə B-də də bağlıdır');
    await rejects(B1.Services.checkout([{ productId: p.id, qty: 1 }], null, { method: 'cash', cashReceived: 1000 }), /növbəni açın/);
  });

  await t('məhsul yaradılması ilə dəyişmə arasında saat fərqi: geridə qalan cihazın dəyişməsi itmir', async () => {
    const be3 = makeBackend({ token: TOKEN });
    const A3 = await boot(be3), B3 = await boot(be3);
    await loginAs(A3, 'Menecer', '2222');
    const p = (await A3.Services.createProduct({ name: 'Saat fərqi', price: 500, cost: 100 })).product;
    await A3.Sync.cycle(); await B3.Sync.cycle();
    // B cihazının saatı geridədir: dəyişmə hadisəsinin vaxtı məhsulun yaradılma vaxtından əvvəldir. Yenə də tətbiq olunmalıdır (yaradılma müqayisədə iştirak etmir)
    const cur = await B3.Replica.cursor();
    const ev = { seq: cur + 1, id: '2001-01-01T00:00:00.000Z_000001_a_late', at: '2001-01-01T00:00:00.000Z', type: 'product.updated', device: 'd_late', data: { id: p.id, after: Object.assign({}, p, { price: 777 }) } };
    await B3.Replica.apply([ev], cur + 1);
    assert.strictEqual((await B3.DB.get('products', p.id)).price, 777);
  });

  await t('cədvəl təmizlənibsə (kursor serverdən böyük) sinxron ilişmir', async () => {
    const be4 = makeBackend({ token: TOKEN });
    const X = await boot(be4);
    await loginAs(X, 'Menecer', '2222');
    await X.Services.createProduct({ name: 'Q', price: 100 });
    await X.Sync.cycle();
    assert.ok(await X.Replica.cursor() > 3);
    be4.store.sheets.Events.rows.length = 1; be4.store.cache = {};          // admin Events-i əl ilə təmizlədi
    const r = await X.Sync.cycle();
    assert.ok(!r.error);
    assert.strictEqual(await X.Replica.cursor(), 0);
  });

  await t('server əlçatmazdırsa: xəta mesajı, məlumat itmir, bərpa olunanda göndərilir', async () => {
    const be5 = makeBackend({ token: TOKEN });
    const X = await boot(be5);
    await loginAs(X, 'Menecer', '2222');
    be5.down = true;
    await X.Services.createProduct({ name: 'Oflayn məhsul', price: 100 });
    const r = await X.Sync.cycle();
    assert.ok(/Anyone|cavab vermədi/.test(r.error));
    assert.ok(await X.Services.outboxCount() > 0);
    be5.down = false;
    assert.ok(!(await X.Sync.cycle()).error);
    assert.strictEqual(await X.Services.outboxCount(), 0);
    assert.ok(be5.rows('Products').some(r => r[1] === 'Oflayn məhsul'));
  });

  await t('Sheets mətni: "=" ilə başlayan ad düstura çevrilmir, boşluq/rəqəmlə başlayanlar mətn qalır', async () => {
    const be6 = makeBackend({ token: TOKEN });
    const X = await boot(be6);
    await loginAs(X, 'Menecer', '2222');
    const p = (await X.Services.createProduct({ name: '=HYPERLINK("x")', price: 100 })).product;
    await X.Sync.cycle();
    const row = be6.rows('Products').find(r => r[0] === p.id);
    assert.strictEqual(row[1], '=HYPERLINK("x")');            // mock ' işarəsini mətn işarəsi sayır → dəyər dəyişməyib
    assert.strictEqual(row[5], p.storeBarcode);                // barkod mətn kimi qalır
  });

  await t('kick(): yazıdan sonra qısa gecikmə ilə avtomatik göndərir', async () => {
    const be7 = makeBackend({ token: TOKEN });
    const X = await boot(be7);
    delete X.Sync.kick;
    // real kick-i yenidən yüklə
    vm.runInContext(fs.readFileSync(path.join(JS, 'sync.js'), 'utf8'), X);
    await loginAs(X, 'Menecer', '2222');
    await X.Services.createProduct({ name: 'Tez', price: 100 });
    await new Promise(r => setTimeout(r, 900));
    assert.ok(be7.rows('Products').some(r => r[1] === 'Tez'), '1 saniyə ərzində göndərilməyib');
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  await t('qoşulma: yalnız ping + sync + GET (nömrə aralığı əlavə sorğusuz gəlir)', async () => {
    const b = makeBackend({ token: TOKEN });
    const actions = [];
    const X = await boot(b, false);
    const inner = X.fetch;
    X.fetch = (url, o) => { actions.push(o && o.method === 'POST' ? JSON.parse(o.body).action : 'GET'); return inner(url, o); };
    await X.Sync.connect(URL_OK, TOKEN);
    assert.deepStrictEqual(actions.slice().sort(), ['GET', 'ping', 'sync']);
    const pr = (await X.DB.get('meta', 'block:productSeq')).value.ranges, rc = (await X.DB.get('meta', 'block:receiptSeq')).value.ranges;
    assert.strictEqual(pr.length, 1); assert.strictEqual(rc.length, 1);
    const sz = r => r.reduce((n, x) => n + x[1] - x[0] + 1, 0);
    assert.ok(sz(rc) >= 400, 'oflayn ehtiyat: ən azı 400 çek nömrəsi (gündə 300 çek üçün qıt-qıt, bir gün) — hazırda ' + sz(rc));
    assert.ok(sz(pr) >= 100, 'ən azı 100 məhsul nömrəsi');
  });

  await t('köhnə server (v3, "blocks" yoxdur): aralıq ayrıca "allocate" ilə alınır', async () => {
    const b = makeBackend({ token: TOKEN });
    const actions = [];
    const X = await boot(b, false);
    const inner = X.fetch;
    X.fetch = (url, o) => {
      let init = o;
      if (o && o.method === 'POST') {
        const body = JSON.parse(o.body); actions.push(body.action);
        if (body.action === 'sync') { delete body.alloc; init = Object.assign({}, o, { body: JSON.stringify(body) }); }
      }
      return inner(url, init).then(r => ({ ok: r.ok, status: r.status, json: () => r.json().then(j => { delete j.blocks; return j; }) }));
    };
    await X.Sync.connect(URL_OK, TOKEN);
    assert.strictEqual(actions.filter(a => a === 'allocate').length, 2);
    assert.ok((await X.DB.get('meta', 'block:productSeq')).value.ranges.length === 1);
  });

  await t('ilişmiş sorğu: zaman həddindən sonra xəta verir, növbəti dövr normal işləyir (sinxron ilişmir)', async () => {
    const b = makeBackend({ token: TOKEN });
    const X = await boot(b);
    const good = X.fetch;
    X.Sync.timing.timeout = 80;
    X.fetch = () => new Promise(() => {});          // heç vaxt cavab vermir
    const t0 = Date.now();
    const r = await X.Sync.cycle();
    assert.ok(r.error && /cavab vermədi/.test(r.error), r.error);
    assert.ok(Date.now() - t0 < 1500);
    assert.strictEqual(X.Sync.status().ok, false);
    X.fetch = good;
    assert.ok(!(await X.Sync.cycle()).error);
    assert.strictEqual(X.Sync.status().ok, true);
  });

  await t('yazı yoxlama sorğusunu gözləmir: gedən boş yoxlama dayandırılır, hadisə dərhal göndərilir', async () => {
    const b = makeBackend({ token: TOKEN });
    const X = await boot(b);
    const good = X.fetch;
    let pollStarted = 0, pollAborted = 0;
    X.fetch = (url, o) => {
      const body = o && o.method === 'POST' ? JSON.parse(o.body) : null;
      if (body && body.action === 'sync' && !body.items.length && !body.alloc) {
        pollStarted++;
        return new Promise((res, rej) => { o.signal.addEventListener('abort', () => { pollAborted++; rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });   // ilişib qalan yoxlama
      }
      return good(url, o);
    };
    const poll = X.Sync.cycle();
    await sleep(30);
    assert.strictEqual(pollStarted, 1);
    await loginAs(X, 'Menecer', '2222');
    await X.Services.createProduct({ name: 'Boru', price: 100 });
    const t0 = Date.now();
    await X.Sync.cycle({ push: true });
    await poll;
    assert.ok(Date.now() - t0 < 800, 'yazı yoxlamanı gözləyib');
    assert.strictEqual(pollAborted, 1);
    assert.ok(b.rows('Products').some(r => r[1] === 'Boru'));
    assert.notStrictEqual(X.Sync.status().ok, false, 'dayandırılmış yoxlama xəta sayılmamalıdır');
    assert.strictEqual(await X.Services.outboxCount(), 0);
  });

  await t('gedən sorğu YAZI daşıyırsa dayandırılmır (təkrar göndəriş riski yoxdur)', async () => {
    const b = makeBackend({ token: TOKEN });
    const X = await boot(b);
    await loginAs(X, 'Menecer', '2222');
    await X.Services.createProduct({ name: 'Yazi', price: 100 });
    const good = X.fetch;
    let aborted = 0, release;
    X.fetch = (url, o) => {
      const body = o && o.method === 'POST' ? JSON.parse(o.body) : null;
      if (body && body.action === 'sync' && body.items.length) {
        o.signal.addEventListener('abort', () => aborted++);
        return new Promise(res => { release = () => res(good(url, o)); });
      }
      return good(url, o);
    };
    const first = X.Sync.cycle();
    await sleep(30);
    X.Sync.cycle({ push: true });                     // ikinci kick
    await sleep(30);
    assert.strictEqual(aborted, 0);
    release(); await first;
    assert.strictEqual(await X.Services.outboxCount(), 0);
    assert.strictEqual(b.rows('Products').filter(r => r[1] === 'Yazi').length, 1);
  });

  await t('Admin PIN-i unudulubsa: Apps Script-də resetAdminPin() müvəqqəti PIN yaradır, bütün cihazlar alır', async () => {
    const b = makeBackend({ token: TOKEN });
    const D1 = await boot(b), D2 = await boot(b);
    await loginAs(D1, 'Admin', '1234'); await D1.Services.changePin('1234', '5821'); await D1.Sync.cycle(); await D2.Sync.cycle();
    await loginAs(D2, 'Admin', '5821');                              // hər iki cihazda Admin PIN-i 5821
    const pin = b.sandbox.resetAdminPin();
    assert.ok(/^\d{6}$/.test(pin));
    assert.ok(b.logs.some(l => l.includes(pin)));
    await D2.Sync.cycle();
    await rejects(loginAs(D2, 'Admin', '5821'), /PIN səhvdir/);
    const u = await loginAs(D2, 'Admin', pin);
    assert.strictEqual(u.mustChangePin, true);
    await D1.Sync.cycle();
    assert.strictEqual((await loginAs(D1, 'Admin', pin)).role, 'admin');
    const row = b.rows('Users').find(r => r[0] === 'u_admin');
    assert.strictEqual(row[4], true);
    assert.ok(!b.rows('Audit').some(r => /pinHash|"salt"/.test(r[3])), 'Audit-də hash olmamalıdır');
    assert.ok(b.rows('Events').some(r => r[2] === 'user.upserted' && /break_glass/.test(r[5])));
  });

  await t('server keşi: yazan sorğu onu düzgün təyin edir; köhnəlmiş (aşağı) keş başqa cihazın sorğusu ilə düzəlir', async () => {
    const b = makeBackend({ token: TOKEN });
    const X = await boot(b);
    await loginAs(X, 'Menecer', '2222'); await X.Services.createProduct({ name: 'Keş', price: 100 }); await X.Sync.cycle();
    const total = b.rows('Events').length;
    assert.strictEqual(Number(b.store.cache.evTotal), total);
    const poll = (since, device) => b.post({ action: 'sync', token: TOKEN, device: device, since: since, items: [], limit: 500 });
    b.store.cache.evTotal = String(total - 2);                       // yarış nəticəsində köhnəlmiş dəyər
    assert.strictEqual(poll(total - 2, 'z1').events.length, 0, 'köhnəlmiş keş yenilik görməyə mane olur (TTL 90 san və ya başqa sorğu düzəldir)');
    assert.strictEqual(poll(0, 'z2').events.length, total);          // başqa cihaz tam yoxlama aparır → keş yuxarı düzəlir
    assert.strictEqual(Number(b.store.cache.evTotal), total);
    assert.strictEqual(poll(total - 2, 'z1').events.length, 2, 'ilişmiş cihaz yeniliyi alır');
    b.store.cache.evTotal = String(total + 50);                      // oxuyan sorğu keşi AŞAĞI salmır
    poll(0, 'z3');
    assert.strictEqual(Number(b.store.cache.evTotal), total + 50);
  });

  await t('Apps Script v4: iki cihaz eyni anda qoşulur → aralıqlar fərqlidir və kəsişmir', async () => {
    const b = makeBackend({ token: TOKEN });
    const [X, Y] = await Promise.all([boot(b), boot(b)]);
    const rx = (await X.DB.get('meta', 'block:productSeq')).value.ranges[0], ry = (await Y.DB.get('meta', 'block:productSeq')).value.ranges[0];
    assert.ok(rx[1] < ry[0] || ry[1] < rx[0], JSON.stringify([rx, ry]));
  });

  await t('istifadəçi idarəsi iki cihazda: yaranır, adı/rolu dəyişir, söndürülür — açıq sessiya düzəlir', async () => {
    const b = makeBackend({ token: TOKEN });
    const [X, Y] = await Promise.all([boot(b), boot(b)]);
    await loginAs(X, 'Admin', '1234');
    const r = await X.Services.createUser({ name: 'Elvin Babayev', role: 'kassir' });
    await X.Sync.cycle(); await Y.Sync.cycle();
    assert.ok((await Y.Services.listUsers()).some(u => u.name === 'Elvin Babayev' && u.role === 'kassir'), 'yeni istifadəçi Y-yə çatmadı');
    const row = b.rows('Users').find(x => x[1] === 'Elvin Babayev');
    assert.ok(row && row[2] === 'kassir' && row[3] === true && row[4] === true, 'Users vərəqində: ' + JSON.stringify(row));
    // Y-də Elvin müvəqqəti PIN ilə girir və öz PIN-ini seçir
    await Y.Services.login(r.user.id, r.tempPin);
    await Y.Services.changePin(r.tempPin, '4817');
    await Y.Sync.cycle(); await X.Sync.cycle();
    // X: ad və rol dəyişir
    await X.Services.updateUser(r.user.id, { name: 'Elvin Babayev (kassa 2)', role: 'menecer' });
    await X.Sync.cycle(); await Y.Sync.cycle();
    assert.strictEqual(await Y.Services.refreshSession(), 'changed');
    assert.strictEqual(Y.Services.currentUser().role, 'menecer');
    assert.strictEqual(Y.Services.currentUser().name, 'Elvin Babayev (kassa 2)');
    assert.ok(b.rows('Users').some(x => x[1] === 'Elvin Babayev (kassa 2)' && x[2] === 'menecer'));
    // PIN dəyişikliyi (Y) ilə rol dəyişikliyi (X) — hər ikisi sağ qalmalıdır: son yazan bütün sətri götürdüyü üçün yeni PIN də rol da saxlanmalıdır
    // X: söndürür
    await X.Services.updateUser(r.user.id, { active: false });
    await X.Sync.cycle(); await Y.Sync.cycle();
    assert.strictEqual(await Y.Services.refreshSession(), 'gone');
    await rejects(Y.Services.requirePerm('pos.sell'), /söndürülüb/);
    assert.ok(!(await Y.Services.listUsers()).some(u => u.id === r.user.id));
    assert.strictEqual(b.rows('Users').find(x => x[0] === r.user.id)[3], false);
    // yenidən aktiv — köhnə PIN işləyir
    await X.Services.updateUser(r.user.id, { active: true });
    await X.Sync.cycle(); await Y.Sync.cycle();
    const u = await Y.Services.login(r.user.id, '4817');
    assert.strictEqual(u.mustChangePin, false);
    assert.strictEqual(u.role, 'menecer');
  });

  /* ---------- Təchizatçılar və FIFO: iki cihazda eyni nəticə ---------- */
  const repKey = r => JSON.stringify(r.rows.map(x => [x.name, x.soldQty, x.returnedQty, x.revenue, x.cost, x.onHandQty, x.products.map(p => [p.name, p.qty, p.revenue])]));
  const mgr = (d) => loginAs(d, 'Menecer', '2222');

  await t('təchizatçı və partiya iki cihaza çatır; sətirlər Suppliers/StockReceipts vərəqlərinə düşür; FIFO hesabatı iki cihazda eynidir', async () => {
    const b = makeBackend({ token: TOKEN });
    const [X, Y] = await Promise.all([boot(b), boot(b)]);
    await mgr(X); await mgr(Y);
    const alfa = await X.Services.createSupplier({ name: 'Alfa MMC', phone: '+994501112233' });
    const beta = await X.Services.createSupplier({ name: 'Beta Toys' });
    const pr = (await X.Services.createProduct({ name: 'Maşın', price: 1000, cost: 100 })).product;
    await X.Services.receiveStock(pr.id, 5, 100, 'q1', alfa.id);
    await X.Services.receiveStock(pr.id, 5, 120, 'q2', beta.id);
    await X.Sync.cycle(); await Y.Sync.cycle();
    assert.strictEqual(JSON.stringify((await Y.Services.listSuppliers()).map(s => s.name).sort()), JSON.stringify(['Alfa MMC', 'Beta Toys']));
    assert.strictEqual((await Y.Services.productLots(pr.id)).length, 2);
    assert.ok(b.rows('Suppliers').some(r => r[1] === 'Alfa MMC' && r[2] === '+994501112233'), 'Suppliers vərəqi: ' + JSON.stringify(b.rows('Suppliers')));
    const sr = b.rows('StockReceipts').filter(r => r[1] === pr.id);
    assert.strictEqual(sr.length, 2); assert.ok(sr.every(r => r[5] && r[6]), 'təchizatçı və partiya id-si yazılıb');
    // Y satış edir (açıq növbə lazımdır)
    await Y.Services.openShift(1000);
    await Y.Services.checkout([{ productId: pr.id, qty: 7 }], null, { method: 'cash', cashReceived: 7000 });
    await Y.Sync.cycle(); await X.Sync.cycle();
    const rx = await X.Services.supplierReport({}), ry = await Y.Services.supplierReport({});
    assert.strictEqual(repKey(rx), repKey(ry), 'iki cihazda hesabat fərqlənir');
    assert.strictEqual(rx.rows.find(r => r.name === 'Alfa MMC').soldQty, 5);
    assert.strictEqual(rx.rows.find(r => r.name === 'Beta Toys').soldQty, 2);
    assert.strictEqual(Number((await X.Services.listProducts()).find(p => p.id === pr.id).stock), 3);
  });

  await t('eyni anda iki cihaz eyni məhsulu müxtəlif təchizatçıdan qəbul edir; sonra satış — hesabat hər yerdə eyni, qalıq cəmi düzgün', async () => {
    const b = makeBackend({ token: TOKEN });
    const [X, Y] = await Promise.all([boot(b), boot(b)]);
    await mgr(X); await mgr(Y);
    const s1 = await X.Services.createSupplier({ name: 'Təchizatçı 1' });
    const s2 = await X.Services.createSupplier({ name: 'Təchizatçı 2' });
    const pr = (await X.Services.createProduct({ name: 'Kukla', price: 2000, cost: 500 })).product;
    await X.Sync.cycle(); await Y.Sync.cycle();
    await Promise.all([X.Services.receiveStock(pr.id, 4, 500, '', s1.id), Y.Services.receiveStock(pr.id, 6, 600, '', s2.id)]);
    await X.Sync.cycle(); await Y.Sync.cycle(); await X.Sync.cycle();
    await X.Services.openShift(0);
    await X.Services.checkout([{ productId: pr.id, qty: 3 }], null, { method: 'cash', cashReceived: 6000 });
    await X.Sync.cycle(); await Y.Sync.cycle();
    const rx = await X.Services.supplierReport({}), ry = await Y.Services.supplierReport({});
    assert.strictEqual(repKey(rx), repKey(ry));
    const lots = await X.Services.productLots(pr.id);
    assert.strictEqual(lots.reduce((n, l) => n + l.remaining, 0), 7);
    assert.strictEqual(rx.totals.soldQty, 3);
    assert.strictEqual(rx.totals.onHandQty, 7);
  });

  await t('təchizatçı eyni anda dəyişdirilir: ad (X) və söndürmə (Y) — son yazan qalib gəlir, iki cihaz eyni vəziyyətə gəlir', async () => {
    const b = makeBackend({ token: TOKEN });
    const [X, Y] = await Promise.all([boot(b), boot(b)]);
    await mgr(X); await mgr(Y);
    const sp = await X.Services.createSupplier({ name: 'Sinaq' });
    await X.Sync.cycle(); await Y.Sync.cycle();
    await X.Services.updateSupplier(sp.id, { name: 'Sinaq 2' });
    await sleep(5);                                   // eyni millisaniyə bərabərliyi ayrıca hal: orada cihazlar məzmunla həll edir, vərəq isə birinci gələni saxlayır (real istifadədə mümkün deyil)
    await Y.Services.updateSupplier(sp.id, { active: false });
    for (let i = 0; i < 2; i++) { await X.Sync.cycle(); await Y.Sync.cycle(); }
    const gx = (await X.Services.listSuppliers({ all: true })).find(s => s.id === sp.id), gy = (await Y.Services.listSuppliers({ all: true })).find(s => s.id === sp.id);
    assert.deepStrictEqual([gx.name, gx.active], [gy.name, gy.active]);
    const row = b.rows('Suppliers').filter(r => r[0] === sp.id);
    assert.strictEqual(row.length, 1, 'bir id — bir sətir');
    assert.strictEqual(row[0][1], gx.name);
  });

  await t('köhnə versiyalı cihaz (partiya/təchizatçı hadisələrini buraxıb) yenilənəndə bir dəfəlik doldurma alır; qalıq ikiqat artmır', async () => {
    const b = makeBackend({ token: TOKEN });
    const X = await boot(b), Z = await boot(b);
    await mgr(X); await mgr(Z);
    const sp = await X.Services.createSupplier({ name: 'Köhnə təchizatçı' });
    const pr = (await X.Services.createProduct({ name: 'Top', price: 300, cost: 100 })).product;
    await X.Services.receiveStock(pr.id, 8, 100, '', sp.id);
    await X.Sync.cycle(); await Z.Sync.cycle();
    const stockBefore = (await Z.Services.listProducts()).find(p => p.id === pr.id).stock;
    // Z-ni "köhnə versiya" vəziyyətinə salırıq: təchizatçı/partiya yoxdur, sxem 3, imleç serverin sonundadır
    for (const l of await Z.DB.getAll('lots')) await Z.DB.del('lots', l.id);
    for (const s of await Z.DB.getAll('suppliers')) await Z.DB.del('suppliers', s.id);
    const cur = (await Z.DB.get('meta', 'syncCursor')).value;
    await Z.DB.put('meta', { key: 'schema', value: 3 });
    await Z.DB.put('meta', { key: 'backfill', value: { upTo: cur, next: 0, done: false } });
    assert.strictEqual((await Z.Services.productLots(pr.id)).length, 1, 'doldurmadan əvvəl yalnız açılış partiyası');
    await Z.Sync.cycle();
    const lots = await Z.Services.productLots(pr.id);
    assert.strictEqual(JSON.stringify(lots.map(l => [l.supplier, l.qty, l.remaining])), JSON.stringify([['Köhnə təchizatçı', 8, 8]]));
    assert.strictEqual((await Z.DB.get('meta', 'backfill')).value.done, true);
    assert.strictEqual((await Z.Services.listProducts()).find(p => p.id === pr.id).stock, stockBefore, 'doldurma qalığa toxunmamalıdır');
    assert.strictEqual(repKey(await Z.Services.supplierReport({})), repKey(await X.Services.supplierReport({})));
    // ikinci dövr heç nəyi dəyişmir
    await Z.Sync.cycle();
    assert.strictEqual((await Z.DB.getAll('lots')).length, 1);
  });

  await t('köhnə cihazdan gələn qəbul (partiya id-si yoxdur) sistemi pozmur: qalıq "açılış partiyası"nda sayılır', async () => {
    const b = makeBackend({ token: TOKEN });
    const X = await boot(b), Y = await boot(b);
    await mgr(X); await mgr(Y);
    const pr = (await X.Services.createProduct({ name: 'Köhnə qəbul', price: 500, cost: 100 })).product;
    await X.Sync.cycle(); await Y.Sync.cycle();
    // köhnə versiyanın göndərdiyi hadisə: supplierId/lotId yoxdur
    const prod = (await Y.Services.listProducts()).find(p => p.id === pr.id);
    const ev = { id: 'ev_old1', type: 'stock.received', at: new Date().toISOString(), userId: 'u_menecer', data: { productId: pr.id, qty: 6, unitCost: 100, note: 'köhnə cihaz' } };
    const res = b.post({ action: 'sync', token: TOKEN, device: 'legacy', since: 0, items: [{ id: ev.id, type: ev.type, at: ev.at, userId: ev.userId, device: 'legacy', data: ev.data }], limit: 500 });
    assert.ok(res && !res.error, JSON.stringify(res));
    await X.Sync.cycle(); await Y.Sync.cycle();
    assert.strictEqual((await X.Services.listProducts()).find(p => p.id === pr.id).stock, 6);
    const lots = await Y.Services.productLots(pr.id);
    assert.strictEqual(lots.reduce((n, l) => n + l.remaining, 0), 6);
    assert.ok(lots.every(l => l.opening), 'partiyası olmayan qəbul açılış partiyası sayılır');
    assert.strictEqual(repKey(await X.Services.supplierReport({})), repKey(await Y.Services.supplierReport({})));
    void prod;
  });

  await t('iki cihaz eyni çekin eyni sətrini oflayn qaytarır: qalıq/hesabat uzlaşır, artıq hissə xəbərdarlıqla göstərilir', async () => {
    const b = makeBackend({ token: TOKEN });
    const [X, Y] = await Promise.all([boot(b), boot(b)]);
    await mgr(X); await mgr(Y);
    const sp = await X.Services.createSupplier({ name: 'Artıq təch' });
    const pr = (await X.Services.createProduct({ name: 'Artıq qayt', price: 1000, cost: 100 })).product;
    await X.Services.receiveStock(pr.id, 5, 100, '', sp.id);
    await X.Services.openShift(0);
    const sale = await X.Services.checkout([{ productId: pr.id, qty: 2 }], null, { method: 'cash', cashReceived: 2000 });
    await X.Sync.cycle(); await Y.Sync.cycle();
    const me = u => u.Services.currentUser();
    await X.Services.createReturn(sale.id, [{ lineIndex: 0, qty: 2 }], me(X));
    await Y.Services.openShift(0).catch(() => {});
    await Y.Services.createReturn(sale.id, [{ lineIndex: 0, qty: 2 }], me(Y));       // Y hələ X-in qaytarmasını görməyib
    for (let i = 0; i < 2; i++) { await X.Sync.cycle(); await Y.Sync.cycle(); }
    const rx = await X.Services.supplierReport({}), ry = await Y.Services.supplierReport({});
    assert.strictEqual(repKey(rx), repKey(ry));
    assert.strictEqual(rx.excessReturnQty, 2, 'artıq qaytarma bilinməlidir');
    const stock = (await X.Services.listProducts()).find(p => p.id === pr.id).stock;
    assert.strictEqual(stock, 7);
    assert.strictEqual((await X.Services.productLots(pr.id)).reduce((n, l) => n + l.remaining, 0), stock, 'partiya qalığı = məhsul qalığı');
  });

  await t('təsdiq sorğusu uçdan-uca: kassir cihazı sorğu göndərir → server menecerin cihazına push göndərir (kassirin özünə yox)', async () => {
    const b = makeBackend({ token: TOKEN });
    const [K, M] = await Promise.all([boot(b), boot(b)]);                     // kassa və menecer cihazları
    await loginAs(M, 'Menecer', '2222');
    const key = (await M.Sync.api('push.key')).key;
    assert.ok(key && key.length > 60);
    await M.Sync.api('push.register', { endpoint: 'https://fcm.googleapis.com/fcm/send/mgr-1', userId: 'u_menecer', userName: 'Menecer', role: 'menecer', perms: ['pos.line.delete', 'pos.discount.approve'] });
    await K.Sync.api('push.register', { endpoint: 'https://fcm.googleapis.com/fcm/send/kassa-1', userId: 'u_kassir', userName: 'Kassir', role: 'kassir', perms: ['pos.sell'] });
    K.Services._session.user = { id: 'u_kassir', name: 'Kassir', role: 'kassir' };     // kassir sınaq PIN-i əvvəlki testlərdə dəyişə bilər: sessiyanı birbaşa quraq
    await K.Services.requestApproval('line_delete', 'pos.line.delete', 'Kassir sətir silmək istəyir: Ayı');
    await K.Sync.cycle();
    assert.strictEqual(JSON.stringify(b.pushLog.map(x => x.url)), JSON.stringify(['https://fcm.googleapis.com/fcm/send/mgr-1']));
    assert.ok(/^vapid t=.+, k=.+$/.test(b.pushLog[0].headers.Authorization));
    await M.Sync.cycle();
    assert.strictEqual((await M.Services.listPendingApprovals()).length, 1);   // menecer cihazında sorğu görünür
  });

  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
