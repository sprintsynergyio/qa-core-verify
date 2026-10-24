import { test, expect } from '@playwright/test';

test('expect metadata', async ({ page }) => {
  await expect(page.getByTestId('title')).toBeVisible();
  expect(page.getByText('Hello')).not.toBeHidden();
  await expect.soft(page).toHaveURL('/inventory.html');
  await expect.soft(page.getByRole('button')).not.toBeDisabled();
  await expect.poll(async () => page.getByTestId('count').textContent()).toBe('1');
});
