import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayText, escapeSelector, projectDirLabel } from '../../report/paths.js';

export interface EvidenceRecord {
  selector: string;
  api: string;
  url: string;
  /** Null when `count()` threw after a successful action. */
  matchCount: number | null;
  phase: 'action' | 'assertion';
  call: string;
  negated: boolean;
  /** True when this action returned. Assertions are false. */
  actionSucceeded: boolean;
  /**
   * True when a strict action returned, so Playwright had resolved one element at action time.
   * Derived only from `actionSucceeded`. It is not a substitute for `matchCount`.
   */
  resolvedOnAction: boolean;
  /** Count of the locator before `.first()`, `.last()`, or `.nth()`. Null when this use was not narrowed. */
  parentCount: number | null;
  /**
   * The number passed to `toHaveCount`, or the length of an array passed to `toHaveText` or `toContainText`.
   * Null when the matcher was not one of those, or the argument was not a number or an array.
   */
  countExpected: number | null;
  /** The number passed to `.nth()`. Null when this use was not `.nth(number)`. */
  nthIndex: number | null;
  /**
   * True when the matcher option asks for the negative state:
   * `visible: false`, `attached: false`, `enabled: false`, `checked: false`, or `editable: false`.
   */
  optionAbsence: boolean;
  file: string;
  line: number;
  column: number;
  testFile: string;
  testLine: number;
  /** Column of the `test()` call. Parameterized iterations share it. Zero when the fixture did not record one. */
  testColumn: number;
  testTitle: string;
}

export interface EvidenceFile {
  schemaVersion: 1;
  tool: { name: string; version: string };
  playwrightVersion: string;
  project: { dir: string };
  playwrightExitCode: number;
  records: EvidenceRecord[];
}

export interface RawEvidencePart {
  selector: string;
  api: string;
  url: string;
  matchCount: number | null;
  phase: string;
  call: string;
  negated: boolean;
  actionSucceeded?: boolean;
  parentCount?: number | null;
  countExpected?: number | null;
  nthIndex?: number | null;
  optionAbsence?: boolean;
  stack: string;
  testFile: string;
  testLine: number;
  testColumn?: number;
  testTitle: string;
}

export interface CallSite {
  file: string;
  line: number;
  column: number;
}

/** First project frame in a V8 stack, skipping node_modules and the generated fixture. */
export function callSiteFromStack(stack: string, projectDir: string): CallSite | undefined {
  const root = path.resolve(projectDir);
  for (const raw of stack.split('\n')) {
    const match = /((?:file:\/\/\/|[A-Za-z]:\\|\/)[^():]+):(\d+):(\d+)/.exec(raw.trim());
    if (!match) continue;
    const rawFile = match[1];
    if (!rawFile) continue;
    const file = stackPath(rawFile);
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (!file || !Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) continue;
    if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (path.basename(file).startsWith('qcv-locator-fixture.')) continue;
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    return { file, line, column };
  }
  return undefined;
}

function stackPath(file: string): string | undefined {
  if (!file.startsWith('file://')) return file;
  try {
    return fileURLToPath(file);
  } catch {
    return undefined;
  }
}

export function buildEvidence(input: {
  parts: readonly RawEvidencePart[];
  workspaceDir: string;
  projectDir: string;
  tool: { name: string; version: string };
  playwrightVersion: string;
  playwrightExitCode: number;
}): EvidenceFile {
  const records: EvidenceRecord[] = [];
  for (const part of input.parts) {
    const record = normalizePart(part, input.workspaceDir);
    if (record) records.push(record);
  }
  records.sort(compareRecords);
  const labeled = displayText(projectDirLabel(input.projectDir));
  return {
    schemaVersion: 1,
    tool: input.tool,
    playwrightVersion: input.playwrightVersion,
    project: { dir: labeled.length === 0 ? '.' : labeled },
    playwrightExitCode: input.playwrightExitCode,
    records,
  };
}

function countOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function positiveInt(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 0;
  return value;
}

