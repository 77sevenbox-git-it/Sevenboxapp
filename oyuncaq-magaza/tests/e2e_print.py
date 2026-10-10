"""Çap yoxlaması (real printer olmadan): tətbiqin çap HTML/CSS-i Chromium ilə PDF-ə çıxarılır və yoxlanılır:
 • kağız ölçüsü (@page) — çek 80/58 mm eni, etiket seçilmiş ölçüdə, hər etiket ayrıca səhifə
 • barkod PDF-dən printerin dpi-si ilə rastrlanıb oxunur (zxing) və düzgün kodu verməlidir
 • mətn kəsilmir (PDF mətnində ad, yekun, qiymət var), çek bir səhifədir (artıq boş kağız yoxdur)
 • zolaq eni printer nöqtəsinin tam sayıdır
İşə salmaq: python3 tests/e2e_print.py   (pip: pypdf pillow zxing-cpp; sistem: poppler-utils)"""
import subprocess, time, sys, os, re, json, tempfile
from playwright.sync_api import sync_playwright
from pypdf import PdfReader
from PIL import Image
import zxingcpp


def wf(pg, expr, timeout=30000):
    """wait_for_function sətri eval ilə işlədir, CSP (script-src 'self') isə eval-ı qadağan edir; ona görə ifadə evaluate ilə dövri yoxlanılır."""
    t0 = time.time()
    while (time.time() - t0) * 1000 < timeout:
        if pg.evaluate('() => !!(' + expr + ')'): return
        pg.wait_for_timeout(50)
    raise TimeoutError('gözlənilən şərt yerinə yetmədi: ' + expr[:100])

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix='print-')
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8766', '-d', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
ok, errors = [], []
def check(cond, msg): (ok if cond else errors).append(msg)
def mm(pt): return pt * 25.4 / 72

def pdf_pages(path):
    r = PdfReader(path)
    return [(mm(float(p.mediabox.width)), mm(float(p.mediabox.height))) for p in r.pages]

def rasterize(path, dpi):
    base = os.path.join(TMP, 'r%d' % int(time.time() * 1000))
    subprocess.run(['pdftoppm', '-r', str(dpi), '-png', path, base], check=True)
    files = sorted(f for f in os.listdir(TMP) if f.startswith(os.path.basename(base)))
    return [Image.open(os.path.join(TMP, f)).convert('L') for f in files]

def decode(img):
    return sorted({r.text for r in zxingcpp.read_barcodes(img) if r.format == zxingcpp.BarcodeFormat.EAN13})

def pdftext(path, page=None):
    args = ['pdftotext', '-layout']
    if page: args += ['-f', str(page), '-l', str(page)]
    return subprocess.run(args + [path, '-'], capture_output=True, text=True).stdout

def ink_bbox(img):
    """Qara piksellərin sərhədi (mm üçün çağıran çevirir)."""
    return img.point(lambda v: 255 if v < 128 else 0).getbbox()

