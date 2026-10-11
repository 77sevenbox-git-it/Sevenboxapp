/* node tests/quota.test.js — Google Apps Script kvota büdcəsi (Code.gs): Script Properties gündə 50 000 oxu+yaz (gmail.com).
   Ölçü real kvota deyil, TƏQLİDDƏ sorğu başına əməliyyat sayıdır; real Google-da sayğac "Executions" və xəta mətni ilə təsdiqlənməlidir.
   Yoxlanır: (1) hər sorğu növü üçün Properties büdcəsi, (2) cihazların gündəlik yükü kvotadan çox aşağıdır, (3) autentifikasiyasız sel kvotanı yemir,
   (4) keş ləğvi/yeniləməni gecikdirmir (Code.gs özü dəyişəndə), əllə dəyişiklik ən çox PROP_TTL sonra qüvvəyə minir, (5) keş boşalanda davranış eynidir. */
const assert = require('assert');
const { makeBackend } = require('./gas-mock.js');

const LEGACY = 'legacy-shared-token-0123456789';
const PROP_TTL = 120;                         // Code.gs ilə eyni olmalıdır (aşağıdakı test bunu yoxlayır)
const DAILY_QUOTA = 50000;                    // gmail.com: Properties read/write (developers.google.com/apps-script/guides/services/quotas)
let passed = 0, failed = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; }, e => { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message).split('\n').slice(0, 5).join('\n   ')); }); }

const ev = (n) => { const at = new Date().toISOString(); return { id: at + '_' + String(n).padStart(6, '0') + '_a_t' + n, at, type: 'noop.test', userId: 'u1', device: 'x', data: { n } }; };
function fresh() {
  const b = makeBackend({ token: LEGACY });
  b.adminKey = b.sandbox.setupAdminKey();
  b.keys = {};
  return b;
}
function mk(b, id) {
  const r = b.post({ action: 'devices.create', token: LEGACY, device: 'admin_pc', adminKey: b.adminKey, id, name: id });
  assert.ok(r.ok, JSON.stringify(r)); b.keys[id] = r.token; return r.token;
}
const syncOf = (b, id, since, items) => b.post({ action: 'sync', token: b.keys[id], device: id, since: since || 0, items: items || [], limit: 500 });
function ops(b, fn) {
  const a = b.calls.propRead + b.calls.propWrite;
  const r = fn();
  return { n: b.calls.propRead + b.calls.propWrite - a, r };
}

