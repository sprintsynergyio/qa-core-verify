import { test, expect } from '@playwright/test';

test.skip('skipped', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('Products');
});

test.fixme('fixme', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('Products');
});

test.only('focused', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('Products');
});

test.describe.skip('skipped suite', () => {
  test('inside skip', async ({ page }) => {
    await expect(page.getByTestId('title')).toHaveText('Products');
  });

  test('also inside skip', async ({ page }) => {
    await expect(page.getByTestId('title')).toHaveText('Products');
  });
});

test.describe.skip('empty skipped suite', () => {});

test.describe.only('focused suite', () => {
  test('inside only', async ({ page }) => {
    await expect(page.getByTestId('title')).toHaveText('Products');
  });
});

test.describe.fixme('fixme suite', () => {
  test('inside fixme', async ({ page }) => {
    await expect(page.getByTestId('title')).toHaveText('Products');
  });
});
