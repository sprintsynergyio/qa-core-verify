import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await expect(page).toHaveTitle('Products');
});

test('after hook only', async () => {});
