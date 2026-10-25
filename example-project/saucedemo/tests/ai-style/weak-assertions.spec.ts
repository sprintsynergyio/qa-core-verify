import { test, expect } from '@playwright/test';
import { login } from '../../support/login.js';

// SEEDED: QCV-W001 this test never calls expect
test('opens the login page and stops', async ({ page }) => {
  await page.goto('/');
});

test('truthy locator', async ({ page }) => {
  await page.goto('/');
  // SEEDED: QCV-W002 toBeTruthy on a locator does not check the element
  expect(page.getByText('Products')).toBeTruthy();
});

test('does not await visibility', async ({ page }) => {
  await page.goto('/');
  // SEEDED: QCV-W003 the visibility assertion is not awaited
  expect(page.getByTestId('login-button')).toBeVisible();
  // The page stays open so this example can finish. The expect above is not awaited.
  await page.waitForTimeout(1000);
});

test('literal compared with literal', async ({ page }) => {
  await page.goto('/');
  // SEEDED: QCV-W004 a literal is compared to the same literal
  expect(true).toBe(true);
});

test('truthy text content', async ({ page }) => {
  await login(page);
  const name = page.getByTestId('item-4-title-link');
  // SEEDED: QCV-W005 truthy text does not check which product is shown
  expect(await name.textContent()).toBeTruthy();
});

test('presence only after add to cart', async ({ page }) => {
  await login(page);
  await page
    .getByTestId('inventory-item')
    .filter({ hasText: 'Sauce Labs Backpack' })
    .getByRole('button', { name: 'Add to cart' })
    .click();
  // SEEDED: QCV-W006 the only assertion is that the list is visible
  await expect(page.getByTestId('inventory-list')).toBeVisible();
});

test('expect inside an if', async ({ page }) => {
  await login(page);
  const missing = page.locator('#not-on-the-inventory-page');
  if ((await missing.count()) > 0) {
    // SEEDED: QCV-W007 this expect runs only when the locator matches
    await expect(missing).toHaveText('will not run');
  }
});

test('swallows a failed assertion', async ({ page }) => {
  await page.goto('/');
  try {
    // SEEDED: QCV-W008 the catch discards the assertion failure
    await expect(page.locator('#login-error-banner')).toBeVisible({ timeout: 1000 });
  } catch {
    // The failure is discarded.
  }
});

// SEEDED: QCV-W009 this test is skipped, so the assertion never runs
test.skip('skipped inventory check', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('this test is skipped');
});

// SEEDED: QCV-W001 this test has no expect call
test('waits and then ends', async ({ page }) => {
  await page.goto('/');
  // SEEDED: QCV-W010 waitForTimeout is the only check
  await page.waitForTimeout(1000);
});
