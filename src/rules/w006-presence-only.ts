import type { BodyEvent, ExpectCall, InventoryTest } from '../inventory/parse.js';
import { ownerIdFor, type Finding } from './types.js';

export const W006_RULE_ID = 'QCV-W006';

const PRESENCE = new Set(['toBeVisible', 'toBeAttached', 'toBeInViewport']);

/**
 * After the last action, every assertion only checks that an element is present.
 * A test with no action is not flagged.
 */
export function findPresenceOnly(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    const finding = presenceFinding(test);
    if (finding) findings.push(finding);
  }
  return findings;
}

function presenceFinding(test: InventoryTest): Finding | undefined {
  let lastAction = -1;
  for (let index = 0; index < test.events.length; index += 1) {
    const event = test.events[index];
    if (event?.type === 'action') lastAction = index;
  }
  if (lastAction < 0) return undefined;
  const after: ExpectCall[] = [];
  for (let index = lastAction + 1; index < test.events.length; index += 1) {
    const event: BodyEvent | undefined = test.events[index];
    if (event?.type === 'expect') after.push(event.expect);
  }
  if (after.length === 0) return undefined;
  if (!after.every(isPresence)) return undefined;
  const first = after[0];
  if (!first) return undefined;
  return {
    ruleId: W006_RULE_ID,
    check: 'weak-assertion',
    severity: 'warn',
    file: first.file,
    line: first.line,
    column: first.column,
    testTitle: test.titlePath.join(' > '),
    message: 'After the last action, the test only checks presence.',
    evidence: first.evidence,
    fixHint: 'Assert the text, value, URL, title, count, checked state, or enabled state the action should change.',
    ownerId: ownerIdFor('test', test.file, test.line, test.column, test.titlePath),
  };
}

function isPresence(expect: ExpectCall): boolean {
  return !expect.not && PRESENCE.has(expect.matcher);
}
