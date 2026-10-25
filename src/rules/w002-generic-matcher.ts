import type { ExpectCall, InventoryTest } from '../inventory/parse.js';
import type { Finding } from './types.js';

export const W002_RULE_ID = 'QCV-W002';

const GENERIC = new Set(['toBeTruthy', 'toBeDefined']);
const NEGATED = new Set(['toBeNull', 'toBeUndefined', 'toBeFalsy']);

/** A locator object is always truthy. These matchers do not look at the element. */
export function findGenericLocatorMatchers(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    for (const expect of test.expects) {
      if (!isGenericLocator(expect)) continue;
      findings.push({
        ruleId: W002_RULE_ID,
        check: 'weak-assertion',
        severity: 'error',
        file: expect.file,
        line: expect.line,
        column: expect.column,
        testTitle: test.titlePath.join(' > '),
        message: 'Generic matcher on a locator.',
        evidence: expect.evidence,
        fixHint: 'Use `await expect(locator).toBeVisible()` or assert its text.',
        relatedLintRule: 'no-unnecessary-assertions',
      });
    }
  }
  return findings;
}

function isGenericLocator(expect: ExpectCall): boolean {
  if (expect.subjectKind !== 'locator') return false;
  if (!expect.not && GENERIC.has(expect.matcher)) return true;
  return expect.not && NEGATED.has(expect.matcher);
}
