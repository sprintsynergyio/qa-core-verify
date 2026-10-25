import { test, expect } from '@playwright/test';

test('assertion is never reached', async ({ page }) => {
  await page.goto('/');
  return;
  // SEEDED: QCV-F001 this expect is after a return, so it never runs
  await expect(page).toHaveTitle('not the login page');
});

test('does not read the page', async ({ page }) => {
  await page.goto('/');
  const marker = 'seeded-constant';
  // SEEDED: QCV-F002 this assertion checks a local constant, not the page
  expect(marker).toContain('seeded');
});