SALE = """({
  receiptNo: 123, at: '2026-10-10T08:30:00.000Z', cashierName: 'Elvin Babayev', receiptBarcode: Barcode.receiptBarcode(123),
  lines: %s, totals: { subtotal: %d, discount: 0, total: %d },
  discount: null, payment: { method: 'cash', cashPart: %d, cashReceived: 20000, change: %d }
})"""
def sale_js(n_lines, long_name=False):
    lines = []
    total = 0
    for i in range(n_lines):
        name = ('Çox uzun adlı oyuncaq konstruktor dəsti ƏÖÜĞŞİÇ nömrə %d, 120 hissəli, 6+ yaş' % i) if long_name or i == 0 else 'Maqnit «Bakı» %d' % i
        price = 1450 if i % 2 == 0 else 225
        lines.append({'name': name, 'qty': 1 + i % 3, 'price': price}); total += price * (1 + i % 3)
    return SALE % (json.dumps(lines, ensure_ascii=False), total, total, total, 20000 - total)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 1200, 'height': 900}, timezone_id='Asia/Baku')
        pg.on('pageerror', lambda e: errors.append('JS xətası: ' + str(e)))
        pg.on('console', lambda m: errors.append('CSP pozuntusu: ' + m.text[:200]) if 'Content Security Policy' in m.text else None)
        pg.add_init_script('window.print = function(){ window.__printed = (window.__printed||0)+1; };')
        pg.goto('http://localhost:8766/index.html'); pg.wait_for_selector('.users button')
        store = "({ name: 'Oyuncaq Dünyası', voen: '1234567891', address: 'Bakı, Nizami küç. 10', registerName: 'Kassa 1' })"

        def do_print(setup_js, html_js, kind):
            pg.evaluate("() => { Print._reset(); Print.save(%s); }" % setup_js)
            pg.evaluate("() => { window.__printed = 0; return Print.print(%s, '%s'); }" % (html_js, kind))
            wf(pg, 'window.__printed >= 1')
            return pg.evaluate("() => document.getElementById('print-page-css').textContent")

        def to_pdf(name):
            path = os.path.join(TMP, name + '.pdf')
            pg.emulate_media(media='print')
            pg.pdf(path=path, prefer_css_page_size=True, print_background=True)
            pg.emulate_media(media='screen')
            return path

        # ---------- Çek: 80 və 58 mm ----------
        for paper, content in ((80, 72), (58, 48)):
            for n_lines, long_name in ((2, False), (30, True)):
                css = do_print("{ receipt: { paper: %d, mode: 'exact', dpi: 203, feedMm: 8 } }" % paper,
                               "Print.receiptHtml(%s, %s)" % (sale_js(n_lines, long_name), store), 'receipt')
                path = to_pdf('rec%d_%d' % (paper, n_lines))
                pages = pdf_pages(path)
                tag = '%d mm / %d sətir' % (paper, n_lines)
                check(len(pages) == 1, 'çek %s: tam 1 səhifə (artıq boş kağız yoxdur): %d' % (tag, len(pages)))
                check(abs(pages[0][0] - paper) < 0.6, 'çek %s: kağız eni %.1f mm' % (tag, pages[0][0]))
                m = re.search(r'size:(\d+)mm (\d+)mm', css)
                check(m and int(m.group(1)) == paper, 'çek %s: @page eni %s' % (tag, css))
                img = rasterize(path, 203)[0]
                bb = ink_bbox(img)
                px_mm = 203 / 25.4
                if bb:
                    left_mm, right_mm = bb[0] / px_mm, bb[2] / px_mm
                    margin = (paper - content) / 2
                    check(left_mm >= margin - 0.6 and right_mm <= paper - margin + 0.6, 'çek %s: mətn çap sahəsindən çıxmır (%.1f–%.1f mm)' % (tag, left_mm, right_mm))
                    bottom_free = pages[0][1] - bb[3] / px_mm
                    check(0 < bottom_free < 8 + 6, 'çek %s: aşağı boşluq %.1f mm (printer kəsimi üçün)' % (tag, bottom_free))
                check(decode(img) == [pg.evaluate("() => Barcode.receiptBarcode(123)")], 'çek %s: barkod 203 dpi-də oxunur' % tag)
                txt = pdftext(path)
                check('YEKUN' in txt and 'Elvin Babayev' in txt and 'Oyuncaq Dünyası' in txt and ('Maqnit' in txt or 'Çox uzun' in txt), 'çek %s: mətn tamdır' % tag)
                if n_lines == 30: check(txt.count('120 hissəli') >= 30 or txt.replace('\n', ' ').count('hissəli') >= 30, 'çek %s: bütün sətirlər çapdadır (%d)' % (tag, txt.replace('\n', ' ').count('hissəli')))

        # çek barkodunun zolaq eni nöqtənin tam sayıdır
        w = pg.evaluate("() => { Print._reset(); Print.save({ receipt: { paper: 80, dpi: 203 } }); const m = Barcode.svgMm(Barcode.receiptBarcode(5), { dpi: 203, maxWidthMm: 70, heightMm: 12, maxMod: 4 }); return [m.mod, m.modMm, m.svg]; }")
        xs = re.findall(r'<rect x="(\d+)" y="0" width="(\d+)"', w[2])
        check(all(int(x) % w[0] == 0 and int(wd) % w[0] == 0 for x, wd in xs), 'barkod zolaqları modulun (%d nöqtə) tam misillərindədir' % w[0])

        # ---------- Etiket ----------
        PRODUCT = "{ name: 'Konstruktor dəsti, 120 hissə ƏÖÜĞŞİÇ', price: 1450, storeBarcode: Barcode.storeBarcode(%d) }"
        for (lw, lh) in ((30, 20), (40, 30), (50, 30), (58, 40), (60, 40), (70, 50), (100, 50), (100, 100)):
            for dpi in (203, 300):
                css = do_print("{ label: { w: %d, h: %d, dpi: %d, mode: 'exact' } }" % (lw, lh, dpi),
                               "Print.labelsHtml([{ product: %s, count: 3 }])" % (PRODUCT % 7), 'label')
                path = to_pdf('lab%dx%d_%d' % (lw, lh, dpi))
                pages = pdf_pages(path)
                tag = '%dx%d mm %d dpi' % (lw, lh, dpi)
                check(len(pages) == 3, 'etiket %s: 3 etiket = 3 səhifə (%d)' % (tag, len(pages)))
                check(all(abs(a - lw) < 0.4 and abs(c - lh) < 0.4 for a, c in pages), 'etiket %s: səhifə ölçüsü %s' % (tag, ['%.1fx%.1f' % x for x in pages[:1]]))
                imgs = rasterize(path, dpi)
                want = pg.evaluate("() => Barcode.storeBarcode(7)")
                good = 0
                for im in imgs:
                    if decode(im) == [want]: good += 1
                info = pg.evaluate("() => Print.barcodeInfo()")
                if info['ok']:
                    check(good == 3, 'etiket %s: barkod %d/3 səhifədə oxunur (zolaq %.3f mm)' % (tag, good, info['modMm']))
                else:
                    ok.append('etiket %s: dar etiket xəbərdarlığı verilir (zolaq %.3f mm, oxunma %d/3)' % (tag, info['modMm'], good))
                txt = pdftext(path, 1)
                check('14,50' in txt, 'etiket %s: qiymət çapdadır' % tag)
                check('Konstruktor' in txt, 'etiket %s: ad çapdadır' % tag)
                bb = ink_bbox(imgs[0])
                pxmm = dpi / 25.4
                if bb:
                    check(bb[0] / pxmm >= 0.8 and (lw - bb[2] / pxmm) >= 0.8 and bb[1] / pxmm >= 0.5 and (lh - bb[3] / pxmm) >= 0.3, 'etiket %s: heç nə kənardan kəsilmir' % tag)

        # sürücü rejimi: @page ölçüsü verilmir
        css = do_print("{ label: { w: 58, h: 40, dpi: 203, mode: 'driver' }, receipt: { paper: 80, mode: 'driver' } }",
                       "Print.labelsHtml([{ product: %s, count: 1 }])" % (PRODUCT % 1), 'label')
        check('size' not in css, 'sürücü rejimi: @page ölçü vermir (%s)' % css)
        css = do_print("{}", "Print.receiptHtml(%s, %s)" % (sale_js(2), store), 'receipt')
        check('size:80mm' in css, 'standart: çek 80 mm')

        # ---------- Ayarlar pəncərəsi (UI) ----------
        pg.evaluate("() => { Print._reset(); localStorage.removeItem('mag.print'); }")
        pg.evaluate("() => Print.settingsModal()")
        pg.wait_for_selector('#pr-paper')
        pg.select_option('#pr-paper', '58')
        pg.select_option('#pl-preset', '40x30')
        info = pg.inner_text('#pl-info')
        check('mm' in info, 'ayarlar: barkod zolağı məlumatı göstərilir (%s)' % info)
        pg.select_option('#pl-preset', 'custom')
        check(pg.is_visible('#pl-w'), 'ayarlar: "Digər ölçü" en/hündürlük sahələrini açır')
        pg.fill('#pl-w', '45'); pg.fill('#pl-h', '25')
        pg.evaluate("() => { window.__printed = 0; }")
        pg.click('#pl-test'); wf(pg, 'window.__printed >= 1')
        saved = pg.evaluate("() => JSON.parse(localStorage.getItem('mag.print'))")
        check(saved['receipt']['paper'] == 58 and saved['label']['w'] == 45 and saved['label']['h'] == 25, 'ayarlar: test çapı ayarı yadda saxlayır %s' % json.dumps(saved))
        css = pg.evaluate("() => document.getElementById('print-page-css').textContent")
        check('size:45mm 25mm' in css, 'ayarlar: test etiketi seçilmiş ölçüdə (%s)' % css)
        pg.evaluate("() => { window.__printed = 0; }")
        pg.click('#pr-test'); wf(pg, 'window.__printed >= 1')
        check('ÇAP SINAĞI' in pg.inner_text('#print-area'), 'ayarlar: test çeki çap olunur')
        path = to_pdf('test_receipt'); pages = pdf_pages(path)
        check(len(pages) == 1 and abs(pages[0][0] - 58) < 0.6, 'test çeki: 58 mm, 1 səhifə')
        # pozulmuş ayar dəyərləri təhlükəsiz sahəyə qaytarılır
        pg.evaluate("() => { localStorage.setItem('mag.print', JSON.stringify({ receipt: { paper: 12, feedMm: 9999 }, label: { w: -5, h: 'x' } })); Print._reset(); }")
        s = pg.evaluate("() => Print.settings()")
        check(s['receipt']['paper'] == 80 and s['receipt']['feedMm'] <= 40 and s['label']['w'] >= 20 and s['label']['h'] >= 12, 'pozulmuş ayar dəyərləri düzəlir %s' % json.dumps(s))
finally:
    srv.terminate()

for m in ok: print('✓', m)
for m in errors: print('✗', m)
print('\n%d keçdi, %d uğursuz' % (len(ok), len(errors)))
sys.exit(1 if errors else 0)
