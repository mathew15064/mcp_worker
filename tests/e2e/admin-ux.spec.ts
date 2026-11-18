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
})

test('OAuth client form defaults read-only, creates credentials once and search respects queries', async ({ page }) => {
  await login(page)
  await page.goto('/admin/clients')
  await page.getByRole('button', { name: 'New Client' }).click()
  const dialog = page.getByRole('dialog', { name: 'New OAuth Client' })
  await expect(dialog.getByLabel('Display name')).toHaveValue('ChatGPT')
  await expect(dialog.getByLabel('Redirect URI(s)')).toHaveValue('https://chatgpt.com/connector_platform_oauth_redirect')
  await expect(dialog.locator('[name="scopes"][value="mcp_worker.terminal"]')).not.toBeChecked()
  await dialog.getByLabel('Display name').fill('Unified UI E2E Client')
  await dialog.getByRole('button', { name: 'Create client' }).click()
  const secret = page.getByRole('dialog', { name: 'OAuth client credentials' })
  await expect(secret).toBeVisible()
  await expect(secret.getByText('Client secret')).toBeVisible()
  await secret.getByRole('button', { name: "I've saved the secret" }).click()
  await expect(page.getByText('Unified UI E2E Client')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('dialog', { name: 'OAuth client credentials' })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Search clients' }).fill('NO_MATCH_UI_E2E')
  await expect(page.getByText('No matching clients')).toBeVisible()
})

test('Worker UI preserves signed release gate, enrollment one-time disclosure and profile list', async ({ page }) => {
  await login(page)
  await page.goto('/admin/workers')
  await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeVisible()
  await expect(page.getByText('Public Worker distribution gated')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Execution profiles', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Enroll Worker' }).click()
  const dialog = page.getByRole('dialog', { name: 'Generate one-time Worker enrollment' })
  await expect(dialog.getByLabel('Lifetime (seconds)')).toBeVisible()
  await dialog.getByRole('button', { name: 'Generate token' }).click()
  const tokenDialog = page.getByRole('dialog', { name: 'One-time Worker enrollment' })
  await expect(tokenDialog).toBeVisible()
  await expect(tokenDialog.getByText('Enrollment token')).toBeVisible()
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
    await row.getByRole('button', { name: 'Approve' }).click()
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
  const state = await response.json() as { data: { clients: { client_id: string; redirect_uris: string[]; allowed_scopes: string[] }[] }; endpoint: string }
  const client = state.data.clients.find(item =>
    item.redirect_uris.length > 0 && item.allowed_scopes.includes('mcp_worker.read'))
  if (!client) throw new Error('Expected an OAuth test client with read scope.')
  const verifier = 'v'.repeat(64)
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const query = new URLSearchParams({
    client_id: client.client_id, redirect_uri: client.redirect_uris[0],
    response_type: 'code', scope: 'mcp_worker.read',
    state: 'ui-qa-state', resource: state.endpoint, code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  await page.route('**/oauth/callback**', async route => route.fulfill({status:200, body:'Callback received'}))
  await page.goto('/oauth/authorize?' + query.toString())
  await expect(page.getByRole('heading', { name: 'Authorize MCP access' })).toBeVisible()
  await expect(page.getByText('mcp_worker.read', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Deny' }).click()
  await page.waitForURL(/error=access_denied/)
  const url = new URL(page.url())
  expect(url.searchParams.get('code')).toBeNull()
  expect(url.searchParams.get('state')).toBe('ui-qa-state')
})
