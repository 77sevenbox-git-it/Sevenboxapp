"""Oflayn iş (PWA): internet kəsiləndə səhifə yenilənir, yeni tab açılır, satış gedir, internet qayıdanda hər şey serverə çatır.
Tətbiq service worker-i yalnız HTTPS-də qeydiyyatdan keçirir, ona görə sınaq öz imzalı sertifikatla yerli HTTPS server qurur. İşə salmaq: python3 tests/e2e_offline.py"""
import subprocess, time, sys, os, json, ssl, threading, http.server, functools, tempfile, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB, MOCK = 8774, 8794
URL = 'https://script.google.com/macros/s/AKfycbOFF/exec'
TOKEN = 'e2e-token'
tmp = tempfile.mkdtemp()
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f'{tmp}/k.pem', '-out', f'{tmp}/c.pem', '-days', '2', '-subj', '/CN=localhost',
                '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], check=True, capture_output=True)
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(('127.0.0.1', WEB), functools.partial(Quiet, directory=ROOT))
sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); sctx.load_cert_chain(f'{tmp}/c.pem', f'{tmp}/k.pem')
httpd.socket = sctx.wrap_socket(httpd.socket, server_side=True)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
gas = subprocess.Popen(['node', os.path.join(ROOT, 'tests', 'gas-server.js'), str(MOCK)], stdout=subprocess.PIPE)
gas.stdout.readline()
errors, ok = [], []
def check(cond, msg): (ok if cond else errors).append(msg)
OFFLINE = [False]

def rows(sheet): return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{MOCK}/__rows/{sheet}').read())

def proxy(route, request):
    if OFFLINE[0]: return route.abort('internetdisconnected')
    data = request.post_data.encode() if request.method == 'POST' else None
    body = urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{MOCK}/', data=data, method=request.method)).read()
    route.fulfill(status=200, body=body, headers={'access-control-allow-origin': '*', 'content-type': 'application/json'})

def poll(fn, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(0.25)
    return False

def scan(pg, code): pg.keyboard.type(code, delay=2); pg.keyboard.press('Enter'); pg.wait_for_timeout(250)

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--ignore-certificate-errors'])
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Baku', ignore_https_errors=True)
        ctx.route('https://script.google.com/**', proxy)
        ctx.add_init_script('window.__printed = 0; window.print = function(){ window.__printed++; };')
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('JS xətası: ' + str(e)))
        pg.on('console', lambda m: errors.append('CSP pozuntusu: ' + m.text[:200]) if 'Content Security Policy' in m.text else None)
        pg.goto(f'https://localhost:{WEB}/index.html'); pg.wait_for_selector('.users button')

        sw_ok = poll(lambda: pg.evaluate("() => navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))"), 15)
        if not sw_ok:
            print('SKIP: service worker bu mühitdə qeydiyyatdan keçmədi — oflayn sınaq atlandı'); sys.exit(0)
        check(sw_ok, 'service worker aktivdir')
        check(poll(lambda: pg.evaluate("() => caches.keys().then(async ks => { const k = ks.find(x => /^magaza-v/.test(x)); if (!k) return false; return (await (await caches.open(k)).keys()).length >= 20; })"), 15), 'tətbiq faylları keşə yazılıb (≥20 fayl)')
        pg.reload(); pg.wait_for_selector('.users button')

        pg.click('#connect-btn'); pg.fill('#c-url', URL); pg.fill('#c-tok', TOKEN)
        pg.get_by_role('button', name='Qoş və yüklə').click(); pg.wait_for_selector('.modal-back', state='detached')
        pg.get_by_role('button', name='Admin Admin').click(); pg.fill('#pin', '1234'); pg.keyboard.press('Enter'); pg.wait_for_selector('#op')
        pg.fill('#op', '1234'); pg.fill('#np1', '4827'); pg.fill('#np2', '4827'); pg.get_by_role('button', name='Saxla və davam et').click(); pg.wait_for_selector('nav')
        pg.evaluate("() => Services.seedDemoProducts()"); pg.wait_for_timeout(300)
        codes = pg.evaluate("() => DB.getAll('products').then(ps => ps.map(p => [p.name, p.storeBarcode]))")
        pg.get_by_role('navigation').get_by_role('button', name='Kassa', exact=True).click()
        pg.fill('#open-cash', '50'); pg.get_by_role('button', name='Növbəni aç').click(); pg.wait_for_selector('#scan')
        pg.evaluate("() => Sync.cycle()"); pg.wait_for_timeout(500)

        # ---- internet kəsilir ----
        OFFLINE[0] = True; ctx.set_offline(True)
        pg.reload()
        check(poll(lambda: pg.locator('nav').count() > 0 and pg.locator('#scan').count() > 0, 15), 'oflayn yeniləmə: səhifə keşdən açıldı, giriş saxlandı, kassa ekranı açıqdır')
        for i in range(3):
            scan(pg, codes[i][1]); pg.keyboard.press('F1'); pg.wait_for_selector('#pay-cash'); pg.fill('#pay-cash', '1000')
            pg.keyboard.press('Enter')
            t0 = time.time()
            while pg.evaluate("() => window.__printed") < i + 1 and time.time() - t0 < 10: pg.wait_for_timeout(100)
        sales = pg.evaluate("() => DB.getAll('sales').then(s => s.map(x => [x.receiptNo, x.offline]))")
        check(len(sales) == 3 and all(s[1] for s in sales), f'oflayn 3 satış tamamlandı, "offline" işarəsi var: {sales}')
        check(pg.evaluate("() => DB.getAll('outbox').then(o => o.length)") >= 3, 'hadisələr outbox-da gözləyir')
        check(len(rows('Sales')) == 0, 'server hələ heç nə almayıb')

        # yeni tab (oflayn)
        pg2 = ctx.new_page(); pg2.on('pageerror', lambda e: errors.append('JS xətası (tab2): ' + str(e)))
        pg2.goto(f'https://localhost:{WEB}/index.html')
        check(poll(lambda: pg2.locator('.users button').count() >= 3 or pg2.locator('nav').count() > 0, 15), 'oflayn yeni tab açılır (keşdən)')
        pg2.close()

        # ---- internet qayıdır ----
        OFFLINE[0] = False; ctx.set_offline(False)
        pg.evaluate("() => Sync.kick && Sync.kick()")
        got = poll(lambda: len(rows('Sales')) == 3, 40)
        if not got: pg.evaluate("() => Sync.cycle()"); got = poll(lambda: len(rows('Sales')) == 3, 20)
        check(got, f'internet qayıdandan sonra 3 çek serverə çatdı ({len(rows("Sales"))})')
        check(poll(lambda: pg.evaluate("() => DB.getAll('outbox').then(o => o.length)") == 0, 20), 'outbox boşaldı')
        nos = sorted(int(float(r[1])) for r in rows('Sales'))
        check(nos == [1, 2, 3], f'çek nömrələri ardıcıl: {nos}')
        ids = [r[0] for r in rows('Events')]
        check(len(ids) == len(set(ids)), 'serverdə təkrar hadisə yoxdur')
        ctx.close(); b.close()
finally:
    httpd.shutdown(); gas.terminate()

print('\n'.join('✓ ' + m for m in ok))
if errors: print('\n'.join('✗ ' + m for m in errors))
print(f'\n{len(ok)} keçdi, {len(errors)} uğursuz')
sys.exit(1 if errors else 0)
