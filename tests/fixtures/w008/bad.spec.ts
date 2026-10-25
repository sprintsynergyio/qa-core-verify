import { test, expect } from '@playwright/test';

test('empty catch', async ({ page }) => {
  try {
    await expect(page.locator('#login-error-banner')).toBeVisible();
  } catch {
    // The failure is discarded.
  }
});

test('logs and continues', async ({ page }) => {
  try {
    await expect(page.getByTestId('title')).toHaveText('Products');
  } catch (error) {
    console.log(error);
  }
});

test('rethrows only inside if', async ({ page }) => {
  try {
    await expect(page.getByTestId('title')).toHaveText('Products');
  } catch (error) {
    if (error instanceof Error) throw error;
  }
});
