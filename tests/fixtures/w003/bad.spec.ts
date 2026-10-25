import { test, expect } from '@playwright/test';

test('not awaited', async ({ page }) => {
  expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('page url', async ({ page }) => {
  expect(page).toHaveURL('/inventory.html');
});

test('soft text', async ({ page }) => {
  expect.soft(page.getByTestId('title')).toHaveText('Products');
});