/** Drop a query string so two runs of the same page compare equal. The hash stays. */
export function evidenceUrl(value: string): string {
  const cleaned = displayText(value);
  if (!cleaned.includes('?')) return cleaned;
  try {
    const url = new URL(cleaned);
    url.search = '';
    return url.toString();
  } catch {
    const query = cleaned.indexOf('?');
    return query === -1 ? cleaned : cleaned.slice(0, query);
  }
}

function normalizePart(part: RawEvidencePart, workspaceDir: string): EvidenceRecord | undefined {
  if (part.phase !== 'action' && part.phase !== 'assertion') return undefined;
  const matchCount = part.matchCount === null ? null : countOrNull(part.matchCount);
  if (part.matchCount !== null && matchCount === null) return undefined;
  const site = callSiteFromStack(part.stack, workspaceDir);
  const testFile = projectFile(part.testFile, workspaceDir);
  const callFile = site ? projectFile(site.file, workspaceDir) : testFile;
  if (!testFile || !callFile) return undefined;
  const selector = escapeSelector(part.selector);
  const api = displayText(part.api);
  if (selector.length === 0) return undefined;
  return {
    selector,
    api,
    url: evidenceUrl(part.url),
    matchCount,
    phase: part.phase,
    call: displayText(part.call),
    negated: part.negated === true,
    actionSucceeded: part.actionSucceeded === true,
    resolvedOnAction: part.actionSucceeded === true,
    parentCount: countOrNull(part.parentCount),
    countExpected: countOrNull(part.countExpected),
    nthIndex: countOrNull(part.nthIndex),
    optionAbsence: part.optionAbsence === true,
    file: callFile,
    line: site?.line ?? part.testLine,
    column: site?.column ?? 1,
    testFile,
    testLine: part.testLine,
    testColumn: positiveInt(part.testColumn),
    testTitle: displayText(part.testTitle),
  };
}

function projectFile(file: string, workspaceDir: string): string | undefined {
  const relative = path.relative(path.resolve(workspaceDir), path.resolve(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const shown = displayText(relative.split(path.sep).join('/'));
  return shown.length === 0 ? undefined : shown;
}

/**
 * Copy for comparing two runs. Action `matchCount` is left out.
 * That count is taken after the action, so a click that navigates or removes its target can change it.
 * Every other field, including assertion `matchCount` and `resolvedOnAction`, stays.
 * Records are sorted again here, with the same order as `buildEvidence`, so a file sorted by `matchCount` still compares equal.
 */
export function evidenceWithoutActionMatchCount(evidence: EvidenceFile): {
  schemaVersion: EvidenceFile['schemaVersion'];
  tool: EvidenceFile['tool'];
  playwrightVersion: string;
  project: EvidenceFile['project'];
  playwrightExitCode: number;
  records: Array<Omit<EvidenceRecord, 'matchCount'> & { matchCount?: number }>;
} {
  return {
    ...evidence,
    records: [...evidence.records].sort(compareRecords).map((record) => {
      if (record.phase !== 'action') return record;
      const { matchCount: _actionMatchCount, ...rest } = record;
      return rest;
    }),
  };
}

/**
 * Deterministic order: file, line, column, test title, then kind (`phase`, then `call`).
 * `matchCount` is not a key. An action count can be 0 or 1 on different runs, and sorting by it swaps records that share a call site.
 */
function compareValue(left: string | number | boolean | null, right: string | number | boolean | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRecords(left: EvidenceRecord, right: EvidenceRecord): number {
  const fields: Array<keyof EvidenceRecord> = [
    'file',
    'line',
    'column',
    'testTitle',
    'phase',
    'call',
    'testFile',
    'testLine',
    'selector',
    'api',
    'url',
    'negated',
    'actionSucceeded',
    'resolvedOnAction',
    'parentCount',
    'countExpected',
    'nthIndex',
    'optionAbsence',
    'testColumn',
  ];
  for (const field of fields) {
    const order = compareValue(left[field], right[field]);
    if (order !== 0) return order;
  }
  return 0;
}
