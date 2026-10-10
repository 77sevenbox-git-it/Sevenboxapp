# 7BOXS — Kassa (MVP, mərhələ 1)

Oyuncaq-suvenir mağazası üçün veb kassa. BRD v1.2 əsasındadır. Build addımı yoxdur: fayllar GitHub Pages və ya istənilən statik hostda olduğu kimi işləyir.

## Bu mərhələdə nə var

- **Kassa (variant A):** mağaza barkodu ilə satış; istehsalçı barkodu kassada qəbul olunmur. Nağd / Bank (POS kart, karta köçürmə) / Qarışıq ödəniş, qaytarılacaq məbləğ avtomatik. 80 mm çek, çek barkodu ilə.
- **Endirim:** ≤ 5%, menecer PIN-i ilə təsdiq. **Mənfi qalıq:** xəbərdarlıq, mal qəbuluna qədər max 2 çek, 3-cüdə blok.
- **Qaytarma:** çek barkodu ilə, 14 təqvim günü (Bakı vaxtı), say limiti, menecer təsdiqi, qaytarma çeki.
- **Növbə:** açılış, mədaxil/məxaric, Z hesabatı, kassa fərqi + izah.
- **Məhsullar:** avtomatik EAN-13 mağaza barkodu ("20" prefiksi), etiket çapı, sadə mal qəbulu, orta çəkili maya.
- **Mal qəbulu ayrıca icazədir (`stock.receive`):** defoltda yalnız Menecer və Admin qalığı artıra bilir (kassir sorğu göndərir, bax aşağıda); Kassir məhsullara baxır və etiket çap edir, amma "Qəbul" düyməsi onda yoxdur və xidmət səviyyəsində də rədd olunur. Kassirdə qalıq bitəndə (mənfi çek limiti dolanda) satış menecer mal qəbul edənə qədər bloklanır. İcazəni Admin İcazələr cədvəlində başqa rola verə bilər; alış qiymətini görməyən rol qəbul edərsə, məhsulun son alış qiyməti götürülür.
- **Rollar:** Admin / Menecer / Kassir / Mühasib, icazə matrisini yalnız Admin dəyişir. Giriş forması **rol üzrə** seçilir (aşağıda «Giriş forması»): PIN və ya şifrə. 5 səhv cəhddə 5 dəqiqəlik blok, ilk girişdə (və ya Admin kodu dəyişəndə / forma dəyişəndə) məcburi yeni kod (ayrıca səhifə, arxa fonda iş ekranı yoxdur). Unudulmuş kodu Admin sıfırlayır (İcazələr → İstifadəçilər).
- **Mal gəldi sorğusu (kassir → menecer):** Kassir qalığı özü artıra bilmir, amma Məhsullar bölməsində **"Mal gəldi"** düyməsi ilə gələn malın sayını (və bilirsə təchizatçını, qeydi) yazıb menecerə sorğu göndərir. Kassir alış qiymətini görmür və yazmır. Menecer/Admin üçün "Sorğular (N)" düyməsində (və telefon bildirişində) sorğu çıxır; təsdiq edən **sayı, təchizatçını və alış qiymətini yoxlayıb düzəldə bilər**, "Təsdiqlə və qəbul et" basanda qalıq, partiya (FIFO) və orta maya bir tranzaksiyada yenilənir. Rədd etsə, qalıq dəyişmir. Kassir "Mal qəbulu sorğularım" siyahısında vəziyyəti görür (gözləyir / təsdiqləndi / rədd edildi / ləğv edildi / vaxtı bitib) və gözləyən sorğunu ləğv edə bilir.
  - Sorğu **24 saat** qüvvədədir (kassadakı əməliyyatlar üçün 10 dəqiqədir): menecer məşğuldursa sonra da təsdiqləyə bilər. Eyni məhsul üçün gözləyən sorğu varkən ikincisi qəbul olunmur (təsadüfi ikiqat basma qalığı iki dəfə artırmasın).
  - İki menecer eyni sorğunu eyni anda fərqli cihazlarda təsdiqləsə qalıq **iki dəfə artmır**: partiyanın id-si sorğudan törəyir, cihazlar yalnız daha erkən qərarı saxlayır (say/qiymət fərqli yazılıbsa partiya və qalıq qalibə düzəlir; orta maya düzəlmir, yalnız son alış qiyməti).
  - Server (sinxron) qoşulmayıbsa sorğu menecerin cihazına çata bilmir: bu halda kassir sorğu göndərə bilmir, mal qəbulunu menecer özü edir. Mənfi qalıqla satış limiti (3-cü çekdə blok) qəbul təsdiqlənənə qədər davam edir, ona görə menecer gecikərsə kassada "mənfi qalıq" xəbərdarlığı çıxa bilər.
  - Admin İcazələr bölməsində kassirdən **"Mal qəbulu sorğusu göndərmək"** icazəsini ala bilər. Server kodu (`Code.gs`) dəyişmir, yenidən yerləşdirmək lazım deyil.
