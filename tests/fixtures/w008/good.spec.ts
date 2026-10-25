import { test, expect } from '@playwright/test';

test('rethrows', async ({ page }) => {
  try {
    await expect(page.getByTestId('title')).toHaveText('Products');
  } catch (error) {
    throw error;
  }
});

test('rethrows on every branch', async ({ page }) => {
  try {
    await expect(page.getByTestId('title')).toHaveText('Products');
  } catch (error) {
    if (error instanceof Error) throw error;
    else throw error;
  }
});

test('no try', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('Products');
});

test('try without an expect', async ({ page }) => {
  try {
    await page.getByRole('button', { name: 'Login' }).click();
  } catch {
    await page.goto('/');
  }
  await expect(page.getByTestId('title')).toHaveText('Products');
});
