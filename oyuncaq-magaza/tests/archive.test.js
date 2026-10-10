/* node tests/archive.test.js — Google Sheets 10 milyon xana həddinə qarşı arxivləşdirmə (Code.gs v7).
   A hissəsi: xam server sorğuları (2500 hadisə, köhnə kursor, soyuq cihaz, yarımçıq qalma bərpası, xəta anında heç nə itmir).
   B hissəsi: real "brauzerlər" (Services + Sync): arxivdən sonra qoşulan yeni cihaz və arxivdən geridə qalan cihaz eyni vəziyyəti alır.
   Backend: tests/gas-mock.js (Code.gs-in özü; Sheets-in şəbəkə ölçüsü və xana sayı təqlid olunur). */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const TOKEN = 't';
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const pad = n => String(n).padStart(6, '0');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); }
}

/* ---------- xam sorğular ---------- */
const post = (be, body) => be.post(Object.assign({ token: TOKEN }, body));
const ask = (be, since, device, limit) => post(be, { action: 'sync', since, device: device || 'raw-reader', limit: limit || 500 });

function saleEv(i, atMs) {
  const at = iso(atMs);
  const lines = [0, 1].map(k => ({ productId: 'p' + k, name: 'Oyuncaq ' + k, storeBarcode: '20000000000' + k, qty: 1, price: 500, unitCost: 300, negative: false }));
  const sale = {
    id: 'sale' + pad(i), receiptNo: 1000 + i, at, shiftId: 'sh1', cashierId: 'u1', cashierName: 'Kassir',
    totals: { subtotal: 1000, discount: 0, total: 1000 }, payment: { method: 'cash', cashPart: 1000, bankPart: 0, cashReceived: 1000, change: 0 },
    discount: null, offline: false, fiscal: { id: '', status: 'none' }, lines
  };
  return { id: 'ev' + pad(i), at, type: 'sale.created', userId: 'u1', device: 'raw-writer', data: { sale } };
}
function noteEv(i, atMs) { return { id: 'ev' + pad(i), at: iso(atMs), type: 'note.added', userId: 'u1', device: 'raw-writer', data: { n: i } }; }
const salesIn = k => Math.ceil(k / 4);          // hadisə i % 4 === 0 → satış, qalanı qeyd
const notesIn = k => k - salesIn(k);

// n hadisə yazır (hər dördüncüsü 2 sətirli satış); id-lərin siyahısını qaytarır
function fill(be, n, from) {
  const ids = [], t0 = Date.now();
  for (let s = from || 0; s < (from || 0) + n; s += 300) {
    const items = [];
    for (let i = s; i < Math.min(s + 300, (from || 0) + n); i++) items.push(i % 4 === 0 ? saleEv(i, t0 + i) : noteEv(i, t0 + i));
    const r = post(be, { action: 'sync', items, since: 0, device: 'raw-writer', limit: 1 });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.acked.length, items.length);
    items.forEach(x => ids.push(x.id));
  }
  return ids;
}
// İlk K hadisənin qəbul vaxtını (və onlara aid satış/jurnal sətirlərini) 100 gün geri çəkir
function age(be, K) {
  const old = iso(Date.now() - 100 * DAY), sh = be.store.sheets;
  for (let i = 1; i <= K; i++) sh.Events.rows[i][4] = old;
  for (let i = 1; i <= salesIn(K); i++) sh.Sales.rows[i][2] = old;
  for (let i = 1; i <= notesIn(K); i++) sh.Audit.rows[i][0] = old;
}
// Kiçik testlər üçün: son 20 hadisə canlı qalır, 10 hadisədən az kəsilmir
function small(be) { be.sandbox.SEEN_WINDOW = 20; be.sandbox.ARCHIVE_MIN_CUT = 10; }
function pullAll(be, since, device, limit) {
  const out = []; let cur = since, guard = 0, pages = 0;
  for (;;) {
    const r = ask(be, cur, device, limit);
    assert.ok(r.ok, r.error);
    r.events.forEach(e => out.push(e));
    pages++;
    if (r.next === cur && !r.more) break;
    cur = r.next;
    if (!r.more) break;
    if (++guard > 100) throw new Error('sonsuz dövr');
  }
  return { events: out, next: cur, pages };
}
const state = be => JSON.parse(be.store.props.ARCHIVE || '{}');

