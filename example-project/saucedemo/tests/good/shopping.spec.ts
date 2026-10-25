import { test, expect } from '@playwright/test';
import { login } from '../../support/login.js';
import { saucePassword } from '../../support/users.js';

test('login lands on the inventory page', async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL('https://www.saucedemo.com/inventory.html');
  await expect(page.getByTestId('title')).toHaveText('Products');
  await expect(page.getByTestId('inventory-list')).toBeVisible();
  // The inventory list showed 6 items on 2026-10-25.
  await expect(page.getByTestId('inventory-item')).toHaveCount(6);
  await expect(page.getByTestId('inventory-item-name').filter({ hasText: 'Sauce Labs Backpack' })).toBeVisible();
});

test('add to cart updates the cart badge', async ({ page }) => {
  await login(page);
  await page
    .getByTestId('inventory-item')
    .filter({ hasText: 'Sauce Labs Backpack' })
    .getByRole('button', { name: 'Add to cart' })
    .click();
  // The badge text was "1" after adding the backpack once, on 2026-10-25.
  await expect(page.getByTestId('shopping-cart-badge')).toHaveText('1');
});

test('locked out user sees the error', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('username').fill('locked_out_user');
  await page.getByTestId('password').fill(saucePassword());
  await page.getByTestId('login-button').click();
  await expect(page).toHaveURL('https://www.saucedemo.com/');
  await expect(page.getByTestId('error')).toHaveText('Epic sadface: Sorry, this user has been locked out.');
});

test('checkout overview shows the backpack item total', async ({ page }) => {
  await login(page);
  await page
    .getByTestId('inventory-item')
    .filter({ hasText: 'Sauce Labs Backpack' })
    .getByRole('button', { name: 'Add to cart' })
    .click();
  await page.getByTestId('shopping-cart-link').click();
  await page.getByTestId('checkout').click();
  await page.getByTestId('firstName').fill('Demo');
  await page.getByTestId('lastName').fill('User');
  await page.getByTestId('postalCode').fill('00000');
  await page.getByTestId('continue').click();
  await expect(page).toHaveURL('https://www.saucedemo.com/checkout-step-two.html');
  await expect(page.getByTestId('inventory-item-name')).toHaveText('Sauce Labs Backpack');
  // Item total for one Sauce Labs Backpack on 2026-10-25.
  // Checkout used first name Demo, last name User, and postal code 00000.
  await expect(page.getByTestId('subtotal-label')).toHaveText('Item total: $29.99');
});
