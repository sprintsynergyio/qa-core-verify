# qa-core-verify Report

- Tool: qa-core-verify 0.0.1
- Started: 2026-10-25T00:00:00.000+00:00
- Finished: 2026-10-25T00:00:01.000+00:00

## Project

- Directory: fixture
- Config: fixture/playwright.config.ts
- Specs: 1
- Tests: 2

## Summary

### Severity

| Severity | Count |
| --- | --- |
| Error | 1 |
| Warning | 0 |
| Info | 0 |

### Verdict

| Verdict | Count |
| --- | --- |
| trusted | 1 |
| review | 0 |
| untrusted | 1 |
| baseline-red | 0 |
| not-run | 0 |

## Checks Run

- weak-assertion

## Tests

### passes

- File: fixture/a.spec.ts:3
- Verdict: trusted
- Findings: none

### needs a look

- File: fixture/a.spec.ts:8
- Verdict: untrusted

#### QCV-W001

- Severity: error
- Check: weak-assertion
- Location: fixture/a.spec.ts:8:1
- Message: Test has no assertion.
- Related Lint Rule: expect-expect
- Evidence:

```
No expect call and no configured assertion helper in this test.
```

- Fix:

```
Add an expect assertion, or call a helper named in qa-core-verify.config.json.
```
