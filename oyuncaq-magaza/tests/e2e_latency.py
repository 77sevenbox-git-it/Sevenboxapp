"""Real Apps Script gecikməsi ilə iki ayrı brauzer: cihazlar arası gecikmə, təsdiq sorğusu, yazı zamanı UI-nin donması,
təsadüfi xətalar və ilişmiş sorğu. Gecikmə modeli real bazadan ölçülüb (yazma ≈ 2,3 san, uzun quyruq 5–6 san).
İşə salmaq:  python3 tests/e2e_latency.py            (APP_ROOT=başqa qovluq ilə köhnə versiyanı da ölçmək olar)
Nəticə: hər ssenari üçün saniyə ilə ölçülər; sonda keçdi/uğursuz. Əsl saniyələrlə işləyir, ~4–6 dəqiqə çəkir."""
import asyncio, json, os, random, statistics, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.environ.get('APP_ROOT', ROOT)
WEB = int(os.environ.get('WEB_PORT', '8771')); MOCK = int(os.environ.get('MOCK_PORT', '8791'))
SCALE = float(os.environ.get('LAT_SCALE', '1'))            # 1 = real gecikmə
URL = 'https://script.google.com/macros/s/AKfycbLAT/exec'; TOKEN = 'e2e-token'
random.seed(int(os.environ.get('SEED', '7')))

web = subprocess.Popen([sys.executable, '-m', 'http.server', str(WEB), '-d', APP], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
gas = subprocess.Popen(['node', os.path.join(ROOT, 'tests', 'gas-server.js'), str(MOCK)], stdout=subprocess.PIPE)
gas.stdout.readline()
t_start = time.time()
errors, ok, notes = [], [], []
reqlog = []          # (vaxt, cihaz, növ, müddət, nəticə)


def check(cond, msg):
    (ok if cond else errors).append(msg)
    print(('  ✓ ' if cond else '  ✗ ') + msg, flush=True)


def note(msg):
    notes.append(msg); print('  · ' + msg, flush=True)


def rows(sheet):
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{MOCK}/__rows/{sheet}').read())


class Net:
    """Apps Script gecikmə və xəta modeli."""
    write = (2.3, 0.5)       # orta, yayılma (san): hadisə daşıyan sorğu
    poll = (1.6, 0.4)        # boş yoxlama
    tail_p, tail = 0.08, (3.0, 6.0)
    fail_p = 0.0
    hang = {}                # cihaz -> neçə sorğu ilişsin

    @classmethod
    def delay(cls, is_poll):
        m, j = cls.poll if is_poll else cls.write
        d = max(0.4, random.gauss(m, j))
        if random.random() < cls.tail_p: d += random.uniform(*cls.tail)
        return d * SCALE


def forward(method, body):
    req = urllib.request.Request(f'http://127.0.0.1:{MOCK}/', data=body.encode() if body else None, method=method)
    return urllib.request.urlopen(req).read()


def make_proxy(label):
    async def proxy(route, request):
        t0 = time.time()
        body = request.post_data
        kind = 'GET'
        if request.method == 'POST':
            j = json.loads(body); kind = j.get('action')
            if kind == 'sync': kind = 'poll' if (not j.get('items') and not j.get('alloc')) else 'push'
        try:
            if Net.hang.get(label, 0) > 0 and kind in ('poll', 'push'):
                Net.hang[label] -= 1
                reqlog.append((t0 - t_start, label, kind, 0, 'ilişdi'))
                await asyncio.sleep(120 * SCALE)
                return await route.abort('failed')
            d = Net.delay(kind == 'poll')
            r = random.random()
            if r < Net.fail_p:
                await asyncio.sleep(d)
                mode = random.choice(['html', '500', 'abort'])
                reqlog.append((t0 - t_start, label, kind, d, mode))
                if mode == 'abort': return await route.abort('failed')
                if mode == 'html':
                    return await route.fulfill(status=200, body='<html><body>Service invoked too many times</body></html>', headers={'access-control-allow-origin': '*', 'content-type': 'text/html'})
                return await route.fulfill(status=500, body='error', headers={'access-control-allow-origin': '*'})
            await asyncio.sleep(d * 0.6)                 # server işləyir
            out = await asyncio.to_thread(forward, request.method, body)
            await asyncio.sleep(d * 0.4)                 # cavab geri qayıdır
            reqlog.append((t0 - t_start, label, kind, time.time() - t0, 'ok'))
            await route.fulfill(status=200, body=out, headers={'access-control-allow-origin': '*', 'content-type': 'application/json'})
        except Exception:
            pass                                          # brauzer sorğunu dayandırıb
    return proxy


async def wait_until(fn, timeout=60, step=0.2):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if await fn(): return time.time() - t0
        await asyncio.sleep(step)
    return None


class Dev:
    def __init__(self, label, page): self.label, self.pg = label, page

    async def ev(self, js): return await self.pg.evaluate(js)

    async def login(self, name, pin):
        await self.pg.get_by_role('button', name=f'{name} {name}').click()
        await self.pg.fill('#pin', pin); await self.pg.keyboard.press('Enter')

    async def set_pin(self, old, new):
        await self.pg.wait_for_selector('#op')
        await self.pg.fill('#op', old); await self.pg.fill('#np1', new); await self.pg.fill('#np2', new)
        await self.pg.get_by_role('button', name='Saxla və davam et').click()
        await self.pg.wait_for_selector('nav')

    async def logout(self):
        await self.pg.get_by_role('button', name='Çıxış').click()
        await self.pg.wait_for_selector('.users button')

    async def nav(self, name): await self.pg.get_by_role('navigation').get_by_role('button', name=name).click()

    async def count(self, store): return await self.ev(f"DB.getAll('{store}').then(x => x.length)")

    async def stock(self, prefix):
        return await self.ev(f"DB.getAll('products').then(ps => {{ const x = ps.find(q => q.name.startsWith('{prefix}')); return x ? x.stock : null; }})")


async def open_dev(browser, label):
    ctx = await browser.new_context(viewport={'width': 1366, 'height': 800}, timezone_id='Asia/Baku')
    await ctx.route('https://script.google.com/**', make_proxy(label))
    await ctx.add_init_script('window.print = function(){};')
    pg = await ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(f'JS xətası ({label}): {e} :: ' + str(getattr(e, "stack", ""))[:600]))
    await pg.goto(f'http://localhost:{WEB}/index.html')
    await pg.wait_for_selector('.users button')
    return Dev(label, pg)


