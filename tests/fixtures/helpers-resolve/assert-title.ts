import { expect, type Page } from '@playwright/test';

export async function assertTitle(page: Page): Promise<void> {
  await expect(page.getByTestId('title')).toHaveText('Products');
}
