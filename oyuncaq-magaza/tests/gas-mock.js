/* Google Apps Script mühitinin yaddaşda təqlidi: Code.gs-i dəyişdirmədən vm daxilində işlədir.
   Sheets-in iki davranışı da təqlid olunur: (1) başında ' olan mətn mətn kimi saxlanır (' görünmür),
   (2) getRange(...).getValues() cədvəldəki dəyərləri qaytarır. API çağırışları sayılır (sürət testi üçün). */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

function makeBackend(opts) {
  opts = opts || {};
  const calls = { sheetApi: 0, openById: 0, requests: 0 };
  const logs = [];
  const pushLog = [];
  const backendRef = {};
  const store = { props: { SYNC_TOKEN: opts.token === undefined ? 'secret-token' : opts.token }, cache: {}, sheets: {}, spreadsheets: {} };

  class Range {
    constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
    getValues() {
      calls.sheetApi++;
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = [];
        for (let j = 0; j < this.nc; j++) {
          const v = (this.sh.rows[this.r - 1 + i] || [])[this.c - 1 + j];
          row.push(v === undefined ? '' : v);
        }
        out.push(row);
      }
      return out;
    }
    setValues(vals) {
      calls.sheetApi++;
      if (vals.length !== this.nr || vals.some(v => v.length !== this.nc)) throw new Error('setValues: ölçü uyğun deyil');
      checkCells(vals);
      for (let i = 0; i < this.nr; i++) {
        while (this.sh.rows.length < this.r + i) this.sh.rows.push([]);
        const row = this.sh.rows[this.r - 1 + i];
        for (let j = 0; j < this.nc; j++) row[this.c - 1 + j] = unq(vals[i][j]);
      }
      return this;
    }
    createTextFinder(text) {
      const self = this;
      let entire = false;
      const f = {
        matchEntireCell(b) { entire = b; return f; },
        findNext() {
          calls.sheetApi++;
          for (let i = 0; i < self.nr; i++) {
            const v = (self.sh.rows[self.r - 1 + i] || [])[self.c - 1];
            if (v !== undefined && (entire ? String(v) === text : String(v).includes(text))) return { getRow: () => self.r + i };
          }
          return null;
        }
      };
      return f;
    }
  }
  // Sheets bir xanaya ən çox 50 000 simvol qəbul edir; aşanda bütün yazma əməliyyatı xəta ilə yıxılır
  const CELL_LIMIT = 50000;
  function checkCells(rows) {
    for (const r of rows) for (const v of r) if (typeof v === 'string' && v.length > CELL_LIMIT) throw new Error('Your input contains more than the maximum of ' + CELL_LIMIT + ' characters in a single cell.');
  }
  // Sheets-in "istifadəçi daxil etməsi" kimi: başındakı ' mətn işarəsidir və saxlanmır
  function unq(v) { return typeof v === 'string' && v[0] === "'" ? v.slice(1) : v; }

  class Sheet {
    constructor(name, owner) { this.name = name; this.owner = owner; this.rows = []; this.frozen = 0; this.maxRows = 1000; this.maxCols = 26; }
    getName() { return this.name; }
    getLastRow() { calls.sheetApi++; let n = this.rows.length; while (n > 0 && this.rows[n - 1].every(v => v === '' || v === undefined)) n--; return n; }
    getLastColumn() {
      calls.sheetApi++; let m = 0;
      for (const r of this.rows) for (let j = r.length - 1; j >= m; j--) if (r[j] !== '' && r[j] !== undefined) { m = j + 1; break; }
      return m;
    }
    getMaxRows() { calls.sheetApi++; return this.maxRows; }
    getMaxColumns() { calls.sheetApi++; return this.maxCols; }
    getRange(r, c, nr, nc) {
      if (r < 1 || c < 1) throw new Error('getRange: koordinat səhvdir');
      nr = nr || 1; nc = nc || 1;
      if (r + nr - 1 > this.maxRows || c + nc - 1 > this.maxCols) throw new Error('The coordinates or dimensions of the range are outside the dimensions of the sheet.');
      return new Range(this, r, c, nr, nc);
    }
    appendRow(row) {
      calls.sheetApi++;
      let n = this.rows.length; while (n > 0 && this.rows[n - 1].every(v => v === '' || v === undefined)) n--;
      if (row.length > this.maxCols) throw new Error('appendRow: sütun sayı şəbəkədən çoxdur');
      checkCells([row]);
      this.rows.length = n; this.rows.push(row.map(unq));
      if (this.rows.length > this.maxRows) this.maxRows = this.rows.length;
    }
    insertRowsAfter(pos, n) { calls.sheetApi++; this.maxRows += n; if (pos < this.rows.length) this.rows.splice(pos, 0, ...Array.from({ length: n }, () => [])); }
    insertColumnsAfter(pos, n) { calls.sheetApi++; this.maxCols += n; for (const r of this.rows) r.splice(pos, 0, ...Array(n).fill('')); }
    deleteRows(start, n) {
      calls.sheetApi++;
      if (this.failOn === 'deleteRows') throw new Error('deleteRows xətası (təqlid)');
      if (start < 1 || n < 1 || start + n - 1 > this.maxRows) throw new Error('deleteRows: aralıq səhvdir');
      if (n >= this.maxRows) throw new Error('Bütün sətirləri silmək olmaz');
      this.rows.splice(start - 1, n); this.maxRows -= n;
    }
    deleteColumns(start, n) {
      calls.sheetApi++;
      if (start < 1 || n < 1 || start + n - 1 > this.maxCols) throw new Error('deleteColumns: aralıq səhvdir');
      if (n >= this.maxCols) throw new Error('Bütün sütunları silmək olmaz');
      for (const r of this.rows) r.splice(start - 1, n);
      this.maxCols -= n;
    }
    setFrozenRows(n) { this.frozen = n; }
    insertSheetCheck() {}
  }
  let ssSeq = 0;
  class Spreadsheet {
    constructor(id, name) { this.id = id; this.name = name || 'Mağaza İS — Verilənlər bazası (test)'; this.sheets = {}; }
    getId() { return this.id; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
    getName() { return this.name; }
    getSheetByName(n) { return this.sheets[n] || null; }
    getSheets() { return Object.keys(this.sheets).map(k => this.sheets[k]); }
    insertSheet(n) { return (this.sheets[n] = new Sheet(n, this)); }
    // Faylın nüsxəsi (Drive-da yeni fayl): bütün vərəqlər, ölçülər və dəyərlər kopyalanır
    copy(name) {
      calls.sheetApi++;
      if (backendRef.failCopy) throw new Error('copy xətası (təqlid)');
      const c = new Spreadsheet('ss-copy-' + (++ssSeq), name);
      for (const k of Object.keys(this.sheets)) {
        const o = this.sheets[k], n = new Sheet(k, c);
        n.rows = o.rows.map(r => r.slice()); n.frozen = o.frozen; n.maxRows = o.maxRows; n.maxCols = o.maxCols;
        c.sheets[k] = n;
      }
      store.spreadsheets[c.id] = c;
      return c;
    }
  }
  const ss = new Spreadsheet('ss-main');
  store.spreadsheets = { 'ss-main': ss };
  store.sheets = ss.sheets;

  const sandbox = {
    console, JSON, Date, Math, String, Number, Object, Array, parseInt, parseFloat, isNaN, RegExp, Error,
    Logger: { log(m) { logs.push(String(m)); } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (alg, text) => Array.from(nodeCrypto.createHash('sha256').update(String(text), 'utf8').digest()).map(b => b > 127 ? b - 256 : b),   // Apps Script işarəli bayt qaytarır
      getUuid: () => nodeCrypto.randomUUID()
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: id => { calls.openById++; return store.spreadsheets[id] || ss; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in store.props ? store.props[k] : null), setProperty: (k, v) => { store.props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in store.cache ? store.cache[k] : null), put: (k, v) => { store.cache[k] = v; }, remove: k => { delete store.cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    // Push xidmətinin təqlidi: backend.pushLog-da hər sorğu (url + başlıqlar); cavabı backend.pushRespond(url, req) təyin edir (defolt 201)
    UrlFetchApp: {
      fetchAll(reqs) {
        return reqs.map(r => {
          pushLog.push({ url: r.url, method: r.method, headers: r.headers });
          if (backendRef.pushThrows) throw new Error(backendRef.pushThrows);
          const out = backendRef.pushRespond ? backendRef.pushRespond(r.url, r) : { status: 201, body: '' };
          return { getResponseCode: () => out.status, getContentText: () => out.body || '' };
        });
      },
      fetch(url, r) { return this.fetchAll([Object.assign({ url }, r)])[0]; }
    }
  };
  if (opts.noBigInt) sandbox.BigInt = undefined;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });
  sandbox.setup();

  Object.assign(backendRef, {
    calls, store, sandbox, logs, pushLog,
    get: () => JSON.parse(sandbox.doGet().text),
    post(body) { calls.requests++; return JSON.parse(sandbox.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text); },
    // Sheets limiti (10 milyon) BOŞ xanaları da sayır: bütün vərəqlərin şəbəkə ölçüsü
    grid(fileId) { const f = store.spreadsheets[fileId || 'ss-main']; return f.getSheets().reduce((n, sh) => n + sh.maxRows * sh.maxCols, 0); },
    rows(name) { const sh = store.sheets[name]; return sh ? sh.rows.slice(1).filter(r => r.some(v => v !== '' && v !== undefined)) : []; },
    // fetch təqlidi: Sync.js-in istifadə etdiyi formada
    fetch() {
      const self = this;
      return function (url, o) {
        if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) return Promise.reject(new TypeError('Failed to fetch'));
        if (self.down) return Promise.reject(new TypeError('Failed to fetch'));
        const body = o && o.method === 'POST' ? self.post(o.body) : self.get();
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      };
    }
  });
  return backendRef;
}

module.exports = { makeBackend };
