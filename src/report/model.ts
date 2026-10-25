import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InventoryTest, SkippedDescribe, TestModifier } from '../inventory/parse.js';
import type { Finding, Severity } from '../rules/types.js';
import { ownerIdFor } from '../rules/types.js';
import { projectDirLabel, toProjectPath } from './paths.js';
import { ToolError } from '../tool-error.js';

export type Verdict = 'trusted' | 'review' | 'untrusted' | 'baseline-red' | 'not-run';

export const VERDICTS: readonly Verdict[] = ['trusted', 'review', 'untrusted', 'baseline-red', 'not-run'];

export interface ReportFinding {
  ruleId: string;
  check: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  message: string;
  evidence: string;
  fixHint: string;
  relatedLintRule?: string;
}

export interface ReportTest {
  id: string;
  file: string;
  line: number;
  titlePath: string[];
  verdict: Verdict;
  findings: ReportFinding[];
}

export interface ReportSummary {
  severity: { error: number; warn: number; info: number };
  verdict: Record<Verdict, number>;
}

export interface Report {
  schemaVersion: 1;
  tool: { name: string; version: string };
  startedAt: string;
  finishedAt: string;
  project: {
    dir: string;
    configFile: string | null;
    specCount: number;
    testCount: number;
  };
  checksRun: string[];
  summary: ReportSummary;
  tests: ReportTest[];
}

const LIMITED_CHECKS = [
  { id: 'locator', alone: 'Locator', together: 'Locator' },
  { id: 'cannot-fail', alone: 'Cannot-fail', together: 'cannot-fail' },
] as const;

/**
 * Names the locator and cannot-fail checks that did not run.
 * Omitted once both have run.
 */
export function trustNote(checksRun: readonly string[]): string | undefined {
  const ran = new Set(checksRun);
  const missing = LIMITED_CHECKS.filter((check) => !ran.has(check.id));
  if (missing.length === 0) return undefined;
  const only = missing.length === 1 ? missing[0] : undefined;
  const names = only ? only.alone : missing.map((check) => check.together).join(' and ');
  const noun = only ? 'check' : 'checks';
  return `Trusted means no warn or error findings from the checks that ran. ${names} ${noun} did not run.`;
}

export interface ReportInput {
  projectDir: string;
  configFile: string | undefined;
  specCount: number;
  tests: readonly InventoryTest[];
  skippedDescribes: readonly SkippedDescribe[];
  findings: readonly Finding[];
  checksRun: readonly string[];
  startedAt: Date;
  finishedAt: Date;
}

interface Row {
  kind: 'test' | 'describe';
  ownerId: string;
  file: string;
  line: number;
  column: number;
  titlePath: string[];
  modifiers: readonly TestModifier[];
  findings: Finding[];
}

/** ISO 8601 in local time, with the offset of `date` (for example `+05:00`). */
export function formatIsoOffset(date: Date): string {
  const pad = (value: number, width = 2): string => String(Math.trunc(Math.abs(value))).padStart(width, '0');
  const offsetMinutesTotal = -date.getTimezoneOffset();
  const sign = offsetMinutesTotal >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutesTotal);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

export function readToolIdentity(): { name: string; version: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, '../../package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Cannot read ${file}: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new ToolError(`${file} must contain a JSON object.`);
  const record = parsed as { name?: unknown; version?: unknown };
  if (typeof record.name !== 'string' || record.name.length === 0) throw new ToolError(`${file} is missing a name.`);
  if (typeof record.version !== 'string' || record.version.length === 0) {
    throw new ToolError(`${file} is missing a version.`);
  }
  return { name: record.name, version: record.version };
}

/**
 * `trusted` means no warn or error finding. `review` means at least one warn and no error.
 * `untrusted` means at least one error. `baseline-red` is reserved for a later runtime check,
 * so this function does not return it. `not-run` covers skip, fixme, and describe.skip.
 * Info findings do not lower a test that ran.
 */
export function verdictFor(
  kind: 'test' | 'describe',
  modifiers: readonly string[],
  findings: readonly { severity: Severity }[],
): Verdict {
  if (kind === 'describe' || modifiers.includes('skip') || modifiers.includes('fixme')) return 'not-run';
  if (findings.some((finding) => finding.severity === 'error')) return 'untrusted';
  if (findings.some((finding) => finding.severity === 'warn')) return 'review';
  return 'trusted';
}

export function summarize(tests: readonly ReportTest[]): ReportSummary {
  const severity = { error: 0, warn: 0, info: 0 };
  const verdict: Record<Verdict, number> = {
    trusted: 0,
    review: 0,
    untrusted: 0,
    'baseline-red': 0,
    'not-run': 0,
  };
  for (const test of tests) {
    verdict[test.verdict] += 1;
    for (const finding of test.findings) severity[finding.severity] += 1;
  }
  return { severity, verdict };
}

export function buildReport(input: ReportInput): Report {
  const tool = readToolIdentity();
  const rows = rowsFor(input);
  const tests = rows
    .map((row) => toReportTest(row, input.projectDir))
    .sort((left, right) => {
      const byFile = left.file.localeCompare(right.file);
      if (byFile !== 0) return byFile;
      if (left.line !== right.line) return left.line - right.line;
      return left.id.localeCompare(right.id);
    });
  return {
    schemaVersion: 1,
    tool,
    startedAt: formatIsoOffset(input.startedAt),
    finishedAt: formatIsoOffset(input.finishedAt),
    project: {
      dir: projectDirLabel(input.projectDir),
      configFile: input.configFile ? toProjectPath(input.configFile, input.projectDir) : null,
      specCount: input.specCount,
      testCount: input.tests.length,
    },
    checksRun: [...input.checksRun],
    summary: summarize(tests),
    tests,
  };
}

function rowsFor(input: ReportInput): Row[] {
  const rows: Row[] = [];
  for (const test of input.tests) {
    rows.push({
      kind: 'test',
      ownerId: ownerIdFor('test', test.file, test.line, test.column, test.titlePath),
      file: test.file,
      line: test.line,
      column: test.column,
      titlePath: test.titlePath,
      modifiers: test.modifiers,
      findings: [],
    });
  }
  for (const block of input.skippedDescribes) {
    rows.push({
      kind: 'describe',
      ownerId: ownerIdFor('describe', block.file, block.line, block.column, block.titlePath),
      file: block.file,
      line: block.line,
      column: block.column,
      titlePath: block.titlePath,
      modifiers: ['skip'],
      findings: [],
    });
  }
  const byOwner = new Map(rows.map((row) => [row.ownerId, row]));
  for (const finding of input.findings) {
    const row = byOwner.get(finding.ownerId);
    if (row) row.findings.push(finding);
  }
  return rows;
}

function toReportTest(row: Row, projectDir: string): ReportTest {
  const file = toProjectPath(row.file, projectDir);
  return {
    id: `${file}:${row.line}:${row.column}:${row.titlePath.join(' > ')}`,
    file,
    line: row.line,
    titlePath: [...row.titlePath],
    verdict: verdictFor(row.kind, row.modifiers, row.findings),
    findings: row.findings.map((finding) => toReportFinding(finding, projectDir)),
  };
}

function toReportFinding(finding: Finding, projectDir: string): ReportFinding {
  const report: ReportFinding = {
    ruleId: finding.ruleId,
    check: finding.check,
    severity: finding.severity,
    file: toProjectPath(finding.file, projectDir),
    line: finding.line,
    column: finding.column,
    message: finding.message,
    evidence: finding.evidence,
    fixHint: finding.fixHint,
  };
  if (finding.relatedLintRule) report.relatedLintRule = finding.relatedLintRule;
  return report;
}
