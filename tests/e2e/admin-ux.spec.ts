import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
// Keep the UI acceptance test typed and self-contained: the historical
// CommonJS test fixture is not a type-safe ESM import in this suite.
async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('PlaywrightAdmin2026!')
  await Promise.all([
    page.waitForURL(/\/admin$/),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ])
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
}

function captureConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function measureOverflow(page: Page) {
  return page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))
}

test('unified admin login, role navigation, keyboard controls and zero console errors', async ({ page }) => {
  const errors = captureConsoleErrors(page)
  await login(page)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('link', { name: 'Users' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Switch theme' })).toBeVisible()
  await expect(page.getByText('SQLite').first()).toBeVisible()
  expect(errors).toEqual([])
})

test('dashboard shows real runtime counters, endpoint, and resource navigation', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('heading', { name: 'Runtime Information' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'System configuration' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'MCP endpoint' })).toBeVisible()
  await expect(page.getByText('15', { exact: true }).first()).toBeVisible()
  await page.getByRole('link', { name: 'OAuth Clients' }).first().click()
  await expect(page.getByRole('heading', { name: 'OAuth Clients', exact: true })).toBeVisible()
})

test('Getting Started preserves six readiness steps and never claims external ChatGPT verification', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Getting Started' }).click()
  await expect(page.getByRole('heading', { name: 'Getting Started' })).toBeVisible()
  await expect(page.locator('[data-onboarding-step]')).toHaveCount(6)
  await expect(page.locator('[data-chatgpt-verification]')).toHaveAttribute('data-chatgpt-verification', 'unverified')
  await expect(page.getByText('External ChatGPT verification is manual')).toBeVisible()
})

