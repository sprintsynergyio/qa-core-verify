import { test, expect } from '@playwright/test';
import { checkTitle } from './check-title.js';

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

test('unawaited step block', async ({ page }) => {
  test.step('title', async () => {
    await expect(page.getByTestId('title')).toHaveText('Products');
  });
});

test('unawaited local helper', async ({ page }) => {
  const check = async () => {
    await expect(page).toHaveTitle('Swag Labs');
  };
  check();
});

test('unawaited imported helper', async ({ page }) => {
  checkTitle(page);
});

test('unawaited resolves', async () => {
  expect(Promise.resolve(1)).resolves.toBe(1);
});

test('unawaited rejects', async () => {
  expect(Promise.reject(new Error('nope'))).rejects.toThrow('nope');
});

test('alias not awaited', async ({ page }) => {
  const e = expect;
  e(page.getByTestId('title')).toBeVisible();
});
