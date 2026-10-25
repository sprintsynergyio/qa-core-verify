import type { InventoryTest } from '../inventory/parse.js';
import { ownerIdFor, type Finding } from './types.js';

export const W008_RULE_ID = 'QCV-W008';

/** A catch that does not throw lets a failed expect finish as a pass. */
export function findSwallowedExpects(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    for (const expect of test.expects) {
      if (!expect.swallowed) continue;
      findings.push({
        ruleId: W008_RULE_ID,
        check: 'weak-assertion',
        severity: 'error',
        file: expect.file,
        line: expect.line,
        column: expect.column,
        testTitle: test.titlePath.join(' > '),
        message: 'Try catch swallows the assertion failure.',
        evidence: expect.evidence,
        fixHint: 'Remove the catch, or rethrow the error.',
        ownerId: ownerIdFor('test', test.file, test.line, test.column, test.titlePath),
      });
    }
  }
  return findings;
}
