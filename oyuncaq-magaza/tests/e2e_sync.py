"""İki ayrı brauzer (ayrı yaddaş) + Apps Script təqlidi: cihazlararası sinxron, PIN-in bazaya yazılması,
menecerə sətir silmə sorğusu. İşə salmaq: python3 tests/e2e_sync.py"""
import subprocess, time, sys, os, json, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get('SHOTS', '/tmp/shots')
os.makedirs(OUT, exist_ok=True)
WEB, MOCK = 8766, 8787
URL = 'https://script.google.com/macros/s/AKfycbE2E/exec'
TOKEN = 'e2e-token'
web = subprocess.Popen([sys.executable, '-m', 'http.server', str(WEB), '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
gas = subprocess.Popen(['node', os.path.join(ROOT, 'tests', 'gas-server.js'), str(MOCK)], stdout=subprocess.PIPE)
gas.stdout.readline()
errors, ok = [], []

def check(cond, msg):
    (ok if cond else errors).append(msg)

def rows(sheet):
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{MOCK}/__rows/{sheet}').read())

PUMP = []   # Playwright sync API marşrut işləyicilərini yalnız API çağırışı zamanı icra edir; gözləyərkən də çağırış lazımdır

def wait_until(fn, timeout=20, step=0.25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if fn(): return time.time() - t0
        if PUMP: PUMP[0].wait_for_timeout(int(step * 1000))
        else: time.sleep(step)
    return None

def proxy(route, request):
    data = request.post_data.encode() if request.method == 'POST' else None
    r = urllib.request.Request(f'http://127.0.0.1:{MOCK}/', data=data, method=request.method)
    body = urllib.request.urlopen(r).read()
    route.fulfill(status=200, body=body, headers={'access-control-allow-origin': '*', 'content-type': 'application/json'})

def open_page(b):
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Baku')   # ayrı kontekst = ayrı brauzer yaddaşı
    ctx.route('https://script.google.com/**', proxy)
    ctx.add_init_script('window.print = function(){};')
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append('JS xətası: ' + str(e)))
    pg.goto(f'http://localhost:{WEB}/index.html')
    pg.wait_for_selector('.users button')
    return pg

def connect(pg):
    pg.click('#connect-btn')
    pg.fill('#c-url', URL); pg.fill('#c-tok', TOKEN)
    pg.get_by_role('button', name='Qoş və yüklə').click()
    pg.wait_for_selector('.modal-back', state='detached')

def login(pg, name, pin):
    pg.get_by_role('button', name=f'{name} {name}' if not name.startswith('Mühasib') else name).click()
    pg.fill('#pin', pin); pg.keyboard.press('Enter')

def set_pin(pg, old, new):
    pg.wait_for_selector('#op')
    pg.fill('#op', old); pg.fill('#np1', new); pg.fill('#np2', new)
    pg.get_by_role('button', name='Saxla və davam et').click()
    pg.wait_for_selector('nav')

def logout(pg):
    pg.get_by_role('button', name='Çıxış').click()
    pg.wait_for_selector('.users button')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()

        # ---------- Brauzer 1: qoşul, Admin PIN-i dəyişir ----------
        p1 = open_page(b)
        PUMP.append(p1)
        connect(p1)
        check(wait_until(lambda: len(rows('Users')) == 5, 10) is not None, 'qoşulanda 5 istifadəçi "Users" vərəqinə yazılıb')
        login(p1, 'Admin', '1234')
        set_pin(p1, '1234', '4827')
        def admin_row():
            r = [x for x in rows('Users') if x[0] == 'u_admin']
            return r[0] if r else None
        check(wait_until(lambda: admin_row() and admin_row()[4] is False, 10) is not None, 'Admin PIN-i dəyişəndə bazada (Users) mustChangePin=false olur')
        check(admin_row() and admin_row()[7] and len(admin_row()[7]) == 64, 'bazada PIN hash-ı yazılıb (düz PIN deyil)')
        check('4827' not in json.dumps(rows('Users')) and '4827' not in json.dumps(rows('Events')), 'düz PIN heç yerdə yazılmayıb')

        p1.get_by_role('navigation').get_by_role('button', name='Məhsullar').click()
        p1.get_by_role('button', name='Sınaq üçün nümunə məhsullar əlavə et').click()
        p1.wait_for_selector('text=Qız qalası maketi')
        check(wait_until(lambda: len(rows('Products')) == 5, 15) is not None, '5 məhsul bazaya yazıldı')

        # ---------- Brauzer 2 (ayrı yaddaş): qoşul → məlumat gəlir ----------
        p2 = open_page(b)
        connect(p2)
        p2.get_by_role('button', name='Admin Admin').click()
        p2.fill('#pin', '1234'); p2.keyboard.press('Enter')
        p2.wait_for_selector('.toast.bad')
        check('PIN səhvdir' in p2.inner_text('.toast-host'), '2-ci brauzerdə köhnə sınaq PIN-i artıq işləmir (yeni PIN bazadan gəlib)')
        p2.fill('#pin', '4827'); p2.keyboard.press('Enter')
        p2.wait_for_selector('nav')
        check(p2.locator('#op').count() == 0, '2-ci brauzerdə yeni PIN ilə girişdə PIN dəyişmə tələb olunmur')
        p2.get_by_role('navigation').get_by_role('button', name='Məhsullar').click()
        p2.wait_for_selector('text=Qız qalası maketi')
        codes1 = p1.evaluate("() => DB.getAll('products').then(ps => ps.map(p => p.storeBarcode).sort())")
        codes2 = p2.evaluate("() => DB.getAll('products').then(ps => ps.map(p => p.storeBarcode).sort())")
        check(len(codes2) == 5 and codes1 == codes2, '2-ci brauzerdə eyni 5 məhsul, eyni barkodlarla')
        p2.screenshot(path=f'{OUT}/s1-browser2-products.png')

        # ---------- Brauzer 1: Kassir, növbə, sətir silmə sorğusu ----------
        logout(p1)
        login(p1, 'Kassir', '1111')
        set_pin(p1, '1111', '5530')
        # Mal qəbulu ayrıca icazədir: kassir məhsulları görür, etiket çap edir, amma qəbul edə və məhsul yarada bilmir
        p1.get_by_role('navigation').get_by_role('button', name='Məhsullar').click()
        p1.wait_for_selector('text=Puzzl 500 hissə')
        check(p1.get_by_role('button', name='Qəbul').count() == 0 and p1.get_by_role('button', name='Yeni məhsul').count() == 0,
              'kassir "Məhsullar"da "Qəbul" və "Yeni məhsul" düymələrini görmür')
        check(p1.get_by_role('button', name='Etiket').count() == 5, 'kassir etiket çap edə bilir')
        p1.get_by_role('navigation').get_by_role('button', name='Kassa').click()
        p1.fill('#open-cash', '20,00'); p1.get_by_role('button', name='Növbəni aç').click()
        p1.wait_for_selector('#scan')
        magnet = [x for x in rows('Products') if x[1].startswith('Maqnit')][0][5]
        p1.fill('#scan', magnet); p1.keyboard.press('Enter'); p1.wait_for_timeout(200)
        p1.fill('#scan', magnet); p1.keyboard.press('Enter'); p1.wait_for_timeout(200)
        check(p1.locator('tbody tr', has_text='Maqnit').count() == 1, 'Maqnit çekdədir (2 ədəd)')

        # Brauzer 2: Menecer kimi daxil ol
        logout(p2)
        login(p2, 'Menecer', '2222')
        set_pin(p2, '2222', '6149')
        # Menecer mal qəbul edir → qalıq kassirin brauzerinə də çatır
        p2.get_by_role('navigation').get_by_role('button', name='Məhsullar').click()
        p2.wait_for_selector('text=Puzzl 500 hissə')
        check(p2.get_by_role('button', name='Qəbul').count() == 5, 'menecer hər məhsulda "Qəbul" düyməsini görür')
        p2.locator('tbody tr', has_text='Puzzl').get_by_role('button', name='Qəbul').click()
        p2.fill('#r-qty', '3'); p2.get_by_role('button', name='Qəbul et').click()
        p2.wait_for_selector('text=Etiket çapı'); p2.get_by_role('button', name='Bağla').click()
        puzzl = "() => DB.getAll('products').then(ps => ps.find(p => p.name.startsWith('Puzzl')).stock)"
        check(p2.evaluate(puzzl) == 11, 'menecer 3 ədəd qəbul etdi: 8 → 11')
        latr = wait_until(lambda: p1.evaluate(puzzl) == 11, 25)
        check(latr is not None, f'menecerin qəbul etdiyi mal kassirin brauzerində görünür ({latr:.1f} san)' if latr else 'qəbul kassirin brauzerinə çatmadı')

        p1.locator('tbody tr', has_text='Maqnit').get_by_role('button', name='Sətri sil').click()
        p1.wait_for_selector('#appr-pin')
        check(p1.get_by_role('button', name='Menecerə sorğu göndər').count() == 1, 'server qoşulubdursa "Menecerə sorğu göndər" düyməsi var')
        t_send = time.time()
        p1.get_by_role('button', name='Menecerə sorğu göndər').click()
        p1.wait_for_selector('text=Sorğu menecerə göndərildi')
        p1.screenshot(path=f'{OUT}/s2-request-waiting.png')
        lat = wait_until(lambda: p2.get_by_role('button', name='Sorğular (1)').count() == 1, 25)
        check(lat is not None, f'menecerin ekranında "Sorğular (1)" çıxır ({lat:.1f} san)' if lat else 'menecerin ekranında "Sorğular (1)" çıxmadı')
        if lat: print(f'   gecikmə: sorğu → menecer ekranı {lat:.1f} san')
        p2.get_by_role('button', name='Sorğular (1)').click()
        p2.wait_for_selector('.req-item')
        check('Maqnit' in p2.inner_text('.req-item') and 'Kassir' in p2.inner_text('.req-item'), 'sorğuda məhsul və kassirin adı görünür')
        p2.screenshot(path=f'{OUT}/s3-manager-requests.png')
        t_dec = time.time()
        p2.get_by_role('button', name='Təsdiqlə', exact=True).click()
        p2.wait_for_selector('text=Gözləyən sorğu yoxdur')
        p2.get_by_role('button', name='Bağla').click()
        lat2 = wait_until(lambda: p1.locator('.modal-back').count() == 0, 25)
        check(lat2 is not None, f'təsdiqdən sonra kassirin pəncərəsi bağlanır ({lat2:.1f} san)' if lat2 else 'kassir cavab almadı')
        if lat2: print(f'   gecikmə: menecer təsdiqi → kassir {lat2:.1f} san')
        check(p1.locator('tbody tr', has_text='Maqnit').count() == 0, 'menecer təsdiqindən sonra sətir silinib')
        check('Menecer təsdiqlədi' in p1.inner_text('#scan-msg'), 'kassirə kim təsdiqlədiyi göstərilir')
        approved = p1.evaluate("() => DB.getAll('audit').then(a => a.filter(x => x.type === 'pos.line_removed').map(x => x.data.approvedByName))")
        check(approved == ['Menecer'], 'silmə audit jurnalında təsdiqləyən menecerdir')

        # Rədd olunan sorğu
        p1.fill('#scan', magnet); p1.keyboard.press('Enter'); p1.wait_for_timeout(200)
        p1.locator('tbody tr', has_text='Maqnit').get_by_role('button', name='Sətri sil').click()
        p1.wait_for_selector('#appr-pin')
        p1.get_by_role('button', name='Menecerə sorğu göndər').click()
        p1.wait_for_selector('text=Sorğu menecerə göndərildi')
        check(wait_until(lambda: p2.get_by_role('button', name='Sorğular (1)').count() == 1, 25) is not None, 'ikinci sorğu menecerə çatır')
        p2.get_by_role('button', name='Sorğular (1)').click()
        p2.wait_for_selector('.req-item')
        p2.get_by_role('button', name='Rədd et').click()
        check(wait_until(lambda: p1.locator('.modal-back').count() == 0, 25) is not None, 'rədd cavabı kassirə çatır')
        check(p1.locator('tbody tr', has_text='Maqnit').count() == 1, 'rədd olunanda sətir qalır')
        p2.get_by_role('button', name='Bağla').click()

        # ---------- Satış 1-ci brauzerdə → 2-ci brauzerin "Çeklər" siyahısında canlı görünür ----------
        p2.get_by_role('navigation').get_by_role('button', name='Çeklər').click()
        p2.wait_for_selector('text=Hələ satış yoxdur')
        p1.keyboard.press('F1'); p1.wait_for_selector('#pay-cash'); p1.fill('#pay-cash', '10'); p1.keyboard.press('Enter')
        p1.wait_for_function("document.querySelector('#scan-msg').textContent.includes('tamamlandı')")
        t_sale = time.time()
        lat3 = wait_until(lambda: p2.locator('tbody tr .mono').count() >= 1, 25)
        check(lat3 is not None, f'1-ci brauzerdə satılan çek 2-cidə avtomatik görünür ({lat3:.1f} san)' if lat3 else '2-ci brauzerdə çek görünmədi')
        if lat3: print(f'   gecikmə: satış → 2-ci brauzerin çek siyahısı {lat3:.1f} san')
        p2.screenshot(path=f'{OUT}/s4-browser2-sales.png')
        stock_p2 = p2.evaluate("() => DB.getAll('products').then(ps => ps.find(p => p.name.startsWith('Maqnit')).stock)")
        stock_p1 = p1.evaluate("() => DB.getAll('products').then(ps => ps.find(p => p.name.startsWith('Maqnit')).stock)")
        check(stock_p1 == stock_p2 == 39, f'qalıq iki brauzerdə eynidir və düzdür: 40 − 1 = 39 ({stock_p1} / {stock_p2})')

        # Bazada: bütün PIN-lər dəyişib, çek və sətirlər yazılıb
        users = {r[1]: r for r in rows('Users')}
        check(users['Kassir'][4] is False and users['Menecer'][4] is False and users['Admin'][4] is False, 'üç istifadəçinin PIN dəyişikliyi bazadadır')
        check(len(rows('Sales')) == 1 and len(rows('SaleLines')) == 1, 'çek bazada (Sales, SaleLines)')
        b.close()
finally:
    web.terminate(); gas.terminate()

for m in ok: print('✓', m)
for m in errors: print('✗', m)
print(f'\n{len(ok)} keçdi, {len(errors)} uğursuz')
sys.exit(1 if errors else 0)
