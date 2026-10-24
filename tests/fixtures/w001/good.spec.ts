import { test, expect } from '@playwright/test';

test('expect in the body', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('expect inside a step', async ({ page }) => {
  await test.step('check title', async () => {
    await expect(page).toHaveTitle('Products');
  });
});

function assertLoggedIn(page: { url: () => string }): string {
  return page.url();
}

test('configured helper', async ({ page }) => {
  await assertLoggedIn(page);
});
