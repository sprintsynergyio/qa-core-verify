import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InventoryTest, SkippedDescribe, TestModifier } from '../inventory/parse.js';
import type { Finding, Severity } from '../rules/types.js';
import { ownerIdFor } from '../rules/types.js';
import { displayText, projectDirLabel, toProjectPath } from './paths.js';
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

export type LocatorStatus = 'unique' | 'ambiguous' | 'never-matched';

/** One locator seen in a test during the locator check. */
export interface ReportLocator {
  selector: string;
  api: string;
  status: LocatorStatus;
  file: string;
  line: number;
  column: number;
  /** Raw `matchCount` values that were numbers. */
  counts: number[];
  /** Parent counts for `.first()`, `.last()`, and `.nth()`. */
  parentCounts: number[];
}

export interface ReportTest {
  id: string;
  file: string;
  line: number;
  titlePath: string[];
  verdict: Verdict;
  findings: ReportFinding[];
  /** Present when the locator check evaluated this row. */
  locators?: ReportLocator[];
  /** Present when the assertion-inversion check listed this row's assertions. */
  assertions?: ReportAssertion[];
  /** Why a not-run row was not evaluated, when the checker knows. */
  reason?: string;
  /** Fault id and result. Present when the fault-injection check ran. */
  faults?: ReportFaultCell[];
}

export type AssertionOutcomeName = 'killed' | 'survived' | 'timeout' | 'error' | 'not-run' | 'skipped';

/** One assertion from the inversion check, with the outcome of inverting it. */
export interface ReportAssertion {
  file: string;
  line: number;
  column: number;
  matcher: string;
  outcome: AssertionOutcomeName;
  source: string;
  reason?: string;
}

export type FaultResultName = 'pass' | 'fail' | 'skipped' | 'not-run';

export interface ReportFaultCell {
  id: string;
  result: FaultResultName;
}

export interface FaultRunSummary {
  faults: { id: string; type: string }[];
}

export interface InversionSummary {
  mutants: number;
  runs: number;
  stoppedAtLimit: boolean;
  outcomes: Record<AssertionOutcomeName, number>;
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
  /** Present when `--only inversion` ran. Counts are computed from `tests[].assertions`. */
  inversion?: InversionSummary;
  /** Present when `--only faults` ran. */
  faultRun?: FaultRunSummary;
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
  /** Owner ids whose tests failed before locator rules ran. */
  baselineRed?: ReadonlySet<string>;
  /** Owner ids with no baseline result. They did not run. */
  notRun?: ReadonlySet<string>;
  /** Owner ids the locator check evaluated, mapped to the per-locator summary. */
  locatorSummaries?: ReadonlyMap<string, ReportLocator[]>;
  /** Owner ids mapped to assertion outcomes from the inversion check. */
  assertionSummaries?: ReadonlyMap<string, ReportAssertion[]>;
  /** Owner ids mapped to a short reason, printed on not-run rows. */
  statusReasons?: ReadonlyMap<string, string>;
  /** Owner ids mapped to the fault matrix. */
  faultCells?: ReadonlyMap<string, ReportFaultCell[]>;
  /** Present when the fault-injection check ran. */
  faultRun?: FaultRunSummary;
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
  baselineRed: boolean;
  absent: boolean;
  locators?: ReportLocator[];
  assertions?: ReportAssertion[];
  reason?: string;
  faults?: ReportFaultCell[];
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
 * `untrusted` means at least one error. `baseline-red` means Playwright status `unexpected`
 * in the baseline run, before locator rules. An expected `test.fail()` is not `baseline-red`.
 * `not-run` covers skip, fixme, describe.skip, a test the baseline report did not include,
 * and a test every project skipped.
 * Info findings do not lower a test that ran.
 * Skip and fixme stay not-run even when the baseline also failed.
 */
export function verdictFor(
  kind: 'test' | 'describe',
  modifiers: readonly string[],
  findings: readonly { severity: Severity }[],
  baselineRed = false,
  absent = false,
): Verdict {
  if (kind === 'describe' || modifiers.includes('skip') || modifiers.includes('fixme') || absent) return 'not-run';
  if (baselineRed) return 'baseline-red';
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
    .map((row) => ({ row, test: toReportTest(row, input.projectDir) }))
    .sort((left, right) => {
      const byFile = left.test.file.localeCompare(right.test.file);
      if (byFile !== 0) return byFile;
      if (left.test.line !== right.test.line) return left.test.line - right.test.line;
      if (left.row.column !== right.row.column) return left.row.column - right.row.column;
      return left.test.id.localeCompare(right.test.id);
    })
    .map((item) => item.test);
  const inversion = input.assertionSummaries ? inversionSummary(tests) : undefined;
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
    ...(inversion ? { inversion } : {}),
    ...(input.faultRun ? { faultRun: input.faultRun } : {}),
    tests,
  };
}

