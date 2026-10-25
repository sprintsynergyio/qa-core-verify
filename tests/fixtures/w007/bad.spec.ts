import { test, expect } from '@playwright/test';

test('if', async ({ page }) => {
  if (await page.getByTestId('title').isVisible()) {
    await expect(page.getByTestId('title')).toHaveText('Products');
  }
});

test('switch', async ({ page }) => {
  const name = 'a';
  switch (name) {
    case 'a':
      await expect(page.getByTestId('title')).toHaveText('Products');
      break;
    default:
      break;
  }
});

test('ternary', async ({ page }) => {
  const ready = true;
  ready
    ? await expect(page.getByTestId('title')).toHaveText('Products')
    : await expect(page.getByTestId('title')).toHaveText('Other');
});

test('catch', async ({ page }) => {
  try {
    await page.goto('/');
  } catch {
    await expect(page.getByTestId('title')).toHaveText('Products');
  }
});

test('for of', async ({ page }) => {
  const names = ['Products'];
  for (const name of names) {
    await expect(page.getByTestId('title')).toHaveText(name);
  }
});

test('while', async ({ page }) => {
  let left = 1;
  while (left > 0) {
    await expect(page.getByTestId('title')).toHaveText('Products');
    left -= 1;
  }
});

test('for each', async ({ page }) => {
  const names = ['Products'];
  names.forEach(async (name) => {
    await expect(page.getByTestId('title')).toHaveText(name);
  });
});
