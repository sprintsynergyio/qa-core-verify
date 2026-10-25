import { test } from '@playwright/test';
import { assertTitle } from './assert-title.js';

test('helper asserts', async ({ page }) => {
  await assertTitle(page);
});
