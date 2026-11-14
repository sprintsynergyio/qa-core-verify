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
  // SEEDED: QCV-F003 this test is listed in expectedToBreak for the cart badge fault and stays green
  // SEEDED: QCV-F004 this test stays green under every fault other than blank-app
  expect(marker).toContain('seeded');
});
