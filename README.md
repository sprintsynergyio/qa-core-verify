# qa-core-verify

qa-core-verify audits a Playwright test suite, often one written by an AI, and reports whether each test can be trusted to go red when the feature breaks.

Private, internal review build. Not released.

No LLM, no API key. The checker is deterministic: same suite, same app state, same findings, when the live site does not change a result.

```text
$ node dist/cli.js example-project/saucedemo

trusted  tests/good/shopping.spec.ts:5  login lands on the inventory page

untrusted  tests/ai-style/weak-assertions.spec.ts:5  opens the login page and stops
  QCV-W001  error  5:1  Test has no assertion.
    Evidence: No expect call and no configured assertion helper in this test.
    Fix: Add an expect assertion, or call a helper named in qa-core-verify.config.json.

Summary: 9 trusted, 3 review, 6 untrusted, 0 baseline-red, 1 not-run. 6 errors, 3 warnings, 3 info findings.
Checks run: weak-assertion.
Trusted means no warn or error findings from the checks that ran. Locator and cannot-fail checks did not run.
Reports: .qa-core/verify/report.json, .qa-core/verify/report.md, .qa-core/verify/report.html.
```

Copied from `node dist/cli.js example-project/saucedemo` on 2026-11-14. Other test lines from that run are left out. The summary line is the full run. Exit code was 1.

## What It Checks

Each test gets one verdict:

| Verdict | Meaning |
| --- | --- |
| trusted | No warn or error from the checks that ran |
| review | At least one warn, and no error |
| untrusted | At least one error |
| baseline-red | The test failed the baseline run |
| not-run | The check did not evaluate the test |

Info does not lower a test that ran.

Static rules, QCV-W000 through QCV-W010, read the spec files. They do not open a browser.

| Rule | What it detects | Severity |
| --- | --- | --- |
| QCV-W000 | Could not resolve a helper past one import | info |
| QCV-W001 | Test has no assertion | error |
| QCV-W002 | Generic matcher on a locator | error |
| QCV-W003 | Async assertion is not awaited | error |
| QCV-W004 | Value compared with itself | error |
| QCV-W005 | Existence check on a page read | warn |
| QCV-W006 | Presence only after the last action | warn |
| QCV-W007 | Expect in a branch or a loop | warn |
| QCV-W008 | Try catch swallows the assertion | error |
| QCV-W009 | Skipped or focused test | info |
| QCV-W010 | Hard wait with no assertion after it | info |

`--only locator` adds QCV-L001 through QCV-L004. `--only inversion` adds QCV-F001. `--only faults` adds QCV-F002, QCV-F003, and QCV-F004. Each rule is described in [docs/rules.md](docs/rules.md).

## Quick Start

Clone this repository and run the checker from that clone. This build is not published and is not installed from a registry.

```sh
git clone https://github.com/sprintsynergyio/qa-core-verify.git
cd qa-core-verify
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npm run build
node dist/cli.js example-project/saucedemo
```

`node dist/cli.js --help` prints the options. Pass spec paths or globs after the project directory to limit the static scan. Runtime checks (`--only locator`, `--only inversion`, `--only faults`) run the whole Playwright project and refuse spec paths.

The static command does not run the tests and does not open a browser. Locator, inversion, and fault checks do. Install Chromium first:

```sh
npx playwright install chromium
npm run build
node dist/cli.js example-project/saucedemo --only locator
node dist/cli.js example-project/saucedemo --only faults
```

Node.js 22.6 or later is required. `@playwright/test` and `playwright` are pinned to 1.60.0 in this package. A suite under test uses its own Playwright from its `node_modules`.

## How It Decides

### Static Rules

The static pass parses each spec with the TypeScript compiler API. It does not execute spec code. Helpers and page objects are followed one import level. A second import is QCV-W000 when the call could be an assertion or a locator.

A test is trusted when the checks that ran found no warn or error. A warn is review. An error is untrusted. Skip and fixme are not-run. That includes a skip or fixme on the test, `test.skip()` or `test.fixme()` in the body, `testInfo.skip()`, and a test that `test.describe.serial` did not run after an earlier failure. A test skipped in one project and run in another is not `not-run`. It is `not-run` only when no project ran it.

### Hallucinated Locators

`--only locator` runs the suite once as a baseline, then again in a temp copy that records how many elements each locator matched. A test that fails the baseline is `baseline-red` and gets no locator finding. Failure is Playwright status `unexpected`. `test.fail()` that fails as expected has status `expected`, so the Baseline line counts it as passed and locator findings still apply. `test.fail()` that passes has status `unexpected`, so the row is `baseline-red`. The baseline runs with `--retries=0`, so a test that fails its first attempt unexpectedly is `baseline-red` even if retries would make it pass. An expected `test.fail()` failure is not that case.

An absence assertion is not proof that the locator is real. This stays green when the element is missing:

```ts
await expect(page.locator('#login-error-banner')).toBeHidden();
```

