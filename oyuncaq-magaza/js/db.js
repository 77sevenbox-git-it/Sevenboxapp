/* Lokal verilənlər bazası (IndexedDB). İnternet olmasa da kassa bununla işləyir (FR-100..104).
   Serverə göndəriləcək hər dəyişiklik "outbox"-a yazılır, sync.js onu Apps Script-ə ötürür. */
(function (root) {
  'use strict';

  var DB_NAME = 'magaza';
  var VERSION = 4;
  var STORES = {
    products: { keyPath: 'id', indexes: [['storeBarcode', true], ['mfrBarcode', false]] },
    // receiptNo unikal deyil: fərqli kassalardan gələn çekin yazılması heç vaxt rədd olunmamalıdır (pul məlumatı itməsin)
    sales: { keyPath: 'id', indexes: [['receiptNo', false], ['shiftId', false]] },
    returns: { keyPath: 'id', indexes: [['saleId', false], ['shiftId', false]] },
    shifts: { keyPath: 'id', indexes: [['status', false]] },
    users: { keyPath: 'id', indexes: [] },
    stockMoves: { keyPath: 'id', indexes: [['productId', false]] },
    priceHistory: { keyPath: 'id', indexes: [['productId', false]] },
    cashMoves: { keyPath: 'id', indexes: [['shiftId', false]] },
    audit: { keyPath: 'id', indexes: [] },
    outbox: { keyPath: 'id', indexes: [] },
    approvals: { keyPath: 'id', indexes: [['status', false]] },
    suppliers: { keyPath: 'id', indexes: [] },
    lots: { keyPath: 'id', indexes: [['productId', false]] },
    supplierPays: { keyPath: 'id', indexes: [['supplierId', false]] },
    meta: { keyPath: 'key', indexes: [] }
  };

  var dbPromise = null;

  function idb() { return root.indexedDB; }

  function open(name) {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = idb().open(name || DB_NAME, VERSION);
      req.onupgradeneeded = function (ev) {
        var db = req.result;
        Object.keys(STORES).forEach(function (s) {
          if (db.objectStoreNames.contains(s)) return;
          var os = db.createObjectStore(s, { keyPath: STORES[s].keyPath });
          STORES[s].indexes.forEach(function (ix) { os.createIndex(ix[0], ix[0], { unique: ix[1] }); });
        });
        // v1 → v2: sales.receiptNo indeksi unikal olmaqdan çıxır
        if (ev.oldVersion === 1) {
          var sales = req.transaction.objectStore('sales');
          sales.deleteIndex('receiptNo');
          sales.createIndex('receiptNo', 'receiptNo', { unique: false });
        }
      };
      req.onsuccess = function () {
        var d = req.result;
        d.onversionchange = function () { d.close(); dbPromise = null; };   // köhnə tab yeni versiyanın qurulmasını bloklamasın
        resolve(d);
      };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function reset() { dbPromise = null; }

  function wrap(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // Bir neçə cədvəldə atomik əməliyyat. fn(t) daxilində yalnız t.* çağırışlarını gözləyin (başqa await yox).
  function atomic(storeNames, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeNames, 'readwrite');
        var result;
        var t = {
          get: function (s, k) { return wrap(tx.objectStore(s).get(k)); },
          put: function (s, v) { return wrap(tx.objectStore(s).put(v)); },
          del: function (s, k) { return wrap(tx.objectStore(s).delete(k)); },
          getAll: function (s) { return wrap(tx.objectStore(s).getAll()); },
          byIndex: function (s, ix, v) { return wrap(tx.objectStore(s).index(ix).getAll(v)); },
          abort: function (err) { tx.__err = err; tx.abort(); }
        };
        tx.oncomplete = function () { resolve(result); };
        tx.onabort = function () { reject(tx.__err || tx.error || new Error('Əməliyyat ləğv olundu')); };
        tx.onerror = function () { /* onabort-da işlənir */ };
        Promise.resolve().then(function () { return fn(t); }).then(function (r) { result = r; })
          .catch(function (e) { try { tx.__err = e; tx.abort(); } catch (_) { reject(e); } });
      });
    });
  }

  function get(s, k) { return atomic([s], function (t) { return t.get(s, k); }); }
  function put(s, v) { return atomic([s], function (t) { return t.put(s, v); }); }
  function getAll(s) { return atomic([s], function (t) { return t.getAll(s); }); }
  function byIndex(s, ix, v) { return atomic([s], function (t) { return t.byIndex(s, ix, v); }); }
  function del(s, k) {
    return open().then(function (db) { return wrap(db.transaction([s], 'readwrite').objectStore(s).delete(k)); });
  }

  function uid(prefix) {
    var r = (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
    return (prefix ? prefix + '_' : '') + r;
  }

  var DB = { open: open, reset: reset, atomic: atomic, get: get, put: put, getAll: getAll, byIndex: byIndex, del: del, uid: uid, STORES: Object.keys(STORES) };
  root.DB = DB;
  if (typeof module !== 'undefined') module.exports = DB;
})(typeof window !== 'undefined' ? window : globalThis);
