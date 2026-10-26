import path from 'node:path';
import type { InventoryTest } from '../inventory/parse.js';
import { ownerIdFor, type Finding } from './types.js';
import { isAbsence, matchInventory, neverMatched, withRuntimeTitles, type LocatorGroup } from './locator-status.js';

export const L002_RULE_ID = 'QCV-L002';

export const L002_MESSAGE =
  'This test stays green even if this element does not exist. Check the locator against a state where the element is shown.';

/**
 * A locator used only in absence assertions, and never matched in any use.
 * Warn by default. A later fault-injection check can raise this when a run that should show the element also misses it.
 */
export function findAbsenceOnUnseen(
  tests: readonly InventoryTest[],
  groups: readonly LocatorGroup[],
  projectDir: string,
): Finding[] {
  const findings: Finding[] = [];
  for (const group of groups) {
    const matched = matchInventory(tests, projectDir, group);
    if (matched.length === 0) continue;
    if (group.uses.length === 0 || !group.uses.every((use) => isAbsence(use))) continue;
    if (!neverMatched(group.uses)) continue;
    const site = [...group.uses].sort((left, right) => left.line - right.line || left.column - right.column)[0];
    if (!site) continue;
    const calls = [...new Set(group.uses.map((use) => (use.negated ? `not.${use.call}` : use.call)))].join(', ');
    for (const test of matched) {
      const inventoryTitle = test.titlePath.join(' > ');
      findings.push({
        ruleId: L002_RULE_ID,
        check: 'locator',
        severity: 'warn',
        file: path.resolve(projectDir, site.file),
        line: site.line,
        column: site.column,
        testTitle: inventoryTitle,
        message: L002_MESSAGE,
        evidence: withRuntimeTitles(
          `${group.api || group.selector} was only used in ${calls} and matched 0 elements.`,
          group,
          inventoryTitle,
        ),
        fixHint: 'Assert this locator in a state where the element is shown, then keep the absence check.',
        ownerId: ownerIdFor('test', test.file, test.line, test.column, test.titlePath),
      });
    }
  }
  return findings;
}
