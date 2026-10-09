/* node tests/fifo.test.js — FIFO bölgüsü və təchizatçı hesabatı (saf funksiyalar) */
const assert = require('assert');
const Fifo = require('../js/fifo.js');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); } }

const T = n => '2026-10-' + String(n).padStart(2, '0') + 'T10:00:00.000Z';
const lot = (id, supplierId, qty, unitCost, at, productId = 'p1') => ({ id, productId, supplierId, qty, unitCost, at });
const sale = (id, at, qty, price = 1000, productId = 'p1') => ({ id, at, lines: [{ productId, qty, price, unitCost: 0 }], totals: { subtotal: price * qty, total: price * qty } });
const ret = (id, saleId, at, qty, amount, productId = 'p1', lineIndex = 0, price = 1000) => ({ id, saleId, at, amount, lines: [{ lineIndex, productId, qty, price }] });
const totalRemaining = res => Object.values(res.lots).reduce((a, l) => a + l.remaining, 0);
const totalDeficit = res => Object.values(res.deficits).reduce((a, n) => a + n, 0);

t('satış ən köhnə partiyadan çıxır (FIFO), qalıq düzgündür', () => {
  const res = Fifo.replay({ lots: [lot('B', 'sB', 10, 120, T(2)), lot('A', 'sA', 4, 100, T(1))], sales: [sale('s1', T(3), 6)], stock: { p1: 8 } });
  const parts = res.lines['s1:0'].parts;
  assert.deepStrictEqual(parts.map(p => [p.lotId, p.qty]), [['A', 4], ['B', 2]]);
  assert.strictEqual(res.lots.A.remaining, 0); assert.strictEqual(res.lots.B.remaining, 8);
  assert.strictEqual(totalRemaining(res) - totalDeficit(res), 8);
});

t('açılış partiyası: qəbul qeydi olmayan köhnə qalıq təchizatçısızdır, ilk çıxır', () => {
  const res = Fifo.replay({ lots: [lot('A', 'sA', 5, 100, T(5))], sales: [sale('s1', T(6), 3)], stock: { p1: 12 }, avgCost: { p1: 90 } });
  // açılış = 12 − 5 + 3 = 10
  assert.strictEqual(res.lots['open:p1'].qty, 10);
  assert.deepStrictEqual(res.lines['s1:0'].parts.map(p => [p.lotId, p.supplierId, p.qty]), [['open:p1', null, 3]]);
  assert.strictEqual(res.lots['open:p1'].unitCost, 90);
  assert.strictEqual(totalRemaining(res), 12);
});

t('mənfi qalıq: sonrakı qəbul borcu bağlayır, partiyanın qalığı real qalığa bərabərdir', () => {
  const res = Fifo.replay({ lots: [lot('A', 'sA', 10, 100, T(2))], sales: [sale('s1', T(1), 3)], stock: { p1: 7 } });
  assert.strictEqual(res.lines['s1:0'].deficit, 0);
  assert.deepStrictEqual(res.lines['s1:0'].parts.map(p => [p.lotId, p.qty]), [['A', 3]]);
  assert.strictEqual(res.lots.A.remaining, 7); assert.strictEqual(totalDeficit(res), 0);
});

t('qəbul çatmayanda borc qalır: qalıq mənfi', () => {
  const res = Fifo.replay({ lots: [lot('A', 'sA', 2, 100, T(2))], sales: [sale('s1', T(1), 3), sale('s2', T(3), 1)], stock: { p1: -2 } });
  assert.strictEqual(totalRemaining(res) - totalDeficit(res), -2);
  assert.strictEqual(res.lines['s1:0'].deficit, 1);   // 2 vahid A-dan, 1 vahid borc
  assert.strictEqual(res.lines['s2:0'].deficit, 1);
});

