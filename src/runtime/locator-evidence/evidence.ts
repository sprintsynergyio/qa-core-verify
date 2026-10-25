import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayText, projectDirLabel } from '../../report/paths.js';

export interface EvidenceRecord {
  selector: string;
  api: string;
  url: string;
  matchCount: number;
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
  file: string;
  line: number;
  column: number;
  testFile: string;
  testLine: number;
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
  matchCount: number;
  phase: string;
  call: string;
  negated: boolean;
  actionSucceeded?: boolean;
  stack: string;
  testFile: string;
  testLine: number;
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

function normalizePart(part: RawEvidencePart, workspaceDir: string): EvidenceRecord | undefined {
  if (part.phase !== 'action' && part.phase !== 'assertion') return undefined;
  if (!Number.isInteger(part.matchCount) || part.matchCount < 0) return undefined;
  const site = callSiteFromStack(part.stack, workspaceDir);
  const testFile = projectFile(part.testFile, workspaceDir);
  const callFile = site ? projectFile(site.file, workspaceDir) : testFile;
  if (!testFile || !callFile) return undefined;
  const selector = displayText(part.selector);
  const api = displayText(part.api);
  if (selector.length === 0) return undefined;
  return {
    selector,
    api,
    url: displayText(part.url),
    matchCount: part.matchCount,
    phase: part.phase,
    call: displayText(part.call),
    negated: part.negated === true,
    actionSucceeded: part.actionSucceeded === true,
    resolvedOnAction: part.actionSucceeded === true,
    file: callFile,
    line: site?.line ?? part.testLine,
    column: site?.column ?? 1,
    testFile,
    testLine: part.testLine,
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
    records: evidence.records.map((record) => {
      if (record.phase !== 'action') return record;
      const { matchCount: _actionMatchCount, ...rest } = record;
      return rest;
    }),
  };
}

function compareRecords(left: EvidenceRecord, right: EvidenceRecord): number {
  const fields: Array<keyof EvidenceRecord> = [
    'file',
    'line',
    'column',
    'phase',
    'call',
    'selector',
    'api',
    'url',
    'matchCount',
    'negated',
    'actionSucceeded',
    'resolvedOnAction',
    'testFile',
    'testLine',
    'testTitle',
  ];
  for (const field of fields) {
    const a = left[field];
    const b = right[field];
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}
