import { defineConfig } from '@playwright/test';

// SauceDemo marks elements with data-test, not data-testid.
export default defineConfig({
  testDir: './tests',
  retries: 0,
  use: {
    baseURL: 'https://www.saucedemo.com',
    testIdAttribute: 'data-test',
    trace: 'retain-on-failure',
    browserName: 'chromium',
  },
});