- **Çek sətri:** kassir sayı sərbəst azaldır (1-ə qədər); sətri silmək zibil ikonu ilə, menecer təsdiqi tələb edir: ya menecer PIN-i, ya da (server qoşulubsa) menecerin cihazına sorğu. Menecer üst paneldə "Sorğular (N)" düyməsindən təsdiqləyir və ya rədd edir.
- **Sessiya və yarımçıq çek:** səhifəni yeniləmək çıxış etdirmir və açıq çeki silmir (brauzer tabında saxlanır; tab bağlananda, çıxışda, PIN/rol dəyişəndə və 12 saatdan sonra silinir).
- **Menecerə sorğu:** "Menecerə sorğu göndər" basılan kimi pəncərə bağlanır, yuxarıda "gözlənilir" zolağı qalır, kassir işləməyə davam edir. Menecer təsdiq edəndə əməliyyat avtomatik tamamlanır; təsdiq yalnız sorğuda göstərilən sətirə/say-a tətbiq olunur (arada çek dəyişibsə tətbiq olunmur). Çıxışda gözləyən sorğular ləğv olunur.
- **Növbə:** yeni növbə əvvəlki növbənin sayılmış nağdı ilə açılır (fərqli məbləğ üçün izah məcburidir və auditə düşür); bağlayanda gözləmə göstəricisi var; Z çekində sıfır olan sətirlər yoxdur.
- **Qaytarma:** say satılandan (və əvvəl qaytarılandan) çox ola bilməz; bu, menecer təsdiq ekranından əvvəl yoxlanır.
- **İstehsalçı barkodu:** uzunluq və format məhdudiyyəti yoxdur (hərf-rəqəm, istənilən uzunluq); yalnız boşluq və öz mağaza/çek barkodlarımız qəbul olunmur.
- **Xəta mesajları:** ekranın yuxarısında və pəncərənin içində göstərilir (telefon klaviaturası aşağını örtəndə itmir).
- **4 dil: Azərbaycanca, Русский, English, Türkçe.** Giriş ekranında və üst paneldə dil seçimi var. Seçim **cihaza aiddir** (hər kassa/telefon öz dilində işləyir; kassir rusca, menecer azərbaycanca ola bilər), dəyişəndə səhifə bir dəfə yenilənir — giriş və yarımçıq çek itmir. Mətnlər kodda Azərbaycanca `_t('Qalıq: {0}', [n])` kimi yazılır, tərcümələr `js/lang-ru.js`, `lang-en.js`, `lang-tr.js` fayllarındadır; tərcümə tapılmasa Azərbaycanca göstərilir (səhifə sınmır). Tarix/saat seçilmiş dilin yerli formatındadır. Təsdiq sorğusunun mətni sorğunu görən menecerin dilində göstərilir (sorğu şablon + dəyərlər kimi saxlanılır). Telefon bildirişi də seçilmiş dildədir (service worker dili keş yaddaşından oxuyur).
  - **Müştəri çeki interfeys dilindən ayrıdır:** "Çap → Çekin dili" (ilkin: Azərbaycanca). Kassir rusca işləsə də çek Azərbaycanca çıxır; istəsəniz çek dilini dəyişin.
  - **Yeni mətn əlavə edəndə:** kodda `_t('...')` ilə yazın, sonra `node tools/i18n-scan.js --missing` (bükülməmiş mətn) və `npm test` (üç dildə tərcümə, `{0}` yer tutucuları, boş/səhv hərf yoxlaması) işlədin. Eyni Azərbaycanca söz fərqli mənada işlənirsə açara kontekst əlavə edin: `_t('Qaytarılan@@change')` — Azərbaycanca "Qaytarılan" görünür, digər dillərdə lüğətdəki ayrıca tərcümə ("Сдача", "Change", "Para üstü") götürülür.
  - **Məhsul adları, istifadəçi adları, təchizatçı adları və qeydlər istifadəçinin yazdığı kimi qalır** (tərcümə olunmur); bazada saxlanan sistem mətnləri (audit jurnalı) yazıldığı dildə qalır.
- **İstifadəçilər adla:** Admin (İcazələr → İstifadəçilər) "+ Yeni istifadəçi" ilə ad və rol verir (məs. «Elvin Babayev» — Kassir), adı/rolu dəyişir, söndürür və geri aktiv edir. Yaranan istifadəçiyə təsadüfi müvəqqəti kod verilir (rolun formasında: PIN rolunda 6 rəqəm, şifrə rolunda 12 simvollu şifrə; bir dəfə göstərilir), ilk girişdə öz kodunu seçir. Ad unikaldır (böyük/kiçik hərf fərqsiz), sistemdə həmişə ən azı bir aktiv Admin qalır, Admin öz hesabını söndürə və öz rolunu dəyişə bilməz. Giriş ekranında, üst paneldə və çeklərdə ad görünür; keçmiş çeklərdə həmin vaxtkı ad qalır. Başqa cihazda rol dəyişəndə/hesab söndürüləndə açıq sessiya bir neçə saniyəyə yenilənir/bağlanır (rol hər əməliyyatda bazadan oxunur).
- **Çap (Xprinter tipli termo çek və etiket printeri):** üst paneldəki **"Çap"** düyməsi bu cihazın printerini quraşdırır (cihaza məxsusdur, serverə getmir): çek kağızı 80 mm (çap sahəsi 72) və ya 58 mm (48), etiket ölçüsü (30×20, 40×30, 50×30, 58×40, 60×40, 70×50, 100×50, 100×100 və ya özəl en×hündürlük), printer sıxlığı 203/300 dpi, test çeki və test etiketi. Çekin kağız hündürlüyü məzmuna görə hesablanır (printer lazımsız boş kağız çəkmir), etiketdə hər etiket ayrıca səhifədir. Barkodun zolaq eni printerin nöqtəsinin tam sayıdır (203 dpi-də 0,25 / 0,375 / 0,5 mm), etiketin eninə görə seçilir; etiket çox darsa xəbərdarlıq çıxır.
- **Təchizatçılar və FIFO:** "Təchizatçılar" bölməsində təchizatçı (ad, telefon, qeyd) əlavə olunur/dəyişir/söndürülür. Mal qəbulunda təchizatçı seçilir (1 məhsul istənilən sayda təchizatçıdan ala bilər); hər qəbul ayrıca **partiyadır** (təchizatçı, say, alış qiyməti, vaxt). Satış FIFO ilədir: hər çek ən köhnə partiyadan çıxır, qaytarma malı çıxdığı partiyaya qaytarır. Hesabat (Təchizatçılar → "Hansı təchizatçının malından nə qədər satılıb"): dövr seçilir (bu gün / bu ay / keçən ay / bütün vaxt / tarixlər), təchizatçı üzrə satılan, qaytarılan, xalis ədəd, gəlir (endirimdən sonra), maya (FIFO), mənfəət və qalıq; hər təchizatçının məhsulları və "Excel üçün CSV". Maya/mənfəət yalnız alış qiymətinə baxmaq icazəsi olan rolda görünür. Məhsullar cədvəlində qalığın təchizatçılara görə bölgüsü və "Partiyalar" pəncərəsi var. İcazələr: `supplier.view` (Admin, Menecer, Mühasib), `supplier.manage` (Admin, Menecer).
  - *"Təchizatçısız"* sətri: sistemə köçməzdən əvvəlki qalıq və qəbuldan əvvəl (mənfi qalıqla) satılan mal. Sonradan qəbul gələndə həmin borc partiyaya bağlanır.
  - FIFO bölgüsü saxlanmır, qəbul/satış/qaytarma **vaxt sırası ilə yenidən hesablanır** — bütün cihazlar eyni nəticəni alır. Oflayn cihaz gec sinxronlaşanda təchizatçılar arasında bölgü düzələ bilər, cəmlər dəyişmir.
  - Satılandan artıq qaytarma (iki cihaz eyni çekin eyni sətrini oflayn qaytarsa) gizlənmir: hesabat səhifəsində xəbərdarlıq çıxır, artıq hissə "Təchizatçısız" qaytarma sayılır, qalıq uzlaşır. Pulun iki dəfə qaytarılıb-qaytarılmadığını əl ilə yoxlamaq lazımdır.
  - Köhnə tətbiq versiyasından yenilənən cihaz buraxdığı təchizatçı/partiya hadisələrini serverdən bir dəfə oxuyur (qalığa toxunmur).
