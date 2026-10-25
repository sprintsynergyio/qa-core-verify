import { test, expect } from '@playwright/test';

test('runs', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('Products');
});

test.describe('suite', () => {
  test('inside', async ({ page }) => {
    await expect(page.getByTestId('title')).toHaveText('Products');
  });
});

test('conditional skip is an annotation', async ({ page }) => {
  test.skip(true, 'not this browser');
  await expect(page.getByTestId('title')).toHaveText('Products');
});
