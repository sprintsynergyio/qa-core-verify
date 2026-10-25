import type { Locator, Page } from '@playwright/test';
import { title } from './parts.js';

export function wrappedTitle(page: Page): Locator {
  return title(page);
}
