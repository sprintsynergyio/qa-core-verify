# Changelog

## Unreleased

- `--only locator` runs QCV-L001 through QCV-L004. A baseline failure is `baseline-red` and gets no locator finding. Reports list each locator as `unique`, `ambiguous`, or `never-matched`. QCV-L002, QCV-L003, and QCV-L004 are active in the SauceDemo manifest. The live check runs when `QCV_LIVE=1`.
- Locator evidence keeps selector controls as `\u` escapes, drops query strings, records parent counts for `.first()`, `.last()`, and `.nth()`, and re-exports `@playwright/test`. `frameLocator` and pages from `context.newPage()` or a popup are wrapped. A broken evidence run with no records prints the Playwright output tail.
- `--only locator-evidence` records locator match counts in a temp copy of the project. The choice and the measurements are in `docs/decisions/0001-locator-evidence.md`.
- A locator action records the raw `count()` taken after the action returns. `resolvedOnAction` is true when that strict action returned. Record order does not use `matchCount`. The temp copy follows symlinks, and a rewrite is refused unless the file is a regular file inside that copy. `project.dir` drops control characters and bidi overrides. `--json`, `--format`, and `--fail-on` exit 2 with that mode. SIGINT, SIGHUP, and SIGTERM stop Playwright and Chromium, then remove the temp copy. A repeat of those signals during cleanup is ignored. Chromium's temp files are created in a unique directory beside the project copy, and that directory is removed with the run. The copy includes the project's own files, including a directory named `.qcv-tmp`. With `--keep-workspace`, the kept directory is `qcv-run-XXXXXX` and it contains `project`. The `.qcv-browser-` sibling is removed even when that directory is kept. A normal finish, SIGINT, SIGTERM, and SIGHUP each print `Workspace: ` plus that absolute path on stderr. C0 and C1 controls in the path are escaped as `\u` plus four lowercase hex digits. The path is not shown with `~`.
- When `--out` is outside the project, the console prints that path as it was typed.
- Evidence and fix hints drop C1 controls and bidi overrides before they are printed.
- The HTML rule filter hides a whole test when none of its rules are checked.
- A const alias of `expect.soft` is a soft assertion. `let` and `var` are not followed.
- QCV-W006 still flags a presence-only assertion when a click is followed by `page.goto`.
- QCV-W003 uses one fix hint for an unawaited assertion and an unawaited call.
- A row is trusted when it has no warn or error finding. Review means a warn. Untrusted means an error. Skip, fixme, and describe.skip stay not-run.
- Report paths are relative to the project folder. `project.dir` is the folder's base name.
- Markdown escapes titles, file names, and messages. Timestamps use local time and its offset. Reports name the checks that ran.
- Write a console report, a JSON report with schemaVersion 1, a Markdown report, and a single-file HTML report.
- QCV-W003 flags an unawaited async helper and an unawaited test.step block that contain an assertion, and it flags unawaited resolves and rejects matchers. An awaited then, catch, or finally chain is waiting. The message says the async assertion is not awaited.
- A const alias of expect in the file, a describe callback, or the test is treated as expect.
- QCV-W008 treats a catch that throws only inside one branch of an if as swallowing the other path.
- page.goto is not a user action for QCV-W006.
- test.describe.skip produces one finding for the block, including when the block has no tests.
- Treat an awaited or returned Promise.all, Promise.allSettled, and test.step as waiting for the assertion inside it.
- Follow locator and page read fields on a page object, including constructor assignments, initializers, and getters.
- Flag every unawaited async matcher, including expect.poll, without requiring the subject to be a locator or a page.
- Do not flag a loop over a non-empty array literal, or over a const in the same test bound to one.
- Add static weak assertion rules QCV-W000 through QCV-W010, with one file per rule and good and bad fixtures.
- Follow one relative import into a helper or page object. A second import is QCV-W000 when the call could be an assertion or a locator.
- Scaffold the TypeScript CLI, the spec inventory parser, and rule QCV-W001 Test Has No Assertion.
- Do not inventory a test call inside a hook callback or a timer callback.
- Add a SauceDemo demo suite, an expected-findings manifest, and a golden test for active findings.
