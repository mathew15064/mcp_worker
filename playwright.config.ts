import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never' }]
  ],
  use: {
    baseURL: 'http://127.0.0.1:3399',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  webServer: {
    command: 'node tests/e2e/fixtures/start-test-server.js',
    url: 'http://127.0.0.1:3399/login',
    reuseExistingServer: false,
    timeout: 30_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
