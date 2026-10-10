"""Əlçatanlıq (WCAG 2.1 A/AA) yoxlaması: axe-core ilə əsas ekranlar. İşə salmaq: python3 tests/e2e_a11y.py
axe-core lazımdır: `npm i -D axe-core` (və ya AXE_PATH=/yol/axe.min.js). Yoxdursa test atlanır.
"Critical" pozuntu testi uğursuz edir; "serious/moderate" hesabata düşür (siyahı çıxarılır)."""
import subprocess, time, sys, os, json, re, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AXE = os.environ.get('AXE_PATH') or os.path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js')
if not os.path.exists(AXE):
    print('axe-core tapılmadı (npm i -D axe-core) — test atlandı'); sys.exit(0)
WEB, MOCK = 8772, 8792
URL = 'https://script.google.com/macros/s/AKfycbA11Y/exec'
TOKEN = 'e2e-token'
web = subprocess.Popen([sys.executable, '-m', 'http.server', str(WEB), '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
gas = subprocess.Popen(['node', os.path.join(ROOT, 'tests', 'gas-server.js'), str(MOCK)], stdout=subprocess.PIPE)
gas.stdout.readline()
errors, ok, findings = [], [], []
def check(cond, msg): (ok if cond else errors).append(msg)

def proxy(route, request):
    data = request.post_data.encode() if request.method == 'POST' else None
    body = urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{MOCK}/', data=data, method=request.method)).read()
    route.fulfill(status=200, body=body, headers={'access-control-allow-origin': '*', 'content-type': 'application/json'})

def audit(pg, where, device='telefon'):
    pg.add_script_tag(path=AXE) if not pg.evaluate('() => !!window.axe') else None
    res = pg.evaluate("""async () => await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })""")
    for v in res['violations']:
        nodes = [n['target'][0] if n['target'] else '?' for n in v['nodes']][:3]
        findings.append({'where': where, 'device': device, 'id': v['id'], 'impact': v['impact'], 'help': v['help'], 'count': len(v['nodes']), 'example': nodes})
    crit = [v for v in res['violations'] if v['impact'] == 'critical']
    check(not crit, f'{where} [{device}]: kritik əlçatanlıq pozuntusu yoxdur ({[c["id"] for c in crit]})')
    return res

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        first = True
        for device, vp in (('kompüter', {'width': 1440, 'height': 900}), ('telefon', {'width': 390, 'height': 800})):
            ctx = b.new_context(viewport=vp, timezone_id='Asia/Baku', bypass_csp=True)
            ctx.route('https://script.google.com/**', proxy)
            ctx.add_init_script('window.print = function(){};')
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append('JS xətası: ' + str(e)))
            pg.goto(f'http://localhost:{WEB}/index.html'); pg.wait_for_selector('.users button')
            audit(pg, 'Giriş ekranı', device)
            pg.click('#connect-btn'); pg.wait_for_selector('#c-url'); audit(pg, 'Serverə qoşulma pəncərəsi', device)
            if first:      # yalnız ilk cihaz serverə qoşulur (ikinci cihaz birincinin dəyişdirdiyi PIN-i və açıq növbəni alardı)
                pg.fill('#c-url', URL); pg.fill('#c-tok', TOKEN); pg.get_by_role('button', name='Qoş və yüklə').click()
            else:
                pg.keyboard.press('Escape')
            pg.wait_for_selector('.modal-back', state='detached'); first = False
            pg.get_by_role('button', name='Admin Admin').click(); pg.fill('#pin', '1234'); pg.keyboard.press('Enter'); pg.wait_for_selector('#op')
            audit(pg, 'PIN dəyişmə ekranı', device)
            pg.fill('#op', '1234'); pg.fill('#np1', '4827'); pg.fill('#np2', '4827'); pg.get_by_role('button', name='Saxla və davam et').click(); pg.wait_for_selector('nav')
            pg.evaluate("() => Services.seedDemoProducts()"); pg.wait_for_timeout(300)
            audit(pg, 'Kassa: növbə açılışı', device)
            pg.fill('#open-cash', '50'); pg.get_by_role('button', name='Növbəni aç').click(); pg.wait_for_selector('#scan')
            codes = pg.evaluate("() => DB.getAll('products').then(ps => ps.map(p => p.storeBarcode))")
            for c in codes[:3]:
                pg.fill('#scan', c); pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
            audit(pg, 'Kassa: səbət', device)
            pg.keyboard.press('F1'); pg.wait_for_selector('#pay-cash'); audit(pg, 'Ödəniş pəncərəsi', device)
            pg.keyboard.press('Escape'); pg.wait_for_selector('.modal-back'); audit(pg, 'Çekin ləğvi (menecer PIN-i) pəncərəsi', device)
            pg.get_by_role('button', name='İmtina').click(); pg.wait_for_selector('.modal-back', state='detached')
            for nm in ('Qaytarma', 'Məhsullar', 'Təchizatçılar', 'Çeklər', 'Növbə', 'İcazələr'):
                pg.get_by_role('navigation').get_by_role('button', name=nm, exact=True).click(); pg.wait_for_timeout(600)
                audit(pg, 'Ekran: ' + nm, device)
            # məhsullar: pəncərələr
            pg.get_by_role('navigation').get_by_role('button', name='Məhsullar', exact=True).click(); pg.wait_for_timeout(400)
            for label in ('Yeni məhsul', 'Qəbul', 'Düzəliş', 'Etiket'):
                btn = pg.get_by_role('button', name=re.compile('^' + label)).first
                if btn.count():
                    btn.click(); pg.wait_for_timeout(400)
                    if pg.locator('.modal-back').count():
                        audit(pg, 'Pəncərə: ' + label, device); pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
            ctx.close()
        b.close()
finally:
    web.terminate(); gas.terminate()

# eyni pozuntunu bir yerdə topla
agg = {}
for f in findings:
    k = (f['id'], f['impact'], f['help'])
    a = agg.setdefault(k, {'count': 0, 'where': set(), 'example': f['example'][0] if f['example'] else ''})
    a['count'] += f['count']; a['where'].add(f['where'])
order = {'critical': 0, 'serious': 1, 'moderate': 2, 'minor': 3}
print('\n— Əlçatanlıq pozuntuları (təkrarsız) —')
for (rid, imp, helptxt), a in sorted(agg.items(), key=lambda kv: (order.get(kv[0][1], 9), -kv[1]['count'])):
    print(f'  [{imp}] {rid}: {helptxt} — {a["count"]} element, {len(a["where"])} ekranda, məs. {a["example"]}')
json.dump([dict(id=k[0], impact=k[1], help=k[2], count=v['count'], screens=sorted(v['where']), example=v['example']) for k, v in agg.items()], open(os.environ.get('A11Y_OUT', '/tmp/a11y-findings.json'), 'w'), ensure_ascii=False, indent=1)
print('\n'.join('✓ ' + m for m in ok[:6]) + (f'\n… (+{len(ok) - 6})' if len(ok) > 6 else ''))
if errors: print('\n'.join('✗ ' + m for m in errors))
print(f'\n{len(ok)} keçdi, {len(errors)} uğursuz')
sys.exit(1 if errors else 0)
