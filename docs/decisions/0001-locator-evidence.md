# Locator Evidence

This spike compares three ways to record how many elements a Playwright locator matched. The runs used Playwright 1.60.0 and the SauceDemo demo suite in `example-project/saucedemo`. That suite has 19 tests. On every run below, 18 passed and 1 was skipped (`skipped inventory check`). The site was `https://www.saucedemo.com`.

The prototype is option A. `--only locator-evidence` copies the project to a temp directory, follows symlinks so the copy holds regular files, symlinks `node_modules`, rewrites `@playwright/test` imports, and writes `locator-evidence.json`. A file is written in that copy only when `lstat` says it is a regular file and `realpath` keeps it inside the copy.

## Option A Injected Fixture

A generated module extends the `page` fixture. Locator actions are wrapped, and `expect` on a wrapped locator is wrapped. `count()` is not wrapped, so the sample does not call itself.

Actions run first. `count()` runs after the action returns. `matchCount` is that raw count. The prototype does not replace it with another number. A successful Playwright action is strict: it resolved one element when it ran. The record stores that fact as `resolvedOnAction`, which is true only when `actionSucceeded` is true. `resolvedOnAction` is not a count. After the action, the page can navigate or the element can be removed, so the later `matchCount` can be 0 even when `resolvedOnAction` is true. That later count can also differ from run to run. A failed action keeps the count taken after the throw, which can be 0, and sets both `actionSucceeded` and `resolvedOnAction` false. If `count()` throws, that call is not recorded, because there is no raw count to store. Assertions call `count()` after the matcher settles, including when the matcher throws, and a count of 0 stays 0. One earlier build sampled assertions before the matcher. On that build, one of three default-worker runs recorded `matchCount` 0 for two passing `toHaveText` assertions (`getByTestId('title')` on the inventory page, and `getByTestId('inventory-item-name')` on the checkout overview). The assertions still passed. The shipped prototype samples assertions after the matcher so those settled counts stay in the file. An earlier build sampled actions before Playwright waited, so successful actions were stored with `matchCount` 0. A later build then forced those counts to 1. This build stores the raw count and `resolvedOnAction` instead.

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

Shipped CLI, unmodified demo project, default worker count, `--only locator-evidence`, three runs before the action-count fix. Each exited 0 with 47 records. Wall times were 6809 ms, 6770 ms, and 7004 ms. Those three `locator-evidence.json` files were byte-identical, 23368 bytes, sha256 `ebef5b50e2edf6a51fc46e2521d455aaaa08ac6d52181bfefb94d87332b9ba31`.

The same command on the build that forced a successful action's `matchCount` to 1, three runs. Each exited 0 with 47 records. Wall times were 7184 ms, 7185 ms, and 7203 ms. Those three files were byte-identical, 24931 bytes, sha256 `4763d59659370726b798a6b10bfd3ea39dee6bc79deaca2b6fdf6d6f6fc4bfdb`. That build is not the current one. It stored 1 for actions whose raw later count was 0.

Records are sorted by file, line, column, test title, and kind (`phase`, then `call`), then the other deterministic fields. `matchCount` is not a sort key. `evidenceWithoutActionMatchCount` sorts with that same order and then drops `matchCount` from action records. Assertion `matchCount` and `resolvedOnAction` stay. A review of the previous sort ran the CLI eight times. The `support/login.ts` line 8 click was raw `matchCount` 0 on 5 of those runs and 1 on the other 3, and the stable sha matched on only 5 of the 8 (`ac701d92f08b776e6a5ddf075377d23551991522c5fd888d9461f7f99c1cefa5`, with `eec6db01`, `bd41a279`, and `380a6619` on the other three). Sorting by `matchCount` before the test title swapped those login records.

Current CLI, raw `matchCount`, eight runs on 2026-10-25 after that sort change. Each exited 0 with 48 records. Wall times were 7514 ms, 7411 ms, 7708 ms, 7417 ms, 7201 ms, 7205 ms, 7285 ms, and 7385 ms. Each file was 26969 bytes. The raw files were not byte-identical. Three raw sha256 values appeared: `dd5ae98bb631d70c1b09b5fc01ea8cd92a9118dffb9589657730e26118a1da8f` on run 1, `051d32d5a0c1f321085df35801c90a6e35280988ecf0f5d336ecde3d0e096796` on runs 2, 3, 4, 5, 7, and 8, and `fc066813ee0c32476d58527d5ad911ba4d50a4a03398c78a36d4c07c930a7a9d` on run 6.