- **Telefona bildiriş (təsdiq sorğusu):** menecer/admin cihazında üst paneldəki **"Bildiriş"** → "Aktiv et" (bir dəfə, icazəni təsdiqləyin). Kassir "Menecerə sorğu göndər" edəndə server (Apps Script) Web Push (VAPID) ilə səlahiyyəti olan başqa cihazlara bildiriş göndərir — tətbiq bağlı olsa belə (telefonda Chrome işləyirsə). Bildirişdə tətbiq ikonu və statusbar üçün şəffaf ağ "badge" var (boş boz kvadrat görünməsin); klik tətbiqi açır və təsdiq sorğuları pəncərəsini göstərir. Tətbiq açıqdır, amma pəncərə arxa plandadırsa, səhifə push olmadan öz bildirişini göstərir; ekrandadırsa səs + zolaq kifayətdir. "Test bildirişi" düyməsi bu cihazda bildiriş göstərir və serverdən real push göndərib push xidmətinin cavabını (məs. 201) yazır. Çıxış edəndə və ya rol təsdiq icazəsini itirəndə cihaz serverdə söndürülür; sorğuçunun öz cihazına/hesabına, 5 dəqiqədən köhnə və artıq cavablanmış sorğuya bildiriş getmir.
  - *iPhone/iPad:* bildiriş yalnız tətbiq Safari-dən "Ana ekrana əlavə et" ilə quraşdırılıbsa işləyir (iOS 16.4+). Android: Chrome-un batareya "optimallaşdırması" onu söndürməməlidir.
  - Bildirişin mətni sabitdir (seçilmiş dildə: "Təsdiq sorğusu — kassadan menecer təsdiqi gözlənilir"), konkret məzmun tətbiqin içindədir (push ilə mətn göndərilmir, boş push gedir; beləliklə serverdə mesaj şifrələmə kodu lazım olmur və məlumat üçüncü tərəf push xidmətindən keçmir).
  - Server kodu (Code.gs v6) xarici xidmətə sorğu göndərir (`UrlFetchApp`): `setup()` işlədəndə Google yeni icazə istəyir ("Connect to an external service"). Apps Script layihəsində V8 runtime olmalıdır (yeni layihələrdə defoltdur; BigInt lazımdır). Xüsusi (private) VAPID açarı Script properties-də qalır, cihaza göndərilmir; `PUSH_CONTACT` property-sini (məs. `mailto:siz@firma.az`) istəsəniz yazın.
- **Oflayn:** bütün məlumat IndexedDB-də; service worker tətbiqi internetsiz açır. Hər əməliyyat audit jurnalına və sinxron növbəsinə yazılır.
- **Çoxcihazlı sinxron (iki istiqamətli):** hər brauzer/cihaz öz lokal nüsxəsi ilə işləyir; hadisələr Google Sheets-ə yazılır və digər cihazlara paylanır. İstifadəçilər/PIN-lər, məhsullar, qalıq, çeklər, qaytarmalar, növbə, icazələr, mağaza məlumatı və təsdiq sorğuları cihazlar arasında eynidir.
- **Backend:** `apps-script/Code.gs` (v6: bildiriş; v5: `Suppliers` vərəqi, `StockReceipts`-də təchizatçı/partiya sütunları) — Google Sheets-ə yazan və digər cihazların hadisələrini qaytaran Apps Script (idempotent, token, yazıda kilid, boş yoxlamada kilid və cədvəl oxuması yoxdur, toplu yazı). Köhnə v3/v4 ilə də işləyir (təchizatçı/partiya məlumatı yenə Events vərəqində saxlanılır, amma ayrıca vərəqlərə yazılmır), v3 yavaşdır: Ayarlar → Mağaza və server → "Bağlantını yoxla" skriptin köhnə olduğunu deyir.

