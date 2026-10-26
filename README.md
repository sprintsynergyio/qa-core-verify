# qa-core-verify

qa-core-verify audits a Playwright test suite, often one written by an AI, and reports whether each test can be trusted to go red when the feature breaks. This repository is work in progress, private, internal use only. It stays private until v0.1 review.

## Quick Start

Clone this repository and run the checker from that clone. This version reads spec files with the TypeScript parser. It does not run the tests, it does not execute spec code, and it does not open a browser. The install can skip the Playwright browser download.

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npm run build
node dist/cli.js <project-dir>
```

`node dist/cli.js --help` prints the options. Pass spec paths or globs after the project directory to limit the scan. `--json` prints the JSON report and nothing else on stdout. The report uses `schemaVersion: 1`. See [docs/report-schema.md](docs/report-schema.md).

## Output

A default run prints one line per test, indented findings, a summary, the checks that ran, and the report paths. Paths are relative to the project folder. This sample is copied from `node dist/cli.js example-project/saucedemo` in this repository. Other test lines from that run are left out. The summary line is the full run.

```text
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

That run writes `example-project/saucedemo/.qa-core/verify/report.json`, `report.md`, and `report.html`. `.qa-core/` is gitignored. `--out <dir>` writes the files in another directory. When that directory is inside the project, the console prints the paths relative to the project folder. When it is outside the project, the console prints the `--out` path as it was typed. `--format console,json,md,html` chooses which reports to produce. The default is all four. `--format console` writes no files.

An optional `qa-core-verify.config.json` in the project directory can name assertion helpers. A call that matches `assertFunctionNames` or `assertFunctionPatterns` counts as an assertion for QCV-W001. Patterns are regular expressions, the same idea as eslint-plugin-playwright `expect-expect`.

```json
{
  "assertFunctionNames": ["assertLoggedIn"],
  "assertFunctionPatterns": ["^assert.*"]
}
```

## How It Decides

A test is trusted when the checks that ran found no warn or error. A warn is review. An error is untrusted. Skip and fixme are not-run. That includes a skip or fixme on the test, `test.skip()` or `test.fixme()` in the body, `testInfo.skip()`, and a test that `test.describe.serial` did not run after an earlier failure. A test skipped in one project and run in another is not `not-run`. It is `not-run` only when no project ran it. A test with no baseline result is `not-run`. A failure in any project is `baseline-red`. Info does not lower a test that ran.

The static pass reads the spec files. It does not open a browser. Those rules are QCV-W000 through QCV-W010.

Hallucinated locators are a second pass, `--only locator`. It runs the suite once as a baseline, then again in a temp copy that records how many elements each locator matched. A test that fails the baseline is `baseline-red` and gets no locator finding. Failure is Playwright status `unexpected`. `test.fail()` that fails as expected has status `expected`, so the Baseline line counts it as passed and locator findings still apply. `test.fail()` that passes has status `unexpected`, so the Baseline line counts it as failed and the row is `baseline-red`. A test the baseline report marks skipped is `not-run` only when every project skipped it. A test with no baseline result is `not-run`. The baseline runs with `--retries=0`, so a test that fails its first attempt unexpectedly is `baseline-red` even if retries would make it pass. An expected `test.fail()` failure is not that case. On a live site, one slow response can make that row `baseline-red` for the same reason. The retries stay at 0.

An absence assertion is not proof that the locator is real. This stays green when the element is missing:

```ts
await expect(page.locator('#login-error-banner')).toBeHidden();
```

QCV-L002 warns, and the message is: This test stays green even if this element does not exist. Check the locator against a state where the element is shown.

QCV-L001 is an error when an action or a positive assertion never matched. QCV-L003 warns when a locator matched more than one element and the test did not account for that. `.first()` and `.last()` still warn. `.nth(index)` with a stated index does not, and neither does `toHaveText` or `toContainText` when the array length equals the match count. QCV-L004 is info for a long CSS chain, XPath, `nth-child`, or a class. Every class in a `locator()` or `frameLocator()` string counts. The report lists each locator as `unique`, `ambiguous`, or `never-matched`.

