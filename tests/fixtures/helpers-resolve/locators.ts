import type { Locator, Page } from '@playwright/test';

export function loginButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Login' });
}
