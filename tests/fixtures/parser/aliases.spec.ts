import { test as pwTest, expect as pwExpect } from '@playwright/test';
import * as pw from '@playwright/test';

pwTest.describe('alias suite', () => {
  pwTest('alias test', async ({ page }) => {
    await pwExpect(page).toHaveURL('/inventory.html');
    pwExpect.soft(page.getByText('Products')).toBeVisible();
  });
});

pw.test('namespace test', async ({ page }) => {
  await pw.expect(page.locator('#login')).toBeVisible();
});
