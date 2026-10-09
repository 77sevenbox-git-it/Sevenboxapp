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

  // Dövr üzrə təchizatçı hesabatı. [from, to) — ISO vaxt. Satışlar vaxtı ilə, qaytarmalar öz vaxtı ilə dövrə düşür.
  // Gəlir: endirimdən sonrakı satış məbləği (qəpik, çekin yekunu ilə uzlaşır), qaytarma isə qaytarılan pul məbləğidir.
  // Qaytarır: { rows: {supplierKey: {supplierId, soldQty, returnedQty, qty, revenue, cost, products:{pid:{...}}}} }
  function supplierReport(res, sales, returns, from, to) {
    var rows = {};
    function row(supplierId) { var k = supplierId || ''; return rows[k] || (rows[k] = { supplierId: supplierId || null, soldQty: 0, returnedQty: 0, qty: 0, revenue: 0, cost: 0, products: {} }); }
    function prod(r, pid) { return r.products[pid] || (r.products[pid] = { productId: pid, soldQty: 0, returnedQty: 0, qty: 0, revenue: 0, cost: 0 }); }
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
        parts.forEach(function (p) {
          var r = row(p.supplierId), pr = prod(r, l.productId), rev = lineNet * p.qty / l.qty, cost = p.qty * p.unitCost;
          r.soldQty += p.qty; r.revenue += rev; r.cost += cost; r.qty += p.qty;
          pr.soldQty += p.qty; pr.revenue += rev; pr.cost += cost; pr.qty += p.qty;
        });
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
        parts.forEach(function (p) {
          var r = row(p.supplierId), pr = prod(r, l.productId), rev = share * p.qty / l.qty, cost = p.qty * p.unitCost;
          r.returnedQty += p.qty; r.revenue -= rev; r.cost -= cost; r.qty -= p.qty;
          pr.returnedQty += p.qty; pr.revenue -= rev; pr.cost -= cost; pr.qty -= p.qty;
        });
      });
    });
    Object.keys(rows).forEach(function (k) {
      var r = rows[k]; r.revenue = Math.round(r.revenue); r.cost = Math.round(r.cost);
      Object.keys(r.products).forEach(function (pid) { var p = r.products[pid]; p.revenue = Math.round(p.revenue); p.cost = Math.round(p.cost); });
    });
    return rows;
  }

  var Fifo = { replay: replay, onHand: onHand, productLots: productLots, supplierReport: supplierReport };
  root.Fifo = Fifo;
  if (typeof module !== 'undefined') module.exports = Fifo;
})(typeof window !== 'undefined' ? window : globalThis);
