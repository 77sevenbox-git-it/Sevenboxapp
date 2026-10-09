/* Brauzer testləri üçün: Code.gs-i (tests/gas-mock.js ilə) kiçik HTTP serverdə işlədir.
   node tests/gas-server.js 8787 — GET → doGet, POST → doPost, GET /__rows/<Vərəq> → vərəqin sətirləri (yoxlama üçün) */
const http = require('http');
const { makeBackend } = require('./gas-mock.js');
const port = parseInt(process.argv[2] || '8787', 10);
const be = makeBackend({ token: 'e2e-token' });
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const m = /^\/__rows\/(\w+)$/.exec(req.url);
    if (m) return res.end(JSON.stringify(be.rows(m[1])));
    res.end(JSON.stringify(req.method === 'POST' ? be.post(body) : be.get()));
  });
}).listen(port, '127.0.0.1', () => console.log('ready'));
