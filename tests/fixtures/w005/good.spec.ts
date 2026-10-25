import { test, expect } from '@playwright/test';

test('exact text', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('Products');
});

test('count at least one', async ({ page }) => {
  expect(await page.getByRole('listitem').count()).toBeGreaterThanOrEqual(1);
});

test('text equals products', async ({ page }) => {
  const text = await page.getByTestId('title').textContent();
  expect(text).toBe('Products');
});
