/**
 * Mağaza İS — Google Apps Script backend (v6).
 * Kassaların hadisələrini (outbox) qəbul edib Google Sheets-ə yazır və digər cihazların hadisələrini geri verir (pull).
 *
 * Quraşdırma / yeniləmə:
 *  1. Verilənlər bazası faylını açın → Extensions → Apps Script → bu kodu yapışdırın (köhnəni əvəz edin).
 *     (Ayrıca script.google.com layihəsində də işləyir: fayl SPREADSHEET_ID ilə açılır.)
 *  2. Project Settings → Script properties: SYNC_TOKEN = uzun təsadüfi sətir (kassanın ayarlarına da eyni yazılır).
 *  3. setup() funksiyasını işə salın (yeni vərəqləri yaradır, başlıqları yeniləyir; təkrar işə salmaq təhlükəsizdir).
 *  4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → URL-i kassaya yazın.
 *     Bildirişlər (v6): kod xarici push xidmətinə (UrlFetchApp) sorğu göndərir. setup()-ı redaktorda işə salanda Google yeni icazə istəyəcək
 *     ("Connect to an external service") — təsdiqləyin, sonra New version deploy edin. Bildirişi istəməsəniz də qalan hər şey işləyir.
 *     Kodu dəyişdikdən sonra: Deploy → Manage deployments → ✏️ → Version: New version → Deploy (ünvan dəyişmir).
 *
 * Təhlükəsizlik (SEC-15): Sheets faylını yalnız Admin-lə paylaşın. "Users" vərəqində PIN-lərin duzlu hash-ı var.
 * Yazı yalnız bu skript vasitəsilə olur.
 */

// Verilənlər bazası faylının ID-si (Drive: "Mağaza İS — Verilənlər bazası").
// Skript cədvəlin içindən (Extensions → Apps Script) yaradılıbsa, həmin fayl istifadə olunur;
// ayrıca script.google.com-da yaradılıbsa, fayl bu ID ilə açılır.
var SPREADSHEET_ID = '1NTzVrx9ioe9elwn3c85RwU64e9NWuylaKT8uyLoe67g';
var VERSION = 6;
var SEEN_WINDOW = 1500;   // təkrar yoxlaması üçün son neçə hadisəyə baxılır (köhnə hadisə gəlsə dəqiq axtarış edilir)
var MAX_ITEMS = 300;      // bir sorğuda ən çox hadisə
var BLOCK_MAX = 1000;     // bir dəfəyə verilən ən böyük nömrə aralığı

function db() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID;
  return SpreadsheetApp.openById(id);
}

var SHEETS = {
  Events: ['id', 'at', 'type', 'userId', 'receivedAt', 'json', 'device'],
  Sales: ['id', 'receiptNo', 'at', 'shiftId', 'cashierId', 'cashierName', 'subtotal', 'discount', 'discountPercent', 'discountApprovedBy',
    'total', 'method', 'bankType', 'cashPart', 'bankPart', 'cashReceived', 'change', 'offline', 'fiscalId', 'fiscalStatus'],
  SaleLines: ['saleId', 'receiptNo', 'lineIndex', 'productId', 'name', 'storeBarcode', 'qty', 'price', 'unitCost', 'negative'],
  Returns: ['id', 'saleId', 'receiptNo', 'at', 'amount', 'cashAmount', 'bankAmount', 'bankType', 'approvedBy', 'reason'],
  Products: ['id', 'name', 'category', 'brand', 'ageGroup', 'storeBarcode', 'mfrBarcode', 'price', 'avgCost', 'lastCost', 'minStock', 'active', 'updatedAt'],
  StockReceipts: ['at', 'productId', 'qty', 'unitCost', 'userId', 'supplierId', 'lotId', 'note'],
  Suppliers: ['id', 'name', 'phone', 'note', 'active', 'updatedAt'],
  Shifts: ['id', 'status', 'openedAt', 'openedBy', 'openingCash', 'closedAt', 'closedBy', 'expectedCash', 'countedCash', 'diff', 'note'],
  CashMoves: ['id', 'shiftId', 'type', 'amount', 'reason', 'at', 'userId', 'approvedBy'],
  Audit: ['at', 'type', 'userId', 'json'],
  Users: ['id', 'name', 'role', 'active', 'mustChangePin', 'updatedAt', 'salt', 'pinHash'],
  Settings: ['key', 'value', 'updatedAt'],
  Push: ['device', 'userId', 'userName', 'role', 'perms', 'endpoint', 'active', 'updatedAt', 'lastStatus', 'lastAt']
};