## Hələ yoxdur (növbəti mərhələlər)

Tam mal qəbulu sənədi və təchizatçı borcu (ödənişlər), digər hesabatlar, inventarizasiya, e-kassa modulunun interfeysi, server tərəfində rol yoxlaması.

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

`Events` vərəqindəki sətirləri əl ilə silməyin: cihazlar məlumatı oradan alır. Köhnə sətirləri yalnız **Arxiv** düyməsi (aşağıda) təhlükəsiz köçürür. Sıfırlamaq lazımdırsa, bütün cihazlarda brauzer məlumatını da təmizləyin.

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

## Təchizatçı borcu, ödənişlər və hesabat sənədi
**Təchizatçılar → Hesab** düyməsi (borcu görmək: «Təchizatçılara baxmaq» + «Alış qiymətini görmək» və ya «Təchizatçıya ödəniş etmək» icazəsi).
- **Borc** = açılış borcu + hesablanan məbləğ − ödənişlər. Hesablanan məbləğin əsasını Admin təchizatçı üzrə seçir (təchizatçı formasında): **alınan mal** (defolt; partiyanın sayı × alış qiyməti, mal qəbulu vaxtı ilə) və ya **satılan mal** (komissiyaya götürülmüş mal: yalnız FIFO ilə satılan hissənin alış qiyməti, qaytarmalar çıxılır). Açılış borcu — sistemdən əvvəlki borcdur (avans üçün mənfi). Əsası sonradan dəyişmək keçmiş borcu da yenidən hesablayır.
- **Ödəniş** («Ödəniş et»): **nağd** — məbləğ AÇIQ növbənin kassasından çıxır (adi «kassadan məxaric» kimi də yazılır → gözlənilən nağd azalır, Z hesabatında «o cümlədən təchizatçılara» sətri). Kassada olan nağddan çox çıxmır; növbə açıq olmalıdır. **Bank** — kassaya toxunmur. Borcdan çox ödəniş yalnız təsdiqlə (avans). İcazə: `supplier.pay` (defolt yalnız Admin; Admin matrisdə başqa rola verə bilər).
- **Ləğv**: səbəb məcburidir; nağd idisə məbləğ açıq növbənin kassasına geri mədaxil olur (iki cihaz eyni anda ləğv etsə də yalnız bir mədaxil). Ödənişlər silinmir, ləğv kimi qalır.
- **Hesabat sənədi** («Hesabat sənədi»): dövr (bu gün defolt, dünən, ay, seçilmiş tarixlər, bütün vaxt) üzrə təchizatçının malı olan **çeklər** (qaytarmalar mənfi), **hesablaşma** (əvvəlki borc + hesablanan − ödənişlər = **QALIQ BORC**), ödənişlər və (alınan mal əsasında) alınan mal siyahısı. Çap/PDF (A4), «Paylaş» (telefonda/Windows-da sistem paylaşma pəncərəsi) və «Kopyala» (WhatsApp/e-poçta yapışdırmaq üçün mətn). Sənədin dili ayrıca seçilir (AZ/RU/EN/TR). Sənəd faylı yaradılmır: fayl lazımdırsa «Çap et / PDF» → «PDF kimi saxla».
- Sheets: `SupplierPayments` vərəqi (ödənişlər + ləğv), `Suppliers`-də `debtBasis`, `openingDebt` sütunları, nağd hərəkətlər `CashMoves`-da. Code.gs-i yeniləyəndən sonra `setup()` işlədin.
- **Məhdudiyyətlər:** təchizatçıya mal qaytarma (kredit-nota) və fakturaların özü hələ yoxdur: belə düzəlişi açılış borcuna yazmaq olar; «satılan mal» əsasında offlayn cihaz gec sinxronlaşanda FIFO bölgüsü təchizatçılar arasında düzələ bilər (borc da ona uyğun dəyişir); alış qiyməti 0 olan partiyalar borca düşmür (sənəddə xəbərdarlıq var).

## Giriş forması (rol üzrə PIN və ya şifrə)
Admin **İcazələr** ekranındakı **Giriş forması (rol üzrə)** kartında hər rol üçün seçir: **PIN** (4–8 rəqəm) və ya **şifrə** (≥ 8 simvol, ən azı 1 böyük hərf, 1 kiçik hərf, 1 rəqəm, 1 işarə; boşluq olmaz; ə, ğ, ı, ö, ü, ş, ç hərf sayılır). İlkin vəziyyət: hamı PIN.
- **Dəyişiklikdən sonra** (Admin forma seçib, rolu dəyişib və ya kodu sıfırlayıb) həmin şəxs **öz hazırkı (və ya Admin-in verdiyi) kodu ilə** daxil olur, dərhal yeni kodu **rolun formasında** seçməlidir; seçənə qədər işə keçə bilmir.
- Açıq sessiyalar siyasət dəyişəndə dərhal bağlanmır; məcburi dəyişmə **növbəti girişdə və ya brauzer yenilənəndə** tələb olunur.
- Şifrə **PBKDF2-SHA256, 310 000 təkrar** ilə saxlanılır (`p1$təkrar$hash`; təkrar sayı hash-ın içindədir, gələcəkdə artırmaq olar). Bir şifrəli giriş ~0,1–0,5 san çəkir. PIN-lər köhnə qaydada (SHA-256 + duz) qalır.
- Təsdiq pəncərələri («Menecer PIN-i və ya şifrəsi»): təsdiq edə bilən şəxslərdən biri şifrədədirsə, sahə hər ikisini qəbul edir.
- Server (Sheets) yalnız forma adını yazır (`Users.cred`, `Settings.authPolicy`), kod/hash Audit-ə düşmür.
- **Məhdudiyyət:** siyasət də, istifadəçi hash-ı da digər admin hadisələri kimi token etibarına əsaslanır; tokeni bilən şəxs saxta hadisə göndərə bilər (RİSK-2). Şifrə yalnız oflayn sındırmanı çətinləşdirir (RİSK-1 yalnız şifrəli rollar üçün azalır; PIN rolları 4–8 rəqəm olduğu üçün hələ saniyələrdə tapılır).
- Code.gs-i yeniləyəndən sonra `setup()` işlədin (yeni `Users.cred` sütunu) və yeni versiya dərc edin.

