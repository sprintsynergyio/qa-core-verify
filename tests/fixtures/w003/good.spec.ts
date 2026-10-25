import { test, expect } from '@playwright/test';

test('awaited visibility', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('returns the assertion', async ({ page }) => {
  return expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('awaited url', async ({ page }) => {
  await expect(page).toHaveURL('/inventory.html');
});

test('sync comparison', async () => {
  expect(1).toBe(2);
});
