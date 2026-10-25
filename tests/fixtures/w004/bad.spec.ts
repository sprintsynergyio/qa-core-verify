import { test, expect } from '@playwright/test';

test('true to true', async () => {
  expect(true).toBe(true);
});

test('one to one', async () => {
  expect(1).toEqual(1);
});

test('same source', async () => {
  const status = 'ready';
  expect(status).toBe(status);
});

test('same text different quotes', async () => {
  expect('a').toBe("a");
});
