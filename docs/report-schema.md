# Report Schema

The checker writes one report in four forms. The JSON file and `--json` use this schema, `schema/report.schema.json`, JSON Schema draft 2020-12. `schemaVersion` is 1.

## Tool

`tool.name` is the package name. `tool.version` is the package version. Both are read from `package.json`.

`startedAt` and `finishedAt` are ISO 8601 timestamps in UTC with a numeric offset, for example `2026-10-25T00:00:00.000+00:00`.

## Project

`project.dir` is the project directory. `project.configFile` is the Playwright config file when one is present, and `null` when it is not. Paths are relative to the directory where the command was run.

`project.specCount` is the number of spec files that were scanned. `project.testCount` is the number of `test()` calls. A `test.describe.skip` block is not a test, so it is not included in `testCount`.

## Checks Run

`checksRun` lists the checks that ran. This version runs `weak-assertion`. `locator` and `cannot-fail` are in the schema for later checks and are not run yet.

## Tests

Each entry in `tests` is one `test()` or one `test.describe.skip` block.

`id` is the display path, line, column, and title path joined by ` > `. `titlePath` is the describe titles plus the test title. For a skipped describe, it is the describe titles only.

`findings` holds the findings for that row. A finding has the rule, the check, the severity, the file, the line, the column, the message, the evidence, the fix hint, and `relatedLintRule` when a lint rule is related.

A `test.describe.skip` row exists so its single finding has a place in `tests`. Summary counts are computed from `tests`, including those rows.

## Summary

`summary.severity` counts findings. `summary.verdict` counts rows in `tests`. Both are computed from `tests`. Neither count is written by hand.

## Verdict

This version assigns one verdict to each row:

- `not-run` when the row is a `test.describe.skip` block, or the test has `skip` or `fixme`. Findings on that row are still listed.
- `untrusted` when the row is not `not-run` and any finding has severity error.
- `review` when the row has no error finding and at least one warn or info finding.
- `trusted` when the row has no findings.
- `baseline-red` is reserved for a later check that the test already fails on the unchanged app. A static run does not assign it, so its count is 0.

## Files

The default directory is `<project>/.qa-core/verify`. `--out <dir>` changes that directory. The file names are `report.json`, `report.md`, and `report.html`.

`--format console,json,md,html` chooses outputs. The default is all four. `console` is printed. The other three are files. `--json` prints the JSON report to stdout and does not also print the console report.