QCV-L002 warns. QCV-L001 is an error when an action or a positive assertion never matched. QCV-L003 warns when a locator matched more than one element and the test did not account for that. `.first()` and `.last()` still warn. `.nth(index)` with a stated index does not. QCV-L004 is info for a long CSS chain, XPath, `nth-child`, or a class. The report lists each locator as `unique`, `ambiguous`, or `never-matched`.

### Assertion Inversion

`--only inversion` runs the suite once as a baseline in a temp copy. For each assertion in a green test it writes one mutant, runs only that test, then restores the file. The mutant adds `.not` when it is absent and removes `.not` when it is present. `.soft` and `.poll` stay. `toPass` and a custom matcher are not inverted. Those rows are `skipped` and the finding is info.

The unawaited `toBeVisible` at `example-project/saucedemo/tests/ai-style/weak-assertions.spec.ts:18` is killed. Playwright 1.60 fails that test when the unawaited locator assertion fails or is still pending at the end of the test. The static finding on that line stays QCV-W003.

Before the mutants, each green test is run on its own with no mutation. A test that does not pass that control run is not inverted. stderr prints `Control run did not pass for <file>:<line>.` and, when Playwright reported one, the first error line. On a live site that line is how a slow response shows up. The assertions are `not-run`. They are not counted as good.

`killed` means the inverted test broke its contract. `survived` is QCV-F001 at error. `timeout` and `error` are not counted as good. `--max-runs <n>` stops after n mutant runs. Control runs are not part of that count. stderr prints the plan after the control runs.

### Fault Injection

`--only faults` runs the suite once as a baseline, then once per fault, in a temp copy. The copy rewrites `@playwright/test` imports to a generated fixture. The fixture applies one fault per run with `context.addInitScript` and `context.route`. `browser.newContext()` and `browser.newPage()` get the same script and the same route. The original project is not written.

`blank-app` is built in. A green test that stays green on an empty body is QCV-F002. The blank check runs on each open page the test used, and again just before `page.close()`, because a page the test closes cannot be read afterwards. Each of those checks waits at most 1 second.

A page or context opened in a test body, a `beforeEach` or `afterEach` hook, a test scoped fixture, or a `test.fail`, `test.fixme`, or `test.skip` body counts only for that test. A page left open by a hook or a test scoped fixture counts only for the test that used it. A page left open by `beforeAll`, `afterAll`, or a worker scoped fixture stays armed for later tests while it is open, including tests outside that describe.

A test that never opens a page is `not-run` for a DOM fault. The row can still say `trusted`, because trusted means no warn or error from the checks that ran. The report then adds: `Every fault was not-run, so the cannot-fail check did not exercise this test.`

`qa-core-verify.faults.json` may add faults. `expectedToBreak` holds JavaScript regular expressions. A pattern that matches no inventoried test prints `Fault <id> expectedToBreak pattern "<pattern>" matched no test.` A listed test that stays green is QCV-F003. QCV-F004 warns when every fault cell passed and QCV-F002 did not already fire. `blank-app` is always in the run, so a test that stays green under every fault already has QCV-F002 and does not also get QCV-F004. The SauceDemo seeded constant test is that case.

A failed cell includes a short reason: the first line of the Playwright error.

Fault types:

- `blank-app`, params `{}`.
- `remove-element`, params `{ "selector": "css" }`.
- `hide-element`, params `{ "selector": "css" }`.
- `change-text`, params `{ "selector": "css", "text": "replacement" }`. When an absence assertion uses that same `locator()` selector and the selector still matches nothing, QCV-L002 is raised from warn to error. The SauceDemo demo does not show that upgrade.
- `block-request`, params `{ "urlPattern": "**/path" }`. `context.route` aborts the request for pages in the context. It does not affect the Playwright `request` fixture or a service worker.
- `user-swap`, params `{ "env": { "NAME": "value" } }`. The variables reach the Playwright process. Names match `[A-Za-z_][A-Za-z0-9_]*` and must not start with `QCV_`. Other names, including `PATH` and `NODE_OPTIONS`, are passed through.

Fault ids that differ only by case are rejected. `Blank-App` cannot sit beside the built-in `blank-app`.

The idea of mutating the DOM in the browser, instead of application source, comes from Yandrapally and Mesbah, "Mutation Analysis for Assessing End-to-End Web Tests", ICSME 2021. See [RESEARCH.md](RESEARCH.md). This checker does not claim to be that framework.

While a fault is active the `page` fixture sets the action timeout to 8 seconds and the navigation timeout to 15 seconds. The baseline keeps the project timeouts. Other pages keep the project timeouts.

Copy notes such as `Copy note: Skipped symlink ...` are printed after the `Baseline:` line.

When the baseline ran tests and none of the inventory locations match, stderr says `Baseline locations match no inventoried test. Fault cells are not-run. This run exits 2.` The run does not say the fault broke no test.

## Output

