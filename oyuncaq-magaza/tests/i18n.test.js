/* node tests/i18n.test.js — dillər: lüğətlərin tamlığı, yer tutucuların (placeholder) uyğunluğu, ehtiyat davranış, çekin ayrı dili, SW bildiriş dili. */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const scan = require('../tools/i18n-scan.js');

let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; } catch (e) { failed++; console.log('✗ ' + name + '\n   ' + (e.stack || e.message)); } }
const ROOT = path.join(__dirname, '..');

// Brauzer mühiti: hər test üçün təzə kontekst (localStorage ilə)
function load(storedLang, files) {
  const store = storedLang ? { 'mag.lang': storedLang } : {};
  const ctx = { localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, document: { documentElement: {} } };
  ctx.window = ctx; vm.createContext(ctx);
  (files || ['i18n.js', 'lang-ru.js', 'lang-en.js', 'lang-tr.js']).forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f }));
  return { I: ctx.I18n, ctx, store };
}
const LANGS = ['ru', 'en', 'tr'];
const ph = s => (String(s).match(/\{\d+\}/g) || []).sort().join(',');
const keysAll = scan.keys();
const staticKeys = [...new Set(keysAll.filter(k => k.key != null).map(k => k.key.trim()))];

(async () => {
  const { I } = load();

  for (const l of LANGS) {
    await t(l + ': koddakı hər _t açarının tərcüməsi var', async () => {
      const miss = staticKeys.filter(k => !Object.prototype.hasOwnProperty.call(I.dict[l], k));
      assert.deepStrictEqual(miss, [], 'tərcüməsi olmayan açarlar:\n' + miss.slice(0, 20).join('\n'));
    });
    await t(l + ': lüğətdə kodda işlənməyən (köhnəlmiş) açar yoxdur', async () => {
      const set = new Set(staticKeys);
      const extra = Object.keys(I.dict[l]).filter(k => !set.has(k));
      assert.deepStrictEqual(extra, [], 'artıq açarlar:\n' + extra.slice(0, 20).join('\n'));
    });
    await t(l + ': {0} {1} yer tutucuları mənbə ilə eynidir, tərcümə boş deyil', async () => {
      const bad = [];
      for (const k of staticKeys) {
        const v = I.dict[l][k];
        if (!v || !String(v).trim()) bad.push('boş: ' + k);
        else if (ph(v) !== ph(k)) bad.push(k + '  =>  ' + v);
      }
      assert.deepStrictEqual(bad, []);
    });
  }

  await t('hərf yoxlaması: rusca tərcümədə Azərbaycan hərfi, ingiliscədə kiril, türkcədə kiril və "ə" yoxdur', async () => {
    const bad = [];
    const az = /[əƏ]/, cyr = /[\u0400-\u04FF]/;
    // ru-da rəsmi ad və markalar latın hərfi ilə qala bilər, lakin ə/ğ/ı/ş kimi Azərbaycan hərfləri düşməməlidir
    for (const [k, v] of Object.entries(I.dict.ru)) if (/[əƏğĞıİşŞçÇöÖüÜ]/.test(v.replace(/VÖEN/g, ''))) bad.push('ru: ' + k + ' => ' + v);   // VÖEN Azərbaycan vergi nömrəsinin rəsmi adıdır
    for (const [k, v] of Object.entries(I.dict.en)) if (cyr.test(v) || az.test(v) || /[ğĞıİşŞ]/.test(v)) bad.push('en: ' + k + ' => ' + v);
    for (const [k, v] of Object.entries(I.dict.tr)) if (cyr.test(v) || az.test(v)) bad.push('tr: ' + k + ' => ' + v);
    assert.deepStrictEqual(bad, []);
  });

  await t('_t çağırışlarında dəyər sayı açardakı {n} ilə uyğundur (massiv literalı olanlar)', async () => {
    const bad = [];
    for (const k of keysAll) {
      if (k.key == null || !k.literal) continue;
      const idx = (k.key.match(/\{(\d+)\}/g) || []).map(x => Number(x.slice(1, -1)));
      const need = idx.length ? Math.max(...idx) + 1 : 0;
      if (need > k.params) bad.push(k.file + ':' + k.line + '  ' + k.key + '  (lazım ' + need + ', verilib ' + k.params + ')');
    }
    assert.deepStrictEqual(bad, []);
  });

  await t('_t-dən kənarda qalmış Azərbaycan mətni yoxdur (istisnalar tools/i18n-scan.js-də)', async () => {
    const u = scan.unwrappedFiltered().map(x => x.file + ':' + x.line + '  ' + JSON.stringify(x.text).slice(0, 100));
    assert.deepStrictEqual(u, [], 'bükülməmiş mətnlər:\n' + u.join('\n'));
  });

  await t('dinamik _t(dəyişən) yalnız bükücü funksiyalarda işlənir (print.js rt, ui.js req)', async () => {
    const dyn = keysAll.filter(k => k.dynamic).map(k => k.file);
    dyn.forEach(f => assert.ok(f === 'print.js' || f === 'ui.js', 'gözlənilməz dinamik açar: ' + f));
  });

  await t('az: mətn dəyişmir, yer tutucular doldurulur, @@kontekst göstərilmir', async () => {
    assert.strictEqual(I.t('Qalıq: {0}', [5], 'az'), 'Qalıq: 5');
    assert.strictEqual(I.t('Qaytarılan@@change', null, 'az'), 'Qaytarılan');
    assert.strictEqual(I.t('Heç yerdə olmayan mətn', null, 'ru'), 'Heç yerdə olmayan mətn');   // tərcümə yoxdur → Azərbaycanca (səhifə sınmır)
    assert.ok(I.missing().includes('ru|Heç yerdə olmayan mətn'));
  });

  await t('kontekst: "Qaytarılan" çekdə qaytarılan pul (sdaça), hesabatda qaytarılmış mal', async () => {
    assert.strictEqual(I.t('Qaytarılan@@change', null, 'ru'), 'Сдача');
    assert.strictEqual(I.t('Qaytarılan@@change', null, 'en'), 'Change');
    assert.strictEqual(I.t('Qaytarılan@@change', null, 'tr'), 'Para üstü');
    assert.strictEqual(I.t('Qaytarılan', null, 'en'), 'Returned');
    assert.strictEqual(I.t('Qaytarılan@@yoxdur', null, 'en'), 'Returned');   // kontekstin öz tərcüməsi yoxdursa adi açar
  });

  await t('boşluqlar saxlanılır: " · qaytarılacaq {0} ₼" başındakı boşluqlarla', async () => {
    const out = I.t(' · qaytarılacaq {0} ₼', ['3.00'], 'en');
    assert.ok(out.startsWith(' ') && /3\.00/.test(out), JSON.stringify(out));
  });

  await t('dil seçimi: yaddaşdan oxunur, səhv kod qəbul edilmir, seçim yazılır və SW üçün keşə qoyulur', async () => {
    const a = load('tr');
    assert.strictEqual(a.I.lang(), 'tr');
    assert.strictEqual(a.ctx.document.documentElement.lang, 'tr');
    assert.strictEqual(a.I.t('Kassa'), 'Kasa');
    const b = load('xx'); assert.strictEqual(b.I.lang(), 'az');
    const c = load(); assert.strictEqual(c.I.setLang('de'), false); assert.strictEqual(c.I.setLang('ru'), true);
    assert.strictEqual(c.store['mag.lang'], 'ru'); assert.strictEqual(c.I.t('Kassa'), 'Касса');
    assert.strictEqual(c.I.locale(), 'ru-RU'); assert.strictEqual(c.I.locale('tr'), 'tr-TR');
    // keş yaddaşı olan mühit
    const puts = [];
    const d = load(); d.ctx.caches = { open: async (n) => ({ put: async (k, r) => { puts.push([n, k, r]); } }) }; d.ctx.Response = function (x) { this.body = x; };
    d.I.setLang('en'); await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(puts.length, 1); assert.deepStrictEqual([puts[0][0], puts[0][1], puts[0][2].body], ['magaza-prefs', 'lang', 'en']);
  });

  await t('dördünə də dil faylı qoşulub: index.html və sw.js keş siyahısında', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const order = ['js/i18n.js', 'js/lang-ru.js', 'js/lang-en.js', 'js/lang-tr.js', 'js/money.js'].map(f => html.indexOf('src="' + f + '"'));
    order.forEach(i => assert.ok(i > 0)); assert.deepStrictEqual(order, order.slice().sort((x, y) => x - y), 'i18n/lang faylları money.js-dən əvvəl, ardıcıl yüklənməlidir');
    ['js/i18n.js', 'js/lang-ru.js', 'js/lang-en.js', 'js/lang-tr.js'].forEach(f => { assert.ok(sw.includes("'" + f + "'"), f + ' sw.js-də yoxdur'); assert.ok(fs.existsSync(path.join(ROOT, f))); });
    // html-dəki hər js faylı SW keşindədir (oflayn işləmə üçün)
    const scripts = [...html.matchAll(/src="(js\/[^"]+)"/g)].map(m => m[1]);
    scripts.forEach(f => assert.ok(sw.includes("'" + f + "'"), f + ' sw.js keşində yoxdur'));
  });

  await t('çekin dili interfeys dilindən ayrıdır (print.js rt): interfeys rusca olsa da çek ayarı az-dırsa Azərbaycanca', async () => {
    const { ctx } = load('ru');
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'print.js'), 'utf8'), ctx, { filename: 'print.js' });
    const P = ctx.Print;
    assert.ok(P && P.rt, 'Print.rt yoxdur');
    assert.strictEqual(ctx.I18n.lang(), 'ru');
    assert.strictEqual(P.settings().receipt.lang, 'az', 'çekin ilkin dili Azərbaycanca olmalıdır');
    assert.strictEqual(P.rt()('Qaytarılan@@change'), 'Qaytarılan');                 // ayar: az
    assert.strictEqual(P.rt()('Qalıq: {0}', [3]), 'Qalıq: 3');
    assert.strictEqual(ctx.I18n.t('Qaytarılan@@change'), 'Сдача');                  // interfeys: ru
    const en = P.rt({ receipt: { lang: 'en' } }), tr = P.rt({ receipt: { lang: 'tr' } });
    assert.strictEqual(en('Qaytarılan@@change'), 'Change'); assert.strictEqual(tr('Qaytarılan@@change'), 'Para üstü');
    assert.strictEqual(P.sanitize({ receipt: { lang: 'zz' } }).receipt.lang, 'az', 'naməlum çek dili az-a düşür');
    assert.strictEqual(P.sanitize({ receipt: { lang: 'tr' } }).receipt.lang, 'tr');
  });

  await t('SW: bildiriş mətni seçilmiş dildə, naməlum dildə Azərbaycanca', async () => {
    const shown = [];
    const handlers = {};
    let lang = 'ru';
    const caches = { open: async () => ({ addAll: async () => {}, match: async () => (lang ? { text: async () => lang } : undefined) }), keys: async () => [], match: async () => null };
    const self = { addEventListener: (ty, fn) => { handlers[ty] = fn; }, skipWaiting() {}, registration: { showNotification: async (ti, o) => { shown.push([ti, o]); } }, clients: { matchAll: async () => [], claim: async () => {} } };
    const ctx = { self, caches, location: { origin: 'https://x.test' }, URL, Date, Promise };
    vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), ctx, { filename: 'sw.js' });
    async function push() { let p; handlers.push({ waitUntil: x => { p = x; } }); await p; }
    await push(); assert.strictEqual(shown[0][0], 'Запрос на подтверждение'); assert.strictEqual(shown[0][1].lang, 'ru');
    lang = 'tr'; await push(); assert.strictEqual(shown[1][0], 'Onay isteği');
    lang = 'en'; await push(); assert.strictEqual(shown[2][0], 'Approval request');
    lang = 'zz'; await push(); assert.strictEqual(shown[3][0], 'Təsdiq sorğusu');
    lang = null; await push(); assert.strictEqual(shown[4][0], 'Təsdiq sorğusu');
    shown.forEach(s => { assert.strictEqual(s[1].icon, 'icons/icon-192.png'); assert.strictEqual(s[1].badge, 'icons/badge-96.png'); });
  });

  console.log('\n' + passed + ' keçdi, ' + failed + ' uğursuz');
  process.exit(failed ? 1 : 0);
})();