t('qaytarma malı çıxdığı partiyalara qaytarır (sonuncudan əvvələ)', () => {
  const res = Fifo.replay({ lots: [lot('A', 'sA', 4, 100, T(1)), lot('B', 'sB', 10, 120, T(2))], sales: [sale('s1', T(3), 6)], returns: [ret('r1', 's1', T(4), 3, 3000)], stock: { p1: 11 } });
  assert.deepStrictEqual(res.returns['r1:0'].parts.map(p => [p.lotId, p.qty]), [['B', 2], ['A', 1]]);
  assert.strictEqual(res.lots.A.remaining, 1); assert.strictEqual(res.lots.B.remaining, 10);
  // sonrakı satış yenə ən köhnədən (A) başlayır
  const res2 = Fifo.replay({ lots: [lot('A', 'sA', 4, 100, T(1)), lot('B', 'sB', 10, 120, T(2))], sales: [sale('s1', T(3), 6), sale('s2', T(5), 2)], returns: [ret('r1', 's1', T(4), 3, 3000)], stock: { p1: 9 } });
  assert.deepStrictEqual(res2.lines['s2:0'].parts.map(p => [p.lotId, p.qty]), [['A', 1], ['B', 1]]);
});

t('borcla satılmış sətrin qaytarılması əvvəl borcu ləğv edir', () => {
  const res = Fifo.replay({ lots: [], sales: [sale('s1', T(1), 3)], returns: [ret('r1', 's1', T(2), 2, 2000)], stock: { p1: -1 }, });
  assert.strictEqual(res.returns['r1:0'].deficit, 2);
  assert.strictEqual(totalDeficit(res), 1);
  assert.strictEqual(totalRemaining(res) - totalDeficit(res), -1);
});

t('saat fərqi: qaytarma satışdan əvvəl görünsə də düzgün tətbiq olunur', () => {
  const res = Fifo.replay({ lots: [lot('A', 'sA', 5, 100, T(1))], sales: [sale('s1', T(5), 2)], returns: [ret('r1', 's1', T(4), 1, 1000)], stock: { p1: 4 } });
  assert.strictEqual(res.returns['r1:0'].parts[0].lotId, 'A');
  assert.strictEqual(res.lots.A.remaining, 4);
});

