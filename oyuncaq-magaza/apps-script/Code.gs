/**
 * 7BOXS — Google Apps Script backend (v9).
 * Kassaların hadisələrini (outbox) qəbul edib Google Sheets-ə yazır və digər cihazların hadisələrini geri verir (pull).
 *
 * Quraşdırma / yeniləmə:
 *  1. Verilənlər bazası faylını açın → Extensions → Apps Script → bu kodu yapışdırın (köhnəni əvəz edin).
 *     (Ayrıca script.google.com layihəsində də işləyir: fayl SPREADSHEET_ID ilə açılır.)
 *  2. Project Settings → Script properties: SYNC_TOKEN = uzun təsadüfi sətir (kassanın ayarlarına da eyni yazılır).
 *     v9: hər cihazın öz açarı olur (aşağıda "Cihaz açarları"). SYNC_TOKEN köhnə cihazlar üçün keçid müddətində işləyir.
 *  3. setup() funksiyasını işə salın (yeni vərəqləri yaradır, başlıqları yeniləyir; təkrar işə salmaq təhlükəsizdir).
 *  4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → URL-i kassaya yazın.
 *     Bildirişlər (v6): kod xarici push xidmətinə (UrlFetchApp) sorğu göndərir. setup()-ı redaktorda işə salanda Google yeni icazə istəyəcək
 *     ("Connect to an external service") — təsdiqləyin, sonra New version deploy edin. Bildirişi istəməsəniz də qalan hər şey işləyir.
 *     Kodu dəyişdikdən sonra: Deploy → Manage deployments → ✏️ → Version: New version → Deploy (ünvan dəyişmir).
 *
 * Arxivləşdirmə (v7): Admin → İcazələr → Arxiv (və ya redaktorda archiveNow()). Köhnə qeydlər arxiv faylına (cədvəlin nüsxəsi) köçürülür,
 * canlı cədvəldə son 45 gün qalır; cihazlar bunu hiss etmir (kursor mütləq nömrədir, köhnə hadisələr arxiv faylından oxunur).
 * Arxiv fayllarını SİLMƏYİN: yeni cihaz və uzun müddət oflayn qalan cihaz tarixçəni onlardan oxuyur.
 *
 * Cihaz açarları (v9): redaktorda bir dəfə setupAdminKey() işlədin (ADMIN_KEY jurnalda göstərilir, saxlayın). Sonra Admin tətbiqdə
 * İcazələr → Cihazlar kartında ADMIN_KEY-i yazıb cihaz id-si üçün açar yaradır, açarı həmin cihazda "Serverə qoş"a yazır.
 * İlk cihaz açarı yaradılandan 14 gün sonra SYNC_TOKEN ilə giriş bağlanır (Admin uzada və ya əvvəl söndürə bilər).
 *
 * Təhlükəsizlik (SEC-15): Sheets faylını yalnız Admin-lə paylaşın. "Users" vərəqində PIN-lərin duzlu hash-ı var.
 * Yazı yalnız bu skript vasitəsilə olur.
 */

// Verilənlər bazası faylının ID-si (Drive: "Mağaza İS — Verilənlər bazası").
// Skript cədvəlin içindən (Extensions → Apps Script) yaradılıbsa, həmin fayl istifadə olunur;
// ayrıca script.google.com-da yaradılıbsa, fayl bu ID ilə açılır.
var SPREADSHEET_ID = '1NTzVrx9ioe9elwn3c85RwU64e9NWuylaKT8uyLoe67g';
var VERSION = 9;
var SEEN_WINDOW = 1500;   // təkrar yoxlaması üçün son neçə hadisəyə baxılır (köhnə hadisə gəlsə dəqiq axtarış edilir)
var MAX_ITEMS = 300;      // bir sorğuda ən çox hadisə
var BLOCK_MAX = 1000;     // bir dəfəyə verilən ən böyük nömrə aralığı
var GRID_LIMIT = 10000000;       // Google Sheets: bir faylda 10 milyon xana. BOŞ xanalar da sayılır (vərəqin şəbəkə ölçüsü)
var ROW_SLACK = 300;             // vərəqin sonunda saxlanan boş sətir ehtiyatı
var ARCHIVE_KEEP_DAYS = 45;      // arxivləşdirəndə canlı cədvəldə qalan son günlər
var ARCHIVE_MIN_GAP = 24 * 3600000;   // iki arxivləşdirmə arasında ən az müddət (təsadüfi təkrar basmaya qarşı)
var ARCHIVE_MIN_CUT = 200;       // bundan az köhnə hadisə varsa arxivləşdirmə edilmir
var ARCHIVE_BUSY = 'Arxivləşdirmə gedir, bir neçə dəqiqə sonra təkrar olunacaq';
// Yalnız əlavə olunan vərəqlər və vaxt sütunu (1-dən). SaleLines vaxtı yoxdur: Sales-ə tabe olaraq kəsilir.
var APPEND_ONLY = [{ name: 'Sales', time: 3 }, { name: 'Returns', time: 4 }, { name: 'StockReceipts', time: 1 },
  { name: 'Shifts', time: 3 }, { name: 'CashMoves', time: 6 }, { name: 'Audit', time: 1 }];

function db() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID;
  return SpreadsheetApp.openById(id);
}