// Bu hadisələr öz vərəqlərində var, "Audit"-də təkrarlanmır (Audit = təhlükəsizlik və əməliyyat jurnalı)
var HEAVY = { 'sale.created': 1, 'return.created': 1, 'product.created': 1, 'product.updated': 1, 'stock.received': 1, 'supplier.upserted': 1,
  'shift.opened': 1, 'shift.closed': 1, 'cash.in': 1, 'cash.out': 1 };

function setup() {
  var ss = db();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = SHEETS[name].length;
    sh.getRange(1, 1, 1, cols).setValues([SHEETS[name]]);   // yeni sütunlar əlavə olunubsa başlıq yenilənir
    sh.setFrozenRows(1);
  });
  CacheService.getScriptCache().remove('evTotal');
  Logger.log('Hazırdır: "' + ss.getName() + '" faylında ' + Object.keys(SHEETS).length + ' vərəq yoxlanıldı.');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Bağlantı yoxlaması: veb tətbiq ünvanını brauzerdə açanda {"ok":true,...} görünməlidir.
function doGet() {
  var ss = db();
  var hasToken = !!PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  var missing = Object.keys(SHEETS).filter(function (n) { return !ss.getSheetByName(n); });
  return json({ ok: true, service: 'magaza-is', version: VERSION, tokenSet: hasToken, missingSheets: missing });
}

