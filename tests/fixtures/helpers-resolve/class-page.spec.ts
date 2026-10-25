import { test, expect } from '@playwright/test';
import { InventoryPage } from './inventory-page.js';

test('page object assertion', async ({ page }) => {
  const inventory = new InventoryPage(page);
  await inventory.assertTitle();
});

test('page object locator is truthy', async ({ page }) => {
  const inventory = new InventoryPage(page);
  expect(inventory.title()).toBeTruthy();
});
