import { test, expect } from '@playwright/test';

test('inline locator', async ({ page }) => {
  expect(page.getByRole('button', { name: 'Login' })).toBeTruthy();
});

test('variable locator', async ({ page }) => {
  const button = page.getByRole('button', { name: 'Login' });
  expect(button).toBeDefined();
});

test('not null', async ({ page }) => {
  const field = page.locator('#user-name');
  expect(field).not.toBeNull();
});

test('not undefined', async ({ page }) => {
  expect(page.getByText('Products')).not.toBeUndefined();
});

test('not falsy', async ({ page }) => {
  expect(page.getByTestId('login-button')).not.toBeFalsy();
});
