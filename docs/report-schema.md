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

`checksRun` lists the checks that ran. A default run lists `weak-assertion`. `--only locator` lists `locator`. `cannot-fail` is in the schema for a later check and is not run yet.

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
- `baseline-red` when `--only locator` saw that test fail in the baseline Playwright run. Failure is Playwright status `unexpected`. A `test.fail()` test that fails as expected has status `expected`, so it is not `baseline-red` and locator findings still apply. A `test.fail()` test that passes has status `unexpected` and is `baseline-red`. A failure in any project marks the row `baseline-red`. That row has no locator findings. The static checker does not assign `baseline-red`, so that count stays 0 on a static run.

`not-run` is for rows the checker did not treat as evaluated tests. A `test.describe.skip` block, and a test with `skip` or `fixme`, is `not-run` even when that row also has findings, and even when the baseline also failed. A test the baseline report marks skipped is `not-run` only when no project ran it. That includes `test.skip()` or `test.fixme()` in the body, `testInfo.skip()`, and a later test in `test.describe.serial` after a failure. A test skipped in one project and run in another is not `not-run`. `describe.only` is not in that extension. The test still ran, and an info finding on it stays `trusted`.

## Locators

`--only locator` adds `locators` on each evaluated test. Each entry is one selector from the evidence file, with `status` of `unique`, `ambiguous`, or `never-matched`. `counts` lists assertion match counts. `parentCounts` lists the count of the locator before `.first()`, `.last()`, or `.nth()`. A baseline-red row omits `locators`. The static report omits the field.

## Files

The default directory is `<project>/.qa-core/verify`. `--out <dir>` changes that directory. The file names are `report.json`, `report.md`, and `report.html`.

`--format console,json,md,html` chooses outputs. The default is all four. `console` is printed. The other three are files. `--json` prints the JSON report to stdout and does not also print the console report.

## Locator Evidence

`locator-evidence.json` is a separate file from `report.json`. `--only locator-evidence` writes it. `schemaVersion` is 1. It has no timestamps. Paths are relative to the project copy. `project.dir` is the project folder's base name after the same `displayText` cleaning as the report paths.

Each record is one locator action or one locator assertion. Records are sorted by file, line, column, test title, and kind (`phase`, then `call`), then the other fields except `matchCount`. `matchCount` is not a sort key, because an action count can change from run to run and would otherwise swap records that share a call site.

- `matchCount` is the raw number returned by `count()` after that call, or `null` when that call throws after a successful action. For an action, the count is taken after the action returns. The post-action count of any click that navigates or removes its target can vary between runs, and that count can be 0. In the eight-run sample, the add-to-cart clicks at `tests/good/shopping.spec.ts` lines 17 and 37 and `tests/ai-style/weak-assertions.spec.ts` line 38 were 0 every time. Counts that varied across samples are the checkout click at `tests/good/shopping.spec.ts` line 43, the continue click at `tests/good/shopping.spec.ts` line 47 (raw 0 once in a review sample), and the login click at `support/login.ts` line 8. Any navigating click can vary. Those lines are examples from the samples, not the full set. That field is the non-deterministic part of an action record. Assertion counts are taken after the matcher settles.
- `url` drops the query string. The hash stays.
- `selector` keeps every code point. C0, DEL, C1, U+2028, U+2029, and bidi controls are written as `\u` plus four lowercase hex digits.
- `parentCount` is the count of the locator before `.first()`, `.last()`, or `.nth()`. It is `null` when the use was not narrowed that way.
- `optionAbsence` is true when `toBeVisible` was called with `visible: false`, or `toBeAttached` was called with `attached: false`.
- `testColumn` is the column Playwright records for the `test()` call. A TypeScript `test()` call records the character after `test`. The inventory row matches that column and its own source column. Iterations that share the call are one row. `testTitle` on each record is the runtime title.
- `actionSucceeded` is true when the action returned, and false for a failed action and for every assertion.
- `resolvedOnAction` is derived only from `actionSucceeded`. It is true when a strict action returned, which means Playwright had resolved one element at action time. It is not a count, and it does not change when the later `matchCount` is 0.
