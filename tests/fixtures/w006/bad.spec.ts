import { test, expect } from '@playwright/test';

test('visible after click', async ({ page }) => {
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByTestId('inventory-list')).toBeVisible();
});

test('attached and in viewport', async ({ page }) => {
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByTestId('inventory-list')).toBeAttached();
  await expect(page.getByTestId('inventory-list')).toBeInViewport();
});

test('visible after goto', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-button')).toBeVisible();
});

test('presence after the last click', async ({ page }) => {
  await expect(page).toHaveURL('/inventory.html');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByTestId('inventory-list')).toBeVisible();
});
