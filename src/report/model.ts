import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InventoryTest, SkippedDescribe, TestModifier } from '../inventory/parse.js';
import type { Finding, Severity } from '../rules/types.js';
import { ownerIdFor } from '../rules/types.js';
import { toDisplayPath } from './console.js';
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

export interface ReportInput {
  cwd: string;
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

/** ISO 8601 in UTC with a numeric offset. */
export function formatIsoOffset(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}+00:00`
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
 * Verdicts for a static run. `baseline-red` is reserved for a later check that the test
 * already fails on the unchanged app, so this function does not return it.
 * A skipped or fixme test, and a `test.describe.skip` block, are `not-run` even when they also have findings.
 * Any error finding makes a test that does run `untrusted`. Warn and info findings make it `review`.
 */
export function verdictFor(
  kind: 'test' | 'describe',
  modifiers: readonly string[],
  findings: readonly { severity: Severity }[],
): Verdict {
  if (kind === 'describe' || modifiers.includes('skip') || modifiers.includes('fixme')) return 'not-run';
  if (findings.some((finding) => finding.severity === 'error')) return 'untrusted';
  if (findings.length > 0) return 'review';
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
    .map((row) => toReportTest(row, input.cwd))
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
      dir: toDisplayPath(input.projectDir, input.cwd),
      configFile: input.configFile ? toDisplayPath(input.configFile, input.cwd) : null,
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

function toReportTest(row: Row, cwd: string): ReportTest {
  const file = toDisplayPath(row.file, cwd);
  return {
    id: `${file}:${row.line}:${row.column}:${row.titlePath.join(' > ')}`,
    file,
    line: row.line,
    titlePath: [...row.titlePath],
    verdict: verdictFor(row.kind, row.modifiers, row.findings),
    findings: row.findings.map((finding) => toReportFinding(finding, cwd)),
  };
}

function toReportFinding(finding: Finding, cwd: string): ReportFinding {
  const report: ReportFinding = {
    ruleId: finding.ruleId,
    check: finding.check,
    severity: finding.severity,
    file: toDisplayPath(finding.file, cwd),
    line: finding.line,
    column: finding.column,
    message: finding.message,
    evidence: finding.evidence,
    fixHint: finding.fixHint,
  };
  if (finding.relatedLintRule) report.relatedLintRule = finding.relatedLintRule;
  return report;
}
