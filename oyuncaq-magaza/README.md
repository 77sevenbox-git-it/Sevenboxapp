# Mağaza İS — Kassa (MVP, mərhələ 1)

Oyuncaq-suvenir mağazası üçün veb kassa. BRD v1.2 əsasındadır. Build addımı yoxdur: fayllar GitHub Pages və ya istənilən statik hostda olduğu kimi işləyir.

## Bu mərhələdə nə var

- **Kassa (variant A):** mağaza barkodu ilə satış; istehsalçı barkodu kassada qəbul olunmur. Nağd / Bank (POS kart, karta köçürmə) / Qarışıq ödəniş, qaytarılacaq məbləğ avtomatik. 80 mm çek, çek barkodu ilə.
- **Endirim:** ≤ 5%, menecer PIN-i ilə təsdiq. **Mənfi qalıq:** xəbərdarlıq, mal qəbuluna qədər max 2 çek, 3-cüdə blok.
- **Qaytarma:** çek barkodu ilə, 14 təqvim günü (Bakı vaxtı), say limiti, menecer təsdiqi, qaytarma çeki.
- **Növbə:** açılış, mədaxil/məxaric, Z hesabatı, kassa fərqi + izah.
- **Məhsullar:** avtomatik EAN-13 mağaza barkodu ("20" prefiksi), etiket çapı, sadə mal qəbulu, orta çəkili maya.
- **Mal qəbulu ayrıca icazədir (`stock.receive`):** defoltda yalnız Menecer və Admin qalığı artıra bilir; Kassir məhsullara baxır və etiket çap edir, amma "Qəbul" düyməsi onda yoxdur və xidmət səviyyəsində də rədd olunur. Kassirdə qalıq bitəndə (mənfi çek limiti dolanda) satış menecer mal qəbul edənə qədər bloklanır. İcazəni Admin İcazələr cədvəlində başqa rola verə bilər; alış qiymətini görməyən rol qəbul edərsə, məhsulun son alış qiyməti götürülür.
- **Rollar:** Admin / Menecer / Kassir / Mühasib, icazə matrisini yalnız Admin dəyişir. PIN girişi, 5 səhv cəhddə 5 dəqiqəlik blok, ilk girişdə məcburi yeni PIN (ayrıca səhifə, arxa fonda iş ekranı yoxdur). Unudulmuş PIN-i Admin sıfırlayır (İcazələr → İstifadəçilər).
- **Çek sətri:** kassir sayı sərbəst azaldır (1-ə qədər); sətri silmək zibil ikonu ilə, menecer təsdiqi tələb edir: ya menecer PIN-i, ya da (server qoşulubsa) menecerin cihazına sorğu. Menecer üst paneldə "Sorğular (N)" düyməsindən təsdiqləyir və ya rədd edir.
- **Sessiya və yarımçıq çek:** səhifəni yeniləmək çıxış etdirmir və açıq çeki silmir (brauzer tabında saxlanır; tab bağlananda, çıxışda, PIN/rol dəyişəndə və 12 saatdan sonra silinir).
- **Menecerə sorğu:** "Menecerə sorğu göndər" basılan kimi pəncərə bağlanır, yuxarıda "gözlənilir" zolağı qalır, kassir işləməyə davam edir. Menecer təsdiq edəndə əməliyyat avtomatik tamamlanır; təsdiq yalnız sorğuda göstərilən sətirə/say-a tətbiq olunur (arada çek dəyişibsə tətbiq olunmur). Çıxışda gözləyən sorğular ləğv olunur.
- **Növbə:** yeni növbə əvvəlki növbənin sayılmış nağdı ilə açılır (fərqli məbləğ üçün izah məcburidir və auditə düşür); bağlayanda gözləmə göstəricisi var; Z çekində sıfır olan sətirlər yoxdur.
- **Qaytarma:** say satılandan (və əvvəl qaytarılandan) çox ola bilməz; bu, menecer təsdiq ekranından əvvəl yoxlanır.
- **İstehsalçı barkodu:** uzunluq və format məhdudiyyəti yoxdur (hərf-rəqəm, istənilən uzunluq); yalnız boşluq və öz mağaza/çek barkodlarımız qəbul olunmur.
- **Xəta mesajları:** ekranın yuxarısında və pəncərənin içində göstərilir (telefon klaviaturası aşağını örtəndə itmir).
- **Oflayn:** bütün məlumat IndexedDB-də; service worker tətbiqi internetsiz açır. Hər əməliyyat audit jurnalına və sinxron növbəsinə yazılır.
- **Çoxcihazlı sinxron (iki istiqamətli):** hər brauzer/cihaz öz lokal nüsxəsi ilə işləyir; hadisələr Google Sheets-ə yazılır və digər cihazlara paylanır. İstifadəçilər/PIN-lər, məhsullar, qalıq, çeklər, qaytarmalar, növbə, icazələr, mağaza məlumatı və təsdiq sorğuları cihazlar arasında eynidir.
- **Backend:** `apps-script/Code.gs` (v4) — Google Sheets-ə yazan və digər cihazların hadisələrini qaytaran Apps Script (idempotent, token, yazıda kilid, boş yoxlamada kilid və cədvəl oxuması yoxdur, toplu yazı). Köhnə v3 ilə də işləyir, amma yavaş: Ayarlar → Mağaza və server → "Bağlantını yoxla" skriptin köhnə olduğunu deyir.