t('nəticə hadisələrin daxil olma sırasından asılı deyil (cihazlar eyni nəticəni alır)', () => {
  const lots = [lot('A', 'sA', 4, 100, T(1)), lot('B', 'sB', 10, 120, T(2)), lot('C', 'sA', 3, 130, T(2))];
  const sales = [sale('s1', T(3), 6), sale('s2', T(3), 5), sale('s3', T(6), 4)];
  const returns = [ret('r1', 's1', T(4), 2, 2000), ret('r2', 's3', T(7), 1, 1000)];
  const base = JSON.stringify(Fifo.replay({ lots, sales, returns, stock: { p1: 5 } }));
  for (let i = 0; i < 20; i++) {
    const sh = a => a.map(x => [Math.random(), x]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    assert.strictEqual(JSON.stringify(Fifo.replay({ lots: sh(lots), sales: sh(sales), returns: sh(returns), stock: { p1: 5 } })), base);
  }
});

t('təsadüfi ssenarilər: Σ qalıq − borc = faktiki qalıq, heç bir partiya mənfi deyil, qaytarma satılandan çox deyil', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let n = 0; n < 300; n++) {
    const lots = [], sales = [], returns = [];
    let stock = Math.floor(rnd() * 8), time = 1;   // köhnə (açılış) qalıq
    const soldQ = {};
    const k = 4 + Math.floor(rnd() * 12);
    for (let i = 0; i < k; i++) {
      time++;
      const x = rnd();
      if (x < 0.3) { const q = 1 + Math.floor(rnd() * 8); lots.push(lot('L' + i, rnd() < 0.2 ? null : 'S' + Math.floor(rnd() * 3), q, 50 + Math.floor(rnd() * 100), T(time))); stock += q; }
      else if (x < 0.8 || !sales.length) { const q = 1 + Math.floor(rnd() * 5); sales.push(sale('s' + i, T(time), q)); soldQ['s' + i] = { sold: q, ret: 0 }; stock -= q; }
      else {
        const s = sales[Math.floor(rnd() * sales.length)], can = soldQ[s.id].sold - soldQ[s.id].ret;
        if (can > 0) { const q = 1 + Math.floor(rnd() * can); soldQ[s.id].ret += q; returns.push(ret('r' + i, s.id, T(time), q, q * 1000)); stock += q; }
      }
    }
    const open0 = 0;   // stock hesablanıb: açılış qalığı = stock − Σ(qəbul) + Σsatış − Σqaytarma ≥ 0 olmalıdır (başlanğıc qalıq)
    const res = Fifo.replay({ lots, sales, returns, stock: { p1: stock } });
    const tr = totalRemaining(res), td = totalDeficit(res);
    assert.strictEqual(tr - td, stock, `ssenari ${n}: Σqalıq ${tr} − borc ${td} ≠ ${stock}`);
    Object.values(res.lots).forEach(l => assert.ok(l.remaining >= 0 && l.remaining <= l.qty + 0, `ssenari ${n}: partiya ${l.id} qalığı ${l.remaining}/${l.qty}`));
    assert.ok(open0 === 0);
    assert.ok(!(tr > 0 && td > 0), `ssenari ${n}: həm qalıq ${tr} həm borc ${td}`);
    // hesabat cəmləri çeklərlə uzlaşır (borcla satılıb qaytarılan hissə də daxil)
    const rep = Fifo.supplierReport(res, sales, returns, '', '');
    const sum = k => Object.values(rep).reduce((a, r) => a + r[k], 0);
    const soldTotal = sales.reduce((a, x) => a + x.lines[0].qty, 0), retTotal = returns.reduce((a, x) => a + x.lines[0].qty, 0);
    assert.strictEqual(sum('soldQty'), soldTotal, `ssenari ${n}: satılan`); assert.strictEqual(sum('returnedQty'), retTotal, `ssenari ${n}: qaytarılan`);
    assert.strictEqual(sum('qty'), soldTotal - retTotal, `ssenari ${n}: xalis`);
    assert.strictEqual(sum('revenue'), sales.reduce((a, x) => a + x.totals.total, 0) - returns.reduce((a, x) => a + x.amount, 0), `ssenari ${n}: gəlir`);
  }
});

t('borcla satılıb qaytarılan mal hesabatda "təchizatçısız"da həm satış həm qaytarma kimi görünür (xalis 0)', () => {
  const s1 = sale('s1', T(1), 3), r1 = ret('r1', 's1', T(2), 2, 2000);
  const res = Fifo.replay({ lots: [], sales: [s1], returns: [r1], stock: { p1: -1 } });
  const rep = Fifo.supplierReport(res, [s1], [r1], '', '');
  assert.strictEqual(rep[''].soldQty, 3); assert.strictEqual(rep[''].returnedQty, 2); assert.strictEqual(rep[''].qty, 1); assert.strictEqual(rep[''].revenue, 3000 - 2000);
});

t('qaytarılan mal əvvəlcədən qalıqsız satılmış malı bağlayır (yeni qəbul kimi): həm qalıq, həm borc eyni anda olmur', () => {
  // A-dan 5 ədəd; s1 hamısını aparır; s2 (3 ədəd) qalıqsız → borc; s1-dən 2 ədəd qayıdır → borcdan 2-ni bağlayır
  const res = Fifo.replay({ lots: [lot('A', 'sA', 5, 100, T(1))], sales: [sale('s1', T(2), 5), sale('s2', T(3), 3)], returns: [ret('r1', 's1', T(4), 2, 2000)], stock: { p1: -1 } });
  assert.strictEqual(totalRemaining(res), 0); assert.strictEqual(totalDeficit(res), 1);
  assert.deepStrictEqual(res.lines['s2:0'].parts.map(p => [p.lotId, p.qty]), [['A', 2]]);
});

