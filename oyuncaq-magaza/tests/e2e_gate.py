"""Yeni cihazın qoşulma qapısı: heç vaxt qurulmamış brauzerdə əvvəlcə yalnız «ünvan + açar» ekranı görünür, istifadəçi adları isə
yalnız serverə qoşulandan (və ya «serversiz» seçiləndən) sonra. Köhnə quraşdırmalar təsirlənmir. İşə salmaq: python3 tests/e2e_gate.py"""
import subprocess, sys, os
from playwright.sync_api import sync_playwright
from e2e_util import local_pass, gate_connect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB, MOCK = 8775, 8789
URL = 'https://script.google.com/macros/s/AKfycbE2E/exec'
TOKEN = 'e2e-token'
web = subprocess.Popen([sys.executable, '-m', 'http.server', str(WEB), '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
gas = subprocess.Popen(['node', os.path.join(ROOT, 'tests', 'gas-server.js'), str(MOCK)], stdout=subprocess.PIPE)
gas.stdout.readline()
errors, ok = [], []

def check(cond, msg): (ok if cond else errors).append(msg)

def proxy(route, request):
    import urllib.request
    data = request.post_data.encode() if request.method == 'POST' else None
    body = urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{MOCK}/', data=data, method=request.method)).read()
    route.fulfill(status=200, body=body, headers={'access-control-allow-origin': '*', 'content-type': 'application/json'})

def fresh(b):
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}, timezone_id='Asia/Baku')
    ctx.route('https://script.google.com/**', proxy)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append('JS xətası: ' + str(e)))
    pg.on('console', lambda m: errors.append('CSP pozuntusu: ' + m.text[:200]) if 'Content Security Policy' in m.text else None)
    pg.goto(f'http://localhost:{WEB}/index.html')
    return pg

def setup_flag(pg): return pg.evaluate("() => DB.get('meta', 'setup').then(m => m ? m.value : null)")
def user_buttons(pg): return pg.locator('.users button').count()

