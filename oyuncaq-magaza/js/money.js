/* Pul: bütün məbləğlər tam ədəd qəpiklə saxlanır (BR-04). Float istifadə olunmur. */
(function (root) {
  'use strict';

  // "100", "100,5", "100.50", "1 250,00" → qəpik (int). Səhv giriş → null.
  function parse(input) {
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return null;
      return Math.round(input * 100);
    }
    var s = String(input == null ? '' : input).trim().replace(/\s/g, '').replace(',', '.');
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
    var parts = s.split('.');
    var whole = parseInt(parts[0], 10);
    var frac = (parts[1] || '').padEnd(2, '0');
    return whole * 100 + parseInt(frac, 10);
  }

  // qəpik → "1 250,00"
  function format(q) {
    var neg = q < 0;
    var abs = Math.abs(q);
    var whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    var frac = String(abs % 100).padStart(2, '0');
    return (neg ? '−' : '') + whole + ',' + frac;
  }

  // Faiz endirimi: qəpikə qədər aşağı yuvarlaqlaşdırılır ki, endirim heç vaxt icazədən çox olmasın.
  function percentOf(q, percent) {
    return Math.floor((q * percent) / 100);
  }

  var Money = { parse: parse, format: format, percentOf: percentOf };
  root.Money = Money;
  if (typeof module !== 'undefined') module.exports = Money;
})(typeof window !== 'undefined' ? window : globalThis);
