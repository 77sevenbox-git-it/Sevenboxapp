"""Brauzerdə uçdan-uca yoxlama: giriş → PIN dəyişmə → nümunə məhsullar → növbə → satış → çek → qaytarma.
İşə salmaq: python3 tests/e2e.py (layihə qovluğunda http server avtomatik açılır)."""
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get('SHOTS', '/tmp/shots')
os.makedirs(OUT, exist_ok=True)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errors = []
ok = []

def check(cond, msg):
    (ok if cond else errors).append(msg)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Baku')
        pg.on('pageerror', lambda e: errors.append('JS xətası: ' + str(e)))
        pg.add_init_script('window.print = function(){ window.__printed = (window.__printed||0)+1; };')
        pg.goto('http://localhost:8765/index.html')
        pg.wait_for_selector('.users button')
        pg.screenshot(path=f'{OUT}/01-login.png')

        # Admin girişi və məcburi PIN dəyişmə
        pg.get_by_role('button', name='Admin Admin').click()
        pg.fill('#pin', '1234'); pg.keyboard.press('Enter')
        pg.wait_for_selector('#op')
        pg.fill('#op', '1234'); pg.fill('#np1', '9876'); pg.fill('#np2', '9876')
        pg.get_by_role('button', name='Saxla').click()
        pg.wait_for_selector('.modal-back', state='detached')

        # Nümunə məhsullar
        pg.get_by_role('navigation').get_by_role('button', name='Məhsullar').click()
        pg.get_by_role('button', name='Sınaq üçün nümunə məhsullar əlavə et').click()
        pg.wait_for_selector('text=Qız qalası maketi')
        pg.screenshot(path=f'{OUT}/02-products.png')
        codes = pg.evaluate("""() => DB.getAll('products').then(ps => Object.fromEntries(ps.map(p => [p.name, p.storeBarcode])))""")
        check(len(codes) == 5, 'nümunə məhsullar yaradıldı')

        # Kassa: növbə aç
        pg.get_by_role('navigation').get_by_role('button', name='Kassa').click()
        pg.fill('#open-cash', '50,00')
        pg.get_by_role('button', name='Növbəni aç').click()
        pg.wait_for_selector('#scan')

        # İstehsalçı barkodu yoxdur; naməlum barkod → xəta
        pg.fill('#scan', '1234567890128'); pg.keyboard.press('Enter')
        pg.wait_for_selector('.scan-msg.bad')
        check('tapılmadı' in pg.inner_text('#scan-msg'), 'naməlum barkod xəbərdarlığı')

        # 25,00 ₼ çek: konstruktor 1, ayı 1 (qalıq 0 → mənfi), maqnit 2
        for name in ['Konstruktor dəsti, 120 hissə', 'Yumşaq ayı, 25 sm', 'Maqnit «Bakı»', 'Maqnit «Bakı»']:
            pg.fill('#scan', codes[name]); pg.keyboard.press('Enter')
            pg.wait_for_timeout(150)
        check(pg.inner_text('.totals .grand b').startswith('25,00'), 'yekun 25,00 ₼')
        check('mənfi qalıqla satış 1/2' in pg.inner_text('.pos-main'), 'mənfi qalıq xəbərdarlığı görünür')

        pg.keyboard.press('F1')
        pg.wait_for_selector('#pay-cash')
        pg.fill('#pay-cash', '20')
        check('azdır' in pg.inner_text('.change'), 'az nağdda xəta')
        pg.fill('#pay-cash', '100')
        check('75,00' in pg.inner_text('.change'), 'qaytarılacaq 75,00')
        pg.screenshot(path=f'{OUT}/03-pos-cash.png')
        pg.keyboard.press('Enter')
        pg.wait_for_function('window.__printed >= 1')
        check('YEKUN' in pg.inner_text('#print-area'), 'çek çap üçün hazırlandı')
        check('Çek № 1 tamamlandı' in pg.inner_text('#scan-msg'), 'satış tamamlandı mesajı')
        receipt_bc = pg.evaluate("() => DB.getAll('sales').then(s => s[0].receiptBarcode)")
        pg.screenshot(path=f'{OUT}/04-after-sale.png')

        # Çekin özü (çap görünüşü)
        pg.emulate_media(media='print')
        pg.screenshot(path=f'{OUT}/05-receipt-print.png', clip={'x': 0, 'y': 0, 'width': 320, 'height': 700})
        pg.emulate_media(media='screen')

        # Endirim: kassir yox, menecer PIN-i 2222
        pg.fill('#scan', codes['Puzzl 500 hissə']); pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
        pg.keyboard.press('F4')
        pg.fill('#disc', '5'); pg.get_by_role('button', name='Menecerə göndər').click()
        pg.fill('#appr-pin', '1111'); pg.keyboard.press('Enter')
        pg.wait_for_selector('.toast.bad')
        pg.fill('#appr-pin', '2222'); pg.keyboard.press('Enter')
        pg.wait_for_selector('.modal-back', state='detached')
        check(pg.inner_text('.totals .grand b').startswith('11,40'), '5% endirim: 12,00 → 11,40')

        # Qarışıq: 5 köçürmə + nağd 10 → 3,60 qaytarılır
        pg.keyboard.press('F3')
        pg.get_by_role('button', name='Karta köçürmə').click()
        pg.fill('#pay-bank', '5'); pg.fill('#pay-cash', '10')
        check('3,60' in pg.inner_text('.change'), 'qarışıq ödəniş qalığı 3,60')
        pg.screenshot(path=f'{OUT}/06-pos-mixed-discount.png')
        pg.get_by_role('button', name='Təsdiqlə və çek çap et (Enter)').click()
        pg.wait_for_function('window.__printed >= 2')

        # Kassada istehsalçı barkodu → rədd (əvvəl bir məhsula istehsalçı barkodu verək)
        pg.evaluate("""() => DB.getAll('products').then(ps => { const p = ps.find(x => x.name.startsWith('Puzzl')); p.mfrBarcode = '4006381333931'; return DB.put('products', p); })""")
        pg.fill('#scan', '4006381333931'); pg.keyboard.press('Enter')
        pg.wait_for_selector('text=istehsalçı barkodudur')
        check(True, 'istehsalçı barkodu kassada qəbul olunmur')

        # Qaytarma
        pg.get_by_role('navigation').get_by_role('button', name='Qaytarma').click()
        pg.fill('#rscan', receipt_bc); pg.keyboard.press('Enter')
        pg.wait_for_selector('text=Qaytarılır')
        pg.get_by_label('Qaytarılan say: Maqnit «Bakı»').fill('1')
        pg.get_by_role('button', name='Qaytar', exact=True).click()
        pg.fill('#appr-pin', '2222'); pg.keyboard.press('Enter')
        pg.wait_for_selector('text=Qaytarıldı')
        pg.screenshot(path=f'{OUT}/07-return.png')
        check('QAYTARMA ÇEKİ' in pg.inner_text('#print-area'), 'qaytarma çeki')

        # Növbə hesabatı: 50 + 25 + 6,40 − 2,25 = 79,15
        pg.get_by_role('navigation').get_by_role('button', name='Növbə').click()
        pg.wait_for_selector('text=Kassada olmalı nağd')
        check('79,15' in pg.inner_text('main'), 'gözlənilən nağd 79,15')
        pg.screenshot(path=f'{OUT}/08-shift.png')

        # Telefon eni
        pg.set_viewport_size({'width': 390, 'height': 844})
        pg.get_by_role('navigation').get_by_role('button', name='Kassa').click()
        pg.wait_for_selector('#scan')
        sw = pg.evaluate('document.documentElement.scrollWidth')
        check(sw <= 390, f'telefon enində üfüqi sürüşmə yoxdur ({sw}px)')
        pg.screenshot(path=f'{OUT}/09-phone.png', full_page=True)
        b.close()
finally:
    srv.terminate()

for m in ok: print('✓', m)
for m in errors: print('✗', m)
print(f'\n{len(ok)} keçdi, {len(errors)} uğursuz')
sys.exit(1 if errors else 0)