/* ---------- real cihaz (sync.test.js ilə eyni qaydada) ---------- */
const URL_OK = 'https://script.google.com/macros/s/AKfycbTEST/exec';
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
  const r = await d.Sync.connect(URL_OK, TOKEN); assert.ok(!r.error, r.error);
  return d;
}
async function loginAs(d, name, pin) {
  const u = (await d.Services.listUsers()).find(x => x.name === name);
  return d.Services.login(u.id, pin);
}
// Cihazın görünən vəziyyəti: müqayisə üçün
async function snapshot(d) {
  const prods = (await d.Services.listProducts()).map(p => [p.name, p.price, p.stock, p.avgCost, p.storeBarcode]).sort();
  const sales = (await d.Services.recentSales(500)).map(s => [s.receiptNo, s.totals.total]).sort();
  // yalnız PIN-i dəyişdirilmiş istifadəçilər: sınaq istifadəçilərinin (eyni vaxt möhürlü) təsadüfi duzları cihazlar bir-birinin hadisəsini alanadək fərqli ola bilər, bu arxivə aid deyil
  const users = (await d.DB.getAll('users')).filter(u => u.id === 'u_admin' || u.id === 'u_menecer').map(u => [u.id, u.role, u.pinHash]).sort();
  const m = await d.Services.getMatrix();
  return JSON.stringify({ prods, sales, users, kassir: [...m.kassir].sort(), store: (await d.Services.storeInfo()).name });
}

