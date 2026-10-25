# Rules

Static checks for a Playwright suite. The checker parses spec files. It does not run them and it does not open a browser.

Each finding has `evidence` (the source text) and `fixHint` (one change to make). `relatedLintRule` is set when [eslint-plugin-playwright](https://github.com/playwright-community/eslint-plugin-playwright) has the same or a close rule. That package is not a dependency.

## QCV-W000 Could Not Resolve Helper

### What

A test calls a local helper, and that helper calls another file. The checker opens one import. It does not open the next one.

### Why

Guessing that the hidden call has an assertion, or that it returns a locator, would mark a good test as bad or hide a weak one.

### Bad Example

```ts
await midAssert(page);
```

`midAssert` calls `deepAssert` from a second file. The checker does not open that file.

### Good Example

```ts
await assertTitle(page);
```

The spec imports `assertTitle` directly, and that function contains the `expect`.

### Severity

info

### Related Lint Rule

None.

## QCV-W001 Test Has No Assertion

### What

The test has no `expect` and no helper named in `qa-core-verify.config.json`.

### Why

A test with no assertion stays green when the feature breaks.

### Bad Example

```ts
test('opens the login page and stops', async ({ page }) => {
  await page.goto('/');
});
```

### Good Example

```ts
test('login lands on the inventory page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL('https://www.saucedemo.com/inventory.html');
});
```

### Severity

error

### Related Lint Rule

`expect-expect`

## QCV-W002 Generic Matcher On A Locator

### What

`toBeTruthy`, `toBeDefined`, `not.toBeNull`, `not.toBeUndefined`, or `not.toBeFalsy` on a locator. The locator may be written inline, stored in a variable, returned by a helper the spec imports, or read from a page object field, initializer, or getter.

### Why

A locator object is always truthy. The matcher does not look at the element.

### Bad Example

```ts
expect(page.getByText('Products')).toBeTruthy();
```

### Good Example

```ts
await expect(page.getByText('Products')).toBeVisible();
```

### Severity

error

### Related Lint Rule

`no-unnecessary-assertions`

## QCV-W003 Web-First Assertion Not Awaited

### What

A matcher that returns a promise is neither awaited nor returned from the test. `expect.poll` returns a promise for every matcher, including `toBe`. The subject can be a locator, a page, or any other value.

`await Promise.all`, `await Promise.allSettled`, and a returned `Promise.all` or `Promise.allSettled` count as waiting. An array element or a `.map` callback passed to that call is included. A value returned from a `test.step` callback counts when that step is awaited or returned.

### Why

The assertion runs later, or not at all, so a failure does not fail the test.

### Bad Example

```ts
expect(page.getByTestId('login-button')).toBeVisible();
```

### Good Example

```ts
await expect(page.getByTestId('login-button')).toBeVisible();
```

Returning the promise from the test is also enough:

```ts
return expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
```

These are awaited too:

```ts
await Promise.all([expect(a).toHaveText('A'), expect(b).toHaveText('B')]);
await test.step('x', () => expect(page.getByTestId('title')).toHaveText('Products'));
```

### Severity

error

### Related Lint Rule

`missing-playwright-await`

## QCV-W004 Value Compared With Itself

### What

`toBe`, `toEqual`, or `toStrictEqual` compares a literal with the same literal, or uses the same source text on both sides.

### Why

The assertion cannot go red because of the page. Both sides are the same value.

### Bad Example

```ts
expect(true).toBe(true);
expect(status).toBe(status);
```

### Good Example

```ts
await expect(page.getByTestId('title')).toHaveText('Products');
```

### Severity

error

### Related Lint Rule

None.

## QCV-W005 Existence Check On A Page Read

### What

`textContent`, `innerText`, `getAttribute`, `inputValue`, or `count` is checked with `toBeTruthy`, `toBeDefined`, or `not.toBeNull`. A `count` checked with `toBeGreaterThanOrEqual(0)` is the same kind of check.

### Why

Any non-empty text passes. A count is always at least zero, including when the list is empty.

### Bad Example

```ts
expect(await name.textContent()).toBeTruthy();
expect(await page.getByRole('listitem').count()).toBeGreaterThanOrEqual(0);
```

### Good Example

```ts
await expect(page.getByTestId('title')).toHaveText('Products');
expect(await page.getByRole('listitem').count()).toBeGreaterThanOrEqual(1);
```

### Severity

warn

### Related Lint Rule

None.

## QCV-W006 Presence Only After The Last Action

### What

After the last action, every assertion is `toBeVisible`, `toBeAttached`, or `toBeInViewport`. Actions include `goto`, `reload`, `goBack`, `goForward`, and interactions such as `click` and `fill`.

### Why

The element can be present while the text, URL, count, or state is wrong. The test stays green.

### Bad Example

```ts
await page.getByRole('button', { name: 'Add to cart' }).click();
await expect(page.getByTestId('inventory-list')).toBeVisible();
```

### Good Example

```ts
await page.getByRole('button', { name: 'Add to cart' }).click();
await expect(page.getByTestId('shopping-cart-badge')).toHaveText('1');
```

A test with no action is not flagged. An assertion before the last action does not cancel a presence-only check that comes after it.

### Severity

warn

### Related Lint Rule

None.

## QCV-W007 Expect In A Branch Or A Loop

### What

`expect` is inside `if`, `switch`, a ternary, `catch`, or a loop that may run zero times. `forEach`, `map`, and the same family of callbacks count as loops.

### Why

The branch or the loop can be skipped. The test still passes.

### Bad Example

```ts
if ((await missing.count()) > 0) {
  await expect(missing).toHaveText('will not run');
}
```

### Good Example

```ts
await expect(page.getByTestId('title')).toHaveText('Products');
```

A `do while` loop runs the body once before the condition. A `for` loop that starts at 0 and counts up to a positive number also runs. A `for of` over a non-empty array literal runs, and so does one over a `const` in the same test that is bound to such a literal. `forEach`, `map`, and the same family are the same when the receiver is one of those. Those are not flagged. An assertion on the right of `&&`, `||`, or `??` is flagged, because that side can be skipped.

### Severity

warn

### Related Lint Rule

`no-conditional-expect`

## QCV-W008 Try Catch Swallows The Assertion

### What

A `try` block contains `expect`, and the `catch` does not throw.

### Why

The assertion can fail and the test still finishes green.

### Bad Example

```ts
try {
  await expect(page.locator('#login-error-banner')).toBeVisible();
} catch {
  // The failure is discarded.
}
```

### Good Example

```ts
try {
  await expect(page.getByTestId('title')).toHaveText('Products');
} catch (error) {
  throw error;
}
```

### Severity

error

### Related Lint Rule

None.

## QCV-W009 Skipped Or Focused Test

### What

`test.skip`, `test.fixme`, `test.only`, `describe.skip`, `describe.only`, or `describe.fixme`.

### Why

A skipped or fixme test does not run. A focused test hides the rest of the suite.

### Bad Example

```ts
test.skip('skipped inventory check', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('this test is skipped');
});
```

### Good Example

```ts
test('runs', async ({ page }) => {
  await expect(page.getByTestId('title')).toHaveText('Products');
});
```

### Severity

info

### Related Lint Rule

`no-skipped-test` for skip and fixme. `no-focused-test` for only.

## QCV-W010 Hard Wait With No Assertion After It

### What

`page.waitForTimeout` in a test, and no `expect` or configured assertion helper after that call.

### Why

The wait only spends time. It does not check the page.

### Bad Example

```ts
await page.goto('/');
await page.waitForTimeout(1000);
```

### Good Example

```ts
await expect(page.getByTestId('title')).toHaveText('Products');
```

A wait that is followed by an assertion is not flagged.

### Severity

info

### Related Lint Rule

`no-wait-for-timeout`

## Known Limits

An `expect` in `beforeEach`, `afterEach`, `beforeAll`, or `afterAll` does not count as an assertion for the test. The hook is not part of the test body. A test that only asserts in `beforeEach` is still QCV-W001.

Imports are followed one level, into a helper or a page object in a local file. A call that needs a second import is QCV-W000 when that call could be an assertion or a locator. A call used only as an argument to a Playwright action, such as a user name passed to `fill`, is not reported.

`test.skip(condition)` and `test.fixme(condition)` inside a test body are annotations. QCV-W009 flags the declaration forms, including `describe.fixme`.

A method stored on an object literal is not followed. Name it in `qa-core-verify.config.json` if it is the assertion, or move it to a function the spec imports.

`const e = expect` inside a test is not treated as `expect`. `e(locator).toBeVisible()` is not seen. Call `expect` by that name, or use `expect.configure`, which is recognized.