test('Admin Users offers approval, toggles, scoped management and a create form', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Users' }).click()
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Allow account requests' })).toBeChecked()
  await expect(page.getByRole('switch', { name: 'Enable verified execution' })).not.toBeChecked()
  await page.getByRole('button', { name: 'Create user', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create user' })
  await expect(dialog.getByLabel('Username')).toBeVisible()
  await expect(dialog.getByLabel('Initial password')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  const username = 'menutest' + Date.now().toString(36)
  await page.getByRole('button', { name: 'Create user' }).click()
  await dialog.getByLabel('Username').fill(username)
  await dialog.getByLabel('Display name').fill('Actions Menu Test User')
  await dialog.getByLabel('Initial password').fill('MenuTestPassword2026!')
  await dialog.getByRole('button', { name: 'Create active user' }).click()

  const row = page.getByRole('row').filter({ hasText: username })
  await expect(row.getByText('active', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'Actions for ' + username }).click()
  await expect(page.getByRole('menuitem', { name: 'Disable' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Disable' }).locator('svg[aria-hidden="true"]')).toHaveCount(1)
  await page.getByRole('menuitem', { name: 'Reset password' }).click()
  const reset = page.getByRole('dialog', { name: 'Reset password · ' + username })
  await expect(reset.getByLabel('New password')).toBeVisible()
  await reset.getByRole('button', { name: 'Cancel' }).click()
  await expect(reset).toHaveCount(0)
  await row.getByRole('button', { name: 'Actions for ' + username }).click()
  await page.getByRole('menuitem', { name: 'Disable' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Disable?' })
  await expect(confirm).toContainText('Disabling a user revokes sessions')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(row.getByText('active', { exact: true })).toBeVisible()
})

test('Generic OAuth registration, MCP URL and one-time secret have safe modal dismissal', async ({ page }) => {
  await login(page)
  await page.goto('/admin/clients')
  const stateResponse = await page.request.get('/api/ui/state?view=%2Fadmin%2Fclients')
  const state = await stateResponse.json() as { endpoint: string }

  await page.getByRole('button', { name: 'New Client' }).click()
  const dialog = page.getByRole('dialog', { name: 'New OAuth Client' })
  await expect(dialog.getByLabel('Display name')).toBeEmpty()
  await expect(dialog.getByLabel('Redirect URI(s)')).toBeEmpty()
  await expect(dialog.getByText(state.endpoint)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy MCP URL' })).toBeVisible()
  await expect(dialog.locator('[name="scopes"][value="mcp_worker.terminal"]')).not.toBeChecked()

  await page.mouse.click(16, 260)
  await expect(dialog).toHaveCount(0) // clean modal closes on outside click
  await page.getByRole('button', { name: 'New Client' }).click()
  await dialog.getByLabel('Display name').fill('Unified UI E2E Client')
  await page.mouse.click(16, 260)
  await expect(dialog).toBeVisible() // unsubmitted fields are protected
  await dialog.getByLabel('Redirect URI(s)').fill('https://example.org/oauth/callback')
  await dialog.getByRole('button', { name: 'Create client' }).click()

  const secret = page.getByRole('dialog', { name: 'OAuth client credentials' })
  await expect(secret).toBeVisible()
  await expect(secret.getByText('Client secret')).toBeVisible()
  await expect(secret.getByText(state.endpoint)).toBeVisible()
  await expect(secret.getByRole('button', { name: 'Copy MCP URL' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.mouse.click(16, 260)
  await expect(secret).toBeVisible() // one-time secret cannot be dismissed accidentally
  await secret.getByRole('button', { name: "I've saved the secret" }).click()
  await expect(page.getByText('Unified UI E2E Client')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('dialog', { name: 'OAuth client credentials' })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Search clients' }).fill('NO_MATCH_UI_E2E')
  await expect(page.getByText('No matching clients')).toBeVisible()
})

test('Revoke dialog updates only the selected client and long principal stays inside its column', async ({ page }) => {
  await login(page)
  await page.goto('/admin/clients')

  for (const name of ['Keep Active UI Client', 'Revoke UI Client']) {
    await page.getByRole('button', { name: 'New Client' }).click()
    const create = page.getByRole('dialog', { name: 'New OAuth Client' })
    await create.getByLabel('Display name').fill(name)
    await create.getByLabel('Redirect URI(s)').fill('https://ai.example/oauth/callback')
    await create.getByRole('button', { name: 'Create client' }).click()
    await page.getByRole('dialog', { name: 'OAuth client credentials' })
      .getByRole('button', { name: "I've saved the secret" }).click()
  }

  const target = page.locator('tbody tr').filter({ hasText: 'Revoke UI Client' })
  const other = page.locator('tbody tr').filter({ hasText: 'Keep Active UI Client' })
  await expect(target).toBeVisible()
  await expect(other.getByText('active', { exact: true })).toBeVisible()

  const principal = target.getByRole('button', { name: 'Copy principal ID for Revoke UI Client' })
  await principal.evaluate((button) => {
    const text = button.querySelector('span')
    if (text) text.textContent = 'a'.repeat(240)
  })
  const bounds = await principal.evaluate((button) => {
    const cell = button.closest('td')
    const next = cell?.nextElementSibling
    const text = button.querySelector('span')
    return {
      columnEndsBeforeNext: Boolean(cell && next && cell.getBoundingClientRect().right <= next.getBoundingClientRect().left + 1),
      textTruncated: Boolean(text && text.scrollWidth > text.clientWidth),
    }
  })
  expect(bounds.columnEndsBeforeNext).toBe(true)
  expect(bounds.textTruncated).toBe(true)

  await target.getByRole('button', { name: 'Actions for Revoke UI Client' }).click()
  await expect(page.getByRole('menuitem', { name: 'Revoke' }).locator('svg[aria-hidden="true"]')).toHaveCount(1)
  await page.getByRole('menuitem', { name: 'Revoke' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Revoke OAuth client?' })
  await expect(confirm).toContainText('All existing access and refresh tokens')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(target.getByText('active', { exact: true })).toBeVisible()
  await target.getByRole('button', { name: 'Actions for Revoke UI Client' }).click()
  await page.getByRole('menuitem', { name: 'Revoke' }).click()
  await page.getByRole('alertdialog', { name: 'Revoke OAuth client?' })
    .getByRole('button', { name: 'Confirm Revoke' }).click()
  await expect(target.getByText('revoked', { exact: true })).toBeVisible()
  await target.getByRole('button', { name: 'Actions for Revoke UI Client' }).click()
  await expect(page.getByRole('menuitem', { name: 'Revoke' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(other.getByText('active', { exact: true })).toBeVisible()
})

test('Worker action picker keeps probe and guarded destructive/form actions accessible', async ({ page }) => {
  await login(page)
  await page.goto('/admin/workers')
  const row = page.getByRole('row').filter({ hasText: 'Playwright Worker' })
  const trigger = row.getByRole('button', { name: 'Actions for Playwright Worker' })
  await expect(trigger).toBeVisible()
  await trigger.click()
  const menu = page.getByRole('menu')
  for (const action of ['Probe', 'Rename', 'Disable', 'Remove', 'Force remove']) {
    await expect(menu.getByRole('menuitem', { name: action, exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: action, exact: true }).locator('svg[aria-hidden="true"]')).toHaveCount(1)
  }
  await menu.getByRole('menuitem', { name: 'Rename' }).click()
  const rename = page.getByRole('dialog', { name: 'Rename Worker' })
  await expect(rename.getByLabel('Worker name')).toHaveValue('Playwright Worker')
  await rename.getByRole('button', { name: 'Cancel' }).click()
  await expect(rename).toHaveCount(0)
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Disable' }).click()
  const disable = page.getByRole('alertdialog', { name: 'Disable?' })
  await expect(disable).toBeVisible()
  await disable.getByRole('button', { name: 'Cancel' }).click()
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Force remove' }).click()
  const force = page.getByRole('alertdialog', { name: 'Force delete Worker record?' })
  await expect(force).toContainText('Remote files may remain')
  await force.getByRole('button', { name: 'Cancel' }).click()
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Probe' }).click()
  await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeVisible()

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 850 })
    await trigger.click()
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
    const size = await measureOverflow(page)
    expect(size.scroll, 'Worker menu overflows at ' + width).toBeLessThanOrEqual(size.width + 1)
    await page.keyboard.press('Escape')
  }
})

test('Worker tabs are compact, shareable and avoid page-level overflow', async ({ page }) => {
  await login(page)
  await page.goto('/admin/workers')
  const sections = page.getByRole('tablist', { name: 'Worker sections' })
  const workersTab = sections.getByRole('tab', { name: 'Workers', exact: true })
  const installTab = sections.getByRole('tab', { name: 'Install Worker' })

  await expect(sections.getByRole('tab')).toHaveCount(2)
  await expect(workersTab).toHaveAttribute('data-state', 'active')
  await expect(page.getByRole('button', { name: 'Enroll Worker' })).toBeVisible()
  await expect(page.getByText('Execution Profiles', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New profile' })).toHaveCount(0)
  await installTab.click()
  await expect(page).toHaveURL(/\/admin\/workers\?tab=install$/)
  await expect(page.locator('[data-worker-install-guide]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Get enrollment token' })).toBeVisible()
  await page.reload()
  await expect(installTab).toHaveAttribute('data-state', 'active')
  await workersTab.click()
  await expect(page).toHaveURL(/\/admin\/workers\?tab=workers$/)
  await page.goBack()
  await expect(installTab).toHaveAttribute('data-state', 'active')
  await page.goForward()
  await expect(workersTab).toHaveAttribute('data-state', 'active')
  await page.goto('/admin/workers?tab=profiles')
  await expect(workersTab).toHaveAttribute('data-state', 'active')

  for (const width of [1650, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 850 })
    await installTab.click()
    const size = await measureOverflow(page)
    expect(size.scroll, 'Worker tab page overflow at ' + width).toBeLessThanOrEqual(size.width + 1)
    await workersTab.click()
    await expect(page.getByRole('button', { name: 'Enroll Worker' })).toBeVisible()
    await expect(page.getByText('Execution Profiles', { exact: true })).toHaveCount(0)
  }
})

test('Worker UI preserves signed release gate and one-time enrollment', async ({ page }) => {
  await login(page)
  await page.goto('/admin/workers')
  await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeVisible()
  const sections = page.getByRole('tablist', { name: 'Worker sections' })
  await expect(sections.getByRole('tab', { name: 'Workers', exact: true })).toHaveAttribute('data-state', 'active')
  await sections.getByRole('tab', { name: 'Install Worker' }).click()
  await expect(page.getByText('Public Worker distribution gated')).toBeVisible()
  await page.getByRole('button', { name: 'Get enrollment token' }).click()
  const installEnrollmentForm = page.getByRole('dialog', { name: 'Generate one-time Worker enrollment' })
  await expect(installEnrollmentForm.getByLabel('Lifetime (seconds)')).toHaveValue('600')
  await installEnrollmentForm.getByRole('button', { name: 'Generate token' }).click()
  await expect(page).toHaveURL(/\/admin\/workers\?tab=install$/)
  const installToken = page.getByRole('dialog', { name: 'One-time Worker enrollment' })
  await expect(installToken.getByRole('button', { name: 'Copy token' })).toBeVisible()
  await installToken.getByRole('button', { name: 'Done' }).click()
  const guide = page.locator('[data-worker-install-guide]').first()
  await expect(guide.getByRole('tab', { name: 'Linux' })).toBeVisible()
  const steps = guide.locator('[data-worker-install-steps] > li')
  await expect(steps).toHaveCount(5)
  await expect(steps.getByRole('button', { name: 'Copy command' })).toHaveCount(5)
  for (const [index, title] of [
    'Download the installer',
    'Review the script',
    'Install the Worker',
    'Log in and enroll',
    'Check connection',
  ].entries()) {
    await expect(steps.nth(index)).toContainText(title)
    await expect(steps.nth(index).locator('code')).toHaveCount(1)
    expect(await steps.nth(index).locator('code').innerText()).not.toContain('\n')
  }
  await expect(steps.nth(0).locator('code')).toContainText('install-linux.sh')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const downloadCommand = await steps.nth(0).locator('code').innerText()
  await steps.nth(0).getByRole('button', { name: 'Copy command' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(downloadCommand)
  await expect(steps.nth(3).locator('code')).toContainText('mcp_worker login --server')
  await expect(steps.nth(4).locator('code')).toContainText('mcp_worker status')
  await guide.getByRole('tab', { name: 'macOS' }).click()
  await expect(steps.nth(0).locator('code')).toContainText('install-macos.sh')
  await expect(steps.nth(3).locator('code')).toContainText('mcp_worker login --server')
  await guide.getByRole('tab', { name: 'Windows' }).click()
  await expect(steps.nth(0).locator('code')).toContainText('install-windows.ps1')
  await expect(steps.nth(3).locator('code')).toContainText('mcp_worker login --server')
  await expect(steps.nth(3).locator('code')).not.toContainText('br_enroll_')
  await expect(steps).toHaveCount(5)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 850 })
    const size = await measureOverflow(page)
    expect(size.scroll, 'Worker installation overflows at ' + width).toBeLessThanOrEqual(size.width + 1)
    await expect(steps.nth(4).getByRole('button', { name: 'Copy command' })).toBeVisible()
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await sections.getByRole('tab', { name: 'Workers', exact: true }).click()
  await expect(page).toHaveURL(/tab=workers/)
  await page.getByRole('button', { name: 'Enroll Worker' }).click()
  const dialog = page.getByRole('dialog', { name: 'Generate one-time Worker enrollment' })
  await expect(dialog.getByLabel('Lifetime (seconds)')).toBeVisible()
  await dialog.getByRole('button', { name: 'Generate token' }).click()
  const tokenDialog = page.getByRole('dialog', { name: 'One-time Worker enrollment' })
  await expect(tokenDialog).toBeVisible()
  await expect(tokenDialog.getByText('Enrollment token', { exact: true })).toBeVisible()
  await expect(tokenDialog.getByRole('button', { name: 'Copy token' })).toBeVisible()
  const loginGuide = tokenDialog.locator('[data-worker-login-guide]')
  await expect(loginGuide).toBeVisible()
  await expect(loginGuide.getByRole('tab', { name: 'Linux' })).toBeVisible()
  await expect(loginGuide.locator('[data-worker-install-steps]')).toHaveCount(0)
  await expect(loginGuide.locator('code')).toHaveCount(1)
  await expect(loginGuide.locator('code')).toContainText('mcp_worker login --server')
  await expect(loginGuide.locator('code')).not.toContainText('install-linux.sh')
  await expect(loginGuide.locator('code')).not.toContainText('mcp_worker status')
  await expect(loginGuide.locator('code')).not.toContainText('br_enroll_')
  await loginGuide.getByRole('button', { name: 'Copy command' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText()))
    .toBe(await loginGuide.locator('code').innerText())
  await loginGuide.getByRole('tab', { name: 'Windows' }).click()
  await expect(loginGuide.locator('code')).toContainText('mcp_worker login --server')
  await expect(loginGuide.locator('code')).not.toContainText('install-windows.ps1')
  await page.mouse.click(16, 260)
  await page.keyboard.press('Escape')
  await expect(tokenDialog).toBeVisible()
  await tokenDialog.getByRole('button', { name: 'Done' }).click()
  await page.reload()
  await expect(page.getByRole('dialog', { name: 'One-time Worker enrollment' })).toHaveCount(0)
})

test('Activity provides real audit data, filtering, pagination and sanitized detail', async ({ page }) => {
  await login(page)
  await page.goto('/admin/audit')
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Audit log/ })).toBeVisible()
  await page.getByLabel('Search').fill('runtime_info')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page).toHaveURL(/q=runtime_info/)
  await expect(page.locator('tbody').getByText('runtime_info').first()).toBeVisible()
  const detailButtons = page.getByRole('button', { name: 'View' })
  if (await detailButtons.count()) {
    await detailButtons.first().click()
    await expect(page.getByRole('dialog', { name: 'Audit event detail' })).toBeVisible()
    await expect(page.getByText('Sanitized request metadata and response payload.')).toBeVisible()
  }
})

test('Settings shows database, MCP and Telegram while keeping stored secrets hidden', async ({ page }) => {
  await login(page)
  for (const [section, heading] of [
    ['database', 'SQLite storage'], ['mcp', 'MCP service configuration'],
    ['telegram', 'Telegram configuration'], ['runtime', 'Runtime details'],
  ]) {
    await page.goto('/admin/settings/' + section)
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
  }
  await page.goto('/admin/settings/telegram')
  await expect(page.getByLabel('Bot token')).toHaveAttribute('type', 'password')
  await expect(page.getByText('Token storage')).toBeVisible()
})

test('Anonymous signup -> pending -> admin approval -> isolated user workspace', async ({ page, browser }) => {
  test.setTimeout(60_000)
  const username = 'uiqa' + Date.now().toString(36)
  const userPassword = 'TestOnlyUserAccess2026!'
  const context = await browser.newContext()
  const user = await context.newPage()
  try {
    await user.goto('/register')
    await expect(user.getByRole('heading', { name: 'Create an account' })).toBeVisible()
    await user.getByLabel('Username').fill(username)
    await user.getByLabel('Email').fill(username + '@example.test')
    await user.getByLabel('Display name').fill('UI Test User')
    await user.getByLabel('Password (10+ characters)').fill(userPassword)
    await user.getByRole('button', { name: 'Request access' }).click()
    await expect(user.getByRole('heading', { name: 'Registration received' })).toBeVisible()
    await user.goto('/login')
    await user.getByLabel('Username').fill(username)
    await user.getByLabel('Password').fill(userPassword)
    await user.getByRole('button', { name: 'Sign in' }).click()
    await expect(user.getByText('Sign in failed')).toBeVisible()

    await login(page)
    await page.goto('/admin/users')
    await page.getByRole('textbox', { name: 'Search users' }).fill(username)
    const row = page.getByRole('row').filter({ hasText: username })
    await expect(row.getByText('pending')).toBeVisible()
    await row.getByRole('button', { name: 'Actions for ' + username }).click()
    await page.getByRole('menuitem', { name: 'Approve' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm Approve' }).click()
    await expect(row.getByText('active')).toBeVisible()

    await user.goto('/login')
    await user.getByLabel('Username').fill(username)
    await user.getByLabel('Password').fill(userPassword)
    await user.getByRole('button', { name: 'Sign in' }).click()
    await expect(user.getByRole('heading', { name: /Welcome, UI Test User/ })).toBeVisible()
    await expect(user.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Connect ChatGPT' })).toBeVisible()
    await expect(user.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Users' })).toHaveCount(0)
    await user.goto('/account/connect')
    await expect(user.getByRole('heading', { name: 'Connect ChatGPT' })).toBeVisible()
    await user.goto('/account/tools')
    await expect(user.getByRole('heading', { name: 'My Tools' })).toBeVisible()
    await user.goto('/account/activity')
    await expect(user.getByRole('heading', { name: 'My Activity' })).toBeVisible()
    await user.goto('/account/workers?tab=profiles')
    const userTabs = user.getByRole('tablist', { name: 'Worker sections' })
    await expect(userTabs.getByRole('tab')).toHaveCount(2)
    await expect(userTabs.getByRole('tab', { name: 'Workers', exact: true })).toHaveAttribute('data-state', 'active')
    await expect(user.getByRole('button', { name: 'Enroll Worker' })).toHaveCount(0)
    await userTabs.getByRole('tab', { name: 'Install Worker' }).click()
    await expect(user).toHaveURL(/\/account\/workers\?tab=install$/)
    await expect(user.getByRole('button', { name: 'Get enrollment token unavailable' })).toBeDisabled()
    await expect(user.getByText('Self-service enrollment tokens are unavailable')).toBeVisible()
    await userTabs.getByRole('tab', { name: 'Workers', exact: true }).click()
    await expect(user).toHaveURL(/\/account\/workers\?tab=workers$/)
    await expect(user.getByRole('button', { name: 'Enroll Worker' })).toHaveCount(0)
    await user.goto('/account/profile')
    await expect(user.getByRole('heading', { name: 'Account' })).toBeVisible()
    await user.getByRole('textbox', { name: 'Display name' }).fill('UI Profile Updated')
    await user.getByRole('button', { name: 'Save profile' }).click()
    await expect(user).toHaveURL(/\/account\/profile$/)
    await user.reload()
    await expect(user.getByRole('textbox', { name: 'Display name' })).toHaveValue('UI Profile Updated')

    const denied = await user.request.get('/api/ui/state?view=%2Fadmin%2Fusers', {
      headers: { Accept: 'application/json' },
    })
    expect(denied.status()).toBe(401)
  } finally {
    await context.close()
  }
})

test('Dark/light theme persists and the unified UI has no uncaught browser errors', async ({ page }) => {
  const errors = captureConsoleErrors(page)
  await login(page)
  await page.getByRole('button', { name: 'Switch theme' }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await page.getByRole('button', { name: 'Switch theme' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.goto('/admin/users')
  await page.goto('/admin/clients')
  await page.goto('/admin/workers')
  await page.goto('/admin/audit')
  await page.goto('/admin/settings/database')
  expect(errors).toEqual([])
})

test('Navigation spacing, card padding and Activity filters remain clearly separated', async ({ page }) => {
  await login(page)
  await page.setViewportSize({ width: 1650, height: 920 })
  await page.goto('/admin/users')

  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  const users = await nav.getByRole('link', { name: 'Users' }).boundingBox()
  const activity = await nav.getByRole('link', { name: 'Activity' }).boundingBox()
  if (!users || !activity) throw new Error('Missing navigation geometry')
  expect(activity.y - (users.y + users.height)).toBeGreaterThanOrEqual(5)

  const registrationHeading = page.getByRole('heading', { name: 'Public registration' })
  const card = registrationHeading.locator('xpath=ancestor::*[@data-slot="card"]')
  const headingBox = await registrationHeading.boundingBox()
  const cardBox = await card.boundingBox()
  if (!headingBox || !cardBox) throw new Error('Missing card geometry')
  expect(headingBox.x - cardBox.x).toBeGreaterThanOrEqual(22)

  for (const width of [1650, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 920 })
    await page.goto('/admin/audit')
    const search = await page.locator('#audit-search').boundingBox()
    const client = await page.getByRole('combobox').first().boundingBox()
    const apply = await page.getByRole('button', { name: 'Apply' }).boundingBox()
    if (!search || !client || !apply) throw new Error('Missing filters geometry at ' + width)
    if (client.y < search.y + search.height - 1) {
      expect(client.x - (search.x + search.width)).toBeGreaterThanOrEqual(16)
    } else {
      expect(client.y - (search.y + search.height)).toBeGreaterThanOrEqual(16)
    }
    expect(apply.y).toBeGreaterThan(search.y + search.height + 12)
    const size = await measureOverflow(page)
    expect(size.scroll, 'Activity overflows at ' + width).toBeLessThanOrEqual(size.width + 1)
  }
})

test('Mobile sidebar, pages and tables do not create document-level horizontal overflow', async ({ page }) => {
  await login(page)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 820 })
    await page.goto('/admin')
    const trigger = page.getByRole('button', { name: 'Toggle sidebar' })
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Users' })).toBeVisible()
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Users' }).click()
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible()
    for (const pathname of ['/admin/users', '/admin/workers', '/admin/audit', '/admin/settings/mcp']) {
      await page.goto(pathname)
      const size = await measureOverflow(page)
      expect(size.scroll, 'page overflow at ' + width + 'px for ' + pathname).toBeLessThanOrEqual(size.width + 1)
    }
  }
})

test('OAuth consent uses verified client, PKCE scope and explicitly denies without issuing code', async ({ page }) => {
  await login(page)
  const malformed = await page.request.get('/api/ui/state?view=' + encodeURIComponent('/oauth/authorize?client_id=missing'), { headers: { Accept: 'application/json' } })
  expect(malformed.status()).toBe(400)
  const response = await page.request.get('/api/ui/state?view=%2Fadmin%2Fclients', {
    headers: { Accept: 'application/json' },
  })
  expect(response.status()).toBe(200)
  const state = await response.json() as { data: { clients: { client_id: string; status: string; redirect_uris: string[]; allowed_scopes: string[] }[] }; endpoint: string }
  const client = state.data.clients.find(item =>
    item.status === 'active' &&
    item.redirect_uris.some(uri => uri.startsWith('http://localhost:') && uri.endsWith('/oauth/callback')) &&
    item.allowed_scopes.includes('mcp_worker.read'))
  if (!client) throw new Error('Expected an OAuth test client with read scope.')
  const verifier = 'v'.repeat(64)
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const query = new URLSearchParams({
    client_id: client.client_id, redirect_uri: client.redirect_uris[0],
    response_type: 'code', scope: 'mcp_worker.read',
    state: 'ui-qa-state', resource: state.endpoint, code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  await page.goto('/oauth/authorize?' + query.toString())
  await expect(page.getByRole('heading', { name: 'Authorize MCP access' })).toBeVisible()
  await expect(page.getByText('mcp_worker.read', { exact: true })).toBeVisible()
  const deniedResponse = page.waitForResponse(response =>
    response.url().endsWith('/oauth/authorize') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Deny' }).click()
  const denied = await deniedResponse
  expect(denied.status()).toBe(302)
  const location = denied.headers()['location']
  expect(location).toBeTruthy()
  const callback = new URL(location)
  expect(callback.origin + callback.pathname).toBe(new URL(client.redirect_uris[0]).origin + new URL(client.redirect_uris[0]).pathname)
  expect(callback.searchParams.get('error')).toBe('access_denied')
  expect(callback.searchParams.get('code')).toBeNull()
  expect(callback.searchParams.get('state')).toBe('ui-qa-state')
})