A default run prints one line per test, indented findings, a summary, the checks that ran, and the report paths. Paths inside the project are relative to the project folder. `--out <dir>` writes the files in another directory. When that directory is outside the project, the console prints the `--out` path as it was typed.

Reports:

- `.qa-core/verify/report.json` with `schemaVersion: 1`
- `.qa-core/verify/report.md`
- `.qa-core/verify/report.html`, one file, no external assets

`--json` prints the JSON report and nothing else on stdout. `--format console,json,md,html` chooses which reports to produce. The default is all four. `--format console` writes no files.

Exit codes: `0` no finding at or above `failOn` (default `error`), `1` a finding at or above `failOn`, `2` a tool or setup error. A fault run whose locations match no inventoried test exits 2.

The JSON shape is [docs/report-schema.md](docs/report-schema.md). The schema file is [schema/report.schema.json](schema/report.schema.json).

## Configuration

An optional `qa-core-verify.config.json` in the project directory names assertion helpers. A call that matches `assertFunctionNames` or `assertFunctionPatterns` counts as an assertion for QCV-W001.

```json
{
  "assertFunctionNames": ["assertLoggedIn"],
  "assertFunctionPatterns": ["^assert.*"]
}
```

Faults live in `qa-core-verify.faults.json` in the project directory. A missing file still runs `blank-app`. A file that omits `blank-app` still runs it first. An entry whose id is `blank-app` and whose type is not `blank-app` exits 2 before the temp copy.

`--config <file>` forwards a Playwright config to a temp run. `--config .` is accepted when that directory holds a `playwright.config.*` file. A directory with no such file is refused before the copy, and the command exits 2.

## CI

Run the static command on every pull request. Run locator, inversion, and fault checks on a schedule or from a manual trigger. The example is [examples/github-action.yml](examples/github-action.yml). The steps are in [docs/ci.md](docs/ci.md).

This repository's own CI typechecks and tests on Node 22 and Node 24, on Ubuntu 24.04. `ubuntu-latest` is Ubuntu 26.04, and Playwright 1.60.0 refuses Chromium there. It does not call SauceDemo unless someone starts the live demo workflow by hand.

## Limits

A clean report does not prove a suite is complete or correct. It only reports the checks that ran.

- The static pass does not open a browser and does not follow imports past one level.
- Coverage gaps are not part of this build. An AI agent red-team pack is not part of this build.
- Under any fault the `page` fixture action timeout is 8 seconds and the navigation timeout is 15 seconds. The baseline keeps the project values. A test that needs longer fails under every fault and counts as broken, which hides QCV-F002 and QCV-F004 for it. The fault file does not set these timeouts. `performance_glitch_user` on SauceDemo can be slow enough to hit that cap. See [example-project/saucedemo/FAULTS.md](example-project/saucedemo/FAULTS.md).
- `user-swap` variables reach the Playwright process. Names that start with `QCV_` are refused.
- `block-request` does not affect the Playwright `request` fixture or a service worker. A request-only test listed under that fault can still be QCV-F003.
- A page the test closes is checked just before `page.close()`. A page closed some other way, after the test has finished with it, is judged from the pages still open.
- A page left open by `afterAll` counts for later tests in the worker. The fixture does not know which describe opened it.
- The QCV-L002 upgrade to error is not shown in the SauceDemo demo.
- On a live site, one slow response can make a baseline or a control run fail. The row is `baseline-red`, or the control line names the test. Repeating a SauceDemo command does not promise byte-identical stdout when the site flakes.
- The tool does not modify the suite. Runtime work uses a temp copy. `.qa-core/` is gitignored.

## Demo Suite

`example-project/saucedemo` is a Playwright suite for [SauceDemo](https://www.saucedemo.com), a free practice app. It has a few honest tests and deliberately weak tests. The weak spots are marked with `SEEDED` comments and listed in `expected-findings.json`. See [example-project/saucedemo/README.md](example-project/saucedemo/README.md).

```sh
npx playwright install chromium
npm run demo:saucedemo -- tests/good
```

`npm test` includes a golden test that reads the manifest. The golden test does not open a browser. The SauceDemo runtime checks run when `QCV_LIVE=1`.

## Related Tools

[eslint-plugin-playwright](https://github.com/playwright-community/eslint-plugin-playwright) lints a spec for some of the same static mistakes, including `expect-expect` and `missing-playwright-await`. It does not run the suite, and it is not a dependency of this package. Where a rule overlaps, [docs/rules.md](docs/rules.md) names the lint rule.

[StrykerJS](https://stryker-mutator.io/) mutates application source and reruns tests. This checker does not need application source. It inverts assertions and changes the page in the browser.

[qa-core-heal](https://github.com/sprintsynergyio/qa-core-heal) repairs a broken Playwright locator and re-runs the test. It answers a different question: the locator is already red, what should replace it. This checker asks whether a green test would go red.

## License

MIT. Copyright 2026 Muhammad Usman. See [LICENSE](LICENSE).
