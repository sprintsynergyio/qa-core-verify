# Report Schema

The checker writes one report in four forms. The JSON file and `--json` use this schema, `schema/report.schema.json`, JSON Schema draft 2020-12. `schemaVersion` is 1.

## Tool

`tool.name` is the package name. `tool.version` is the package version. Both are read from `package.json`.

`startedAt` and `finishedAt` are ISO 8601 timestamps in local time. The offset is the offset of that local time, for example `+05:00` when the machine is five hours ahead of UTC.

## Project

`project.dir` is the base name of the project folder. It is `.` when that name is empty, which is the filesystem root. It is never an absolute path, and it does not change with the current working directory.

`project.configFile` is the Playwright config file when one is present, and `null` when it is not. Every other file path in the report is also relative to the project folder and uses `/` separators. That includes each test `file`, each finding `file`, the file portion of `id`, and the report paths on the console.

`project.specCount` is the number of spec files that were scanned. `project.testCount` is the number of `test()` calls. A `test.describe.skip` block is not a test, so it is not included in `testCount`.

## Checks Run

`checksRun` lists the checks that ran. A default run lists `weak-assertion`. `--only locator` lists `locator`. `--only inversion` and `--only faults` list `cannot-fail`. A fault run that raises QCV-L002 also lists `locator`.

The console prints `Checks run:` with that list. The Markdown report lists it under Checks Run. The HTML report prints it in the header. The console summary, the Markdown summary, and the HTML header also name the `locator` and `cannot-fail` checks that did not run. When neither ran, that sentence is: Trusted means no warn or error findings from the checks that ran. Locator and cannot-fail checks did not run. When only one of them ran, the sentence names the other check.

## Tests

Each entry in `tests` is one `test()` or one `test.describe.skip` block.

`id` is the display path, line, column, and title path joined by ` > `. `titlePath` is the describe titles plus the test title. For a skipped describe, it is the describe titles only.

`findings` holds the findings for that row. A finding has the rule, the check, the severity, the file, the line, the column, the message, the evidence, the fix hint, and `relatedLintRule` when a lint rule is related.

A `test.describe.skip` row exists so its single finding has a place in `tests`. Summary counts are computed from `tests`, including those rows.

## Summary

`summary.severity` counts findings. `summary.verdict` counts rows in `tests`. Both are computed from `tests`. Neither count is written by hand.

## Verdict

Each row gets one verdict:

- `trusted` when the row has no finding at warn level or above. Info findings, including QCV-W000, QCV-W009, and QCV-W010, stay `trusted`.
- `review` when the row has at least one warn finding and no error finding. A warn means the test is weak. It does not prove the test is useless.
- `untrusted` when the row has at least one error finding. QCV-L001 is an error when a locator used in an action or a positive assertion matched 0 elements in every use.
- `baseline-red` when `--only locator` saw that test fail in the baseline Playwright run. Failure is Playwright status `unexpected`. A `test.fail()` test that fails as expected has status `expected`, so it is not `baseline-red` and locator findings still apply. A `test.fail()` test that passes has status `unexpected` and is `baseline-red`. A failure in any project marks the row `baseline-red`. The baseline runs with `--retries=0`, so a test that fails its first attempt is `baseline-red` even if retries would make it pass. That row has no locator findings. The static checker does not assign `baseline-red`, so that count stays 0 on a static run.

`not-run` is for rows the checker did not treat as evaluated tests. A `test.describe.skip` block, and a test with `skip` or `fixme`, is `not-run` even when that row also has findings, and even when the baseline also failed. A test the baseline report marks skipped is `not-run` only when no project ran it. That includes `test.skip()` or `test.fixme()` in the body, `testInfo.skip()`, and a later test in `test.describe.serial` after a failure. A test skipped in one project and run in another is not `not-run`. A test with no baseline result is `not-run`. `describe.only` is not in that extension. The test still ran, and an info finding on it stays `trusted`.

`reason` is set on a row when the checker knows why that row is `not-run`, and when a fault run left every cell `not-run` on a test that passed the baseline. That second reason is `Every fault was not-run, so the cannot-fail check did not exercise this test.` The verdict stays `trusted` when there is no warn or error. A test that failed only in the locator evidence run has the reason `The test did not pass in the evidence run.` A fault run whose baseline locations match no inventoried test sets `The baseline locations do not match the inventoried tests.` and the row is `not-run`.

## Inversion

`inversion` is present when `--only inversion` ran. The counts are computed from `tests[].assertions`.

`runs` is `killed` plus `survived` plus `timeout` plus `error`.

`mutants` is `runs` plus the assertions whose outcome is `not-run` and whose reason is `Stopped at limit.` An assertion that is `not-run` because the test did not run in the baseline, because the test failed the baseline, or because the control run did not pass, is not a mutant. An assertion that is `skipped` is not a mutant. A demo can show more `not-run` assertions than `mutants` counts, because those extra rows were not inverted.

