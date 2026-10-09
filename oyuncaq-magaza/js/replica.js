/* Digər cihazlardan gələn hadisələri bu cihazın lokal bazasına tətbiq edir (çoxcihazlı sinxron).
   Hər səhifə (hadisələr + server kursoru) BİR tranzaksiyada yazılır: yarımçıq tətbiq və ya təkrar tətbiq olmur.
   Qaydalar: istifadəçi/məhsul/ayar dəyişikliklərində "son yazan qalib" (updatedAt / hadisə vaxtı), qalıq isə hadisələrin cəmindən formalaşır. */
(function (root) {
  'use strict';
  var DB = root.DB, Rules = root.Rules;
  var EPOCH = '1970-01-01T00:00:00.000Z';
  var STORES = ['users', 'products', 'sales', 'returns', 'shifts', 'cashMoves', 'stockMoves', 'approvals', 'meta', 'audit'];
  var MASTER_FIELDS = ['name', 'category', 'brand', 'ageGroup', 'mfrBarcode', 'price', 'minStock', 'active'];

  // Outbox id-sindən audit id-sini çıxarır: yeni "vaxt_000123_a_uuid" və köhnə "vaxt_a_uuid" formatı
  function auditIdOf(eventId) {
    var p = String(eventId).split('_');
    return (p.length > 2 && /^\d{6}$/.test(p[1]) ? p.slice(2) : p.slice(1)).join('_');
  }

  function note(t, entry) {
    return t.get('meta', 'conflicts').then(function (m) {
      var list = m ? m.value : [];
      entry.at = new Date().toISOString();
      list.push(entry);
      if (list.length > 100) list = list.slice(-100);
      return t.put('meta', { key: 'conflicts', value: list });
    });
  }

  // Ardıcıl icra (hər addım əvvəlkinin nəticəsini görür)
  function each(list, fn) {
    return list.reduce(function (chain, x, i) { return chain.then(function () { return fn(x, i); }); }, Promise.resolve());
  }

  var H = {};

  H['user.upserted'] = function (t, ev, d, sum) {
    var nu = d.user; if (!nu || !nu.id) return;
    return t.get('users', nu.id).then(function (cur) {
      if (cur && (cur.updatedAt || EPOCH) >= (nu.updatedAt || EPOCH)) return;
      sum.touched.users = true;
      return t.put('users', nu);
    });
  };

  H['admin.matrix_changed'] = function (t, ev, d, sum) {
    if (!d.after) return;
    return t.get('meta', 'matrixAt').then(function (m) {
      if (m && m.value >= ev.at) return;
      sum.touched.matrix = true;
      return t.put('meta', { key: 'matrix', value: d.after }).then(function () { return t.put('meta', { key: 'matrixAt', value: ev.at }); });
    });
  };

  H['admin.store_changed'] = function (t, ev, d, sum) {
    if (!d.store) return;
    return t.get('meta', 'storeAt').then(function (m) {
      if (m && m.value >= ev.at) return;
      sum.touched.store = true;
      return t.put('meta', { key: 'store', value: d.store }).then(function () { return t.put('meta', { key: 'storeAt', value: ev.at }); });
    });
  };

  H['product.created'] = function (t, ev, d, sum) {
    var p = d.product; if (!p || !p.id) return;
    return t.get('products', p.id).then(function (cur) {
      if (cur) return;
      return t.byIndex('products', 'storeBarcode', p.storeBarcode).then(function (dups) {
        if (dups.length) {
          // İki cihaz eyni barkodu vermiş (nömrə aralığı təyin olunmamış köhnə rejim). Barkod unikal olmalıdır, ona görə məhsul yazılmır, istifadəçiyə bildirilir.
          return note(t, { kind: 'barcode', message: 'Eyni mağaza barkodu iki məhsulda: "' + p.name + '" və "' + dups[0].name + '" (' + p.storeBarcode + ')', productId: p.id });
        }
        sum.touched.products = true;
        return t.put('products', p);
      });
    });
  };

  H['product.updated'] = function (t, ev, d, sum) {
    var after = d.after, id = d.id || (after && after.id); if (!after || !id) return;
    return t.get('products', id).then(function (cur) {
      if (!cur || (cur.updatedAt || '') > ev.at) return;
      MASTER_FIELDS.forEach(function (k) { if (k in after) cur[k] = after[k]; });
      cur.updatedAt = ev.at;
      sum.touched.products = true;
      return t.put('products', cur);
    });
  };

  H['stock.received'] = function (t, ev, d, sum) {
    return t.get('products', d.productId).then(function (p) {
      if (!p) return;
      var before = p.stock;
      Object.assign(p, Rules.applyReceipt(p, d.qty, d.unitCost));
      sum.touched.products = true;
      return t.put('products', p).then(function () {
        return t.put('stockMoves', { id: 'sm_' + ev.id, productId: p.id, type: 'receipt', qty: d.qty, before: before, after: p.stock, unitCost: d.unitCost, note: 'başqa cihaz', at: ev.at, userId: ev.userId });
      });
    });
  };

  H['sale.created'] = function (t, ev, d, sum) {
    var sale = d.sale; if (!sale || !sale.id) return;
    return t.get('sales', sale.id).then(function (cur) {
      if (cur) return;
      return t.byIndex('sales', 'receiptNo', sale.receiptNo).then(function (dups) {
        var chain = dups.length ? note(t, { kind: 'receipt', message: 'Çek № ' + sale.receiptNo + ' iki cihazda verilib (hər ikisi saxlanıldı)', saleId: sale.id }) : Promise.resolve();
        return chain.then(function () {
          return each(sale.lines, function (l, i) {
            return t.get('products', l.productId).then(function (p) {
              if (!p) return;
              var before = p.stock;
              p.stock -= l.qty;
              if (l.negative) p.negSalesSinceReceipt = (p.negSalesSinceReceipt || 0) + 1;
              return t.put('products', p).then(function () {
                return t.put('stockMoves', { id: 'sm_' + ev.id + '_' + i, productId: p.id, type: 'sale', qty: -l.qty, before: before, after: p.stock, ref: sale.id, at: sale.at, userId: sale.cashierId });
              });
            });
          });
        }).then(function () { sum.touched.sales = true; sum.touched.products = true; return t.put('sales', sale); });
      });
    });
  };

  H['return.created'] = function (t, ev, d, sum) {
    var ret = d.ret; if (!ret || !ret.id) return;
    return t.get('returns', ret.id).then(function (cur) {
      if (cur) return;
      return each(ret.lines, function (l, i) {
        return t.get('products', l.productId).then(function (p) {
          if (!p) return;
          var before = p.stock; p.stock += l.qty;
          return t.put('products', p).then(function () {
            return t.put('stockMoves', { id: 'sm_' + ev.id + '_' + i, productId: p.id, type: 'return', qty: l.qty, before: before, after: p.stock, ref: ret.id, at: ret.at, userId: ret.userId });
          });
        });
      }).then(function () { sum.touched.sales = true; sum.touched.products = true; return t.put('returns', ret); });
    });
  };

  function shiftHandler(t, ev, d, sum) {
    var sh = d.shift; if (!sh || !sh.id) return;
    return t.get('shifts', sh.id).then(function (cur) {
      if (cur && cur.status === 'closed') return;   // bağlanmış növbə yenidən açılmır
      sum.touched.shifts = true;
      return t.put('shifts', sh);
    });
  }
  H['shift.opened'] = shiftHandler;
  H['shift.closed'] = shiftHandler;

  function cashHandler(t, ev, d, sum) {
    var m = d.move; if (!m || !m.id) return;
    return t.get('cashMoves', m.id).then(function (cur) { if (cur) return; sum.touched.shifts = true; return t.put('cashMoves', m); });
  }
  H['cash.in'] = cashHandler;
  H['cash.out'] = cashHandler;

  H['approval.requested'] = function (t, ev, d, sum) {
    var a = d.approval; if (!a || !a.id) return;
    return t.get('approvals', a.id).then(function (cur) {
      if (cur) return;
      sum.touched.approvals = true;
      return t.put('approvals', a);
    });
  };

  H['approval.decided'] = function (t, ev, d, sum) {
    return t.get('approvals', d.id).then(function (a) {
      if (!a || a.status !== 'pending') return;      // ilk cavab qalib gəlir
      a.status = d.decision; a.decidedBy = d.by || null; a.decidedAt = d.decidedAt || ev.at;
      sum.touched.approvals = true;
      return t.put('approvals', a);
    });
  };

  function applyOne(t, ev, sum) {
    var handler = H[ev.type];
    if (!handler) { sum.ignored++; return Promise.resolve(); }
    return t.get('audit', auditIdOf(ev.id)).then(function (own) {
      if (own) { sum.own++; return; }          // bu cihazın öz hadisəsi (köhnə formatda mənşə qeyd olunmayıb)
      sum.applied++;
      return handler(t, ev, ev.data || {}, sum);
    });
  }

  // events: serverdən gələn (öz cihazımızınkı istisna) hadisələr, next: yeni server kursoru.
  // Eyni brauzerin iki tabı eyni səhifəni yükləyə bilər: kursor tranzaksiya DAXİLİNDƏ yoxlanılır ki, qalıq iki dəfə dəyişməsin.
  // opts.force: kursoru olduğu kimi qoyur (server cədvəli təmizlənibsə geri çəkmək üçün).
  function apply(events, next, opts) {
    var sum = { applied: 0, own: 0, ignored: 0, touched: {} };
    return DB.atomic(STORES, function (t) {
      return t.get('meta', 'syncCursor').then(function (m) {
        var cur = m ? m.value : 0;
        var force = !!(opts && opts.force);
        if (!force && cur >= next) return;                       // başqa tab artıq tətbiq edib
        var fresh = force ? events : events.filter(function (ev) { return !(ev.seq <= cur); });
        return each(fresh, function (ev) {
          // Bir hadisənin məntiq xətası bütün səhifəni dayandırmasın; IndexedDB xətaları isə tranzaksiyanı ləğv edir və təkrar cəhd olunur
          return Promise.resolve().then(function () { return applyOne(t, ev, sum); }).catch(function (e) {
            if (typeof DOMException !== 'undefined' && e instanceof DOMException) throw e;
            return note(t, { kind: 'apply', message: 'Hadisə tətbiq olunmadı (' + ev.type + '): ' + (e && e.message), eventId: ev.id });
          });
        }).then(function () { return t.put('meta', { key: 'syncCursor', value: next }); });
      });
    }).then(function () { return sum; });
  }

  function cursor() { return DB.get('meta', 'syncCursor').then(function (m) { return m ? m.value : 0; }); }
  function setCursor(n) { return DB.put('meta', { key: 'syncCursor', value: n }); }

  root.Replica = { apply: apply, cursor: cursor, setCursor: setCursor, auditIdOf: auditIdOf };
  if (typeof module !== 'undefined') module.exports = root.Replica;
})(typeof window !== 'undefined' ? window : globalThis);
