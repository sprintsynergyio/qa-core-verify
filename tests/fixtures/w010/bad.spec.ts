import { test, expect } from '@playwright/test';

test('wait then end', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1000);
});

test('text then wait', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('Products');
  await page.waitForTimeout(1000);
});