/* ---------- Köməkçilər ---------- */
// Cədvəl mətni düstur, tarix və ya rəqəm kimi "ağıllı" çevirməsin: =, +, -, @, rəqəm və boşluqla başlayan mətnin qarşısına ' qoyulur
function cell(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\d\s']/.test(v) ? "'" + v : v;
}
function rid(v) { return String(v).replace(/^'/, ''); }
function iso(v) { return v instanceof Date ? v.toISOString() : rid(v); }
function fit(row, width) {
  var out = [];
  for (var i = 0; i < width; i++) out.push(i < row.length && row[i] != null ? cell(row[i]) : '');
  return out;
}

function sheet(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) {                       // setup() unudulubsa vərəq özü yaranır
    sh = ss.insertSheet(name);
    sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Bir sorğuda hər vərəqə YALNIZ BİR yazma əməliyyatı (Sheets API çağırışları yavaşdır: hər çağırış ~0,1–0,3 san)
function Table(ss, name) {
  this.name = name;
  this.sh = sheet(ss, name);
  this.width = SHEETS[name].length;
  this.base = this.sh.getLastRow();              // başlıq daxil
  this.pending = [];
  this.edits = [];
  this.index = null;
  this.tsCol = SHEETS[name].indexOf('updatedAt');
}
Table.prototype.add = function (row) { this.pending.push(fit(row, this.width)); };
Table.prototype.load = function () {
  if (this.index) return this.index;
  var idx = {}, n = this.base - 1;
  if (n > 0) {
    var ids = this.sh.getRange(2, 1, n, 1).getValues();
    var ts = this.tsCol >= 0 ? this.sh.getRange(2, this.tsCol + 1, n, 1).getValues() : null;
    for (var i = 0; i < n; i++) idx[rid(ids[i][0])] = { row: i + 2, ts: ts ? iso(ts[i][0]) : '' };
  }
  this.index = idx;
  return idx;
};
// "Son yazan qalib": yeni sətrin vaxtı mövcud sətirdən köhnə və ya bərabərdirsə, yazılmır
Table.prototype.upsert = function (row) {
  var idx = this.load(), id = String(row[0]);
  var ts = this.tsCol >= 0 ? iso(row[this.tsCol]) : '';
  var hit = idx[id];
  var full = fit(row, this.width);
  if (!hit) { this.pending.push(full); idx[id] = { pending: this.pending.length - 1, ts: ts }; return true; }
  if (this.tsCol >= 0 && hit.ts && ts && ts <= hit.ts) return false;
  if (hit.pending != null) this.pending[hit.pending] = full; else this.edits.push({ row: hit.row, values: full });
  hit.ts = ts;
  return true;
};
Table.prototype.flush = function () {
  if (this.pending.length) this.sh.getRange(this.base + 1, 1, this.pending.length, this.width).setValues(this.pending);
  for (var i = 0; i < this.edits.length; i++) this.sh.getRange(this.edits[i].row, 1, 1, this.width).setValues([this.edits[i].values]);
};

function Batch(ss) { this.ss = ss; this.tables = {}; }
Batch.prototype.table = function (name) { return this.tables[name] || (this.tables[name] = new Table(this.ss, name)); };
Batch.prototype.flush = function () { for (var k in this.tables) this.tables[k].flush(); };

// Events sətir sayının keşi (sürətli "yenilik yoxdur" cavabı üçün). Yalnız yazan sorğu (kilid altında) onu təyin edir;
// oxuyan sorğu keşi yalnız YUXARI düzəldə bilər (köhnəlmiş aşağı dəyər cihazı "yenilik yoxdur" cavabında ilişdirərdi).
// Keş qısa ömürlüdür: hər hansı pozuntu ən çox 90 san-də özü sağalır.
function cacheTotal(set) {
  var c = CacheService.getScriptCache();
  if (set === undefined) { var v = c.get('evTotal'); return v === null || v === undefined ? null : Number(v); }
  c.put('evTotal', String(set), 90);
}
function cacheRaise(total) {
  var cur = cacheTotal();
  if (cur === null || total > cur) cacheTotal(total);
}

/* ---------- Giriş nöqtəsi ---------- */
// Açarın müqayisəsi: sətir deyilsə rədd; uzunluq eynidirsə bütün simvollar müqayisə olunur (ilk fərqdə dayanmır)
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'JSON səhvdir' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, error: 'JSON səhvdir' });

  var token = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  if (!token || !sameToken(body.token, token)) return json({ ok: false, error: 'İcazə yoxdur' });

  try {
    switch (body.action) {
      case 'ping': return json({ ok: true, version: VERSION });
      case 'sync': return json(handleSync(body));
      case 'allocate': return json(handleAllocate(body));
      case 'push.key': case 'push.register': case 'push.unregister': case 'push.test': return json(handlePush(body));
      default: return json({ ok: false, error: 'Naməlum əməliyyat' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ---------- Göndər + al ---------- */
function handleSync(body) {
  var items = body.items || [];
  var since = Math.max(0, Number(body.since) || 0);
  var limit = Math.min(Math.max(Number(body.limit) || 300, 1), 500);
  var device = String(body.device || '');
  var wantAlloc = body.alloc && body.alloc.length ? body.alloc : null;
  if (items.length > MAX_ITEMS) return { ok: false, error: 'Bir sorğuda ən çox ' + MAX_ITEMS + ' hadisə' };

  var acked = [], blocks = [], fresh = [];
  var total, ss;
  if (!items.length && !wantAlloc) {
    // Sürətli yol: yeni hadisə yoxdursa cədvəl açılmır (təxminən 0,1–0,3 san)
    var cached = cacheTotal();
    if (cached !== null && cached === since) return { ok: true, acked: [], events: [], next: since, more: false, now: new Date().toISOString() };
  } else {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return { ok: false, error: 'Server məşğuldur, sonra təkrar olunacaq' };
    try {
      ss = db();
      if (items.length) {
        total = appendItems(ss, items, acked, device, fresh);
        cacheTotal(total);                       // kilid altında: sonrakı yazı bunu ancaq irəli apara bilər
      }
      if (wantAlloc) blocks = allocateBlocks(ss, wantAlloc);
    } finally {
      lock.releaseLock();
    }
  }

  ss = ss || db();
  if (fresh.length) notifyApprovals(ss, fresh);       // kilid buraxıldıqdan sonra; xəta sinxronu pozmur
  var events = sheet(ss, 'Events');
  if (total === undefined) total = Math.max(events.getLastRow() - 1, 0);
  else total = Math.max(total, 0);

  // Müştərinin kursoru serverdən irəlidədirsə (cədvəl təmizlənibsə), kursor geri qaytarılır
  if (since > total) { cacheTotal(total); return { ok: true, acked: acked, events: [], next: total, more: false, rewind: true, blocks: blocks, now: new Date().toISOString() }; }
  cacheRaise(total);

  var out = [], next = since;
  if (total > since) {
    var n = Math.min(limit, total - since);
    var rows = events.getRange(since + 2, 1, n, 7).getValues();
    for (var i = 0; i < rows.length; i++) {
      next = since + i + 1;
      var r = rows[i];
      if (String(r[6]) === device) continue;                          // öz hadisəsini geri göndərmirik
      var data = null;
      try { data = JSON.parse(r[5]); } catch (err) { data = null; }
      out.push({ seq: next, id: rid(r[0]), at: iso(r[1]), type: String(r[2]), userId: String(r[3] || ''), device: String(r[6] || ''), data: data });
    }
  }
  return { ok: true, acked: acked, events: out, next: next, more: total > next, blocks: blocks, now: new Date().toISOString() };
}

// Hadisələri yazır (kilid altında çağırılır). Qaytarır: Events-də yeni sətir sayı
function appendItems(ss, items, acked, device, fresh) {
  var batch = new Batch(ss);
  var ev = batch.table('Events');
  var total = Math.max(ev.base - 1, 0);

  // Təkrar yoxlaması: son SEEN_WINDOW hadisənin id-ləri. Daha köhnə vaxtlı hadisə gələrsə, dəqiq axtarış edilir.
  var first = Math.max(2, ev.base - SEEN_WINDOW + 1);
  var seen = {}, windowStartAt = '';
  if (ev.base >= 2) {
    var win = ev.sh.getRange(first, 1, ev.base - first + 1, 2).getValues();
    for (var i = 0; i < win.length; i++) seen[rid(win[i][0])] = true;
    windowStartAt = iso(win[0][1]);
  }
  var windowFull = first > 2;      // pəncərə bütün cədvəli əhatə etmirsə

  var now = new Date().toISOString();
  items.forEach(function (it) {
    if (!it || !it.id) return;
    var id = String(it.id);
    var dup = !!seen[id];
    if (!dup && windowFull && String(it.at || '') < windowStartAt) dup = existsOlder(ev.sh, first, id);
    if (!dup) {
      try {
        project(batch, it);
      } catch (err) {
        // Bir pozuq hadisə bütün növbəni dayandırmasın: səhv jurnala yazılır, hadisə isə Events-də saxlanılır
        batch.table('Audit').add([now, 'server.project_error', it.userId || '', JSON.stringify({ id: id, type: it.type, error: String(err) })]);
      }
      ev.add([id, it.at, it.type, it.userId || '', now, JSON.stringify(it.data == null ? {} : it.data), it.device || device || '']);
      seen[id] = true;
      if (fresh) fresh.push(it);
      total++;
    }
    acked.push(id);
  });
  batch.flush();
  return total;
}

function existsOlder(sh, firstWindowRow, id) {
  if (firstWindowRow <= 2) return false;
  var found = sh.getRange(2, 1, firstWindowRow - 2, 1).createTextFinder(id).matchEntireCell(true).findNext();
  return !!found;
}

/* ---------- Nömrə aralığı ---------- */
// Hər kassa üçün ayrı aralıq verilir ki, iki cihazda eyni barkod / çek nömrəsi olmasın.
// Yeni müştəri aralığı "sync" sorğusunun içində istəyir (əlavə sorğu yoxdur); "allocate" köhnə müştərilər üçün saxlanılıb.
function allocateOne(ss, key, count, min) {
  if (key !== 'productSeq' && key !== 'receiptSeq') return null;
  count = Math.min(Math.max(parseInt(count, 10) || 0, 1), BLOCK_MAX);
  min = Math.max(parseInt(min, 10) || 0, 0);
  var props = PropertiesService.getScriptProperties();
  var cur = parseInt(props.getProperty(key), 10) || 0;
  var base = Math.max(cur, min, derivedMax(ss, key));   // cədvəldə artıq olan ən böyük nömrədən də yuxarı
  props.setProperty(key, String(base + count));
  return { key: key, from: base + 1, to: base + count };
}

function allocateBlocks(ss, reqs) {
  var out = [];
  for (var i = 0; i < reqs.length && i < 4; i++) {
    var b = allocateOne(ss, reqs[i].key, reqs[i].count, reqs[i].min);
    if (b) out.push(b);
  }
  return out;
}

function handleAllocate(body) {
  if (body.key !== 'productSeq' && body.key !== 'receiptSeq') return { ok: false, error: 'Naməlum açar' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'Server məşğuldur, sonra təkrar olunacaq' };
  try {
    var b = allocateOne(db(), body.key, body.count, body.min);
    return { ok: true, from: b.from, to: b.to };
  } finally {
    lock.releaseLock();
  }
}

// Köhnə rejimdə (aralıqsız) yaradılmış məhsul barkodları / çek nömrələri ilə toqquşmamaq üçün
function derivedMax(ss, key) {
  var name = key === 'productSeq' ? 'Products' : 'Sales';
  var col = key === 'productSeq' ? 6 : 2;
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return 0;
  var vals = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
  var m = 0;
  for (var i = 0; i < vals.length; i++) {
    var v = rid(vals[i][0]);
    var n = key === 'productSeq' ? parseInt(v.substr(2, 10), 10) : parseInt(v, 10);
    if (n > m) m = n;
  }
  return m;
}

/* ---------- Hadisəni oxunaqlı vərəqlərə yazır ---------- */
function project(batch, it) {
  var d = it.data || {};
  if (!HEAVY[it.type]) batch.table('Audit').add([it.at, it.type, it.userId || '', JSON.stringify(redact(it.type, d))]);
  switch (it.type) {
    case 'sale.created': {
      var s = d.sale, p = s.payment;
      batch.table('Sales').add([s.id, s.receiptNo, s.at, s.shiftId, s.cashierId, s.cashierName, s.totals.subtotal / 100, s.totals.discount / 100,
        s.discount ? s.discount.percent : '', s.discount ? s.discount.approvedByName : '', s.totals.total / 100, p.method, p.bankType || '',
        p.cashPart / 100, p.bankPart / 100, p.cashReceived / 100, p.change / 100, s.offline, s.fiscal.id || '', s.fiscal.status]);
      s.lines.forEach(function (l, i) {
        batch.table('SaleLines').add([s.id, s.receiptNo, i, l.productId, l.name, l.storeBarcode, l.qty, l.price / 100, l.unitCost / 100, l.negative]);
      });
      break;
    }
    case 'return.created': {
      var r = d.ret;
      batch.table('Returns').add([r.id, r.saleId, r.receiptNo, r.at, r.amount / 100, r.cashAmount / 100, r.bankAmount / 100, r.bankType || '', r.approvedByName, r.reason]);
      break;
    }
    case 'product.created':
    case 'product.updated': {
      var pr = d.product || d.after;
      batch.table('Products').upsert([pr.id, pr.name, pr.category, pr.brand, pr.ageGroup, pr.storeBarcode, pr.mfrBarcode, pr.price / 100, pr.avgCost / 100, pr.lastCost / 100,
        pr.minStock, pr.active, it.at]);
      break;
    }
    case 'stock.received':
      batch.table('StockReceipts').add([d.at || it.at, d.productId, d.qty, d.unitCost / 100, it.userId || '', d.supplierId || '', d.lotId || '', d.note || '']);
      break;
    case 'supplier.upserted': {
      var sp = d.supplier;
      batch.table('Suppliers').upsert([sp.id, sp.name, sp.phone || '', sp.note || '', sp.active, sp.updatedAt]);
      break;
    }
    case 'shift.opened':
    case 'shift.closed': {
      var sh = d.shift;
      batch.table('Shifts').add([sh.id, sh.status, sh.openedAt, sh.openedBy, sh.openingCash / 100, sh.closedAt || '', sh.closedBy || '',
        sh.expectedCash != null ? sh.expectedCash / 100 : '', sh.countedCash != null ? sh.countedCash / 100 : '', sh.diff != null ? sh.diff / 100 : '', sh.note || '']);
      break;
    }
    case 'cash.in':
    case 'cash.out': {
      var m = d.move;
      batch.table('CashMoves').add([m.id, m.shiftId, m.type, m.amount / 100, m.reason, m.at, m.userId, m.approvedBy || '']);
      break;
    }
    case 'user.upserted': {
      var u = d.user;
      batch.table('Users').upsert([u.id, u.name, u.role, u.active, u.mustChangePin, u.updatedAt, u.salt, u.pinHash]);
      break;
    }
    case 'admin.matrix_changed':
      batch.table('Settings').upsert(['matrix', JSON.stringify(d.after), it.at]);
      break;
    case 'admin.store_changed':
      batch.table('Settings').upsert(['store', JSON.stringify(d.store), it.at]);
      break;
  }
}

/* ---------- Təcili bərpa: Admin PIN-i unudulubsa ---------- */
// Apps Script redaktorunda bu funksiyanı seçib "Run" basın. Admin üçün müvəqqəti 6 rəqəmli PIN yaradılır
// (Execution log-da görünür), bütün cihazlar onu növbəti sinxronda alır, Admin ilk girişdə yeni PIN seçir.
// Bunu yalnız bu Google hesabının sahibi edə bilər: cədvələ və skriptə giriş bunun təhlükəsizlik sərhəddidir.
function hexSha256(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { b = b < 0 ? b + 256 : b; return (b < 16 ? '0' : '') + b.toString(16); }).join('');
}
function resetAdminPin() {
  var pin = String(100000 + Math.floor(Math.random() * 900000));
  var salt = Utilities.getUuid().replace(/-/g, '');
  var at = new Date().toISOString();
  var user = { id: 'u_admin', name: 'Admin', role: 'admin', salt: salt, pinHash: hexSha256(salt + ':' + pin), active: true, mustChangePin: true, updatedAt: at };
  var item = { id: at + '_000000_a_bg_' + Utilities.getUuid(), at: at, type: 'user.upserted', userId: '', device: 'server', data: { user: user, reason: 'break_glass' } };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Server məşğuldur, bir az sonra təkrar edin');
  try {
    cacheTotal(appendItems(db(), [item], [], 'server'));
  } finally {
    lock.releaseLock();
  }
  Logger.log('Admin üçün müvəqqəti PIN: ' + pin + '  (cihazlar bir neçə saniyəyə alır; Admin girişdən sonra yeni PIN seçməlidir)');
  return pin;
}

// Audit jurnalına hash və duz düşməsin
function redact(type, d) {
  if (type !== 'user.upserted' || !d.user) return d;
  var u = d.user;
  return { reason: d.reason, user: { id: u.id, name: u.name, role: u.role, active: u.active, mustChangePin: u.mustChangePin, updatedAt: u.updatedAt } };
}


/* ---------- Bildiriş: Web Push (VAPID) ----------
   Təsdiq sorğusu gələndə menecerin telefonuna/brauzerinə bildiriş göndərilir (tətbiq bağlı olsa belə).
   Push xidmətləri (Google FCM, Mozilla, Apple, Microsoft) yalnız sahibin açar cütü ilə imzalanmış (VAPID, ES256) sorğu qəbul edir.
   Apps Script-də ECDSA yoxdur, ona görə P-256 hesabı BigInt ilə burada yazılıb (Node-un kriptoqrafiyası ilə yoxlanılıb).
   Mesajın mətni göndərilmir (boş push): bildirişin mətnini service worker özü qurur. Bu, şifrələmə kodunu tələb etmir.
   BigInt literalı (123n) QƏSDƏN yoxdur: BigInt dəstəklənməsə yalnız bildiriş işləməz, bütün skript sintaksis xətası ilə dayanmaz. */
var PUSH_HOST_OK = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|mozaws\.net|notify\.windows\.com|push\.apple\.com)(:\d+)?\//;
var PUSH_SLOW_MS = 8000;           // push xidməti bundan yavaş cavab veribsə, 2 dəqiqə push göndərilmir (kassanın sinxron sorğusunu gözlətməsin)
var PUSH_MAX_AGE = 5 * 60000;     // bundan köhnə sorğu üçün bildiriş göndərilmir (oflayn cihaz gec sinxronlaşanda köhnə xəbərdarlıq yağmasın)
var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

var P256C = null;
function ec() {
  if (P256C) return P256C;
  var B = BigInt;
  P256C = {
    p: B('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
    n: B('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
    gx: B('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
    gy: B('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
    z0: B(0), z1: B(1), z2: B(2), z3: B(3), z4: B(4), z8: B(8)
  };
  return P256C;
}
function ecMod(x, m) { var r = x % m; return r < ec().z0 ? r + m : r; }
function ecPow(base, e, m) {
  var C = ec(), r = C.z1, b = ecMod(base, m);
  while (e > C.z0) { if (e % C.z2 === C.z1) r = (r * b) % m; b = (b * b) % m; e = e / C.z2; }
  return r;
}
function ecInv(a, m) { return ecPow(a, m - ec().z2, m); }              // m sadədir (Fermat)
function ecInf() { var C = ec(); return { x: C.z1, y: C.z1, z: C.z0 }; }
function ecDbl(P) {                                                      // Jacobian, a = −3
  var C = ec(), p = C.p;
  if (P.z === C.z0 || P.y === C.z0) return ecInf();
  var delta = (P.z * P.z) % p, gamma = (P.y * P.y) % p, beta = (P.x * gamma) % p;
  var alpha = ecMod(C.z3 * (P.x - delta) * (P.x + delta), p);
  var x3 = ecMod(alpha * alpha - C.z8 * beta, p);
  var z3 = ecMod((P.y + P.z) * (P.y + P.z) - gamma - delta, p);
  var y3 = ecMod(alpha * (C.z4 * beta - x3) - C.z8 * gamma * gamma, p);
  return { x: x3, y: y3, z: z3 };
}
function ecAdd(P, Q) {
  var C = ec(), p = C.p;
  if (P.z === C.z0) return Q;
  if (Q.z === C.z0) return P;
  var z1z1 = (P.z * P.z) % p, z2z2 = (Q.z * Q.z) % p;
  var u1 = (P.x * z2z2) % p, u2 = (Q.x * z1z1) % p;
  var s1 = (P.y * Q.z % p) * z2z2 % p, s2 = (Q.y * P.z % p) * z1z1 % p;
  var h = ecMod(u2 - u1, p);
  if (h === C.z0) return ecMod(s2 - s1, p) === C.z0 ? ecDbl(P) : ecInf();
  var i = (C.z2 * h) * (C.z2 * h) % p, j = (h * i) % p, r = ecMod(C.z2 * (s2 - s1), p), v = (u1 * i) % p;
  var x3 = ecMod(r * r - j - C.z2 * v, p);
  var y3 = ecMod(r * (v - x3) - C.z2 * s1 * j, p);
  var z3 = ecMod(((P.z + Q.z) * (P.z + Q.z) - z1z1 - z2z2) * h, p);
  return { x: x3, y: y3, z: z3 };
}
function ecMulG(k) {                                                     // k·G, affine nəticə {x, y}
  var C = ec(), G = { x: C.gx, y: C.gy, z: C.z1 }, R = ecInf(), bits = k.toString(2);
  for (var i = 0; i < bits.length; i++) {
    R = ecDbl(R);
    if (bits.charAt(i) === '1') R = ecAdd(R, G);
  }
  var zi = ecInv(R.z, C.p), zi2 = (zi * zi) % C.p;
  return { x: (R.x * zi2) % C.p, y: ((R.y * zi2) % C.p) * zi % C.p };
}
function hex32(v) { var h = v.toString(16); while (h.length < 64) h = '0' + h; return h; }
function hexBytes(h) { var out = []; for (var i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16)); return out; }
function b64u(bytes) {
  var out = '', i;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL.charAt(n >> 18) + B64URL.charAt((n >> 12) & 63) + B64URL.charAt((n >> 6) & 63) + B64URL.charAt(n & 63);
  }
  if (bytes.length - i === 1) { var a = bytes[i] << 16; out += B64URL.charAt(a >> 18) + B64URL.charAt((a >> 12) & 63); }
  else if (bytes.length - i === 2) { var b = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B64URL.charAt(b >> 18) + B64URL.charAt((b >> 12) & 63) + B64URL.charAt((b >> 6) & 63); }
  return out;
}
function b64uStr(str) { var bytes = []; for (var i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 255); return b64u(bytes); }

// ES256 imzası (JOSE formatı: r‖s, 64 bayt). k hər dəfə gizli açar + təsadüfi UUID-dən hash ilə alınır.
function ecSign(hashHex, dHex) {
  var C = ec(), d = BigInt('0x' + dHex), z = BigInt('0x' + hashHex);
  for (var t = 0; t < 20; t++) {
    var k = BigInt('0x' + hexSha256(dHex + ':' + Utilities.getUuid() + ':' + hashHex + ':' + t)) % (C.n - C.z1) + C.z1;
    var r = ecMulG(k).x % C.n;
    if (r === C.z0) continue;
    var s = ecMod(ecInv(k, C.n) * (z + r * d), C.n);
    if (s === C.z0) continue;
    return hexBytes(hex32(r) + hex32(s));
  }
  throw new Error('İmza alınmadı');
}

// Açar cütü bir dəfə yaranır (Script properties). Xüsusi (private) açar heç vaxt cihaza göndərilmir.
function vapid() {
  var props = PropertiesService.getScriptProperties();
  var d = props.getProperty('VAPID_PRIVATE'), pub = props.getProperty('VAPID_PUBLIC');
  if (d && pub) return { d: d, pub: pub };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Server məşğuldur, sonra təkrar olunacaq');
  try {
    d = props.getProperty('VAPID_PRIVATE'); pub = props.getProperty('VAPID_PUBLIC');
    if (d && pub) return { d: d, pub: pub };
    var C = ec();
    var dn = BigInt('0x' + hexSha256(Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + ':' + new Date().getTime())) % (C.n - C.z1) + C.z1;
    var P = ecMulG(dn);
    d = hex32(dn); pub = b64u([4].concat(hexBytes(hex32(P.x)), hexBytes(hex32(P.y))));
    props.setProperty('VAPID_PUBLIC', pub); props.setProperty('VAPID_PRIVATE', d);
    return { d: d, pub: pub };
  } finally { lock.releaseLock(); }
}

function vapidHeader(endpoint, v) {
  var aud = endpoint.match(/^(https:\/\/[^\/]+)/)[1];
  var contact = PropertiesService.getScriptProperties().getProperty('PUSH_CONTACT') || 'mailto:magaza-admin@example.com';
  var input = b64uStr('{"typ":"JWT","alg":"ES256"}') + '.' + b64uStr(JSON.stringify({ aud: aud, exp: Math.floor(new Date().getTime() / 1000) + 12 * 3600, sub: contact }));
  return 'vapid t=' + input + '.' + b64u(ecSign(hexSha256(input), v.d)) + ', k=' + v.pub;
}

// targets: [{endpoint}] → [{status, body}]. Boş push (mətn yoxdur); TTL 15 dəq, təcili.
function pushSend(targets) {
  var v = vapid(), cache = {}, reqs = targets.map(function (t) {
    var aud = t.endpoint.match(/^(https:\/\/[^\/]+)/)[1];
    var hdr = cache[aud] || (cache[aud] = vapidHeader(t.endpoint, v));
    return { url: t.endpoint, method: 'post', headers: { Authorization: hdr, TTL: '900', Urgency: 'high' }, muteHttpExceptions: true, followRedirects: false };
  });
  return UrlFetchApp.fetchAll(reqs).map(function (r) { return { status: r.getResponseCode(), body: String(r.getContentText() || '').slice(0, 200) }; });
}

function pushRows(ss) {
  var sh = sheet(ss, 'Push'), n = Math.max(sh.getLastRow() - 1, 0);
  var vals = n ? sh.getRange(2, 1, n, SHEETS.Push.length).getValues() : [];
  return { sh: sh, rows: vals.map(function (r, i) {
    return { row: i + 2, device: rid(r[0]), userId: rid(r[1]), userName: String(r[2]), role: String(r[3]), perms: String(r[4]).split(','), endpoint: rid(r[5]), active: r[6] === true || String(r[6]) === 'true' };
  }) };
}
function pushMark(sh, target, res) {          // 404/410: abunəlik bitib → söndürülür
  var gone = res.status === 404 || res.status === 410;
  var cur = sh.getRange(target.row, 7, 1, 1).getValues()[0][0];
  sh.getRange(target.row, 7, 1, 4).setValues([[gone ? false : (cur === true || String(cur) === 'true'), new Date().toISOString(), String(res.status), new Date().toISOString()]]);
}

function handlePush(body) {
  if (body.action === 'push.key') return { ok: true, key: vapid().pub };
  var device = String(body.device || '');
  if (!device) return { ok: false, error: 'Cihaz id-si yoxdur' };
  var ss = db();
  if (body.action === 'push.register') {
    var endpoint = String(body.endpoint || '');
    if (endpoint.length > 1000 || !PUSH_HOST_OK.test(endpoint)) return { ok: false, error: 'Bildiriş ünvanı tanınmır' };
    var perms = (Array.isArray(body.perms) ? body.perms : []).filter(function (x) { return typeof x === 'string' && /^[\w.]{1,40}$/.test(x); }).slice(0, 80).join(',');
    var row = [device, String(body.userId || ''), String(body.userName || '').slice(0, 80), String(body.role || '').slice(0, 20), perms, endpoint, true, new Date().toISOString(), '', ''];
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return { ok: false, error: 'Server məşğuldur, sonra təkrar olunacaq' };
    try {
      var pr = pushRows(ss), hit = null;
      pr.rows.forEach(function (r) { if (r.device === device) hit = r; });
      var full = fit(row, SHEETS.Push.length);
      if (hit) pr.sh.getRange(hit.row, 1, 1, full.length).setValues([full]); else pr.sh.appendRow(full);
    } finally { lock.releaseLock(); }
    return { ok: true };
  }
  if (body.action === 'push.unregister') {
    var lock2 = LockService.getScriptLock();
    if (!lock2.tryLock(25000)) return { ok: false, error: 'Server məşğuldur, sonra təkrar olunacaq' };
    try {
      var pr2 = pushRows(ss);
      pr2.rows.forEach(function (r) { if (r.device === device && r.active) pr2.sh.getRange(r.row, 7, 1, 2).setValues([[false, new Date().toISOString()]]); });
    } finally { lock2.releaseLock(); }
    return { ok: true };
  }
  // push.test: yalnız bu cihaza
  var pr3 = pushRows(ss), me = null;
  pr3.rows.forEach(function (r) { if (r.device === device && r.active) me = r; });
  if (!me) return { ok: false, error: 'Bu cihaz bildiriş üçün qeydiyyatdan keçməyib' };
  var res = pushSend([me])[0];
  try { pushMark(pr3.sh, me, res); } catch (e) { /* jurnal yazılmadısa test nəticəsi yenə qaytarılır */ }
  return { ok: true, sent: res.status >= 200 && res.status < 300, status: res.status, detail: res.body };     // ok = sorğu işləndi; sent = push xidməti qəbul etdi
}

// Yeni təsdiq sorğusu: səlahiyyəti olan başqa cihazlara push. Xəta olsa belə sinxron pozulmur.
function notifyApprovals(ss, items) {
  try {
    var now = new Date().getTime(), reqs = [];
    items.forEach(function (it) {
      var a = it.type === 'approval.requested' && it.data && it.data.approval;
      if (a && a.status === 'pending' && now - Date.parse(a.at) < PUSH_MAX_AGE) reqs.push(a);
    });
    if (!reqs.length) return;
    if (!PropertiesService.getScriptProperties().getProperty('VAPID_PRIVATE')) return;     // bildiriş heç vaxt qurulmayıb: cədvələ toxunmuruq
    if (CacheService.getScriptCache().get('pushSlow')) return;
    var pr = pushRows(ss), targets = {}, list = [];
    pr.rows.forEach(function (r) {
      if (!r.active || !r.endpoint) return;
      reqs.forEach(function (a) {
        if (r.device === a.device || (a.requestedBy && r.userId === a.requestedBy.id) || r.perms.indexOf(a.perm) === -1) return;
        if (!targets[r.endpoint]) { targets[r.endpoint] = true; list.push(r); }
      });
    });
    if (!list.length) return;
    var t0 = new Date().getTime();
    var out = pushSend(list);
    if (new Date().getTime() - t0 > PUSH_SLOW_MS) { CacheService.getScriptCache().put('pushSlow', '1', 120); Logger.log('Push xidməti yavaşdır, 2 dəqiqə göndərilmir'); }
    list.forEach(function (t, i) { try { pushMark(pr.sh, t, out[i]); } catch (e) { /* jurnal */ } });
  } catch (e) {
    try { Logger.log('Bildiriş göndərilmədi: ' + e); } catch (e2) { /* ignore */ }
  }
}
