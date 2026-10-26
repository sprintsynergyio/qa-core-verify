import path from 'node:path';
import type { InventoryTest } from '../inventory/parse.js';
import { ownerIdFor, type Finding } from './types.js';
import { matchInventory, multiMatchUnaccounted, withRuntimeTitles, type LocatorGroup } from './locator-status.js';

export const L003_RULE_ID = 'QCV-L003';

/** More than one match, or `.first()`, `.last()`, or `.nth()` on a locator that matched more than one element. */
export function findAmbiguous(
  tests: readonly InventoryTest[],
  groups: readonly LocatorGroup[],
  projectDir: string,
): Finding[] {
  const findings: Finding[] = [];
  for (const group of groups) {
    const test = matchInventory(tests, projectDir, group);
    if (!test) continue;
    if (!multiMatchUnaccounted(group.uses)) continue;
      const site = [...group.uses].sort((left, right) => left.line - right.line || left.column - right.column)[0];
      if (!site) continue;
      const parts: string[] = [];
      if (group.seenCounts.length > 0) parts.push(`Match count ${group.seenCounts.join(', ')}.`);
      if (group.parentCounts.length > 0) parts.push(`Parent match count ${group.parentCounts.join(', ')}.`);
      if (parts.length === 0) parts.push('More than one element matched.');
      const inventoryTitle = test.titlePath.join(' > ');
      findings.push({
        ruleId: L003_RULE_ID,
        check: 'locator',
        severity: 'warn',
        file: path.resolve(projectDir, site.file),
        line: site.line,
        column: site.column,
        testTitle: inventoryTitle,
        message: 'Locator matched more than one element.',
        evidence: withRuntimeTitles(`${group.api || group.selector} ${parts.join(' ')}`, group, inventoryTitle),
        fixHint: 'Narrow the locator to one element with a role, text, or test id.',
        ownerId: ownerIdFor('test', test.file, test.line, test.column, test.titlePath),
      });
  }
  return findings;
}
