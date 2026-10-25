import { test, expect } from '@playwright/test';

throw new Error('user code executed');

test('parsed without running', async () => {
  await expect(true).toBe(true);
});
