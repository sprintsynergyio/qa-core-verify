import { test, expect } from '@playwright/test';

test('expect after the if', async ({ page }) => {
  if (await page.getByTestId('title').isVisible()) {
    await page.getByTestId('title').click();
  }
  await expect(page.getByTestId('title')).toHaveText('Products');
});

test('do while', async ({ page }) => {
  let seen = false;
  do {
    await expect(page.getByTestId('title')).toHaveText('Products');
    seen = true;
  } while (!seen);
});

test('counted loop', async ({ page }) => {
  for (let index = 0; index < 2; index += 1) {
    await expect(page.getByTestId('title')).toHaveText('Products');
  }
});

test('for of literal', async ({ page }) => {
  for (const id of ['a', 'b']) {
    await expect(page.getByTestId(id)).toHaveText('Products');
  }
});

test('for of const', async ({ page }) => {
  const ids = ['a', 'b'];
  for (const id of ids) {
    await expect(page.getByTestId(id)).toHaveText('Products');
  }
});

test('for each literal', async ({ page }) => {
  [1, 2].forEach(async () => {
    await expect(page.getByTestId('title')).toHaveText('Products');
  });
});

test('map literal', async ({ page }) => {
  await Promise.all(
    ['a', 'b'].map(async (id) => {
      await expect(page.getByTestId(id)).toHaveText(id);
    }),
  );
});
