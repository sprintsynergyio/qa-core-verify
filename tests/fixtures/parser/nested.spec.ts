import { test, expect } from '@playwright/test';

test.describe('outer', () => {
  test.describe('inner', () => {
    test('leaf', async () => {
      await expect(true).toBe(true);
    });
  });
});

test.describe.parallel('parallel suite', () => {
  test('inside parallel', async () => {
    await expect(true).toBe(true);
  });
});
