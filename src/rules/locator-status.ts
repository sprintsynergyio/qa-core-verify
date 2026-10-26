import path from 'node:path';
import type { EvidenceRecord } from '../runtime/locator-evidence/evidence.js';
import type { InventoryTest } from '../inventory/parse.js';
import type { ReportLocator } from '../report/model.js';
import { ownerIdFor } from './types.js';

export interface LocatorGroup {
  selector: string;
  api: string;
  testFile: string;
  testLine: number;
  testColumn: number;
  /** One runtime title from the evidence. Parameterized runs keep every title in `runtimeTitles`. */
  testTitle: string;
  runtimeTitles: string[];
  uses: EvidenceRecord[];
  status: ReportLocator['status'];
  counts: number[];
  /** Every numeric match count, including actions. The summary `counts` stay assertion-only. */
  seenCounts: number[];
  parentCounts: number[];
}

export function groupRecords(records: readonly EvidenceRecord[]): LocatorGroup[] {
  const groups = new Map<string, EvidenceRecord[]>();
  for (const record of records) {
    const key = [record.testFile, String(record.testLine), String(record.testColumn ?? 0), record.selector].join('\0');
    const list = groups.get(key);
    if (list) list.push(record);
    else groups.set(key, [record]);
  }
  const out: LocatorGroup[] = [];
  for (const uses of groups.values()) {
    const first = uses[0];
    if (!first) continue;
    const api = uses.reduce((best, use) => (use.api.length > best.length ? use.api : best), first.api);
    const counts = uniqueNumbers(uses.filter((use) => use.phase === 'assertion').map((use) => use.matchCount));
    const seenCounts = uniqueNumbers(uses.map((use) => use.matchCount));
    const parentCounts = uniqueNumbers(uses.map((use) => use.parentCount));
    const runtimeTitles = [...new Set(uses.map((use) => use.testTitle))].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    out.push({
      selector: first.selector,
      api,
      testFile: first.testFile,
      testLine: first.testLine,
      testColumn: first.testColumn ?? 0,
      testTitle: first.testTitle,
      runtimeTitles,
      uses,
      status: statusOf(uses),
      counts,
      seenCounts,
      parentCounts,
    });
  }
  out.sort((left, right) => {
    if (left.testFile !== right.testFile) return left.testFile < right.testFile ? -1 : 1;
    if (left.testLine !== right.testLine) return left.testLine - right.testLine;
    if (left.testColumn !== right.testColumn) return left.testColumn - right.testColumn;
    if (left.selector !== right.selector) return left.selector < right.selector ? -1 : 1;
    return left.api < right.api ? -1 : left.api > right.api ? 1 : 0;
  });
  return out;
}

export function statusOf(uses: readonly EvidenceRecord[]): ReportLocator['status'] {
  if (multiMatchUnaccounted(uses)) return 'ambiguous';
  if (neverMatched(uses)) return 'never-matched';
  return 'unique';
}

/**
 * Absence checks that stay green when the element is not in the page.
 * `optionAbsence` is a matcher option such as `{ visible: false }` or `{ enabled: false }`.
 */
export function isAbsence(use: EvidenceRecord): boolean {
  if (use.phase !== 'assertion') return false;
  if (use.optionAbsence) return true;
  if (use.call === 'toBeHidden' && !use.negated) return true;
  if (use.call === 'toBeVisible' && use.negated) return true;
  if (use.call === 'toBeAttached' && use.negated) return true;
  if (use.call === 'toHaveCount' && !use.negated && use.countExpected === 0) return true;
  return false;
}

export function isPositiveAssertion(use: EvidenceRecord): boolean {
  return use.phase === 'assertion' && !isAbsence(use);
}

export function neverMatched(uses: readonly EvidenceRecord[]): boolean {
  return uses.length > 0 && uses.every((use) => use.matchCount === 0 && !use.resolvedOnAction);
}

/**
 * `toHaveCount(n)` with the same n the page returned is the test naming that count.
 * `.first()`, `.last()`, and `.nth()` are not that kind of narrowing: the parent count is the signal.
 */
export function multiMatchUnaccounted(uses: readonly EvidenceRecord[]): boolean {
  const multi = uses.filter((use) => (use.matchCount !== null && use.matchCount > 1) || (use.parentCount !== null && use.parentCount > 1));
  if (multi.length === 0) return false;
  return multi.some((use) => {
    if (use.parentCount !== null && use.parentCount > 1) return true;
    return !(use.phase === 'assertion' && use.call === 'toHaveCount' && !use.negated && use.countExpected === use.matchCount);
  });
}

/**
 * Match evidence to the source test by file and test line, then column when that picks one row.
 * A `for` loop that calls `test(\`param ${n}\`)` has one inventory row and several runtime titles.
 */
export function matchInventory(tests: readonly InventoryTest[], projectDir: string, group: LocatorGroup): InventoryTest | undefined {
  const eligible = tests.filter((test) => {
    if (test.modifiers.includes('skip') || test.modifiers.includes('fixme')) return false;
    const file = path.relative(projectDir, test.file).split(path.sep).join('/');
    return file === group.testFile && test.line === group.testLine;
  });
  if (group.testColumn > 0) {
    const byColumn = eligible.filter((test) => test.column === group.testColumn);
    if (byColumn.length === 1) return byColumn[0];
  }
  if (eligible.length === 1) return eligible[0];
  return eligible.find((test) => test.titlePath.join(' > ') === group.testTitle);
}

/** Runtime titles that differ from the inventory title, for the finding under that row. */
export function withRuntimeTitles(evidence: string, group: LocatorGroup, inventoryTitle: string): string {
  const titles = group.runtimeTitles.filter((title) => title.length > 0);
  if (titles.length === 0) return evidence;
  if (titles.length === 1 && titles[0] === inventoryTitle) return evidence;
  return `${evidence} Runtime titles: ${titles.join(', ')}.`;
}

export function summaryFor(group: LocatorGroup): ReportLocator {
  const site = earliest(group.uses);
  return {
    selector: group.selector,
    api: group.api,
    status: group.status,
    file: site?.file ?? group.testFile,
    line: site?.line ?? group.testLine,
    column: site?.column ?? 1,
    counts: group.counts,
    parentCounts: group.parentCounts,
  };
}

export function ownerFor(test: InventoryTest): string {
  return ownerIdFor('test', test.file, test.line, test.column, test.titlePath);
}

function earliest(uses: readonly EvidenceRecord[]): EvidenceRecord | undefined {
  return [...uses].sort((left, right) => left.line - right.line || left.column - right.column)[0];
}

function uniqueNumbers(values: readonly (number | null)[]): number[] {
  const found = new Set<number>();
  for (const value of values) {
    if (value !== null) found.add(value);
  }
  return [...found].sort((left, right) => left - right);
}
