import { test, expect } from '@playwright/test';

test.describe('active', () => {
  test.only('focused without assertion', async ({ page }) => {
    await page.getByRole('button', { name: 'Login' }).click();
  });

  test.skip('skipped without assertion', async () => {});

  test.fixme('fixme without assertion', async () => {});
});

test.describe.skip('skipped suite', () => {
  test('inside skipped describe', async () => {});
});

test.describe.fixme('fixme suite', () => {
  test('inside fixme describe', async () => {});
});

test('plain with assertion', async () => {
  await expect(true).toBe(true);
});
