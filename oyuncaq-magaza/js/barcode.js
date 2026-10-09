/* Barkod: EAN-13 yoxlama rəqəmi, mağaza barkodu (prefiks "2"), çek barkodu (prefiks "29") və SVG çəkilişi. */
(function (root) {
  'use strict';

  var L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  var G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  var R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  var PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

  function checkDigit(twelve) {
    if (!/^\d{12}$/.test(twelve)) throw new Error('EAN-13 üçün 12 rəqəm lazımdır');
    var sum = 0;
    for (var i = 0; i < 12; i++) sum += parseInt(twelve[i], 10) * (i % 2 === 0 ? 1 : 3);
    return String((10 - (sum % 10)) % 10);
  }

  function isValidEan13(code) {
    return /^\d{13}$/.test(code) && checkDigit(code.slice(0, 12)) === code[12];
  }

  // Mağaza barkodu: "20" + 10 rəqəmli ardıcıl nömrə + yoxlama rəqəmi (GS1 mağazadaxili diapazon).
  function storeBarcode(seq) {
    if (!Number.isInteger(seq) || seq < 1 || seq > 9999999999) throw new Error('Ardıcıl nömrə səhvdir');
    var twelve = '20' + String(seq).padStart(10, '0');
    return twelve + checkDigit(twelve);
  }

  // Çek barkodu: "29" + 10 rəqəmli çek nömrəsi + yoxlama rəqəmi. Mağaza barkodları ilə toqquşmur.
  function receiptBarcode(receiptNo) {
    var twelve = '29' + String(receiptNo).padStart(10, '0');
    return twelve + checkDigit(twelve);
  }

  function isStoreBarcode(code) { return isValidEan13(code) && code.slice(0, 2) === '20'; }
  function isReceiptBarcode(code) { return isValidEan13(code) && code.slice(0, 2) === '29'; }
  function receiptNoFromBarcode(code) { return isReceiptBarcode(code) ? parseInt(code.slice(2, 12), 10) : null; }

  // EAN-13 → 95 modulluq bit sətri
  function encode(code) {
    if (!isValidEan13(code)) throw new Error('Yanlış EAN-13: ' + code);
    var parity = PARITY[parseInt(code[0], 10)];
    var bits = '101';
    for (var i = 1; i <= 6; i++) {
      var d = parseInt(code[i], 10);
      bits += parity[i - 1] === 'L' ? L[d] : G[d];
    }
    bits += '01010';
    for (var j = 7; j <= 12; j++) bits += R[parseInt(code[j], 10)];
    bits += '101';
    return bits;
  }

  // SVG (çek və etiket üçün). module = bir zolağın eni (px), height = zolaq hündürlüyü.
  function svg(code, opts) {
    opts = opts || {};
    var m = opts.module || 2, h = opts.height || 60, quiet = 11 * m;
    var bits = encode(code);
    var width = bits.length * m + quiet * 2;
    var rects = '';
    var x = quiet, i = 0;
    while (i < bits.length) {
      if (bits[i] === '1') {
        var start = i;
        while (i < bits.length && bits[i] === '1') i++;
        // Kənar və orta qoruyucu zolaqlar bir az uzun
        var guard = start < 3 || (start >= 45 && start < 50) || start >= 92;
        rects += '<rect x="' + (quiet + start * m) + '" y="0" width="' + ((i - start) * m) + '" height="' + (guard ? h + 8 : h) + '"/>';
      } else { i++; }
    }
    var textY = h + 20;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + (h + 24) + '" width="' + width + '" height="' + (h + 24) + '" role="img" aria-label="Barkod ' + code + '">' +
      '<rect width="100%" height="100%" fill="#fff"/><g fill="#000">' + rects + '</g>' +
      '<text x="' + (width / 2) + '" y="' + textY + '" font-family="monospace" font-size="' + (m * 7) + '" text-anchor="middle" fill="#000">' + code + '</text></svg>';
  }

  // Çap üçün SVG (termo çek və etiket printeri). Ölçü milimetrlə verilir, zolaq eni isə printerin nöqtəsinin (dot) TAM sayıdır:
  // 203 dpi-də 1 nöqtə = 0,125 mm, 2 nöqtə = 0,25 mm. Kəsr nöqtə bulanıq/qeyri-bərabər zolaq verib oxunmanı pozur.
  // opts: dpi (203), maxWidthMm (sığmalı olduğu en), heightMm (zolaq + rəqəmlər), maxMod (zolaq eni üçün nöqtə sayı yuxarı həddi), text (rəqəmləri göstər)
  // Qaytarır: { svg, mod, modMm, widthMm, heightMm, ok } — ok=false: sığan zolaq eni 0,24 mm-dən kiçikdir (etiket çox dardır, oxunmaya bilər)
  var LEFT_Q = 7, RIGHT_Q = 2;               // SVG-nin içindəki sakit zona (birinci rəqəm solda yerləşir); qalanı etiketin boş kağızıdır
  function svgMm(code, opts) {
    opts = opts || {};
    var bits = encode(code);
    var dpi = opts.dpi || 203, dotMm = 25.4 / dpi;
    var totalMods = LEFT_Q + bits.length + RIGHT_Q;
    var maxDots = Math.floor((opts.maxWidthMm || 60) / dotMm + 1e-6);
    var mod = Math.max(1, Math.min(opts.maxMod || 4, Math.floor(maxDots / totalMods)));
    if (opts.mod) mod = opts.mod;
    var W = totalMods * mod;
    var H = Math.max(24, Math.round((opts.heightMm || 12) / dotMm));
    var withText = opts.text !== false;
    var fs = withText ? Math.min(Math.round(2.4 / dotMm), Math.round(H * 0.3)) : 0;      // rəqəm hündürlüyü ≈ 2,4 mm
    var barH = withText ? H - fs - 2 : H, guardH = H;
    var rects = '', i = 0, left = LEFT_Q * mod;
    while (i < bits.length) {
      if (bits[i] === '1') {
        var start = i;
        while (i < bits.length && bits[i] === '1') i++;
        var guard = withText && (start < 3 || (start >= 45 && start < 50) || start >= 92);
        rects += '<rect x="' + (left + start * mod) + '" y="0" width="' + ((i - start) * mod) + '" height="' + (guard ? guardH : barH) + '"/>';
      } else { i++; }
    }
    var txt = '';
    if (withText) {
      var y = H - Math.round(fs * 0.12);
      var style = 'font-family="Arial,Helvetica,sans-serif" font-size="' + fs + '" text-anchor="middle" fill="#000"';
      txt += '<text x="' + Math.round(LEFT_Q * mod / 2) + '" y="' + y + '" ' + style + '>' + code[0] + '</text>';
      for (var k = 0; k < 6; k++) {
        txt += '<text x="' + (left + (3 + k * 7 + 3.5) * mod) + '" y="' + y + '" ' + style + '>' + code[1 + k] + '</text>';
        txt += '<text x="' + (left + (50 + k * 7 + 3.5) * mod) + '" y="' + y + '" ' + style + '>' + code[7 + k] + '</text>';
      }
    }
    var widthMm = W * dotMm, heightMm = H * dotMm;
    return {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + widthMm.toFixed(3) + 'mm" height="' + heightMm.toFixed(3) + 'mm" shape-rendering="crispEdges" role="img" aria-label="Barkod ' + code + '">' +
        '<g fill="#000">' + rects + '</g>' + txt + '</svg>',
      mod: mod, modMm: mod * dotMm, widthMm: widthMm, heightMm: heightMm, ok: mod * dotMm >= 0.24
    };
  }

  var Barcode = {
    checkDigit: checkDigit, isValidEan13: isValidEan13, storeBarcode: storeBarcode, receiptBarcode: receiptBarcode,
    isStoreBarcode: isStoreBarcode, isReceiptBarcode: isReceiptBarcode, receiptNoFromBarcode: receiptNoFromBarcode,
    encode: encode, svg: svg, svgMm: svgMm
  };
  root.Barcode = Barcode;
  if (typeof module !== 'undefined') module.exports = Barcode;
})(typeof window !== 'undefined' ? window : globalThis);