(async () => {
  /* ======================= A. xam server ======================= */
  const be = makeBackend({ token: TOKEN });
  const startCells = be.grid();
  let ids = [], cellsBefore = 0, run1, seg1;

  await t('başlanğıc: boş sütun və sətirlər kəsilib (26 sütunluq vərəq yoxdur), xana sayı ~40 min', async () => {
    assert.ok(startCells < 45000, 'xana sayı: ' + startCells);
    Object.keys(be.store.sheets).forEach(n => assert.ok(be.store.sheets[n].maxCols <= 20, n + ' sütun: ' + be.store.sheets[n].maxCols));
  });

  await t('2500 hadisə (625 satış): şəbəkə 1000 sətri keçir, xəta yoxdur, hamısı yazılır', async () => {
    ids = fill(be, 2500);
    assert.strictEqual(be.rows('Events').length, 2500);
    assert.strictEqual(be.rows('Sales').length, 625);
    assert.strictEqual(be.rows('SaleLines').length, 1250);
    assert.strictEqual(be.rows('Audit').length, notesIn(2500));
    cellsBefore = be.grid();
    // məlumat üçün: bir satışın şəbəkədə tutduğu xana (docs-dakı tutum hesabı bundan götürülüb)
    console.log('  (məlumat) 625 satış sonrası xana: ' + cellsBefore + ' (limitin ' + (cellsBefore / 1e5).toFixed(2) + '%), satışa ~' + Math.round((cellsBefore - startCells) / 625) + ' xana');
  });

  await t('status: əsas 0, canlı 2500, arxiv yoxdur, version 7', async () => {
    const s = post(be, { action: 'archive.status' });
    assert.ok(s.ok); assert.strictEqual(s.version, 7);
    assert.strictEqual(s.base, 0); assert.strictEqual(s.live, 2500); assert.strictEqual(s.total, 2500);
    assert.strictEqual(s.cells, cellsBefore); assert.strictEqual(s.limit, 10000000); assert.deepStrictEqual(s.segs, []);
    assert.strictEqual(s.last, '');
  });

  await t('təsdiq olmadan arxivləşdirmə rədd olunur, heç nə dəyişmir', async () => {
    const r = post(be, { action: 'archive.run' });
    assert.strictEqual(r.ok, false); assert.match(r.error, /Təsdiq/);
    assert.strictEqual(be.rows('Events').length, 2500);
    assert.deepStrictEqual(state(be), {});
  });

  await t('hamısı təzədirsə arxivləşdirmə "dəyməz" deyir və heç nə silmir (fayl da yaranmır)', async () => {
    const before = Object.keys(be.store.spreadsheets).length;
    const r = post(be, { action: 'archive.run', confirm: 'ARXIV' });
    assert.ok(r.ok); assert.strictEqual(r.archived, false); assert.match(r.reason, /köhnə qeyd yoxdur/);
    assert.strictEqual(Object.keys(be.store.spreadsheets).length, before);
    assert.strictEqual(be.rows('Events').length, 2500);
  });

  // soyuq cihaz üçün arxivdən ƏVVƏLKİ tam görüntü
  let fullBefore;
  await t('arxivdən əvvəl: yeni cihaz bütün 2500 hadisəni ardıcıl nömrə ilə alır', async () => {
    fullBefore = pullAll(be, 0, 'cold-1');
    assert.strictEqual(fullBefore.events.length, 2500);
    assert.deepStrictEqual(fullBefore.events.map(e => e.seq), ids.map((_, i) => i + 1));
    assert.deepStrictEqual(fullBefore.events.map(e => e.id), ids);
    assert.strictEqual(fullBefore.next, 2500);
  });

  await t('2000 hadisə 100 gün köhnədir: yalnız 1000-i köçürülür (son 1500 hadisə həmişə canlı qalır)', async () => {
    age(be, 2000);
    run1 = post(be, { action: 'archive.run', confirm: 'ARXIV' });
    assert.ok(run1.ok, run1.error); assert.strictEqual(run1.archived, true);
    assert.strictEqual(run1.removed.Events, 1000);
    assert.strictEqual(run1.removed.Sales, 500);          // vaxta görə: bütün köhnə satışlar
    assert.strictEqual(run1.removed.SaleLines, 1000);     // satışa tabe
    assert.strictEqual(run1.removed.Audit, notesIn(2000));
    assert.deepStrictEqual(run1.warnings, []);
    assert.strictEqual(run1.base, 1000); assert.strictEqual(run1.live, 1500);
  });

  await t('arxiv faylı: Drive-da yeni fayl, bütün 2500 hadisə, 625 satış və 1250 sətir (silinənlər də)', async () => {
    seg1 = be.store.spreadsheets[run1.id];
    assert.ok(seg1, 'fayl yaranmayıb');
    assert.match(seg1.getName(), /Arxiv/);
    assert.strictEqual(seg1.getSheetByName('Events').getLastRow() - 1, 2500);
    assert.strictEqual(seg1.getSheetByName('Sales').getLastRow() - 1, 625);
    assert.strictEqual(seg1.getSheetByName('SaleLines').getLastRow() - 1, 1250);
    assert.ok(/^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(run1.url));
  });

  await t('canlı cədvəl: Events 1500 sətir (ilk sətir mütləq #1000), Sales/SaleLines uyğun kəsilib', async () => {
    const live = be.rows('Events');
    assert.strictEqual(live.length, 1500);
    assert.strictEqual(live[0][0], ids[1000]); assert.strictEqual(live[1499][0], ids[2499]);
    assert.strictEqual(be.rows('Sales').length, 625 - 500);
    assert.strictEqual(be.rows('SaleLines').length, 2 * (625 - 500));
    const liveSales = new Set(be.rows('Sales').map(r => r[0]));
    be.rows('SaleLines').forEach(r => assert.ok(liveSales.has(r[0]), 'sahibsiz sətir: ' + r[0]));   // yetim sətir qalmayıb
    assert.strictEqual(be.rows('Audit').length, notesIn(2500) - notesIn(2000) + 1);                  // +1: server.archive qeydi
    assert.ok(be.rows('Audit').some(r => r[1] === 'server.archive'));
  });

  await t('Sheets xana sayı azalır (boş şəbəkə də kəsilir)', async () => {
    const after = be.grid();
    assert.ok(after < cellsBefore * 0.8, 'əvvəl ' + cellsBefore + ', sonra ' + after);
    assert.strictEqual(run1.cells, after);
    const s = post(be, { action: 'archive.status' });
    assert.strictEqual(s.base, 1000); assert.strictEqual(s.live, 1500); assert.strictEqual(s.total, 2500);
    assert.strictEqual(s.segs.length, 1);
    assert.deepStrictEqual([s.segs[0].from, s.segs[0].to, s.segs[0].moved, s.segs[0].id], [0, 2500, 1000, run1.id]);
    assert.ok(s.last && s.nextAt > s.last);
  });

  await t('mövcud cihaz (kursor 2500) arxivləşdirmədən xəbərsiz işləyir: yenilik yoxdur, yenisini yazır, digər cihaz alır', async () => {
    const same = ask(be, 2500, 'dev-1');
    assert.ok(same.ok); assert.deepStrictEqual(same.events, []); assert.strictEqual(same.next, 2500); assert.strictEqual(same.more, false);
    const w = post(be, { action: 'sync', since: 2500, device: 'dev-1', items: [noteEv(2500, Date.now())] });
    assert.ok(w.ok, w.error); assert.deepStrictEqual(w.acked, ['ev' + pad(2500)]); assert.strictEqual(w.next, 2501);
    const other = ask(be, 2500, 'dev-2');
    assert.strictEqual(other.events.length, 1); assert.strictEqual(other.events[0].seq, 2501); assert.strictEqual(other.events[0].id, 'ev' + pad(2500));
    ids.push('ev' + pad(2500));
  });

  await t('arxivdən geridə qalan cihaz (kursor 300): hadisələri arxiv faylından, sonra canlıdan oxuyur — boşluq və təkrar yoxdur', async () => {
    const r = pullAll(be, 300, 'dev-late');
    assert.strictEqual(r.events.length, 2501 - 300);
    assert.deepStrictEqual(r.events.map(e => e.seq), ids.slice(300).map((_, i) => 301 + i));
    assert.deepStrictEqual(r.events.map(e => e.id), ids.slice(300));
    assert.ok(r.pages >= 4, 'səhifə sayı ' + r.pages);
    assert.strictEqual(r.next, 2501);
  });

  await t('soyuq cihaz (kursor 0): arxivdən əvvəlki ilə eyni hadisələr, eyni sıra və məzmun', async () => {
    const r = pullAll(be, 0, 'cold-2');
    assert.strictEqual(r.events.length, 2501);
    assert.deepStrictEqual(r.events.map(e => e.id), ids);
    assert.deepStrictEqual(r.events.slice(0, 2500).map(e => JSON.stringify([e.type, e.data])), fullBefore.events.map(e => JSON.stringify([e.type, e.data])));
  });

  await t('kursor tam sərhəddədir (999, 1000, 1001): ardıcıl və təkrarsız', async () => {
    for (const s of [999, 1000, 1001]) {
      const r = pullAll(be, s, 'edge-' + s);
      assert.deepStrictEqual(r.events.map(e => e.seq), ids.slice(s).map((_, i) => s + 1 + i), 'since=' + s);
    }
  });

  await t('təkrar göndərmə: canlı pəncərədəki hadisə təkrar yazılmır (arxivdən sonra da)', async () => {
    const before = be.rows('Events').length;
    const r = post(be, { action: 'sync', since: 2501, device: 'dev-1', items: [noteEv(1200, Date.now()), noteEv(2500, Date.now()), saleEv(2400, Date.now())] });
    assert.ok(r.ok); assert.strictEqual(r.acked.length, 3);
    assert.strictEqual(be.rows('Events').length, before);
    assert.strictEqual(post(be, { action: 'archive.status' }).total, 2501);
  });

  await t('2-ci arxivləşdirmə 24 saat dolmamış rədd olunur, heç nə dəyişmir', async () => {
    const r = post(be, { action: 'archive.run', confirm: 'ARXIV' });
    assert.strictEqual(r.ok, false); assert.match(r.error, /24 saat/);
    assert.strictEqual(be.rows('Events').length, 1501);
  });

  await t('növbəti arxivləşdirmə (24 saatdan sonra): 2-ci seqment əlavə olunur, hər kursor üçün tarixçə hələ də ardıcıldır', async () => {
    const st = state(be);
    st.last = iso(Date.now() - 2 * DAY); be.store.props.ARCHIVE = JSON.stringify(st);      // son arxiv 2 gün əvvəl olub
    be.sandbox.SEEN_WINDOW = 800;                                                          // canlıda ilk 1000 sətir (mütləq #1000…#1999) köhnədir → 701 köçürülür
    const r = post(be, { action: 'archive.run', confirm: 'ARXIV' });
    assert.ok(r.ok, r.error); assert.strictEqual(r.archived, true); assert.strictEqual(r.removed.Events, 701);
    assert.strictEqual(r.base, 1701);
    be.sandbox.SEEN_WINDOW = 1500;
    const s = post(be, { action: 'archive.status' });
    assert.strictEqual(s.segs.length, 2); assert.strictEqual(s.total, 2501); assert.strictEqual(s.live, 800);
    assert.deepStrictEqual([s.segs[1].from, s.segs[1].to, s.segs[1].moved], [1000, 2501, 701]);
    for (const c of [0, 500, 999, 1000, 1001, 1700, 1701, 2000, 2500]) {
      const p = pullAll(be, c, 'seg-' + c);
      assert.deepStrictEqual(p.events.map(e => e.id), ids.slice(c), 'since=' + c);
    }
  });

  await t('oxuma zamanı arxivləşdirmə başlasa nəticə atılır ("gözləyin"), cihaz kursoru dəyişmir', async () => {
    const orig = be.sandbox.archState; let n = 0;
    be.sandbox.archState = function () { const s = orig(); if (++n === 2) s.base += 1; return s; };
    try {
      const r = ask(be, 100, 'racer');
      assert.strictEqual(r.ok, false); assert.match(r.error, /Arxivləşdirmə gedir/);
    } finally { be.sandbox.archState = orig; }
    const ok = ask(be, 100, 'racer'); assert.ok(ok.ok);
  });

  /* ---- çek nömrəsi ---- */
  await t('bütün satışlar arxivə getsə də yeni çek nömrəsi köhnələrlə toqquşmur', async () => {
    const b = makeBackend({ token: TOKEN }); small(b);
    fill(b, 300);                                    // 75 satış: nömrələr 1000…1296
    age(b, 300);
    const r = post(b, { action: 'archive.run', confirm: 'ARXIV' });
    assert.ok(r.ok, r.error); assert.strictEqual(r.removed.Sales, 75);
    assert.strictEqual(b.rows('Sales').length, 0);
    const a = post(b, { action: 'allocate', key: 'receiptSeq', count: 10 });
    assert.ok(a.ok); assert.strictEqual(a.from, 1297);     // 1296 (ən böyük arxivlənmiş) + 1
    const st = post(b, { action: 'sync', since: 0, device: 'x', alloc: [{ key: 'receiptSeq', count: 5 }], items: [] });
    assert.ok(st.blocks[0].from > 1306);
  });

  /* ---- xəta və yarımçıq qalma ---- */
  await t('nüsxə yaranmasa (copy xətası) heç nə silinmir', async () => {
    const b = makeBackend({ token: TOKEN }); small(b);
    fill(b, 300); age(b, 300);
    b.failCopy = true;
    const r = post(b, { action: 'archive.run', confirm: 'ARXIV' });
    assert.strictEqual(r.ok, false); assert.match(r.error, /copy xətası/);
    assert.strictEqual(b.rows('Events').length, 300); assert.strictEqual(b.rows('Sales').length, 75);
    assert.deepStrictEqual(state(b), {});
    b.failCopy = false;
    assert.ok(post(b, { action: 'archive.run', confirm: 'ARXIV' }).archived);       // sonra yenə cəhd olunur
  });

  await t('nüsxə natamam olsa (sətir sayı uyğun deyil) heç nə silinmir', async () => {
    const b = makeBackend({ token: TOKEN }); small(b);
    fill(b, 300); age(b, 300);
    const orig = b.store.spreadsheets['ss-main'].copy;
    b.store.spreadsheets['ss-main'].copy = function (n) { const c = orig.call(this, n); c.sheets.Sales.rows.length = 10; return c; };
    const r = post(b, { action: 'archive.run', confirm: 'ARXIV' });
    assert.strictEqual(r.ok, false); assert.match(r.error, /nüsxəsi tam deyil/);
    assert.strictEqual(b.rows('Events').length, 300); assert.deepStrictEqual(state(b), {});
  });

  await t('Events-dən silmə xətası: vəziyyət dəyişmir, marker təmizlənir, düzələndən sonra uğurlu olur', async () => {
    const b = makeBackend({ token: TOKEN }); small(b);
    fill(b, 300); age(b, 300);
    b.store.sheets.Events.failOn = 'deleteRows';
    const r = post(b, { action: 'archive.run', confirm: 'ARXIV' });
    assert.strictEqual(r.ok, false); assert.match(r.error, /deleteRows/);
    assert.strictEqual(b.rows('Events').length, 300); assert.strictEqual(state(b).trim, null); assert.strictEqual(state(b).base, 0);
    assert.strictEqual(pullAll(b, 0, 'z').events.length, 300);
    b.store.sheets.Events.failOn = null;
    const ok = post(b, { action: 'archive.run', confirm: 'ARXIV' });
    assert.ok(ok.archived, ok.error); assert.strictEqual(ok.base, 280);
  });

  await t('Sales-dən silmə xətası: Events düzgün qalır, xəbərdarlıq verilir, sinxron işləyir', async () => {
    const b = makeBackend({ token: TOKEN }); small(b);
    const idsB = fill(b, 300); age(b, 300);
    b.store.sheets.Sales.failOn = 'deleteRows';
    const r = post(b, { action: 'archive.run', confirm: 'ARXIV' });
    assert.ok(r.ok && r.archived); assert.ok(r.warnings.some(w => /^Sales/.test(w)));
    assert.strictEqual(b.rows('Sales').length, 75);              // toxunulmayıb: növbəti arxivləşdirmə vaxta görə təmizləyəcək
    assert.deepStrictEqual(pullAll(b, 0, 'z').events.map(e => e.id), idsB);
  });

  async function crashBackend() {
    const b = makeBackend({ token: TOKEN }); small(b);
    const idsB = fill(b, 300);
    const copy = b.store.spreadsheets['ss-main'].copy('arxiv-sınaq');
    const trim = { live: 300, cut: 250, at: iso(Date.now()), maxReceipt: 1296, seg: { i: copy.getId(), f: 0, t: 300, a: iso(Date.now()), n: 250 } };
    b.store.props.ARCHIVE = JSON.stringify({ base: 0, segs: [], last: '', maxReceipt: 0, trim });
    return { b, idsB };
  }
  await t('yarımçıq qalma: sətirlər silinib, vəziyyət yazılmayıb → növbəti sorğu özü tamamlayır', async () => {
    const { b, idsB } = await crashBackend();
    b.store.sheets.Events.deleteRows(2, 250);
    const r = pullAll(b, 0, 'z');                     // oxuyan sorğu belə sağaldır
    assert.deepStrictEqual(r.events.map(e => e.id), idsB);
    const st = state(b);
    assert.strictEqual(st.trim, null); assert.strictEqual(st.base, 250); assert.strictEqual(st.segs.length, 1); assert.strictEqual(st.maxReceipt, 1296);
    // yazan sorğu da işləyir
    const w = post(b, { action: 'sync', since: 300, device: 'z', items: [noteEv(300, Date.now())] });
    assert.ok(w.ok); assert.strictEqual(w.next, 301);
  });
  await t('yarımçıq qalma: marker var, heç nə silinməyib → marker təmizlənir, əsas dəyişmir', async () => {
    const { b, idsB } = await crashBackend();
    const w = post(b, { action: 'sync', since: 0, device: 'z', items: [noteEv(300, Date.now())], limit: 500 });
    assert.ok(w.ok, w.error);
    const st = state(b);
    assert.strictEqual(st.trim, null); assert.strictEqual(st.base, 0); assert.strictEqual(st.segs.length, 0);
    assert.deepStrictEqual(w.events.map(e => e.id), idsB.concat('ev' + pad(300)));      // yazılan hadisənin cihazı 'raw-writer' olduğundan özünə də qayıdır
  });
  await t('yarımçıq qalma: gözlənilməyən sətir sayı → səhv bildirilir, heç nə əl ilə pozulmur', async () => {
    const { b } = await crashBackend();
    b.store.sheets.Events.deleteRows(2, 100);
    const r = ask(b, 0, 'z');
    assert.strictEqual(r.ok, false); assert.match(r.error, /uyğunsuz/);
    const w = post(b, { action: 'sync', since: 0, device: 'z', items: [noteEv(301, Date.now())] });
    assert.strictEqual(w.ok, false);
    assert.strictEqual(b.rows('Events').length, 200);          // yeni hadisə yazılmayıb
  });

  await t('setup(): 26 sütunluq köhnə vərəq kəsilir, istifadəçinin əlavə etdiyi dolu sütuna toxunulmur', async () => {
    const b = makeBackend({ token: TOKEN });
    b.store.sheets.Events.maxCols = 26; b.store.sheets.Events.maxRows = 1000;
    b.store.sheets.Settings.maxCols = 26; b.store.sheets.Settings.rows[1] = ['k', 'v', 'u', '', '', '', '', 'qeyd'];
    b.sandbox.setup();
    assert.strictEqual(b.store.sheets.Events.maxCols, 7);
    assert.strictEqual(b.store.sheets.Settings.maxCols, 8);
    assert.strictEqual(b.store.sheets.Settings.rows[1][7], 'qeyd');
    assert.ok(b.store.sheets.Events.maxRows <= 301);
  });

  await t('köhnə (v6) hadisə sayı ilə uyğunluq: ARCHIVE property olmayan bazada kursorlar dəyişmir', async () => {
    const b = makeBackend({ token: TOKEN });
    fill(b, 400);
    assert.strictEqual(b.store.props.ARCHIVE, undefined);
    assert.strictEqual(ask(b, 400, 'q').next, 400);
    assert.strictEqual(pullAll(b, 0, 'q').events.length, 400);
  });

  /* ======================= B. real cihazlar ======================= */
  const bb = makeBackend({ token: TOKEN });
  let A, B, C, D, lego, snapA;
  await t('B: A və B qoşulur; A məhsul, mal qəbulu, növbə və satışlar yaradır', async () => {
    A = await boot(bb); B = await boot(bb);
    await loginAs(A, 'Menecer', '2222'); await A.Services.changePin('2222', '7342');
    lego = (await A.Services.createProduct({ name: 'Konstruktor', price: 1450, cost: 900 })).product;
    const bear = (await A.Services.createProduct({ name: 'Ayı', price: 600, cost: 350 })).product;
    await A.Services.receiveStock(lego.id, 30, 900); await A.Services.receiveStock(bear.id, 20, 350);
    await A.Services.openShift(5000);
    await loginAs(A, 'Kassir', '1111');
    for (let i = 0; i < 6; i++) await A.Services.checkout([{ productId: lego.id, qty: 1 }, { productId: bear.id, qty: 2 }], null, { method: 'cash', cashReceived: 10000 });
    await loginAs(A, 'Admin', '1234'); await A.Services.changePin('1234', '5821');
    const m = JSON.parse(JSON.stringify(await A.Services.getMatrix())); m.kassir = m.kassir.filter(p => p !== 'label.print');
    await A.Services.setMatrix(m); await A.Services.setStoreInfo({ name: 'Oyuncaq dünyası', voen: '1234567890', address: 'Bakı', registerName: 'Kassa 1' });
    await A.Sync.cycle();
    snapA = await snapshot(A);
    assert.ok(bb.rows('Events').length > 25, 'hadisə sayı: ' + bb.rows('Events').length);
  });

  await t('B: köhnə hadisələr arxivə köçürülür (qəsdən kiçik pəncərə: son 8 hadisə canlı qalır)', async () => {
    bb.sandbox.SEEN_WINDOW = 8; bb.sandbox.ARCHIVE_MIN_CUT = 5;
    await new Promise(r => setTimeout(r, 150));         // keepDays:0 → kəsim anı indidir; cihaz saatı (ardıcıl 'at') bir neçə ms irəli gedə bilər
    const total = bb.rows('Events').length;
    const r = bb.sandbox.archiveRun({ force: true, keepDays: 0 });
    assert.ok(r.archived, JSON.stringify(r));
    assert.strictEqual(r.removed.Events, total - 8);
    assert.strictEqual(bb.rows('Events').length, 8);
    assert.strictEqual(bb.rows('Sales').length, 0);
    assert.strictEqual(state(bb).base, total - 8);
  });

  await t('B: arxivdən əvvəl heç nə almamış cihaz (B) bütün tarixçəni arxivdən alır və A ilə eyni vəziyyətə gəlir', async () => {
    await B.Sync.cycle();
    assert.strictEqual(await snapshot(B), snapA);
    assert.strictEqual((await B.Services.recentSales(50)).length, 6);
  });

  await t('B: arxivdən sonra qoşulan YENİ cihaz (C) eyni vəziyyəti alır: məhsullar, qalıq, satışlar, istifadəçilər, icazələr, mağaza', async () => {
    C = await boot(bb);
    await C.Sync.cycle();
    assert.strictEqual(await snapshot(C), snapA);
    await rejectsLogin(C, 'Admin', '1234');                       // köhnə PIN yox, yeni PIN işləyir
    assert.strictEqual((await loginAs(C, 'Admin', '5821')).role, 'admin');
  });

  await t('B: arxivdən sonra fəaliyyət davam edir: A satır, B və C alır; C satır, A alır — qalıqlar üçündə eynidir', async () => {
    await loginAs(A, 'Kassir', '1111');
    await A.Services.checkout([{ productId: lego.id, qty: 2 }], null, { method: 'bank', bankType: 'pos' });
    await loginAs(C, 'Kassir', '1111');
    const sc = await C.Services.checkout([{ productId: lego.id, qty: 1 }], null, { method: 'cash', cashReceived: 2000 });
    await A.Sync.cycle(); await C.Sync.cycle(); await B.Sync.cycle(); await A.Sync.cycle();
    const na = await snapshot(A);
    assert.strictEqual(await snapshot(B), na); assert.strictEqual(await snapshot(C), na);
    const stock = (await A.Services.listProducts()).find(p => p.name === 'Konstruktor').stock;
    assert.strictEqual(stock, 30 - 6 - 2 - 1);
    // çek nömrələri toqquşmur (arxivlənmiş çeklərin nömrəsi də nəzərə alınır)
    const nums = (await A.Services.recentSales(500)).map(s => s.receiptNo);
    assert.strictEqual(new Set(nums).size, nums.length);
    assert.ok(sc.receiptNo > 0);
  });

  await t('B: ikinci arxivləşdirmədən sonra daha bir yeni cihaz (D) yenə eyni vəziyyəti alır (iki seqmentli tarixçə)', async () => {
    const st = state(bb); st.last = iso(Date.now() - 2 * DAY); bb.store.props.ARCHIVE = JSON.stringify(st);
    await new Promise(r => setTimeout(r, 150));
    const r = bb.sandbox.archiveRun({ keepDays: 0 });
    assert.ok(r.archived, JSON.stringify(r));
    assert.strictEqual(state(bb).segs.length, 2);
    D = await boot(bb); await D.Sync.cycle();
    assert.strictEqual(await snapshot(D), await snapshot(A));
  });

  async function rejectsLogin(d, name, pin) {
    try { await loginAs(d, name, pin); } catch (e) { return; }
    throw new Error('giriş rədd olunmalı idi');
  }

  console.log(passed + ' keçdi, ' + failed + ' uğursuz');
  process.exit(failed ? 1 : 0);
})();
