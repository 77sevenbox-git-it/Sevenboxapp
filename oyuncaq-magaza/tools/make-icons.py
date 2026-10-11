"""PNG ikonlarını yaradır (icons/icon.svg ilə eyni barkod motivi). İşə salmaq: python3 tools/make-icons.py
 • icon-192.png, icon-512.png   — tətbiq ikonu (mavi yuvarlaq kvadrat, ağ zolaqlar)
 • icon-maskable-512.png        — Android "maskable": tam mavi fon, zolaqlar mərkəzdəki təhlükəsiz zonada
 • apple-touch-icon.png (180)   — iPhone ana ekranı (künc yuvarlaqlığı sistem tərəfindən verilir)
 • favicon.ico (16/32/48), icon-32.png, icon-16.png — brauzer tabının ikonu (Chrome kompüterdə /favicon.ico və 32 px PNG axtarır)
 • badge-96.png                 — bildirişin statusbardakı kiçik ikonu: ŞƏFFAF fon üzərində ağ siluet (rəngli şəkil boz kvadrat kimi görünür)"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
BLUE = (31, 95, 173, 255)
# icon.svg-dəki zolaqlar (512 koordinat sistemində): x, en
BARS = [(120, 16), (152, 32), (200, 12), (228, 24), (268, 12), (296, 36), (348, 12), (376, 16)]
TOP, BOT = 150, 362
SS = 4   # antialiasing üçün 4x çəkib kiçildirik


def bars(draw, scale, ox, oy, fill):
    for x, w in BARS:
        draw.rectangle([ox + x * scale, oy + TOP * scale, ox + (x + w) * scale - 1, oy + BOT * scale - 1], fill=fill)


def render(size, bg, radius, content_scale, silhouette=False):
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg:
        if radius:
            d.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * radius), fill=BLUE)
        else:
            d.rectangle([0, 0, big - 1, big - 1], fill=BLUE)
    s = big / 512 * content_scale
    # məzmunu mərkəzə yerləşdiririk
    ox = (big - 512 * s) / 2
    oy = (big - 512 * s) / 2
    bars(d, s, ox, oy, (255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


# Tab ikonunun zolaqları: (zolaq eni, boşluq) piksellə, ölçüyə görə əl ilə seçilib
TAB_BARS = {48: ([3, 2, 4, 2, 3, 4, 2, 3], 2), 32: ([2, 1, 3, 1, 2, 3, 1, 2], 1), 16: ([1, 1, 2, 1, 2], 1)}


def tab_icon(n):
    img = Image.new('RGBA', (n * SS, n * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n * SS - 1, n * SS - 1], radius=int(n * SS * 0.18), fill=BLUE)
    widths, gap = TAB_BARS[n]
    total = sum(widths) + gap * (len(widths) - 1)
    x = (n - total) // 2
    top, bot = int(n * 0.26), int(n * 0.74)
    for w in widths:
        d.rectangle([x * SS, top * SS, (x + w) * SS - 1, bot * SS - 1], fill=(255, 255, 255, 255))
        x += w + gap
    return img.resize((n, n), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    render(192, True, 96 / 512, 1.0).save(os.path.join(OUT, 'icon-192.png'))
    render(512, True, 96 / 512, 1.0).save(os.path.join(OUT, 'icon-512.png'))
    render(512, True, 0, 0.78).save(os.path.join(OUT, 'icon-maskable-512.png'))     # təhlükəsiz zona: mərkəzdəki ~80%
    render(180, True, 0, 0.9).convert('RGB').save(os.path.join(OUT, 'apple-touch-icon.png'))
    # Tab ikonu: kiçik ölçüdə zolaqlar piksel şəbəkəsinə oturur (yumşaldılmış zolaq bulanıq görünür)
    ico = [tab_icon(n) for n in (48, 32, 16)]
    ico[1].save(os.path.join(OUT, 'icon-32.png'))
    ico[2].save(os.path.join(OUT, 'icon-16.png'))
    ico[0].save(os.path.join(os.path.dirname(OUT), 'favicon.ico'), format='ICO', sizes=[(48, 48), (32, 32), (16, 16)], append_images=ico[1:])
    # Badge: yalnız alfa kanalı vacibdir; ağ siluet, fon şəffaf. 96 px şəbəkədə qalın zolaqlar və aydın boşluqlar
    big = 96 * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pattern = [8, 5, 4, 5, 12, 5, 4, 5, 8, 5, 12]          # zolaq, boşluq, zolaq, ...
    x = (96 - sum(pattern)) // 2
    for i, w in enumerate(pattern):
        if i % 2 == 0:
            d.rectangle([x * SS, 18 * SS, (x + w) * SS - 1, 78 * SS - 1], fill=(255, 255, 255, 255))
        x += w
    img.resize((96, 96), Image.LANCZOS).save(os.path.join(OUT, 'badge-96.png'))

main()
