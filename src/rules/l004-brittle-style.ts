import type { InventoryTest } from '../inventory/parse.js';
import { ownerIdFor, type Finding } from './types.js';

export const L004_RULE_ID = 'QCV-L004';

const LOCATOR_LITERAL = /(?:frameLocator|locator)\(\s*(['"`])([\s\S]*?)\1/g;

/**
 * Static check. CSS with more than two combinators, XPath, nth-child, or a styling class.
 * Playwright's locator guide prefers a role, label, text, or test id over CSS and XPath:
 * https://playwright.dev/docs/locators
 */
export function findBrittleStyle(tests: readonly InventoryTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const test of tests) {
    if (test.modifiers.includes('skip') || test.modifiers.includes('fixme')) continue;
    const seen = new Set<string>();
    for (const expect of test.expects) {
      const reasons = reasonsIn(expect.subjectSource);
      if (reasons.length === 0 || seen.has(expect.subjectSource)) continue;
      seen.add(expect.subjectSource);
      findings.push(toFinding(test, expect.line, expect.column, expect.subjectSource, reasons));
    }
    for (const locator of test.locators) {
      if ([...seen].some((source) => source.includes(locator.source))) continue;
      const reasons = reasonsIn(locator.source);
      if (reasons.length === 0 || seen.has(locator.source)) continue;
      seen.add(locator.source);
      findings.push(toFinding(test, locator.line, locator.column, locator.source, reasons));
    }
  }
  return findings;
}

/** Reasons a CSS or XPath string is brittle. An empty list means the string is not flagged. */
export function brittleReasons(selector: string): string[] {
  const trimmed = selector.trim();
  const reasons: string[] = [];
  if (isXPath(trimmed)) reasons.push('XPath');
  if (/:nth-(?:child|of-type|last-child|last-of-type)\b/.test(trimmed)) reasons.push('nth-child');
  if (!isXPath(trimmed)) {
    const combinators = combinatorCount(trimmed);
    if (combinators > 2) reasons.push(`CSS chain with ${combinators} combinators`);
    const classes = stylingClasses(trimmed);
    if (classes.length > 0) reasons.push(`styling class ${classes.map((name) => `.${name}`).join(', ')}`);
  }
  return reasons;
}

function reasonsIn(source: string): string[] {
  const reasons: string[] = [];
  for (const selector of literalSelectors(source)) {
    for (const reason of brittleReasons(selector)) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return reasons;
}

function literalSelectors(source: string): string[] {
  const found: string[] = [];
  LOCATOR_LITERAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOCATOR_LITERAL.exec(source)) !== null) {
    const text = match[2];
    if (text !== undefined) found.push(text);
  }
  return found;
}

function isXPath(selector: string): boolean {
  return selector.startsWith('xpath=') || selector.startsWith('//') || selector.startsWith('(') && selector.includes('//');
}

function combinatorCount(selector: string): number {
  const body = selector.replace(/\[[^\]]*\]/g, '[]');
  const matches = body.match(/\s*[>+~]\s*|\s+(?=[.#a-zA-Z*[:])/g);
  return matches ? matches.length : 0;
}

function stylingClasses(selector: string): string[] {
  const body = selector.replace(/\[[^\]]*\]/g, '[]');
  const matches = body.match(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g) ?? [];
  return [...new Set(matches.map((item) => item.slice(1)))];
}

function toFinding(test: InventoryTest, line: number, column: number, source: string, reasons: string[]): Finding {
  return {
    ruleId: L004_RULE_ID,
    check: 'locator',
    severity: 'info',
    file: test.file,
    line,
    column,
    testTitle: test.titlePath.join(' > '),
    message: 'Locator depends on CSS structure, a styling class, nth-child, or XPath.',
    evidence: `${source.trim()} (${reasons.join('; ')}).`,
    fixHint: 'Use a user-facing locator such as getByRole, getByLabel, getByText, or getByTestId. See https://playwright.dev/docs/locators',
    ownerId: ownerIdFor('test', test.file, test.line, test.column, test.titlePath),
  };
}