## Assertion Inversion

`--only inversion` is the cannot-fail check, rule QCV-F001. It runs the suite once as a baseline in a temp copy. For each assertion in a green test it writes one mutant, runs only that test (`<file>:<line>`) with `--retries=0` and `--workers=1`, then restores the file before the next mutant. The mutant adds `.not` when it is absent and removes `.not` when it is present. `.soft` and `.poll` stay. `toPass` and a custom matcher are not inverted. Those rows are `skipped` and the finding is info.

Outcomes are read from the Playwright JSON reporter. `killed` means a result status `failed`: the inverted test went red, which is what you want. `survived` means every result `passed`: the assertion did not make the test fail, and that is QCV-F001 at error. `timeout` is a result status `timedOut`. `error` is a missing report or any other result status. A timeout or an error is not counted as good. The test row is `not-run` when an assertion was not checked and none survived. `--max-runs <n>` stops after n mutant runs. stderr prints the plan before those runs (`Inversion plan: N mutants, M runs.`) and `Stopped at limit.` when the cap is hit. Assertions that were not started are `not-run` with that reason.

This check runs the suite once, then once more per assertion. A large suite costs that many Playwright runs. The runs are one at a time.

`--config <file>` is forwarded to the temp run. `--config .` and `--config` set to the project directory are accepted when that directory holds a `playwright.config.*` file. A directory that holds no `playwright.config.*` is refused before the copy, and the command exits 2. Playwright itself would run that directory with default settings. A missing config file is refused the same way, with one line, before the copy.

A `qcv-run-*` directory whose `owner.pid` is dead is not removed. That happens when SIGKILL stops the CLI and the watchdog together. Delete that `qcv-run-*` directory by hand. Startup does not sweep other runs.

## Rules

The static rules are QCV-W000 through QCV-W010. Each section in [docs/rules.md](docs/rules.md) says what the rule detects, why, a bad example, a good example, the severity, and the related lint rule when there is one.

- QCV-W000 Could Not Resolve Helper (info)
- QCV-W001 Test Has No Assertion (error)
- QCV-W002 Generic Matcher On A Locator (error)
- QCV-W003 Async Assertion Not Awaited (error)
- QCV-W004 Value Compared With Itself (error)
- QCV-W005 Existence Check On A Page Read (warn)
- QCV-W006 Presence Only After The Last Action (warn)
- QCV-W007 Expect In A Branch Or A Loop (warn)
- QCV-W008 Try Catch Swallows The Assertion (error)
- QCV-W009 Skipped Or Focused Test (info)
- QCV-W010 Hard Wait With No Assertion After It (info)

`--only locator` adds QCV-L001 through QCV-L004. The command opens a browser. It is not part of `npm test` unless `QCV_LIVE=1`.

`--only inversion` adds QCV-F001. The command opens a browser once for the baseline and once per inverted assertion. It is not part of `npm test` unless `QCV_LIVE=1`.

```sh
npx playwright install chromium
npm run build
node dist/cli.js example-project/saucedemo --only locator
```

## Demo Suite

The folder `example-project/saucedemo` is a Playwright suite for [SauceDemo](https://www.saucedemo.com), a free practice app. It has a few honest tests and deliberately weak tests. The weak spots are marked with `SEEDED` comments and listed in `expected-findings.json`. See [example-project/saucedemo/README.md](example-project/saucedemo/README.md).

```sh
npx playwright install chromium
npm run demo:saucedemo -- tests/good
```

`npm test` includes a golden test that reads that manifest. The golden test does not open a browser. To print the current findings:

```sh
npm run build
node dist/cli.js example-project/saucedemo
```

## License

MIT. Copyright 2026 Muhammad Usman. See [LICENSE](LICENSE).
