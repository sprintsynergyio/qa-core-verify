import { test, expect } from '@playwright/test';

test('text after click', async ({ page }) => {
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByTestId('shopping-cart-badge')).toHaveText('1');
});

test('url and visible after click', async ({ page }) => {
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL('/inventory.html');
  await expect(page.getByTestId('inventory-list')).toBeVisible();
});

test('visible with no action', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('visible after goto', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-button')).toBeVisible();
});

test('hidden after click', async ({ page }) => {
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('error')).toBeHidden();
});

test('enabled after click', async ({ page }) => {
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByTestId('checkout')).toBeEnabled();
});