async def connect(d):
    await d.pg.click('#connect-btn')
    await d.pg.fill('#c-url', URL); await d.pg.fill('#c-tok', TOKEN)
    t0 = time.time()
    await d.pg.get_by_role('button', name='Qoş və yüklə').click()
    await d.pg.wait_for_selector('.modal-back', state='detached', timeout=120000)
    return time.time() - t0


def stats(xs):
    xs = sorted(xs)
    return f'orta {statistics.mean(xs):.1f} · median {statistics.median(xs):.1f} · ən pis {xs[-1]:.1f} san (n={len(xs)})'


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()

        print('\n== 0. Qoşulma və ilkin quraşdırma ==', flush=True)
        K = await open_dev(b, 'Kassa'); M = await open_dev(b, 'Menecer')
        tc = await connect(K); note(f'1-ci brauzer qoşulma: {tc:.1f} san')
        await K.login('Admin', '1234'); await K.set_pin('1234', '4827')
        await K.nav('Məhsullar'); await K.pg.get_by_role('button', name='Sınaq üçün nümunə məhsullar əlavə et').click()
        await K.pg.wait_for_selector('text=Qız qalası maketi')
        await K.logout(); await K.login('Kassir', '1111'); await K.set_pin('1111', '5530')
        t_conn2 = await connect(M); note(f'2-ci brauzer qoşulma (bütün məlumatı çəkir): {t_conn2:.1f} san')
        await M.login('Menecer', '2222'); await M.set_pin('2222', '6149')
        check(await wait_until(lambda: _all5(M), 60) is not None, '2-ci brauzerdə 5 məhsul var')
        await K.nav('Kassa'); await K.pg.fill('#open-cash', '20,00'); await K.pg.get_by_role('button', name='Növbəni aç').click(); await K.pg.wait_for_selector('#scan')
        codes = await K.ev("DB.getAll('products').then(ps => Object.fromEntries(ps.map(p => [p.name, p.storeBarcode])))")
        magnet = codes['Maqnit «Bakı»']; puzzle = codes['Puzzl 500 hissə']
        await M.nav('Çeklər')

        print('\n== 1. Kassadan menecerə: satış → 2-ci brauzerdə görünmə ==', flush=True)
        lags, ui_lags = [], []
        for i in range(5):
            await asyncio.sleep(random.uniform(4, 11))             # real istifadə: satışlar arası fasilə
            before = await M.count('sales')
            await K.pg.fill('#scan', magnet); await K.pg.keyboard.press('Enter')
            await K.pg.wait_for_selector('tbody tr .mono')
            await K.pg.keyboard.press('F1'); await K.pg.wait_for_selector('#pay-cash')
            await K.pg.fill('#pay-cash', '10'); await K.pg.keyboard.press('Enter')
            await K.pg.wait_for_function("document.querySelector('#scan-msg').textContent.includes('tamamlandı')")
            t0 = time.time()
            lag = await wait_until(lambda: _gt(M, 'sales', before), 90)
            lags.append(lag if lag is not None else 90)
            ui = await wait_until(lambda: _rows(M, before + 1), 30)
            ui_lags.append((time.time() - t0) if ui is not None else 120)
        note('satış → menecerin bazasında: ' + stats(lags))
        note('satış → menecerin çek siyahısında: ' + stats(ui_lags))
        check(max(lags) < 30, f'ən pis halda belə 30 san-dən tez ({max(lags):.1f} san)')

        print('\n== 2. Menecerdən kassaya: mal qəbulu → kassanın qalığı ==', flush=True)
        await M.nav('Məhsullar'); await M.pg.wait_for_selector('text=Puzzl 500 hissə')
        s0 = await K.stock('Puzzl')
        await M.pg.locator('tbody tr', has_text='Puzzl').get_by_role('button', name='Qəbul').click()
        await M.pg.fill('#r-qty', '5'); await M.pg.get_by_role('button', name='Qəbul et').click()
        await M.pg.wait_for_selector('text=Etiket çapı'); await M.pg.get_by_role('button', name='Bağla').click()
        t0 = time.time()
        lag = await wait_until(lambda: _stock(K, 'Puzzl', s0 + 5), 90)
        check(lag is not None, f'menecerin qəbul etdiyi mal kassada görünür ({(time.time()-t0):.1f} san)')

        print('\n== 3. Təsdiq sorğusu: kassir göndərir → menecer təsdiqləyir → kassir davam edir ==', flush=True)
        await K.pg.fill('#scan', magnet); await K.pg.keyboard.press('Enter')
        await K.pg.fill('#scan', puzzle); await K.pg.keyboard.press('Enter')
        await K.pg.locator('tbody tr', has_text='Puzzl').get_by_role('button', name='Sətri sil').click()
        await K.pg.wait_for_selector('#appr-pin')
        t_req = time.time()
        await K.pg.get_by_role('button', name='Menecerə sorğu göndər').click()
        lat = await wait_until(lambda: _count(M.pg.get_by_role('button', name='Sorğular (1)'), 1), 90)
        check(lat is not None, f'sorğu menecerin ekranına çatdı: {time.time()-t_req:.1f} san')
        await M.pg.get_by_role('button', name='Sorğular (1)').click(); await M.pg.get_by_role('button', name='Təsdiqlə').first.click()
        t_dec = time.time()
        lat2 = await wait_until(lambda: _count(K.pg.locator('tbody tr', has_text='Puzzl'), 0), 90)
        note(f'təsdiqdən sonra kassirin ekranı: {time.time()-t_dec:.1f} san; ümumi (sorğu → davam): {time.time()-t_req:.1f} san')
        check(lat2 is not None, 'kassir təsdiqi aldı')
        await M.pg.get_by_role('button', name='Bağla').click()

        print('\n== 4. Yazı zamanı UI: sinxron gələndə kassada yığılan barkod itmir, ekran donmur ==', flush=True)
        await K.pg.evaluate("document.querySelector('#scan').value = ''")     # fill('') Playwright-da Delete düyməsi basır (sətri silmə pəncərəsi açır)
        half = puzzle[:7]
        await K.pg.focus('#scan'); await K.pg.keyboard.type(half, delay=30)
        # menecer eyni anda hadisə yaradır; kassirin tərəfində tətbiq olunana qədər yığılan hissə qalmalıdır
        before = await K.stock('Puzzl')
        await M.pg.locator('tbody tr', has_text='Puzzl').get_by_role('button', name='Qəbul').click()
        await M.pg.fill('#r-qty', '1'); await M.pg.get_by_role('button', name='Qəbul et').click()
        await M.pg.wait_for_selector('text=Etiket çapı'); await M.pg.get_by_role('button', name='Bağla').click()
        await wait_until(lambda: _stock(K, 'Puzzl', before + 1), 90)
        got = await K.pg.input_value('#scan'); focused = await K.ev("document.activeElement && document.activeElement.id")
        check(got == half, f'sinxron gələndə yazılmış barkod hissəsi itmədi ("{got}")')
        check(focused == 'scan', f'sinxron gələndə fokus barkod xanasında qaldı ("{focused}")')
        await K.pg.keyboard.type(puzzle[7:], delay=30); await K.pg.keyboard.press('Enter')
        # ekran cavabdehliyi: 12 skan
        t0 = time.time(); times = []
        for i in range(12):
            ts = time.time()
            await K.pg.fill('#scan', magnet); await K.pg.keyboard.press('Enter')
            await K.pg.wait_for_function("document.querySelector('#scan').value === ''")
            times.append(time.time() - ts)
        note('12 skan: ' + stats(times))
        check(max(times) < 1.0, f'skan hər dəfə 1 san-dən tez ({max(times):.2f} san)')

        print('\n== 5. Xətalı şəbəkə: 15% xəta (HTML, 500, kəsilmə) + 1 ilişmiş sorğu ==', flush=True)
        await K.pg.evaluate('POS.reset()'); await K.nav('Kassa'); await K.pg.wait_for_selector('#scan')   # yarımçıq çeki təmizlə
        Net.fail_p = 0.15; Net.hang['Kassa'] = 1
        base_sales = len(rows('Sales'))
        for i in range(5):
            await asyncio.sleep(random.uniform(1, 4))
            await K.pg.fill('#scan', codes['Qız qalası maketi']); await K.pg.keyboard.press('Enter')
            await K.pg.wait_for_selector('tbody tr .mono')
            await K.pg.keyboard.press('F1'); await K.pg.wait_for_selector('#pay-cash')
            await K.pg.fill('#pay-cash', '500'); await K.pg.keyboard.press('Enter')
            await K.pg.wait_for_function("document.querySelector('#scan-msg').textContent.includes('tamamlandı')")
        t0 = time.time()
        k_sales = await K.count('sales')
        conv = await wait_until(lambda: _count_sales_rows(base_sales + 5), 180)
        Net.fail_p = 0.0
        note('xəta rejimində 5 satışın hamısı bazaya çatdı: ' + (f'{time.time()-t0:.1f} san sonra' if conv else 'ÇATMADI'))
        check(conv is not None, '5 satışın hamısı xətalara baxmayaraq bazaya yazıldı')
        await asyncio.sleep(12)
        check(len(rows('Sales')) == base_sales + 5, f'dublikat yoxdur (Sales={len(rows("Sales"))}, gözlənilən {base_sales + 5})')
        ids = [r[0] for r in rows('Sales')]
        check(len(ids) == len(set(ids)), 'çek id-ləri təkrarlanmır')
        nos = [r[1] for r in rows('Sales')]
        check(len(nos) == len(set(nos)), 'çek nömrələri təkrarlanmır')
        k_count = await K.count('sales')
        m_sales = await wait_until(lambda: _eq(M, 'sales', k_count), 90)
        check(m_sales is not None, 'xətalardan sonra iki brauzerdə çek sayı eynidir')
        stK = await K.stock('Qız'); stM = await wait_until(lambda: _stock(M, 'Qız', stK), 90)
        check(stM is not None, f'qalıq iki brauzerdə eynidir ({stK})')
        out_k = await K.ev("DB.getAll('outbox').then(x => x.length)")
        check(out_k == 0, f'kassada göndərilməmiş qeyd qalmayıb ({out_k})')
        errs = [r for r in rows('Events') if r[2] == 'server.project_error']
        check(not errs, 'server layihə xətası yoxdur')

        print('\n== Sorğu statistikası ==', flush=True)
        for lab in ('Kassa', 'Menecer'):
            xs = [r for r in reqlog if r[1] == lab]
            span = max(r[0] for r in xs) - min(r[0] for r in xs) if xs else 1
            kinds = {}
            for r in xs: kinds[r[2]] = kinds.get(r[2], 0) + 1
            print(f'  {lab}: {len(xs)} sorğu / {span/60:.1f} dəq = {len(xs)/(span/60):.1f} sorğu/dəq  {kinds}', flush=True)
        await b.close()


async def _all5(d): return (await d.count('products')) == 5
async def _gt(d, store, n): return (await d.count(store)) > n
async def _rows(d, n): return (await d.pg.locator('tbody tr .mono').count()) >= n
async def _stock(d, prefix, v): return (await d.stock(prefix)) == v
async def _count(loc, n): return (await loc.count()) == n
async def _eq(d, store, n): return (await d.count(store)) == n
async def _count_sales_rows(n): return len(rows('Sales')) >= n


try:
    asyncio.run(main())
finally:
    web.terminate(); gas.terminate()
print(f'\n{len(ok)} keçdi, {len(errors)} uğursuz   (ümumi {(time.time()-t_start)/60:.1f} dəq)')
for e in errors: print('  ✗ ' + e)
sys.exit(1 if errors else 0)
