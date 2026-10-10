/* FIFO: hər satış ən köhnə mal partiyasından (qəbul) çıxır. Təchizatçı və maya hesabatının əsası.
   Saf funksiyalar (bazaya toxunmur). Nəticə qəbulların, satışların və qaytarmaların ZAMAN SIRASINDAN hesablanır, gəliş sırasından yox:
   bütün cihazlar eyni hadisələri görəndə eyni nəticəni alır. Oflayn cihaz sonradan sinxronlaşanda keçmiş bölgü yenidən hesablanır (cəmlər dəyişmir, təchizatçılar arasında paylanma düzələ bilər).
   Qaydalar:
   • Hər partiya = bir mal qəbulu (məhsul, təchizatçı, say, alış qiyməti, vaxt). Qəbul sistemə köçməzdən əvvəlki qalıq "açılış partiyası"dır (təchizatçısı məlum deyil).
   • Satış sətri ən köhnə partiyadan başlayaraq çıxır. Partiyalar çatmırsa, çatmayan hissə "borc"dur: sonrakı qəbul əvvəl bu borcu bağlayır (qalıq mənfi satılmış mal).
   • Qaytarma əvvəl həmin sətrin borcunu ləğv edir, sonra malı həmin sətrin çıxdığı partiyalara (sonuncudan əvvələ) qaytarır.
   • Satılandan artıq qaytarma (iki cihaz eyni sətri oflayn qaytarıb) gizlədilmir: artıq hissə "naməlum mənşəli" partiya olur, hesabatda təchizatçısız qaytarma kimi görünür. */
