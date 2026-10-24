import { test } from '@playwright/test';

test('clicks and does not assert', async ({ page }) => {
  await page.getByRole('button', { name: 'Login' }).click();
});

test('only logs', async () => {
  console.log('no assertion');
});

test('empty test', async () => {});
