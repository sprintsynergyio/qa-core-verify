import { test, expect } from '@playwright/test';
import { loginButton } from './locators.js';

test('truthy helper locator', async ({ page }) => {
  expect(loginButton(page)).toBeTruthy();
});
