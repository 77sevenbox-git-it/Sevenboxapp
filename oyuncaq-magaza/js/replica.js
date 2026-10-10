/* Digər cihazlardan gələn hadisələri bu cihazın lokal bazasına tətbiq edir (çoxcihazlı sinxron).
   Hər səhifə (hadisələr + server kursoru) BİR tranzaksiyada yazılır: yarımçıq tətbiq və ya təkrar tətbiq olmur.
   Qaydalar: istifadəçi/məhsul/ayar dəyişikliklərində "son yazan qalib" (updatedAt / hadisə vaxtı), qalıq isə hadisələrin cəmindən formalaşır. */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var DB = root.DB, Rules = root.Rules;
  var EPOCH = '1970-01-01T00:00:00.000Z';
  var STORES = ['users', 'products', 'sales', 'returns', 'shifts', 'cashMoves', 'stockMoves', 'approvals', 'suppliers', 'lots', 'supplierPays', 'meta', 'audit'];
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

  // "Son yazan qalib": yeni dəyər cari dəyərdən sonradır? Vaxt eynidirsə (eyni millisaniyədə iki cihaz) məzmun həkəmdir ki, bütün cihazlar eyni nəticəyə gəlsin
  function newer(atNew, vNew, atCur, vCur) {
    if (atNew !== atCur) return atNew > atCur;
    return JSON.stringify(vNew) > JSON.stringify(vCur);
  }

  var H = {};

  H['user.upserted'] = function (t, ev, d, sum) {
    var nu = d.user; if (!nu || !nu.id) return;
    return t.get('users', nu.id).then(function (cur) {
      if (cur && !newer(nu.updatedAt || EPOCH, nu, cur.updatedAt || EPOCH, cur)) return;
      sum.touched.users = true;
      return t.put('users', nu);
    });
  };

  H['admin.matrix_changed'] = function (t, ev, d, sum) {
    if (!d.after) return;
    // köhnə versiyalı cihazdan gələn matris yeni "stock.receive" icazəsini bilmir: eyni qaydayla yenilənir
    var after = d.v >= Rules.MATRIX_VERSION ? d.after : Rules.upgradeMatrix(d.after);
    return Promise.all([t.get('meta', 'matrixAt'), t.get('meta', 'matrix')]).then(function (r) {
      var m = r[0];
      if (m && !newer(ev.at, after, m.value, r[1] && r[1].value)) return;
      sum.touched.matrix = true;
      return t.put('meta', { key: 'matrix', value: after }).then(function () { return t.put('meta', { key: 'matrixAt', value: ev.at }); });
    });
  };

  // Rol üzrə giriş forması (PIN/şifrə): matris kimi "son yazan qalib". Köhnə cihaz bu hadisəni tanımır və atlayır (səhv deyil).
  H['admin.auth_policy_changed'] = function (t, ev, d, sum) {
    if (!d.after) return;
    var after = Rules.normalizeAuth(d.after);
    return Promise.all([t.get('meta', 'authPolicyAt'), t.get('meta', 'authPolicy')]).then(function (r) {
      var m = r[0];
      if (m && !newer(ev.at, after, m.value, r[1] && r[1].value)) return;
      sum.touched.users = true;
      return t.put('meta', { key: 'authPolicy', value: after }).then(function () { return t.put('meta', { key: 'authPolicyAt', value: ev.at }); });
    });
  };

  H['admin.store_changed'] = function (t, ev, d, sum) {
    if (!d.store) return;
    return Promise.all([t.get('meta', 'storeAt'), t.get('meta', 'store')]).then(function (r) {
      var m = r[0];
      if (m && !newer(ev.at, d.store, m.value, r[1] && r[1].value)) return;
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
          return note(t, { kind: 'barcode', message: _t('Eyni mağaza barkodu iki məhsulda: "{0}" və "{1}" ({2})', [p.name, dups[0].name, p.storeBarcode]), productId: p.id });
        }
        sum.touched.products = true;
        return t.put('products', p);
      });
    });
  };

  H['product.updated'] = function (t, ev, d, sum) {
    var after = d.after, id = d.id || (after && after.id); if (!after || !id) return;
    return t.get('products', id).then(function (cur) {
      // "Son yazan qalib": vaxt eynidirsə cihaz nömrəsi həkəmdir ki, bütün cihazlar eyni nəticəyə gəlsin
      if (!cur || (cur.updatedAt || '') + '|' + (cur.updatedDev || '') > ev.at + '|' + (ev.device || '')) return;
      MASTER_FIELDS.forEach(function (k) { if (k in after) cur[k] = after[k]; });
      cur.updatedAt = ev.at; cur.updatedDev = ev.device || '';
      sum.touched.products = true;
      return t.put('products', cur);
    });
  };

  // Mal qəbulu partiyası (FIFO üçün): bütün cihazlarda eyni id, eyni vaxt, eyni təchizatçı. Təkrar tətbiqdə dəyişmir.
  function putLot(t, ev, d, sum) {
    if (!d.lotId) return Promise.resolve();            // köhnə versiyalı cihazdan gələn qəbul: partiyası yoxdur, qalıq "açılış partiyasında" sayılır
    return t.get('lots', d.lotId).then(function (cur) {
      if (cur) return;
      sum.touched.lots = true;
      var lot = { id: d.lotId, productId: d.productId, supplierId: d.supplierId || null, qty: d.qty, unitCost: d.unitCost, at: d.at || ev.at, userId: ev.userId, note: d.note || '' };
      if (d.approvalId) lot.approvalId = d.approvalId;            // təsdiq sorğusundan gələn partiya bütün cihazlarda eyni görünsün
      return t.put('lots', lot);
    });
  }

  // Təsdiqlənmiş mal qəbulu sorğusu (d.approvalId): partiyanın id-si sorğudan törəyir (lot_<sorğu id>). İki menecer eyni sorğunu eyni anda
  // fərqli cihazlarda təsdiqləsə, qalıq iki dəfə artmır: yalnız qalib qərar qalır (sorğuların qaydası ilə eyni — daha erkən qərar; bərabərdirsə id-si kiçik olan).
  // Qalibin sayı/qiyməti/təchizatçısı fərqlidirsə partiya və qalıq qalibə düzəldilir (orta maya düzəlmir, yalnız son qiymət).
  function receivedFromApproval(t, ev, d, sum, cur) {
    var inAt = d.at || ev.at, inKey = inAt + '|' + (ev.userId || ''), curKey = (cur.at || '') + '|' + (cur.userId || '');
    if (inKey >= curKey) return Promise.resolve();                       // bizdəki qərar qalibdir (və ya eynidir)
    return t.get('products', d.productId).then(function (p) {
      var delta = d.qty - cur.qty;
      return Promise.resolve().then(function () {
        if (!p) return;
        if (delta) {
          var before = p.stock; p.stock += delta; sum.touched.products = true;
          return t.put('products', p).then(function () { return t.put('stockMoves', { id: 'sm_' + ev.id, productId: p.id, type: 'correction', qty: delta, before: before, after: p.stock, unitCost: d.unitCost, note: 'təsdiq düzəlişi', at: ev.at, userId: ev.userId }); });
        }
      }).then(function () {
        sum.touched.lots = true;
        return t.put('lots', { id: d.lotId, productId: d.productId, supplierId: d.supplierId || null, qty: d.qty, unitCost: d.unitCost, at: inAt, userId: ev.userId, note: d.note || '', approvalId: d.approvalId });
      });
    });
  }

  H['stock.received'] = function (t, ev, d, sum) {
    var existing = d.approvalId && d.lotId ? t.get('lots', d.lotId) : Promise.resolve(null);
    return existing.then(function (cur) {
      if (cur) return receivedFromApproval(t, ev, d, sum, cur);
      return t.get('products', d.productId).then(function (p) {
        if (!p) return;
        var before = p.stock;
        Object.assign(p, Rules.applyReceipt(p, d.qty, d.unitCost));
        sum.touched.products = true;
        return t.put('products', p).then(function () {
          return t.put('stockMoves', { id: 'sm_' + ev.id, productId: p.id, type: 'receipt', qty: d.qty, before: before, after: p.stock, unitCost: d.unitCost, note: 'başqa cihaz', at: ev.at, userId: ev.userId });
        }).then(function () { return putLot(t, ev, d, sum); });
      });
    });
  };

  function putSupplier(t, d, sum) {
    var ns = d.supplier; if (!ns || !ns.id) return Promise.resolve();
    return t.get('suppliers', ns.id).then(function (cur) {
      if (cur && !newer(ns.updatedAt || EPOCH, ns, cur.updatedAt || EPOCH, cur)) return;
      sum.touched.suppliers = true;
      return t.put('suppliers', ns);
    });
  }
  H['supplier.upserted'] = function (t, ev, d, sum) { return putSupplier(t, d, sum); };

  // Köhnə versiyadan yeniləndikdən sonra bir dəfəlik "doldurma": keçmişdə buraxılmış təchizatçı və partiya hadisələri yenidən oxunur.
  // Yalnız təkrar tətbiq təhlükəsiz (idempotent) hadisələr işlənir; qalıq, çek və s. toxunulmaz qalır.
  var BACKFILL = {
    'supplier.upserted': function (t, ev, d, sum) { return putSupplier(t, d, sum); },
    'supplier.paid': function (t, ev, d, sum) { return putPay(t, ev, d, sum); },
    'supplier.pay_voided': function (t, ev, d, sum) { return voidPay(t, ev, d, sum); },
    'stock.received': function (t, ev, d, sum) { return putLot(t, ev, d, sum); }
  };
  function backfill(events) {
    var sum = { applied: 0, touched: {} };
    return DB.atomic(['suppliers', 'lots', 'supplierPays'], function (t) {
      return each(events, function (ev) {
        var fn = BACKFILL[ev.type]; if (!fn) return;
        sum.applied++;
        return fn(t, ev, ev.data || {}, sum);
      });
    }).then(function () { return sum; });
  }

  H['sale.created'] = function (t, ev, d, sum) {
    var sale = d.sale; if (!sale || !sale.id) return;
    return t.get('sales', sale.id).then(function (cur) {
      if (cur) return;
      return t.byIndex('sales', 'receiptNo', sale.receiptNo).then(function (dups) {
        var chain = dups.length ? note(t, { kind: 'receipt', message: _t('Çek № {0} iki cihazda verilib (hər ikisi saxlanıldı)', [sale.receiptNo]), saleId: sale.id }) : Promise.resolve();
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
      // Bağlanmış növbə yenidən açılmır; iki cihaz eyni növbəni bağlayıbsa ilk bağlama hər yerdə qalır
      if (cur && cur.status === 'closed' && (sh.status !== 'closed' || (cur.closedAt || '') <= (sh.closedAt || ''))) return;
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

  // Təchizatçıya ödəniş (nağd olarsa kassa hərəkəti ayrıca cash.out hadisəsi ilə gəlir). Eyni id təkrar yazılmır.
  function putPay(t, ev, d, sum) {
    var p = d.pay; if (!p || !p.id) return Promise.resolve();
    return t.get('supplierPays', p.id).then(function (cur) {
      if (cur) return;
      sum.touched.suppliers = true;
      return t.put('supplierPays', p);
    });
  }
  H['supplier.paid'] = putPay;
  // Ləğv: ilk ləğv qalib gəlir (iki cihaz eyni anda ləğv edərsə vaxtı erkən olan, bərabərdirsə id-si kiçik olan). Ödəniş hələ gəlməyibsə (nadir) hadisə atılır.
  function voidPay(t, ev, d, sum) {
    return t.get('supplierPays', d.id).then(function (cur) {
      if (!cur) return;
      var by = (d.by && d.by.id) || '';
      if (cur.voidedAt && cur.voidedAt + '|' + (cur.voidedBy || '') <= d.at + '|' + by) return;
      cur.voidedAt = d.at; cur.voidedBy = by; cur.voidedByName = (d.by && d.by.name) || ''; cur.voidReason = d.reason || ''; cur.updatedAt = d.at;
      sum.touched.suppliers = true;
      return t.put('supplierPays', cur);
    });
  }
  H['supplier.pay_voided'] = voidPay;

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
      if (!a) return;
      var at = d.decidedAt || ev.at, by = (d.by && d.by.id) || '';
      // İlk cavab qalib gəlir. İki cihaz eyni anda fərqli cavab veribsə, vaxtı erkən olan (bərabərdirsə id-si kiçik olan) hər yerdə qalır
      if (a.status !== 'pending' && (a.decidedAt || '') + '|' + ((a.decidedBy && a.decidedBy.id) || '') <= at + '|' + by) return;
      a.status = d.decision; a.decidedBy = d.by || null; a.decidedAt = at; a.result = d.result || null;
      sum.touched.approvals = true;
      return t.put('approvals', a);
    });
  };

  /* ---------- Gələn hadisənin quruluş yoxlaması ----------
     Serverdən gələn hadisəni yazan şəxs (səhv versiyalı cihaz və ya açarı bilən hücumçu) mətn əvəzinə obyekt, NaN qalıq, mənfi say, nəhəng sətir və s. göndərə bilər.
     Belə hadisə bazaya yazılmır və sinxronu dondurmur: rədd edilir və «konfliktlər» siyahısına düşür. Yoxlama yalnız tip və hüdudlara baxır:
     düzgün görünən saxta hadisəni (məs. başqasının adından təsdiq) tanımaq mümkün deyil — bu, serverdə istifadəçi yoxlaması olmayan arxitekturanın məhdudiyyətidir. */
  var MONEY_MAX = 1e10, QTY_MAX = 1e6, STOCK_MAX = 1e7;
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function sOk(x, max) { return typeof x === 'string' && x.length <= max; }
  function idOk(x) { return typeof x === 'string' && x.length > 0 && x.length <= 120; }
  function nameOk(x, max) { return typeof x === 'string' && x.length > 0 && x.length <= max; }
  function iOk(x, lo, hi) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x && x >= lo && x <= hi; }
  function nOk(x, lo, hi) { return typeof x === 'number' && isFinite(x) && x >= lo && x <= hi; }
  function oS(o, k, max) { return o[k] == null || sOk(o[k], max); }
  function oN(o, k, lo, hi) { return o[k] == null || nOk(o[k], lo, hi); }
  function oI(o, k, lo, hi) { return o[k] == null || iOk(o[k], lo, hi); }
  function oB(o, k) { return o[k] == null || typeof o[k] === 'boolean'; }
  function oId(o, k) { return o[k] == null || o[k] === '' || idOk(o[k]); }
  function eanOk(x) { return typeof x === 'string' && x.length === 13 && !!root.Barcode && root.Barcode.isValidEan13(x); }      // yanlış EAN çap ekranını (etiket/çek) çökdürərdi
  function small(x, max) { try { return JSON.stringify(x).length <= max; } catch (e) { return false; } }
  function arr(a, lo, hi, fn) { return Array.isArray(a) && a.length >= lo && a.length <= hi && a.every(fn); }
  var own = Object.prototype.hasOwnProperty;

  function masterOk(a) {                       // product.updated.after / product.created.product ortaq sahələri (olan sahələr yoxlanır)
    return isObj(a) && (!('name' in a) || nameOk(a.name, 200)) && oS(a, 'category', 200) && oS(a, 'brand', 200) && oS(a, 'ageGroup', 200) && oS(a, 'mfrBarcode', 500) &&
      (!('price' in a) || iOk(a.price, 0, MONEY_MAX)) && oI(a, 'minStock', 0, QTY_MAX) && oB(a, 'active');
  }
  // "p1$" ilə başlayan hash şifrə (PBKDF2) formasıdır: təkrar sayı ağlabatan olmalıdır (saxta hadisə ilə milyardlıq təkrar sayı bütün cihazları dondura bilməz)
  function hashOk(h) {
    if (h.indexOf('p1$') !== 0) return true;
    var m = /^p1\$(\d{5,7})\$[0-9a-f]{64}$/.exec(h);
    return !!m && parseInt(m[1], 10) >= 10000 && parseInt(m[1], 10) <= 1000000;
  }
  var CHECK = {
    'user.upserted': function (d) {
      var u = d.user; return isObj(u) && idOk(u.id) && nameOk(u.name, 80) && typeof u.role === 'string' && own.call(Rules.ROLE_NAMES, u.role) && sOk(u.salt, 200) && sOk(u.pinHash, 200) && hashOk(u.pinHash) && oB(u, 'active') && oB(u, 'mustChangePin') && oS(u, 'updatedAt', 40);
    },
    'admin.auth_policy_changed': function (d) {
      var a = d.after; if (!isObj(a)) return false;
      var keys = Object.keys(a); if (!keys.length || keys.length > 10) return false;
      return keys.every(function (r) { return own.call(Rules.ROLE_NAMES, r) && Rules.AUTH_FORMS.indexOf(a[r]) !== -1; });
    },
    'product.created': function (d) {
      var p = d.product; return masterOk(p) && idOk(p.id) && nameOk(p.name, 200) && iOk(p.price, 0, MONEY_MAX) && eanOk(p.storeBarcode) && oN(p, 'avgCost', 0, MONEY_MAX) && oN(p, 'lastCost', 0, MONEY_MAX) && oI(p, 'stock', -STOCK_MAX, STOCK_MAX);
    },
    'product.updated': function (d) { var a = d.after; return isObj(a) && idOk(d.id || a.id) && masterOk(a); },
    'stock.received': function (d) {
      return idOk(d.productId) && iOk(d.qty, 1, QTY_MAX) && nOk(d.unitCost, 0, MONEY_MAX) && oId(d, 'lotId') && oId(d, 'approvalId') && oId(d, 'supplierId') && oS(d, 'note', 500) && oS(d, 'at', 40);
    },
    'supplier.upserted': function (d) {
      var s = d.supplier; return isObj(s) && idOk(s.id) && nameOk(s.name, 200) && oS(s, 'phone', 500) && oS(s, 'note', 500) && oB(s, 'active') && oS(s, 'updatedAt', 40) &&
        (s.debtBasis == null || s.debtBasis === 'received' || s.debtBasis === 'sold') && (s.openingDebt == null || iOk(s.openingDebt, -MONEY_MAX, MONEY_MAX));
    },
    'supplier.paid': function (d) {
      var p = d.pay; return payOk(p);
    },
    'supplier.pay_voided': function (d) {
      return idOk(d.id) && sOk(d.at, 40) && oS(d, 'reason', 500) && (d.by == null || (isObj(d.by) && oId(d.by, 'id') && oS(d.by, 'name', 80))) && (d.pay == null || payOk(d.pay));
    },
    'sale.created': function (d) {
      var s = d.sale; if (!isObj(s) || !idOk(s.id) || !iOk(s.receiptNo, 0, 1e9) || !sOk(s.at, 40) || !oS(s, 'shiftId', 120) || !oS(s, 'cashierId', 120) || !oS(s, 'cashierName', 80) || !(s.receiptBarcode == null || eanOk(s.receiptBarcode))) return false;
      if (!arr(s.lines, 1, 500, function (l) { return isObj(l) && idOk(l.productId) && nameOk(l.name, 200) && iOk(l.qty, 1, QTY_MAX) && nOk(l.price, 0, MONEY_MAX) && oN(l, 'unitCost', 0, MONEY_MAX) && oS(l, 'storeBarcode', 40); })) return false;
      var t = s.totals, p = s.payment;
      if (!isObj(t) || !nOk(t.subtotal, 0, MONEY_MAX) || !nOk(t.total, 0, MONEY_MAX) || !oN(t, 'discount', 0, MONEY_MAX)) return false;
      if (!isObj(p) || ['cash', 'bank', 'mixed'].indexOf(p.method) === -1 || (p.bankType != null && p.bankType !== 'pos' && p.bankType !== 'transfer')) return false;
      if (!oN(p, 'cashPart', 0, MONEY_MAX) || !oN(p, 'bankPart', 0, MONEY_MAX) || !oN(p, 'cashReceived', 0, MONEY_MAX) || !oN(p, 'change', 0, MONEY_MAX)) return false;
      if (s.discount != null && !(isObj(s.discount) && nOk(s.discount.percent, 0, 100) && oS(s.discount, 'approvedByName', 80) && oS(s.discount, 'approvedBy', 120))) return false;
      return s.fiscal == null || (isObj(s.fiscal) && oS(s.fiscal, 'status', 40) && (s.fiscal.id == null || sOk(s.fiscal.id, 120)));
    },
    'return.created': function (d) {
      var r = d.ret; return isObj(r) && idOk(r.id) && oS(r, 'saleId', 120) && sOk(r.at, 40) && nOk(r.amount, 0, MONEY_MAX) && oN(r, 'cashAmount', 0, MONEY_MAX) && oN(r, 'bankAmount', 0, MONEY_MAX) && (r.bankType == null || r.bankType === 'pos' || r.bankType === 'transfer') &&
        oS(r, 'reason', 500) && oS(r, 'approvedByName', 80) && oS(r, 'userId', 120) &&
        arr(r.lines, 1, 500, function (l) { return isObj(l) && idOk(l.productId) && nameOk(l.name, 200) && iOk(l.qty, 1, QTY_MAX) && nOk(l.price, 0, MONEY_MAX); });
    },
    'shift.opened': function (d) { return shiftOk(d.shift); },
    'shift.closed': function (d) { return shiftOk(d.shift); },
    'cash.in': function (d) { return moveOk(d.move); },
    'cash.out': function (d) { return moveOk(d.move); },
    'approval.requested': function (d) {
      var a = d.approval; return isObj(a) && idOk(a.id) && oS(a, 'kind', 60) && oS(a, 'perm', 60) && oS(a, 'status', 20) && oS(a, 'summary', 600) && oS(a, 'tk', 600) && (a.tp == null || (Array.isArray(a.tp) && a.tp.length <= 10 && small(a.tp, 1000))) && (a.payload == null || (isObj(a.payload) && small(a.payload, 5000))) && oS(a, 'at', 40);
    },
    'approval.decided': function (d) {
      return idOk(d.id) && ['approved', 'rejected', 'cancelled'].indexOf(d.decision) !== -1 && oS(d, 'decidedAt', 40) && (d.by == null || (isObj(d.by) && oId(d.by, 'id') && oS(d.by, 'name', 80))) && (d.result == null || (isObj(d.result) && small(d.result, 2000)));
    },
    'admin.matrix_changed': function (d) {
      var a = d.after; if (!isObj(a)) return false;
      var keys = Object.keys(a); if (!keys.length || keys.length > 10) return false;
      return keys.every(function (r) { return own.call(Rules.ROLE_NAMES, r) && arr(a[r], 0, 100, function (x) { return typeof x === 'string' && x.length <= 60; }); });
    },
    'admin.store_changed': function (d) {
      var s = d.store; if (!isObj(s)) return false;
      var keys = Object.keys(s); if (keys.length > 30) return false;
      return keys.every(function (k) { var v = s[k]; return v == null || typeof v === 'boolean' || nOk(v, -1e12, 1e12) || sOk(v, 300); });
    }
  };
  function shiftOk(s) { return isObj(s) && idOk(s.id) && (s.status === 'open' || s.status === 'closed') && sOk(s.openedAt, 40) && oS(s, 'closedAt', 40) && oS(s, 'note', 500) && oN(s, 'openingCash', -MONEY_MAX, MONEY_MAX) && oN(s, 'expectedCash', -MONEY_MAX, MONEY_MAX) && oN(s, 'countedCash', -MONEY_MAX, MONEY_MAX) && oN(s, 'diff', -MONEY_MAX, MONEY_MAX); }
  function payOk(p) {
    return isObj(p) && idOk(p.id) && idOk(p.supplierId) && iOk(p.amount, 1, MONEY_MAX) && (p.method === 'cash' || p.method === 'bank') && sOk(p.at, 40) && oS(p, 'note', 500) && oS(p, 'userName', 80) && oS(p, 'userId', 120) &&
      oS(p, 'supplierName', 200) && oS(p, 'shiftId', 120) && oId(p, 'cashMoveId') && oS(p, 'voidedAt', 40) && oS(p, 'voidReason', 500) && oS(p, 'updatedAt', 40);
  }
  function moveOk(m) { return isObj(m) && idOk(m.id) && oS(m, 'shiftId', 120) && nOk(m.amount, 0, MONEY_MAX) && oS(m, 'type', 40) && oS(m, 'reason', 500) && oS(m, 'at', 40) && oS(m, 'userId', 120); }

  function applyOne(t, ev, sum) {
    var handler = own.call(H, ev.type) ? H[ev.type] : null;
    if (!handler) { sum.ignored++; return Promise.resolve(); }
    return t.get('audit', auditIdOf(ev.id)).then(function (mine) {
      if (mine) { sum.own++; return; }          // bu cihazın öz hadisəsi (köhnə formatda mənşə qeyd olunmayıb)
      var d = isObj(ev.data) ? ev.data : {}, check = CHECK[ev.type], good = false;
      try { good = !check || check(d); } catch (e) { good = false; }
      if (!good) {
        sum.rejected = (sum.rejected || 0) + 1;
        return note(t, { kind: 'rejected', message: _t('Etibarsız hadisə rədd edildi ({0})', [ev.type]), eventId: ev.id });
      }
      sum.applied++;
      return handler(t, ev, d, sum);
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
            // Sinxron atılan DataError/DataCloneError (yanlış açar, köçürülə bilməyən dəyər) sorğu yaratmır, tranzaksiyanı pozmur: hadisənin öz xətasıdır. Qalanı (kvota, ləğv) təkrar cəhd üçündür.
            if (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name !== 'DataError' && e.name !== 'DataCloneError') throw e;
            return note(t, { kind: 'apply', message: _t('Hadisə tətbiq olunmadı ({0}): {1}', [ev.type, (e && e.message)]), eventId: ev.id });
          });
        }).then(function () { return t.put('meta', { key: 'syncCursor', value: next }); });
      });
    }).then(function () { return sum; });
  }

  function cursor() { return DB.get('meta', 'syncCursor').then(function (m) { return m ? m.value : 0; }); }
  function setCursor(n) { return DB.put('meta', { key: 'syncCursor', value: n }); }

  root.Replica = { apply: apply, backfill: backfill, cursor: cursor, setCursor: setCursor, auditIdOf: auditIdOf };
  if (typeof module !== 'undefined') module.exports = root.Replica;
})(typeof window !== 'undefined' ? window : globalThis);
