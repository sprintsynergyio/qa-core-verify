import type { Page } from '@playwright/test';
import { saucePassword, sauceUser } from './users.js';

export async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('username').fill(sauceUser());
  await page.getByTestId('password').fill(saucePassword());
  await page.getByTestId('login-button').click();
}
