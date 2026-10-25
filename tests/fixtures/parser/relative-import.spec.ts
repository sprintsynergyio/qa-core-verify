import { test, expect } from './local-fixtures';

test.describe('relative', () => {
  test('relative good', async ({ page }) => {
    await expect(page).toHaveTitle('Products');
  });

  test('relative bad', async () => {});
});