var SHEETS = {
  Events: ['id', 'at', 'type', 'userId', 'receivedAt', 'json', 'device'],
  Sales: ['id', 'receiptNo', 'at', 'shiftId', 'cashierId', 'cashierName', 'subtotal', 'discount', 'discountPercent', 'discountApprovedBy',
    'total', 'method', 'bankType', 'cashPart', 'bankPart', 'cashReceived', 'change', 'offline', 'fiscalId', 'fiscalStatus', 'lineDiscount', 'discountType'],
  SaleLines: ['saleId', 'receiptNo', 'lineIndex', 'productId', 'name', 'storeBarcode', 'qty', 'price', 'unitCost', 'negative', 'discount', 'discountPercent'],
  Returns: ['id', 'saleId', 'receiptNo', 'at', 'amount', 'cashAmount', 'bankAmount', 'bankType', 'approvedBy', 'reason'],
  Products: ['id', 'name', 'category', 'brand', 'ageGroup', 'storeBarcode', 'mfrBarcode', 'price', 'avgCost', 'lastCost', 'minStock', 'active', 'updatedAt', 'maxDiscount'],
  StockReceipts: ['at', 'productId', 'qty', 'unitCost', 'userId', 'supplierId', 'lotId', 'note'],
  Suppliers: ['id', 'name', 'phone', 'note', 'active', 'updatedAt', 'debtBasis', 'openingDebt'],
  SupplierPayments: ['id', 'supplierId', 'supplierName', 'at', 'amount', 'method', 'shiftId', 'cashMoveId', 'userName', 'note', 'voidedAt', 'voidReason', 'updatedAt'],
  Shifts: ['id', 'status', 'openedAt', 'openedBy', 'openingCash', 'closedAt', 'closedBy', 'expectedCash', 'countedCash', 'diff', 'note'],
  CashMoves: ['id', 'shiftId', 'type', 'amount', 'reason', 'at', 'userId', 'approvedBy'],
  Audit: ['at', 'type', 'userId', 'json'],
  Users: ['id', 'name', 'role', 'active', 'mustChangePin', 'updatedAt', 'salt', 'pinHash', 'cred'],
  Settings: ['key', 'value', 'updatedAt'],
  Push: ['device', 'userId', 'userName', 'role', 'perms', 'endpoint', 'active', 'updatedAt', 'lastStatus', 'lastAt']
};

// Bu hadisələr öz vərəqlərində var, "Audit"-də təkrarlanmır (Audit = təhlükəsizlik və əməliyyat jurnalı)
var HEAVY = { 'sale.created': 1, 'return.created': 1, 'product.created': 1, 'product.updated': 1, 'stock.received': 1, 'supplier.upserted': 1, 'supplier.paid': 1, 'supplier.pay_voided': 1,
  'shift.opened': 1, 'shift.closed': 1, 'cash.in': 1, 'cash.out': 1 };

