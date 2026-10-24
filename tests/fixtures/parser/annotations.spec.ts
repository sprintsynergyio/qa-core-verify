import { test, expect } from '@playwright/test';

test.describe('annotations', () => {
  test.slow(({ browserName }) => browserName === 'webkit');
  test.fail(({ browserName }) => browserName === 'firefox');
  test.skip(({ browserName }) => browserName === 'webkit');
  test.fixme(({ browserName }) => browserName === 'webkit');
  test.skip(true, 'boolean skip');
  test.skip();
  test.fail();
  test.slow();

  test.skip('skipped declaration', async () => {});

  test.fail('expected fail', async ({ page }) => {
    await expect(page).toHaveTitle('Products');
  });

  test.fail('failing and empty', async () => {});

  test('real test', async ({ page }) => {
    await expect(page).toHaveURL('/inventory.html');
  });

  test('skips inside the body', async () => {
    test.skip(true, 'not today');
  });
});
