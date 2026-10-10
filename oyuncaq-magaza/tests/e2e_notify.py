"""Bildiriş yoxlaması real Chromium-da: service worker qeydiyyatı, push hadisəsi (CDP ilə çatdırılır), bildirişin ikon/badge/mətni,
ikon fayllarının əlçatanlığı, "Bildiriş" pəncərəsi. Real FCM/Apple push xidməti sandbox-dan əlçatmazdır, ona görə abunə (pushManager.subscribe)
və serverdən real push BURADA yoxlanmır — server tərəfi tests/push.test.js-də, abunə məntiqi tests/notify.test.js-də yoxlanır.
İşə salmaq: python3 tests/e2e_notify.py"""
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright


def wf(pg, expr, timeout=30000):
    """wait_for_function sətri eval ilə işlədir, CSP (script-src 'self') isə eval-ı qadağan edir; ona görə ifadə evaluate ilə dövri yoxlanılır."""
    t0 = time.time()
    while (time.time() - t0) * 1000 < timeout:
        if pg.evaluate('() => !!(' + expr + ')'): return
        pg.wait_for_timeout(50)
    raise TimeoutError('gözlənilən şərt yerinə yetmədi: ' + expr[:100])

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get('SHOTS', '/tmp/shots'); os.makedirs(OUT, exist_ok=True)
PORT = 8768
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
ok, errors = [], []
def check(c, m): (ok if c else errors).append(m)
URL = f'http://localhost:{PORT}/index.html'