function setup() {
  var ss = db();
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = SHEETS[name].length;
    var maxCols = sh.getMaxColumns();
    if (maxCols < cols) sh.insertColumnsAfter(maxCols, cols - maxCols);
    sh.getRange(1, 1, 1, cols).setValues([SHEETS[name]]);   // yeni sütunlar əlavə olunubsa başlıq yenilənir
    sh.setFrozenRows(1);
    trimGrid(sh, cols);          // boş artıq sütun/sətirlər silinir: Sheets limiti (10 milyon) boş xanaları da sayır
  });
  CacheService.getScriptCache().remove('evTotal');
  Logger.log('Hazırdır: "' + ss.getName() + '" faylında ' + Object.keys(SHEETS).length + ' vərəq yoxlanıldı. Xana sayı (limit ' + GRID_LIMIT + '): ' + gridCells(ss));
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Bağlantı yoxlaması: veb tətbiq ünvanını brauzerdə açanda {"ok":true,...} görünməlidir.
function doGet() {
  var ss = db();
  var props = PropertiesService.getScriptProperties();
  var hasToken = !!props.getProperty('SYNC_TOKEN') || props.getKeys().some(function (k) { return k.indexOf('DEV_') === 0; });
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
// Google Sheets bir xanaya ən çox 50 000 simvol qəbul edir; aşan yazı bütün sorğunu yıxar və cihazın göndərmə növbəsi həmişəlik ilişərdi.
// Ona görə hər xana bu həddə kəsilir (Events-in JSON xanası ayrıca: bax appendItems).
var CELL_MAX = 49000;
function fit(row, width) {
  var out = [];
  for (var i = 0; i < width; i++) {
    var v = i < row.length && row[i] != null ? row[i] : '';
    if (typeof v === 'string' && v.length > CELL_MAX) v = v.slice(0, CELL_MAX - 20) + '…[kəsildi]';
    out.push(v === '' ? '' : cell(v));
  }
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
// Vərəqin şəbəkəsindən kənara yazmaq xəta verir: lazım olanda sətir əlavə edilir (ehtiyatla birlikdə, API çağırışı seyrək olsun)
function ensureRows(sh, lastNeeded) {
  var max = sh.getMaxRows();
  if (max < lastNeeded) sh.insertRowsAfter(max, lastNeeded - max + ROW_SLACK);
}
// Boş artıq sütunları və sətirləri silir (dolu xanalara toxunmur)
function trimGrid(sh, usedCols) {
  var lastRow = Math.max(sh.getLastRow(), 1), keepRows = lastRow + ROW_SLACK, maxRows = sh.getMaxRows();
  if (maxRows > keepRows) sh.deleteRows(keepRows + 1, maxRows - keepRows);
  var keepCols = Math.max(sh.getLastColumn(), usedCols || 1, 1), maxCols = sh.getMaxColumns();
  if (maxCols > keepCols) sh.deleteColumns(keepCols + 1, maxCols - keepCols);
}
function gridCells(ss) {
  var n = 0, list = ss.getSheets();
  for (var i = 0; i < list.length; i++) n += list[i].getMaxRows() * list[i].getMaxColumns();
  return n;
}
Table.prototype.write = function () {
  if (this.pending.length) {
    ensureRows(this.sh, this.base + this.pending.length);
    this.sh.getRange(this.base + 1, 1, this.pending.length, this.width).setValues(this.pending);
  }
  for (var i = 0; i < this.edits.length; i++) this.sh.getRange(this.edits[i].row, 1, 1, this.width).setValues([this.edits[i].values]);
};
// Vərəqdə yeni buraxılışın sütunları yoxdursa (setup() işlədilməyib), sütunlar və başlıq özü əlavə olunur: yoxsa hər yazı xəta verib cihazların sinxronu ilişərdi
Table.prototype.heal = function () {
  var max = this.sh.getMaxColumns();
  if (max < this.width) this.sh.insertColumnsAfter(max, this.width - max);
  this.sh.getRange(1, 1, 1, this.width).setValues([SHEETS[this.name]]);
};
Table.prototype.flush = function () {
  try { this.write(); } catch (e) { this.heal(); this.write(); }       // ikinci cəhd də alınmasa xəta olduğu kimi qalır
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

/* ---------- Cihaz açarları (v9, FR-101) ----------
   Hər cihazın ÖZ açarı var: Admin cihazın id-sini yazır, sistem açarı yaradır (yalnız bir dəfə göstərilir), Admin onu həmin cihaza yazır.
   Script Properties-də açarın özü yox, SHA-256 hash-ı saxlanılır (DEV_<cihaz id>). Cihaz ləğv edilə bilər: o, bağlanır, məlumatı silinmir.
   Açar giriş hüququdur (kim, nə vaxt, ləğv): hadisənin MƏZMUNUNU yoxlamır (RİSK-2…7 qalır, bax BRD K-10).
   Köhnə ümumi açar (SYNC_TOKEN) keçid üçün işləyir: ilk cihaz açarı yaradılandan 14 gün (və ya Admin söndürənə qədər).
   Cihaz idarəsi (devices.*, legacy.*) əlavə olaraq ADMIN_KEY tələb edir (Script properties; setupAdminKey() yaradır). */
var DEV_RE = /^[A-Za-z0-9_-]{3,64}$/;
var LEGACY_DAYS = 14;
var ADMIN_MAX_FAILS = 5;          // ADMIN_KEY-i səhv yazma limiti; aşanda 10 dəqiqə bağlanır
var SEEN_EVERY = 300;             // "son görünmə" Script Properties-ə ən çox 5 dəqiqədə bir yazılır (hər sinxronda yazmaq yavaşdır)

function devId(v) { return typeof v === 'string' && DEV_RE.test(v) ? v : ''; }
function devGet(props, id) {
  var raw = id ? props.getProperty('DEV_' + id) : null;
  if (!raw) return null;
  try { var r = JSON.parse(raw); return r && typeof r === 'object' ? r : null; } catch (err) { return null; }
}
function devPut(props, id, rec) { props.setProperty('DEV_' + id, JSON.stringify(rec)); }
function devHash(id, token) { return hexSha256('dev:' + id + ':' + token); }
function newDeviceToken() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }   // 64 onaltılıq simvol, ~240 bit

// Köhnə ümumi açar: LEGACY_UNTIL yoxdursa məhdudiyyət hələ başlamayıb (heç bir cihaz açarı yaradılmayıb: təsadüfən kilidlənmə olmasın)
function legacyUntil(props) {
  var raw = props.getProperty('LEGACY_UNTIL');
  if (raw === null || raw === undefined || raw === '') return -1;
  return Number(raw) || 0;
}
function legacyActive(props) {
  if (!props.getProperty('SYNC_TOKEN')) return false;
  var u = legacyUntil(props);
  return u === -1 || u > new Date().getTime();
}
function legacyInfo(props) {
  var u = legacyUntil(props);
  return { tokenSet: !!props.getProperty('SYNC_TOKEN'), active: legacyActive(props), until: u > 0 ? new Date(u).toISOString() : null, started: u !== -1 };
}
function fail(code, error) { return { ok: false, code: code, error: error }; }

// Sorğu kimdən gəlir? → { ok, kind: 'device' | 'legacy', device } və ya { ok:false, code, error }
function authenticate(body) {
  var props = PropertiesService.getScriptProperties();
  var token = typeof body.token === 'string' ? body.token : '';
  var id = devId(body.device);
  var rec = devGet(props, id);
  var legacyTok = props.getProperty('SYNC_TOKEN');
  var isLegacy = !!legacyTok && sameToken(token, legacyTok);
  var isOwn = !!(rec && rec.hash && token && sameToken(devHash(id, token), rec.hash));
  // Ləğv olunmuş cihaza yalnız açarı doğrudursa bildirilir (cihaz özünü kilidləsin); başqasına "icazə yoxdur"
  if (rec && rec.status === 'revoked') return (isOwn || isLegacy) ? fail('revoked', 'Bu cihaz bloklanıb') : fail('denied', 'İcazə yoxdur');
  if (isOwn) return { ok: true, kind: 'device', device: id };
  if (isLegacy) return legacyActive(props) ? { ok: true, kind: 'legacy', device: id } : fail('legacy_off', 'İcazə yoxdur');
  return fail('denied', 'İcazə yoxdur');
}

// "Son görünmə": keşdə qısa işarə, Script Properties-ə seyrək yazı
function touchSeen(auth) {
  if (!auth.device) return;
  try {
    var c = CacheService.getScriptCache(), key = 'lsw_' + auth.device;
    if (c.get(key) === auth.kind) return;
    c.put(key, auth.kind, SEEN_EVERY);
    PropertiesService.getScriptProperties().setProperty('ls_' + auth.device, JSON.stringify({ at: new Date().toISOString(), kind: auth.kind }));
  } catch (err) { /* son görünmə vacib deyil: sinxronu pozmur */ }
}

function adminCheck(body) {
  var key = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!key) return fail('adminkey_unset', 'ADMIN_KEY təyin olunmayıb: Apps Script-də setupAdminKey() funksiyasını işlədin');
  var c = CacheService.getScriptCache(), fails = Number(c.get('adm_fail') || 0);
  if (fails >= ADMIN_MAX_FAILS) return fail('adminkey_locked', 'Çox səhv cəhd: 10 dəqiqə gözləyin');
  if (!sameToken(body.adminKey, key)) { c.put('adm_fail', String(fails + 1), 600); return fail('adminkey_bad', 'Admin açarı səhvdir'); }
  if (fails) c.remove('adm_fail');
  return { ok: true };
}

function cleanName(v, fallback) {
  var s = typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) : '';
  return s || fallback || '';
}

