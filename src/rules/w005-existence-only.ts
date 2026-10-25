import type { ExpectCall, InventoryTest } from '../inventory/parse.js';
import { ownerIdFor, type Finding } from './types.js';

export const W005_RULE_ID = 'QCV-W005';

/**
 * A page read checked only for presence, or a count checked against zero.
 * The test stays green for any non-empty text, or for an empty list.
 */
export function findExistenceOnly(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    for (const expect of test.expects) {
      if (!isExistenceOnly(expect)) continue;
      findings.push({
        ruleId: W005_RULE_ID,
        check: 'weak-assertion',
        severity: 'warn',
        file: expect.file,
        line: expect.line,
        column: expect.column,
        testTitle: test.titlePath.join(' > '),
        message: 'Existence check does not verify the page value.',
        evidence: expect.evidence,
        fixHint: 'Assert the expected text, attribute, input value, or count.',
        ownerId: ownerIdFor('test', test.file, test.line, test.column, test.titlePath),
      });
    }
  }
  return findings;
}

function isExistenceOnly(expect: ExpectCall): boolean {
  if (expect.subjectKind !== 'page-read' || !expect.pageRead) return false;
  if (!expect.not && (expect.matcher === 'toBeTruthy' || expect.matcher === 'toBeDefined')) return true;
  if (expect.not && expect.matcher === 'toBeNull') return true;
  return (
    !expect.not &&
    expect.matcher === 'toBeGreaterThanOrEqual' &&
    expect.pageRead === 'count' &&
    expect.argumentLiteral?.kind === 'number' &&
    expect.argumentLiteral.value === 0
  );
}
