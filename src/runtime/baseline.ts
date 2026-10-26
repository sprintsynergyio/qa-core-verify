import fs from 'node:fs';
import path from 'node:path';

export interface BaselineSummary {
  /** False when Playwright did not print a JSON report. */
  ok: boolean;
  exitCode: number;
  passed: number;
  failed: number;
  skipped: number;
  /** `path/file.ts:line` for a test that failed, timed out, or was interrupted. */
  failedKeys: Set<string>;
  /**
   * `path/file.ts:line:column` for every spec in the JSON report.
   * The column is Playwright's. Omitted by unit fixtures that predate this field, which then count every inventory row as run.
   */
  seenKeys?: Set<string>;
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
  const summary: BaselineSummary = {
    ok: false,
    exitCode,
    passed: 0,
    failed: 0,
    skipped: 0,
    failedKeys,
    seenKeys,
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
  for (const suite of suites) walkSuite(suite, summary, roots, workspaceDir);
  summary.ok = true;
  return summary;
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

function walkSuite(value: unknown, summary: BaselineSummary, roots: ReportRoots, workspaceDir: string | undefined): void {
  if (typeof value !== 'object' || value === null) return;
  const suite = value as JsonSuite;
  for (const spec of suite.specs ?? []) classifySpec(spec, summary, roots, workspaceDir);
  for (const child of suite.suites ?? []) walkSuite(child, summary, roots, workspaceDir);
}

function classifySpec(spec: JsonSpec, summary: BaselineSummary, roots: ReportRoots, workspaceDir: string | undefined): void {
  const raw = typeof spec.file === 'string' ? spec.file : '';
  const file = raw ? specFileInProject(raw, roots, workspaceDir) : '';
  const line = spec.line;
  if (file && typeof line === 'number') {
    const column = typeof spec.column === 'number' ? spec.column : 0;
    summary.seenKeys?.add(`${baselineKey(file, line)}:${column}`);
  }
  for (const test of spec.tests ?? []) {
    const results = (test.results ?? []).map((result) => result.status ?? '');
    const failed = test.status === 'unexpected' || results.some((status) => status === 'failed' || status === 'timedOut' || status === 'interrupted');
    const skipped = !failed && (test.status === 'skipped' || (results.length > 0 && results.every((status) => status === 'skipped')));
    if (failed) {
      summary.failed += 1;
      if (file && typeof line === 'number') summary.failedKeys.add(baselineKey(file, line));
    } else if (skipped) summary.skipped += 1;
    else summary.passed += 1;
  }
}
