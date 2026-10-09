/* Google Apps Script mühitinin yaddaşda təqlidi: Code.gs-i dəyişdirmədən vm daxilində işlədir.
   Sheets-in iki davranışı da təqlid olunur: (1) başında ' olan mətn mətn kimi saxlanır (' görünmür),
   (2) getRange(...).getValues() cədvəldəki dəyərləri qaytarır. API çağırışları sayılır (sürət testi üçün). */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function makeBackend(opts) {
  opts = opts || {};
  const calls = { sheetApi: 0, openById: 0, requests: 0 };
  const store = { props: { SYNC_TOKEN: opts.token === undefined ? 'secret-token' : opts.token }, cache: {}, sheets: {} };

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
  // Sheets-in "istifadəçi daxil etməsi" kimi: başındakı ' mətn işarəsidir və saxlanmır
  function unq(v) { return typeof v === 'string' && v[0] === "'" ? v.slice(1) : v; }

  class Sheet {
    constructor(name) { this.name = name; this.rows = []; this.frozen = 0; }
    getLastRow() { calls.sheetApi++; let n = this.rows.length; while (n > 0 && this.rows[n - 1].every(v => v === '' || v === undefined)) n--; return n; }
    getRange(r, c, nr, nc) {
      if (r < 1 || c < 1) throw new Error('getRange: koordinat səhvdir');
      return new Range(this, r, c, nr || 1, nc || 1);
    }
    appendRow(row) { calls.sheetApi++; this.rows.push(row.map(unq)); }
    setFrozenRows(n) { this.frozen = n; }
    insertSheetCheck() {}
  }
  class Spreadsheet {
    getName() { return 'Mağaza İS — Verilənlər bazası (test)'; }
    getSheetByName(n) { return store.sheets[n] || null; }
    insertSheet(n) { return (store.sheets[n] = new Sheet(n)); }
  }
  const ss = new Spreadsheet();

  const sandbox = {
    console, JSON, Date, Math, String, Number, Object, Array, parseInt, parseFloat, isNaN, RegExp, Error,
    Logger: { log() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, openById: () => { calls.openById++; return ss; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in store.props ? store.props[k] : null), setProperty: (k, v) => { store.props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in store.cache ? store.cache[k] : null), put: (k, v) => { store.cache[k] = v; }, remove: k => { delete store.cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });
  sandbox.setup();

  return {
    calls, store, sandbox,
    get: () => JSON.parse(sandbox.doGet().text),
    post(body) { calls.requests++; return JSON.parse(sandbox.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text); },
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
  };
}

module.exports = { makeBackend };
