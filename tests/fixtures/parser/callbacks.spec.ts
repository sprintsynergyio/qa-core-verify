import { test, expect } from '@playwright/test';

test.beforeEach(async () => {
  test('inside beforeEach', async () => {});
});

test.afterEach(async () => {
  test('inside afterEach', async () => {});
});

test.beforeAll(async () => {
  test('inside beforeAll', async () => {});
});

test.afterAll(async () => {
  test('inside afterAll', async () => {});
});

beforeEach(() => {
  test('inside bare beforeEach', async () => {});
});

const hooks = {
  afterAll(fn: () => void) {
    fn();
  },
};
hooks.afterAll(() => {
  test('inside hooks.afterAll', async () => {});
});

setTimeout(() => {
  test('inside setTimeout', async () => {});
  ['hidden'].forEach((name) => {
    test(`timer for each ${name}`, async () => {});
  });
});

globalThis.setTimeout(() => {
  test('inside globalThis.setTimeout', async () => {});
}, 0);

const browserWindow = {
  setTimeout(fn: () => void) {
    fn();
  },
};
browserWindow.setTimeout(() => {
  test('inside browserWindow.setTimeout', async () => {});
});

setInterval(() => {
  test('inside setInterval', async () => {});
});

setImmediate(() => {
  test('inside setImmediate', async () => {});
});

test.setTimeout(() => {
  test('inside test.setTimeout', async () => {});
});

['kept'].forEach((name) => {
  test(`kept ${name}`, async ({ page }) => {
    await expect(page).toHaveURL('/inventory.html');
  });
});

['also'].map((name) => {
  test.beforeEach(() => {
    test(`hook inside map ${name}`, async () => {});
  });
  setTimeout(() => {
    test(`timer inside map ${name}`, async () => {});
  });
  test(`mapped ${name}`, async () => {});
});

test.describe('wrapped', () => {
  test.afterAll(() => {
    test('inside describe afterAll', async () => {});
  });
  ['wrapped'].forEach((name) => {
    test(`describe for each ${name}`, async ({ page }) => {
      await expect(page).toBeVisible();
    });
  });
});

test('real empty', async () => {});

function hidden() {
  test('inside a function declaration', async () => {});
}