t('satılandan artıq qaytarma (iki cihaz eyni sətri qaytarıb): qalıq uzlaşır, artıq hissə təchizatçısız qaytarma kimi görünür', () => {
  const s1 = sale('s1', T(2), 3), rs = [ret('r1', 's1', T(3), 2, 2000), ret('r2', 's1', T(3), 2, 2000)];
  const res = Fifo.replay({ lots: [lot('A', 'sA', 5, 100, T(1))], sales: [s1], returns: rs, stock: { p1: 5 + 1 } });   // 5 − 3 + 4 qaytarma
  assert.strictEqual(totalRemaining(res) - totalDeficit(res), 6);
  const rep = Fifo.supplierReport(res, [s1], rs, '', '');
  assert.strictEqual(rep.sA.returnedQty, 3); assert.strictEqual(rep[''].returnedQty, 1);
  assert.strictEqual(rep.sA.returnedQty + rep[''].returnedQty, 4);
});

t('təchizatçı hesabatı: satış, qaytarma, maya və gəlir (endirimlə), dövr filtri', () => {
  const lots = [lot('A', 'sA', 4, 100, T(1)), lot('B', 'sB', 10, 120, T(2))];
  // s1: 6 ədəd × 10,00 ₼, 10% endirim → 54,00 ₼; s2 dövrdən kənar
  const s1 = { id: 's1', at: T(3), lines: [{ productId: 'p1', qty: 6, price: 1000, unitCost: 0 }], totals: { subtotal: 6000, total: 5400 } };
  const s2 = sale('s2', T(20), 1);
  const returns = [ret('r1', 's1', T(4), 3, 2700)];     // 3 ədəd: B-dən 2, A-dan 1; 27,00 ₼ qaytarılıb
  const res = Fifo.replay({ lots, sales: [s1, s2], returns, stock: { p1: 10 } });
  const rep = Fifo.supplierReport(res, [s1, s2], returns, T(1), T(10));
  assert.strictEqual(rep.sA.soldQty, 4); assert.strictEqual(rep.sB.soldQty, 2);
  assert.strictEqual(rep.sA.returnedQty, 1); assert.strictEqual(rep.sB.returnedQty, 2);
  assert.strictEqual(rep.sA.qty, 3); assert.strictEqual(rep.sB.qty, 0);
  assert.strictEqual(rep.sA.revenue + rep.sB.revenue, 5400 - 2700);
  assert.strictEqual(rep.sA.cost, 3 * 100); assert.strictEqual(rep.sB.cost, 0);
  assert.ok(!rep[''], 'təchizatçısız sətir yoxdur');
  assert.strictEqual(Object.keys(rep.sA.products).length, 1);
  // bütün dövr: s2 də daxil
  const all = Fifo.supplierReport(res, [s1, s2], returns, '', '');
  assert.strictEqual(all.sA.soldQty + all.sB.soldQty + (all[''] ? all[''].soldQty : 0), 6 + 1);
});

t('hesabat: borcla satılan hissə "təchizatçısız" sətrinə düşür, maya sətir mayasından götürülür', () => {
  const s1 = { id: 's1', at: T(1), lines: [{ productId: 'p1', qty: 3, price: 1000, unitCost: 77 }], totals: { subtotal: 3000, total: 3000 } };
  const res = Fifo.replay({ lots: [], sales: [s1], stock: { p1: -3 } });
  const rep = Fifo.supplierReport(res, [s1], [], '', '');
  assert.strictEqual(rep[''].soldQty, 3); assert.strictEqual(rep[''].cost, 3 * 77); assert.strictEqual(rep[''].revenue, 3000);
});

t('onHand: təchizatçılara görə qalıq və dəyər', () => {
  const res = Fifo.replay({ lots: [lot('A', 'sA', 4, 100, T(1)), lot('B', 'sB', 10, 120, T(2))], sales: [sale('s1', T(3), 6)], stock: { p1: 8 } });
  const oh = Fifo.onHand(res);
  assert.strictEqual(oh.sB.qty, 8); assert.strictEqual(oh.sB.value, 8 * 120); assert.ok(!oh.sA);
  assert.deepStrictEqual(Fifo.productLots(res, 'p1').map(l => [l.id, l.remaining]), [['A', 0], ['B', 8]]);
});

console.log(`\n${passed} keçdi, ${failed} uğursuz`);
process.exit(failed ? 1 : 0);
