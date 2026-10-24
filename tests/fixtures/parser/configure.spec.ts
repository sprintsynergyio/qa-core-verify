import { test, expect } from '@playwright/test';

const slowExpect = expect.configure({ timeout: 10_000 });

test('inline configure', async ({ page }) => {
  await expect.configure({ timeout: 10_000 })(page).toHaveURL('/inventory.html');
});

test('aliased configure', async ({ page }) => {
  await slowExpect(page).toBeVisible();
});

test('still empty', async () => {});
