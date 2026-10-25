import { test, expect } from '@playwright/test';

test('not awaited', async ({ page }) => {
  expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('page url', async ({ page }) => {
  expect(page).toHaveURL('/inventory.html');
});

test('soft text', async ({ page }) => {
  expect.soft(page.getByTestId('title')).toHaveText('Products');
});

test('poll', async () => {
  expect.poll(() => 6).toBe(6);
});

test('to pass', async ({ page }) => {
  expect(async () => {
    await expect(page.getByTestId('title')).toHaveText('Products');
  }).toPass();
});

test('contain class', async ({ page }) => {
  expect(page.getByTestId('title')).toContainClass('selected');
});

test('match aria snapshot', async ({ page }) => {
  expect(page.getByTestId('title')).toMatchAriaSnapshot('- heading');
});

test('fixture locator', async ({ loginButton }) => {
  expect(loginButton).toBeVisible();
});

test('closure call', async ({ page }) => {
  const check = () => expect(page).toHaveTitle('Swag Labs');
  check();
});

test('response ok', async ({ page }) => {
  const response = await page.request.get('/');
  expect(response).toBeOK();
});
