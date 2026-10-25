import { test, expect } from '@playwright/test';
import { LoginFields } from './login-fields.js';

test('constructor field text', async ({ page }) => {
  const login = new LoginFields(page);
  await expect(login.title).toHaveText('Products');
});

test('initializer field text', async ({ page }) => {
  const login = new LoginFields(page);
  await expect(login.banner).toHaveText('Products');
});

test('getter field text', async ({ page }) => {
  const login = new LoginFields(page);
  await expect(login.status).toHaveText('Ready');
});

test('page read field equals text', async ({ page }) => {
  const login = new LoginFields(page);
  expect(await login.label).toBe('Products');
});

test('plain field is not a locator', async ({ page }) => {
  const login = new LoginFields(page);
  expect(login.ready).toBeTruthy();
});
