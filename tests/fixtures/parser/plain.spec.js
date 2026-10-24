const { test, expect } = require('@playwright/test');

test.describe('js suite', () => {
  test('js arrow', async ({ page }) => {
    await expect(page).toHaveTitle('Products');
  });

  test('js function', async function ({ page }) {
    expect(page.locator('#login')).toBeVisible();
  });
});
