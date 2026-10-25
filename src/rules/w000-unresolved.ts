import type { InventoryTest } from '../inventory/parse.js';
import type { Finding } from './types.js';

export const W000_RULE_ID = 'QCV-W000';

/** A helper or locator import that would need a second file is not guessed. */
export function findUnresolvedHelpers(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    for (const helper of test.unresolved) {
      findings.push({
        ruleId: W000_RULE_ID,
        check: 'weak-assertion',
        severity: 'info',
        file: helper.file,
        line: helper.line,
        column: helper.column,
        testTitle: test.titlePath.join(' > '),
        message: 'Could Not Resolve Helper',
        evidence: helper.source,
        fixHint: `Move the assertion or locator out of ${helper.name} into the test, or into a helper the spec imports directly.`,
      });
    }
  }
  return findings;
}