The sha256 of `JSON.stringify` of `evidenceWithoutActionMatchCount` was `1d6735ac913daed78b13078078412c83ab1f964c6472ef79647be6eef2676ec8` on all eight runs. That string was 20181 bytes.

The post-action count of any click that navigates or removes its target can vary between runs. The calls below are examples, not the full set. On all eight runs, the add-to-cart clicks were raw `matchCount` 0 with `resolvedOnAction` true every time: `tests/good/shopping.spec.ts` line 17, `tests/good/shopping.spec.ts` line 37, and `tests/ai-style/weak-assertions.spec.ts` line 38. Counts that varied: the checkout click at `tests/good/shopping.spec.ts` line 43 was raw `matchCount` 0 on run 1 and 1 on the other seven. The login click at `support/login.ts` line 8 varies. In this sample the click inside `login lands on the inventory page` was raw `matchCount` 0 on run 6 and 1 on the other seven, and the other five login clicks were 1 on every run. The first name fill at `tests/good/shopping.spec.ts` line 44 was 1 on every run. A review also saw the continue click at `tests/good/shopping.spec.ts` line 47 record raw `matchCount` 0 once.

The 48th record, which the 47-record files above did not have, is the unawaited `expect(page.getByText('Products')).toBeTruthy()` at `tests/ai-style/weak-assertions.spec.ts` line 12. The page fixture waits up to 2 seconds for in-flight records, which is what stored that call. The record is filed at the test line, `tests/ai-style/weak-assertions.spec.ts` 9:1, for now. On all eight runs it was an assertion, call `toBeTruthy`, `matchCount` 0, `resolvedOnAction` false.

## The Choice

Option A is the prototype. It is the only option that recorded a number for the passing `#login-error-banner` check (`matchCount` 0) and a number for the locked-out error (`matchCount` 1). It also attributes the login helper to `support/login.ts`. Option B sees selectors, stack frames, and page URLs, and it does not see a count for a passing `toBeHidden`. Option C can see an inlined CSS or attribute node, and the before snapshot of the error expect omitted the error node that was already on the page.

The demo suite result did not change on the measured injected runs: 18 passed, 1 skipped, exit 0.

## Known Limits

