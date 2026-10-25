import { test } from '@playwright/test';

function assertCartCount(): boolean {
  return true;
}

function reportOnly(): void {
  return undefined;
}

const helpers = {
  assertCartCount(): boolean {
    return true;
  },
};

test('pattern helper', async () => {
  assertCartCount();
});

test('member pattern helper', async () => {
  helpers.assertCartCount();
});

test('not a configured helper', async () => {
  reportOnly();
});
