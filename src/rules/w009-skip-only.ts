import type { InventoryTest, ModifierSite, SkippedDescribe } from '../inventory/parse.js';
import { ownerIdFor, type Finding } from './types.js';

export const W009_RULE_ID = 'QCV-W009';

/**
 * Skipped, fixme, and focused tests do not guard the suite.
 * `test.describe.skip` is one finding on the describe block, including when the block has no tests.
 */
export function findSkipOrFocus(
  tests: readonly InventoryTest[],
  skippedDescribes: readonly SkippedDescribe[] = [],
): Finding[] {
  const findings: Finding[] = [];
  for (const block of skippedDescribes) {
    findings.push({
      ruleId: W009_RULE_ID,
      check: 'weak-assertion',
      severity: 'info',
      file: block.file,
      line: block.line,
      column: block.column,
      testTitle: block.titlePath.join(' > '),
      message: 'Describe block is skipped.',
      evidence: block.source,
      fixHint: 'Remove skip so the tests in this block run with the rest of the suite.',
      relatedLintRule: 'no-skipped-test',
      ownerId: ownerIdFor('describe', block.file, block.line, block.column, block.titlePath),
    });
  }
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
    ownerId: ownerIdFor('test', test.file, test.line, test.column, test.titlePath),
  };
}