`stoppedAtLimit` is true when at least one assertion was stopped at `--max-runs`.

The plan line is printed after the control runs. Control runs are not part of `mutants`, `runs`, or `--max-runs`.

## Faults

`faultRun` is present when `--only faults` ran. `faultRun.faults` lists each fault id and type. `blank-app` is always included.

Each test may have `faults`, one cell per fault. `result` is `pass`, `fail`, `skipped`, or `not-run`. `pass` means the Playwright test status was `expected` and the fault was applied. `fail` means `unexpected`, and the cell `reason` is the first line of the Playwright error, or `The test failed.` when that line is missing. `not-run` is also used when a page fault never reached a page the test used, or when a passing test's page was not blank at the end, including a page the test closed after replacing the body. The close check runs just before `page.close()`. A page opened in `beforeAll`, `afterAll`, or a worker scoped fixture counts as reached while it is open. A page opened in a test body, `beforeEach`, `afterEach`, or a test scoped fixture stops counting when that test ends. A page closed before the test started does not. A baseline test missing from a fault run is `not-run` with reason `The test was not found in the fault run.` That cell has a `reason`. The console prints one `Fault <id> <result>` line per cell, and the reason on the same line when it is set. A `Faults:` summary is computed from those cells. QCV-F004 is not written when QCV-F002 is already written for that test.

## Locators

`--only locator` adds `locators` on each evaluated test. Each entry is one selector from the evidence file, with `status` of `unique`, `ambiguous`, or `never-matched`. `counts` lists assertion match counts. `parentCounts` lists the count of the locator before `.first()`, `.last()`, or `.nth()`. A baseline-red row omits `locators`. The static report omits the field.

## Files

The default directory is `<project>/.qa-core/verify`. `--out <dir>` changes that directory. The file names are `report.json`, `report.md`, and `report.html`.

`--format console,json,md,html` chooses outputs. The default is all four. `console` is printed. The other three are files. `--json` prints the JSON report to stdout and does not also print the console report.

## Locator Evidence

`locator-evidence.json` is a separate file from `report.json`. `--only locator-evidence` writes it. `schemaVersion` is 1. It has no timestamps. Paths are relative to the project copy. `project.dir` is the project folder's base name after the same `displayText` cleaning as the report paths.

Each record is one locator action or one locator assertion. Records are sorted by file, line, column, test title, and kind (`phase`, then `call`), then the other fields except `matchCount`. `matchCount` is not a sort key, because an action count can change from run to run and would otherwise swap records that share a call site.

- `matchCount` is the raw number returned by `count()` after that call, or `null` when that call throws after a successful action. For an action, the count is taken after the action returns. The post-action count of any click that navigates or removes its target can vary between runs, and that count can be 0. In the eight-run sample, the add-to-cart clicks at `tests/good/shopping.spec.ts` lines 17 and 37 and `tests/ai-style/weak-assertions.spec.ts` line 38 were 0 every time. Counts that varied across samples are the checkout click at `tests/good/shopping.spec.ts` line 43, the continue click at `tests/good/shopping.spec.ts` line 47 (raw 0 once in a review sample), and the login click at `support/login.ts` line 8. Any navigating click can vary. Those lines are examples from the samples, not the full set. That field is the non-deterministic part of an action record. Assertion counts are taken after the matcher settles.
- `url` is the page URL after the action or assertion returns. A navigating click stores the URL of the page it landed on. The query string is dropped. The hash stays. The post-action `count()` of a navigating click can differ between live runs, so `locator-evidence.json` is not byte-identical across those runs. Verdicts do not use that count as a sort key.
- `selector` keeps every code point. C0, DEL, C1, U+2028, U+2029, and bidi controls are written as `\u` plus four lowercase hex digits.
- `parentCount` is the count of the locator before `.first()`, `.last()`, or `.nth()`. It is `null` when the use was not narrowed that way.
- `optionAbsence` is true when `toBeVisible` was called with `visible: false`, or `toBeAttached` was called with `attached: false`. The flag stays true when the matcher is also negated. `not.toBeVisible({ visible: false })` is a positive check: the negation and the option cancel, so it is not an absence check.
- `nthIndex` is the number passed to `.nth()`, or `null` when the use was not narrowed that way. A stated index is not QCV-L003. `.first()` and `.last()` leave `nthIndex` null.
- `testColumn` is the column Playwright records for the `test()` call. A TypeScript `test()` call records the character after `test`. The inventory row matches that column and its own source column. Iterations that share the call are one row. `testTitle` on each record is the runtime title.
- `actionSucceeded` is true when the action returned, and false for a failed action and for every assertion.
- `resolvedOnAction` is derived only from `actionSucceeded`. It is true when a strict action returned, which means Playwright had resolved one element at action time. It is not a count, and it does not change when the later `matchCount` is 0.