(async () => {
  await t('PROP_TTL testdəki ilə eynidir (Code.gs-dəki sabit dəyişsə test də yenilənməlidir)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
    assert.ok(new RegExp('var PROP_TTL = ' + PROP_TTL + ';').test(src), 'Code.gs-də PROP_TTL ≠ ' + PROP_TTL);
  });

  await t('boş sinxron sorğusu (cihaz açarı, keş isti): 0 Properties əməliyyatı; ping də', () => {
    const b = fresh(); mk(b, 'kassa1');
    const next = syncOf(b, 'kassa1', 0, [ev(1)]).next;
    syncOf(b, 'kassa1', next);                                   // keşi qızdırır
    for (let i = 0; i < 20; i++) { const o = ops(b, () => syncOf(b, 'kassa1', next)); assert.ok(o.r.ok); assert.strictEqual(o.n, 0, i + '-ci boş sorğu ' + o.n + ' Properties əməliyyatı etdi'); }
    assert.strictEqual(ops(b, () => b.post({ action: 'ping', token: b.keys.kassa1, device: 'kassa1' })).n, 0);
  });

  await t('köhnə ümumi açarla boş sorğu da 0 əməliyyat (keçid dövrü)', () => {
    const b = fresh();
    const next = b.post({ action: 'sync', token: LEGACY, device: 'old_pc', since: 0, items: [ev(1)], limit: 500 }).next;
    b.post({ action: 'sync', token: LEGACY, device: 'old_pc', since: next, items: [], limit: 500 });
    const o = ops(b, () => b.post({ action: 'sync', token: LEGACY, device: 'old_pc', since: next, items: [], limit: 500 }));
    assert.ok(o.r.ok); assert.strictEqual(o.n, 0);
  });

  await t('yazan sorğu və allocate: sorğu başına ≤ 4 Properties əməliyyatı', () => {
    const b = fresh(); mk(b, 'kassa1');
    syncOf(b, 'kassa1', 0, [ev(1)]);
    let next = 0;
    for (let i = 0; i < 5; i++) { const o = ops(b, () => syncOf(b, 'kassa1', next, [ev(10 + i)])); assert.ok(o.r.ok); next = o.r.next; assert.ok(o.n <= 4, 'yazan sorğu ' + o.n + ' əməliyyat etdi'); }
    const al = ops(b, () => b.post({ action: 'allocate', token: b.keys.kassa1, device: 'kassa1', key: 'receiptSeq', count: 100, min: 0 }));
    assert.ok(al.r.ok && al.n <= 4, 'allocate ' + al.n + ' əməliyyat etdi');
  });

  await t('GÜNLÜK BÜDCƏ: 5 cihaz × 24 saat × hər 4 san yoxlama (hamısı ön planda) + 600 satış kvotanın yarısından azdır (keşsiz: 4 dəfədən çox aşardı)', () => {
    const b = fresh(); const ids = ['kassa1', 'kassa2', 'kassa3', 'kassa4', 'kassa5']; ids.forEach(id => mk(b, id));
    const start = b.calls.propRead + b.calls.propWrite;
    // 24 saatın 5 cihaz üçün təqlidi: hər cihaz hər 4 san boş sorğu (21 600/gün), keş saatı real vaxtla irəli aparılır
    const SAMPLE_SEC = 4, DAY = 86400, cursors = {};
    ids.forEach(id => { cursors[id] = syncOf(b, id, 0, [ev(id.charCodeAt(1))]).next; });
    let requests = 0;
    for (let sec = 0; sec < DAY; sec += SAMPLE_SEC) {
      b.tick(SAMPLE_SEC);
      ids.forEach(id => { const r = syncOf(b, id, cursors[id]); requests++; assert.ok(r.ok, JSON.stringify(r)); if (r.next > cursors[id]) cursors[id] = r.next; });
      if (sec % 144 === 0) { const id = ids[(sec / 144) % ids.length]; const r = syncOf(b, id, cursors[id], [ev(sec)]); cursors[id] = r.next; requests++; }   // gündə 600 satış hadisəsi
    }
    const used = b.calls.propRead + b.calls.propWrite - start;
    const pct = Math.round(used / DAILY_QUOTA * 1000) / 10;
    console.log('   (5 cihaz × 24 saat: ' + requests + ' sorğu, ' + used + ' Properties əməliyyatı = kvotanın ' + pct + '%)');
    assert.ok(used < DAILY_QUOTA * 0.5, 'günlük büdcə ' + used + ' (' + pct + '%) — hədd 50%');
  });

  await t('MÜQAYİSƏ: keşsiz hesablama (sorğu başına 2 oxu) 3 kassa × 12 saatda kvotanı aşırdı', () => {
    // Köhnə davranışın arifmetikası: bu test kodu yoxlamır, qərarın səbəbini sənədləşdirir
    const requestsPerDevice = 12 * 3600 / 4, devices = 3, readsPerRequest = 2;
    assert.ok(requestsPerDevice * devices * readsPerRequest > DAILY_QUOTA);
  });

  await t('autentifikasiyasız sel: uydurma cihaz id-si, səhv açar, açarsız — 1000 sorğu Properties-ə toxunmur (kvotanı yeyə bilməz)', () => {
    const b = fresh(); mk(b, 'kassa1');
    b.post({ action: 'sync', token: 'x', device: 'warm', items: [] });
    b.post({ action: 'sync', token: 'x', device: 'kassa1', items: [] });                    // mövcud id-nin qeydi bir dəfə oxunub keşlənir
    const o = ops(b, () => {
      for (let i = 0; i < 1000; i++) {
        const r = i % 3 === 0 ? b.post({ action: 'sync', token: 'x'.repeat(64), device: 'rnd_' + i, items: [] })
          : i % 3 === 1 ? b.post({ action: 'sync', token: 'y' + i, device: 'kassa1', items: [] }) : b.post({ action: 'sync', items: [] });
        assert.strictEqual(r.ok, false);
      }
    });
    assert.strictEqual(o.n, 0, '1000 rədd edilən sorğu ' + o.n + ' Properties əməliyyatı etdi');
  });

  await t('keş sel ilə şişmir: uydurma cihaz id-ləri keş açarı yaratmır', () => {
    const b = fresh(); mk(b, 'kassa1');
    b.post({ action: 'sync', token: 'x', device: 'warm', items: [] });
    const before = Object.keys(b.store.cache).length;
    for (let i = 0; i < 500; i++) b.post({ action: 'sync', token: 'x', device: 'rnd_' + i, items: [] });
    assert.strictEqual(Object.keys(b.store.cache).length, before);
  });

  await t('ləğv dərhal qüvvəyə minir (isti keşdə də): bloklanan cihazın növbəti sorğusu "revoked"', () => {
    const b = fresh(); mk(b, 'kassa1'); mk(b, 'kassa2');
    const n = syncOf(b, 'kassa1', 0, [ev(1)]).next; syncOf(b, 'kassa1', n);
    assert.ok(syncOf(b, 'kassa1', n).ok);
    assert.ok(b.post({ action: 'devices.revoke', token: b.keys.kassa2, device: 'kassa2', adminKey: b.adminKey, id: 'kassa1', reason: 'itdi' }).ok);
    assert.strictEqual(syncOf(b, 'kassa1', n).code, 'revoked', 'ləğv keşdə gecikdi');
    assert.ok(b.post({ action: 'devices.restore', token: b.keys.kassa2, device: 'kassa2', adminKey: b.adminKey, id: 'kassa1' }).ok);
    assert.ok(syncOf(b, 'kassa1', n).ok, 'bərpa keşdə gecikdi');
  });

  await t('yeni açar (rotate) köhnəni dərhal bağlayır, yeni cihaz (create) dərhal tanınır — isti keşdə də', () => {
    const b = fresh(); mk(b, 'kassa1');
    const old = b.keys.kassa1; const n = syncOf(b, 'kassa1', 0, [ev(1)]).next; syncOf(b, 'kassa1', n);
    const rot = b.post({ action: 'devices.rotate', token: LEGACY, device: 'admin_pc', adminKey: b.adminKey, id: 'kassa1' });
    assert.ok(rot.ok);
    assert.strictEqual(b.post({ action: 'sync', token: old, device: 'kassa1', since: n, items: [] }).code, 'denied', 'köhnə açar keşdə yaşadı');
    assert.ok(b.post({ action: 'sync', token: rot.token, device: 'kassa1', since: n, items: [] }).ok);
    // tanınmayan id keşlənmiş "yoxdur" cavabı verdikdən sonra yaradılır
    assert.strictEqual(b.post({ action: 'sync', token: 'z'.repeat(64), device: 'kassa9', since: 0, items: [] }).code, 'denied');
    const nw = mk(b, 'kassa9');
    assert.ok(b.post({ action: 'sync', token: nw, device: 'kassa9', since: 0, items: [] }).ok, 'yeni cihaz keşdə tanınmadı');
  });

  await t('Admin ümumi açarı söndürür (legacy.set): dərhal qüvvəyə minir', () => {
    const b = fresh(); mk(b, 'kassa1');
    const p = () => b.post({ action: 'sync', token: LEGACY, device: 'old_pc', since: 0, items: [] });
    assert.ok(p().ok);
    assert.ok(b.post({ action: 'legacy.set', token: b.keys.kassa1, device: 'kassa1', adminKey: b.adminKey, mode: 'off' }).ok);
    assert.strictEqual(p().code, 'legacy_off');
    assert.ok(b.post({ action: 'legacy.set', token: b.keys.kassa1, device: 'kassa1', adminKey: b.adminKey, mode: 'on', days: 3 }).ok);
    assert.ok(p().ok);
  });

  await t('Script properties əllə dəyişəndə təsir ən çox PROP_TTL sonra olur; dropPropCache() dərhal tətbiq edir', () => {
    const b = fresh(); mk(b, 'kassa1');
    const p = () => b.post({ action: 'sync', token: LEGACY, device: 'old_pc', since: 0, items: [] });
    assert.ok(p().ok);
    b.store.props.SYNC_TOKEN = 'yeni-ümumi-açar-0123456789abcdef';          // admin açarı redaktorda dəyişdi
    assert.ok(p().ok, 'gecikmə gözlənilir (keş)');
    b.tick(PROP_TTL - 5); assert.ok(p().ok, 'müddət bitməyib');
    b.tick(10); assert.strictEqual(p().code, 'denied', 'PROP_TTL bitəndən sonra köhnə açar keçməməlidir');
    // dropPropCache
    b.store.props.SYNC_TOKEN = LEGACY; b.sandbox.dropPropCache();
    assert.ok(p().ok, 'dropPropCache dərhal tətbiq etməlidir');
    b.store.props.SYNC_TOKEN = 'baska-açar-0123456789abcdefghij'; b.sandbox.dropPropCache();
    assert.strictEqual(p().code, 'denied');
  });

  await t('keş tam boşalanda (yenidən başlama/çıxarılma) davranış eynidir, yalnız Properties oxunur', () => {
    const b = fresh(); mk(b, 'kassa1');
    const n = syncOf(b, 'kassa1', 0, [ev(1)]).next; syncOf(b, 'kassa1', n);
    b.store.cache = {}; b.store.cacheExp = {};
    const o = ops(b, () => syncOf(b, 'kassa1', n));
    assert.ok(o.r.ok); assert.ok(o.n > 0 && o.n <= 8, 'soyuq sorğu ' + o.n + ' əməliyyat');
    assert.strictEqual(ops(b, () => syncOf(b, 'kassa1', n)).n, 0, 'ikinci sorğu artıq keşdən');
  });

  await t('autentifikasiya keşi xəta versə də (p_* açarlarında CacheService atır) server Properties-ə qayıdıb işləyir', () => {
    const b = fresh(); mk(b, 'kassa1');
    const n = syncOf(b, 'kassa1', 0, [ev(1)]).next;
    const orig = b.sandbox.CacheService.getScriptCache, real = orig();
    const guard = (f) => (k, ...a) => { if (String(k).indexOf('p_') === 0) throw new Error('keş xətası'); return real[f](k, ...a); };
    b.sandbox.CacheService.getScriptCache = () => ({ get: guard('get'), put: guard('put'), remove: guard('remove') });
    try {
      const r = syncOf(b, 'kassa1', n);
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(b.post({ action: 'sync', token: 'x', device: 'kassa1', since: 0, items: [] }).code, 'denied');
    } finally { b.sandbox.CacheService.getScriptCache = orig; }
  });

  await t('/exec cavabları skriptin dəqiq buraxılışını (rev) göstərir: Deploy-un yeniləndiyini yoxlamaq üçün', () => {
    const b = fresh();
    const g = b.get(); assert.strictEqual(g.ok, true); assert.ok(/^\d{4}\.\d{2}\.\d{2}-\w+$/.test(g.rev), String(g.rev));
    mk(b, 'kassa1'); assert.strictEqual(b.post({ action: 'ping', token: b.keys.kassa1, device: 'kassa1' }).rev, g.rev);
  });

  console.log('\n' + passed + ' keçdi, ' + failed + ' uğursuz');
  process.exit(failed ? 1 : 0);
})();
