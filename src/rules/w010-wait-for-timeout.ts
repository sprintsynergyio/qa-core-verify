import type { InventoryTest } from '../inventory/parse.js';
import type { Finding } from './types.js';

export const W010_RULE_ID = 'QCV-W010';

/** page.waitForTimeout with no assertion after it does not check the page. */
export function findHardWaits(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    for (let index = 0; index < test.events.length; index += 1) {
      const event = test.events[index];
      if (event?.type !== 'wait') continue;
      if (hasAssertionAfter(test, index)) continue;
      findings.push({
        ruleId: W010_RULE_ID,
        check: 'weak-assertion',
        severity: 'info',
        file: event.fact.file,
        line: event.fact.line,
        column: event.fact.column,
        testTitle: test.titlePath.join(' > '),
        message: 'waitForTimeout is used with no assertion after it.',
        evidence: event.fact.source,
        fixHint: 'Replace `page.waitForTimeout` with a web-first assertion such as `await expect(locator).toBeVisible()`.',
        relatedLintRule: 'no-wait-for-timeout',
      });
    }
  }
  return findings;
}

function hasAssertionAfter(test: InventoryTest, waitIndex: number): boolean {
  for (let index = waitIndex + 1; index < test.events.length; index += 1) {
    const event = test.events[index];
    if (event?.type === 'expect' || event?.type === 'helper') return true;
  }
  return false;
}
