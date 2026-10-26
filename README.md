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

A test is trusted when the checks that ran found no warn or error. A warn is review. An error is untrusted. Skip and fixme are not-run. That includes a skip or fixme on the test, `test.skip()` or `test.fixme()` in the body, `testInfo.skip()`, and a test that `test.describe.serial` did not run after an earlier failure. Info does not lower a test that ran.

The static pass reads the spec files. It does not open a browser. Those rules are QCV-W000 through QCV-W010.

Hallucinated locators are a second pass, `--only locator`. It runs the suite once as a baseline, then again in a temp copy that records how many elements each locator matched. A test that fails the baseline is `baseline-red` and gets no locator finding. A test the baseline report marks skipped is `not-run`.

An absence assertion is not proof that the locator is real. This stays green when the element is missing:

```ts
await expect(page.locator('#login-error-banner')).toBeHidden();
```

QCV-L002 warns, and the message is: This test stays green even if this element does not exist. Check the locator against a state where the element is shown.

QCV-L001 is an error when an action or a positive assertion never matched. QCV-L003 warns when a locator matched more than one element and the test did not account for that, including `.first()`, `.last()`, and `.nth()`. QCV-L004 is info for a long CSS chain, XPath, `nth-child`, or a styling class. The report lists each locator as `unique`, `ambiguous`, or `never-matched`.

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
