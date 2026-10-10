"""Barkod skaneri (klaviatura kimi sürətli yazır) və ikiqat basma: real klaviatura hadisələri ilə. İşə salmaq: python3 tests/e2e_scanner.py
Yoxlanır: sürətli skan, eyni məhsulun ardıcıl skanı (say), fokus başqa yerdə olanda skan, nağd sahəsinə düşən skan, "Enter"-in iki dəfə basılması (təkrar satış olmamalıdır)."""
import subprocess, time, sys, os, json, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = 8773
web = subprocess.Popen([sys.executable, '-m', 'http.server', str(WEB), '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
errors, ok = [], []
def check(cond, msg): (ok if cond else errors).append(msg)

def cart(pg):
    return pg.evaluate("() => POS._state().cart.map(c => [c.product.name, c.qty])")

def sales(pg):
    return pg.evaluate("() => DB.getAll('sales').then(s => s.length)")

def scan(pg, code, delay=2):
    """Skaner kimi: hər rəqəm arası `delay` ms, sonda Enter"""
    pg.keyboard.type(code, delay=delay); pg.keyboard.press('Enter')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Baku')
        ctx.add_init_script('window.__printed = 0; window.print = function(){ window.__printed++; };')
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('JS xətası: ' + str(e)))
        pg.on('console', lambda m: errors.append('CSP pozuntusu: ' + m.text[:200]) if 'Content Security Policy' in m.text else None)
        pg.goto(f'http://localhost:{WEB}/index.html'); pg.wait_for_selector('.users button')
        pg.get_by_role('button', name='Admin Admin').click(); pg.fill('#pin', '1234'); pg.keyboard.press('Enter'); pg.wait_for_selector('#op')
        pg.fill('#op', '1234'); pg.fill('#np1', '4827'); pg.fill('#np2', '4827'); pg.get_by_role('button', name='Saxla və davam et').click(); pg.wait_for_selector('nav')
        pg.evaluate("() => Services.seedDemoProducts()"); pg.wait_for_timeout(300)
        codes = pg.evaluate("() => DB.getAll('products').then(ps => ps.map(p => [p.name, p.storeBarcode, p.mfrBarcode]))")
        a, bb, c = codes[0], codes[1], codes[2]
        pg.get_by_role('navigation').get_by_role('button', name='Kassa', exact=True).click()
        pg.fill('#open-cash', '50'); pg.get_by_role('button', name='Növbəni aç').click(); pg.wait_for_selector('#scan')

        # 1. sürətli skan
        check(pg.evaluate("() => document.activeElement.id") == 'scan', 'növbə açılandan sonra fokus skan sahəsindədir')
        scan(pg, a[1], delay=2); pg.wait_for_timeout(200)
        check(cart(pg) == [[a[0], 1]], f'sürətli skan (2 ms/rəqəm): bir sətir əlavə olundu {cart(pg)}')
        # 2. eyni məhsul 10 dəfə ardıcıl, gözləmədən
        for _ in range(9): scan(pg, a[1], delay=1)
        pg.wait_for_timeout(400)
        check(cart(pg) == [[a[0], 10]], f'10 ardıcıl skan = say 10 (itən/təkrar rəqəm yoxdur) {cart(pg)}')
        # 3. fərqli məhsullar ardıcıl
        scan(pg, bb[1], delay=1); scan(pg, c[1], delay=1); pg.wait_for_timeout(300)
        names = [x[0] for x in cart(pg)]
        check(names == [a[0], bb[0], c[0]], f'fərqli məhsullar sıra ilə: {names}')
        # 4. tanınmayan və istehsalçı barkodu: xəta mesajı, çökmə yoxdur
        scan(pg, '9999999999994'); pg.wait_for_timeout(200)
        check('tapılmadı' in pg.inner_text('#scan-msg'), 'tanınmayan barkod: «Barkod tapılmadı» mesajı')
        mfr = next((x for x in codes if x[2]), None)
        if mfr:
            scan(pg, mfr[2]); pg.wait_for_timeout(200)
            check('istehsalçı' in pg.inner_text('#scan-msg').lower(), f'istehsalçı barkodu: izahat mesajı ({pg.inner_text("#scan-msg")[:60]})')
        check(len(cart(pg)) == 3, 'səhv skanlar səbəti dəyişmir')

        # 5. fokus heç yerdə deyil (kassir boş yerə klik edib): skaner yazanda barkod itməməlidir
        pg.evaluate("() => { if (document.activeElement) document.activeElement.blur(); }")
        pg.wait_for_timeout(100)
        focus_before = pg.evaluate("() => document.activeElement.tagName + '#' + document.activeElement.id")
        before = [x[1] for x in cart(pg)]
        scan(pg, a[1], delay=2); pg.wait_for_timeout(300)
        after = [x[1] for x in cart(pg)]
        check(after[0] == before[0] + 1, f'fokus skan sahəsindən çıxıbsa da (fokus: {focus_before}) skan sətrə əlavə olunur: {before} → {after}')
        # 5a. fokus düymədədir ("+" düyməsinə klik edilib), sonra skan
        pg.locator('button', has_text='+').first.click(); pg.wait_for_timeout(100)
        focus_btn = pg.evaluate("() => document.activeElement.tagName")
        before = [x[1] for x in cart(pg)]
        scan(pg, bb[1], delay=2); pg.wait_for_timeout(300)
        after = [x[1] for x in cart(pg)]
        check(after[1] == before[1] + 1, f'fokus düymədə ({focus_btn}) olanda skan sətrə əlavə olunur (Enter düyməni basıb setri dəyişmir): {before} → {after}')
        # 5b. fokus düymədədir (Nağd düyməsinə klik edilib, sonra Esc ilə ödəniş panelindən çıxılıb)
        pg.keyboard.press('F1'); pg.wait_for_selector('#pay-cash'); pg.wait_for_timeout(100)
        # 6. skan nağd sahəsinə düşür (kassir ödəniş paneli açıq olanda növbəti məhsulu skan edir)
        pg.fill('#pay-cash', '')
        cash_items = [x[1] for x in cart(pg)]
        scan(pg, c[1], delay=2); pg.wait_for_timeout(300)
        cash_val = pg.input_value('#pay-cash')
        check(len(cash_val.replace(',', '').replace('.', '')) < 8, f'skan nağd sahəsinə yazılmadı (sahə: «{cash_val}»)')
        check(cart(pg)[2][1] == cash_items[2] + 1, f'ödəniş sahəsindən skan edilən məhsul sətrə əlavə olundu: {cart(pg)}')

        # 7. ikiqat Enter: yalnız bir satış
        n0 = sales(pg)
        total = pg.evaluate("() => POS._state().cart.reduce((s, c) => s + c.qty * c.product.price, 0)")
        pg.fill('#pay-cash', '100000')
        pg.keyboard.press('Enter'); pg.keyboard.press('Enter'); pg.keyboard.press('Enter')
        pg.wait_for_timeout(1500)
        n1 = sales(pg)
        check(n1 == n0 + 1, f'Enter 3 dəfə basıldı: yalnız 1 çek yarandı ({n0} → {n1})')
        check(pg.evaluate("() => window.__printed") == 1, 'çek bir dəfə çap olundu')
        check(pg.evaluate("() => document.activeElement.id") == 'scan', 'satışdan sonra fokus skan sahəsinə qayıdır')
        check(cart(pg) == [], 'satışdan sonra səbət təmizdir')

        # 8. ödəniş düyməsinə ikiqat klik
        scan(pg, a[1]); pg.wait_for_timeout(200)
        pg.keyboard.press('F1'); pg.wait_for_selector('#pay-cash'); pg.fill('#pay-cash', '100000')
        btn = pg.locator('button.btn.dark', has_text='Təsdiqlə')
        btn.dblclick(); pg.wait_for_timeout(1500)
        check(sales(pg) == n1 + 1, f'ödəniş düyməsinə ikiqat klik: yalnız 1 çek ({n1} → {sales(pg)})')
        recs = pg.evaluate("() => DB.getAll('sales').then(s => s.map(x => x.receiptNo).sort((x, y) => x - y))")
        check(recs == list(range(1, len(recs) + 1)), f'çek nömrələri ardıcıl və təkrarsızdır: {recs}')

        # 9. satış sonrası dərhal skan (kassir növbəti müştəriyə keçir)
        scan(pg, bb[1], delay=1); pg.wait_for_timeout(200)
        check(cart(pg) == [[bb[0], 1]], 'satışdan dərhal sonrakı skan yeni səbətə düşür')
        ctx.close(); b.close()
finally:
    web.terminate()

print('\n'.join('✓ ' + m for m in ok))
if errors: print('\n'.join('✗ ' + m for m in errors))
print(f'\n{len(ok)} keçdi, {len(errors)} uğursuz')
sys.exit(1 if errors else 0)
