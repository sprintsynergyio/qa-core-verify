import type { Locator, Page } from '@playwright/test';

export function title(page: Page): Locator {
  return page.getByTestId('title');
}
