import path from 'node:path';
import type { ExpectCall, InventoryTest } from '../../inventory/parse.js';
import { L002_MESSAGE } from '../../rules/l002-absence-on-unseen.js';
import { ownerIdFor, type Finding } from '../../rules/types.js';
import { titleMatches, type Fault, type FaultResultName } from './types.js';

export interface FaultCell {
  id: string;
  result: FaultResultName;
  /** Short reason for not-run, or the first line of the Playwright error when result is fail. */
  reason?: string;
}

export interface ClassifiedTest {
  test: InventoryTest;
  ownerId: string;
  baseline: FaultResultName;
  cells: FaultCell[];
  /** Selector match counts recorded while a change-text fault ran. Keyed by fault id, then selector. */
  counts: Map<string, Record<string, number>>;
}

export function classifyFindings(projectDir: string, faults: readonly Fault[], rows: readonly ClassifiedTest[]): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    if (row.baseline !== 'pass') continue;
    const blank = row.cells.find((cell) => faults.find((fault) => fault.id === cell.id)?.type === 'blank-app');
    const blankPassed = blank?.result === 'pass';
    if (blankPassed) findings.push(f002(projectDir, row));
    for (const fault of faults) {
      const cell = row.cells.find((entry) => entry.id === fault.id);
      if (!cell || cell.result !== 'pass') continue;
      if (!fault.expectedToBreak.some((pattern) => titleMatches(pattern, row.test.titlePath))) continue;
      findings.push(f003(projectDir, row, fault));
    }
    const nonBlank = row.cells.filter((cell) => faults.find((fault) => fault.id === cell.id)?.type !== 'blank-app');
    if (nonBlank.length > 0 && nonBlank.every((cell) => cell.result === 'pass')) {
      findings.push(f004(projectDir, row, nonBlank));
    }
    findings.push(...upgradedAbsence(projectDir, faults, row));
  }
  return findings.sort((left, right) => {
    const byFile = left.file.localeCompare(right.file);
    if (byFile !== 0) return byFile;
    if (left.line !== right.line) return left.line - right.line;
    if (left.column !== right.column) return left.column - right.column;
    return left.ruleId.localeCompare(right.ruleId);
  });
}

function f002(projectDir: string, row: ClassifiedTest): Finding {
  const site = siteOf(row.test);
  return {
    ruleId: 'QCV-F002',
    check: 'cannot-fail',
    severity: 'error',
    file: path.resolve(projectDir, site.file),
    line: site.line,
    column: site.column,
    testTitle: row.test.titlePath.join(' > '),
    message: 'This test passes on a blank app.',
    evidence: 'The test passed the baseline and stayed green when the page body was replaced with an empty element.',
    fixHint: 'Assert something that is on the page, so the test goes red when the page is empty.',
    ownerId: row.ownerId,
  };
}

function f003(projectDir: string, row: ClassifiedTest, fault: Fault): Finding {
  const site = siteOf(row.test);
  return {
    ruleId: 'QCV-F003',
    check: 'cannot-fail',
    severity: 'error',
    file: path.resolve(projectDir, site.file),
    line: site.line,
    column: site.column,
    testTitle: row.test.titlePath.join(' > '),
    message: 'This test stayed green under a fault that should break it.',
    evidence: `Fault ${fault.id} (${fault.type}) lists this test in expectedToBreak, and the test passed.`,
    fixHint: 'Point the assertion at the behaviour this fault changes.',
    ownerId: row.ownerId,
  };
}

function f004(projectDir: string, row: ClassifiedTest, cells: readonly FaultCell[]): Finding {
  const site = siteOf(row.test);
  const ids = cells.map((cell) => cell.id).join(', ');
  return {
    ruleId: 'QCV-F004',
    check: 'cannot-fail',
    severity: 'warn',
    file: path.resolve(projectDir, site.file),
    line: site.line,
    column: site.column,
    testTitle: row.test.titlePath.join(' > '),
    message: 'This test stayed green under every fault other than blank-app.',
    evidence: `Faults other than blank-app: ${ids}.`,
    fixHint: 'Add an assertion that fails when one of these faults is applied, or add a fault in qa-core-verify.faults.json that this test should catch.',
    ownerId: row.ownerId,
  };
}

/**
 * QCV-L002 stays a warn on the locator check.
 * A change-text fault should leave its selector in the page. An absence assertion on that
 * selector that still matches nothing is raised to error.
 */
function upgradedAbsence(projectDir: string, faults: readonly Fault[], row: ClassifiedTest): Finding[] {
  const findings: Finding[] = [];
  for (const fault of faults) {
    if (fault.type !== 'change-text') continue;
    const selector = 'selector' in fault.params ? fault.params.selector : '';
    if (!selector) continue;
    const counts = row.counts.get(fault.id);
    if (!counts || !Object.prototype.hasOwnProperty.call(counts, selector)) continue;
    if (counts[selector] !== 0) continue;
    const expect = absenceExpect(row.test, selector);
    if (!expect) continue;
    findings.push({
      ruleId: 'QCV-L002',
      check: 'locator',
      severity: 'error',
      file: path.resolve(projectDir, relativeFile(expect.file, projectDir)),
      line: expect.line,
      column: expect.column,
      testTitle: row.test.titlePath.join(' > '),
      message: L002_MESSAGE,
      evidence: `${selector} matched 0 elements under fault ${fault.id}, which should show the element.`,
      fixHint: 'Assert this locator in a state where the element is shown, then keep the absence check.',
      ownerId: row.ownerId,
    });
  }
  return findings;
}

function absenceExpect(test: InventoryTest, selector: string): ExpectCall | undefined {
  for (const expect of test.expects) {
    if (!isAbsence(expect)) continue;
    if (!subjectUsesSelector(expect.subjectSource, selector)) continue;
    return expect;
  }
  return undefined;
}

function isAbsence(expect: ExpectCall): boolean {
  if (expect.matcher === 'toBeHidden' && !expect.not) return true;
  if ((expect.matcher === 'toBeVisible' || expect.matcher === 'toBeAttached') && expect.not) return true;
  if (expect.matcher === 'toHaveCount' && !expect.not && countArgumentIsZero(expect)) return true;
  if (expect.matcher === 'toBeVisible' && !expect.not && /visible\s*:\s*false/.test(expect.argumentSource)) return true;
  if (expect.matcher === 'toBeAttached' && !expect.not && /attached\s*:\s*false/.test(expect.argumentSource)) return true;
  return false;
}

function countArgumentIsZero(expect: ExpectCall): boolean {
  if (expect.argumentLiteral?.kind === 'number' && expect.argumentLiteral.value === 0) return true;
  return expect.argumentSource.trim() === '0';
}

function subjectUsesSelector(source: string, selector: string): boolean {
  const quoted = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`locator\\(\\s*(['"])${quoted}\\1`).test(source);
}

function siteOf(test: InventoryTest): { file: string; line: number; column: number } {
  const expect = test.expects[0];
  if (expect) return { file: relativeFile(expect.file, path.dirname(test.file)), line: expect.line, column: expect.column };
  return { file: test.file, line: test.line, column: test.column };
}

function relativeFile(file: string, projectDir: string): string {
  if (path.isAbsolute(file)) return file;
  return path.resolve(projectDir, file);
}

export function ownerForTest(test: InventoryTest): string {
  return ownerIdFor('test', test.file, test.line, test.column, test.titlePath);
}
