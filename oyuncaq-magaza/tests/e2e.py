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
        login_text = pg.inner_text('body')
        check('1234' not in login_text and 'Sınaq' not in login_text and '2222' not in login_text, 'giriş ekranında sınaq PIN-ləri yazılmayıb')

        # Admin girişi və məcburi PIN dəyişmə
        pg.get_by_role('button', name='Admin Admin').click()
        pg.fill('#pin', '1234'); pg.keyboard.press('Enter')
        pg.wait_for_selector('#op')
        check(pg.locator('#scan').count() == 0 and pg.locator('nav').count() == 0 and pg.locator('.topbar').count() == 0,
              'yeni PIN ekranında arxa fonda kassa / menyu yoxdur')
        pg.screenshot(path=f'{OUT}/01b-new-pin.png')
        # köhnə PIN ilə eyni, çox sadə və uyğunsuz PIN-lər rədd olunur
        pg.fill('#op', '1234'); pg.fill('#np1', '1234'); pg.fill('#np2', '1234'); pg.get_by_role('button', name='Saxla və davam et').click()
        pg.wait_for_selector('.toast.bad'); check('eyni ola bilməz' in pg.inner_text('.toast-host'), 'köhnə PIN ilə eyni PIN rədd olunur')
        pg.fill('#np1', '4827'); pg.fill('#np2', '4827')
        pg.get_by_role('button', name='Saxla və davam et').click()
        pg.wait_for_selector('nav')
        check(pg.locator('#op').count() == 0, 'PIN dəyişəndən sonra PIN ekranı bağlanır')
        pg.reload(); pg.wait_for_selector('nav')
        check(pg.locator('.users button').count() == 0 and 'Admin' in pg.inner_text('.status'), 'səhifəni yeniləyəndə giriş saxlanılır (çıxış vermir)')

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

        # Sayı azaltmaq sərbəstdir, 1-dən aşağı düşmür; sətri silmək menecer təsdiqi tələb edir
        magnet_row = pg.locator('tbody tr', has_text='Maqnit')
        magnet_row.get_by_role('button', name='Azalt').click()
        check(pg.inner_text('.totals .grand b').startswith('22,75'), 'say azaldılır: 25,00 → 22,75')
        check(magnet_row.get_by_role('button', name='Azalt').is_disabled(), 'say 1 olanda "−" söndürülür')
        magnet_row.get_by_role('button', name='Artır').click()
        check(pg.inner_text('.totals .grand b').startswith('25,00'), 'say artırılır: 22,75 → 25,00')
        bear_row = pg.locator('tbody tr', has_text='Yumşaq ayı')
        bear_row.get_by_role('button', name='Sətri sil').click()
        pg.wait_for_selector('#appr-pin')
        check(pg.get_by_role('button', name='Menecerə sorğu göndər').count() == 0, 'server qoşulmayıbsa sorğu düyməsi yoxdur (yalnız PIN)')
        pg.get_by_role('button', name='İmtina').click()
        pg.wait_for_selector('.modal-back', state='detached')
        check(pg.locator('tbody tr', has_text='Yumşaq ayı').count() == 1, 'imtina edəndə sətir qalır')
        bear_row.get_by_role('button', name='Sətri sil').click()
        pg.fill('#appr-pin', '1111'); pg.keyboard.press('Enter')
        pg.wait_for_selector('.toast.bad')
        check(pg.locator('.modal .modal-err').is_visible(), 'xəta pəncərənin içində də göstərilir (klaviatura toast-u örtsə də)')
        tb = pg.locator('.toast.bad').first.bounding_box()
        check(tb is not None and tb['y'] < 200, f'xəta mesajı ekranın yuxarısındadır, klaviatura altında itmir (y={tb and tb["y"]:.0f})')
        check(pg.locator('tbody tr', has_text='Yumşaq ayı').count() == 1, 'kassir PIN-i ilə sətir silinmir')
        pg.fill('#appr-pin', '2222'); pg.keyboard.press('Enter')
        pg.wait_for_selector('.modal-back', state='detached')
        pg.wait_for_function("!Array.from(document.querySelectorAll('tbody tr')).some(r => r.textContent.includes('Yumşaq ayı'))")
        check(pg.locator('tbody tr', has_text='Yumşaq ayı').count() == 0, 'menecer PIN-i ilə sətir silinir')
        check(pg.inner_text('.totals .grand b').startswith('19,00'), 'silindikdən sonra yekun 19,00')
        removed = pg.evaluate("() => DB.getAll('audit').then(a => a.filter(x => x.type === 'pos.line_removed').map(x => x.data.approvedByName))")
        check(removed == ['Menecer'], 'silmə audit jurnalına yazılıb (təsdiqləyən: Menecer)')
        pg.fill('#scan', codes['Yumşaq ayı, 25 sm']); pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
        check(pg.inner_text('.totals .grand b').startswith('25,00'), 'sətir yenidən əlavə edildi, yekun 25,00')

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

        # Qarışıq: alınan nağd boş qalanda nağd hissə dəqiq sayılır (qalıq verilmir)
        pg.fill('#scan', codes['Puzzl 500 hissə']); pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
        pg.keyboard.press('F3'); pg.fill('#pay-bank', '5')
        check('Nağd hissə: 7,00' in pg.inner_text('.pay-panel'), 'qarışıq ödənişdə nağd hissə avtomatik göstərilir (12,00 − 5,00)')
        check('0,00' in pg.inner_text('.change'), 'alınan nağd boşdursa qaytarılacaq 0,00')
        pg.get_by_role('button', name='Təsdiqlə və çek çap et (Enter)').click()
        pg.wait_for_function('window.__printed >= 3')

        # Kassada istehsalçı barkodu → rədd (əvvəl bir məhsula istehsalçı barkodu verək)
        pg.evaluate("""() => DB.getAll('products').then(ps => { const p = ps.find(x => x.name.startsWith('Puzzl')); p.mfrBarcode = '4006381333931'; return DB.put('products', p); })""")
        pg.fill('#scan', '4006381333931'); pg.keyboard.press('Enter')
        pg.wait_for_selector('text=istehsalçı barkodudur')
        check(True, 'istehsalçı barkodu kassada qəbul olunmur')

        # Qaytarma
        pg.get_by_role('navigation').get_by_role('button', name='Qaytarma').click()
        pg.fill('#rscan', receipt_bc); pg.keyboard.press('Enter')
        pg.wait_for_selector('text=Qaytarılır')
        # Satılandan çox: yazanda düzəlir və xəta göstərilir; zorla göndərmək də menecer ekranından ƏVVƏL rədd olunur
        inp = pg.get_by_label('Qaytarılan say: Maqnit «Bakı»')
        inp.fill('9')
        check(inp.input_value() == '2', 'qaytarma sayı satılandan çox yazılanda maksimuma düşür (2)')
        pg.wait_for_selector('.toast.bad'); check('ən çox 2' in pg.inner_text('.toast-host'), 'satılandan çox qaytarmaq xəbərdarlığı')
        pg.evaluate("() => { const i = document.querySelector('input[aria-label=\"Qaytarılan say: Maqnit «Bakı»\"]'); i.value = '7'; }")
        pg.get_by_role('button', name='Qaytar', exact=True).click()
        pg.wait_for_selector('main .modal-err')
        check(pg.locator('#appr-pin').count() == 0, 'say səhvdirsə menecer təsdiq ekranı açılmır')
        check('ən çox 2' in pg.inner_text('main .modal-err'), 'səhv say üçün xəta səhifədə göstərilir')
        inp.fill('1')
        pg.get_by_role('button', name='Qaytar', exact=True).click()
        pg.fill('#appr-pin', '2222'); pg.keyboard.press('Enter')
        pg.wait_for_selector('text=Qaytarıldı')
        pg.screenshot(path=f'{OUT}/07-return.png')
        check('QAYTARMA ÇEKİ' in pg.inner_text('#print-area'), 'qaytarma çeki')

        # Növbə hesabatı: 50 + 25 + 6,40 + 7,00 − 2,25 = 86,15
        pg.get_by_role('navigation').get_by_role('button', name='Növbə').click()
        pg.wait_for_selector('text=Kassada olmalı nağd')
        check('86,15' in pg.inner_text('main'), 'gözlənilən nağd 86,15')
        pg.screenshot(path=f'{OUT}/08-shift.png')

        # Növbəni bağla: fərq izahsız → xəta (səhifədə), düymə yenidən açılır; sonra düzgün bağlanır, Z çekində sıfır sətirlər yoxdur
        pg.get_by_role('button', name='Bağla və Z hesabatı çap et').click()
        pg.wait_for_selector('main .modal-err')
        check('Sayılmış' in pg.inner_text('main .modal-err'), 'sayılmış məbləğ boşdursa xəta səhifədə göstərilir')
        pg.fill('#counted', '70')
        pg.get_by_role('button', name='Bağla və Z hesabatı çap et').click()
        pg.wait_for_function("document.querySelector('main .modal-err') && !document.querySelector('main .modal-err').hidden && document.querySelector('main .modal-err').textContent.includes('İzah')")
        check(not pg.locator('#close-shift').is_disabled(), 'xəta olandan sonra "Bağla" düyməsi yenidən aktivdir')
        printed_before = pg.evaluate('window.__printed')
        pg.fill('#counted', '86,15')
        pg.get_by_role('button', name='Bağla və Z hesabatı çap et').click()
        pg.wait_for_function(f'window.__printed > {printed_before}')
        zt = pg.inner_text('#print-area')
        check('Z HESABATI' in zt and 'mədaxil' not in zt and 'məxaric' not in zt, 'Z çekində sıfır olan sətirlər (mədaxil/məxaric) yoxdur')
        check('Başlanğıc nağd' in zt and '50,00' in zt, 'Z çekində başlanğıc nağd var')

        # Yeni növbə əvvəlkinin qalığı ilə başlayır; fərqli məbləğ izah tələb edir
        pg.get_by_role('navigation').get_by_role('button', name='Kassa').click()
        pg.wait_for_selector('#open-cash')
        check(pg.input_value('#open-cash') == '86,15', f'yeni növbə əvvəlki qalıqla başlayır ({pg.input_value("#open-cash")})')
        check(not pg.locator('#open-note').is_visible(), 'qalıq dəyişməyibsə izah sahəsi gizlidir')
        pg.fill('#open-cash', '10')
        check(pg.locator('#open-note').is_visible(), 'məbləğ dəyişəndə izah sahəsi çıxır')
        pg.get_by_role('button', name='Növbəni aç').click()
        pg.wait_for_selector('.toast.bad:has-text("izah")'); check(True, 'izahsız fərqli açılış rədd olunur')
        pg.fill('#open-note', 'kassadan inkassasiya edilib')
        pg.get_by_role('button', name='Növbəni aç').click()
        pg.wait_for_selector('#scan')

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