- `count()` is an extra call. These SauceDemo runs stayed green. That does not prove a timing-sensitive suite would stay green.
- A count taken before a retrying assertion can be 0 while the assertion later passes. That happened in the earlier build described above. The shipped code counts an assertion after the matcher settles, so a node that disappears after the assertion can be missed the other way. That case was not observed here.
- `matchCount` on an action is the raw count after the action returns. It is the non-deterministic field. The post-action count of any click that navigates or removes its target can vary between runs, and it can be 0 after a click that succeeded. `resolvedOnAction` stays true for a strict action that returned, including when that later count is 0. Assertion `matchCount` is taken after the matcher and stays in the deterministic comparison. Record order does not use `matchCount`. `evidenceWithoutActionMatchCount` sorts by file, line, column, test title, and kind, then drops action `matchCount`. In the eight-run sample the add-to-cart clicks at `tests/good/shopping.spec.ts` lines 17 and 37 and `tests/ai-style/weak-assertions.spec.ts` line 38 were 0 every time. Counts that varied across samples are the checkout click at `tests/good/shopping.spec.ts` line 43, the continue click at `tests/good/shopping.spec.ts` line 47, and the login click at `support/login.ts` line 8.
- `_selector` is private. `getByTestId('error')` is stored as `internal:testid=[data-test="error"s]`. A control character in that string is escaped as `\u` plus four lowercase hex digits. It is not deleted. `getByTestId('a\u0085b')` is not stored as `ab`.
- `url` drops the query string so two loads of the same page compare equal. The hash stays.
- Locators created from the `page` fixture are wrapped. `frameLocator()` is wrapped, and so are locators created from that frame. `context.newPage()` and pages delivered through `context.on('page')` are wrapped, which covers a popup opened from the page. `browser.newPage()` is not wrapped.
- The fixture re-exports every value from `@playwright/test`, so `chromium`, `devices`, and `mergeTests` keep working. `import type` is erased by the compiler.
- `expect.configure` is returned as the original function. An expect created from it is not wrapped.
- A project file that imports a path outside the project folder is not copied, because the temp tree is only that folder. A `globalSetup` file at `../setup`, or a monorepo import that leaves the project, fails in the copy the same way a copied folder would fail if that file were missing. Run the checker from a project whose own files are inside the project directory.
- The evidence file and line skip frames in `node_modules` and in `qcv-locator-fixture.ts`. Playwright's own failure output can still name `qcv-locator-fixture.ts`, because that output is Playwright's stack, not the evidence call site.
- `.first()`, `.last()`, and `.nth()` also record `parentCount`, the count of the locator before that call.
- A successful action whose later `count()` throws is stored with `matchCount` null. A failed action whose `count()` throws is omitted.
- Part files are appended one JSON line at a time. A refused write is reported as `QCV_EVIDENCE_ERROR` and the run fails.
- The stack for an assertion is captured before `count()` is awaited, so an unawaited expect keeps the call line.
- `playwright.config.ts`, `.js`, `.mts`, `.mjs`, `.cts`, and `.cjs` are not rewritten. `--config <file>` is forwarded and not rewritten.
- A dangling symlink is skipped. A symlink is a loop only when its target is an ancestor of the link, or that target is already on the current copy path. A link to a directory that was already copied somewhere else is copied again. The run prints `Skipped symlink` and the reason. It does not exit 2 for that link.
- Startup does not delete `qcv-run-*` or `qcv-workspace-*` directories. A workspace kept with `--keep-workspace` stays, and so does an unrelated directory such as `qcv-workspace-my-notes`. Playwright is started under a parent-death watchdog, so a SIGKILL of the CLI stops the child and removes that run unless `--keep-workspace` was set.
- A backslash anywhere in `TMPDIR` makes Playwright fail to load the copied config (`ERR_INVALID_MODULE_SPECIFIER`). The same failure happens with `npx playwright test` in that path. The CLI prints the Playwright output tail when that run writes no records.
- A tool error before the copy exists, such as a missing project path, prints no Workspace line. Nothing is kept on that path.
- The evidence file has no timestamps, so these runs can match. Paths are relative to the project copy. `project.dir` still uses `displayText`, which strips controls and bidi marks. Selectors do not. Titles in the report strip U+2028 and U+2029 by turning them into spaces. Evidence and fix hints keep `\n` inside Markdown fences and HTML `<pre>` blocks.
- `--only locator-evidence` does not accept `--json`, `--format`, or `--fail-on`. Those flags exit 2 before Playwright starts.
- SIGINT exits 130, SIGHUP exits 129, and SIGTERM exits 143. All three stop the Playwright child and its process group, including Chromium, even when `--keep-workspace` is set. The handler stays installed, and a second signal while cleanup is running is ignored, so a fast double Ctrl-C still waits for the child to exit before deleting the temp copy. The temp copy is removed after that child has exited, unless `--keep-workspace` was set. `--keep-workspace` skips the delete and still stops the child. Playwright is started in its own process group, so a SIGHUP that reached only the CLI would otherwise leave Chromium running. The Playwright child gets `TMPDIR`, `TMP`, and `TEMP` set to a unique directory created with `mkdtemp` beside the project copy, under the same run directory, prefixed `.qcv-browser-`. That sibling is not part of the copy, so a later run on a kept workspace does not carry it forward. The copy includes the project's own paths, including a directory named `.qcv-tmp` at any depth. Chromium's profile and any `.org.chromium.Chromium.*` file are created in that sibling, and the cleanup that removes the run also removes the sibling, so killing Chromium does not leave them in the user's temp directory. The kept workspace is the `qcv-run-XXXXXX` directory. After the run it contains only `project`, the copied tree. The `.qcv-browser-` sibling is removed even when the run is kept, so deleting only `project` would leave an empty `qcv-run-XXXXXX` directory. The printed path is that run directory. A finished run with `--keep-workspace`, and SIGINT, SIGTERM, and SIGHUP with `--keep-workspace`, each print one line on stderr: `Workspace: ` plus the absolute run directory. A backslash in that path is doubled. C0, DEL, C1, U+2028, U+2029, and bidi controls are then escaped as `\u` plus four lowercase hex digits. The path is not shortened with `~`, and the line is not written to stdout. A tool error before the copy exists prints no Workspace line. The signal tests read `/proc`, so they run on Linux and are skipped on other platforms.
