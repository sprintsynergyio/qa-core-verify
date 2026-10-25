import { test, expect } from '@playwright/test';

test('arrow body', async ({ page }) => {
  await expect(page).toHaveURL('/inventory.html');
});

test('function body', async function ({ page }) {
  await expect(page).toHaveURL('/inventory.html');
});
