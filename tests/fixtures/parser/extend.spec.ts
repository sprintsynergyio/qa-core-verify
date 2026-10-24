import { test as base, expect } from '@playwright/test';

const test = base.extend({}).extend({});
const wrapped = test.extend({});

test('uses extended test', async ({ page }) => {
  await expect(page).toHaveURL('/inventory.html');
});

wrapped('chained extend without assertion', async () => {});
