import { test, expect } from '@playwright/test';
import { LoginFields } from './login-fields.js';

test('constructor field is truthy', async ({ page }) => {
  const login = new LoginFields(page);
  expect(login.title).toBeTruthy();
});

test('initializer field is truthy', async ({ page }) => {
  const login = new LoginFields(page);
  expect(login.banner).toBeTruthy();
});

test('getter field is truthy', async ({ page }) => {
  const login = new LoginFields(page);
  expect(login.status).toBeTruthy();
});

test('constructor field is not awaited', async ({ page }) => {
  const login = new LoginFields(page);
  expect(login.title).toHaveText('Products');
});

test('page read field is truthy', async ({ page }) => {
  const login = new LoginFields(page);
  expect(await login.label).toBeTruthy();
});
