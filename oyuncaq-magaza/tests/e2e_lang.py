"""Dillər real Chromium-da: AZ / RU / EN / TR. Dil dəyişəndə giriş və yarımçıq çek itmir, bütün bölmələr tərcümə olunur (tərcüməsiz mətn qalmır),
çek interfeys dilindən ayrıdır (ilkin: Azərbaycanca), çek dili ayrıca seçiləndə çek həmin dildə çıxır, dar ekranda mətn sığır.
İşə salmaq: python3 tests/e2e_lang.py"""
import subprocess, time, sys, os, re
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get('SHOTS', '/tmp/shots'); os.makedirs(OUT, exist_ok=True)
PORT = 8771
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
ok, errors = [], []
def check(c, m): (ok if c else errors).append(m)
URL = f'http://localhost:{PORT}/index.html'
CYR = re.compile(r'[Ѐ-ӿ]')
BAD = re.compile(r'undefined|NaN|\[object|\{\d\}|@@')

def T(pg, az, lang=None):
    return pg.evaluate("([k, l]) => I18n.t(k, null, l || undefined)", [az, lang])

def to_lang(pg, code):
    if pg.evaluate("() => I18n.lang()") == code: return
    with pg.expect_navigation():
        pg.select_option('#lang-sel', code)
    pg.wait_for_selector('nav, .users button')

def nav_click(pg, az):
    pg.get_by_role('navigation').get_by_role('button', name=T(pg, az), exact=True).click()
    pg.wait_for_timeout(250)

def clean(pg, where):
    txt = pg.inner_text('body')
    m = BAD.search(txt)
    check(not m, f'{where}: ekranda "undefined/NaN/{{0}}" yoxdur' + (f' (tapıldı: {txt[max(0, m.start()-30):m.end()+30]!r})' if m else ''))

def close_modals(pg):
    pg.evaluate("() => document.querySelectorAll('.modal-back').forEach(e => e.remove())")

