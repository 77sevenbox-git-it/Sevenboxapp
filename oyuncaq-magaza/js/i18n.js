/* Dillər: az (əsas, mənbə mətni), ru, en, tr.
   Mətnlər kodda Azərbaycanca yazılır: _t('Qalıq {0}', [n]). Açar = Azərbaycanca mətn; {0}, {1} … yerləşdirilən dəyərlərdir.
   Tərcümələr js/lang-ru.js, lang-en.js, lang-tr.js fayllarındadır. Tərcümə tapılmasa Azərbaycanca göstərilir (səhifə sınmır).
   İnterfeys dili cihaza aiddir (localStorage "mag.lang"), səhifə yüklənəndə bir dəfə seçilir; dil dəyişəndə səhifə yenilənir (giriş və çek saxlanılır).
   Çekin dili ayrıdır (Çap ayarları): müştəri çeki interfeys dilindən asılı olmayaraq, adətən Azərbaycanca çıxır. */
(function (root) {
  'use strict';
  var KEY = 'mag.lang';
  var LANGS = [
    { code: 'az', name: 'Azərbaycanca', short: 'AZ', abbr: 'Az', locale: 'az-AZ' },
    { code: 'ru', name: 'Русский', short: 'RU', abbr: 'Rus', locale: 'ru-RU' },
    { code: 'en', name: 'English', short: 'EN', abbr: 'Eng', locale: 'en-GB' },
    { code: 'tr', name: 'Türkçe', short: 'TR', abbr: 'Tr', locale: 'tr-TR' }
  ];
  var dict = { ru: {}, en: {}, tr: {} };
  var missing = {};

  function valid(code) { return LANGS.some(function (l) { return l.code === code; }); }
  function stored() { try { return root.localStorage.getItem(KEY); } catch (e) { return null; } }
  var cur = valid(stored()) ? stored() : 'az';

  function add(lang, entries) {
    if (!dict[lang]) dict[lang] = {};
    Object.keys(entries).forEach(function (k) { dict[lang][k] = entries[k]; });
  }

  function fmt(s, params) {
    if (params == null) return s;
    return String(s).replace(/@@.*$/, '').replace(/\{(\d+)\}/g, function (m, i) { var v = params[Number(i)]; return v == null ? '' : String(v); });
  }

  // Eyni Azərbaycanca söz fərqli mənada işlənəndə açara "@@kontekst" əlavə olunur: _t('Qaytarılan@@change') — Azərbaycanca "Qaytarılan" göstərilir,
  // digər dillərdə isə lüğətdəki ayrıca tərcümə ("Para üstü") götürülür; ayrıca tərcümə yoxdursa adi açara baxılır.
  function stripCtx(k) { var i = k.indexOf('@@'); return i < 0 ? k : k.slice(0, i); }

  // _t(açar, [dəyərlər], dil?) — baş və son boşluqlar açarın tərkibində sayılmır, nəticədə saxlanılır
  function t(key, params, lang) {
    lang = lang || cur;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(key)), s;
    if (lang === 'az') s = m[1] + stripCtx(m[2]) + m[3];
    else {
      var table = dict[lang], own = Object.prototype.hasOwnProperty, plain = stripCtx(m[2]);
      var hit = table && own.call(table, m[2]) ? table[m[2]] : (table && own.call(table, plain) ? table[plain] : null);
      if (hit == null) { missing[lang + '|' + m[2]] = true; s = m[1] + plain + m[3]; }
      else s = m[1] + hit + m[3];
    }
    return fmt(s, params);
  }

  function lang() { return cur; }
  function locale(l) { var x = LANGS.filter(function (e) { return e.code === (l || cur); })[0]; return x ? x.locale : 'az-AZ'; }
  function setLang(code) {
    if (!valid(code)) return false;
    try { root.localStorage.setItem(KEY, code); } catch (e) { /* yaddaş bağlıdırsa seçim yadda qalmır */ }
    cur = code;
    remember(code);
    return true;
  }
  // Service worker bildiriş mətnini istifadəçinin dilində göstərsin deyə dil keş yaddaşına yazılır (SW-nin localStorage-ı yoxdur)
  function remember(code) {
    try {
      if (root.caches && root.Response) root.caches.open('magaza-prefs').then(function (c) { return c.put('lang', new root.Response(code)); }).catch(function () { /* vacib deyil */ });
    } catch (e) { /* vacib deyil */ }
  }
  function applyDocument() {
    if (root.document && root.document.documentElement) root.document.documentElement.lang = cur;
  }
  applyDocument();

  root.I18n = { t: t, add: add, lang: lang, setLang: setLang, langs: LANGS, locale: locale, valid: valid, dict: dict, missing: function () { return Object.keys(missing); }, remember: remember, KEY: KEY };
  if (typeof module !== 'undefined') module.exports = root.I18n;
})(typeof window !== 'undefined' ? window : globalThis);
