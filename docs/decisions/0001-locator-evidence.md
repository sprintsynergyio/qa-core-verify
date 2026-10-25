# Locator Evidence

This spike compares three ways to record how many elements a Playwright locator matched. The runs used Playwright 1.60.0 and the SauceDemo demo suite in `example-project/saucedemo`. That suite has 19 tests. On every run below, 18 passed and 1 was skipped (`skipped inventory check`). The site was `https://www.saucedemo.com`.

The prototype is option A. `--only locator-evidence` copies the project to a temp directory, symlinks `node_modules`, rewrites `@playwright/test` imports, and writes `locator-evidence.json`.

## Option A Injected Fixture

A generated module extends the `page` fixture. Locator actions are wrapped, and `expect` on a wrapped locator is wrapped. `count()` is not wrapped, so the sample does not call itself.

Actions call `count()` before the action. Assertions call `count()` after the matcher settles, including when the matcher throws. One earlier build sampled assertions before the matcher. On that build, one of three default-worker runs recorded `matchCount` 0 for two passing `toHaveText` assertions (`getByTestId('title')` on the inventory page, and `getByTestId('inventory-item-name')` on the checkout overview). The assertions still passed. The shipped prototype samples assertions after the matcher so those settled counts stay in the file.

The selector stored is the locator's `_selector` string. That field is not a public Playwright API. `toString()` is stored as `api`. The first project stack frame supplies the file and line. Frames in `node_modules` and in `qcv-locator-fixture.ts` are skipped.

`playwright.config.ts`, `playwright.config.js`, and `playwright.config.mjs` are not rewritten. The fixture re-exports `test` and `expect` only.

## Option B Trace Parsing

`trace: 'on'` writes a zip per test. For Playwright 1.60.0 the zip contains `test.trace`, `0-trace.trace`, `0-trace.network`, `0-trace.stacks`, and `resources`. `test.trace` starts with `"version":8` and `"playwrightVersion":"1.60.0"`. The trace format is internal.

`0-trace.trace` is JSON lines. Action and expect calls use `before`, `log`, and `after` events. `before` carries `class`, `method`, `params.selector`, and `title`. `0-trace.stacks` maps a call id to `[fileOrdinal, line, column, function]` and lists the files. For the login helper, the files are `support/login.ts` and `tests/good/shopping.spec.ts`.

Passing `toBeHidden` on `#login-error-banner` (`call@16` in `tests/ai-style/locators.spec.ts`) has selector `#login-error-banner`, log `waiting for locator('#login-error-banner')`, and after result `{ matches: true }`. There is no element count. A passing hidden check does not say whether the count was 0 or the element was present and hidden.

The swallowed `toBeVisible` on the same selector times out at 1000 ms. Its after event has `errorMessage` `Error: element(s) not found`.

`toHaveText` on the locked-out error uses selector `internal:testid=[data-test="error"s]`. The log says `waiting for getByTestId('error')`. The after event has the received text and no count. A passing `toHaveCount` for the six inventory items does include `received.value.n` of 6. That number is the matcher result for `toHaveCount`, not a count on every expect.

## Option C Trace DOM Snapshots

The same zips include `frame-snapshot` events. The snapshot `html` value is a compressed tree of arrays, not an HTML string. Nodes can be inlined or stored as `[int, int]` refs. `frameUrl` is present. This shape is internal to Playwright 1.60.0.

In the locked-out trace, `after@call@112` (the login click) inlines one `H3` with `data-test` `error`. `before@call@116` (the `toHaveText` expect on that error) inlines zero nodes with `data-test` `error`, even though the element is already on the page. `after@call@116` inlines one `H3` and puts its children in refs. The string `login-error-banner` appears twice in the banner test's `0-trace.trace`, both times as the selector. It does not appear as a DOM id in the snapshots.

A CSS or attribute check can see an inlined node. It cannot see a node that the snapshot left as a ref, and it cannot evaluate `getByRole` without Playwright's engine. The snapshot also does not name the source line. That still comes from `0-trace.stacks`.

## What Each Option Can See

| Question | Option A | Option B | Option C |
| --- | --- | --- | --- |
| Passing `toBeHidden` on `#login-error-banner` | `matchCount` 0, call `toBeHidden`, file `tests/ai-style/locators.spec.ts` line 10 | Selector and passing result, no count | Selector text only. No DOM id in the snapshots |
| `not.toBeVisible` and `toHaveCount(0)` | See the measured extra spec below | Not present in the demo suite. A passing `toBeHidden` has no count. `toHaveCount` can carry `received.value.n` | Not measured offline. Incremental refs already miss inlined nodes |
| Page object | `support/login.ts` lines 6, 7, and 8 for the login helper | `0-trace.stacks` lists `support/login.ts` | The snapshot has the frame URL, not the helper file |
| Playwright version changes | `_selector` and the `.js` import of the `.ts` fixture can break | Trace version 8 fields can break | Snapshot array shape can break |