try:
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chromium')   # tam Chromium (headless-shell bildiriş icazəsini dəstəkləmir)
        ctx = b.new_context(viewport={'width': 1200, 'height': 800}, timezone_id='Asia/Baku', permissions=['notifications'])
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('JS xətası: ' + str(e)))
        pg.on('console', lambda m: errors.append('CSP pozuntusu: ' + m.text[:200]) if 'Content Security Policy' in m.text else None)
        pg.goto(URL)
        pg.wait_for_selector('.users button')

        # İkonlar əlçatandır və düzgün PNG-dir
        for f, size in [('icons/icon-192.png', (192, 192)), ('icons/icon-512.png', (512, 512)), ('icons/icon-maskable-512.png', (512, 512)), ('icons/badge-96.png', (96, 96)), ('icons/apple-touch-icon.png', (180, 180))]:
            r = pg.evaluate("""async (f) => { const r = await fetch(f); const b = await createImageBitmap(await r.blob()); return [r.status, r.headers.get('content-type'), b.width, b.height]; }""", f)
            check(r[0] == 200 and r[1] == 'image/png' and (r[2], r[3]) == size, f'{f}: PNG {size[0]}x{size[1]} yüklənir ({r})')
        man = pg.evaluate("() => fetch('manifest.json').then(r => r.json())")
        srcs = {i['src']: i for i in man['icons']}
        check('icons/icon-192.png' in srcs and 'icons/icon-512.png' in srcs and srcs['icons/icon-maskable-512.png']['purpose'] == 'maskable', 'manifest PNG ikonları və maskable ikonu elan edir')
        # badge: şəffaf fon üzərində ağ siluet (rəngli piksel və ya tam qeyri-şəffaf kvadrat olmamalıdır)
        stat = pg.evaluate("""async () => { const bm = await createImageBitmap(await (await fetch('icons/badge-96.png')).blob()); const c = new OffscreenCanvas(96, 96); const g = c.getContext('2d'); g.drawImage(bm, 0, 0);
          const d = g.getImageData(0, 0, 96, 96).data; let opaque = 0, clear = 0, colored = 0; for (let i = 0; i < d.length; i += 4) { if (d[i+3] > 200) { opaque++; if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) colored++; } if (d[i+3] < 10) clear++; } return { opaque, clear, colored, total: 96*96 }; }""")
        check(stat['colored'] == 0 and 0.15 < stat['opaque'] / stat['total'] < 0.6 and stat['clear'] / stat['total'] > 0.4, f'badge: şəffaf fonda ağ siluet, boş kvadrat deyil ({stat})')

        # Service worker qeydiyyatı (tətbiq özü yalnız https-də qeydiyyat edir; localhost təhlükəsiz kontekstdir)
        cdp = ctx.new_cdp_session(pg)
        regs = {}
        cdp.on('ServiceWorker.workerRegistrationUpdated', lambda e: regs.update({r['scopeURL']: r['registrationId'] for r in e['registrations']}))
        cdp.send('ServiceWorker.enable')
        pg.evaluate("() => navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => 1)")
        wf(pg, "navigator.serviceWorker.controller !== undefined || true")
        time.sleep(1)
        rid = regs.get(f'http://localhost:{PORT}/')
        check(rid is not None, f'service worker qeydiyyatdadır (registrationId={rid})')

        # Push hadisəsi: tətbiq pəncərəsi başqa tab arxasında olsun deyə ikinci səhifəni önə çıxarırıq
        pg2 = ctx.new_page(); pg2.goto('about:blank'); pg2.bring_to_front()
        time.sleep(0.5)
        cdp.send('ServiceWorker.deliverPushMessage', {'origin': f'http://localhost:{PORT}', 'registrationId': rid, 'data': ''})
        got = []
        for _ in range(30):
            got = pg.evaluate("() => navigator.serviceWorker.ready.then(r => r.getNotifications()).then(l => l.map(n => ({ title: n.title, body: n.body, icon: n.icon, badge: n.badge, tag: n.tag, requireInteraction: n.requireInteraction, data: n.data })))")
            if got: break
            time.sleep(0.3)
        check(len(got) == 1, f'push hadisəsi bildiriş yaradır ({len(got)})')
        if got:
            n = got[0]
            check(n['title'] == 'Təsdiq sorğusu' and 'təsdiqi gözlənilir' in n['body'], f'bildirişin mətni: {n["title"]!r} / {n["body"]!r}')
            check(n['icon'].endswith('/icons/icon-192.png') and n['badge'].endswith('/icons/badge-96.png'), f'ikon və badge göstərilib ({n["icon"].split("/")[-1]}, {n["badge"].split("/")[-1]})')
            check(n['tag'] == 'approval' and n['requireInteraction'] is True, 'tag və requireInteraction')
            check(n['data'].get('url', '').endswith('#approvals'), 'klikdə təsdiq sorğularına yönləndirmə ünvanı var')
        # Təkrar push eyni tag ilə əvəzlənir (bildiriş yığılmır)
        cdp.send('ServiceWorker.deliverPushMessage', {'origin': f'http://localhost:{PORT}', 'registrationId': rid, 'data': ''})
        time.sleep(1.0)
        cnt = pg.evaluate("() => navigator.serviceWorker.ready.then(r => r.getNotifications()).then(l => l.length)")
        check(cnt == 1, f'təkrar push eyni tag ilə əvəz edir, yığılmır ({cnt})')

        # Tətbiq: menecer kimi daxil ol → "Bildiriş" düyməsi və pəncərə
        pg.bring_to_front()
        pg.get_by_role('button', name='Menecer Menecer').click()
        pg.fill('#pin', '2222'); pg.keyboard.press('Enter')
        pg.wait_for_selector('nav, #op', timeout=10000)
        if pg.locator('#op').count():                      # ilk giriş: məcburi yeni PIN
            pg.fill('#op', '2222'); pg.fill('#np1', '4827'); pg.fill('#np2', '4827'); pg.get_by_role('button', name='Saxla və davam et').click(); pg.wait_for_selector('nav')
        pg.wait_for_selector('#notify-btn')
        check(True, 'menecerdə "Bildiriş" düyməsi var')
        pg.click('#notify-btn'); pg.wait_for_selector('#nt-out')
        txt = pg.inner_text('.modal')
        check('Brauzer icazəsi verilib' in txt, 'pəncərədə icazə vəziyyəti göstərilir')
        check(pg.locator('#nt-on').count() == 1 and pg.locator('#nt-test').count() == 0, '"Aktiv et" düyməsi var, abunə olmayanda "Test" yoxdur')
        pg.screenshot(path=f'{OUT}/10-notify-modal.png')
        # Server qoşulmayıbsa "Aktiv et" aydın xəta verir və cihazı "aktiv" saxlamır
        pg.click('#nt-on'); pg.wait_for_selector('#nt-out >> text=Əvvəl serveri qoşun')
        check(pg.evaluate("() => JSON.parse(localStorage.getItem('mag.notify') || '{}').on !== true"), 'server qoşulmayıbsa aktivləşdirmə uğursuzdur və cihaz "aktiv" qalmır')
        check(pg.locator('#nt-on').is_enabled(), '"Aktiv et" düyməsi xətadan sonra yenidən aktivdir')
        pg.keyboard.press('Escape')

        # Pəncərə arxa plandadır və yeni təsdiq sorğusu gəlir: səhifə özü sistem bildirişi göstərir (push lazım deyil)
        pg.evaluate("() => { localStorage.setItem('mag.notify', JSON.stringify({ on: true })); }")
        pg.evaluate("() => App.refreshStatus()"); time.sleep(0.5)
        pg.evaluate("() => navigator.serviceWorker.ready.then(r => r.getNotifications()).then(l => l.forEach(n => n.close()))")
        pg.evaluate("() => Object.defineProperty(document, 'hidden', { value: true, configurable: true })")
        pg.evaluate("""() => DB.put('approvals', { id: 'ap_t1', kind: 'line_delete', perm: 'pos.line.delete', summary: 'Elvin Babayev sətir silmək istəyir: Yumşaq ayı', requestedBy: { id: 'u_kassir', name: 'Kassir', role: 'kassir' },
          at: new Date().toISOString(), status: 'pending', device: 'baska' }).then(() => App.refreshStatus())""")
        loc = []
        for _ in range(30):
            loc = pg.evaluate("() => navigator.serviceWorker.ready.then(r => r.getNotifications()).then(l => l.map(n => ({ title: n.title, body: n.body, icon: n.icon, badge: n.badge })))")
            if loc: break
            time.sleep(0.2)
        check(len(loc) == 1 and 'Yumşaq ayı' in loc[0]['body'] and loc[0]['icon'].endswith('icon-192.png') and loc[0]['badge'].endswith('badge-96.png'),
              f'arxa plandakı pəncərədə yeni sorğu üçün yerli bildiriş ikon+badge ilə göstərilir ({loc})')
        pg.evaluate("() => { delete document.hidden; }")
        pg.evaluate("() => navigator.serviceWorker.ready.then(r => r.getNotifications()).then(l => l.forEach(n => n.close()))")
        pg.evaluate("() => DB.put('approvals', { id: 'ap_t2', kind: 'line_delete', perm: 'pos.line.delete', summary: 'ikinci', requestedBy: { id: 'u_kassir', name: 'Kassir', role: 'kassir' }, at: new Date().toISOString(), status: 'pending', device: 'baska' }).then(() => App.refreshStatus())")
        time.sleep(1.0)
        n2 = pg.evaluate("() => navigator.serviceWorker.ready.then(r => r.getNotifications()).then(l => l.length)")
        check(n2 == 0, 'pəncərə ekrandadırsa sistem bildirişi göstərilmir (səhifənin öz xəbərdarlığı var)')
        pg.evaluate("() => localStorage.removeItem('mag.notify')")
        # Kassirdə düymə yoxdur
        pg.get_by_role('button', name='Çıxış').click(); pg.wait_for_selector('.users button')
        pg.get_by_role('button', name='Kassir Kassir').click()
        pg.fill('#pin', '1111'); pg.keyboard.press('Enter'); pg.wait_for_selector('nav, #op', timeout=10000)
        if pg.locator('#op').count():
            pg.fill('#op', '1111'); pg.fill('#np1', '7391'); pg.fill('#np2', '7391'); pg.get_by_role('button', name='Saxla və davam et').click(); pg.wait_for_selector('nav')
        check(pg.locator('#notify-btn').count() == 0, 'kassirdə "Bildiriş" düyməsi yoxdur')
        b.close()
finally:
    srv.terminate()

for m in ok: print('✓', m)
for m in errors: print('✗', m)
print(f'\n{len(ok)} keçdi, {len(errors)} uğursuz')
sys.exit(1 if errors else 0)