## Arxivləşdirmə (Google Sheets 10 milyon xana həddi)

**Problem.** Google Sheets bir faylda 10 milyon xanaya icazə verir və **boş xanaları da sayır** (vərəqin şəbəkə ölçüsü: sətir × sütun, yeni vərəq 1000 × 26 gəlir). Hər çek `Events` (7 xana), `Sales` (20) və `SaleLines` (hər sətir 10) vərəqlərinə yazılır, ona görə ~50 xana/çek. Dolanda Sheets yazını rədd edir və sinxron dayanır. Hesab (gündə 300 çek): v7-dən əvvəl (26 sütunluq vərəqlər) ~9–10 ay, v7-nin sütun/sətir kəsməsi ilə ~1,5 il, arxivləşdirmə ilə **məhdudiyyətsiz** (canlı cədvəldə yalnız son 45 gün qalır: ~0,7 milyon xana, həddin 7%-i).

**Nə vaxt.** Admin → İcazələr → **Arxiv** kartında "Cədvəl tutumu" göstərilir. Tutum **60%-ə** çatanda və ya ən azı ildə bir dəfə arxivləşdirin. 70%-dən yuxarıda Admin girişdə xəbərdarlıq alır. Yalnız **iş saatından sonra** edin: 1–5 dəqiqə ərzində digər cihazların sinxronu "Server məşğuldur" alıb özü təkrar cəhd edir (kassa satışı isə yerli işləyir, itki yoxdur).

**Addımlar (hər dəfə).**
1. Bütün kassalarda internet olsun, üst paneldə "göndərilməmiş" qeyd qalmasın (Admin kartında "İndi sinxronlaşdır").
2. Admin → İcazələr → Arxiv → **Köhnə qeydləri arxivləşdir** → təsdiq. Pəncərəni bağlamayın (1–5 dəq).
3. "Arxivləşdirildi: N hadisə köçürüldü. Cədvəl tutumu: X%" çıxmalıdır; siyahıda yeni arxiv faylı görünür (linkə klik → Drive-da açılır).
4. Drive-da `7BOXS — Arxiv …` faylını bir dəfə açıb baxın; istəsəniz şəxsi qovluğa köçürün (fayl ID-si dəyişmir, sinxron pozulmur).
5. Hər şey qaydasındadır: cihazlarda heç nə etmək lazım deyil.

**Nə dəyişir.** `Events`, `Sales`, `SaleLines`, `Returns`, `StockReceipts`, `Shifts`, `CashMoves`, `Audit` vərəqlərindən son **45 gündən** köhnə sətirlər arxiv faylına (cədvəlin tam nüsxəsi) köçür; `Events`-də həm də ən azı son **1500** hadisə canlı qalır. `Products`, `Suppliers`, `Users`, `Settings`, `Push` toxunulmur. Cihazlar öz yerli bazasını saxlayır; kursor hadisənin **mütləq nömrəsidir**, ona görə mövcud cihazlar heç nə hiss etmir. Uzun müddət oflayn qalmış və ya yeni qoşulan cihaz çatışan hadisələri arxiv faylından oxuyur. Çek nömrələri arxivdən sonra da təkrarlanmır (ən böyük nömrə yadda saxlanılır).

**Təhlükəsizlik tədbirləri.** Nüsxə yaradılır və `Events`/`Sales`/`SaleLines` sətir sayı yoxlanılır, uyğun gəlməsə **heç nə silinmir**. Silmədən əvvəl vəziyyətə "trim" markeri yazılır: Apps Script yarıda dayansa növbəti sorğu özü tamamlayır və ya təmizləyir. Oxuyan sorğu arxivləşdirmə ilə toqquşsa nəticə atılır, cihaz təkrar soruşur. İki arxivləşdirmə arasında ən azı 24 saat, düymə təsdiq istəyir. Redaktordan: `archiveStatusLog()` (vəziyyət), `archiveNow()` (eyni əməliyyat).

**Etməyin.** Arxiv fayllarını silməyin. `Events` vərəqindən əl ilə sətir silməyin. Script properties-də `ARCHIVE` dəyərini silməyin/dəyişməyin (kursorlar pozular).

