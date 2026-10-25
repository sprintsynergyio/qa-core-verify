import type { InventoryTest, ModifierSite } from '../inventory/parse.js';
import type { Finding } from './types.js';

export const W009_RULE_ID = 'QCV-W009';

/** Skipped, fixme, and focused tests do not guard the suite. */
export function findSkipOrFocus(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    for (const site of test.modifierSites) {
      findings.push(findingFor(test, site));
    }
  }
  return findings;
}

function findingFor(test: InventoryTest, site: ModifierSite): Finding {
  const focused = site.modifier === 'only';
  return {
    ruleId: W009_RULE_ID,
    check: 'weak-assertion',
    severity: 'info',
    file: test.file,
    line: site.line,
    column: site.column,
    testTitle: test.titlePath.join(' > '),
    message: focused ? 'Test is focused.' : site.modifier === 'fixme' ? 'Test is marked fixme.' : 'Test is skipped.',
    evidence: site.source,
    fixHint: 'Remove skip, fixme, or only so this test runs with the rest of the suite.',
    relatedLintRule: focused ? 'no-focused-test' : 'no-skipped-test',
  };
}
