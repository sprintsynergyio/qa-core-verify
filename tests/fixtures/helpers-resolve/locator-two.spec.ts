import { test, expect } from '@playwright/test';
import { wrappedTitle } from './wrapper.js';

test('two level locator', async ({ page }) => {
  expect(wrappedTitle(page)).toBeTruthy();
});