(function (root) {
  'use strict';

  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function evCmp(x, y) { return cmp(x.at, y.at) || (x.rank - y.rank) || cmp(x.id, y.id); }

  // inp: { lots: [{id, productId, supplierId, qty, unitCost, at}], sales: [{id, at, lines:[{productId, qty}]}],
  //        returns: [{id, saleId, at, lines:[{lineIndex, productId, qty}]}], stock: {productId: cari qalıq}, avgCost: {productId: qəpik} }
  function replay(inp) {
    var lotsByP = {}, evByP = {}, openQty = {};
    function ev(pid) { return evByP[pid] || (evByP[pid] = []); }
    function sumP(map, pid, n) { map[pid] = (map[pid] || 0) + n; }
    var newQty = {}, soldQty = {}, retQty = {};

    (inp.lots || []).forEach(function (l) {
      ev(l.productId).push({ at: l.at, rank: 0, id: l.id, kind: 'lot', lot: l });
      sumP(newQty, l.productId, l.qty);
    });
    (inp.sales || []).forEach(function (s) {
      (s.lines || []).forEach(function (l, i) {
        ev(l.productId).push({ at: s.at, rank: 1, id: s.id + ':' + i, kind: 'sale', saleId: s.id, li: i, line: l });
        sumP(soldQty, l.productId, l.qty);
      });
    });
    (inp.returns || []).forEach(function (r) {
      (r.lines || []).forEach(function (l, i) {
        ev(l.productId).push({ at: r.at, rank: 2, id: r.id + ':' + i, kind: 'ret', retId: r.id, saleId: r.saleId, line: l });
        sumP(retQty, l.productId, l.qty);
      });
    });

    var out = { lines: {}, returns: {}, lots: {}, deficits: {} };
    var pids = {};
    Object.keys(evByP).forEach(function (p) { pids[p] = 1; });
    Object.keys(inp.stock || {}).forEach(function (p) { pids[p] = 1; });

    Object.keys(pids).forEach(function (pid) {
      // Açılış partiyası: indiki qalıq − yeni qəbullar + satışlar − qaytarmalar (sistemə köçməzdən əvvəl mövcud olan mal)
      var open = Math.max(0, ((inp.stock || {})[pid] || 0) - (newQty[pid] || 0) + (soldQty[pid] || 0) - (retQty[pid] || 0));
      var events = (evByP[pid] || []).slice();
      if (open > 0) events.push({ at: '', rank: 0, id: '~open:' + pid, kind: 'lot', lot: { id: 'open:' + pid, productId: pid, supplierId: null, qty: open, unitCost: (inp.avgCost || {})[pid] || 0, at: '', opening: true } });
      events.sort(evCmp);

      var queue = [], deficits = [], pendingRet = {};

      function settleDeficits(L) {
        while (deficits.length && L.remaining > 0) {
          var d = deficits[0], take = Math.min(d.qty, L.remaining);
          L.remaining -= take; d.qty -= take; d.rec.deficit -= take;
          d.rec.parts.push({ lotId: L.id, supplierId: L.supplierId, unitCost: L.unitCost, qty: take, returned: 0, lot: L });
          if (d.qty === 0) deficits.shift();
        }
      }

      function applyReturn(e, rec) {
        var left = e.line.qty;
        var rr = { retId: e.retId, li: e.id.slice(e.retId.length + 1), productId: pid, qty: e.line.qty, parts: [], deficit: 0 };
        var cancel = Math.min(left, rec.deficit);
        if (cancel > 0) {
          rec.deficit -= cancel; left -= cancel; rr.deficit = cancel; rec.cancelled += cancel;     // satış tərəfində də "təchizatçısız" sayılır ki, cəmlər uzlaşsın
          for (var i = 0; i < deficits.length && cancel > 0; i++) {
            if (deficits[i].rec === rec) { var c = Math.min(deficits[i].qty, cancel); deficits[i].qty -= c; cancel -= c; }
          }
          deficits = deficits.filter(function (d) { return d.qty > 0; });
        }
        for (var p = rec.parts.length - 1; p >= 0 && left > 0; p--) {
          var part = rec.parts[p], give = Math.min(left, part.qty - part.returned);
          if (give <= 0) continue;
          part.returned += give; part.lot.remaining += give; left -= give;
          rr.parts.push({ lotId: part.lotId, supplierId: part.supplierId, unitCost: part.unitCost, qty: give });
          settleDeficits(part.lot);     // qaytarılan mal rəfə qayıdır: əvvəlcədən qalıqsız satılmış mal varsa o bunu götürür (yeni qəbul kimi)
        }
        // Satılandan artıq qaytarma (iki cihaz eyni sətri oflayn qaytarıb): mal qalığa əlavə olunub, ona görə naməlum mənşəli partiya kimi sayılır ki, qalıq uzlaşsın
        if (left > 0) {
          rr.excess = left;
          var X = out.lots['excess:' + pid];
          if (!X) { X = out.lots['excess:' + pid] = { id: 'excess:' + pid, productId: pid, supplierId: null, unitCost: rec.fallbackCost || 0, qty: 0, remaining: 0, at: '', opening: true, excess: true }; queue.push(X); }
          X.qty += left; X.remaining += left;
          settleDeficits(X);
        }
        out.returns[e.id] = rr;
      }

      events.forEach(function (e) {
        if (e.kind === 'lot') {
          var L = { id: e.lot.id, productId: pid, supplierId: e.lot.supplierId || null, unitCost: e.lot.unitCost || 0, qty: e.lot.qty, remaining: e.lot.qty, at: e.lot.at, opening: !!e.lot.opening };
          out.lots[L.id] = L;
          settleDeficits(L);
          queue.push(L);
        } else if (e.kind === 'sale') {
          var rec = { saleId: e.saleId, li: e.li, productId: pid, qty: e.line.qty, parts: [], deficit: 0, cancelled: 0, fallbackCost: e.line.unitCost || 0 };
          var need = e.line.qty;
          for (var i = 0; i < queue.length && need > 0; i++) {
            var q = queue[i], take = Math.min(q.remaining, need);
            if (take <= 0) continue;
            q.remaining -= take; need -= take;
            rec.parts.push({ lotId: q.id, supplierId: q.supplierId, unitCost: q.unitCost, qty: take, returned: 0, lot: q });
          }
          if (need > 0) { rec.deficit = need; deficits.push({ rec: rec, qty: need }); }
          out.lines[e.id] = rec;
          (pendingRet[e.id] || []).forEach(function (pe) { applyReturn(pe, rec); });
          delete pendingRet[e.id];
        } else {
          var key = e.saleId + ':' + e.line.lineIndex;
          if (out.lines[key]) applyReturn(e, out.lines[key]);
          else (pendingRet[key] = pendingRet[key] || []).push(e);   // saat fərqi: qaytarma satışdan əvvəl görünür, satış işlənəndən sonra tətbiq olunur
        }
      });

      out.deficits[pid] = deficits.reduce(function (a, d) { return a + d.qty; }, 0);
    });
    // "lot" arayışları nəticədə lazım deyil (dövri istinad JSON-a düşməsin)
    Object.keys(out.lines).forEach(function (k) { out.lines[k].parts.forEach(function (p) { delete p.lot; }); });
    return out;
  }

  // Cari qalıq təchizatçılar üzrə: [{supplierId, qty, value}] (supplierId null — açılış/naməlum)
  function onHand(res) {
    var by = {};
    Object.keys(res.lots).forEach(function (id) {
      var L = res.lots[id]; if (L.remaining <= 0) return;
      var k = L.supplierId || '';
      var r = by[k] || (by[k] = { supplierId: L.supplierId || null, qty: 0, value: 0, products: {} });
      r.qty += L.remaining; r.value += L.remaining * L.unitCost;
      r.products[L.productId] = (r.products[L.productId] || 0) + L.remaining;
    });
    return by;
  }

  // Bir məhsulun partiyaları (köhnədən yeniyə)
  function productLots(res, productId) {
    return Object.keys(res.lots).map(function (id) { return res.lots[id]; })
      .filter(function (L) { return L.productId === productId; })
      .sort(function (a, b) { return cmp(a.at, b.at) || cmp(a.id, b.id); });
  }

  // Satış və qaytarma sətirlərini təchizatçı hissələrinə bölür və hər hissə üçün cb(kind, doc, lineIndex, line, part, rev, cost) çağırır
  // (kind: 'sale' | 'ret'; rev: dövrə düşən gəlir, endirimdən sonra, qəpik (kəsr ola bilər); cost: partiyanın alış qiyməti ilə). Hesabat və çek siyahısı EYNİ ədədləri alsın deyə ortaqdır.
  function walkParts(res, sales, returns, from, to, cb) {
    function inRange(at) { return (!from || at >= from) && (!to || at < to); }
    (sales || []).forEach(function (s) {
      if (!inRange(s.at)) return;
      var sub = s.totals && s.totals.subtotal, total = s.totals && s.totals.total;
      var ratio = sub > 0 ? total / sub : 1;
      (s.lines || []).forEach(function (l, i) {
        var rec = res.lines[s.id + ':' + i]; if (!rec) return;
        var lineNet = l.price * l.qty * ratio;
        var parts = rec.parts.slice();
        if (rec.deficit + rec.cancelled > 0) parts.push({ supplierId: null, unitCost: rec.fallbackCost, qty: rec.deficit + rec.cancelled, returned: 0 });
        parts.forEach(function (p) { cb('sale', s, i, l, p, lineNet * p.qty / l.qty, p.qty * p.unitCost); });
      });
    });
    (returns || []).forEach(function (rt) {
      if (!inRange(rt.at)) return;
      var gross = 0; (rt.lines || []).forEach(function (l) { gross += l.price * l.qty; });
      (rt.lines || []).forEach(function (l, i) {
        var rr = res.returns[rt.id + ':' + i]; if (!rr) return;
        var share = gross > 0 ? rt.amount * (l.price * l.qty) / gross : 0;
        var parts = rr.parts.slice();
        if (rr.deficit + (rr.excess || 0) > 0) parts.push({ supplierId: null, unitCost: (res.lines[rt.saleId + ':' + l.lineIndex] || {}).fallbackCost || 0, qty: rr.deficit + (rr.excess || 0) });
        parts.forEach(function (p) { cb('ret', rt, i, l, p, share * p.qty / l.qty, p.qty * p.unitCost); });
      });
    });
  }

  // Dövr üzrə təchizatçı hesabatı. [from, to) — ISO vaxt. Satışlar vaxtı ilə, qaytarmalar öz vaxtı ilə dövrə düşür.
  // Gəlir: endirimdən sonrakı satış məbləği (qəpik, çekin yekunu ilə uzlaşır), qaytarma isə qaytarılan pul məbləğidir.
  // Qaytarır: { rows: {supplierKey: {supplierId, soldQty, returnedQty, qty, revenue, cost, products:{pid:{...}}}} }
  function supplierReport(res, sales, returns, from, to) {
    var rows = {};
    function row(supplierId) { var k = supplierId || ''; return rows[k] || (rows[k] = { supplierId: supplierId || null, soldQty: 0, returnedQty: 0, qty: 0, revenue: 0, cost: 0, products: {} }); }
    function prod(r, pid) { return r.products[pid] || (r.products[pid] = { productId: pid, soldQty: 0, returnedQty: 0, qty: 0, revenue: 0, cost: 0 }); }
    walkParts(res, sales, returns, from, to, function (kind, doc, i, l, p, rev, cost) {
      var r = row(p.supplierId), pr = prod(r, l.productId);
      if (kind === 'sale') {
        r.soldQty += p.qty; r.revenue += rev; r.cost += cost; r.qty += p.qty;
        pr.soldQty += p.qty; pr.revenue += rev; pr.cost += cost; pr.qty += p.qty;
      } else {
        r.returnedQty += p.qty; r.revenue -= rev; r.cost -= cost; r.qty -= p.qty;
        pr.returnedQty += p.qty; pr.revenue -= rev; pr.cost -= cost; pr.qty -= p.qty;
      }
    });
    Object.keys(rows).forEach(function (k) {
      var r = rows[k]; r.revenue = Math.round(r.revenue); r.cost = Math.round(r.cost);
      Object.keys(r.products).forEach(function (pid) { var p = r.products[pid]; p.revenue = Math.round(p.revenue); p.cost = Math.round(p.cost); });
    });
    return rows;
  }

  // Bir təchizatçının malı olan çeklər və qaytarmalar (günün sonunda təchizatçıya göndəriləcək sənəd üçün).
  // Hər çekdə YALNIZ bu təchizatçının hissəsi: [{kind:'sale'|'ret', id, receiptNo, at, qty, revenue, cost, lines:[{lineIndex, productId, name, price, qty, revenue, cost}]}] (zamana görə).
  // Qaytarmada say/məbləğ mənfidir. Sətrin məbləği qəpiyə yuvarlaqlaşdırılır, çekin yekunu sətirlərin cəmidir (sənəd öz daxilində uzlaşır).
  function supplierReceipts(res, sales, returns, supplierId, from, to) {
    var by = {}, list = [], want = supplierId || null;
    walkParts(res, sales, returns, from, to, function (kind, doc, i, l, p, rev, cost) {
      if ((p.supplierId || null) !== want) return;
      var key = kind + ':' + doc.id;
      var r = by[key];
      if (!r) { r = by[key] = { kind: kind, id: doc.id, receiptNo: doc.receiptNo, at: doc.at, qty: 0, revenue: 0, cost: 0, lines: {} }; list.push(r); }
      var sg = kind === 'sale' ? 1 : -1;
      var ln = r.lines[i] || (r.lines[i] = { lineIndex: i, productId: l.productId, name: l.name, price: l.price, qty: 0, revenue: 0, cost: 0 });
      ln.qty += sg * p.qty; ln.revenue += sg * rev; ln.cost += sg * cost;
    });
    list.forEach(function (r) {
      r.lines = Object.keys(r.lines).map(function (k) { return r.lines[k]; }).sort(function (a, b) { return a.lineIndex - b.lineIndex; });
      r.lines.forEach(function (ln) { ln.revenue = Math.round(ln.revenue); ln.cost = Math.round(ln.cost); r.qty += ln.qty; r.revenue += ln.revenue; r.cost += ln.cost; });
    });
    return list.sort(function (a, b) { return cmp(a.at, b.at) || cmp(a.id, b.id); });
  }

  /* ---------- Təchizatçı hesabı (borc) ----------
     Borc = açılış borcu + hesablanan məbləğ − ödənişlər (+ ləğv edilmiş ödənişlər).
     Hesablanan məbləğin əsası təchizatçı üzrə seçilir (sup.debtBasis):
       'received' (defolt) — təchizatçıdan alınan mal: partiyanın sayı × alış qiyməti (mal qəbulu vaxtı ilə);
       'sold' — yalnız SATILMIŞ mal: FIFO ilə satılan hissənin alış qiyməti, qaytarmalar çıxılır (mal komissiyaya götürülübsə).
     Ödəniş T vaxtında "qüvvədədir": at < T və T-dən əvvəl ləğv edilməyib. T boşdursa — indiyə qədər hamısı. */
  function payActive(p, T) { return (!T || p.at < T) && !(p.voidedAt && (!T || p.voidedAt < T)); }
  function sumPays(pays, T) { return (pays || []).reduce(function (a, p) { return a + (payActive(p, T) ? p.amount : 0); }, 0); }
  function accrued(sup, lots, res, sales, returns, from, to) {
    // [from, to) aralığında hesablanan məbləğ (qəpik) və tərkibi
    var items = [], total = 0;
    if ((sup.debtBasis || 'received') === 'sold') {
      var rep = supplierReport(res, sales, returns, from, to)[sup.id];
      if (rep) {
        Object.keys(rep.products).forEach(function (pid) { var pr = rep.products[pid]; if (pr.cost || pr.qty) items.push({ productId: pid, qty: pr.qty, amount: pr.cost }); });
        total = rep.cost;
      }
    } else {
      (lots || []).forEach(function (l) {
        if (l.supplierId !== sup.id || (from && l.at < from) || (to && l.at >= to)) return;
        var amount = Math.round(l.qty * l.unitCost);
        items.push({ lotId: l.id, at: l.at, productId: l.productId, qty: l.qty, unitCost: l.unitCost, amount: amount });
        total += amount;
      });
      items.sort(function (a, b) { return cmp(a.at, b.at) || cmp(a.lotId, b.lotId); });
    }
    return { total: total, items: items };
  }
  function debtAt(sup, lots, pays, res, sales, returns, T) {
    return (sup.openingDebt || 0) + accrued(sup, lots, res, sales, returns, '', T).total - sumPays(pays, T);
  }

  // Dövr üzrə hesab çıxarışı. inp: {sup, lots, pays, res, sales, returns, from, to}
  // opening: dövrün əvvəlinə borc; accrued: dövrdə hesablanan; payments: dövrdə ödənənlər (dövrdə ləğv edilməyənlər); reversed: əvvəl ödənmiş, dövrdə ləğv edilmiş ödənişlər (borcu artırır); closing: dövrün sonuna borc.
  function supplierStatement(inp) {
    var sup = inp.sup, from = inp.from || '', to = inp.to || '', pays = inp.pays || [];
    var opening = debtAt(sup, inp.lots, pays, inp.res, inp.sales, inp.returns, from);      // from boşdursa "ən əvvəl": açılış borcu
    if (!from) opening = sup.openingDebt || 0;
    var acc = accrued(sup, inp.lots, inp.res, inp.sales, inp.returns, from, to);
    var paid = pays.filter(function (p) { return (!from || p.at >= from) && payActive(p, to); }).sort(function (a, b) { return cmp(a.at, b.at) || cmp(a.id, b.id); });
    var reversed = pays.filter(function (p) { return from && p.at < from && p.voidedAt && p.voidedAt >= from && (!to || p.voidedAt < to); });
    var paidTotal = paid.reduce(function (a, p) { return a + p.amount; }, 0), revTotal = reversed.reduce(function (a, p) { return a + p.amount; }, 0);
    var closing = debtAt(sup, inp.lots, pays, inp.res, inp.sales, inp.returns, to);
    var receipts = supplierReceipts(inp.res, inp.sales, inp.returns, sup.id, from, to);
    var tot = receipts.reduce(function (a, r) { a.qty += r.qty; a.revenue += r.revenue; a.cost += r.cost; return a; }, { qty: 0, revenue: 0, cost: 0 });
    var unpriced = (inp.lots || []).filter(function (l) { return l.supplierId === sup.id && !l.unitCost && (!to || l.at < to); }).length;
    return { basis: sup.debtBasis || 'received', openingDebt: sup.openingDebt || 0, opening: opening, accrued: acc.total, accruedItems: acc.items, payments: paid, paidTotal: paidTotal,
      reversed: reversed, reversedTotal: revTotal, closing: closing, receipts: receipts, sales: tot, unpricedLots: unpriced };
  }

  var Fifo = { replay: replay, onHand: onHand, productLots: productLots, supplierReport: supplierReport, supplierReceipts: supplierReceipts, supplierStatement: supplierStatement, debtAt: debtAt, payActive: payActive };
  root.Fifo = Fifo;
  if (typeof module !== 'undefined') module.exports = Fifo;
})(typeof window !== 'undefined' ? window : globalThis);