The demo suite has `toBeHidden` and does not have `not.toBeVisible` or `toHaveCount(0)`. Those two were measured with an extra spec in a temp copy of the demo project, not committed, so the suite findings stay as they are. One run of the prototype on that copy exited 0 and recorded, for `#login-error-banner`:

- `toBeHidden`, negated false, `matchCount` 0
- `toBeVisible`, negated true, `matchCount` 0
- `toHaveCount`, negated false, `matchCount` 0

The locked-out test in the demo suite recorded selector `internal:testid=[data-test="error"s]`, api `getByTestId('error')`, call `toHaveText`, `matchCount` 1, file `tests/good/shopping.spec.ts` line 32.

## Measured Run Time

`--workers=1` was passed to the baseline and trace commands. The injected workers=1 runs used a temp copy of the demo project with `workers: 1` added to the config. The shipped command does not set workers. Wall time is the whole command. The Playwright line is the duration Playwright printed.

Baseline, `playwright test --retries=0 --workers=1 --reporter=line`:

- Wall 8895 ms, Playwright 8.4s, exit 0
- Wall 8893 ms, Playwright 8.4s, exit 0
- Wall 8848 ms, Playwright 8.3s, exit 0

Trace, the same command plus `--trace=on`:

- Wall 9096 ms, Playwright 8.5s, exit 0
- Wall 9316 ms, Playwright 8.9s, exit 0
- Wall 9291 ms, Playwright 8.8s, exit 0

Injected fixture, workers 1, final prototype. Wall time includes the temp copy:

- Wall 8831 ms, Playwright 8.2s, exit 0, 47 records
- Wall 8555 ms, Playwright 8.0s, exit 0, 47 records
- Wall 8675 ms, Playwright 8.1s, exit 0, 47 records

On these nine runs the injected Playwright times are not above the baseline times. The samples are too close to call a stable overhead. The trace runs are the ones that grew (Playwright 8.5s, 8.9s, and 8.8s against baseline 8.4s, 8.4s, and 8.3s).

Reading the 18 trace zips from the earlier `--trace=on` run (2,777,932 bytes) by unzipping them and counting JSON lines in `0-trace.trace` took 69 ms and saw 821 events. That is the read cost only. It is not an offline selector engine.

Shipped CLI, unmodified demo project, default worker count, `--only locator-evidence`, three runs. Each exited 0 with 47 records. Wall times were 6809 ms, 6770 ms, and 7004 ms. The three `locator-evidence.json` files were byte-identical, 23368 bytes, sha256 `ebef5b50e2edf6a51fc46e2521d455aaaa08ac6d52181bfefb94d87332b9ba31`.

## The Choice

Option A is the prototype. It is the only option that recorded a number for the passing `#login-error-banner` check (`matchCount` 0) and a number for the locked-out error (`matchCount` 1). It also attributes the login helper to `support/login.ts`. Option B sees selectors, stack frames, and page URLs, and it does not see a count for a passing `toBeHidden`. Option C can see an inlined CSS or attribute node, and the before snapshot of the error expect omitted the error node that was already on the page.

The demo suite result did not change on the measured injected runs: 18 passed, 1 skipped, exit 0.

## Known Limits

- `count()` is an extra call. These SauceDemo runs stayed green. That does not prove a timing-sensitive suite would stay green.
- A count taken before a retrying assertion can be 0 while the assertion later passes. That happened in the earlier build described above. The shipped code counts an assertion after the matcher settles, so a node that disappears after the assertion can be missed the other way. That case was not observed here.
- `_selector` is private. `getByTestId('error')` is stored as `internal:testid=[data-test="error"s]`.
- Only locators created from the `page` fixture are wrapped. `browser.newPage()` is not wrapped.
- The fixture does not re-export other `@playwright/test` names. A value import of `chromium`, for example, fails in the temp copy. `import type` is erased by the compiler. The demo suite only imports `test` and `expect` as values.
- `expect.configure` is returned as the original function. An expect created from it is not wrapped.
- The evidence file has no timestamps, so these runs can match. Paths are relative to the project copy. Control characters are stripped with the same `displayText` rules as the reports.
