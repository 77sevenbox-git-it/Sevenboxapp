# Mağaza İS — Kassa (MVP, mərhələ 1)

Oyuncaq-suvenir mağazası üçün veb kassa. BRD v1.2 əsasındadır. Build addımı yoxdur: fayllar GitHub Pages və ya istənilən statik hostda olduğu kimi işləyir.

## Bu mərhələdə nə var

- **Kassa (variant A):** mağaza barkodu ilə satış; istehsalçı barkodu kassada qəbul olunmur. Nağd / Bank (POS kart, karta köçürmə) / Qarışıq ödəniş, qaytarılacaq məbləğ avtomatik. 80 mm çek, çek barkodu ilə.
- **Endirim:** ≤ 5%, menecer PIN-i ilə təsdiq. **Mənfi qalıq:** xəbərdarlıq, mal qəbuluna qədər max 2 çek, 3-cüdə blok.
- **Qaytarma:** çek barkodu ilə, 14 təqvim günü (Bakı vaxtı), say limiti, menecer təsdiqi, qaytarma çeki.
- **Növbə:** açılış, mədaxil/məxaric, Z hesabatı, kassa fərqi + izah.
- **Məhsullar:** avtomatik EAN-13 mağaza barkodu ("20" prefiksi), etiket çapı, sadə mal qəbulu, orta çəkili maya.
- **Rollar:** Admin / Menecer / Kassir / Mühasib, icazə matrisini yalnız Admin dəyişir. PIN girişi, 5 səhv cəhddə 5 dəqiqəlik blok, ilk girişdə PIN dəyişmə.
- **Oflayn:** bütün məlumat IndexedDB-də; service worker tətbiqi internetsiz açır. Hər əməliyyat audit jurnalına və sinxron növbəsinə yazılır.
- **Backend:** `apps-script/Code.gs` — Google Sheets-ə yazan Apps Script (idempotent sinxron, token, kilid).

## Hələ yoxdur (növbəti mərhələlər)

Tam mal qəbulu sənədi və təchizatçı borcu, hesabatlar və Excel ixracı, menecer PWA-sında bildirişlə təsdiq, inventarizasiya, Sheets-dən geri oxuma (çox cihaz), e-kassa modulunun interfeysi.

## İşə salmaq

```bash
python3 -m http.server 8000      # sonra http://localhost:8000
```
Sınaq PIN-ləri: Admin 1234, Menecer 2222, Kassir 1111, Mühasib 3333 / 4444 (ilk girişdə dəyişdirilir).

**Səssiz çap:** Chrome-u `--kiosk-printing` parametri ilə açın və 80 mm printeri default edin — çek pəncərəsiz çap olunur.

## Google Sheets-ə qoşmaq

Verilənlər bazası faylı Drive-da hazırdır, cədvəllər və başlıqlar qurulub: [Mağaza İS — Verilənlər bazası](https://docs.google.com/spreadsheets/d/1NTzVrx9ioe9elwn3c85RwU64e9NWuylaKT8uyLoe67g/edit).

1. Həmin faylı açın → Extensions → Apps Script → `apps-script/Code.gs` yapışdırın.
2. Script properties: `SYNC_TOKEN` = uzun təsadüfi sətir.
3. `setup()` funksiyasını bir dəfə işə salın.
4. Deploy → Web app (Execute as: Me, Access: Anyone) → URL-i və tokeni tətbiqdə **İcazələr → Mağaza və server** bölməsinə yazın.

## Testlər

```bash
npm install
node tests/run.js              # qaydalar, pul, barkod (39)
node tests/services.test.js    # satış/qaytarma/növbə axınları (22)
python3 tests/e2e.py           # brauzerdə uçdan-uca (14, Playwright lazımdır)
```

## Vacib təhlükəsizlik qeydi

Giriş və icazələr bu mərhələdə **brauzerin içində** yoxlanılır. Bu, kassirin səhvən icazəsiz düyməyə basmasının qarşısını alır, amma kompyuterə texniki girişi olan biri lokal bazanı dəyişə bilər. Server tərəfində rol yoxlaması (Apps Script) və Admin/Menecer üçün 2FA növbəti mərhələdədir; o vaxta qədər kassa kompyuterini ayrıca Windows hesabı ilə qoruyun.

## Struktur

```
index.html  manifest.json  sw.js
css/app.css
js/money.js     pul (qəpiklə, float yox)
js/barcode.js   EAN-13, mağaza və çek barkodu, SVG
js/rules.js     biznes qaydaları (saf funksiyalar)
js/db.js        IndexedDB, atomik tranzaksiyalar
js/services.js  satış, qaytarma, növbə, məhsul, giriş, audit
js/sync.js      outbox → Apps Script
js/ui.js        modal, PIN təsdiqi, çek/etiket şablonları
js/pos.js       kassa ekranı
js/screens.js   giriş, məhsullar, qaytarma, növbə, çeklər, icazələr
js/app.js       menyu və marşrutlar
apps-script/Code.gs
tests/
```
