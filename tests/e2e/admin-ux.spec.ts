import { test, expect } from '@playwright/test';
import helpers = require('./fixtures/helpers');
const { login, captureConsoleErrors } = helpers;

test.describe.configure({ mode: 'serial' });

test('login and admin navigation are keyboard/accessibility friendly', async ({ page }) => {
  const errors = captureConsoleErrors(page);
  await login(page);

  const overview = page.getByRole('link', { name: 'Overview' });
  await expect(overview).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('button', { name: /theme/i })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Getting Started exposes database readiness and six guided steps', async ({ page }) => {
  await login(page);
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Getting Started' })
    .click();
  await expect(page.getByRole('heading', { name: 'Getting Started' })).toBeVisible();
  await expect(page.locator('[data-onboarding-step]')).toHaveCount(6);
  await expect(page.getByText('Next step: 2')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Database settings', exact: true })).toBeVisible();
});

test('Audit Log traces client tool activity and supports client/tool/result filtering', async ({
  page,
}) => {
  await login(page);
  await page.goto('/admin/audit');

  await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();
  const auditClientValue = await page
    .getByLabel('Filter by client')
    .locator('option')
    .filter({ hasText: 'ChatGPT Connector' })
    .getAttribute('value');
  await page.getByLabel('Filter by client').selectOption(auditClientValue);
  await page.getByLabel('Filter by tool').selectOption('runtime_info');
  await page.getByLabel('Filter by result').selectOption('SUCCESS');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/client_id=.*tool_name=runtime_info.*result=SUCCESS/);
  await expect(page.locator('#audit-table tbody tr')).toHaveCount(1);
  const runtimeRow = page.locator('#audit-table tbody tr').filter({ hasText: 'runtime_info' });
  await expect(runtimeRow).toContainText('ChatGPT Connector');
  await expect(runtimeRow).toContainText('req_playwright_runtime_info');
  await expect(runtimeRow).toContainText('SUCCESS');
  await expect(page.locator('#audit-table').getByText('terminal_list')).toHaveCount(0);

  await runtimeRow.getByRole('button', { name: 'View' }).click();
  const detailDialog = page.getByRole('dialog', { name: 'Audit Event Detail' });
  await expect(detailDialog).toBeVisible();
  await expect(detailDialog.locator('#audit-request-payload')).toContainText('"profile": "Codex"');
  await expect(detailDialog.locator('#audit-response-payload')).toContainText('runtime ready');
  await detailDialog.getByRole('button', { name: 'Close' }).click();

  await page.goto('/admin/clients');
  await page.getByRole('button', { name: 'Actions for ChatGPT Connector' }).click();
  await page.getByRole('menuitem', { name: 'View Activity' }).click();
  await expect(page).toHaveURL(/\/admin\/audit\?client_id=/);
  await expect(page.getByLabel('Filter by client')).toHaveValue(/br_client_/);
});

test('Audit Log pagination stays compact and page-size changes update the result window', async ({
  page,
}) => {
  await login(page);
  await page.goto('/admin/audit');

  await expect(page.locator('#audit-table tbody tr')).toHaveCount(20);
  await expect(page.getByRole('navigation', { name: 'Audit log pagination' })).toBeVisible();
  await expect(
    page.getByLabel('Audit log pagination').getByRole('link', { name: '2', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Showing/)).toContainText('1–20');

  await page.getByLabel('Rows').selectOption('50');
  await expect(page).toHaveURL(/per_page=50/);
  await expect(page.locator('#audit-table tbody tr')).toHaveCount(27);

  await page.getByLabel('Rows').selectOption('20');
  await page
    .getByRole('navigation', { name: 'Audit log pagination' })
    .getByRole('link', { name: '2', exact: true })
    .click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText(/Showing/)).toContainText('21–27');

  await page.setViewportSize({ width: 1440, height: 760 });
  await page.goto('/admin/audit?per_page=50');
  const scrollState = await page.locator('.audit-section > .table-wrap').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
    bottom: element.getBoundingClientRect().bottom,
    viewport: window.innerHeight,
  }));
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  expect(['auto', 'scroll']).toContain(scrollState.overflowY);
  expect(scrollState.bottom).toBeLessThanOrEqual(scrollState.viewport);
  const header = page.locator('#audit-table thead th').first();
  const before = await header.boundingBox();
  await page.locator('.audit-section > .table-wrap').evaluate((element) => {
    element.scrollTop = 320;
  });
  const after = await header.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(3);
});

