/* Tətbiq qatı: məhsul, satış, qaytarma, növbə, istifadəçi və audit əməliyyatları.
   Hər yazı əməliyyatı: icazə yoxlanır → atomik tranzaksiya → audit → outbox (serverə sinxron üçün). */
(function (root) {
  'use strict';
  var DB = root.DB, Rules = root.Rules, Money = root.Money, Barcode = root.Barcode;

  function err(msg, code) { var e = new Error(msg); e.code = code || 'error'; return e; }
  function now() { return new Date().toISOString(); }

  /* ---------- Təhlükəsizlik ---------- */
  function toHex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  function hashPin(pin, salt) {
    var data = new TextEncoder().encode(salt + ':' + pin);
    return root.crypto.subtle.digest('SHA-256', data).then(toHex);
  }
  function newSalt() { return toHex(root.crypto.getRandomValues(new Uint8Array(16))); }

  var session = { user: null };

  function matrix() { return DB.get('meta', 'matrix').then(function (m) { return m ? m.value : Rules.DEFAULT_MATRIX; }); }

  function requirePerm(perm, user) {
    user = user || session.user;
    if (!user) return Promise.reject(err('Daxil olun', 'auth'));
    return matrix().then(function (m) {
      if (!Rules.can(m, user.role, perm)) throw err('Bu əməliyyata icazəniz yoxdur: ' + (Rules.PERMISSIONS[perm] || perm), 'forbidden');
      return user;
    });
  }

  // Audit və outbox eyni tranzaksiyada yazılır ki, biri olub digəri olmasın
  function log(t, type, data, user) {
    var ts = now();
    var entry = { id: DB.uid('a'), at: ts, type: type, userId: user ? user.id : null, userName: user ? user.name : null, data: data };
    return t.put('audit', entry).then(function () {
      return t.put('outbox', { id: ts + '_' + entry.id, at: ts, type: type, data: data, userId: entry.userId });
    });
  }

  function nextSeq(t, key) {
    return t.get('meta', key).then(function (m) {
      var v = (m ? m.value : 0) + 1;
      return t.put('meta', { key: key, value: v }).then(function () { return v; });
    });
  }

  /* ---------- İlkin quraşdırma ---------- */
  var DEMO_USERS = [
    { name: 'Admin', role: 'admin', pin: '1234' },
    { name: 'Menecer', role: 'menecer', pin: '2222' },
    { name: 'Kassir', role: 'kassir', pin: '1111' },
    { name: 'Mühasib 1', role: 'muhasib', pin: '3333' },
    { name: 'Mühasib 2', role: 'muhasib', pin: '4444' }
  ];

  function init() {
    return DB.open().then(function () { return DB.get('meta', 'initialized'); }).then(function (done) {
      if (done) return;
      return Promise.all(DEMO_USERS.map(function (u) {
        var salt = newSalt();
        return hashPin(u.pin, salt).then(function (h) {
          return { id: DB.uid('u'), name: u.name, role: u.role, salt: salt, pinHash: h, active: true, mustChangePin: true };
        });
      })).then(function (users) {
        return DB.atomic(['users', 'meta'], function (t) {
          return Promise.all(users.map(function (u) { return t.put('users', u); })).then(function () {
            return Promise.all([
              t.put('meta', { key: 'matrix', value: Rules.DEFAULT_MATRIX }),
              t.put('meta', { key: 'store', value: { name: '[Mağaza adı]', voen: '[VÖEN]', address: '[Ünvan]', registerName: 'Kassa 1' } }),
              t.put('meta', { key: 'initialized', value: now() })
            ]);
          });
        });
      });
    });
  }

  function storeInfo() { return DB.get('meta', 'store').then(function (m) { return m.value; }); }

  /* ---------- Giriş ---------- */
  function listUsers() {
    return DB.getAll('users').then(function (us) {
      return us.filter(function (u) { return u.active; }).map(function (u) { return { id: u.id, name: u.name, role: u.role }; });
    });
  }

  var failed = {};
  function login(userId, pin) {
    var f = failed[userId] || { n: 0, until: 0 };
    if (Date.now() < f.until) return Promise.reject(err('Çox səhv cəhd. ' + Math.ceil((f.until - Date.now()) / 60000) + ' dəqiqə gözləyin', 'locked'));
    return DB.get('users', userId).then(function (u) {
      if (!u || !u.active) throw err('İstifadəçi tapılmadı');
      return hashPin(pin, u.salt).then(function (h) {
        if (h !== u.pinHash) {
          f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; } // SEC-06
          failed[userId] = f;
          return DB.atomic(['audit', 'outbox'], function (t) { return log(t, 'auth.failed', { userId: userId }, null); })
            .then(function () { throw err('PIN səhvdir'); });
        }
        failed[userId] = { n: 0, until: 0 };
        session.user = { id: u.id, name: u.name, role: u.role, mustChangePin: u.mustChangePin };
        return DB.atomic(['audit', 'outbox'], function (t) { return log(t, 'auth.login', {}, session.user); }).then(function () { return session.user; });
      });
    });
  }

  function logout() { session.user = null; }
  function currentUser() { return session.user; }

  function changePin(oldPin, newPin) {
    if (!/^\d{4,8}$/.test(newPin)) return Promise.reject(err('PIN 4–8 rəqəm olmalıdır'));
    if (/^(\d)\1+$/.test(newPin) || '0123456789'.indexOf(newPin) !== -1) return Promise.reject(err('Çox sadə PIN seçməyin'));
    var me = session.user;
    return DB.get('users', me.id).then(function (u) {
      return hashPin(oldPin, u.salt).then(function (h) {
        if (h !== u.pinHash) throw err('Köhnə PIN səhvdir');
        var salt = newSalt();
        return hashPin(newPin, salt).then(function (nh) {
          u.salt = salt; u.pinHash = nh; u.mustChangePin = false;
          return DB.atomic(['users', 'audit', 'outbox'], function (t) {
            return t.put('users', u).then(function () { return log(t, 'auth.pin_changed', {}, me); });
          }).then(function () { me.mustChangePin = false; });
        });
      });
    });
  }

  // Menecer təsdiqi: PIN kimə məxsusdursa və icazəsi varsa, onu qaytarır (SEC-04)
  function approveWithPin(pin, perm) {
    return Promise.all([DB.getAll('users'), matrix()]).then(function (r) {
      var candidates = r[0].filter(function (u) { return u.active && Rules.can(r[1], u.role, perm); });
      return Promise.all(candidates.map(function (u) { return hashPin(pin, u.salt).then(function (h) { return h === u.pinHash ? u : null; }); }))
        .then(function (res) {
          var u = res.filter(Boolean)[0];
          if (!u) throw err('PIN yanlışdır və ya bu şəxsin təsdiq icazəsi yoxdur');
          return { id: u.id, name: u.name, role: u.role };
        });
    });
  }

  /* ---------- Məhsullar ---------- */
  function listProducts() {
    return DB.getAll('products').then(function (ps) { return ps.sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); }); });
  }

  // Kassir alış qiymətini görmür (SEC-03): ekrana veriləndən əvvəl təmizlənir
  function sanitizeForRole(p, canSeeCost) {
    if (canSeeCost) return p;
    var c = Object.assign({}, p); delete c.avgCost; delete c.lastCost; return c;
  }

  function validateProductInput(d) {
    if (!d.name || !String(d.name).trim()) return 'Məhsulun adı boşdur';
    if (d.price == null || d.price <= 0) return 'Satış qiyməti 0-dan böyük olmalıdır';
    if (d.mfrBarcode) {
      if (!/^\d{8,14}$/.test(d.mfrBarcode)) return 'İstehsalçı barkodu 8–14 rəqəm olmalıdır';
      if (Barcode.isStoreBarcode(d.mfrBarcode) || Barcode.isReceiptBarcode(d.mfrBarcode)) return 'Bu, mağaza və ya çek barkodudur, istehsalçı barkodu deyil';
    }
    return null;
  }

  // Qaytarır: {product, warnings[]}. Təkrar istehsalçı barkodu bloklamır, xəbərdarlıq edir (FR-13).
  function createProduct(d) {
    return requirePerm('product.edit').then(function (user) {
      var v = validateProductInput(d); if (v) throw err(v);
      return matrix().then(function (m) {
        if (!Rules.can(m, user.role, 'product.price.set')) throw err('Satış qiymətini yalnız Menecer və Admin təyin edir');
        var warnings = [];
        return DB.atomic(['products', 'meta', 'priceHistory', 'audit', 'outbox'], function (t) {
          var p0 = d.mfrBarcode ? t.byIndex('products', 'mfrBarcode', d.mfrBarcode) : Promise.resolve([]);
          return p0.then(function (dups) {
            if (dups.length) warnings.push('Bu istehsalçı barkodu artıq var: ' + dups.map(function (x) { return x.name; }).join(', '));
            return nextSeq(t, 'productSeq');
          }).then(function (seq) {
            var p = {
              id: DB.uid('p'), name: String(d.name).trim(), category: d.category || '', brand: d.brand || '', ageGroup: d.ageGroup || '',
              storeBarcode: Barcode.storeBarcode(seq), mfrBarcode: d.mfrBarcode || '',
              price: d.price, lastCost: d.cost || 0, avgCost: d.cost || 0, stock: 0, negSalesSinceReceipt: 0,
              minStock: d.minStock || 0, active: true, createdAt: now(), createdBy: user.id
            };
            return t.put('products', p)
              .then(function () { return t.put('priceHistory', { id: DB.uid('ph'), productId: p.id, type: 'sale', old: null, new: p.price, userId: user.id, at: now() }); })
              .then(function () { return log(t, 'product.created', { product: p }, user); })
              .then(function () { return { product: p, warnings: warnings }; });
          });
        });
      });
    });
  }

  function updateProduct(id, changes) {
    return requirePerm('product.edit').then(function (user) {
      return matrix().then(function (m) {
        var canPrice = Rules.can(m, user.role, 'product.price.set');
        var warnings = [];
        return DB.atomic(['products', 'priceHistory', 'audit', 'outbox'], function (t) {
          return t.get('products', id).then(function (p) {
            if (!p) throw err('Məhsul tapılmadı');
            var next = Object.assign({}, p);
            ['name', 'category', 'brand', 'ageGroup', 'minStock', 'active'].forEach(function (k) { if (k in changes) next[k] = changes[k]; });
            if ('mfrBarcode' in changes) next.mfrBarcode = changes.mfrBarcode || '';
            if ('price' in changes && changes.price !== p.price) {
              if (!canPrice) throw err('Satış qiymətini yalnız Menecer və Admin təyin edir');
              next.price = changes.price;
            }
            var v = validateProductInput(next); if (v) throw err(v);
            var chk = next.mfrBarcode && next.mfrBarcode !== p.mfrBarcode ? t.byIndex('products', 'mfrBarcode', next.mfrBarcode) : Promise.resolve([]);
            return chk.then(function (dups) {
              if (dups.length) warnings.push('Bu istehsalçı barkodu artıq var: ' + dups.map(function (x) { return x.name; }).join(', '));
              return t.put('products', next);
            }).then(function () {
              if (next.price !== p.price) return t.put('priceHistory', { id: DB.uid('ph'), productId: id, type: 'sale', old: p.price, new: next.price, userId: user.id, at: now() });
            }).then(function () { return log(t, 'product.updated', { id: id, before: p, after: next }, user); })
              .then(function () { return { product: next, warnings: warnings }; });
          });
        });
      });
    });
  }

  // Sadə mal qəbulu (tam qəbul sənədi və təchizatçı borcu növbəti mərhələdə). Orta çəkili maya (FR-24).
  function receiveStock(productId, qty, unitCost, note) {
    return requirePerm('product.edit').then(function (user) {
      if (!Number.isInteger(qty) || qty <= 0) throw err('Say müsbət tam ədəd olmalıdır');
      if (!(unitCost >= 0)) throw err('Alış qiyməti səhvdir');
      return DB.atomic(['products', 'stockMoves', 'priceHistory', 'audit', 'outbox'], function (t) {
        return t.get('products', productId).then(function (p) {
          if (!p) throw err('Məhsul tapılmadı');
          var base = Math.max(p.stock, 0);
          var avg = base + qty > 0 ? Math.round((base * p.avgCost + qty * unitCost) / (base + qty)) : unitCost;
          var before = p.stock;
          p.stock += qty; p.avgCost = avg; p.lastCost = unitCost; p.negSalesSinceReceipt = 0;
          return t.put('products', p)
            .then(function () { return t.put('stockMoves', { id: DB.uid('sm'), productId: p.id, type: 'receipt', qty: qty, before: before, after: p.stock, unitCost: unitCost, note: note || '', at: now(), userId: user.id }); })
            .then(function () { return t.put('priceHistory', { id: DB.uid('ph'), productId: p.id, type: 'cost', old: null, new: unitCost, userId: user.id, at: now() }); })
            .then(function () { return log(t, 'stock.received', { productId: p.id, qty: qty, unitCost: unitCost }, user); })
            .then(function () { return p; });
        });
      });
    });
  }

  // Kassa yalnız mağaza barkodu ilə işləyir (FR-16). İstehsalçı barkodu → xəbərdarlıq.
  function lookupForPos(code) {
    code = String(code || '').trim();
    if (!code) return Promise.resolve({ kind: 'empty' });
    return DB.byIndex('products', 'storeBarcode', code).then(function (r) {
      if (r.length) return r[0].active ? { kind: 'product', product: r[0] } : { kind: 'inactive', product: r[0] };
      if (Barcode.isReceiptBarcode(code)) return { kind: 'receipt' };
      return DB.byIndex('products', 'mfrBarcode', code).then(function (m) {
        return m.length ? { kind: 'mfr', products: m } : { kind: 'notfound' };
      });
    });
  }

  /* ---------- Növbə ---------- */
  function currentShift() {
    return DB.byIndex('shifts', 'status', 'open').then(function (s) { return s[0] || null; });
  }

  function openShift(openingCash) {
    return requirePerm('shift.open_close').then(function (user) {
      if (!(openingCash >= 0)) throw err('Başlanğıc nağdı yazın');
      return DB.atomic(['shifts', 'audit', 'outbox'], function (t) {
        return t.byIndex('shifts', 'status', 'open').then(function (open) {
          if (open.length) throw err('Artıq açıq növbə var');
          var s = { id: DB.uid('sh'), status: 'open', openedAt: now(), openedBy: user.id, openedByName: user.name, openingCash: openingCash };
          return t.put('shifts', s).then(function () { return log(t, 'shift.opened', { shift: s }, user); }).then(function () { return s; });
        });
      });
    });
  }

  function shiftData(shiftId) {
    return Promise.all([DB.byIndex('sales', 'shiftId', shiftId), DB.byIndex('returns', 'shiftId', shiftId), DB.byIndex('cashMoves', 'shiftId', shiftId)])
      .then(function (r) { return { sales: r[0], returns: r[1], cashMoves: r[2] }; });
  }

  function shiftReport(shift) {
    return shiftData(shift.id).then(function (d) {
      var sum = Rules.shiftSummary(d.sales, d.returns);
      sum.expectedCash = Rules.expectedCash(shift, d.sales, d.returns, d.cashMoves);
      sum.cashIn = d.cashMoves.filter(function (m) { return m.type === 'in'; }).reduce(function (a, m) { return a + m.amount; }, 0);
      sum.cashOut = d.cashMoves.filter(function (m) { return m.type === 'out'; }).reduce(function (a, m) { return a + m.amount; }, 0);
      return sum;
    });
  }

  function cashMove(type, amount, reason, approver) {
    return requirePerm('shift.open_close').then(function (user) {
      if (!(amount > 0)) throw err('Məbləğ səhvdir');
      if (!reason) throw err('Səbəbi yazın');
      if (type === 'out' && !approver) throw err('Kassadan məxaric menecer təsdiqi tələb edir');
      return currentShift().then(function (s) {
        if (!s) throw err('Növbə açıq deyil');
        return DB.atomic(['cashMoves', 'audit', 'outbox'], function (t) {
          var m = { id: DB.uid('cm'), shiftId: s.id, type: type, amount: amount, reason: reason, at: now(), userId: user.id, approvedBy: approver ? approver.id : null };
          return t.put('cashMoves', m).then(function () { return log(t, 'cash.' + type, { move: m }, user); }).then(function () { return m; });
        });
      });
    });
  }

  function closeShift(countedCash, note) {
    return requirePerm('shift.open_close').then(function (user) {
      return currentShift().then(function (s) {
        if (!s) throw err('Açıq növbə yoxdur');
        return Promise.all([shiftReport(s), DB.getAll('outbox')]).then(function (r) {
          var rep = r[0];
          if (r[1].length && root.navigator && root.navigator.onLine === false) {
            throw err('Sinxronlaşmamış ' + r[1].length + ' qeyd var. İnternet qayıdana qədər növbə bağlanmır (FR-104)');
          }
          var diff = countedCash - rep.expectedCash;
          if (diff !== 0 && !note) throw err('Kassa fərqi var (' + Money.format(diff) + '). İzah yazın');
          s.status = 'closed'; s.closedAt = now(); s.closedBy = user.id; s.countedCash = countedCash; s.expectedCash = rep.expectedCash; s.diff = diff; s.note = note || ''; s.report = rep;
          return DB.atomic(['shifts', 'audit', 'outbox'], function (t) {
            return t.put('shifts', s).then(function () { return log(t, 'shift.closed', { shift: s }, user); }).then(function () { return s; });
          });
        });
      });
    });
  }

  /* ---------- Satış ---------- */
  // cart: [{productId, qty}], discount: {percent, approvedBy}|null, payment: rules.validatePayment girişi
  function checkout(cart, discount, payment) {
    return requirePerm('pos.sell').then(function (user) {
      if (!cart.length) throw err('Çek boşdur');
      if (discount) {
        var dv = Rules.validateDiscountPercent(discount.percent); if (dv) throw err(dv);
        if (!discount.approvedBy) throw err('Endirim menecer tərəfindən təsdiqlənməyib');
      }
      return currentShift().then(function (shift) {
        if (!shift) throw err('Satış üçün növbəni açın');
        return DB.atomic(['products', 'sales', 'meta', 'stockMoves', 'audit', 'outbox'], function (t) {
          return Promise.all(cart.map(function (c) { return t.get('products', c.productId); })).then(function (products) {
            var lines = [];
            var negatives = [];
            for (var i = 0; i < cart.length; i++) {
              var p = products[i];
              if (!p || !p.active) throw err('Məhsul satışda deyil');
              if (!Number.isInteger(cart[i].qty) || cart[i].qty <= 0) throw err('Say səhvdir: ' + p.name);
              var chk = Rules.negativeStockCheck(p, cart[i].qty);
              if (chk.blocked) throw err('"' + p.name + '" qalığı yoxdur və artıq ' + Rules.NEGATIVE_SALE_LIMIT + ' mənfi çekdə satılıb. Mal qəbulu daxil edin', 'negative_blocked');
              if (chk.needsNegative) negatives.push(p.id);
              lines.push({ productId: p.id, name: p.name, storeBarcode: p.storeBarcode, price: p.price, qty: cart[i].qty, unitCost: p.avgCost, negative: chk.needsNegative });
            }
            var totals = Rules.cartTotals(lines, discount ? discount.percent : 0);
            var pay = Rules.validatePayment(Object.assign({}, payment, { total: totals.total }));
            if (!pay.ok) throw err(pay.error, 'payment');
            pay.method = payment.method; pay.bankType = payment.method === 'cash' ? null : payment.bankType;

            return nextSeq(t, 'receiptSeq').then(function (no) {
              var sale = {
                id: DB.uid('s'), receiptNo: no, receiptBarcode: Barcode.receiptBarcode(no), at: now(), shiftId: shift.id,
                cashierId: user.id, cashierName: user.name, lines: lines, totals: totals,
                discount: discount ? { percent: discount.percent, approvedBy: discount.approvedBy.id, approvedByName: discount.approvedBy.name } : null,
                payment: pay, offline: !!(root.navigator && root.navigator.onLine === false),
                fiscal: { id: null, status: 'disabled' } // e-kassa modulu söndürülüb (FR-66, FR-67)
              };
              var writes = products.map(function (p, i) {
                var before = p.stock;
                p.stock -= cart[i].qty;
                if (negatives.indexOf(p.id) !== -1) p.negSalesSinceReceipt = (p.negSalesSinceReceipt || 0) + 1;
                return t.put('products', p).then(function () {
                  return t.put('stockMoves', { id: DB.uid('sm'), productId: p.id, type: 'sale', qty: -cart[i].qty, before: before, after: p.stock, ref: sale.id, at: sale.at, userId: user.id });
                });
              });
              return Promise.all(writes)
                .then(function () { return t.put('sales', sale); })
                .then(function () { return log(t, 'sale.created', { sale: sale }, user); })
                .then(function () { return sale; });
            });
          });
        });
      });
    });
  }

  function auditEvent(type, data) {
    var user = session.user;
    return DB.atomic(['audit', 'outbox'], function (t) { return log(t, type, data, user); });
  }

  /* ---------- Qaytarma ---------- */
  function findSaleByCode(code) {
    code = String(code || '').trim();
    var no = Barcode.receiptNoFromBarcode(code);
    if (no == null && /^\d{1,10}$/.test(code)) no = parseInt(code, 10);
    if (no == null) return Promise.resolve(null);
    return DB.byIndex('sales', 'receiptNo', no).then(function (r) { return r[0] || null; });
  }

  function returnedQtyBySale(saleId) {
    return DB.byIndex('returns', 'saleId', saleId).then(function (rs) {
      var map = {};
      rs.forEach(function (r) { r.lines.forEach(function (l) { map[l.lineIndex] = (map[l.lineIndex] || 0) + l.qty; }); });
      return { map: map, cashRefunded: rs.reduce(function (a, r) { return a + (r.cashAmount || 0); }, 0) };
    });
  }

  // items: [{lineIndex, qty}]
  function createReturn(saleId, items, approver, reason) {
    return requirePerm('pos.return.request').then(function (user) {
      if (!approver) throw err('Qaytarma menecer təsdiqi tələb edir');
      return Promise.all([DB.get('sales', saleId), returnedQtyBySale(saleId), currentShift()]).then(function (r) {
        var sale = r[0], prev = r[1], shift = r[2];
        if (!sale) throw err('Çek tapılmadı');
        if (!shift) throw err('Qaytarma üçün növbəni açın');
        var win = Rules.returnWindow(sale.at, now());
        if (win.expired) throw err('Çekin qaytarma müddəti bitib (' + win.daysPassed + ' gün keçib, limit ' + Rules.RETURN_DAYS + ' gün)', 'expired');
        var lines = [];
        items.forEach(function (it) {
          if (!it.qty) return;
          var l = sale.lines[it.lineIndex];
          if (!l) throw err('Sətir tapılmadı');
          var can = Rules.returnableQty(l.qty, prev.map[it.lineIndex]);
          if (it.qty > can) throw err('"' + l.name + '" üzrə ən çox ' + can + ' ədəd qaytarmaq olar');
          lines.push({ lineIndex: it.lineIndex, productId: l.productId, name: l.name, price: l.price, qty: it.qty });
        });
        if (!lines.length) throw err('Qaytarılacaq məhsul seçin');
        var amount = Rules.refundAmount(lines, sale.discount ? sale.discount.percent : 0);
        // Pul ilkin üsulla: əvvəlcə nağd hissəyə qədər nağd, qalanı banka
        var cashLeft = Math.max(0, sale.payment.cashPart - prev.cashRefunded);
        var cashAmount = Math.min(amount, cashLeft);
        var bankAmount = amount - cashAmount;
        return DB.atomic(['products', 'returns', 'stockMoves', 'audit', 'outbox'], function (t) {
          var rec = {
            id: DB.uid('r'), saleId: sale.id, receiptNo: sale.receiptNo, shiftId: shift.id, at: now(), lines: lines, amount: amount,
            cashAmount: cashAmount, bankAmount: bankAmount, bankType: bankAmount ? sale.payment.bankType : null,
            userId: user.id, approvedBy: approver.id, approvedByName: approver.name, reason: reason || ''
          };
          return Promise.all(lines.map(function (l) {
            return t.get('products', l.productId).then(function (p) {
              var before = p.stock; p.stock += l.qty;
              return t.put('products', p).then(function () {
                return t.put('stockMoves', { id: DB.uid('sm'), productId: p.id, type: 'return', qty: l.qty, before: before, after: p.stock, ref: rec.id, at: rec.at, userId: user.id });
              });
            });
          })).then(function () { return t.put('returns', rec); })
            .then(function () { return log(t, 'return.created', { ret: rec }, user); })
            .then(function () { return rec; });
        });
      });
    });
  }

  /* ---------- Admin ---------- */
  function getMatrix() { return matrix(); }
  function setMatrix(m) {
    return requirePerm('admin.permissions').then(function (user) {
      // Admin özünü icazə idarəsindən kənarlaşdıra bilməz
      if (m.admin.indexOf('admin.permissions') === -1) throw err('Admin icazə idarəsini özündən götürə bilməz');
      return DB.atomic(['meta', 'audit', 'outbox'], function (t) {
        return t.get('meta', 'matrix').then(function (old) {
          return t.put('meta', { key: 'matrix', value: m }).then(function () { return log(t, 'admin.matrix_changed', { before: old && old.value, after: m }, user); });
        });
      });
    });
  }

  function setStoreInfo(info) {
    return requirePerm('admin.users').then(function (user) {
      return DB.atomic(['meta', 'audit', 'outbox'], function (t) {
        return t.put('meta', { key: 'store', value: info }).then(function () { return log(t, 'admin.store_changed', { store: info }, user); });
      });
    });
  }

  function recentSales(limit) {
    return DB.getAll('sales').then(function (s) { return s.sort(function (a, b) { return b.receiptNo - a.receiptNo; }).slice(0, limit || 50); });
  }
  function outboxCount() { return DB.getAll('outbox').then(function (o) { return o.length; }); }

  function seedDemoProducts() {
    var demo = [
      { name: 'Konstruktor dəsti, 120 hissə', category: 'Oyuncaq', price: 1450, cost: 900, qty: 6, ageGroup: '6+' },
      { name: 'Yumşaq ayı, 25 sm', category: 'Oyuncaq', price: 600, cost: 350, qty: 0, ageGroup: '0+' },
      { name: 'Maqnit «Bakı»', category: 'Suvenir', price: 225, cost: 90, qty: 40 },
      { name: 'Qız qalası maketi', category: 'Suvenir', price: 1800, cost: 1100, qty: 4 },
      { name: 'Puzzl 500 hissə', category: 'Oyuncaq', price: 1200, cost: 700, qty: 8, ageGroup: '8+' }
    ];
    return demo.reduce(function (chain, d) {
      return chain.then(function () {
        return createProduct(d).then(function (r) { return d.qty ? receiveStock(r.product.id, d.qty, d.cost, 'Nümunə qalıq') : null; });
      });
    }, Promise.resolve());
  }

  var Services = {
    init: init, storeInfo: storeInfo, setStoreInfo: setStoreInfo, listUsers: listUsers, login: login, logout: logout, currentUser: currentUser, changePin: changePin,
    approveWithPin: approveWithPin, requirePerm: requirePerm, getMatrix: getMatrix, setMatrix: setMatrix,
    listProducts: listProducts, sanitizeForRole: sanitizeForRole, createProduct: createProduct, updateProduct: updateProduct,
    receiveStock: receiveStock, lookupForPos: lookupForPos, seedDemoProducts: seedDemoProducts,
    currentShift: currentShift, openShift: openShift, closeShift: closeShift, shiftReport: shiftReport, cashMove: cashMove,
    checkout: checkout, auditEvent: auditEvent, findSaleByCode: findSaleByCode, returnedQtyBySale: returnedQtyBySale, createReturn: createReturn,
    recentSales: recentSales, outboxCount: outboxCount, _session: session
  };
  root.Services = Services;
  if (typeof module !== 'undefined') module.exports = Services;
})(typeof window !== 'undefined' ? window : globalThis);
