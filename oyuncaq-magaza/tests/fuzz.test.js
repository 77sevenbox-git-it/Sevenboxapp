/* node tests/fuzz.test.js [seedSayı] — çoxcihazlı təsadüfi (fuzz) yoxlama.
   3 "brauzer" paralel işləyir: məhsul yaradır, təchizatçı yaradır/adını dəyişir, təchizatçıdan mal qəbul edir, növbə açıb bağlayır, satır, qaytarır, qiymət dəyişir, PIN dəyişir.
   Şəbəkə pozulur: təsadüfi gecikmə, sorğu itir, CAVAB itir (server işləyib, cihaz bilmir), HTML cavab, 500.
   Sonda şəbəkə düzəlir və yoxlanılır: bütün cihazlarda eyni məlumat, qalıq = hadisələrin cəmi, çek nömrələri və barkodlar unikal, dublikat yoxdur. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { makeBackend } = require('./gas-mock.js');

const URL_OK = 'https://script.google.com/macros/s/AKfycbFUZZ/exec';
const TOKEN = 'fuzz-token';
const JS = path.join(__dirname, '..', 'js');
const SEEDS = parseInt(process.argv[2] || '12', 10);
const DEVICES = 3, OPS = 45;

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function faultyFetch(be, ctl) {
  return function (url, o) {
    return new Promise((resolve, reject) => {
      const rnd = ctl.rnd;
      const lat = Math.floor(rnd() * 12);
      let mode = 'ok';
      if (ctl.faults) {
        const x = rnd();
        if (x < 0.05) mode = 'drop'; else if (x < 0.11) mode = 'lost'; else if (x < 0.14) mode = 'html'; else if (x < 0.17) mode = '500';
      }
      setTimeout(() => {
        if (mode === 'drop') return reject(new TypeError('Failed to fetch'));
        const body = o && o.method === 'POST' ? be.post(o.body) : be.get();
        if (mode === 'lost') return reject(new TypeError('Failed to fetch'));
        if (mode === 'html') return resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')) });
        if (mode === '500') return resolve({ ok: false, status: 500, json: () => Promise.reject(new Error('x')) });
        resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(body))) });
      }, lat);
    });
  };
}

function makeDevice(fetchFn) {
  const ctx = { console, setTimeout, clearTimeout, TextEncoder, DOMException, crypto: require('crypto').webcrypto, indexedDB: new IDBFactory(), IDBKeyRange, navigator: { onLine: true }, fetch: fetchFn };
  ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
  ['money', 'barcode', 'rules', 'fifo', 'db', 'services', 'replica', 'sync'].forEach(f => vm.runInContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), ctx, { filename: f + '.js' }));
  ctx.Sync.kick = () => {};
  return ctx;
}

// Gözlənilən (iş qaydası) xətalar: bunlar səhv deyil. Qalan hər xəta tapıntıdır.
const BUSINESS = /mənfi çekdə|növbəni açın|Artıq açıq növbə|azdır|ən çox|müddəti bitib|menecer təsdiqi|İzah yazın|Qalıq yoxdur|limit|qaytarıla bilməz|Bağlanmış|bağlanıb|tapılmadı|icazəniz yoxdur|PIN səhvdir|bloklanıb|Nömrə ehtiyatı|Açıq növbə yoxdur|artıq var|söndürülüb/i;

async function runSeed(seed) {
  const rnd = mulberry32(seed * 7919 + 13);
  const be = makeBackend({ token: TOKEN });
  const ctl = { rnd, faults: false };
  const devs = [];
  for (let i = 0; i < DEVICES; i++) {
    const d = makeDevice(faultyFetch(be, ctl));
    await d.Services.init();
    await d.Sync.connect(URL_OK, TOKEN);
    devs.push(d);
  }
  ctl.faults = true;
  const unexpected = [];
  const sales = [];     // [{deviceIdx, id}]
  let pinPhase = 0;

  const login = (d, id, pin) => d.Services.login(id, pin);
  const pick = a => a[Math.floor(rnd() * a.length)];

  async function step(i) {
    const d = devs[i];
    const x = rnd();
    const S = d.Services;
    try {
      if (x < 0.12) {
        await login(d, 'u_menecer', '2222');
        await S.createProduct({ name: 'Mal ' + Math.floor(rnd() * 1e6), price: 100 + Math.floor(rnd() * 900), cost: 50 + Math.floor(rnd() * 50) });
      } else if (x < 0.15) {
        await login(d, 'u_menecer', '2222');
        const sups = await S.listSuppliers({ all: true });
        if (sups.length && rnd() < 0.4) await S.updateSupplier(pick(sups).id, rnd() < 0.5 ? { name: 'Təch ' + Math.floor(rnd() * 1e6) } : { note: 'qeyd ' + Math.floor(rnd() * 100) });
        else await S.createSupplier({ name: 'Təch ' + Math.floor(rnd() * 1e6), phone: '+99450' + Math.floor(1e6 + rnd() * 8e6) });
      } else if (x < 0.27) {
        await login(d, 'u_menecer', '2222');
        const ps = await S.listProducts(); if (!ps.length) return;
        const sups = await S.listSuppliers();
        await S.receiveStock(pick(ps).id, 1 + Math.floor(rnd() * 12), 40 + Math.floor(rnd() * 80), '', sups.length && rnd() < 0.8 ? pick(sups).id : undefined);
      } else if (x < 0.34) {
        await login(d, 'u_kassir', '1111');
        if (!(await S.currentShift())) await S.openShift(1000 + Math.floor(rnd() * 5000), 'sınaq');
      } else if (x < 0.62) {
        await login(d, 'u_kassir', '1111');
        const ps = (await S.listProducts()).filter(p => p.active); if (!ps.length) return;
        const lines = []; const n = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) { const p = pick(ps); if (!lines.some(l => l.productId === p.id)) lines.push({ productId: p.id, qty: 1 + Math.floor(rnd() * 3) }); }
        const s = await S.checkout(lines, null, { method: 'cash', cashReceived: 1e7 });
        sales.push({ i, id: s.id });
      } else if (x < 0.68) {
        await login(d, 'u_menecer', '2222');
        const rs = await S.recentSales(); if (!rs.length) return;
        const s = pick(rs); const ret = await S.returnedQtyBySale(s.id);
        const li = Math.floor(rnd() * s.lines.length);
        if ((ret[li] || 0) < s.lines[li].qty) await S.createReturn(s.id, [{ lineIndex: li, qty: 1 }], await S.currentUser());
      } else if (x < 0.74) {
        await login(d, 'u_menecer', '2222');
        const ps = await S.listProducts(); if (!ps.length) return;
        await S.updateProduct(pick(ps).id, { price: 100 + Math.floor(rnd() * 900) });
      } else if (x < 0.78) {
        await login(d, 'u_kassir', '1111');
        if (await S.currentShift()) await S.closeShift(0, 'sınaq');
      } else if (x < 0.81 && i === 0) {
        const pins = ['3333', '4827', '5938', '6149'];
        if (pinPhase < 3) { await login(d, 'u_muhasib1', pins[pinPhase]); await S.changePin(pins[pinPhase], pins[pinPhase + 1]); pinPhase++; }
      } else if (x < 0.84 && i === 1) {
        await login(d, 'u_admin', '1234');
        await S.setStoreInfo({ name: 'Mağaza ' + Math.floor(rnd() * 100), voen: '123', address: 'Bakı', registerName: 'Kassa ' + (i + 1) });
      } else if (x < 0.92) {
        await d.Sync.cycle();
      } else {
        await sleep(Math.floor(rnd() * 8));
      }
    } catch (e) {
      if (!BUSINESS.test(e.message || '')) unexpected.push('cihaz ' + i + ': ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | '));
    }
  }

  await Promise.all(devs.map(async (d, i) => { for (let k = 0; k < OPS; k++) { await step(i); if (rnd() < 0.3) await sleep(Math.floor(rnd() * 6)); } }));

  // şəbəkə düzəlir → hamı sinxronlaşır
  ctl.faults = false;
  for (let round = 0; round < 12; round++) {
    await Promise.all(devs.map(d => d.Sync.cycle()));
    const total = be.rows('Events').length;
    const states = await Promise.all(devs.map(async d => ({ out: await d.Services.outboxCount(), cur: await d.Replica.cursor() })));
    if (states.every(s => s.out === 0 && s.cur === total)) break;
  }

  const problems = unexpected.slice();
  const total = be.rows('Events').length;
  for (let i = 0; i < DEVICES; i++) {
    const out = await devs[i].Services.outboxCount(), cur = await devs[i].Replica.cursor();
    if (out !== 0) problems.push(`cihaz ${i}: göndərilməmiş ${out} qeyd qalıb`);
    if (cur !== total) problems.push(`cihaz ${i}: kursor ${cur} ≠ server ${total}`);
    const st = devs[i].Sync.status(); if (st.ok === false) problems.push(`cihaz ${i}: sinxron xətası "${st.error}"`);
  }

  const snap = async d => {
    const j = x => JSON.parse(JSON.stringify(x));
    const products = j(await d.DB.getAll('products')).map(p => ({ id: p.id, name: p.name, price: p.price, active: p.active, storeBarcode: p.storeBarcode, stock: p.stock })).sort((a, b) => a.id < b.id ? -1 : 1);
    const users = j(await d.DB.getAll('users')).map(u => ({ id: u.id, role: u.role, active: u.active, mustChangePin: u.mustChangePin, updatedAt: u.updatedAt, pinHash: u.updatedAt === '1970-01-01T00:00:00.000Z' ? 'ilkin' : u.pinHash })).sort((a, b) => a.id < b.id ? -1 : 1);
    const sales = j(await d.DB.getAll('sales')).map(s => ({ id: s.id, receiptNo: s.receiptNo, code: s.receiptBarcode, total: s.totals.total })).sort((a, b) => a.id < b.id ? -1 : 1);
    const returns = j(await d.DB.getAll('returns')).map(r => r.id).sort();
    const shifts = j(await d.DB.getAll('shifts')).map(s => ({ id: s.id, status: s.status })).sort((a, b) => a.id < b.id ? -1 : 1);
    const store = j((await d.DB.get('meta', 'store')).value);
    const suppliers = j(await d.DB.getAll('suppliers')).map(x => ({ id: x.id, name: x.name, phone: x.phone, note: x.note, active: x.active, updatedAt: x.updatedAt })).sort((a, b) => a.id < b.id ? -1 : 1);
    const lots = j(await d.DB.getAll('lots')).map(x => ({ id: x.id, productId: x.productId, supplierId: x.supplierId, qty: x.qty, unitCost: x.unitCost, at: x.at })).sort((a, b) => a.id < b.id ? -1 : 1);
    return { products, users, sales, returns, shifts, store, suppliers, lots };
  };
  const snaps = [];
  for (const d of devs) snaps.push(await snap(d));
  for (const k of Object.keys(snaps[0])) {
    for (let i = 1; i < DEVICES; i++) {
      const a = JSON.stringify(snaps[0][k]), b = JSON.stringify(snaps[i][k]);
      if (a !== b) {
        const A = snaps[0][k], B = snaps[i][k];
        const diff = Array.isArray(A) ? A.filter((x, n) => JSON.stringify(x) !== JSON.stringify(B[n])).slice(0, 2).map(x => JSON.stringify(x) + ' ≠ ' + JSON.stringify(B.find(y => y.id === x.id || y === x))) : [a + ' ≠ ' + b];
        problems.push(`"${k}" cihaz 0 və cihaz ${i}-də fərqlidir: ${diff.join(' || ').slice(0, 600)}`);
      }
    }
  }

  // Məhsul fərqi varsa diaqnostika: hər cihazın qeydi və bu məhsulun bütün hadisələri
  if (problems.some(p => p.startsWith('"products"'))) {
    const bad = new Set();
    for (let i = 1; i < DEVICES; i++) snaps[0].products.forEach((x, n) => { if (JSON.stringify(x) !== JSON.stringify(snaps[i].products[n])) bad.add(x.id); });
    for (const id of bad) {
      for (let i = 0; i < DEVICES; i++) { const r = await devs[i].DB.get('products', id); problems.push(`  [diaq] cihaz ${i}: price=${r.price} updatedAt=${r.updatedAt} dev=${r.updatedDev}`); }
      be.rows('Events').forEach(r => { if (r[5].indexOf(id) !== -1 && /product\./.test(r[2])) { let d = {}; try { d = JSON.parse(r[5]); } catch (e) {} problems.push(`  [diaq] at=${r[1]} ${r[2]} dev=${r[6]} price=${d.after ? d.after.price : d.product ? d.product.price : '?'}`); } });
    }
  }

  // unikallıq
  const s0 = snaps[0];
  const dupe = (arr, f) => { const seen = new Set(); return arr.some(x => { const v = f(x); if (seen.has(v)) return true; seen.add(v); return false; }); };
  if (dupe(s0.sales, s => s.receiptNo)) problems.push('çek nömrəsi təkrarlanır');
  if (dupe(s0.sales, s => s.code)) problems.push('çek barkodu təkrarlanır');
  if (dupe(s0.products, p => p.storeBarcode)) problems.push('mağaza barkodu təkrarlanır');

  // qalıq = hadisələrin cəmi (müstəqil hesab)
  const exp = {};
  const created = new Set(s0.products.map(p => p.id));
  const seenEv = new Set();
  be.rows('Events').forEach(r => {
    if (seenEv.has(r[0])) { problems.push('Events-də təkrar id: ' + r[0]); return; }
    seenEv.add(r[0]);
    let d; try { d = JSON.parse(r[5]); } catch (e) { problems.push('Events JSON pozuqdur: ' + r[0]); return; }
    if (r[2] === 'stock.received') exp[d.productId] = (exp[d.productId] || 0) + d.qty;
    if (r[2] === 'sale.created') d.sale.lines.forEach(l => exp[l.productId] = (exp[l.productId] || 0) - l.qty);
    if (r[2] === 'return.created') d.ret.lines.forEach(l => exp[l.productId] = (exp[l.productId] || 0) + l.qty);
  });
  s0.products.forEach(p => { if ((exp[p.id] || 0) !== p.stock) problems.push(`qalıq səhvdir: ${p.name} gözlənilən ${exp[p.id] || 0}, cihazda ${p.stock}`); });

  // FIFO: bütün cihazlarda eyni hesabat; partiyaların qalığı − borc = məhsul qalığı; təchizatçılar üzrə cəm = ümumi satış/qaytarma
  const reps = [];
  for (const d of devs) { await d.Services.login('u_menecer', '2222'); reps.push(await d.Services.supplierReport({})); }
  for (let i = 1; i < DEVICES; i++) if (JSON.stringify(reps[0]) !== JSON.stringify(reps[i])) problems.push(`təchizatçı hesabatı cihaz 0 və cihaz ${i}-də fərqlidir`);
  {
    const d = devs[0], lots = await d.DB.getAll('lots'), salesAll = await d.DB.getAll('sales'), retsAll = await d.DB.getAll('returns'), prods = await d.DB.getAll('products');
    const stock = {}, avgCost = {}; prods.forEach(p => { stock[p.id] = p.stock; avgCost[p.id] = p.avgCost || 0; });
    const res = d.Fifo.replay({ lots, sales: salesAll, returns: retsAll, stock, avgCost });
    prods.forEach(p => {
      const rem = Object.keys(res.lots).map(k => res.lots[k]).filter(l => l.productId === p.id).reduce((n, l) => n + l.remaining, 0);
      const def = res.deficits[p.id] || 0;
      if (rem - def !== p.stock) {
        problems.push(`FIFO qalığı uyğun deyil: ${p.name} partiyalar ${rem} − borc ${def} ≠ qalıq ${p.stock}`);
        if (process.env.FUZZ_DUMP) fs.writeFileSync(process.env.FUZZ_DUMP, JSON.stringify({ pid: p.id, stock: p.stock, avg: p.avgCost, lots: lots.filter(l => l.productId === p.id), sales: salesAll.filter(x => x.lines.some(l => l.productId === p.id)), returns: retsAll.filter(x => x.lines.some(l => l.productId === p.id)) }, null, 1));
      }
      if (rem > 0 && def > 0) problems.push(`FIFO: ${p.name} həm qalıq (${rem}) həm borc (${def}) göstərir`);
    });
    const sold = salesAll.reduce((n, sl) => n + sl.lines.reduce((m, l) => m + l.qty, 0), 0), back = retsAll.reduce((n, r) => n + r.lines.reduce((m, l) => m + l.qty, 0), 0);
    if (reps[0].totals.soldQty !== sold) problems.push(`hesabatda satılan ${reps[0].totals.soldQty} ≠ çeklərdə ${sold}`);
    if (reps[0].totals.returnedQty !== back) problems.push(`hesabatda qaytarılan ${reps[0].totals.returnedQty} ≠ qaytarmalarda ${back}`);
    const revenue = salesAll.reduce((n, sl) => n + sl.totals.total, 0) - retsAll.reduce((n, r) => n + r.amount, 0);
    if (Math.abs(reps[0].totals.revenue - revenue) > reps[0].rows.length + 5) problems.push(`hesabat gəliri ${reps[0].totals.revenue} ≠ çeklər−qaytarma ${revenue}`);
  }
  const nRecv = be.rows('Events').filter(r => r[2] === 'stock.received').length;
  if (be.rows('StockReceipts').length !== nRecv) problems.push(`StockReceipts vərəqi ${be.rows('StockReceipts').length} sətir, hadisə ${nRecv}`);
  if (be.rows('Suppliers').length !== s0.suppliers.length) problems.push(`Suppliers vərəqi ${be.rows('Suppliers').length} sətir, cihazda ${s0.suppliers.length}`);

  // Sheets-dəki cədvəllər
  if (be.rows('Sales').length !== s0.sales.length) problems.push(`Sales vərəqi ${be.rows('Sales').length} sətir, cihazda ${s0.sales.length} çek`);
  if (be.rows('Products').length !== s0.products.length) problems.push(`Products vərəqi ${be.rows('Products').length} sətir, cihazda ${s0.products.length} məhsul`);
  if (be.rows('Users').length !== 5) problems.push('Users vərəqində 5 istifadəçi olmalıdır: ' + be.rows('Users').length);
  const errs = be.rows('Events').filter(r => r[2] === 'server.project_error'); if (errs.length) problems.push('server layihə xətası: ' + errs.length);

  return { problems, stats: { events: total, sales: s0.sales.length, products: s0.products.length, suppliers: s0.suppliers.length, lots: s0.lots.length } };
}

(async () => {
  let bad = 0, n = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    n++;
    let r;
    try { r = await runSeed(seed); } catch (e) { r = { problems: ['SINAQ ÇÖKDÜ: ' + (e.stack || e.message)], stats: {} }; }
    if (r.problems.length) { bad++; console.log(`✗ seed ${seed}: ${JSON.stringify(r.stats)}`); r.problems.slice(0, 8).forEach(p => console.log('    - ' + p)); }
    else console.log(`✓ seed ${seed}: ${r.stats.events} hadisə, ${r.stats.sales} çek, ${r.stats.products} məhsul, ${r.stats.suppliers} təchizatçı, ${r.stats.lots} partiya`);
  }
  console.log(`\n${n - bad} keçdi, ${bad} uğursuz`);
  process.exit(bad ? 1 : 0);
})();
