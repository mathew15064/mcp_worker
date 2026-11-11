const { expect } = require('@playwright/test');

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'PlaywrightAdmin2026!';

async function login(page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(ADMIN_USERNAME);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/admin$/),
    page.getByRole('button', { name: 'Sign in' }).click()
  ]);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

function captureConsoleErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

module.exports = { login, captureConsoleErrors };