az_nav = None
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        for L in ['az', 'ru', 'en', 'tr']:
            ctx = b.new_context(viewport={'width': 1280, 'height': 800}, timezone_id='Asia/Baku')
            pg = ctx.new_page()
            pg.on('pageerror', lambda e, L=L: errors.append(f'[{L}] JS xətası: {e}'))
            pg.add_init_script('window.print = function(){ window.__printed = (window.__printed||0)+1; };')
            pg.goto(URL); pg.wait_for_selector('.users button')
            check(pg.evaluate("() => I18n.lang()") == 'az', f'[{L}] ilkin dil Azərbaycanca')
            opts = pg.eval_on_selector_all('#lang-sel option', 'els => els.map(e => e.value + ":" + e.textContent)')
            check(opts == ['az:Azərbaycanca', 'ru:Русский', 'en:English', 'tr:Türkçe'], f'[{L}] dil siyahısı: {opts}')
            login_az = pg.inner_text('body')
            to_lang(pg, L)
            check(pg.evaluate("() => document.documentElement.lang") == L, f'[{L}] html lang={L}')
            check(pg.evaluate("() => localStorage.getItem('mag.lang')") == (L if L != 'az' else None), f'[{L}] seçim yaddaşa yazılır')
            login_txt = pg.inner_text('body')
            if L != 'az':
                check(login_txt != login_az, f'[{L}] giriş ekranı tərcümə olunub')
                check(pg.locator('.users').inner_text() != '' and pg.locator('#lang-sel').is_visible(), f'[{L}] giriş ekranında dil seçimi görünür')
            pg.reload(); pg.wait_for_selector('.users button')
            check(pg.evaluate("() => I18n.lang()") == L, f'[{L}] yenilədikdən sonra dil qalır')
            clean(pg, f'[{L}] giriş')
            pg.screenshot(path=f'{OUT}/lang-{L}-login.png')

            # Admin girişi, məcburi PIN dəyişmə
            pg.locator('.users button').first.click()
            pg.fill('#pin', '1234'); pg.keyboard.press('Enter')
            pg.wait_for_selector('#op')
            pg.fill('#op', '1234'); pg.fill('#np1', '4827'); pg.fill('#np2', '4827')
            pg.get_by_role('button', name=T(pg, 'Saxla və davam et'), exact=True).click()
            pg.wait_for_selector('nav')
            nav_labels = pg.eval_on_selector_all('nav button', 'els => els.map(e => e.textContent.trim())')
            if L == 'az':
                az_nav = nav_labels
                check(len(az_nav) >= 6, f'[az] bölmələr: {az_nav}')
            else:
                exp = [T(pg, a) for a in az_nav]
                check(nav_labels == exp, f'[{L}] menyu tərcümə olunub: {nav_labels}')
                check(all(not re.search(r'[əƏ]', x) for x in nav_labels), f'[{L}] menyuda Azərbaycan hərfi qalmayıb')

            # Dil dəyişəndə səhifə yenilənir, amma giriş saxlanılır
            other = 'en' if L != 'en' else 'ru'
            to_lang(pg, other)
            check(pg.locator('.users button').count() == 0 and pg.locator('nav').count() == 1, f'[{L}→{other}] dil dəyişəndə çıxış vermir')
            check('Admin' in pg.inner_text('.status'), f'[{L}→{other}] istifadəçi adı statusda görünür')
            to_lang(pg, L)
            check(pg.locator('nav').count() == 1, f'[{L}] geri qayıdanda da giriş saxlanılıb')

            # Məhsullar, növbə, satış
            nav_click(pg, 'Məhsullar')
            pg.get_by_role('button', name=T(pg, 'Sınaq üçün nümunə məhsullar əlavə et'), exact=True).click()
            pg.wait_for_selector('text=Qız qalası maketi')
            codes = pg.evaluate("() => DB.getAll('products').then(ps => Object.fromEntries(ps.map(p => [p.name, p.storeBarcode])))")
            clean(pg, f'[{L}] məhsullar')
            nav_click(pg, 'Kassa')
            pg.fill('#open-cash', '50,00')
            pg.get_by_role('button', name=T(pg, 'Növbəni aç'), exact=True).click()
            pg.wait_for_selector('#scan')
            for name in ['Konstruktor dəsti, 120 hissə', 'Maqnit «Bakı»']:
                pg.fill('#scan', codes[name]); pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
            total_before = pg.inner_text('.totals .grand b')
            clean(pg, f'[{L}] kassa')

            # Yarımçıq çek dil dəyişəndə itmir
            to_lang(pg, other)
            pg.wait_for_selector('#scan')
            check(pg.inner_text('.totals .grand b') == total_before and pg.locator('tbody tr').count() == 2, f'[{L}→{other}] yarımçıq çek dil dəyişəndə saxlanılır ({total_before})')
            to_lang(pg, L); pg.wait_for_selector('#scan')

            # Çek: interfeys hansı dildədirsə, çek ilkin olaraq Azərbaycanca
            pg.keyboard.press('F1'); pg.wait_for_selector('#pay-cash'); pg.fill('#pay-cash', '100')
            clean(pg, f'[{L}] ödəniş pəncərəsi')
            pg.keyboard.press('Enter'); pg.wait_for_function('window.__printed >= 1')
            rc = pg.inner_text('#print-area')
            check('YEKUN' in rc and 'Qaytarılan' in rc, f'[{L}] çek Azərbaycanca çıxır (çekin dili ayrıdır)')
            check(not CYR.search(rc) or L == 'az', f'[{L}] çekdə kiril yoxdur')
            if L != 'az':
                # Çap ayarlarında çekin dili seçilir
                pg.click('#print-settings'); pg.wait_for_selector('#pr-lang')
                clean(pg, f'[{L}] çap ayarları')
                pg.select_option('#pr-lang', L)
                pg.get_by_role('button', name=T(pg, 'Yadda saxla'), exact=True).first.click()
                pg.wait_for_selector('.modal-back', state='detached')
                check(pg.evaluate("() => Print.settings().receipt.lang") == L, f'[{L}] çekin dili ayarlarda saxlandı')
                for name in ['Konstruktor dəsti, 120 hissə']:
                    pg.fill('#scan', codes[name]); pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
                pg.keyboard.press('F1'); pg.wait_for_selector('#pay-cash'); pg.fill('#pay-cash', '100'); pg.keyboard.press('Enter')
                pg.wait_for_function('window.__printed >= 2')
                rc2 = pg.inner_text('#print-area')
                check(T(pg, 'YEKUN', L) in rc2 and T(pg, 'Qaytarılan@@change', L) in rc2, f'[{L}] çek seçilmiş dildə çıxır ({T(pg, "YEKUN", L)})')
                check('YEKUN' not in rc2, f'[{L}] seçilmiş dildə çekdə Azərbaycanca "YEKUN" qalmayıb')
                pg.screenshot(path=f'{OUT}/lang-{L}-receipt.png')
                pg.evaluate("() => Print.save(Object.assign({}, Print.settings(), { receipt: Object.assign({}, Print.settings().receipt, { lang: 'az' }) }))")

            # Təsdiq pəncərəsi (sətir silmə) və endirim
            for name in ['Maqnit «Bakı»', 'Konstruktor dəsti, 120 hissə']:
                pg.fill('#scan', codes[name]); pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
            pg.locator('tbody tr').first.get_by_role('button', name=T(pg, 'Sətri sil: {0}').split('{0}')[0].strip()).first.click()
            pg.wait_for_selector('#appr-pin')
            clean(pg, f'[{L}] təsdiq pəncərəsi')
            pg.fill('#appr-pin', '1111'); pg.keyboard.press('Enter'); pg.wait_for_selector('.toast.bad')
            toast = pg.inner_text('.toast-host')
            check(not (L != 'az' and re.search(r'[əƏ]', toast)), f'[{L}] PIN xətası tərcümə olunub: {toast!r}')
            close_modals(pg)
            pg.keyboard.press('F4'); pg.wait_for_selector('#disc'); clean(pg, f'[{L}] endirim'); close_modals(pg)
            pg.keyboard.press('F3'); pg.wait_for_selector('#pay-bank'); clean(pg, f'[{L}] qarışıq ödəniş'); close_modals(pg)

            # Bütün bölmələr
            n = pg.locator('nav button').count()
            for i in range(n):
                pg.locator('nav button').nth(i).click(); pg.wait_for_timeout(350)
                label = pg.locator('nav button').nth(i).inner_text().strip()
                clean(pg, f'[{L}] bölmə "{label}"')
                pg.screenshot(path=f'{OUT}/lang-{L}-screen{i}.png')

            # Növbə bölməsi, qaytarma, çeklər
            nav_click(pg, 'Növbə'); pg.wait_for_timeout(300); clean(pg, f'[{L}] növbə')
            nav_click(pg, 'Qaytarma'); pg.wait_for_selector('#rscan')
            rb = pg.evaluate("() => DB.getAll('sales').then(s => s[0].receiptBarcode)")
            pg.fill('#rscan', rb); pg.keyboard.press('Enter'); pg.wait_for_timeout(500); clean(pg, f'[{L}] qaytarma')
            nav_click(pg, 'Çeklər'); pg.wait_for_timeout(300); clean(pg, f'[{L}] çeklər')
            nav_click(pg, 'Təchizatçılar'); pg.wait_for_timeout(300); clean(pg, f'[{L}] təchizatçılar')
            nav_click(pg, 'İcazələr'); pg.wait_for_selector('#user-add'); clean(pg, f'[{L}] icazələr')
            if pg.locator('#notify-btn').count():
                pg.click('#notify-btn'); pg.wait_for_selector('#nt-out'); clean(pg, f'[{L}] bildiriş pəncərəsi'); close_modals(pg)

            # Dar ekran (telefon): mətn uzandıqca səhifə yana sürüşməməlidir
            pg.set_viewport_size({'width': 390, 'height': 800})
            for az_name in ['Kassa', 'Məhsullar', 'Qaytarma', 'Növbə']:
                nav_click(pg, az_name); pg.wait_for_timeout(300)
                wd = pg.evaluate("() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]")
                culprits = '' if wd[0] <= wd[1] + 2 else pg.evaluate("""() => { const W = document.documentElement.clientWidth; const bad = Array.from(document.querySelectorAll('body *')).filter(e => { const r = e.getBoundingClientRect(); return r.right > W + 1 && r.width > 0 && !e.closest('.table-wrap, .scroll-x, table'); }); return bad.slice(0, 6).map(e => e.tagName + '.' + e.className + '#' + e.id + ' ' + Math.round(e.getBoundingClientRect().right)).join(' | '); }""")
                check(wd[0] <= wd[1] + 2, f'[{L}] 390 px ekranda "{az_name}" yana sürüşmür ({wd}) {culprits}')
            pg.screenshot(path=f'{OUT}/lang-{L}-phone.png')

            if L != 'az':
                miss = pg.evaluate("() => I18n.missing()")
                check(miss == [], f'[{L}] tərcüməsiz mətn qalmayıb: {miss[:10]}')
            ctx.close()
        b.close()
finally:
    srv.terminate()

print(f'{len(ok)} keçdi, {len(errors)} uğursuz')
for e in errors: print('✗', e)
sys.exit(1 if errors else 0)