**Məhdudiyyətlər (dürüst).**
- Yeni cihazın ilk qoşulması arxiv seqmentlərini də oxuyur: tarixçə böyüdükcə (illər) ilk yükləmə uzanır (hər 500 hadisə ~1–3 san).
- Təkrar göndərmə qoruması canlı pəncərəni əhatə edir (45 gün / 1500 hadisə). 45 gündən çox oflayn qalmış cihaz, əvvəlki göndərməsinin cavabı itibsə, bir hadisəni ikiqat yaza bilər (praktikada çox nadir).
- Arxiv siyahısı Script properties-də saxlanılır (9 KB hədd): onlarla il kifayətdir; dolsa arxivləşdirmə aydın xəta verir.
- Köhnə satışları Sheets-də `Sales` vərəqində yox, arxiv faylında axtarın (tətbiqdəki "Çeklər" cihazın yerli bazasındandır və dəyişmir).
- Real Google Sheets/Drive-da yoxlanılmayıb: məntiq Code.gs-i işlədən təqlidlə (`tests/archive.test.js`) yoxlanılıb. İlk dəfə **test nüsxəsində** edin və Execution log-a baxın. Böyük faylda `copy()` bir neçə dəqiqə çəkə bilər (Apps Script limiti 6 dəq; keçərsə heç nə silinmir, boşa nüsxə faylı qala bilər: silin).

**Code.gs v7-yə keçid.** `apps-script/Code.gs`-i yapışdırın → `setup()` işə salın (ilk dəfə Drive/Sheets üçün əlavə icazə istəyə bilər; **Allow**; eyni zamanda 26 sütunluq vərəqlərin boş sütun və sətirlərini kəsir: xana sayı ~340 mindən ~35 minə düşür) → Deploy → Manage deployments → ✏️ → **New version**. Köhnə v6 skript işləməyə davam edir, amma Arxiv kartı "Skript köhnədir" göstərir.

## Testlər

```bash
npm install
npm test                       # aşağıdakı node testləri birlikdə (brauzer testləri ayrıca: npm run test:e2e)
node tests/run.js              # qaydalar, pul, barkod
node tests/services.test.js    # satış/qaytarma/növbə/PIN/təsdiq axınları (tək cihaz)
node tests/sync.test.js        # 2+ cihaz + Code.gs təqlidi: PIN, məhsul, qalıq, çek, təsdiq, oflayn, təkrar, səhifələmə
node tests/archive.test.js     # arxivləşdirmə: 2500 hadisə, köhnə kursor arxivdən oxuyur, soyuq cihaz eyni vəziyyəti alır, yarımçıq qalma bərpası, xətada heç nə silinmir, xana sayı azalır
node tests/auth.test.js        # rol üzrə PIN/şifrə: siyasət, şifrə qaydaları, PBKDF2 (Node ilə eyni), məcburi dəyişmə, rol dəyişimi, bloklama, saxta siyasət hadisələri
node tests/supplier.test.js    # tədarükçü borcu: iki əsas, ödəniş/ləğv, kassaya təsir, icazələr, sinxron, saxta hadisələr, 4 dildə hesabat sənədi
node tests/migrate.test.js     # köhnə (v1) brauzer bazasının yeni sxemə keçməsi
node tests/push.test.js        # server push: P-256/ES256 hesabı Node kriptoqrafiyası ilə yoxlanır, kimə push gedir, xəta halları
node tests/notify.test.js      # brauzer tərəfi: abunə, icazə, qeydiyyat/söndürmə, test, yerli bildiriş (API-lər təqlid olunur)
node tests/sw.test.js          # service worker: push/klik məntiqi
node tests/i18n.test.js        # dillər: hər _t açarının ru/en/tr tərcüməsi, {0} yer tutucuları, hərf yoxlaması, ehtiyat davranış, çekin ayrı dili, SW bildiriş dili
node tests/fifo.test.js        # FIFO bölgüsü, təchizatçı hesabatı, borc/qaytarma/artıq qaytarma (saf funksiyalar, təsadüfi ssenarilər)
python3 tests/e2e.py           # brauzerdə uçdan-uca, tək cihaz (Playwright lazımdır)
python3 tests/e2e_sync.py      # iki ayrı brauzer yaddaşı + Apps Script təqlidi: PIN bazaya yazılır, 2-ci brauzerdə işləyir, menecer təsdiqi
node tests/fuzz.test.js [N]    # təsadüfi çoxcihazlı əməliyyatlar + şəbəkə xətaları: bütün cihazlar eyni nəticəyə gəlməlidir (N toxum, defolt 12)
python3 tests/e2e_lang.py      # real Chromium: AZ/RU/EN/TR — dil dəyişəndə giriş və yarımçıq çek qalır, bütün bölmələr tərcümə olunub (tərcüməsiz mətn yoxdur), çek dili ayrıdır, 390 px ekranda yana sürüşmə yoxdur
python3 tests/e2e_notify.py    # real Chromium: service worker-ə push çatdırılır, bildirişin ikon/badge/mətni, ikon faylları, "Bildiriş" pəncərəsi (tam Chromium lazımdır)
python3 tests/e2e_print.py     # çap: çek/etiket PDF ölçüləri, səhifə sayı, barkod 203/300 dpi-də oxunur (pip: pypdf pillow zxing-cpp; sistem: poppler-utils)
python3 tests/e2e_latency.py   # real Apps Script gecikməsi (~2,3 san/sorğu) + 15% xəta + ilişmiş sorğu təqlidi ilə 2 brauzer; ölçülmüş gecikmələri yazır
node tests/security.test.js     # "hack" sınağı: token/giriş qapıları, saxta hadisələr, PIN-in sındırılması, rol keçidi; açıq risklər hesabata düşür (SEC_OUT qovluğuna JSON yazır)
node tests/clock.test.js        # cihaz saatı səhvdirsə (2 gün irəli / 20 dəq. geri) hadisə damğaları server saatına görə düzəlir
python3 tests/e2e_xss.py        # real Chromium: CSP, XSS yükləri (ad/qeyd/şablon), çərçivəyə salma, CSV formulları
python3 tests/e2e_scanner.py    # barkod skaneri (sürətli klaviatura axını), fokus başqa yerdə olanda skan, Enter-in təkrar basılması
python3 tests/e2e_offline.py    # PWA: internet kəsilir → yeniləmə, yeni tab, satış; qayıdanda hamısı serverə çatır (öz imzalı HTTPS server qurur)
python3 tests/e2e_a11y.py       # əlçatanlıq (WCAG 2.1 A/AA, axe-core: `npm i -D axe-core`), kompüter və telefon ölçüsü
node tests/stress.test.js [N]   # yük: 3 kassa × N satış (defolt 800), yeni cihazın yüklənməsi, oflayn yığılma, paralel sinxron, böyük çek; Sheets tutumu hesablanır
```

