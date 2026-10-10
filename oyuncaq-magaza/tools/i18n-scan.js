/* Mətn tarayıcısı (AST): js/*.js faylındakı _t('...') açarlarını çıxarır və tərcümə edilməmiş görünən mətnləri tapır.
   İstifadə:  node tools/i18n-scan.js            → açarların siyahısı
              node tools/i18n-scan.js --missing  → _t() xaricində qalmış Azərbaycan hərfli sətirlər */
'use strict';
const fs = require('fs'), path = require('path');
const acorn = require('acorn');
const JS = path.join(__dirname, '..', 'js');
const AZ = /[əƏğĞıİöÖüÜşŞçÇ]/;
const FN = '_t';
const FN2 = 'approvalText';     // services.js: approvalText(açar, [dəyərlər]) — _t kimi açar götürür

function files() { return fs.readdirSync(JS).filter(f => f.endsWith('.js') && !/^lang-|^i18n\.js$/.test(f)); }
function parse(src) { return acorn.parse(src, { ecmaVersion: 2020, locations: true, sourceType: 'script' }); }
function walk(node, parent, key, cb) {
  if (!node || typeof node.type !== 'string') return;
  cb(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && walk(c, node, k, cb));
    else if (v && typeof v.type === 'string') walk(v, node, k, cb);
  }
}

// _t('açar', [..]) çağırışlarının açarları: [{file, line, key, params}]
function keys() {
  const out = [];
  for (const f of files()) {
    const ast = parse(fs.readFileSync(path.join(JS, f), 'utf8'));
    walk(ast, null, null, (n) => {
      const isReq = n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.name === 'UI' && n.callee.property.name === 'req';
      if (n.type === 'CallExpression' && ((n.callee.type === 'Identifier' && (n.callee.name === FN || n.callee.name === FN2)) || isReq)) {
        const a = n.arguments[isReq ? 1 : 0];
        if (isReq && n.arguments[2]) { /* parametrlər üçüncü argumentdadır */ }
        const pa = isReq ? n.arguments[2] : n.arguments[1];
        const literal = !!pa && pa.type === 'ArrayExpression';   // massiv literalı olmayan parametrlər (dəyişən) say yoxlamasından çıxarılır
        const params = literal ? pa.elements.length : 0;
        if (a && a.type === 'Literal' && typeof a.value === 'string') out.push({ file: f, line: n.loc.start.line, key: a.value, params, literal, dynamic: false });
        else out.push({ file: f, line: n.loc.start.line, key: null, params, literal, dynamic: true });
      }
    });
  }
  return out;
}

// _t() içində olmayan, Azərbaycan hərfi olan sətir literalları
function unwrapped() {
  const out = [];
  for (const f of files()) {
    const ast = parse(fs.readFileSync(path.join(JS, f), 'utf8'));
    walk(ast, null, null, function visit(n, p) { /* aşağıda parent zənciri ilə */ });
    (function rec(n, anc) {
      if (!n || typeof n.type !== 'string') return;
      const inT = anc.some(a => a.type === 'CallExpression' && ((a.callee.type === 'Identifier' && (a.callee.name === FN || a.callee.name === FN2)) || (a.callee.type === 'MemberExpression' && a.callee.object.name === 'UI' && a.callee.property.name === 'req')));
      if (!inT && ((n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateElement')) {
        const v = n.type === 'Literal' ? n.value : n.value.cooked;
        if (AZ.test(v)) out.push({ file: f, line: n.loc.start.line, text: v });
      }
      for (const k of Object.keys(n)) {
        if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && rec(c, anc.concat(n)));
        else if (v && typeof v.type === 'string') rec(v, anc.concat(n));
      }
    })(ast, []);
  }
  return out;
}

// Bilərəkdən tərcümə olunmayan sətirlər: proqramçı xətaları, bazada saxlanan nümunə/ilkin məlumat, test çapı üçün sınaq mətni
const ALLOW = [
  /^barcode\.js:/, /^db\.js:/,
  /^services\.js:.*(Mühasib [12]|\[Mağaza adı\]|\[VÖEN\]|\[Ünvan\]|Konstruktor dəsti|Yumşaq ayı|Maqnit|Qız qalası|Puzzl|Nümunə qalıq)/,
  /^replica\.js:.*(başqa cihaz|təsdiq düzəlişi)/,
  /^print\.js:.*(Konstruktor dəsti|ƏÖÜĞŞİÇ|Sınaq məhsulu|Azərbaycanca)/,   // "Azərbaycanca" — dil seçimində hər dilin öz adı ilə yazılır
  /^sync\.js:\d+:(İcazə yoxdur|JSON səhvdir|Naməlum əməliyyat|Naməlum açar|Server məşğuldur, sonra təkrar olunacaq|Bildiriş ünvanı tanınmır|Bu cihaz bildiriş üçün qeydiyyatdan keçməyib|Təsdiq lazımdır|Arxivləşdirmə gedir, bir neçə dəqiqə sonra təkrar olunacaq)$/   // Code.gs-in qaytardığı xəta mətnləri (müqayisə üçün; ekrana srvErr() ilə tərcümə olunmuş çıxır)
];
function unwrappedFiltered() { return unwrapped().filter(u => !ALLOW.some(r => r.test(u.file + ':' + u.line + ':' + u.text))); }

module.exports = { keys, unwrapped, unwrappedFiltered, files, FN, AZ };

if (require.main === module) {
  if (process.argv.includes('--missing')) {
    for (const u of unwrappedFiltered()) console.log(u.file + ':' + u.line + '  ' + JSON.stringify(u.text).slice(0, 140));
  } else {
    const seen = new Map();
    for (const k of keys()) if (k.key != null) seen.set(k.key, (seen.get(k.key) || 0) + 1);
    console.log([...seen.keys()].length + ' unikal açar');
    for (const k of seen.keys()) console.log(JSON.stringify(k));
  }
}