const EMPTY_OUTCOMES = (): Record<AssertionOutcomeName, number> => ({
  killed: 0,
  survived: 0,
  timeout: 0,
  error: 0,
  'not-run': 0,
  skipped: 0,
});

/** Counts come from the assertion rows. A stopped run is one whose reason is the limit note. */
function inversionSummary(tests: readonly ReportTest[]): InversionSummary {
  const outcomes = EMPTY_OUTCOMES();
  let stopped = 0;
  for (const test of tests) {
    for (const assertion of test.assertions ?? []) {
      outcomes[assertion.outcome] += 1;
      if (assertion.outcome === 'not-run' && assertion.reason === 'Stopped at limit.') stopped += 1;
    }
  }
  const runs = outcomes.killed + outcomes.survived + outcomes.timeout + outcomes.error;
  return { mutants: runs + stopped, runs, stoppedAtLimit: stopped > 0, outcomes };
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
      baselineRed: input.baselineRed?.has(ownerIdFor('test', test.file, test.line, test.column, test.titlePath)) === true,
      absent: input.notRun?.has(ownerIdFor('test', test.file, test.line, test.column, test.titlePath)) === true,
      reason: input.statusReasons?.get(ownerIdFor('test', test.file, test.line, test.column, test.titlePath)),
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
      baselineRed: false,
      absent: false,
    });
  }
  const byOwner = new Map(rows.map((row) => [row.ownerId, row]));
  for (const finding of input.findings) {
    const row = byOwner.get(finding.ownerId);
    if (!row || row.baselineRed || row.absent) continue;
    row.findings.push(finding);
  }
  if (input.locatorSummaries) {
    for (const row of rows) {
      if (row.baselineRed || row.absent || row.kind === 'describe') continue;
      if (row.modifiers.includes('skip') || row.modifiers.includes('fixme')) continue;
      row.locators = input.locatorSummaries.get(row.ownerId) ?? [];
    }
  }
  if (input.assertionSummaries) {
    for (const row of rows) {
      if (row.kind === 'describe') continue;
      const listed = input.assertionSummaries.get(row.ownerId);
      if (listed) row.assertions = listed.map((assertion) => ({ ...assertion }));
    }
  }
  if (input.faultCells) {
    for (const row of rows) {
      if (row.kind === 'describe') continue;
      const listed = input.faultCells.get(row.ownerId);
      if (listed) row.faults = listed.map((cell) => ({ ...cell }));
    }
  }
  return rows;
}

function toReportTest(row: Row, projectDir: string): ReportTest {
  const file = toProjectPath(row.file, projectDir);
  const titlePath = row.titlePath.map((part) => displayText(part));
  const report: ReportTest = {
    id: `${file}:${row.line}:${row.column}:${titlePath.join(' > ')}`,
    file,
    line: row.line,
    titlePath,
    verdict: verdictFor(row.kind, row.modifiers, row.findings, row.baselineRed, row.absent),
    findings: row.findings.map((finding) => toReportFinding(finding, projectDir)),
  };
  if (row.reason) report.reason = row.reason;
  if (row.locators) report.locators = row.locators;
  if (row.assertions) report.assertions = row.assertions;
  if (row.faults) report.faults = row.faults;
  return report;
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
