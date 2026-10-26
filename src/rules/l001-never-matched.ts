import path from 'node:path';
import type { InventoryTest } from '../inventory/parse.js';
import { ownerIdFor, type Finding } from './types.js';
import { isPositiveAssertion, matchInventory, neverMatched, withRuntimeTitles, type LocatorGroup } from './locator-status.js';

export const L001_RULE_ID = 'QCV-L001';

const MESSAGE = 'Locator matched 0 elements in every action and positive assertion.';

/**
 * A locator used in an action or a positive assertion that matched 0 elements in every use.
 * A strict action that returned is not a zero match: `resolvedOnAction` records that Playwright had an element.
 */
export function findNeverMatched(
  tests: readonly InventoryTest[],
  groups: readonly LocatorGroup[],
  projectDir: string,
): Finding[] {
  const findings: Finding[] = [];
  for (const group of groups) {
    const test = matchInventory(tests, projectDir, group);
    if (!test) continue;
    const actionable = group.uses.some((use) => use.phase === 'action' || isPositiveAssertion(use));
    if (!actionable || !neverMatched(group.uses)) continue;
    const site = earliest(group);
    if (!site) continue;
    const inventoryTitle = test.titlePath.join(' > ');
    findings.push({
        ruleId: L001_RULE_ID,
        check: 'locator',
        severity: 'error',
        file: path.resolve(projectDir, site.file),
        line: site.line,
        column: site.column,
        testTitle: inventoryTitle,
        message: MESSAGE,
        evidence: withRuntimeTitles(`${group.api || group.selector} matched 0 elements.`, group, inventoryTitle),
        fixHint: 'Run qa-core-heal to suggest a replacement locator.',
        ownerId: ownerIdFor('test', test.file, test.line, test.column, test.titlePath),
      });
  }
  return findings;
}

function earliest(group: LocatorGroup): LocatorGroup['uses'][number] | undefined {
  return [...group.uses].sort((left, right) => left.line - right.line || left.column - right.column || left.file.localeCompare(right.file))[0];
}
