import fs from 'node:fs';
import path from 'node:path';

export interface BaselineSummary {
  /** False when Playwright did not print a JSON report. */
  ok: boolean;
  exitCode: number;
  passed: number;
  failed: number;
  skipped: number;
  /** `path/file.ts:line` for a test whose Playwright status is `unexpected`. */
  failedKeys: Set<string>;
  /**
   * `path/file.ts:line:column` for every spec in the JSON report.
   * The column is Playwright's. Omitted by unit fixtures that predate this field, which then count every inventory row as run.
   */
  seenKeys?: Set<string>;
  /**
   * `path/file.ts:line:column` when every project skipped that test.
   * The column is Playwright's. A project that passed or failed the same test removes the key.
   */
  skippedKeys?: Set<string>;
  stdout: string;
  stderr: string;
}

interface JsonSuite {
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

interface JsonSpec {
  file?: string;
  line?: number;
  column?: number;
  tests?: JsonTest[];
}

interface JsonTest {
  status?: string;
  results?: Array<{ status?: string }>;
}

interface ReportRoots {
  rootDir?: string;
  testDirs: string[];
}

/**
 * Read the JSON reporter document. A broken config leaves stdout empty or non-JSON.
 * `spec.file` is relative to Playwright's `config.rootDir` (the config directory plus `testDir`),
 * not to the project folder. `workspaceDir` maps that path, and each project `testDir`, back to the copy.
 */
export function parseBaseline(
  stdout: string,
  stderr: string,
  exitCode: number,
  workspaceDir?: string,
): BaselineSummary {
  const failedKeys = new Set<string>();
  const seenKeys = new Set<string>();
  const skippedKeys = new Set<string>();
  const summary: BaselineSummary = {
    ok: false,
    exitCode,
    passed: 0,
    failed: 0,
    skipped: 0,
    failedKeys,
    seenKeys,
    skippedKeys,
    stdout,
    stderr,
  };
  const start = stdout.indexOf('{');
  if (start < 0) return summary;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return summary;
  }
  if (typeof parsed !== 'object' || parsed === null || !('suites' in parsed)) return summary;
  const suites = (parsed as { suites?: unknown }).suites;
  if (!Array.isArray(suites)) return summary;
  const roots = readRoots(parsed);
  const states = new Map<string, LocationState>();
  for (const suite of suites) walkSuite(suite, summary, roots, workspaceDir, states);
  for (const [key, state] of states) {
    if (state.failed) summary.failedKeys.add(state.lineKey);
    else if (state.skipped && !state.ran) summary.skippedKeys?.add(key);
  }
  summary.ok = true;
  return summary;
}

/** One file, line, and column across every project spec that shares it. */
interface LocationState {
  lineKey: string;
  failed: boolean;
  ran: boolean;
  skipped: boolean;
}

function readRoots(parsed: object): ReportRoots {
  const config = (parsed as { config?: { rootDir?: unknown; projects?: unknown } }).config;
  const rootDir = config && typeof config.rootDir === 'string' && config.rootDir.length > 0 ? config.rootDir : undefined;
  const testDirs: string[] = [];
  if (config && Array.isArray(config.projects)) {
    for (const project of config.projects) {
      if (typeof project !== 'object' || project === null) continue;
      const testDir = (project as { testDir?: unknown }).testDir;
      if (typeof testDir === 'string' && testDir.length > 0) testDirs.push(testDir);
    }
  }
  return { rootDir, testDirs };
}

/** Project-relative spec path. `rootDir` is tried first, then each project `testDir`. */
export function specFileInProject(file: string, roots: ReportRoots, workspaceDir: string | undefined): string {
  const normalized = file.split('\\').join('/');
  if (!workspaceDir) return normalized;
  const bases: string[] = [];
  if (roots.rootDir) bases.push(roots.rootDir);
  for (const testDir of roots.testDirs) bases.push(testDir);
  const inside: string[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    const absolute = path.resolve(base, normalized);
    const relative = path.relative(workspaceDir, absolute);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const posix = relative.split(path.sep).join('/');
    if (seen.has(posix)) continue;
    seen.add(posix);
    inside.push(posix);
  }
  if (inside.length === 0) return normalized;
  for (const relative of inside) {
    if (fs.existsSync(path.join(workspaceDir, relative))) return relative;
  }
  const first = inside[0];
  return first ?? normalized;
}

export function baselineKey(file: string, line: number): string {
  return `${file.split('\\').join('/')}:${line}`;
}

function walkSuite(
  value: unknown,
  summary: BaselineSummary,
  roots: ReportRoots,
  workspaceDir: string | undefined,
  states: Map<string, LocationState>,
): void {
  if (typeof value !== 'object' || value === null) return;
  const suite = value as JsonSuite;
  for (const spec of suite.specs ?? []) classifySpec(spec, summary, roots, workspaceDir, states);
  for (const child of suite.suites ?? []) walkSuite(child, summary, roots, workspaceDir, states);
}

/**
 * The baseline passes `--retries=0`, so Playwright status is `expected`, `unexpected`, or `skipped`.
 * A first failure is `unexpected`. A retry never runs, so the status is not `flaky`.
 * An expected `test.fail()` has status `expected` even when a result is `failed`.
 * A result status is not used, so an expected failure is not a baseline failure.
 */
function classifySpec(
  spec: JsonSpec,
  summary: BaselineSummary,
  roots: ReportRoots,
  workspaceDir: string | undefined,
  states: Map<string, LocationState>,
): void {
  const raw = typeof spec.file === 'string' ? spec.file : '';
  const file = raw ? specFileInProject(raw, roots, workspaceDir) : '';
  const line = spec.line;
  const column = typeof spec.column === 'number' ? spec.column : 0;
  if (file && typeof line === 'number') {
    summary.seenKeys?.add(`${baselineKey(file, line)}:${column}`);
  }
  for (const test of spec.tests ?? []) {
    const kind = outcomeKind(test.status);
    if (kind === 'failed') summary.failed += 1;
    else if (kind === 'skipped') summary.skipped += 1;
    else summary.passed += 1;
    if (file && typeof line === 'number') noteLocation(states, file, line, column, kind);
  }
}

function outcomeKind(status: string | undefined): 'failed' | 'skipped' | 'ran' {
  if (status === 'unexpected') return 'failed';
  if (status === 'skipped') return 'skipped';
  return 'ran';
}

function noteLocation(
  states: Map<string, LocationState>,
  file: string,
  line: number,
  column: number,
  kind: 'failed' | 'skipped' | 'ran',
): void {
  const key = `${baselineKey(file, line)}:${column}`;
  const state = states.get(key) ?? { lineKey: baselineKey(file, line), failed: false, ran: false, skipped: false };
  if (kind === 'failed') state.failed = true;
  else if (kind === 'skipped') state.skipped = true;
  else state.ran = true;
  states.set(key, state);
}
