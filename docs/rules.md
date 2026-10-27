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

## QCV-W003 Async Assertion Not Awaited

### What

A matcher that returns a promise is neither awaited nor returned from the test. `expect.poll`, `expect(promise).resolves`, and `expect(promise).rejects` return a promise for every matcher, including `toBe`. The subject can be a locator, a page, or any other value.

`await Promise.all`, `await Promise.allSettled`, and a returned `Promise.all` or `Promise.allSettled` count as waiting. An array element or a `.map` callback passed to that call is included. A value returned from a `test.step` callback counts when that step is awaited or returned.

An awaited `.then`, `.catch`, or `.finally` chain on the matcher counts as waiting. The same is true when the test returns that chain.

Two calls are flagged even when the assertion inside them is awaited:

- `test.step(...)` is not awaited or returned, its callback has a block body, and that body contains an assertion.
- A call to a local or imported `async` function is not awaited or returned, and that function contains an assertion that stays tied to the function's promise. A bare `check();` is the usual case.

### Why

Playwright 1.60 fails a test at its end when an unawaited locator or page assertion is still pending, or when that assertion fails during the test. An unawaited `expect.poll` or `.resolves` failure can be lost, or reported in the next test.

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
await expect(page).toHaveTitle('Swag Labs').then(() => undefined);
await expect(Promise.resolve(1)).resolves.toBe(1);
await checkTitle(page);
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

After the last action, every assertion is `toBeVisible`, `toBeAttached`, or `toBeInViewport`. Actions include interactions such as `click` and `fill`, and the navigation calls `reload`, `goBack`, and `goForward`. `page.goto` is navigation, not a user action, so it does not count as the last action. A test whose only navigation is `page.goto` is not flagged. A click, then `page.goto`, then a presence-only `toBeVisible` is still flagged, because the click stays the last user action.

### Why

The element can be present while the text, URL, count, or state is wrong. The test stays green.

### Bad Example

```ts
await page.getByRole('button', { name: 'Add to cart' }).click();
await expect(page.getByTestId('inventory-list')).toBeVisible();
```

