# qa-core-verify Report

- Tool: qa-core-verify 0.0.1
- Started: 2026-01-15T05:00:00.000+05:00
- Finished: 2026-01-15T05:00:01.000+05:00

## Project

- Directory: probes
- Config: playwright.config.ts
- Specs: 1
- Tests: 4

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
| trusted | 3 |
| review | 0 |
| untrusted | 1 |
| baseline-red | 0 |
| not-run | 0 |

Trusted means no warn or error findings from the checks that ran. Locator and cannot-fail checks did not run.

## Checks Run

- weak-assertion

## Tests

### &lt;img src=x onerror=alert\(4\)&gt;

- File: bad/&lt;img&gt;.spec.ts:1
- Verdict: trusted
- Findings: none

### line one line two

- File: dir/file name.spec.ts:2
- Verdict: trusted
- Findings: none

### a \| b &gt; &lt;b&gt;bold&lt;/b&gt;

- File: pipe.spec.ts:3
- Verdict: trusted
- Findings: none

### \[link\]\(javascript:...\)

- File: link.spec.ts:4
- Verdict: untrusted

#### QCV-W001

- Severity: error
- Check: weak-assertion
- Location: link.spec.ts:4:1
- Message: sees &lt;b&gt; and \| and \[link\]\(javascript:...\)
- Evidence:

``````
seen ``` and ````` here
``````

- Fix:

`````
fix ```` hint
`````
