import type { InventoryTest } from '../inventory/parse.js';
import type { Finding } from './types.js';

export const W001_RULE_ID = 'QCV-W001';

/**
 * Flag a test that has no expect call and no configured assertion helper.
 * test.skip and test.fixme (including a skipped or fixme describe) are not flagged.
 * An expect inside beforeEach, afterEach, beforeAll, or afterAll is not counted.
 * An unresolved helper is not treated as proof that the assertion is missing.
 */
export function findTestsWithNoAssertion(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    if (test.modifiers.includes('skip') || test.modifiers.includes('fixme')) continue;
    if (test.expects.length > 0 || test.helpers.length > 0 || test.unresolved.length > 0) continue;
    findings.push({
      ruleId: W001_RULE_ID,
      check: 'weak-assertion',
      severity: 'error',
      file: test.file,
      line: test.line,
      column: test.column,
      testTitle: test.titlePath.join(' > '),
      message: 'Test has no assertion.',
      evidence: 'No expect call and no configured assertion helper in this test.',
      fixHint: 'Add an expect assertion, or call a helper named in qa-core-verify.config.json.',
      relatedLintRule: 'expect-expect',
    });
  }
  return findings;
}