```ts
await page.getByRole('button', { name: 'Login' }).click();
await page.goto('/');
await expect(page.getByTestId('login-button')).toBeVisible();
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

A `try` block contains `expect`, and the `catch` does not throw on every path.

A `throw` directly in the catch, or in a nested block, rethrows. `if` counts only when both the `then` branch and the `else` branch throw. `catch (e) { if (x) throw e; }` still swallows the failure when `x` is false, so the expect is flagged. `catch (e) { if (x) throw e; else throw e; }` rethrows on every path, so it is not flagged.

A `switch` counts as an always-rethrow only when it has a `default` clause and every clause throws on its own. A clause that only falls through to a later `throw` is not treated as a rethrow.

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

`test.skip`, `test.fixme`, `test.only`, `describe.only`, or `describe.fixme` on each test those modifiers apply to.

`test.describe.skip` is one finding for the describe block, including when the block contains no tests. The tests inside that block are not each flagged for the describe.

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

## QCV-L001 Locator Never Matched

### What

A locator used in an action or a positive assertion matched 0 elements in every recorded use. A strict action that returned is not a zero match, because Playwright had resolved one element at action time.

### Why

The test asked for an element that was not there. A click that fails does go red. Playwright 1.60 fails a test at its end when an unawaited locator or page assertion is still pending, or when that assertion fails during the test. An unawaited `expect.poll` or `.resolves` failure can be lost, or reported in the next test. A swallowed assertion can stay green.

### Bad Example

```ts
expect(page.getByText('Products')).toBeTruthy();
```

### Good Example

```ts
await expect(page.getByTestId('error')).toHaveText('Epic sadface: Sorry, this user has been locked out.');
```

### Severity

error

### Related Lint Rule

None. The fix hint says to run qa-core-heal.

## QCV-L002 Absence Assertion On An Unseen Locator

### What

The locator is used only in absence assertions, and it never matched. The absence assertions are `toBeHidden`, `not.toBeVisible`, `not.toBeAttached`, `toHaveCount(0)`, `toBeVisible({ visible: false })`, and `toBeAttached({ attached: false })`.

### Why

This test stays green even if this element does not exist. Check the locator against a state where the element is shown.

### Bad Example

```ts
await expect(page.locator('#login-error-banner')).toBeHidden();
```

### Good Example

```ts
await expect(page.getByTestId('error')).toBeVisible();
await expect(page.getByTestId('error')).toBeHidden();
```

The second check is the absence. The first check has already shown that the locator can match.

### Severity

warn. `--only faults` raises this to error when a `change-text` fault should show the selector and the selector still matches nothing.

### Related Lint Rule

None.

## QCV-L003 Ambiguous Locator

### What

The locator matched more than one element and the test did not account for that count. `toHaveCount(n)` accounts for it when n equals the match count. An array passed to `toHaveText` or `toContainText` accounts for it when the array length equals the match count. `.nth(index)` with a stated index is narrowed. `.first()` and `.last()` are not narrowed: the parent count is the signal, and those calls still warn.

### Why

The test can keep passing while it talks to a different element than the one a reader expects.

### Bad Example

```ts
await expect(page.locator('div').first()).toBeVisible();
```

### Good Example

```ts
await expect(page.getByTestId('inventory-item')).toHaveCount(6);
```

### Severity

warn

### Related Lint Rule

None. The evidence lists the match counts that were seen.

## QCV-L004 Brittle CSS Or XPath

### What

A `locator()` or `frameLocator()` string is an XPath, uses `nth-child` or `nth-of-type`, has more than two CSS combinators, or uses a class.

Playwright's locator guide prefers a role, label, text, or test id over CSS and XPath: https://playwright.dev/docs/locators

Every class in a `locator()` or `frameLocator()` string counts, including a class that names a component. The finding calls it a styling class. This is a static check. It does not open a browser.

### Why

A long CSS chain or a class used for styling changes when the page is restyled, and the test fails for a reason that is not the feature.

### Bad Example

```ts
await expect(page.locator('div#root > div.login_container > div.login_wrapper > div.form')).toBeVisible();
```

### Good Example

```ts
await expect(page.getByTestId('login-button')).toBeVisible();
```

### Severity

info

### Related Lint Rule

None.

## QCV-F001 Assertion Cannot Fail

### What

An assertion in a green test was inverted and the test still passed. Inversion adds `.not` when it is absent and removes `.not` when it is present. `.soft` and `.poll` stay. `toPass` is not inverted, and neither is a custom matcher. Those are info, with the reason on the assertion row.

### Why

A test that stays green when its assertion is negated does not go red when the feature breaks.

### Bad Example

```ts
await page.goto('/');
return;
await expect(page).toHaveTitle('not the login page');
```

The expect is after `return`. Inverting it still does not run, so the test stays green.

### Good Example

```ts
await expect(page.getByTestId('login-button')).toBeVisible();
```

Inverting this check fails the test, so the assertion is `killed`.

### Severity

error

### Related Lint Rule

None. The check runs Playwright. It is not part of the static audit.

## QCV-F002 Passes On A Blank App

### What

A test that passed the baseline also passed when the page body was replaced with an empty element after load. A MutationObserver keeps the body empty when the app renders again. The fault id is `blank-app`. It is built in and runs for every suite.

The blank is applied to every browser context the test opens, including `browser.newContext()` and `browser.newPage()`. A page opened in `beforeAll`, or held by a worker scoped fixture, stays armed for each later test while that page is still open. A page or context opened in a test body stops counting when that test ends, even if it is still open. The checker counts the carried pages that are still open when the test starts, plus any page armed during that test. A page that is already closed when the test starts does not count. `page.setContent` replaces the document, so the same script runs again after it. At the end of the test the checker looks at the body of each open page the test used, not only the `page` fixture. A passing test whose page is not that single empty element is `not-run` for `blank-app`, with a reason, and QCV-F002 is not raised. A test that never opens a page, such as a `request` test, is also `not-run` for this fault. QCV-F003 and QCV-F004 are not raised for a fault that was not applied. `user-swap` sets environment variables for the Playwright process, so it still applies when no page is opened.

### Why

A test that stays green on an empty page does not check the feature.

### Bad Example

```ts
await page.goto('/');
const marker = 'seeded-constant';
expect(marker).toContain('seeded');
```

### Good Example

```ts
await expect(page.getByTestId('inventory-list')).toBeVisible();
```

### Severity

error

### Related Lint Rule

None. The check runs Playwright.

## QCV-F003 Survives An Expected Fault

### What

`qa-core-verify.faults.json` lists `expectedToBreak` as JavaScript regular expressions. A pattern matches the title path (`Describe > title`) or the test title. A test that passed the baseline and is listed for a fault, and still passes under that fault, is QCV-F003. The fault must have been applied. A page that is still open from `beforeAll` or a worker scoped fixture counts as the fault reaching that test. A page left open by an earlier test does not. `block-request` uses `context.route`, so a popup in that context is blocked, and a context from `browser.newContext()` gets the same route. A cell that is `not-run` because the fault never reached a page does not raise QCV-F003.

### Why

The fault file says this test should go red. It did not.

### Bad Example

```json
{ "id": "cart-badge", "type": "change-text", "params": { "selector": "[data-test='shopping-cart-badge']", "text": "9" }, "expectedToBreak": ["does not read the page"] }
```

The listed test checks a local constant, so the badge fault does not fail it.

### Good Example

```json
{ "id": "cart-badge", "type": "change-text", "params": { "selector": "[data-test='shopping-cart-badge']", "text": "9" }, "expectedToBreak": ["add to cart updates the cart badge"] }
```

The cart test reads the badge text, so this fault fails it and QCV-F003 does not fire.

### Severity

error

### Related Lint Rule

None.

## QCV-F004 Stays Green Under Every Fault

### What

A test that passed the baseline also passed under every fault in the run, including `blank-app`. The evidence lists the fault ids. The spec for this check asks for that warn and does not assign a rule id. This checker uses QCV-F004. A `not-run` cell means that fault was not applied, so the test does not get this warn.

### Why

Nothing in the fault file made the test go red.

### Bad Example

The constant assertion in QCV-F002 stays green under every DOM fault and every user-swap that does not read that constant.

### Good Example

```ts
await expect(page.getByTestId('shopping-cart-badge')).toHaveText('1');
```

A `change-text` fault on that badge fails the test, so the test did not stay green under every fault.

### Severity

warn

### Related Lint Rule

None.

## Known Limits

An `expect` in `beforeEach`, `afterEach`, `beforeAll`, or `afterAll` does not count as an assertion for the test. The hook is not part of the test body. A test that only asserts in `beforeEach` is still QCV-W001.

Imports are followed one level, into a helper or a page object in a local file. A call that needs a second import is QCV-W000 when that call could be an assertion or a locator. A call used only as an argument to a Playwright action, such as a user name passed to `fill`, is not reported.

`test.skip(condition)` and `test.fixme(condition)` inside a test body are annotations. QCV-W009 flags the declaration forms, including `describe.fixme`.

A method stored on an object literal is not followed. Name it in `qa-core-verify.config.json` if it is the assertion, or move it to a function the spec imports.

A `const` alias of `expect` is treated as `expect` when it is declared in the file, in a `describe` callback, or in the same test: `const e = expect` then `await e(locator).toBeVisible()`. The initializer must be `expect` or another `const` alias already in scope. `let` and `var` aliases are not followed, because they can be reassigned. `expect.configure` is recognized for `const` and for assignment.

A `const` alias of `expect.soft` is a soft assertion in those same places. `const soft = expect.soft`, `const e = expect` then `const soft = e.soft`, and `const soft2 = soft` all count. `let` and `var` aliases of `expect.soft` are not followed.
