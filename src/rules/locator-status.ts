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
  testTitle: string;
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
    const key = [record.testFile, String(record.testLine), record.testTitle, record.selector].join('\0');
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
    out.push({
      selector: first.selector,
      api,
      testFile: first.testFile,
      testLine: first.testLine,
      testTitle: first.testTitle,
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

/** Absence checks that stay green when the element is not in the page. */
export function isAbsence(use: EvidenceRecord): boolean {
  if (use.phase !== 'assertion') return false;
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

export function matchInventory(tests: readonly InventoryTest[], projectDir: string, group: LocatorGroup): InventoryTest | undefined {
  return tests.find((test) => {
    if (test.modifiers.includes('skip') || test.modifiers.includes('fixme')) return false;
    const file = path.relative(projectDir, test.file).split(path.sep).join('/');
    return file === group.testFile && test.titlePath.join(' > ') === group.testTitle;
  });
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