try:
    with sync_playwright() as p:
        b = p.chromium.launch()

        # ---------- 1. Yeni cihaz: istifadəçi adları görünmür ----------
        pg = fresh(b)
        pg.wait_for_selector('#connect-gate')
        check(user_buttons(pg) == 0 and pg.locator('.users').count() == 0, 'yeni cihazda istifadəçi siyahısı yoxdur')
        names = [pg.get_by_role('button', name=n).count() for n in ('Admin Admin', 'Menecer Menecer', 'Kassir Kassir', 'Mühasib 1', 'Mühasib 2')]
        check(sum(names) == 0, f'heç bir istifadəçi düyməsi yoxdur: {names}')
        check(pg.locator('#pin').count() == 0, 'PIN sahəsi yoxdur')
        check(pg.locator('#g-url').count() == 1 and pg.locator('#g-tok').count() == 1 and pg.locator('#g-go').count() == 1, 'ünvan, açar sahələri və «Qoş» düyməsi var')
        check(len(pg.inner_text('#device-id').strip()) >= 8, 'cihaz ID-si göstərilir (Admin açar yaratmaq üçün)')
        check(setup_flag(pg) == 'pending', 'qeyd: setup=pending')
        pg.reload(); pg.wait_for_selector('#connect-gate')
        check(user_buttons(pg) == 0, 'yenilədikdən sonra da qapı qalır')

        # ---------- 2. Səhv ünvan / səhv açar: qapı açılmır ----------
        pg.fill('#g-url', 'https://example.com/abc'); pg.fill('#g-tok', TOKEN); pg.click('#g-go')
        pg.wait_for_selector('#g-msg.warn-text')
        check('script.google.com' in pg.inner_text('#g-msg'), 'səhv ünvan: aydın xəta mesajı')
        check(user_buttons(pg) == 0 and not pg.locator('#g-go').is_disabled(), 'səhv ünvan: qapı bağlı, düymə yenidən aktivdir')
        pg.fill('#g-url', URL); pg.fill('#g-tok', 'yanlis-acar'); pg.click('#g-go')
        pg.wait_for_function("() => document.querySelector('#g-msg').textContent.length > 0 && !document.querySelector('#g-go').disabled")
        check(user_buttons(pg) == 0, 'səhv açar: istifadəçi adları yenə görünmür')
        check('uyğun gəlmir' in pg.inner_text('#g-msg') or 'Açar' in pg.inner_text('#g-msg'), f'səhv açar: xəta mesajı ({pg.inner_text("#g-msg")[:80]})')
        check(setup_flag(pg) == 'pending', 'uğursuz cəhddən sonra setup hələ pending')

        # ---------- 3. Düzgün ünvan + açar: adlar görünür ----------
        pg.fill('#g-tok', TOKEN); pg.click('#g-go')
        pg.wait_for_selector('.users button', timeout=30000)
        check(user_buttons(pg) >= 3, 'qoşulandan sonra istifadəçi adları görünür')
        check(pg.locator('#connect-gate').count() == 0, 'qapı bağlanıb')
        check(setup_flag(pg) == 'done', 'qeyd: setup=done')
        check('Server qoşulub' in pg.inner_text('.login'), 'giriş ekranında «Server qoşulub» yazısı')
        pg.reload(); pg.wait_for_selector('.users button')
        check(pg.locator('#connect-gate').count() == 0, 'yenilədikdən sonra qapı qayıtmır')
        pg.context.close()

        # ---------- 4. «Serversiz davam et»: qəsdən seçim ----------
        pg = fresh(b)
        pg.wait_for_selector('#connect-gate')
        pg.click('#gate-local')
        pg.wait_for_selector('.modal-back')
        check('sinxron olmayacaq' in pg.inner_text('.modal-back'), 'təsdiq pəncərəsi xəbərdarlıq verir')
        pg.get_by_role('button', name='İmtina').click(); pg.wait_for_selector('.modal-back', state='detached')
        check(user_buttons(pg) == 0 and setup_flag(pg) == 'pending', 'imtinadan sonra qapı qalır')
        pg.click('#gate-local'); pg.get_by_role('button', name='Serversiz davam et', exact=True).click()
        pg.wait_for_selector('.users button')
        check(user_buttons(pg) >= 3 and setup_flag(pg) == 'done', 'serversiz seçimdən sonra adlar görünür')
        check(pg.locator('#connect-btn').count() == 1, 'sonra serverə qoşmaq üçün düymə qalır')
        pg.context.close()

        # ---------- 5. Köhnə quraşdırma (setup qeydi yox): birbaşa giriş ----------
        pg = fresh(b)
        pg.wait_for_selector('#connect-gate')
        pg.evaluate("() => DB.del('meta', 'setup')")
        pg.reload(); pg.wait_for_selector('.users button')
        check(pg.locator('#connect-gate').count() == 0, 'köhnə quraşdırmada qapı çıxmır')
        pg.context.close()

        # ---------- 6. Dillər: yeni mətnlər tərcümə olunub ----------
        pg = fresh(b)
        pg.wait_for_selector('#connect-gate')
        az_h1 = pg.inner_text('#connect-gate h1')
        for code, word in (('en', 'New device'), ('ru', 'Новое устройство'), ('tr', 'Yeni cihaz')):
            with pg.expect_navigation():
                pg.select_option('#lang-sel', code)
            pg.wait_for_selector('#connect-gate')
            h1 = pg.inner_text('#connect-gate h1')
            check(word in h1 and h1 != az_h1, f'[{code}] qapı başlığı tərcümə olunub: {h1}')
            check('Serversiz' not in pg.inner_text('#gate-local') and 'əvvəlcə' not in pg.inner_text('#connect-gate'), f'[{code}] qapıda Azərbaycanca qalıq yoxdur')
            check(user_buttons(pg) == 0, f'[{code}] qapı dil dəyişəndə açılmır')
        pg.context.close()
        b.close()
finally:
    web.terminate(); gas.terminate()

print(f'\n{len(ok)} keçdi, {len(errors)} uğursuz')
for e in errors: print('✗', e)
sys.exit(1 if errors else 0)
