import { test } from '@playwright/test';
import { midAssert } from './mid.js';

test('two levels', async ({ page }) => {
  await midAssert(page);
});