**Çapı işə salmaq (Windows + Chrome):** Xprinter sürücüsünü quraşdırın; çap pəncərəsində *Printer* — Xprinter, *Miqyas* — 100%, *Kənar boşluqlar* — Yoxdur, *Başlıq və sonluq* — söndürülü. Hər çekdə pəncərə çıxmasın deyirsinizsə, Chrome-u `chrome.exe --kiosk-printing --app=<ünvan>` ilə açın: çap pəncərəsiz, defolt printerə gedir (Xprinter-i Windows-da defolt edin; etiket printeri ayrıdırsa, onu başqa kompyuterdə və ya başqa brauzer profilində defolt edin). Çek printerində sürücünün kağızı "80mm × Receipt" (və ya 58 mm) olmalıdır. Test çapında çərçivə kəsilirsə "Çap" pəncərəsində "Kağız ölçüsü: Çap sürücüsünün ölçüsü" seçin. Çox uzun çeklərdə (50+ sətir) sürücü maksimum uzunluğu məhdudlaşdıra bilər, o halda da həmin seçim işləyir.
Real printer olmadan yoxlanılan: PDF ölçüləri, səhifə sayı, mətnin kəsilməməsi, barkodun printer sıxlığında oxunması (`tests/e2e_print.py`). **Yoxlanıla bilməyən:** sizin konkret printerin sürücüsünün kağızı qəbul etməsi və termo başlığın qaralığı — ona görə ilk dəfə test çeki və test etiketi çap edin.

**Giriş kodunu unutmusunuzsa (Admin də):** Apps Script redaktorunda `resetAdminPin()` funksiyasını işə salın. Admin üçün təsadüfi müvəqqəti PIN yaranır (Admin rolu şifrəyə keçirilibsə də PIN verilir: daxil olur və dərhal şifrə seçməlidir) və Logs-da (View → Logs / Execution log) göstərilir; cihazlar onu bir neçə saniyəyə alır, Admin girişdən sonra yeni PIN seçməlidir.

**Code.gs v6-ya keçid (v3/v4/v5-dən):** `apps-script/Code.gs`-i köhnənin yerinə yapışdırın → `setup()` işə salın → Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy (ünvan və token dəyişmir). `setup()` işlədəndə Google "Connect to an external service" icazəsi istəyəcək (bildiriş üçün) — təsdiqləyin. Sonra hər brauzerdə Ctrl+F5. Bildiriş üçün hər menecer cihazında "Bildiriş → Aktiv et" və "Test bildirişi" edin. `setup()` `Suppliers` və `Push` vərəqlərini yaradır və `StockReceipts`-ə yeni sütunları (təchizatçı, partiya) əlavə edir; onu işə salmasanız da vərəqlər ilk yazıda yaranır, amma köhnə `StockReceipts` başlığı yenilənməz.

## Təhlükəsizlik (GitHub Pages + Google Sheets/Apps Script)

**Model:** serverə giriş yalnız `SYNC_TOKEN` ilə olur; token kimdədirsə, "tərəfdaş cihaz"dır. Rollar (Kassir/Menecer/Admin) və PIN-lər **brauzerdə** yoxlanılır, server istifadəçini tanımır. Bu mərhələdə bu, bilinən məhdudiyyətdir (`tests/security.test.js` RİSK-1…8). Ona görə əsas qoruma: **token və cədvəl məxfi qalsın, cihazlar etibarlı olsun**.

**Mütləq edin:**
1. **Token ≥ 32 təsadüfi simvol** olsun (Apps Script → Project Settings → Script properties → `SYNC_TOKEN`). Dəyişəndə hər cihazda "Serverə qoş"da yenisini yazın. Token-i heç vaxt GitHub-a, mesajlaşma qruplarına, skrinşotlara qoymayın; kimsə işdən çıxanda tokeni dəyişin.
2. **Cədvəl (Sheets) yalnız sizin hesabda qalsın:** "Share" → *Restricted*, heç kimə "link ilə" açmayın. Bu faylı yalnız Admin görsün (mühasib hesabat istəyirsə, ayrıca *Viewer* kimi və yalnız adı ilə). Apps Script veb-tətbiqi "Execute as: Me", "Who has access: Anyone" qalır (token bunu qoruyur), amma ünvanı (`/exec`) açıq yerdə paylaşmayın.
3. **Standart PIN-ləri dəyişin / artıq lazım olmayan hesabları söndürün** (Mühasib 1/2 hələ standart PIN-dədir; PIN-lər kodda və GitHub-da açıqdır). Admin və Menecer üçün PIN-dən çox **şifrə** forması seçin (Giriş forması kartı); PIN qalırsa ≥ 6 rəqəm. 5 səhv cəhddən sonra 5 dəq. bloklama var və yenilənmə ilə sıfırlanmır.
4. **Google və GitHub hesablarında 2FA** (Authenticator/passkey). Bu iki hesab bütün sistemin açarıdır: GitHub-a giriş = kodu dəyişib bütün kassalara zərərli skript göndərmək.
5. **Kassa cihazı:** ayrıca Windows hesabı, avtomatik ekran kilidi, kiosk rejimi (`chrome --kiosk-printing --app=...`), brauzerdə başqa sayt/uzantı olmasın. Brauzerin DevTools-u olan şəxs PIN-siz Admin ola bilər (RİSK-7), bunu yalnız cihaz nəzarəti azaldır.
6. **Cihazın saatı "avtomatik" olsun.** Səhv saat çek tarixini pozur; tətbiq artıq server saatına görə damğaları düzəldir və üst paneldə "Saat səhvdir" göstərir, amma düzgün həll avtomatik saatdır.
7. **Ehtiyat nüsxə:** Sheets → File → Version history avtomatik var; əlavə olaraq həftədə bir *File → Make a copy* (başqa Drive qovluğuna) edin. Audit və Events vərəqlərini silməyin: araşdırma yalnız onlarla mümkündür.

