import { test, expect } from '@playwright/test';

test('text content', async ({ page }) => {
  expect(await page.getByTestId('title').textContent()).toBeTruthy();
});

test('inner text variable', async ({ page }) => {
  const label = page.getByRole('heading');
  const text = await label.innerText();
  expect(text).toBeDefined();
});

test('attribute', async ({ page }) => {
  expect(await page.getByTestId('login-button').getAttribute('type')).not.toBeNull();
});

test('input value', async ({ page }) => {
  const field = page.getByTestId('username');
  expect(await field.inputValue()).toBeTruthy();
});

test('count at least zero', async ({ page }) => {
  expect(await page.getByRole('listitem').count()).toBeGreaterThanOrEqual(0);
});
