import type { ExpectCall, InventoryTest, SourceFact } from '../inventory/parse.js';
import { ownerIdFor, type Finding } from './types.js';

export const W003_RULE_ID = 'QCV-W003';

/**
 * Matchers that return a promise in Playwright 1.60.0.
 * Taken from LocatorAssertions, PageAssertions, APIResponseAssertions, and FunctionAssertions
 * in playwright/types/test.d.ts. toMatchSnapshot returns void, so it is not listed.
 * expect.poll, expect().resolves, and expect().rejects are separate: every matcher on them returns a promise.
 */
const ASYNC_MATCHERS = new Set([
  'toBeAttached',
  'toBeChecked',
  'toBeDisabled',
  'toBeEditable',
  'toBeEmpty',
  'toBeEnabled',
  'toBeFocused',
  'toBeHidden',
  'toBeInViewport',
  'toBeOK',
  'toBeVisible',
  'toContainClass',
  'toContainText',
  'toHaveAccessibleDescription',
  'toHaveAccessibleErrorMessage',
  'toHaveAccessibleName',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveCount',
  'toHaveCSS',
  'toHaveId',
  'toHaveJSProperty',
  'toHaveRole',
  'toHaveScreenshot',
  'toHaveText',
  'toHaveTitle',
  'toHaveURL',
  'toHaveValue',
  'toHaveValues',
  'toMatchAriaSnapshot',
  'toPass',
]);

/** An async assertion that is neither awaited nor returned never fails the test. */
export function findMissingAwait(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    const ownerId = ownerIdFor('test', test.file, test.line, test.column, test.titlePath);
    const title = test.titlePath.join(' > ');
    for (const expect of test.expects) {
      if (!isMissingAwait(expect)) continue;
      findings.push({
        ruleId: W003_RULE_ID,
        check: 'weak-assertion',
        severity: 'error',
        file: expect.file,
        line: expect.line,
        column: expect.column,
        testTitle: title,
        message: 'Async assertion is not awaited.',
        evidence: expect.evidence,
        fixHint: 'Await the assertion, or return its promise from the test.',
        relatedLintRule: 'missing-playwright-await',
        ownerId,
      });
    }
    for (const call of test.floatingCalls) {
      findings.push(floatingFinding(call, title, ownerId));
    }
  }
  return findings;
}

function floatingFinding(call: SourceFact, testTitle: string, ownerId: string): Finding {
  return {
    ruleId: W003_RULE_ID,
    check: 'weak-assertion',
    severity: 'error',
    file: call.file,
    line: call.line,
    column: call.column,
    testTitle,
    message: 'Async assertion is not awaited.',
    evidence: call.source,
    fixHint: 'Await the call, or return its promise from the test.',
    relatedLintRule: 'missing-playwright-await',
    ownerId,
  };
}

function isMissingAwait(expect: ExpectCall): boolean {
  if (expect.awaited || expect.returned) return false;
  if (expect.poll || expect.resolves || expect.rejects) return true;
  return ASYNC_MATCHERS.has(expect.matcher);
}