## Hələ yoxdur (növbəti mərhələlər)

Tam mal qəbulu sənədi və təchizatçı borcu, hesabatlar və Excel ixracı, push-bildiriş (təsdiq sorğusu indi açıq tətbiqdə görünür), inventarizasiya, e-kassa modulunun interfeysi, server tərəfində rol yoxlaması.

## İşə salmaq

```bash
python3 -m http.server 8000      # sonra http://localhost:8000
```
İlk girişdə hər istifadəçi öz PIN-ini təyin edir. Başlanğıc PIN-ləri layihə sahibinə məlumdur; ekranda və burada yazılmır.

**Səssiz çap:** Chrome-u `--kiosk-printing` parametri ilə açın və 80 mm printeri default edin — çek pəncərəsiz çap olunur.

## Google Sheets-ə qoşmaq

Verilənlər bazası faylı Drive-da hazırdır, cədvəllər və başlıqlar qurulub: [Mağaza İS — Verilənlər bazası](https://docs.google.com/spreadsheets/d/1NTzVrx9ioe9elwn3c85RwU64e9NWuylaKT8uyLoe67g/edit).

1. Həmin faylı açın → Extensions → Apps Script → `apps-script/Code.gs` yapışdırın (köhnə kodu əvəz edin).
2. Script properties: `SYNC_TOKEN` = uzun təsadüfi sətir.
3. `setup()` funksiyasını işə salın (yeni `Users`, `Settings` vərəqlərini yaradır, başlıqları yeniləyir; təkrar işə salmaq təhlükəsizdir).
4. Deploy → Web app → Execute as: **Me**, Who has access: **Anyone**. Kodu sonradan dəyişəndə: Deploy → Manage deployments → ✏️ → Version: **New version** (ünvan dəyişmir).
5. **Birinci cihaz:** giriş ekranında "Bu cihazı serverə qoş" (və ya admin kimi İcazələr → Mağaza və server) → URL və token.
6. **Hər yeni brauzer/cihaz:** eyni addım. Qoşulan kimi istifadəçilər (yeni PIN-lərlə), məhsullar, qalıq və çeklər serverdən yüklənir. URL və token brauzerdə saxlanılır, ona görə hər brauzerdə bir dəfə yazılmalıdır.

Yoxlama: URL-i **gizli pəncərədə** açın, `{"ok":true,...}` görünməlidir. Google giriş səhifəsi görünürsə, "Who has access" = Anyone deyil: digər brauzerlər qoşula bilməyəcək.

`Events` vərəqindəki sətirləri silməyin: cihazlar məlumatı oradan alır. Sıfırlamaq lazımdırsa, bütün cihazlarda brauzer məlumatını da təmizləyin.

### Sinxronun qaydaları

- Yazıdan ~0,3 san sonra göndərilir; açıq tətbiq 4 san-dən bir yoxlayır (yenilik gələndən və təsdiq gözlənəndən sonra bir müddət 1,5 san). Boş yoxlama cədvəli açmır (ümumi sayğac keşdədir), ona görə yüngüldür.
- **Sürət həddi:** Apps Script bir sorğuya ~2–2,5 san çəkir və "push" bildirişi yoxdur. Buna görə bir cihazdan digərinə yenilik adətən 4–8 san, menecer təsdiqi (sorğu → təsdiq → kassirdə davam) ~10–12 san çəkir. Üst paneldəki "Server X san" göstəricisi hazırkı cavab müddətidir. Menecer PIN-i ilə kassada yerindəcə təsdiq isə dərhal olur. 2 san-dən aşağı lazımdırsa, real vaxt verən backend (Firebase/Supabase) lazımdır.
- Sorğu 30 san-dən uzun ilişərsə kəsilir və təkrar cəhd olunur; xəta olanda gözləmə 4 → 8 → 16 → 30 san artır, qayıdanda dərhal normal rejimə keçir.
- Brauzer **gizli/örtülmüş pəncərənin** taymerlərini yavaşladır. Menecerin pəncərəsini kassirin sorğusunu gözləyərkən başqa pəncərənin altında qoymayın; versiyanı yoxlamaq üçün üst paneldəki `vYYYY.MM.DD-N` iki cihazda eyni olmalıdır (fərqlidirsə Ctrl+F5).
- Eyni qeyd iki cihazda dəyişsə (istifadəçi, məhsul, icazə, mağaza məlumatı), son dəyişiklik qalib gəlir; buna görə kompüterlərin saatı dəqiq olmalıdır (fərq böyükdürsə üst paneldə xəbərdarlıq çıxır). Qalıq isə hadisələrin cəmindən formalaşır: iki kassada paralel satış qalığı düzgün azaldır.
- Məhsul barkodu və çek nömrəsi hər cihaza ayrı **aralıqla** verilir (100 / 500-lük), ona görə iki kassada eyni nömrə çıxmır. Çek nömrələri cihazlar arasında ardıcıl deyil, amma unikaldır.
- Bir növbə bütün cihazlar üçün ümumidir. "Növbəni aç" basanda cihaz əvvəl serverə baxır (4 san-ə qədər); başqa cihaz artıq açıbsa, ikinci növbə yaranmır. Yenə də eyni anda açılıbsa, ən əvvəl açılan cari sayılır.
- Eyni sorğuya iki menecer fərqli cavab versə, vaxtı erkən olan cavab bütün cihazlarda qalır.
- Ayarlarda mağaza məlumatı dəyişməyibsə, saxla düyməsi serverə heç nə yazmır (başqa cihazdakı dəyişikliyi əvəz etməsin).
- Növbəni bağlayanda digər kassaların satışları da hesabata düşsün deyə əvvəlcə server yenilənir.
- Sətir silmə sorğusu gözləyərkən internet kəsilərsə, menecer PIN-i ilə təsdiqləmək qalır.

## Testlər

```bash
npm install
npm test                       # aşağıdakı 4 qovluq testi birlikdə
node tests/run.js              # qaydalar, pul, barkod
node tests/services.test.js    # satış/qaytarma/növbə/PIN/təsdiq axınları (tək cihaz)
node tests/sync.test.js        # 2+ cihaz + Code.gs təqlidi: PIN, məhsul, qalıq, çek, təsdiq, oflayn, təkrar, səhifələmə
node tests/migrate.test.js     # köhnə (v1) brauzer bazasının yeni sxemə keçməsi
python3 tests/e2e.py           # brauzerdə uçdan-uca, tək cihaz (Playwright lazımdır)
python3 tests/e2e_sync.py      # iki ayrı brauzer yaddaşı + Apps Script təqlidi: PIN bazaya yazılır, 2-ci brauzerdə işləyir, menecer təsdiqi
node tests/fuzz.test.js [N]    # təsadüfi çoxcihazlı əməliyyatlar + şəbəkə xətaları: bütün cihazlar eyni nəticəyə gəlməlidir (N toxum, defolt 12)
python3 tests/e2e_latency.py   # real Apps Script gecikməsi (~2,3 san/sorğu) + 15% xəta + ilişmiş sorğu təqlidi ilə 2 brauzer; ölçülmüş gecikmələri yazır
```

**Giriş PIN-ini unutmusunuzsa (Admin də):** Apps Script redaktorunda `resetAdminPin()` funksiyasını işə salın. Admin üçün təsadüfi müvəqqəti PIN yaranır və Logs-da (View → Logs / Execution log) göstərilir; cihazlar onu bir neçə saniyəyə alır, Admin girişdən sonra yeni PIN seçməlidir.

**Code.gs v4-ə keçid:** `apps-script/Code.gs`-i köhnənin yerinə yapışdırın → `setup()` işə salın → Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy (ünvan və token dəyişmir). Sonra hər brauzerdə Ctrl+F5.

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
js/replica.js   başqa cihazlardan gələn hadisələrin lokal bazaya tətbiqi
js/sync.js      outbox ⇄ Apps Script (göndər + al, nömrə aralıqları)
js/ui.js        modal, PIN təsdiqi, çek/etiket şablonları
js/pos.js       kassa ekranı
js/screens.js   giriş, məhsullar, qaytarma, növbə, çeklər, icazələr
js/app.js       menyu və marşrutlar
apps-script/Code.gs
tests/
```
