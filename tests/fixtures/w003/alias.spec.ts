import { test, expect } from '@playwright/test';

const fileAlias = expect;

test.describe('aliases', () => {
  const describeAlias = expect;

  test('describe alias', async ({ page }) => {
    await describeAlias(page).toHaveTitle('Swag Labs');
  });
});

test('file alias', async ({ page }) => {
  await fileAlias(page).toHaveTitle('Swag Labs');
});

test('test alias', async ({ page }) => {
  const e = expect;
  await e(page).toHaveTitle('Swag Labs');
});

test('let alias is not seen', async ({ page }) => {
  let e = expect;
  await e(page).toHaveTitle('Swag Labs');
});

test('alias not awaited', async ({ page }) => {
  const e = expect;
  e(page.getByTestId('title')).toBeVisible();
});
