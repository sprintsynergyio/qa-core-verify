import { test, expect } from '@playwright/test';
import { checkTitle } from './check-title.js';

test('awaited visibility', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('returns the assertion', async ({ page }) => {
  return expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('awaited url', async ({ page }) => {
  await expect(page).toHaveURL('/inventory.html');
});

test('sync comparison', async () => {
  expect(1).toBe(2);
});

test('promise all', async ({ page }) => {
  const a = page.getByTestId('a');
  const b = page.getByTestId('b');
  await Promise.all([expect(a).toHaveText('A'), expect(b).toHaveText('B')]);
});

test('promise all settled', async ({ page }) => {
  await Promise.allSettled([expect(page.getByTestId('title')).toHaveText('Products')]);
});

test('promise all map', async ({ page }) => {
  const ids = ['a', 'b'];
  await Promise.all(ids.map((id) => expect(page.getByTestId(id)).toHaveText(id)));
});

test('awaited step', async ({ page }) => {
  await test.step('x', () => expect(page.getByTestId('title')).toHaveText('Products'));
});

test('step returns the assertion', async ({ page }) => {
  await test.step('x', () => {
    return expect(page.getByTestId('title')).toHaveText('Products');
  });
});

test('returns promise all', async ({ page }) => {
  return Promise.all([expect(page.getByTestId('title')).toHaveText('Products')]);
});

test('returns a step', async ({ page }) => {
  return test.step('x', () => expect(page.getByTestId('title')).toHaveText('Products'));
});

test('awaited then', async ({ page }) => {
  await expect(page).toHaveTitle('Swag Labs').then(() => undefined);
});

test('awaited catch', async ({ page }) => {
  await expect(page).toHaveTitle('Swag Labs').catch(() => undefined);
});

test('awaited finally', async ({ page }) => {
  await expect(page).toHaveTitle('Swag Labs').finally(() => undefined);
});

test('awaited resolves', async () => {
  await expect(Promise.resolve(1)).resolves.toBe(1);
});

test('awaited rejects', async () => {
  await expect(Promise.reject(new Error('nope'))).rejects.toThrow('nope');
});

test('awaited helper', async ({ page }) => {
  await checkTitle(page);
});

test('returned helper', async ({ page }) => {
  return checkTitle(page);
});

test('awaited step block', async ({ page }) => {
  await test.step('title', async () => {
    await expect(page.getByTestId('title')).toHaveText('Products');
  });
});

test('const alias', async ({ page }) => {
  const e = expect;
  await e(page).toHaveTitle('Swag Labs');
});
