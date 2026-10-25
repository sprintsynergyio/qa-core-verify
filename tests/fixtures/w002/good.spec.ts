import { test, expect } from '@playwright/test';

test('visible locator', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('text locator', async ({ page }) => {
  await expect(page.getByRole('heading')).toHaveText('Products');
});

test('truthy flag', async () => {
  const ready = true;
  expect(ready).toBeTruthy();
});
