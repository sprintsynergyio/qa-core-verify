import { expect, type Page } from '@playwright/test';

export async function checkTitle(page: Page): Promise<void> {
  await expect(page).toHaveTitle('Swag Labs');
}
