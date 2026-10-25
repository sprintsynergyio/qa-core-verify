import { test, expect } from '@playwright/test';
import { saucePassword } from '../../support/users.js';

test('invented banner is hidden', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('username').fill('locked_out_user');
  await page.getByTestId('password').fill(saucePassword());
  await page.getByTestId('login-button').click();
  // SEEDED: QCV-L002 toBeHidden on a locator that is not in the page
  await expect(page.locator('#login-error-banner')).toBeHidden();
});

test('first div on the login page', async ({ page }) => {
  await page.goto('/');
  // SEEDED: QCV-L003 first() on a locator that matches more than one div
  // SEEDED: QCV-W006 after goto the only assertion checks visibility
  await expect(page.locator('div').first()).toBeVisible();
});

test('login form through a long css chain', async ({ page }) => {
  await page.goto('/');
  // Ancestor chain of the login form, read from the page on 2026-10-25.
  // SEEDED: QCV-L004 a long css chain instead of a stable locator
  // SEEDED: QCV-W006 after goto the only assertion checks visibility
  await expect(
    page.locator(
      'div#root > div.login_container > div.login_wrapper > div.login_wrapper-inner > div#login_button_container.form_column > div.login-box > form',
    ),
  ).toBeVisible();
});
