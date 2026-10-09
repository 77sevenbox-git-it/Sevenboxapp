/**
 * Mağaza İS — Google Apps Script backend (v1).
 * Kassa outbox qeydlərini qəbul edir və Google Sheets vərəqlərinə yazır.
 *
 * Quraşdırma:
 *  1. Yeni Google Sheets faylı yaradın → Extensions → Apps Script → bu kodu yapışdırın.
 *  2. Project Settings → Script properties: SYNC_TOKEN = uzun təsadüfi sətir (kassanın ayarlarına da eyni yazılır).
 *  3. setup() funksiyasını bir dəfə işə salın (vərəqləri yaradır).
 *  4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → URL-i kassaya yazın.
 *
 * Təhlükəsizlik (SEC-15): Sheets faylını yalnız Admin-lə paylaşın. Yazı yalnız bu skript vasitəsilə olur.
 */

var SHEETS = {
  Events: ['id', 'at', 'type', 'userId', 'receivedAt', 'json'],
  Sales: ['id', 'receiptNo', 'at', 'shiftId', 'cashierId', 'cashierName', 'subtotal', 'discount', 'discountPercent', 'discountApprovedBy',
    'total', 'method', 'bankType', 'cashPart', 'bankPart', 'cashReceived', 'change', 'offline', 'fiscalId', 'fiscalStatus'],
  SaleLines: ['saleId', 'receiptNo', 'lineIndex', 'productId', 'name', 'storeBarcode', 'qty', 'price', 'unitCost', 'negative'],
  Returns: ['id', 'saleId', 'receiptNo', 'at', 'amount', 'cashAmount', 'bankAmount', 'bankType', 'approvedBy', 'reason'],
  Products: ['id', 'name', 'category', 'brand', 'ageGroup', 'storeBarcode', 'mfrBarcode', 'price', 'avgCost', 'lastCost', 'minStock', 'active', 'updatedAt'],
  StockReceipts: ['at', 'productId', 'qty', 'unitCost', 'userId'],
  Shifts: ['id', 'status', 'openedAt', 'openedBy', 'openingCash', 'closedAt', 'closedBy', 'expectedCash', 'countedCash', 'diff', 'note'],
  CashMoves: ['id', 'shiftId', 'type', 'amount', 'reason', 'at', 'userId', 'approvedBy'],
  Audit: ['at', 'type', 'userId', 'json']
};

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
  });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Bağlantı yoxlaması: veb tətbiq ünvanını brauzerdə açanda {"ok":true,...} görünməlidir.
function doGet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hasToken = !!PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  var missing = Object.keys(SHEETS).filter(function (n) { return !ss.getSheetByName(n); });
  return json({ ok: true, service: 'magaza-is', version: 2, tokenSet: hasToken, missingSheets: missing });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'JSON səhvdir' }); }

  var token = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  if (!token || body.token !== token) return json({ ok: false, error: 'İcazə yoxdur' });

  if (body.action !== 'sync') return json({ ok: false, error: 'Naməlum əməliyyat' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json({ ok: false, error: 'Server məşğuldur, sonra təkrar olunacaq' });
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var events = ss.getSheetByName('Events');
    var seen = {};
    if (events.getLastRow() > 1) {
      events.getRange(2, 1, events.getLastRow() - 1, 1).getValues().forEach(function (r) { seen[r[0]] = true; });
    }
    var acked = [];
    var now = new Date().toISOString();
    (body.items || []).forEach(function (it) {
      if (!it || !it.id) return;
      if (!seen[it.id]) {               // Təkrar göndəriş yazılmır (idempotent)
        project(ss, it);
        events.appendRow([it.id, it.at, it.type, it.userId || '', now, JSON.stringify(it.data)]);
        seen[it.id] = true;
      }
      acked.push(it.id);
    });
    return json({ ok: true, acked: acked });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function append(ss, sheet, row) { ss.getSheetByName(sheet).appendRow(row); }

// Hadisəni oxunaqlı vərəqlərə yazır
function project(ss, it) {
  var d = it.data || {};
  append(ss, 'Audit', [it.at, it.type, it.userId || '', JSON.stringify(d)]);
  switch (it.type) {
    case 'sale.created': {
      var s = d.sale, p = s.payment;
      append(ss, 'Sales', [s.id, s.receiptNo, s.at, s.shiftId, s.cashierId, s.cashierName, s.totals.subtotal / 100, s.totals.discount / 100,
        s.discount ? s.discount.percent : '', s.discount ? s.discount.approvedByName : '', s.totals.total / 100, p.method, p.bankType || '',
        p.cashPart / 100, p.bankPart / 100, p.cashReceived / 100, p.change / 100, s.offline, s.fiscal.id || '', s.fiscal.status]);
      s.lines.forEach(function (l, i) {
        append(ss, 'SaleLines', [s.id, s.receiptNo, i, l.productId, l.name, l.storeBarcode, l.qty, l.price / 100, l.unitCost / 100, l.negative]);
      });
      break;
    }
    case 'return.created': {
      var r = d.ret;
      append(ss, 'Returns', [r.id, r.saleId, r.receiptNo, r.at, r.amount / 100, r.cashAmount / 100, r.bankAmount / 100, r.bankType || '', r.approvedByName, r.reason]);
      break;
    }
    case 'product.created':
    case 'product.updated':
      upsertProduct(ss, d.product || d.after, it.at);
      break;
    case 'stock.received':
      append(ss, 'StockReceipts', [it.at, d.productId, d.qty, d.unitCost / 100, it.userId]);
      break;
    case 'shift.opened':
    case 'shift.closed': {
      var sh = d.shift;
      append(ss, 'Shifts', [sh.id, sh.status, sh.openedAt, sh.openedBy, sh.openingCash / 100, sh.closedAt || '', sh.closedBy || '',
        sh.expectedCash != null ? sh.expectedCash / 100 : '', sh.countedCash != null ? sh.countedCash / 100 : '', sh.diff != null ? sh.diff / 100 : '', sh.note || '']);
      break;
    }
    case 'cash.in':
    case 'cash.out': {
      var m = d.move;
      append(ss, 'CashMoves', [m.id, m.shiftId, m.type, m.amount / 100, m.reason, m.at, m.userId, m.approvedBy || '']);
      break;
    }
  }
}

function upsertProduct(ss, p, at) {
  var sh = ss.getSheetByName('Products');
  var row = [p.id, p.name, p.category, p.brand, p.ageGroup, p.storeBarcode, p.mfrBarcode, p.price / 100, p.avgCost / 100, p.lastCost / 100, p.minStock, p.active, at];
  var n = sh.getLastRow();
  if (n > 1) {
    var ids = sh.getRange(2, 1, n - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === p.id) { sh.getRange(i + 2, 1, 1, row.length).setValues([row]); return; }
    }
  }
  sh.appendRow(row);
}
