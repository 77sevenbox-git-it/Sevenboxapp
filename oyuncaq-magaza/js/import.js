/* Məhsulların Excel (.xlsx) / CSV-dən toplu yüklənməsi (FR-113): fayl oxuma, sütunların tanınması, yoxlama, dublikat təsnifatı, şablon.
   Üçüncü tərəf kitabxana yoxdur: .xlsx fayl ZIP-dir, brauzerin daxili DecompressionStream-i ilə açılır və XML sətir-sətir oxunur
   (CSP dəyişmir, oflayn işləyir, xarici koda etibar lazım deyil). Bu fayl DOM-a toxunmur: node testlərində də işləyir. */
(function (root) {
  'use strict';
  var _t = (root.I18n || { t: function (s, p) { return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { return p && p[i] != null ? p[i] : m; }); } }).t;
  var R = root.Rules || (typeof require !== 'undefined' ? require('./rules.js') : null);
  var M = root.Money || (typeof require !== 'undefined' ? require('./money.js') : null);

  var MAX_ROWS = 500;                      // bir yükləmədə ən çox məhsul sətri (AS-43)
  var MAX_FILE = 10 * 1024 * 1024;         // fayl ölçüsü
  var MAX_ENTRY = 40 * 1024 * 1024;        // ZIP-in içindəki bir faylın açılmış ölçüsü (zip-bomba qoruması)
  var MAX_ROW_NO = 100000;                 // Excel sətir nömrəsi bundan böyükdürsə sətir atılır (saxta r="4294967290")
  var MAX_SCAN_ROWS = 20000;               // cədvəldə boş sətirlər çox ola bilər; bundan sonra oxumaq dayanır

  /* ---------- Sütun adları: Azərbaycan, ingilis, rus, türk. Açarlar Rules.foldAz ilə sadələşdirilir (ə→e, ı→i, ...) ---------- */
  var FIELDS = [
    { key: 'name', required: true, alias: ['ad', 'adi', 'mehsul', 'mehsul adi', 'mehsulun adi', 'name', 'product', 'product name', 'urun adi', 'urun', 'наименование', 'название', 'товар'] },
    { key: 'category', alias: ['kateqoriya', 'kategoriya', 'category', 'kategori', 'категория'] },
    { key: 'brand', alias: ['brend', 'marka', 'brand', 'бренд', 'марка'] },
    { key: 'ageGroup', alias: ['yas qrupu', 'yas', 'age', 'age group', 'yas grubu', 'возраст', 'возрастная группа'] },
    { key: 'mfrBarcode', alias: ['istehsalci barkodu', 'istehsalci barkod', 'istehsalci kodu', 'barkod', 'barcode', 'mfr', 'mfr barcode', 'manufacturer barcode', 'uretici barkodu', 'штрихкод', 'штрихкод производителя'] },
    { key: 'price', required: true, alias: ['satis qiymeti', 'satis', 'qiymet', 'price', 'sale price', 'satis fiyati', 'fiyat', 'цена', 'цена продажи'] },
    { key: 'cost', alias: ['alis qiymeti', 'alis', 'maya', 'cost', 'purchase price', 'alis fiyati', 'maliyet', 'себестоимость', 'закупочная цена'] },
    { key: 'minStock', alias: ['minimum qaliq', 'min qaliq', 'minimum', 'min', 'min stock', 'minimum stock', 'minimum stok', 'минимальный остаток', 'мин остаток'] },
    { key: 'maxDiscount', alias: ['max endirim', 'maksimum endirim', 'endirim', 'max discount', 'maksimum indirim', 'макс скидка', 'максимальная скидка'] },
    { key: 'opening', alias: ['acilis qaliqi', 'qaliq', 'say', 'miqdar', 'stock', 'qty', 'quantity', 'opening stock', 'adet', 'stok', 'остаток', 'количество', 'начальный остаток'] }
  ];
  function normHeader(h) { return R.foldAz(h).replace(/[^a-z0-9а-я]+/g, ' ').trim(); }
  var ALIAS = {};
  FIELDS.forEach(function (f) { f.alias.forEach(function (a) { ALIAS[normHeader(a)] = f.key; }); });

  /* ---------- Mətn köməkçiləri ---------- */
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, e) {
      if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
      var code = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (x) { return ''; }
    });
  }
  function cleanName(n) { return String(n == null ? '' : n).replace(/\s+/g, ' ').trim(); }
  function utf8(u8, fatal) { return new TextDecoder('utf-8', { fatal: !!fatal }).decode(u8); }

  /* ---------- ZIP oxuyucu (yalnız lazım olan: mərkəzi qovluq + saxlanmış/deflate fayllar) ---------- */
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }
  function readZipIndex(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) { if (u32(dv, i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error(_t('Bu fayl düzgün Excel (.xlsx) faylı deyil'));
    var count = u16(dv, eocd + 10), p = u32(dv, eocd + 16), entries = {};
    if (count === 0xFFFF || p === 0xFFFFFFFF) throw new Error(_t('Bu Excel faylı çox böyükdür və ya dəstəklənməyən formatdadır'));
    for (var n = 0; n < count; n++) {
      if (p + 46 > bytes.length || u32(dv, p) !== 0x02014b50) throw new Error(_t('Bu fayl düzgün Excel (.xlsx) faylı deyil'));
      var flags = u16(dv, p + 8), method = u16(dv, p + 10), csize = u32(dv, p + 20), usize = u32(dv, p + 24);
      var nl = u16(dv, p + 28), el = u16(dv, p + 30), cl = u16(dv, p + 32), lho = u32(dv, p + 42);
      var name = utf8(bytes.subarray(p + 46, p + 46 + nl));
      entries[name] = { method: method, csize: csize, usize: usize, lho: lho, encrypted: (flags & 1) === 1 };
      p += 46 + nl + el + cl;
    }
    return entries;
  }
  function entryBytes(bytes, e) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (e.encrypted) throw new Error(_t('Parolla qorunan Excel faylı oxunmur. Parolu götürüb yenidən saxlayın'));
    if (e.lho + 30 > bytes.length || u32(dv, e.lho) !== 0x04034b50) throw new Error(_t('Bu fayl düzgün Excel (.xlsx) faylı deyil'));
    var start = e.lho + 30 + u16(dv, e.lho + 26) + u16(dv, e.lho + 28);
    if (start + e.csize > bytes.length) throw new Error(_t('Bu fayl düzgün Excel (.xlsx) faylı deyil'));
    return bytes.subarray(start, start + e.csize);
  }
  // Brauzerin daxili açıcısı. Axın hissə-hissə oxunur və həddi keçərsə dayandırılır (kiçik ZIP-dən nəhəng fayl çıxmasın)
  function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error(_t('Bu brauzer .xlsx faylını oxuya bilmir. Faylı Excel-də "CSV UTF-8" kimi saxlayıb yükləyin')));
    var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw')), reader = stream.getReader(), parts = [], total = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) { var out = new Uint8Array(total), at = 0; parts.forEach(function (c) { out.set(c, at); at += c.length; }); return out; }
        total += r.value.length;
        if (total > MAX_ENTRY) { reader.cancel(); throw new Error(_t('Excel faylının məzmunu həddindən artıq böyükdür')); }
        parts.push(r.value); return pump();
      });
    }
    return pump();
  }
  // inflate: (Uint8Array) → Promise<Uint8Array>; node testlərində zlib verilir
  function readEntry(bytes, entries, name, inflate) {
    var e = entries[name]; if (!e) return Promise.resolve(null);
    if (e.usize > MAX_ENTRY) return Promise.reject(new Error(_t('Excel faylının məzmunu həddindən artıq böyükdür')));
    var raw = entryBytes(bytes, e);
    if (e.method === 0) return Promise.resolve(raw);
    if (e.method === 8) return (inflate || inflateRaw)(raw);
    return Promise.reject(new Error(_t('Bu Excel faylının sıxma üsulu dəstəklənmir. Faylı Excel-də yenidən saxlayın')));
  }

  /* ---------- .xlsx → cədvəl (massiv massivi, hamısı sətir) ---------- */
  /* ---------- XML oxuyucu (doğrusal vaxtlı) ----------
     Regex-lər ("<c[^>]*>([\s\S]*?)</c>") bağlanmamış teqlərdə kvadratik geri izləməyə düşür: bir neçə MB-lıq saxta fayl səhifəni dondurardı.
     Burada yalnız indexOf işlədilir; bağlanmamış teq tapılanda oxuma dayanır. fn(atributlar, daxili mətn, təkTeqMi) false qaytarsa dayanır. */
  function eachTag(xml, name, fn) {
    var open = '<' + name, close = '</' + name + '>', pos = 0;
    for (;;) {
      var i = xml.indexOf(open, pos); if (i < 0) return;
      var nx = xml.charAt(i + open.length);
      if (nx !== ' ' && nx !== '>' && nx !== '/' && nx !== '\t' && nx !== '\n' && nx !== '\r') { pos = i + open.length; continue; }      // <cols>, <rowBreaks> kimi başqa teqlər
      var gt = xml.indexOf('>', i); if (gt < 0) return;
      var head = xml.slice(i + open.length, gt);
      if (head.charAt(head.length - 1) === '/') { if (fn(head.slice(0, -1), '', true) === false) return; pos = gt + 1; continue; }
      var end = xml.indexOf(close, gt + 1); if (end < 0) return;
      if (fn(head, xml.slice(gt + 1, end), false) === false) return;
      pos = end + close.length;
    }
  }
  // <name>…</name> bloklarını silir (bağlanmamış teq tapılsa qalan hissə atılır)
  function stripTag(xml, name) {
    var open = '<' + name, close = '</' + name + '>', pos = 0, out = '';
    for (;;) {
      var i = xml.indexOf(open, pos); if (i < 0) return out + xml.slice(pos);
      var nx = xml.charAt(i + open.length);
      if (nx !== ' ' && nx !== '>' && nx !== '/') { out += xml.slice(pos, i + open.length); pos = i + open.length; continue; }
      out += xml.slice(pos, i);
      var e = xml.indexOf(close, i); if (e < 0) return out;
      pos = e + close.length;
    }
  }
  function firstInner(xml, name) { var r = ''; eachTag(xml, name, function (a, inner) { r = inner; return false; }); return r; }
  function hasTag(xml, name) { var f = false; eachTag(xml, name, function () { f = true; return false; }); return f; }

  function textOfSi(xml) {
    xml = stripTag(xml, 'rPh');                               // fonetik yazı (yapon və s.) ayrıca hissədir
    var out = '';
    eachTag(xml, 't', function (a, inner) { out += decodeEntities(inner); });
    return out;
  }
  function colIndex(ref) {
    var letters = /^[A-Za-z]+/.exec(ref); if (!letters) return -1;
    var n = 0; letters[0].toUpperCase().split('').forEach(function (c) { n = n * 26 + (c.charCodeAt(0) - 64); });
    return n - 1;
  }
  // Excel ədədi: "4006381333931" tam rəqəm kimi, "1.2E+3" kimi elmi yazı isə düzgün ədədə çevrilir
  function numText(v) {
    var s = String(v).trim();
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return s;
    var n = Number(s);
    if (!isFinite(n)) return s;
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    return String(Math.round(n * 1e9) / 1e9);
  }
  function parseSheet(xml, shared) {
    var rows = [], scanned = 0, rowNo = 0;
    // Boş sətirlər <row .../> kimi tək teq ola bilər; r atributu varsa sətir nömrəsi ondan götürülür
    eachTag(xml, 'row', function (attrs, body, selfClosed) {
      var rAt = /\br="(\d+)"/.exec(attrs); rowNo = rAt ? parseInt(rAt[1], 10) : rowNo + 1;
      if (++scanned > MAX_SCAN_ROWS) return false;
      if (selfClosed || rowNo < 1 || rowNo > MAX_ROW_NO) return;        // r="4294967290" kimi saxta nömrə milyardlıq dövr yaratmasın
      var cells = [], auto = 0;
      eachTag(body, 'c', function (ca, inner) {
        var ref = /\br="([A-Za-z]+\d+)"/.exec(ca), type = (/\bt="([^"]*)"/.exec(ca) || [])[1] || 'n';
        var ci = ref ? colIndex(ref[1]) : auto; auto = ci + 1;
        if (ci < 0 || ci > 200) return;
        var val = '', vInner = hasTag(inner, 'v') ? firstInner(inner, 'v') : null;
        if (type === 's') val = vInner !== null ? (shared[parseInt(vInner, 10)] || '') : '';
        else if (type === 'inlineStr') val = textOfSi(inner);
        else if (type === 'str') val = vInner !== null ? decodeEntities(vInner) : '';
        else if (type === 'b') val = vInner !== null && vInner.trim() === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'e') val = '';
        else val = vInner !== null ? numText(decodeEntities(vInner)) : '';
        cells[ci] = val;
      });
      if (cells.length) { for (var k = 0; k < cells.length; k++) if (cells[k] == null) cells[k] = ''; rows[rowNo - 1] = cells; }
    });
    var out = []; for (var i = 0; i < rows.length; i++) out.push(rows[i] || []);
    return out;
  }
  function firstSheetPath(wbXml, relsXml) {
    var rid = null;
    eachTag(wbXml || '', 'sheet', function (a) { var m = /\br:id="([^"]+)"/.exec(a); rid = m ? m[1] : null; return false; });
    if (rid && relsXml) {
      var want = rid.replace(/[^A-Za-z0-9_]/g, ''), found = null;
      eachTag(relsXml, 'Relationship', function (a) {
        var idm = /\bId="([^"]*)"/.exec(a);
        if (idm && idm[1] === want) { var t = /\bTarget="([^"]+)"/.exec(a); if (t) { found = t[1].charAt(0) === '/' ? t[1].slice(1) : 'xl/' + t[1].replace(/^\.\//, ''); return false; } }
      });
      if (found) return found;
    }
    return 'xl/worksheets/sheet1.xml';
  }
  function readXlsxRaw(bytes, inflate) {
    var entries = readZipIndex(bytes);
    if (!entries['xl/workbook.xml']) return Promise.reject(new Error(_t('Bu fayl düzgün Excel (.xlsx) faylı deyil')));
    return Promise.all([readEntry(bytes, entries, 'xl/workbook.xml', inflate), readEntry(bytes, entries, 'xl/_rels/workbook.xml.rels', inflate), readEntry(bytes, entries, 'xl/sharedStrings.xml', inflate)]).then(function (r) {
      var path = firstSheetPath(r[0] ? utf8(r[0]) : '', r[1] ? utf8(r[1]) : '');
      var shared = [];
      if (r[2]) eachTag(utf8(r[2]), 'si', function (a, inner) { shared.push(textOfSi(inner)); });
      return readEntry(bytes, entries, path, inflate).then(function (sheet) {
        if (!sheet) throw new Error(_t('Excel faylında vərəq tapılmadı'));
        return parseSheet(utf8(sheet), shared);
      });
    });
  }
  // Pozulmuş/kəsilmiş zip DataView xətası (RangeError) verir: istifadəçiyə başa düşülən mesaj, həm sinxron, həm asinxron xətalar üçün
  function readXlsx(bytes, inflate) {
    return new Promise(function (resolve) { resolve(readXlsxRaw(bytes, inflate)); }).catch(function (e) {
      if (e instanceof RangeError || e instanceof TypeError) throw new Error(_t('Bu fayl düzgün Excel (.xlsx) faylı deyil'));
      throw e;
    });
  }

  /* ---------- CSV ---------- */
  function parseCsv(text) {
    text = String(text).replace(/^﻿/, '');
    var first = text.split(/\r\n|\n|\r/)[0] || '', counts = { ';': 0, ',': 0, '\t': 0 }, inQ = false;
    for (var i = 0; i < first.length; i++) { var ch = first[i]; if (ch === '"') inQ = !inQ; else if (!inQ && counts[ch] != null) counts[ch]++; }
    var delim = counts[';'] >= counts[','] && counts[';'] >= counts['\t'] ? ';' : counts[','] >= counts['\t'] ? ',' : '\t';
    if (!counts[';'] && !counts[','] && !counts['\t']) delim = ';';
    var rows = [], row = [], cell = '', q = false;
    for (var j = 0; j < text.length; j++) {
      var c = text[j];
      if (q) { if (c === '"') { if (text[j + 1] === '"') { cell += '"'; j++; } else q = false; } else cell += c; }
      else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[j + 1] === '\n') j++; row.push(cell); cell = ''; rows.push(row); row = []; if (rows.length > MAX_SCAN_ROWS) break; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* Fayl (File/Blob) → cədvəl. ZIP imzası (PK) varsa .xlsx, yoxsa CSV. */
  function readFile(file) {
    if (!file) return Promise.reject(new Error(_t('Fayl seçin')));
    if (file.size > MAX_FILE) return Promise.reject(new Error(_t('Fayl çox böyükdür (ən çox {0} MB)', [Math.round(MAX_FILE / 1048576)])));
    return file.arrayBuffer().then(function (buf) {
      var u8 = new Uint8Array(buf);
      if (u8[0] === 0x50 && u8[1] === 0x4B) return readXlsx(u8);
      if (/\.xls$/i.test(file.name || '')) throw new Error(_t('Köhnə .xls formatı oxunmur. Faylı Excel-də .xlsx və ya "CSV UTF-8" kimi saxlayın'));
      var text;
      try { text = utf8(u8, true); } catch (e) { text = new TextDecoder('windows-1254').decode(u8); }      // ANSI CSV (ə hərfi bu kodlaşdırmada itə bilər: UTF-8 tövsiyə olunur)
      return parseCsv(text);
    });
  }

  /* ---------- Sətirlərin tanınması və yoxlanması ---------- */
  // Ədəd mətni: "12,5", "12.50", "1 250,00", "1.250,00", "12 ₼", "10%" → sadə "1250.00" formasına
  function plainNumber(v) {
    var s = String(v == null ? '' : v).replace(/₼|azn|man\.?|%/ig, '').replace(/[\s ]/g, '');
    if (s.indexOf(',') !== -1 && s.indexOf('.') !== -1) {
      var dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.', th = dec === ',' ? '.' : ',';
      s = s.split(th).join('').replace(dec, '.');
    } else s = s.replace(',', '.');
    return s;
  }
  function intField(v, label, max, errors, dflt) {
    var s = plainNumber(v);
    if (s === '') return dflt;
    if (!/^\d+(\.0+)?$/.test(s)) { errors.push(_t('{0}: tam ədəd olmalıdır', [label])); return dflt; }
    var n = parseInt(s, 10);
    if (n > max) { errors.push(_t('{0}: {1}-dən çox ola bilməz', [label, max])); return dflt; }
    return n;
  }

  /* table: massiv massivi (ilk sətir başlıq). Qaytarır: {rows, unknown[], missing[], tooMany}
     opts.validate(d) → səhv mətni və ya null (Services.validateProductInput); opts.canCost: alış qiyməti sütunu oxunsun */
  function mapRows(table, opts) {
    opts = opts || {};
    var headRow = -1;
    for (var i = 0; i < table.length; i++) { if (table[i].some(function (c) { return cleanName(c) !== ''; })) { headRow = i; break; } }
    if (headRow < 0) return { rows: [], unknown: [], missing: FIELDS.filter(function (f) { return f.required; }).map(function (f) { return f.key; }), empty: true };
    var col = {}, unknown = [];
    table[headRow].forEach(function (h, ci) {
      var raw = cleanName(h); if (!raw) return;
      var key = ALIAS[normHeader(raw)];
      if (key && col[key] == null) col[key] = ci; else unknown.push(raw);
    });
    var missing = FIELDS.filter(function (f) { return f.required && col[f.key] == null; }).map(function (f) { return f.key; });
    var out = [], used = 0;
    for (var r = headRow + 1; r < table.length; r++) {
      var cells = table[r] || [];
      if (!cells.some(function (c) { return cleanName(c) !== ''; })) continue;
      used++;
      if (used > MAX_ROWS) return { rows: out, unknown: unknown, missing: missing, tooMany: true };
      function get(key) { return col[key] == null ? '' : cleanName(cells[col[key]]); }
      var errors = [], warnings = [], d = { line: r + 1 };
      d.name = get('name'); d.category = get('category'); d.brand = get('brand'); d.ageGroup = get('ageGroup');
      var mfr = col.mfrBarcode == null ? '' : String(cells[col.mfrBarcode] == null ? '' : cells[col.mfrBarcode]).replace(/\s+/g, '');
      if (/^\d+([.,]\d+)?e[+-]?\d+$/i.test(mfr)) { errors.push(_t('İstehsalçı barkodu elmi yazıda ({0}). Excel-də sütunu "Mətn" formatına keçirin və barkodu yenidən yazın', [mfr])); mfr = ''; }
      d.mfrBarcode = mfr;
      var p = plainNumber(get('price')), price = p === '' ? null : M.parse(p);
      if (col.price != null && (price == null || price <= 0)) errors.push(p === '' ? _t('Satış qiyməti boşdur') : _t('Satış qiyməti səhvdir: {0}', [get('price')]));
      d.price = price;
      d.cost = 0;
      if (col.cost != null && get('cost') !== '') {
        var cc = M.parse(plainNumber(get('cost')));
        if (cc == null || cc < 0) errors.push(_t('Alış qiyməti səhvdir: {0}', [get('cost')]));
        else if (opts.canCost === false) warnings.push(_t('Alış qiyməti oxunmadı: bu rolun alış qiymətinə icazəsi yoxdur'));
        else d.cost = cc;
      }
      d.minStock = intField(get('minStock'), _t('Minimum qalıq'), 100000, errors, 0);
      var md = plainNumber(get('maxDiscount')), mdn = md === '' ? 0 : Number(md);
      if (md !== '' && !Number.isFinite(mdn)) { errors.push(_t('Max endirim səhvdir: {0}', [get('maxDiscount')])); mdn = 0; }
      d.maxDiscount = mdn;
      d.opening = intField(get('opening'), _t('Açılış qalığı'), 100000, errors, 0);
      if (!d.name) errors.push(_t('Ad boşdur'));
      if (d.opening > 0 && !d.cost) warnings.push(_t('Alış qiyməti yoxdur: açılış qalığı 0 ₼ maya ilə yazılacaq'));
      if (!errors.length && opts.validate) { var bad = opts.validate({ name: d.name, price: d.price, mfrBarcode: d.mfrBarcode, category: d.category, brand: d.brand, ageGroup: d.ageGroup, maxDiscount: d.maxDiscount }); if (bad) errors.push(bad); }
      d.errors = errors; d.warnings = warnings;
      out.push(d);
    }
    return { rows: out, unknown: unknown, missing: missing };
  }

  /* Dublikat təsnifatı. existing: mövcud məhsullar. Ad + istehsalçı barkodu eynidirsə sətir atlanır (allowDup=true olarsa yüklənir);
     eyni istehsalçı barkodu fərqli adlı məhsulda varsa xəbərdarlıq (kassada seçim pəncərəsi çıxacaq), yüklənir (BR-01, FR-103).
     Hər sətrə status verilir: 'new' | 'skip' | 'error'. */
  function classify(rows, existing, allowDup) {
    var key = function (name, mfr) { return R.foldAz(cleanName(name)) + '|' + (mfr || ''); };
    var have = {}, byMfr = {};
    (existing || []).forEach(function (p) {
      have[key(p.name, p.mfrBarcode)] = p;
      if (p.mfrBarcode) (byMfr[p.mfrBarcode] = byMfr[p.mfrBarcode] || []).push(p.name);
    });
    var inFile = {}, mfrInFile = {};
    rows.forEach(function (d) {
      d.notes = [];
      if (d.errors.length) { d.status = 'error'; return; }
      var k = key(d.name, d.mfrBarcode);
      if (have[k] || inFile[k]) {
        d.dup = true;
        d.notes.push(have[k] ? _t('Eyni ad və istehsalçı barkodu ilə məhsul artıq var') : _t('Faylda eyni ad və barkodlu sətir {0}-dədir', [inFile[k]]));
        d.status = allowDup ? 'new' : 'skip';
      } else d.status = 'new';
      if (d.status === 'new') inFile[k] = inFile[k] || d.line;
      if (d.mfrBarcode) {
        var others = (byMfr[d.mfrBarcode] || []).filter(function (n) { return R.foldAz(n) !== R.foldAz(d.name); });
        if (mfrInFile[d.mfrBarcode] && R.foldAz(mfrInFile[d.mfrBarcode]) !== R.foldAz(d.name)) others.push(mfrInFile[d.mfrBarcode]);
        if (others.length) d.notes.push(_t('Bu istehsalçı barkodu başqa məhsulda da var: {0}. Kassada oxudanda seçim pəncərəsi çıxacaq', [others.slice(0, 3).join(', ')]));
        if (d.status === 'new' && !mfrInFile[d.mfrBarcode]) mfrInFile[d.mfrBarcode] = d.name;
      }
    });
    return rows;
  }
  function summary(rows) {
    var s = { total: rows.length, new: 0, skip: 0, error: 0, opening: 0 };
    rows.forEach(function (d) { s[d.status]++; if (d.status === 'new' && d.opening > 0) s.opening++; });
    return s;
  }

  /* ---------- Şablon (.xlsx): minimal ZIP yazıcı (sıxmasız), başlıq + 2 nümunə sətir ---------- */
  var CRC = null;
  function crc32(u8) {
    if (!CRC) { CRC = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) crc = CRC[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function enc(s) { return new TextEncoder().encode(s); }
  function zipStore(files) {
    var chunks = [], central = [], offset = 0;
    function push(u8) { chunks.push(u8); offset += u8.length; }
    files.forEach(function (f) {
      var name = enc(f.name), data = f.data, crc = crc32(data), lh = new Uint8Array(30 + name.length), dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true); dv.setUint16(26, name.length, true);
      lh.set(name, 30);
      central.push({ name: name, crc: crc, size: data.length, offset: offset });
      push(lh); push(data);
    });
    var cdStart = offset;
    central.forEach(function (c) {
      var ch = new Uint8Array(46 + c.name.length), dv = new DataView(ch.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(8, 0x0800, true);
      dv.setUint32(16, c.crc, true); dv.setUint32(20, c.size, true); dv.setUint32(24, c.size, true); dv.setUint16(28, c.name.length, true); dv.setUint32(42, c.offset, true);
      ch.set(c.name, 46); push(ch);
    });
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true); ev.setUint32(12, offset - cdStart, true); ev.setUint32(16, cdStart, true);
    push(end);
    var out = new Uint8Array(offset), at = 0; chunks.forEach(function (c) { out.set(c, at); at += c.length; });
    return out;
  }
  function xmlEsc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function colName(i) { return String.fromCharCode(65 + i); }
  // rows: massiv massivi; sətir = mətn (inlineStr) və ya {n: ədəd}
  function xlsxFromRows(rows) {
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="10" width="20" customWidth="1"/></cols><sheetData>' +
      rows.map(function (r, ri) {
        return '<row r="' + (ri + 1) + '">' + r.map(function (c, ci) {
          var ref = colName(ci) + (ri + 1);
          if (c === '' || c == null) return '';
          return typeof c === 'object' ? '<c r="' + ref + '"><v>' + c.n + '</v></c>' : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(c) + '</t></is></c>';
        }).join('') + '</row>';
      }).join('') + '</sheetData></worksheet>';
    return zipStore([
      { name: '[Content_Types].xml', data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
      { name: '_rels/.rels', data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Mehsullar" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: 'xl/worksheets/sheet1.xml', data: enc(sheet) }
    ]);
  }
  // Şablonun başlıqları interfeys dilindədir; yükləmə həmişə dörd dildəki adları tanıyır
  function templateRows() {
    return [
      [_t('Ad *'), _t('Kateqoriya'), _t('Brend'), _t('Yaş qrupu'), _t('İstehsalçı barkodu'), _t('Satış qiyməti *'), _t('Alış qiyməti'), _t('Minimum qalıq'), _t('Max endirim %'), _t('Açılış qalığı')],
      [_t('Konstruktor dəsti, 120 hissə'), _t('Oyuncaq'), 'Lego', '6+', '4006381333931', { n: 14.5 }, { n: 9 }, { n: 2 }, { n: 10 }, { n: 6 }],
      [_t('Maqnit «Bakı»'), _t('Suvenir'), '', '', '', { n: 2.25 }, { n: 0.9 }, { n: 5 }, { n: 0 }, { n: 40 }]
    ];
  }
  function templateXlsx() { return xlsxFromRows(templateRows()); }

  var Import = {
    MAX_ROWS: MAX_ROWS, MAX_FILE: MAX_FILE, FIELDS: FIELDS,
    readFile: readFile, readXlsx: readXlsx, parseCsv: parseCsv, mapRows: mapRows, classify: classify, summary: summary,
    templateXlsx: templateXlsx, templateRows: templateRows, xlsxFromRows: xlsxFromRows, zipStore: zipStore, plainNumber: plainNumber, normHeader: normHeader
  };
  root.Import = Import;
  if (typeof module !== 'undefined') module.exports = Import;
})(typeof window !== 'undefined' ? window : globalThis);
