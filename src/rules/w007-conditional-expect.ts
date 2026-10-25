import type { InventoryTest } from '../inventory/parse.js';
import type { Finding } from './types.js';

export const W007_RULE_ID = 'QCV-W007';

/** An expect in a branch, catch, or loop may never run, so the test can stay green. */
export function findConditionalExpects(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    for (const expect of test.expects) {
      if (!expect.conditional) continue;
      findings.push({
        ruleId: W007_RULE_ID,
        check: 'weak-assertion',
        severity: 'warn',
        file: expect.file,
        line: expect.line,
        column: expect.column,
        testTitle: test.titlePath.join(' > '),
        message: 'Expect is inside a branch or a loop that may not run.',
        evidence: expect.evidence,
        fixHint: 'Move the expect out of the branch or loop so a missing step fails the test.',
        relatedLintRule: 'no-conditional-expect',
      });
    }
  }
  return findings;
}
