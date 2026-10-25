import { test } from '@playwright/test';

test('locator chains', async ({ page }) => {
  await page.locator('.inventory_list').locator('.inventory_item').filter({ hasText: 'Bike' }).first().click();
  await page.getByRole('listitem').nth(0).click();
  const lastItem = page.getByRole('listitem').last();
  await lastItem.click();
});
