import { test, expect } from '@playwright/test';

test('assert after the wait', async ({ page }) => {
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('title')).toHaveText('Products');
});

test('no wait', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('Products');
});