**GitHub Pages haqqında:**
- Repo **public**-dirsə kod, `SPREADSHEET_ID`, demo PIN-lər və commit müəllifinin e-poçtu hamıya görünür. Təhlükəsizlik tokenə əsaslandığı üçün bu kritik deyil, amma ID-ni gizli saxlamaq mümkün deyil. Gizli repo + Pages ödənişli planda mümkündür; alternativ: Cloudflare Pages/Netlify (gizli repo ilə pulsuz).
- Eyni hesabın bütün Pages saytları (`<user>.github.io/...`) **bir mənşəni (origin)** paylaşır: orada başqa layihə/sayt yerləşdirməyin, çünki onun skripti bu tətbiqin IndexedDB-sini (token daxil) oxuya bilər (RİSK-8). Tövsiyə: ayrıca GitHub hesabı və ya öz domeniniz.
- GitHub HTTP başlıq (header) təyin etməyə imkan vermir. Tətbiq CSP-ni `<meta>` ilə tətbiq edir (`default-src 'self'`, yalnız `script.google.com` və Google Fonts-a icazə), çərçivəyə salınma isə JavaScript ilə bloklanır. Başlıqlı CSP lazımdırsa, saytı Cloudflare Pages/Netlify-ə qoyun (`_headers` faylı ilə başlıq təyin olunur).
- `main` budağını qoruyun (Settings → Branches → Require PR/status checks), Actions secrets-ə token qoymayın, Dependabot-u açın.
- Google Fonts hər cihazdan Google-a sorğu göndərir (məxfilik); istəsəniz şriftləri `fonts/` qovluğuna endirib `'self'`-dən verin.

**Kod səviyyəsində edilənlər (bu mərhələ):** CSP; XSS yoxlaması (ad, qeyd, şablon, URL); CSV/Excel formul inyeksiyasının zərərsizləşdirilməsi; serverdən gələn hadisələrin tip/uzunluq/aralıq yoxlaması (zəhərli hadisə bütün cihazları dondura bilməz); girişdə bloklamanın yenilənmədən sonra qalması; service worker yalnız uğurlu cavabları saxlayır; token müqayisəsi sabit vaxtlıdır, `doPost` boş/yanlış gövdədə çökmür; nömrə aralıqları serverdə 1000 ilə məhdud; çekdə ≤ 100 sətir (Sheets xanası 50 000 simvol).

**Açıq risklər (Səviyyə 2 – BRD v1.3 üçün):** server tərəfində istifadəçiyə bağlı imza / cihaz açarları, PIN hash-larının cihazlara yayılmaması, hadisələrin rol əsasında serverdə rədd edilməsi. Bunlar olmadan token-i əldə edən daxili şəxs saxta hadisə göndərə bilər (RİSK-1…6); audit izində hadisənin hansı cihazdan gəldiyi görünür.

## Struktur

```
index.html  manifest.json  sw.js
css/app.css
js/i18n.js      dillər: _t(), dil seçimi (cihaza aiddir), ehtiyat davranış
js/lang-ru.js   rus dili tərcümələri  (lang-en.js — ingilis, lang-tr.js — türk)
js/money.js     pul (qəpiklə, float yox)
js/barcode.js   EAN-13, mağaza və çek barkodu, SVG (svgMm: printer nöqtəsinə uyğun çap barkodu)
js/rules.js     biznes qaydaları (saf funksiyalar)
js/db.js        IndexedDB, atomik tranzaksiyalar
js/services.js  satış, qaytarma, növbə, məhsul, giriş, audit
js/fifo.js      FIFO bölgüsü və təchizatçı hesabatı (saf funksiyalar)
js/notify.js    bildirişlər: Web Push abunəsi, icazə, test, yerli bildiriş
js/replica.js   başqa cihazlardan gələn hadisələrin lokal bazaya tətbiqi
js/sync.js      outbox ⇄ Apps Script (göndər + al, nömrə aralıqları)
js/ui.js        modal, PIN təsdiqi, bildirişlər
js/print.js     çek/etiket şablonları, kağız/etiket ayarları, çap
js/pos.js       kassa ekranı
js/screens.js   giriş, məhsullar, təchizatçılar, qaytarma, növbə, çeklər, icazələr
js/app.js       menyu və marşrutlar
apps-script/Code.gs
tools/i18n-scan.js  AST tarayıcısı: _t açarlarını çıxarır, _t-siz qalmış mətni tapır
icons/          tətbiq ikonları (SVG + PNG), bildiriş badge-i; tools/make-icons.py ilə yenidən yaradılır
tests/
```