test('desktop sidebar can collapse, persists the preference, and toasts stack from the top', async ({
  page,
}) => {
  await login(page);

  const sidebar = page.locator('#admin-sidebar');
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  const expandedWidth = (await sidebar.boundingBox())!.width;
  await collapse.click();
  await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/);
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  const collapsedWidth = (await sidebar.boundingBox())!.width;
  expect(collapsedWidth).toBeLessThan(expandedWidth);

  await page.reload();
  await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/);
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.locator('body')).not.toHaveClass(/sidebar-collapsed/);

  await page.goto('/admin/settings/telegram');
  await page.getByRole('button', { name: 'Edit Configuration' }).first().click();
  await page
    .getByRole('dialog', { name: 'Edit Telegram Configuration' })
    .getByRole('button', { name: 'Save Changes' })
    .click();
  const toast = page
    .getByRole('status')
    .filter({ hasText: 'Telegram settings saved to database.' });
  await expect(toast).toBeVisible();
  const box = await toast.boundingBox();
  expect(box!.y).toBeLessThan(120);
});

test('OAuth modal traps focus, restores focus, creates a one-time secret, and search has an empty result state', async ({
  page,
}) => {
  await login(page);
  await page.goto('/admin/clients');

  const trigger = page.getByRole('button', { name: 'New Client' }).first();
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'New OAuth Client' });
  await expect(dialog).toBeVisible();
  const scopeChecks = dialog.locator('.scope-option input[type="checkbox"]');
  await expect(scopeChecks).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    const box = await scopeChecks.nth(index).boundingBox();
    expect(box!.width).toBeLessThanOrEqual(20);
    expect(box!.height).toBeLessThanOrEqual(20);
  }
  await expect(page.getByLabel('Display name')).toBeFocused();

  await page.locator('#client-create-modal').click({ position: { x: 6, y: 6 } });
  await expect(dialog).toBeVisible();
  await page.getByLabel('Display name').focus();

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByLabel('Display name').fill('Playwright UX Client');
  await expect(dialog.getByLabel('Principal ID')).toHaveCount(0);
  await expect(dialog).toContainText('Principal ID is generated by mcp_worker');
  await page.getByLabel('Redirect URI(s)').fill('http://localhost:4555/oauth/callback');
  await page.getByRole('button', { name: 'Create Client' }).click();

  const secretDialog = page.getByRole('dialog', { name: 'Client secret created' });
  await expect(secretDialog).toBeVisible();
  const secret = (await page.locator('#new-client-secret').textContent())!.trim();
  expect(secret).toMatch(/^br_sec_/);
  await page.getByRole('button', { name: "I've saved the secret" }).click();
  await expect(secretDialog).toBeHidden();
  const createdClientRow = page
    .locator('#clients-table tbody tr')
    .filter({ hasText: 'Playwright UX Client' });
  await expect(createdClientRow.getByText(/^principal:client:br_client_/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(secret)).toHaveCount(0);

  const oauthClientRow = page
    .locator('#clients-table tbody tr')
    .filter({ hasText: 'Playwright UX Client' });
  const oauthActions = oauthClientRow.locator('details.dropdown');
  await oauthActions.evaluate((details) => {
    (details as HTMLDetailsElement).open = true;
  });
  await expect(oauthActions).toHaveAttribute('open', '');
  await oauthActions.locator('form[action$="/rotate"] button').click();
  const rotateConfirm = page.getByRole('dialog', { name: 'Rotate client secret?' });
  await expect(rotateConfirm).toBeVisible();
  await rotateConfirm.getByRole('button', { name: 'Rotate Secret' }).click();
  await expect(secretDialog).toBeVisible();
  const rotatedSecret = (await page.locator('#new-client-secret').textContent())!.trim();
  expect(rotatedSecret).toMatch(/^br_sec_/);
  expect(rotatedSecret).not.toBe(secret);
  await page.getByRole('button', { name: "I've saved the secret" }).click();
  await page.reload();
  await expect(page.getByText(rotatedSecret)).toHaveCount(0);

  const search = page.getByRole('searchbox', { name: 'Search OAuth clients' });
  await search.fill('definitely-no-client-match');
  await expect(page.getByText('No matching OAuth clients')).toBeVisible();
  await search.fill('Playwright UX Client');
  await expect(
    page.locator('#clients-table tbody tr').filter({ hasText: 'Playwright UX Client' }),
  ).toHaveCount(1);
});

