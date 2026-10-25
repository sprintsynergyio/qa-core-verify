import { test, expect } from '@playwright/test';

test('different numbers', async () => {
  expect(1).toBe(2);
});

test('page text', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('Products');
});

test('variable against expected text', async ({ page }) => {
  const status = await page.getByTestId('title').textContent();
  expect(status).toBe('Products');
});
