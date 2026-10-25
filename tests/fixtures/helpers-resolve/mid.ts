import type { Page } from '@playwright/test';
import { deepAssert } from './deep.js';

export async function midAssert(page: Page): Promise<void> {
  await deepAssert(page);
}
