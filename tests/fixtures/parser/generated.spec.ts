import { test, expect } from '@playwright/test';

test.describe('generated', () => {
  ['a', 'b'].forEach((name) => {
    test(`for each ${name}`, async ({ page }) => {
      await expect(page).toHaveURL('/inventory.html');
    });
  });

  ['c', 'd'].map((name) => test(`mapped ${name}`, async () => {}));
});

function hidden() {
  test('inside a function declaration', async () => {});
}

test(`plain template`, async ({ page }) => {
  await expect(page).toBeVisible();
});
