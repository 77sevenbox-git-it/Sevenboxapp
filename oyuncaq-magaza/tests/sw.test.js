/* node tests/sw.test.js — sw.js-in push/notificationclick məntiqi: service worker mühiti təqlid olunur. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); } }

function makeSw(clientsList) {
  const handlers = {}, shown = [], opened = [];
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting() {}, caches: {},
    registration: { showNotification: async (title, o) => { shown.push(Object.assign({ title }, o)); } },
    clients: { matchAll: async () => clientsList, openWindow: async (u) => { opened.push(u); }, claim: async () => {} }
  };
  const ctx = { self, location: { origin: 'https://x.test' }, URL, Date, Promise, caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [], match: async () => null } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), ctx, { filename: 'sw.js' });
  async function fire(type, ev) {
    let p = Promise.resolve();
    ev.waitUntil = x => { p = Promise.resolve(x); };
    handlers[type](ev); await p; return ev;
  }
  return { fire, shown, opened, handlers };
}
const win = (o) => Object.assign({ visibilityState: 'hidden', focused: false, focus: async function () { this.didFocus = true; }, postMessage(m) { (this.msgs = this.msgs || []).push(m); } }, o);

(async () => {
  await t('push: pəncərə yoxdursa bildiriş ikon + badge ilə göstərilir', async () => {
    const sw = makeSw([]);
    await sw.fire('push', {});
    assert.strictEqual(sw.shown.length, 1);
    const n = sw.shown[0];
    assert.strictEqual(n.title, 'Təsdiq sorğusu');
    assert.strictEqual(n.icon, 'icons/icon-192.png'); assert.strictEqual(n.badge, 'icons/badge-96.png');
    assert.strictEqual(n.tag, 'approval'); assert.strictEqual(n.renotify, true); assert.strictEqual(n.requireInteraction, true);
    assert.ok(/approvals/.test(n.data.url));
    ['icons/icon-192.png', 'icons/badge-96.png'].forEach(f => assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f + ' mövcud deyil'));
  });

  await t('push: tətbiq ekranda və fokusdadırsa göstərilmir; arxa plandadırsa göstərilir', async () => {
    let sw = makeSw([win({ visibilityState: 'visible', focused: true })]);
    await sw.fire('push', {}); assert.strictEqual(sw.shown.length, 0);
    sw = makeSw([win({ visibilityState: 'visible', focused: false })]);
    await sw.fire('push', {}); assert.strictEqual(sw.shown.length, 1);
    sw = makeSw([win({ visibilityState: 'hidden', focused: false })]);
    await sw.fire('push', {}); assert.strictEqual(sw.shown.length, 1);
  });

  await t('push: test push (expect-push) tətbiq ekranda olsa da göstərilir', async () => {
    const sw = makeSw([win({ visibilityState: 'visible', focused: true })]);
    await sw.fire('message', { data: { type: 'expect-push' } });
    await sw.fire('push', {}); assert.strictEqual(sw.shown.length, 1);
  });

  await t('klik: açıq pəncərə fokuslanır və "open-approvals" xəbəri alır; bildiriş bağlanır', async () => {
    const w = win();
    const sw = makeSw([w]);
    let closed = false;
    await sw.fire('notificationclick', { notification: { close() { closed = true; }, data: { url: './index.html#approvals' } } });
    assert.ok(closed); assert.ok(w.didFocus); assert.strictEqual(JSON.stringify(w.msgs), JSON.stringify([{ type: 'open-approvals' }]));
    assert.strictEqual(sw.opened.length, 0);
  });

  await t('klik: pəncərə yoxdursa tətbiq təsdiq sorğuları ilə açılır', async () => {
    const sw = makeSw([]);
    await sw.fire('notificationclick', { notification: { close() {}, data: { url: './index.html#approvals' } } });
    assert.strictEqual(JSON.stringify(sw.opened), JSON.stringify(['./index.html#approvals']));
  });

  await t('sw.js keşə yeni faylları əlavə edir (notify.js, ikonlar)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    ['js/notify.js', 'icons/icon-192.png', 'icons/badge-96.png'].forEach(f => assert.ok(src.includes("'" + f + "'"), f));
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(html.includes('js/notify.js'));
  });

  // fetch: yalnız uğurlu (2xx) cavab keşlənir; şəbəkə xətasında əvvəlki yaxşı keş qaytarılır
  async function swFetch(url, respond, cached) {
    const handlers = {}, puts = [];
    const cache = { put: async (r, x) => { puts.push(r.url); }, addAll: async () => {} };
    const ctx = { self: { addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting() {}, clients: { claim: async () => {} } }, location: { origin: 'https://x.test' }, URL, Date, Promise,
      fetch: async () => { const r = respond(); if (r instanceof Error) throw r; return r; },
      caches: { open: async () => cache, keys: async () => [], match: async () => cached || null } };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), ctx, { filename: 'sw.js' });
    let out; const ev = { request: { method: 'GET', url }, respondWith: p => { out = p; } };
    handlers.fetch(ev);
    const res = await out; await new Promise(r => setTimeout(r, 5));
    return { res, puts };
  }
  const resp = (ok, status) => ({ ok, status, type: 'basic', clone() { return this; } });

  await t('fetch: 200 cavabı keşlənir, 404/500 keşləmir (deploy zamanı yaxşı nüsxə pozulmur)', async () => {
    const good = await swFetch('https://x.test/js/app.js', () => resp(true, 200));
    assert.deepStrictEqual(good.puts, ['https://x.test/js/app.js']);
    for (const st of [404, 500, 503]) { const bad = await swFetch('https://x.test/js/app.js', () => resp(false, st)); assert.deepStrictEqual(bad.puts, [], 'status ' + st + ' keşləndi'); assert.strictEqual(bad.res.status, st); }
  });

  await t('fetch: şəbəkə yoxdursa keşdəki nüsxə qaytarılır; POST (Apps Script) toxunulmur', async () => {
    const cachedRes = { status: 200, marker: 'keş' };
    const off = await swFetch('https://x.test/js/app.js', () => new TypeError('Failed to fetch'), cachedRes);
    assert.strictEqual(off.res.marker, 'keş');
    const handlers = {}; const ctx = { self: { addEventListener: (t, f) => { handlers[t] = f; } }, location: { origin: 'https://x.test' }, URL, caches: {}, fetch() { throw new Error('çağırılmamalıdır'); } };
    vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), ctx);
    let used = false; handlers.fetch({ request: { method: 'POST', url: 'https://script.google.com/macros/s/x/exec' }, respondWith() { used = true; } });
    assert.strictEqual(used, false);
  });

  console.log(`\n${passed} keçdi, ${failed} uğursuz`);
  process.exit(failed ? 1 : 0);
})();
