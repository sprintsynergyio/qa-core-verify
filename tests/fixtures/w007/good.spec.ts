import { test, expect } from '@playwright/test';

test('expect after the if', async ({ page }) => {
  if (await page.getByTestId('title').isVisible()) {
    await page.getByTestId('title').click();
  }
  await expect(page.getByTestId('title')).toHaveText('Products');
});

test('do while', async ({ page }) => {
  let seen = false;
  do {
    await expect(page.getByTestId('title')).toHaveText('Products');
    seen = true;
  } while (!seen);
});

test('counted loop', async ({ page }) => {
  for (let index = 0; index < 2; index += 1) {
    await expect(page.getByTestId('title')).toHaveText('Products');
  }
});
