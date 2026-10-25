import { test, expect } from '@playwright/test';

const fileAlias = expect;
const fileSoft = expect.soft;
const fileExpect = expect;
const chainedSoft = fileExpect.soft;
const chainedAgain = chainedSoft;

test.describe('aliases', () => {
  const describeAlias = expect;
  const describeSoft = expect.soft;
  const describeAgain = describeSoft;

  test('describe alias', async ({ page }) => {
    await describeAlias(page).toHaveTitle('Swag Labs');
  });

  test('describe soft alias', async ({ page }) => {
    await describeAgain(page.getByTestId('title')).toBeVisible();
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

test('file soft alias', async ({ page }) => {
  await fileSoft(page.getByTestId('title')).toBeVisible();
});

test('chained soft alias', async ({ page }) => {
  await chainedAgain(page.getByTestId('title')).toBeVisible();
});

test('test soft alias', async ({ page }) => {
  const e = expect;
  const soft = e.soft;
  const soft2 = soft;
  await soft2(page.getByTestId('title')).toBeVisible();
});

test('let soft alias is not seen', async ({ page }) => {
  let soft = expect.soft;
  await soft(page.getByTestId('title')).toBeVisible();
});

test('var soft alias is not seen', async ({ page }) => {
  var soft = expect.soft;
  await soft(page.getByTestId('title')).toBeVisible();
});
