import type { ExpectCall, InventoryTest, ScalarLiteral } from '../inventory/parse.js';
import { ownerIdFor, type Finding } from './types.js';

export const W004_RULE_ID = 'QCV-W004';

const EQUALITY = new Set(['toBe', 'toEqual', 'toStrictEqual']);

/** Literal compared with the same literal, or the same source text on both sides. */
export function findTautologies(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    for (const expect of test.expects) {
      if (!isTautology(expect)) continue;
      findings.push({
        ruleId: W004_RULE_ID,
        check: 'weak-assertion',
        severity: 'error',
        file: expect.file,
        line: expect.line,
        column: expect.column,
        testTitle: test.titlePath.join(' > '),
        message: 'Assertion compares a value to itself.',
        evidence: expect.evidence,
        fixHint: 'Compare the page value to the expected text, number, or state.',
        ownerId: ownerIdFor('test', test.file, test.line, test.column, test.titlePath),
      });
    }
  }
  return findings;
}

function isTautology(expect: ExpectCall): boolean {
  if (expect.not || !EQUALITY.has(expect.matcher) || expect.argumentSource.length === 0) return false;
  if (expect.sameSource) return true;
  return literalsEqual(expect.subjectLiteral, expect.argumentLiteral);
}

function literalsEqual(left: ScalarLiteral | undefined, right: ScalarLiteral | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'string' || left.kind === 'number' || left.kind === 'boolean') {
    return right.kind === left.kind && Object.is(left.value, right.value);
  }
  return true;
}