test('Worker-only execution targets replace SSH profiles and browser consoles', async ({
  page,
}) => {
  await login(page);
  await page.goto('/admin/workers');
  await expect(page.getByRole('heading', { name: 'Workers', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Execution Target' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Execution Targets' })).toBeVisible();
  await expect(page.getByText('Dev Alpha', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'SSH Profiles' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New Execution Target' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Worker Profile' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Worker', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Name')).toBeVisible();
  await expect(dialog.getByLabel('SSH password')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  for (const url of ['/admin/terminals', '/admin/terminals/old/shell']) {
    const response = await page.request.get(url);
    expect(response.status()).toBe(404);
  }
});

test('Workers use one-time enrollment tokens and worker profiles without SSH credentials', async ({
  page,
}) => {
  await login(page);
  await page.goto('/admin/workers');

  await expect(page.getByRole('heading', { name: 'Workers', level: 1 })).toBeVisible();
  await expect(page.getByText(/Outbound execution agents/)).toBeVisible();
  await expect(
    page
      .locator('tbody .cell-title')
      .filter({ hasText: /^Playwright Worker$/ })
      .first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Execution Target' })).toBeVisible();
  await expect(page.getByText('Worker Alpha', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Outbound WSS only')).toBeVisible();
  await expect(page.getByText('Inbound execution port', { exact: true })).toBeVisible();
  await expect(page.getByText('Not required', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Refresh workers' }).click();
  await expect(page).toHaveURL(/\/admin\/workers$/);
  await expect(
    page
      .locator('tbody .cell-title')
      .filter({ hasText: /^Playwright Worker$/ })
      .first(),
  ).toBeVisible();

  const workerSearch = page.getByRole('searchbox', { name: 'Search workers' });
  await workerSearch.fill('Playwright Worker');
  await expect(page.locator('#workers-table tbody tr:not([hidden])')).toHaveCount(1);
  await workerSearch.fill('definitely-no-worker');
  await expect(page.getByText('No matching workers.')).toBeVisible();
  await workerSearch.fill('');

  await page.getByRole('button', { name: 'Generate Enrollment Token' }).click();
  const enrollmentDialog = page.getByRole('dialog', { name: 'One-time Enrollment Token' });
  await expect(enrollmentDialog).toBeVisible();
  await expect(enrollmentDialog.locator('#worker-install-linux-command')).toContainText(
    'curl -fsSL http://127.0.0.1:3399/worker/install-linux.sh | sh',
  );
  await expect(enrollmentDialog.locator('#worker-install-macos-command')).toContainText(
    'curl -fsSL http://127.0.0.1:3399/worker/install-macos.sh | sh',
  );
  await expect(enrollmentDialog.locator('#worker-install-windows-command')).toContainText(
    'irm http://127.0.0.1:3399/worker/install.ps1 | iex',
  );
  await expect(enrollmentDialog.getByText('systemtd login', { exact: true })).toBeVisible();
  const enrollment = (await enrollmentDialog
    .locator('#worker-enrollment-token')
    .textContent())!.trim();
  expect(enrollment).toMatch(/^br_enroll_/);
  await enrollmentDialog.getByRole('button', { name: "I've saved the token" }).click();
  await expect(enrollmentDialog).toBeHidden();
  await page.reload();
  await expect(page.getByText(enrollment)).toHaveCount(0);

  await expect(page.getByRole('link', { name: 'SSH Profiles' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Execution Targets' })).toBeVisible();

  let workerActions = page.getByRole('button', { name: 'Actions for Playwright Worker' });
  await workerActions.click();
  await page
    .getByRole('menu', { name: 'Actions for Playwright Worker' })
    .getByRole('menuitem', { name: 'Edit name' })
    .click();
  const editWorkerDialog = page.getByRole('dialog', { name: 'Edit Worker name' });
  await expect(editWorkerDialog).toBeVisible();
  await expect(editWorkerDialog.getByLabel('Worker name')).toHaveValue('Playwright Worker');
  await editWorkerDialog.getByLabel('Worker name').fill('Playwright Worker Renamed');
  await editWorkerDialog.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Worker name updated.')).toBeVisible();
  await expect(
    page.locator('#workers-table tbody tr').filter({ hasText: 'Playwright Worker Renamed' }),
  ).toHaveCount(1);

  workerActions = page.getByRole('button', { name: 'Actions for Playwright Worker Renamed' });
  await workerActions.click();
  await page
    .getByRole('menu', { name: 'Actions for Playwright Worker Renamed' })
    .getByRole('menuitem', { name: 'Disable' })
    .click();
  const disableDialog = page.getByRole('dialog', { name: 'Disable Worker?' });
  await expect(disableDialog).toBeVisible();
  await disableDialog.getByRole('button', { name: 'Disable Worker' }).click();
  await expect(page.getByText('Worker disabled.')).toBeVisible();
  const disabledWorkerRow = page
    .locator('#workers-table tbody tr')
    .filter({ hasText: 'Playwright Worker Renamed' });
  await expect(disabledWorkerRow.getByText('Disabled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Playwright Worker Renamed' }).click();
  await page
    .getByRole('menu', { name: 'Actions for Playwright Worker Renamed' })
    .getByRole('menuitem', { name: 'Enable' })
    .click();
  await expect(page.getByText('Worker enabled.')).toBeVisible();

  await page.getByRole('button', { name: 'Actions for Playwright Worker Renamed' }).click();
  await page
    .getByRole('menu', { name: 'Actions for Playwright Worker Renamed' })
    .getByRole('menuitem', { name: 'Remove from mcp_worker' })
    .click();
  const removeDialog = page.getByRole('dialog', { name: 'Remove Worker remotely?' });
  await expect(removeDialog).toBeVisible();
  await expect(removeDialog).toContainText('uninstall mcp_worker Worker from the target machine');
  await expect(removeDialog).toContainText('Worker must be online');
  await removeDialog.getByRole('button', { name: 'Remove Worker' }).click();
  await expect(page.getByText('Worker is not connected.')).toBeVisible();
  await expect(
    page.locator('#workers-table tbody tr').filter({ hasText: 'Playwright Worker Renamed' }),
  ).toHaveCount(1);

  await page.getByRole('button', { name: 'Actions for Playwright Worker Renamed' }).click();
  await page
    .getByRole('menu', { name: 'Actions for Playwright Worker Renamed' })
    .getByRole('menuitem', { name: 'Force delete' })
    .click();
  const forceDialog = page.getByRole('dialog', { name: 'Force delete Worker?' });
  await expect(forceDialog).toContainText('without waiting for remote uninstall');
  await forceDialog.getByRole('button', { name: 'Force Delete' }).click();
  await expect(page.getByText('Worker force deleted from mcp_worker.')).toBeVisible();
  await expect(
    page.locator('#workers-table tbody tr').filter({ hasText: 'Playwright Worker Renamed' }),
  ).toHaveCount(0);
});

test('Settings uses dedicated sub-pages and keeps Telegram secrets hidden', async ({ page }) => {
  await login(page);
  await page.goto('/admin/settings/database');

  const settingsNav = page
    .locator('#admin-sidebar')
    .getByRole('navigation', { name: 'Settings navigation' });
  await expect(settingsNav).toBeVisible();
  await expect(settingsNav.getByRole('link')).toHaveCount(4);
  await expect(page.locator('main .settings-menu')).toHaveCount(0);
  await expect(
    page.locator('.settings-content').getByRole('heading', { name: 'Database' }),
  ).toBeVisible();
  await expect(page.locator('.settings-content').getByRole('heading', { name: 'MCP' })).toHaveCount(
    0,
  );

  await settingsNav.getByRole('link', { name: /MCP/ }).click();
  await expect(page).toHaveURL(/\/admin\/settings\/mcp$/);
  await expect(
    page.locator('.settings-content').getByRole('heading', { name: 'MCP' }),
  ).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Settings navigation' })
    .getByRole('link', { name: /Telegram/ })
    .click();
  await expect(page).toHaveURL(/\/admin\/settings\/telegram$/);
  await expect(
    page.locator('.settings-content').getByRole('heading', { name: 'Admin Telegram' }),
  ).toBeVisible();
  await expect(page.getByText('Legacy SQLite compatibility mode')).toHaveCount(0);
  await expect(page.getByText('playwright-fixture-token')).toHaveCount(0);
  await expect(page.getByLabel('Bot Token')).toBeHidden();

  await page.getByRole('button', { name: 'Edit Configuration' }).first().click();
  const telegramDialog = page.getByRole('dialog', { name: 'Edit Telegram Configuration' });
  const token = telegramDialog.getByLabel('Bot Token');
  const chatId = telegramDialog.getByLabel('Chat ID');
  await expect(token).toHaveValue('');
  await expect(token).toHaveAttribute('placeholder', /stored securely/i);
  await chatId.fill('987654321');
  await telegramDialog.getByRole('button', { name: 'Save Changes' }).click();

  await expect(page).toHaveURL(/\/admin\/settings\/telegram$/);
  await expect(page.getByText('987654321', { exact: true })).toBeVisible();
  await expect(page.getByText('Telegram settings saved to database.')).toBeVisible();
  await expect(page.getByText('playwright-fixture-token')).toHaveCount(0);
});

test('Admin excludes Users; retired routes reject management while OAuth and Workers remain', async ({
  page,
}) => {
  await login(page);
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(navigation.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'OAuth Clients' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Workers' })).toBeVisible();
  for (const route of ['/admin/users', '/admin/users/retired/reset-password']) {
    expect((await page.request.get(route)).status()).toBe(404);
  }
  await navigation.getByRole('link', { name: 'OAuth Clients' }).click();
  await expect(page).toHaveURL(/\/admin\/clients$/);
  await expect(page.getByRole('heading', { name: 'OAuth Clients', level: 1 })).toBeVisible();
  await navigation.getByRole('link', { name: 'Workers' }).click();
  await expect(page).toHaveURL(/\/admin\/workers$/);
  await expect(page.getByRole('heading', { name: 'Workers', level: 1 })).toBeVisible();
});

test('mobile navigation behaves like a drawer and tables do not create page-level horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  const menuButton = page.locator('[data-mobile-menu]');
  await expect(menuButton).toHaveAttribute('aria-label', 'Open navigation');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await menuButton.click();
  await expect(menuButton).toHaveAttribute('aria-label', 'Close navigation');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-sidebar-scrim]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');

  await menuButton.click();
  await page.locator('#admin-sidebar').getByRole('link', { name: 'Workers', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/workers$/);
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  await expect(page.getByRole('heading', { name: 'Workers', level: 1 })).toBeVisible();
});

test('theme preference persists and all admin pages render on desktop/mobile without browser errors', async ({
  page,
}, testInfo) => {
  const errors = captureConsoleErrors(page);
  await login(page);

  const themeToggle = page.getByRole('button', { name: /theme/i });
  await themeToggle.click();
  const theme = await page.locator('html').getAttribute('data-theme');
  expect(['light', 'dark']).toContain(theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme ?? '');

  const pages = [
    ['overview', '/admin'],
    ['audit-log', '/admin/audit'],
    ['oauth-clients', '/admin/clients'],
    ['workers', '/admin/workers'],
    ['settings-database', '/admin/settings/database'],
    ['settings-mcp', '/admin/settings/mcp'],
    ['settings-telegram', '/admin/settings/telegram'],
    ['settings-runtime', '/admin/settings/runtime'],
  ];

  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [name, path] of pages) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${name}-desktop.png`), fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of pages) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    await page.screenshot({ path: testInfo.outputPath(`${name}-mobile.png`), fullPage: true });
  }

  expect(errors).toEqual([]);
});