function auditAdmin(type, data) {
  var b = new Batch(db());
  b.table('Audit').add([new Date().toISOString(), type, 'server', JSON.stringify(data)]);
  b.flush();
}

function listDevices(props) {
  var all = props.getProperties(), devices = [], known = {};
  function parse(s) { try { return JSON.parse(s); } catch (err) { return null; } }
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('DEV_') !== 0) return;
    var id = k.slice(4), rec = parse(all[k]) || {}, ls = parse(all['ls_' + id]) || {};
    known[id] = true;
    devices.push({ id: id, name: rec.name || '', status: rec.status === 'revoked' ? 'revoked' : 'active', hasToken: !!rec.hash,
      createdAt: rec.createdAt || null, rotatedAt: rec.rotatedAt || null, revokedAt: rec.revokedAt || null, reason: rec.reason || '',
      lastSeen: ls.at || null, lastKind: ls.kind || null });
  });
  var unknown = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('ls_') !== 0 || known[k.slice(3)]) return;
    var ls = parse(all[k]) || {};
    unknown.push({ id: k.slice(3), lastSeen: ls.at || null, lastKind: ls.kind || null });
  });
  devices.sort(function (a, b) { return String(b.lastSeen || b.createdAt || '').localeCompare(String(a.lastSeen || a.createdAt || '')); });
  unknown.sort(function (a, b) { return String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')); });
  return { ok: true, devices: devices, unknown: unknown, legacy: legacyInfo(props) };
}

// Admin əməliyyatları: əsas sorğu doğrulamasından (cihaz/ümumi açar) sonra əlavə olaraq ADMIN_KEY tələb olunur
function handleAdmin(body, auth) {
  var chk = adminCheck(body);
  if (!chk.ok) return chk;
  var props = PropertiesService.getScriptProperties();
  if (body.action === 'devices.list') return listDevices(props);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return fail('busy', 'Server məşğuldur, sonra təkrar olunacaq');
  try {
    if (body.action === 'legacy.set') {
      var days = Math.floor(Number(body.days));
      var mode = body.mode === 'on' ? 'on' : body.mode === 'off' ? 'off' : '';
      if (!mode) return fail('bad', 'Əməliyyat səhvdir');
      if (mode === 'on') {
        if (!(days >= 1 && days <= 90)) return fail('bad', 'Müddət 1–90 gün olmalıdır');
        props.setProperty('LEGACY_UNTIL', String(new Date().getTime() + days * 86400000));
      } else {
        // Hamını kilidləməmək üçün: ən az bir aktiv cihaz açarı olmalıdır və sorğunu göndərən cihaz özü ümumi açarla işləməməlidir
        if (!listDevices(props).devices.some(function (d) { return d.hasToken && d.status === 'active'; })) return fail('no_devices', 'Heç bir cihaza ayrıca açar verilməyib: ümumi açarı söndürmək hamını kilidləyər');
        if (auth.kind === 'legacy') return fail('self_legacy', 'Bu kompüter hələ ümumi açarla işləyir: əvvəl ona ayrıca açar yazın');
        props.setProperty('LEGACY_UNTIL', '0');
      }
      auditAdmin('legacy.set', { mode: mode, days: mode === 'on' ? days : 0 });
      return { ok: true, legacy: legacyInfo(props) };
    }
    var id = devId(body.id);
    if (!id) return fail('bad', 'Cihaz id-si səhvdir (3–64 simvol: hərf, rəqəm, _ və -)');
    var rec = devGet(props, id), at = new Date().toISOString(), token;
    switch (body.action) {
      case 'devices.create':
      case 'devices.rotate':
        if (rec && rec.status === 'revoked') return fail('dev_revoked', 'Cihaz bloklanıb: əvvəlcə bərpa edin');
        if (body.action === 'devices.create' && rec && rec.hash) return fail('exists', 'Bu cihaz üçün açar artıq var. "Yeni açar" seçin');
        if (body.action === 'devices.rotate' && !rec) return fail('missing', 'Cihaz tapılmadı');
        token = newDeviceToken();
        rec = rec || { createdAt: at };
        rec.name = cleanName(body.name, rec.name || id.slice(-8));
        rec.status = 'active'; rec.hash = devHash(id, token);
        if (body.action === 'devices.rotate') rec.rotatedAt = at;
        devPut(props, id, rec);
        if (legacyUntil(props) === -1) props.setProperty('LEGACY_UNTIL', String(new Date().getTime() + LEGACY_DAYS * 86400000));   // keçid pəncərəsi ilk cihaz açarı ilə başlayır
        auditAdmin(body.action === 'devices.create' ? 'device.created' : 'device.rotated', { id: id, name: rec.name });
        return { ok: true, id: id, token: token, name: rec.name, legacy: legacyInfo(props) };
      case 'devices.revoke':
        rec = rec || { createdAt: at, name: cleanName(body.name, id.slice(-8)) };
        rec.status = 'revoked'; rec.revokedAt = at; rec.reason = cleanName(body.reason, '');
        devPut(props, id, rec);
        try {                                   // bildiriş də kəsilir
          var pr = pushRows(db());
          pr.rows.forEach(function (r) { if (r.device === id && r.active) pr.sh.getRange(r.row, 7, 1, 2).setValues([[false, at]]); });
        } catch (err) { /* bildiriş qurulmayıb: vacib deyil */ }
        auditAdmin('device.revoked', { id: id, name: rec.name, reason: rec.reason });
        return { ok: true, id: id };
      case 'devices.restore':
        if (!rec) return fail('missing', 'Cihaz tapılmadı');
        rec.status = 'active'; rec.revokedAt = null; rec.reason = '';
        devPut(props, id, rec);
        auditAdmin('device.restored', { id: id, name: rec.name });
        return { ok: true, id: id };
      case 'devices.rename':
        if (!rec) return fail('missing', 'Cihaz tapılmadı');
        rec.name = cleanName(body.name, rec.name);
        devPut(props, id, rec);
        auditAdmin('device.renamed', { id: id, name: rec.name });
        return { ok: true, id: id };
      default:
        return fail('bad', 'Naməlum əməliyyat');
    }
  } finally {
    lock.releaseLock();
  }
}

// Redaktorda bir dəfə işə salın: Admin açarı yaranır və jurnalda göstərilir (təkrar işə salmaq mövcud açarı dəyişmir).
// Bu açar yalnız cihazları idarə edəndə (tətbiqdə "Cihazlar" kartı) lazımdır; cihazda saxlanmır, hər dəfə əl ilə yazılır.
function setupAdminKey() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ADMIN_KEY')) { Logger.log('ADMIN_KEY artıq var. Dəyişmək üçün onu Script properties-dən silib bu funksiyanı təkrar işə salın.'); return null; }
  var key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty('ADMIN_KEY', key);
  Logger.log('ADMIN_KEY (bir yerdə, məsələn parol meneceri; təkrar göstərilməyəcək): ' + key);
  return key;
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'JSON səhvdir' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, error: 'JSON səhvdir' });

  var auth = authenticate(body);
  if (!auth.ok) return json(auth);
  touchSeen(auth);

  try {
    switch (body.action) {
      case 'ping':
        var pr = { ok: true, version: VERSION, kind: auth.kind };
        if (auth.kind === 'legacy') pr.legacyUntil = legacyInfo(PropertiesService.getScriptProperties()).until;
        return json(pr);
      case 'sync': var sr = handleSync(body); sr.kind = auth.kind; return json(sr);
      case 'devices.list': case 'devices.create': case 'devices.rotate': case 'devices.revoke': case 'devices.restore': case 'devices.rename': case 'legacy.set':
        return json(handleAdmin(body, auth));
      case 'allocate': return json(handleAllocate(body));
      case 'archive.status': return json(archiveStatus());
      case 'archive.run':
        if (body.confirm !== 'ARXIV') return json({ ok: false, error: 'Təsdiq lazımdır' });
        return json(archiveRun({}));
      case 'push.key': case 'push.register': case 'push.unregister': case 'push.test': return json(handlePush(body));
      default: return json({ ok: false, error: 'Naməlum əməliyyat' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
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
  var total, ss, st;
  if (!items.length && !wantAlloc) {
    // Sürətli yol: yeni hadisə yoxdursa cədvəl açılmır (təxminən 0,1–0,3 san)
    var cached = cacheTotal();
    if (cached !== null && cached === since) return { ok: true, acked: [], events: [], next: since, more: false, now: new Date().toISOString() };
  } else {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return { ok: false, error: 'Server məşğuldur, sonra təkrar olunacaq' };
    try {
      ss = db();
      st = archFix();                            // yarımçıq arxivləşdirmə varsa sağaldılır
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
  st = st || archRead();                         // kilidsiz yol: arxivləşdirmə gedirsə "gözləyin"
  if (fresh.length) notifyApprovals(ss, fresh);       // kilid buraxıldıqdan sonra; xəta sinxronu pozmur
  var events = sheet(ss, 'Events');
  // Kursor MÜTLƏQ nömrədir (arxivə köçürülmüş hadisələr də sayılır): arxivləşdirmə cihazların kursorunu dəyişmir
  if (total === undefined) total = st.base + Math.max(events.getLastRow() - 1, 0);
  else total = Math.max(total, 0);

  // Müştərinin kursoru serverdən irəlidədirsə (cədvəl təmizlənibsə), kursor geri qaytarılır
  if (since > total) { cacheTotal(total); return { ok: true, acked: acked, events: [], next: total, more: false, rewind: true, blocks: blocks, now: new Date().toISOString() }; }
  cacheRaise(total);

  var out = [], next = since;
  if (total > since) {
    var src = archSource(ss, st, events, since, total);      // canlı cədvəl və ya arxiv faylı
    var n = Math.min(limit, src.end - since);
    var rows = src.sh.getRange(since - src.off + 2, 1, n, 7).getValues();
    for (var i = 0; i < rows.length; i++) {
      next = since + i + 1;
      var r = rows[i];
      if (String(r[6]) === device) continue;                          // öz hadisəsini geri göndərmirik
      var data = null;
      try { data = JSON.parse(r[5]); } catch (err) { data = null; }
      out.push({ seq: next, id: rid(r[0]), at: iso(r[1]), type: String(r[2]), userId: String(r[3] || ''), device: String(r[6] || ''), data: data });
    }
    // Oxuyarkən arxivləşdirmə başlayıbsa sətirlər sürüşə bilərdi: nəticə atılır, cihaz təkrar soruşur
    var st2 = archState();
    if (st2.trim || st2.base !== st.base) throw new Error(ARCHIVE_BUSY);
  }
  return { ok: true, acked: acked, events: out, next: next, more: total > next, blocks: blocks, now: new Date().toISOString() };
}

// Hadisələri yazır (kilid altında çağırılır). Qaytarır: Events-də yeni sətir sayı
function appendItems(ss, items, acked, device, fresh) {
  var batch = new Batch(ss);
  var ev = batch.table('Events');
  var total = archState().base + Math.max(ev.base - 1, 0);      // mütləq say (arxivə köçürülənlər daxil)

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
      var json = JSON.stringify(it.data == null ? {} : it.data);
      if (json.length > CELL_MAX) {          // xanaya sığmayan hadisə növbəni ilişdirməsin: qəbul olunur, Events-də işarə qalır, Audit-də qeyd düşür
        batch.table('Audit').add([now, 'server.event_too_big', it.userId || '', JSON.stringify({ id: id, type: it.type, size: json.length })]);
        json = JSON.stringify({ _tooBig: json.length });
      }
      ev.add([id, it.at, it.type, it.userId || '', now, json, it.device || device || '']);
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
  var m = 0;
  if (!sh || sh.getLastRow() < 2) return key === 'receiptSeq' ? (archState().maxReceipt || 0) : 0;
  var vals = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    var v = rid(vals[i][0]);
    var n = key === 'productSeq' ? parseInt(v.substr(2, 10), 10) : parseInt(v, 10);
    if (n > m) m = n;
  }
  if (key === 'receiptSeq') m = Math.max(m, archState().maxReceipt || 0);      // arxivə köçürülmüş çeklərin ən böyük nömrəsi
  return m;
}

/* ---------- Arxivləşdirmə ----------
   Problem: Google Sheets bir faylda 10 milyon xanaya icazə verir və BOŞ xanaları da sayır. Hər çek ~60+ xana yazır, ona görə vaxt keçdikcə fayl dolur və sinxron dayanır.
   Həll (log rotasiyası): Events və əlavə olunan vərəqlərin köhnə sətirləri cədvəlin NÜSXƏSİNƏ (arxiv faylı) köçürülür, canlı cədvəldə son ARCHIVE_KEEP_DAYS gün qalır.
   - Kursor mütləq nömrədir: Script property "ARCHIVE" = { base, segs, last, maxReceipt, trim }.
     Canlı Events-in 2-ci sətri = mütləq hadisə #base. Cihaz kursoru base-dən kiçikdirsə (yeni cihaz / uzun oflayn), hadisələr uyğun arxiv faylından oxunur.
   - Nüsxə tam yoxlanılmayınca heç nə silinmir; silinmədən əvvəl "trim" markeri yazılır (iş yarımçıq qalsa növbəti sorğu özü sağaldır).
   - Oxuyan sorğu arxivləşdirmə ilə toqquşsa nəticə atılır ("gözləyin"), cihaz bir az sonra təkrar soruşur.
   - Hamısı skript kilidi altında gedir; bu müddətdə (adətən 10–60 san) digər sorğular "Server məşğuldur" alıb təkrar cəhd edir. İşdən sonra edin. */
function archState() {
  var st = { base: 0, segs: [], last: '', maxReceipt: 0, trim: null };
  var raw = PropertiesService.getScriptProperties().getProperty('ARCHIVE');
  if (raw) {
    try {
      var o = JSON.parse(raw);
      st.base = Number(o.base) || 0; st.segs = Array.isArray(o.segs) ? o.segs : []; st.last = String(o.last || '');
      st.maxReceipt = Number(o.maxReceipt) || 0; st.trim = o.trim && typeof o.trim === 'object' ? o.trim : null;
    } catch (e) { /* pozulmuş dəyər: ilkin vəziyyət (Events toxunulmaz qalır) */ }
  }
  return st;
}
function archSave(st) { PropertiesService.getScriptProperties().setProperty('ARCHIVE', JSON.stringify(st)); }
function archApply(st) {
  var tr = st.trim;
  st.base += tr.cut; st.segs.push(tr.seg); st.maxReceipt = Math.max(st.maxReceipt, tr.maxReceipt || 0); st.last = tr.at; st.trim = null;
  archSave(st);
}
// Kilid ALTINDA çağırılır: yarımçıq qalmış arxivləşdirməni sağaldır
function archRecover(st) {
  var tr = st.trim, live = Math.max(sheet(db(), 'Events').getLastRow() - 1, 0);
  if (live === tr.live - tr.cut) archApply(st);                      // sətirlər silinib, vəziyyət yazılmayıb: tamamlanır
  else if (live === tr.live) { st.trim = null; archSave(st); }       // heç nə silinməyib: marker təmizlənir (nüsxə faylı artıq qalır)
  else throw new Error('Arxiv vəziyyəti uyğunsuzdur (canlı ' + live + ', gözlənilən ' + tr.live + ' və ya ' + (tr.live - tr.cut) + '): əl ilə yoxlayın');
}
function archFix() { var st = archState(); if (st.trim) { archRecover(st); st = archState(); } return st; }
// Kilidsiz oxuma yolu: arxivləşdirmə gedirsə gözləməyi tələb edir; yarımçıq qalıbsa (kilid boşdur) sağaldır
function archRead() {
  var st = archState();
  if (!st.trim) return st;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) throw new Error(ARCHIVE_BUSY);
  try { return archFix(); } finally { lock.releaseLock(); }
}

// since mütləq nömrəsindəki hadisələrin oxunacağı vərəq: {sh, off (vərəqin 2-ci sətrinin mütləq nömrəsi), end (bu vərəqdən oxunan son mütləq nömrə, daxil deyil)}
function archSource(ss, st, events, since, total) {
  if (since >= st.base) return { sh: events, off: st.base, end: total };
  var k = -1;
  for (var i = 0; i < st.segs.length; i++) if (st.segs[i].f <= since) k = i;
  if (k < 0) throw new Error('Arxiv faylı tapılmadı: hadisə #' + since);
  var seg = st.segs[k], end = k + 1 < st.segs.length ? st.segs[k + 1].f : st.base, file, sh;
  try { file = SpreadsheetApp.openById(seg.i); } catch (e) { throw new Error('Arxiv faylı açıla bilmədi (' + seg.i + '): ' + e); }
  sh = file.getSheetByName('Events');
  if (!sh) throw new Error('Arxiv faylında "Events" vərəqi yoxdur (' + seg.i + ')');
  return { sh: sh, off: seg.f, end: Math.min(end, seg.t) };
}

// Başdan ardıcıl, cutoff-dan köhnə sətirlərin sayı (boş vaxtda dayanır)
function oldPrefix(sh, timeCol, cutoff) {
  var n = Math.max(sh.getLastRow() - 1, 0);
  if (!n) return 0;
  var vals = sh.getRange(2, timeCol, n, 1).getValues(), i = 0;
  while (i < n && vals[i][0] !== '' && iso(vals[i][0]) < cutoff) i++;
  return i;
}

function archiveStatus() {
  var ss = db(), st = archRead(), cells = gridCells(ss);
  var live = Math.max(sheet(ss, 'Events').getLastRow() - 1, 0), sales = Math.max(sheet(ss, 'Sales').getLastRow() - 1, 0);
  return {
    ok: true, version: VERSION, cells: cells, limit: GRID_LIMIT, pct: Math.round(cells / GRID_LIMIT * 1000) / 10,
    base: st.base, live: live, total: st.base + live, sales: sales, last: st.last, keepDays: ARCHIVE_KEEP_DAYS,
    nextAt: st.last ? new Date(Date.parse(st.last) + ARCHIVE_MIN_GAP).toISOString() : '',
    segs: st.segs.map(function (g) { return { id: g.i, url: 'https://docs.google.com/spreadsheets/d/' + g.i, from: g.f, to: g.t, at: g.a, moved: g.n }; })
  };
}

// opts: { keepDays, force } (force yalnız redaktordan: veb sorğu onu göndərə bilmir)
function archiveRun(opts) {
  opts = opts || {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Server məşğuldur, sonra təkrar olunacaq');
  try {
    var ss = db(), st = archFix(), nowMs = Date.now(), at = new Date(nowMs).toISOString();
    if (!opts.force && st.last && nowMs - Date.parse(st.last) < ARCHIVE_MIN_GAP) throw new Error('Son arxivləşdirmədən 24 saat keçməyib (' + st.last.slice(0, 16).replace('T', ' ') + ' UTC)');
    if (JSON.stringify(st).length > 7500) throw new Error('Arxiv siyahısı doldu (Script properties həddi): köhnə arxivləri birləşdirmək lazımdır');
    var keep = opts.keepDays != null ? Math.max(Number(opts.keepDays) || 0, 0) : ARCHIVE_KEEP_DAYS;
    var cutoff = new Date(nowMs - keep * 86400000).toISOString();

    // 1) Nə köçürüləcək (hələ heç nə dəyişmir)
    var ev = sheet(ss, 'Events'), live = Math.max(ev.getLastRow() - 1, 0);
    var cut = Math.min(oldPrefix(ev, 5, cutoff), live - SEEN_WINDOW);      // son SEEN_WINDOW hadisə canlı qalır: təkrar yoxlaması işləsin
    if (cut < (opts.force ? 1 : ARCHIVE_MIN_CUT)) return { ok: true, archived: false, reason: 'Arxivləşdirməyə dəyər köhnə qeyd yoxdur (' + keep + ' gündən köhnə: ' + Math.max(cut, 0) + ' hadisə)', cells: gridCells(ss) };
    var plan = [], removedSales = {}, haveSales = false;
    APPEND_ONLY.forEach(function (p) {
      var sh = sheet(ss, p.name), k = oldPrefix(sh, p.time, cutoff);
      if (p.name === 'Sales' && k) { var ids = sh.getRange(2, 1, k, 1).getValues(); for (var i = 0; i < k; i++) removedSales[rid(ids[i][0])] = true; haveSales = true; }
      plan.push({ name: p.name, sh: sh, k: k });
    });
    var sl = sheet(ss, 'SaleLines'), nsl = Math.max(sl.getLastRow() - 1, 0), kl = 0;
    if (haveSales && nsl) { var sids = sl.getRange(2, 1, nsl, 1).getValues(); while (kl < nsl && removedSales[rid(sids[kl][0])]) kl++; }
    plan.push({ name: 'SaleLines', sh: sl, k: kl });
    var maxReceipt = derivedMax(ss, 'receiptSeq');      // silinəcək çeklərin ən böyük nömrəsi yadda qalır (nömrə təkrarlanmasın)

    // 2) Tam nüsxə (Drive-da yeni fayl) və yoxlama: nüsxə tam deyilsə HEÇ NƏ silinmir
    var name = '7BOXS — Arxiv ' + at.slice(0, 10) + ' (hadisə ' + (st.base + 1) + '–' + (st.base + live) + ')';
    var copy = ss.copy(name);
    ['Events', 'Sales', 'SaleLines'].forEach(function (n) {
      var a = sheet(ss, n).getLastRow(), cs = copy.getSheetByName(n), b = cs ? cs.getLastRow() : -1;
      if (a !== b) throw new Error('Arxiv nüsxəsi tam deyil (' + n + ': ' + b + '/' + a + '). Köhnə qeydlər silinmədi');
    });

    // 3) Marker → Events-dən köhnə sətirlər → vəziyyət. Marker yazıldıqdan sonra iş yarımçıq qalsa archRecover sağaldır.
    st.trim = { live: live, cut: cut, at: at, maxReceipt: maxReceipt, seg: { i: copy.getId(), f: st.base, t: st.base + live, a: at, n: cut } };
    archSave(st);
    try { ev.deleteRows(2, cut); } catch (e) { st.trim = null; archSave(st); throw e; }
    archApply(st);

    // 4) Əlavə olunan vərəqlər (xəta olsa belə Events artıq düzgündür) + boş şəbəkənin kəsilməsi
    var removed = { Events: cut }, warnings = [];
    plan.forEach(function (p) {
      if (!p.k) return;
      try { p.sh.deleteRows(2, p.k); removed[p.name] = p.k; } catch (e) { warnings.push(p.name + ': ' + e); }
    });
    ss.getSheets().forEach(function (sh) {
      var spec = SHEETS[sh.getName()];
      if (!spec) return;
      try { trimGrid(sh, spec.length); } catch (e) { warnings.push(sh.getName() + ' (şəbəkə): ' + e); }
    });
    var audit = new Table(ss, 'Audit');
    audit.add([at, 'server.archive', '', JSON.stringify({ file: copy.getId(), name: name, removed: removed, base: st.base, warnings: warnings })]);
    audit.flush();
    return { ok: true, archived: true, name: name, id: copy.getId(), url: copy.getUrl(), removed: removed, base: st.base, live: live - cut, cells: gridCells(ss), warnings: warnings };
  } finally {
    lock.releaseLock();
  }
}

// Redaktorda "Run": arxivləşdirmə (Admin ekranındakı düymə ilə eynidir). Nəticə Execution log-da.
function archiveNow() { var r = archiveRun({}); Logger.log(JSON.stringify(r)); return r; }
function archiveStatusLog() { var r = archiveStatus(); Logger.log(JSON.stringify(r)); return r; }

/* ---------- Hadisəni oxunaqlı vərəqlərə yazır ---------- */
function project(batch, it) {
  var d = it.data || {};
  if (!HEAVY[it.type]) batch.table('Audit').add([it.at, it.type, it.userId || '', JSON.stringify(redact(it.type, d))]);
  switch (it.type) {
    case 'sale.created': {
      var s = d.sale, p = s.payment;
      batch.table('Sales').add([s.id, s.receiptNo, s.at, s.shiftId, s.cashierId, s.cashierName, s.totals.subtotal / 100, s.totals.discount / 100,
        s.discount && s.discount.percent != null ? s.discount.percent : '', s.discount ? s.discount.approvedByName : '', s.totals.total / 100, p.method, p.bankType || '',
        p.cashPart / 100, p.bankPart / 100, p.cashReceived / 100, p.change / 100, s.offline, s.fiscal.id || '', s.fiscal.status,
        (s.totals.lineDiscount || 0) / 100, s.discount ? (s.discount.type === 'amount' ? 'amount' : 'percent') : '']);
      s.lines.forEach(function (l, i) {
        batch.table('SaleLines').add([s.id, s.receiptNo, i, l.productId, l.name, l.storeBarcode, l.qty, l.price / 100, l.unitCost / 100, l.negative,
          (l.discount || 0) / 100, l.discountPercent != null ? l.discountPercent : '']);
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
        pr.minStock, pr.active, it.at, pr.maxDiscount || 0]);
      break;
    }
    case 'stock.received':
      batch.table('StockReceipts').add([d.at || it.at, d.productId, d.qty, d.unitCost / 100, it.userId || '', d.supplierId || '', d.lotId || '', d.note || '']);
      break;
    case 'supplier.upserted': {
      var sp = d.supplier;
      batch.table('Suppliers').upsert([sp.id, sp.name, sp.phone || '', sp.note || '', sp.active, sp.updatedAt, sp.debtBasis || 'received', (sp.openingDebt || 0) / 100]);
      break;
    }
    case 'supplier.paid':
    case 'supplier.pay_voided': {
      // Ödəniş (nağd olarsa kassa hərəkəti ayrıca cash.out/in hadisəsi ilə CashMoves-a düşür). Ləğv hadisəsi ödənişin yenilənmiş surətini daşıyır
      var py = d.pay;
      if (py && py.id) batch.table('SupplierPayments').upsert([py.id, py.supplierId, py.supplierName || '', py.at, (py.amount || 0) / 100, py.method, py.shiftId || '', py.cashMoveId || '', py.userName || '', py.note || '', py.voidedAt || '', py.voidReason || '', py.updatedAt || py.at]);
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
      batch.table('Users').upsert([u.id, u.name, u.role, u.active, u.mustChangePin, u.updatedAt, u.salt, u.pinHash, credOf(u)]);
      break;
    }
    case 'admin.matrix_changed':
      batch.table('Settings').upsert(['matrix', JSON.stringify(d.after), it.at]);
      break;
    case 'admin.auth_policy_changed':
      batch.table('Settings').upsert(['authPolicy', JSON.stringify(d.after), it.at]);      // rol üzrə giriş forması: pin / password
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
  return { reason: d.reason, user: { id: u.id, name: u.name, role: u.role, active: u.active, mustChangePin: u.mustChangePin, cred: credOf(u), updatedAt: u.updatedAt } };
}
// Hazırkı giriş forması hash-ın formatından: "p1$…" = şifrə (PBKDF2), qalanı PIN (SHA-256). Cədvəldə oxunaqlılıq üçündür, cihazlar özləri hesablayır.
function credOf(u) { return /^p1\$\d+\$[0-9a-f]{64}$/.test(String(u && u.pinHash || '')) ? 'password' : 'pin'; }


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
    var props = PropertiesService.getScriptProperties();
    pr.rows.forEach(function (r) {
      if (!r.active || !r.endpoint) return;
      var dv = devGet(props, devId(r.device));
      if (dv && dv.status === 'revoked') return;          // ləğv olunmuş cihaza bildiriş getmir
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
