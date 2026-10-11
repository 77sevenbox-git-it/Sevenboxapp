"""E2E köməkçiləri: yeni cihazın qoşulma qapısı (giriş ekranından əvvəl «ünvan + açar» ekranı)."""


def local_pass(pg):
    """Yeni cihazda qapını «serversiz» keçir (yerli işləyən testlər üçün); qapı yoxdursa (köhnə quraşdırma) heç nə etmir."""
    pg.wait_for_selector('.users button, #connect-gate')
    if pg.locator('#connect-gate').count():
        pg.click('#gate-local')
        pg.get_by_role('button', name='Serversiz davam et', exact=True).click()
        pg.wait_for_selector('.users button')


def gate_connect(pg, url, token, wait=True):
    """Yeni cihazda qapı formasını doldurub serverə qoşul; uğurlu olanda istifadəçi siyahısı görünür."""
    pg.wait_for_selector('#connect-gate')
    pg.fill('#g-url', url); pg.fill('#g-tok', token)
    pg.click('#g-go')
    if wait: pg.wait_for_selector('.users button', timeout=120000)


async def local_pass_async(pg):
    await pg.wait_for_selector('.users button, #connect-gate')
    if await pg.locator('#connect-gate').count():
        await pg.click('#gate-local')
        await pg.get_by_role('button', name='Serversiz davam et', exact=True).click()
        await pg.wait_for_selector('.users button')


async def gate_connect_async(pg, url, token):
    await pg.wait_for_selector('#connect-gate')
    await pg.fill('#g-url', url); await pg.fill('#g-tok', token)
    await pg.click('#g-go')
    await pg.wait_for_selector('.users button', timeout=120000)
