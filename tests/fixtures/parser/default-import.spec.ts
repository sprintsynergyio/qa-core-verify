import test from '@playwright/test';

test('default import', async () => {
  await test.expect(true).toBe(true);
});
