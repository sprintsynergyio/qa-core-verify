import type { ExpectCall, InventoryTest } from '../inventory/parse.js';
import type { Finding } from './types.js';

export const W003_RULE_ID = 'QCV-W003';

/**
 * Matchers that return a promise in Playwright 1.60.0.
 * Taken from LocatorAssertions, PageAssertions, APIResponseAssertions, and FunctionAssertions
 * in playwright/types/test.d.ts. toMatchSnapshot returns void, so it is not listed.
 * expect.poll is separate: every matcher on it returns a promise.
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

/** A web-first assertion that is neither awaited nor returned never fails the test. */
export function findMissingAwait(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    for (const expect of test.expects) {
      if (!isMissingAwait(expect)) continue;
      findings.push({
        ruleId: W003_RULE_ID,
        check: 'weak-assertion',
        severity: 'error',
        file: expect.file,
        line: expect.line,
        column: expect.column,
        testTitle: test.titlePath.join(' > '),
        message: 'Web-first assertion is not awaited.',
        evidence: expect.evidence,
        fixHint: 'Await the assertion, or return its promise from the test.',
        relatedLintRule: 'missing-playwright-await',
      });
    }
  }
  return findings;
}

function isMissingAwait(expect: ExpectCall): boolean {
  if (expect.awaited || expect.returned) return false;
  if (expect.poll) return true;
  return ASYNC_MATCHERS.has(expect.matcher);
}
