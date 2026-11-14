import type { InventoryTest, SkippedDescribe } from '../inventory/parse.js';
import { findUnresolvedHelpers } from './w000-unresolved.js';
import { findTestsWithNoAssertion } from './w001-no-assertion.js';
import { findGenericLocatorMatchers } from './w002-generic-matcher.js';
import { findMissingAwait } from './w003-missing-await.js';
import { findTautologies } from './w004-tautology.js';
import { findExistenceOnly } from './w005-existence-only.js';
import { findPresenceOnly } from './w006-presence-only.js';
import { findConditionalExpects } from './w007-conditional-expect.js';
import { findSwallowedExpects } from './w008-swallowed-expect.js';
import { findSkipOrFocus } from './w009-skip-only.js';
import { findHardWaits } from './w010-wait-for-timeout.js';
import type { Finding } from './types.js';

export const CHECKS_RUN = ['weak-assertion'] as const;

/** Static rule ids, in the order the README lists them. */
export const STATIC_RULE_IDS = [
  'QCV-W000',
  'QCV-W001',
  'QCV-W002',
  'QCV-W003',
  'QCV-W004',
  'QCV-W005',
  'QCV-W006',
  'QCV-W007',
  'QCV-W008',
  'QCV-W009',
  'QCV-W010',
] as const;

export function collectFindings(
  tests: readonly InventoryTest[],
  skippedDescribes: readonly SkippedDescribe[] = [],
): Finding[] {
  const findings = [
    ...findUnresolvedHelpers(tests),
    ...findTestsWithNoAssertion(tests),
    ...findGenericLocatorMatchers(tests),
    ...findMissingAwait(tests),
    ...findTautologies(tests),
    ...findExistenceOnly(tests),
    ...findPresenceOnly(tests),
    ...findConditionalExpects(tests),
    ...findSwallowedExpects(tests),
    ...findSkipOrFocus(tests, skippedDescribes),
    ...findHardWaits(tests),
  ];
  return findings.sort((left, right) => {
    const byFile = left.file.localeCompare(right.file);
    if (byFile !== 0) return byFile;
    if (left.line !== right.line) return left.line - right.line;
    if (left.column !== right.column) return left.column - right.column;
    return left.ruleId.localeCompare(right.ruleId);
  });
}
