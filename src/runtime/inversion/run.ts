import fs from 'node:fs';
import path from 'node:path';
import { loadVerifyConfig } from '../../config.js';
import { discoverSpecs, findPlaywrightConfig } from '../../inventory/discover.js';
import { parseSpecFile, type ExpectCall, type InventoryTest, type SkippedDescribe } from '../../inventory/parse.js';
import { buildReport, type Report, type ReportAssertion } from '../../report/model.js';
import { columnsFor } from '../../rules/locator-status.js';
import { ownerIdFor, type Finding } from '../../rules/types.js';
import { ToolError } from '../../tool-error.js';
import { parseBaseline, specFileInProject, type BaselineSummary } from '../baseline.js';
import { BaselineStartError } from '../locator-check.js';
import { assertWorkspaceFile, configInsideProject, withCopiedProject, type PlaywrightRun } from '../workspace.js';
import { planMutations, type MutationPlan } from './mutate.js';

export type MutantOutcome = 'killed' | 'survived' | 'timeout' | 'error';

export interface MutantClass {
  outcome: MutantOutcome;
  reason?: string;
}

interface JsonSuite {
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

interface JsonSpec {
  file?: string;
  line?: number;
  column?: number;
  tests?: Array<{ results?: Array<{ status?: string }> }>;
}

/**
 * Read one inverted test from Playwright's JSON reporter.
 * `killed` means a result status `failed`. `survived` means every result `passed`.
 * `timeout` means a result status `timedOut` and is never treated as killed.
 * A missing report or any other result status is `error`.
 */
export function classifyMutantOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
  file: string,
  line: number,
  columns: readonly number[],
  workspaceDir?: string,
): MutantClass {
  const parsed = parseReporter(stdout);
  if (!parsed) {
    return {
      outcome: 'error',
      reason: firstProblemLine(stderr, stdout) ?? 'Playwright produced no report for the inverted test.',
    };
  }
  const specs = specsOnLine(parsed.suites, parsed.roots, workspaceDir, file, line);
  const matched = specs.filter((spec) => typeof spec.column === 'number' && columns.includes(spec.column));
  const chosen = matched.length > 0 ? matched : specs.length === 1 ? specs : [];
  if (chosen.length === 0) {
    return {
      outcome: 'error',
      reason: firstProblemLine(stderr, stdout) ?? `Playwright exited ${exitCode} and did not report ${file}:${line}.`,
    };
  }
  const results: string[] = [];
  for (const spec of chosen) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        if (typeof result.status === 'string') results.push(result.status);
      }
    }
  }
  if (results.length === 0) return { outcome: 'error', reason: 'Playwright reported the test without a result status.' };
  if (results.some((status) => status === 'timedOut')) return { outcome: 'timeout', reason: 'The inverted test timed out.' };
  if (results.some((status) => status === 'failed')) return { outcome: 'killed' };
  if (results.every((status) => status === 'passed')) return { outcome: 'survived' };
  if (results.some((status) => status === 'interrupted')) return { outcome: 'error', reason: 'The inverted test was interrupted.' };
  return { outcome: 'error', reason: `The inverted test ended as ${results.join(', ')}.` };
}

export interface InversionRun {
  report: Report;
  findings: Finding[];
  runRoot: string;
  kept: boolean;
  skippedLinks: string[];
  baseline: BaselineSummary;
  /** Wall time of the baseline plus every mutant run, in milliseconds. */
  durationMs: number;
}

interface Bucket {
  assertions: Map<string, ReportAssertion[]>;
  findings: Finding[];
}

/**
 * Baseline the suite, then invert one assertion at a time in the temp copy.
 * A green test whose inverted copy still passes is QCV-F001. The original project is not written.
 * `--max-runs` stops early. Assertions that were not started are `not-run` with reason `Stopped at limit.`
 */
export async function collectInversion(options: {
  projectDir: string;
  keepWorkspace: boolean;
  configFile?: string;
  cwd?: string;
  now?: () => Date;
  maxRuns?: number;
}): Promise<InversionRun> {
  const projectDir = path.resolve(options.projectDir);
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const wallStart = Date.now();
  const inventory = readInventory(projectDir, options.configFile, cwd);
  const plans = plansFor(inventory.tests);
  let baselineRun: PlaywrightRun | undefined;
  let baselineSummary: BaselineSummary | undefined;
  const collected: Bucket = { assertions: new Map(), findings: [] };
  const run = await withCopiedProject(
    projectDir,
    { keep: options.keepWorkspace, configFile: inventory.forwardedConfig },
    async (session) => {
      const baseline = await session.run([
        'test',
        '--retries=0',
        '--workers=1',
        '--reporter=json',
        '--output=test-results-baseline',
      ]);
      baselineRun = baseline;
      const parsed = parseBaseline(baseline.stdout, baseline.stderr, baseline.exitCode, session.workspaceDir);
      if (!parsed.ok) throw new BaselineStartError(baseline);
      baselineSummary = parsed;
      noteStaticAssertions(projectDir, inventory.tests, plans, parsed, collected);
      const work = mutantWork(projectDir, inventory.tests, plans, parsed);
      const limit = options.maxRuns === undefined ? work.length : options.maxRuns;
      console.error(`Inversion plan: ${work.length} mutants, ${Math.min(work.length, limit)} runs.`);
      let executed = 0;
      for (const item of work) {
        if (executed >= limit) {
          addAssertion(collected, item, 'not-run', 'Stopped at limit.');
          continue;
        }
        executed += 1;
        await runOneMutant(session.workspaceDir, session.run, item, executed, collected);
      }
      if (executed < work.length) console.error(`Stopped at limit. ${work.length - executed} assertions were not run.`);
      return baseline;
    },
  );
  if (!baselineRun || !baselineSummary) throw new ToolError('Baseline Playwright run did not start.');
  sortAssertions(collected.assertions);
  const durationMs = Date.now() - wallStart;
  console.error(`Inversion time: ${durationMs} ms.`);
  const report = buildReport({
    projectDir,
    configFile: inventory.configFile,
    specCount: inventory.specCount,
    tests: inventory.tests,
    skippedDescribes: inventory.skippedDescribes,
    findings: collected.findings,
    checksRun: ['cannot-fail'],
    startedAt,
    finishedAt: now(),
    baselineRed: idsWhere(projectDir, inventory.tests, baselineSummary, 'failed'),
    notRun: notRunIds(projectDir, inventory.tests, baselineSummary, collected.assertions),
    assertionSummaries: collected.assertions,
  });
  return {
    report,
    findings: collected.findings,
    runRoot: run.runRoot,
    kept: run.kept,
    skippedLinks: run.skippedLinks,
    baseline: baselineSummary,
    durationMs,
  };
}

interface WorkItem {
  test: InventoryTest;
  testRelative: string;
  relativeFile: string;
  absoluteFile: string;
  plan: MutationPlan;
}

async function runOneMutant(
  workspaceDir: string,
  run: (args?: string[]) => Promise<PlaywrightRun>,
  item: WorkItem,
  index: number,
  collected: Bucket,
): Promise<void> {
  const target = path.join(workspaceDir, item.relativeFile);
  if (item.relativeFile.startsWith('..') || path.isAbsolute(item.relativeFile)) {
    addAssertion(collected, item, 'not-run', 'The assertion file is outside the temp copy.');
    return;
  }
  const original = fs.readFileSync(target);
  try {
    assertWorkspaceFile(workspaceDir, target);
    fs.writeFileSync(target, item.plan.mutated ?? original);
    const mutant = await run([
      'test',
      `${item.testRelative}:${item.test.line}`,
      '--retries=0',
      '--workers=1',
      '--reporter=json',
      `--output=test-results-mutant-${index}`,
    ]);
    const classified = classifyMutantOutput(
      mutant.stdout,
      mutant.stderr,
      mutant.exitCode,
      item.testRelative,
      item.test.line,
      columnsFor(item.test),
      workspaceDir,
    );
    if (classified.outcome === 'killed' || classified.outcome === 'survived') {
      addAssertion(collected, item, classified.outcome);
      if (classified.outcome === 'survived') collected.findings.push(f001(item));
      return;
    }
    addAssertion(collected, item, classified.outcome, classified.reason);
  } finally {
    if (fs.existsSync(target)) {
      assertWorkspaceFile(workspaceDir, target);
      fs.writeFileSync(target, original);
    }
  }
}

function noteStaticAssertions(
  projectDir: string,
  tests: readonly InventoryTest[],
  plans: ReadonlyMap<string, MutationPlan[]>,
  baseline: BaselineSummary,
  collected: Bucket,
): void {
  const siblings = siblingCounts(projectDir, tests);
  for (const test of tests) {
    const ownerId = ownerFor(test);
    const green = isGreen(projectDir, test, baseline, siblings);
    for (const expect of test.expects) {
      const plan = findPlan(plans, expect);
      const relativeFile = relative(projectDir, expect.file);
      if (!green) {
        const reason = isFailed(projectDir, test, baseline, siblings)
          ? 'The test failed before inversion.'
          : wasSeen(projectDir, test, baseline, siblings)
            ? 'The test did not run in the baseline.'
            : 'The test has no baseline result.';
        push(collected, ownerId, {
          file: relativeFile,
          line: expect.line,
          column: expect.column,
          matcher: expect.matcher,
          outcome: 'not-run',
          source: expect.evidence,
          reason,
        });
        continue;
      }
      if (!plan || plan.kind === 'skip') {
        const reason = plan?.reason ?? 'The assertion could not be mapped to an expect call.';
        push(collected, ownerId, {
          file: relativeFile,
          line: plan?.line ?? expect.line,
          column: plan?.column ?? expect.column,
          matcher: plan?.matcher ?? expect.matcher,
          outcome: 'skipped',
          source: plan?.source ?? expect.evidence,
          reason,
        });
        collected.findings.push({
          ruleId: 'QCV-F001',
          check: 'cannot-fail',
          severity: 'info',
          file: path.resolve(projectDir, relativeFile),
          line: plan?.line ?? expect.line,
          column: plan?.column ?? expect.column,
          testTitle: test.titlePath.join(' > '),
          message: 'Assertion inversion does not apply.',
          evidence: reason,
          fixHint: 'Invert a matcher that Playwright can negate with .not.',
          ownerId,
        });
      }
    }
  }
}

function mutantWork(
  projectDir: string,
  tests: readonly InventoryTest[],
  plans: ReadonlyMap<string, MutationPlan[]>,
  baseline: BaselineSummary,
): WorkItem[] {
  const work: WorkItem[] = [];
  const siblings = siblingCounts(projectDir, tests);
  for (const test of tests) {
    if (!isGreen(projectDir, test, baseline, siblings)) continue;
    const testRelative = relative(projectDir, test.file);
    for (const expect of test.expects) {
      const plan = findPlan(plans, expect);
      if (!plan || plan.kind !== 'invert' || plan.mutated === undefined) continue;
      const relativeFile = relative(projectDir, expect.file);
      work.push({ test, testRelative, relativeFile, absoluteFile: path.resolve(projectDir, relativeFile), plan });
    }
  }
  work.sort((left, right) => {
    if (left.relativeFile !== right.relativeFile) return left.relativeFile < right.relativeFile ? -1 : 1;
    if (left.plan.line !== right.plan.line) return left.plan.line - right.plan.line;
    if (left.plan.column !== right.plan.column) return left.plan.column - right.plan.column;
    if (left.testRelative !== right.testRelative) return left.testRelative < right.testRelative ? -1 : 1;
    return left.test.column - right.test.column;
  });
  return work;
}

function addAssertion(collected: Bucket, item: WorkItem, outcome: ReportAssertion['outcome'], reason?: string): void {
  push(collected, ownerFor(item.test), {
    file: item.relativeFile,
    line: item.plan.line,
    column: item.plan.column,
    matcher: item.plan.matcher,
    outcome,
    source: item.plan.source,
    ...(reason ? { reason } : {}),
  });
}

function f001(item: WorkItem): Finding {
  return {
    ruleId: 'QCV-F001',
    check: 'cannot-fail',
    severity: 'error',
    file: item.absoluteFile,
    line: item.plan.line,
    column: item.plan.column,
    testTitle: item.test.titlePath.join(' > '),
    message: 'Assertion cannot fail.',
    evidence: item.plan.source,
    fixHint: 'The inverted assertion still passed, so this assertion does not make the test fail.',
    ownerId: ownerFor(item.test),
  };
}

function push(collected: Bucket, ownerId: string, assertion: ReportAssertion): void {
  const list = collected.assertions.get(ownerId) ?? [];
  list.push(assertion);
  collected.assertions.set(ownerId, list);
}

function sortAssertions(assertions: Map<string, ReportAssertion[]>): void {
  for (const list of assertions.values()) {
    list.sort((left, right) => left.line - right.line || left.column - right.column || left.matcher.localeCompare(right.matcher));
  }
}

function plansFor(tests: readonly InventoryTest[]): Map<string, MutationPlan[]> {
  const files = new Set<string>();
  for (const test of tests) {
    files.add(path.resolve(test.file));
    for (const expect of test.expects) files.add(path.resolve(expect.file));
  }
  const plans = new Map<string, MutationPlan[]>();
  for (const file of files) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    plans.set(file, planMutations(file, fs.readFileSync(file, 'utf8')));
  }
  return plans;
}

function findPlan(plans: ReadonlyMap<string, MutationPlan[]>, expect: ExpectCall): MutationPlan | undefined {
  return plans.get(path.resolve(expect.file))?.find((plan) => plan.line === expect.line && plan.column === expect.column);
}

function readInventory(
  projectDir: string,
  configArg: string | undefined,
  cwd: string,
): {
  specCount: number;
  tests: InventoryTest[];
  skippedDescribes: SkippedDescribe[];
  configFile: string | undefined;
  forwardedConfig: string | undefined;
} {
  const config = loadVerifyConfig(projectDir);
  const forwarded = configArg ? configInsideProject(configArg, projectDir, cwd) : undefined;
  const absoluteConfig = forwarded ? path.resolve(projectDir, forwarded) : undefined;
  const discovery = discoverSpecs(projectDir, [], projectDir, absoluteConfig);
  const tests: InventoryTest[] = [];
  const skippedDescribes: SkippedDescribe[] = [];
  for (const file of discovery.files) {
    const inventory = parseSpecFile(file, config);
    tests.push(...inventory.tests);
    skippedDescribes.push(...inventory.skippedDescribes);
  }
  return {
    specCount: discovery.files.length,
    tests,
    skippedDescribes,
    configFile: absoluteConfig ?? findPlaywrightConfig(projectDir),
    forwardedConfig: forwarded,
  };
}

function siblingCounts(projectDir: string, tests: readonly InventoryTest[]): Map<string, number> {
  const siblings = new Map<string, number>();
  for (const test of tests) {
    const key = `${relative(projectDir, test.file)}:${test.line}`;
    siblings.set(key, (siblings.get(key) ?? 0) + 1);
  }
  return siblings;
}

function isGreen(projectDir: string, test: InventoryTest, baseline: BaselineSummary, siblings: Map<string, number>): boolean {
  return wasSeen(projectDir, test, baseline, siblings) && !isFailed(projectDir, test, baseline, siblings) && !isBaselineSkipped(projectDir, test, baseline, siblings);
}

function isFailed(projectDir: string, test: InventoryTest, baseline: BaselineSummary, siblings: Map<string, number>): boolean {
  return hits(baseline.failedKeys, relative(projectDir, test.file), test, siblings);
}

function isBaselineSkipped(projectDir: string, test: InventoryTest, baseline: BaselineSummary, siblings: Map<string, number>): boolean {
  if (!baseline.skippedKeys) return false;
  return hits(baseline.skippedKeys, relative(projectDir, test.file), test, siblings);
}

function wasSeen(projectDir: string, test: InventoryTest, baseline: BaselineSummary, siblings: Map<string, number>): boolean {
  if (!baseline.seenKeys) return true;
  return hits(baseline.seenKeys, relative(projectDir, test.file), test, siblings);
}

function hits(keys: Set<string>, file: string, test: InventoryTest, siblings: Map<string, number>): boolean {
  const lineKey = `${file}:${test.line}`;
  const count = siblings.get(lineKey) ?? 1;
  if (count <= 1 && keys.has(lineKey)) return true;
  const prefix = `${lineKey}:`;
  const columns = columnsFor(test);
  let seen = 0;
  let columnHit = false;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    seen += 1;
    const column = Number(key.slice(prefix.length));
    if (columns.includes(column)) columnHit = true;
  }
  if (seen === 0) return false;
  if (count <= 1) return true;
  return columnHit;
}

function idsWhere(projectDir: string, tests: readonly InventoryTest[], baseline: BaselineSummary, kind: 'failed'): Set<string> {
  const ids = new Set<string>();
  const siblings = siblingCounts(projectDir, tests);
  for (const test of tests) {
    if (kind === 'failed' && isFailed(projectDir, test, baseline, siblings)) ids.add(ownerFor(test));
  }
  return ids;
}

function notRunIds(
  projectDir: string,
  tests: readonly InventoryTest[],
  baseline: BaselineSummary,
  assertions: ReadonlyMap<string, ReportAssertion[]>,
): Set<string> {
  const ids = new Set<string>();
  const siblings = siblingCounts(projectDir, tests);
  for (const test of tests) {
    const id = ownerFor(test);
    if (isFailed(projectDir, test, baseline, siblings)) continue;
    if (!isGreen(projectDir, test, baseline, siblings)) {
      ids.add(id);
      continue;
    }
    const rows = assertions.get(id) ?? [];
    const survived = rows.some((row) => row.outcome === 'survived');
    const unchecked = rows.some((row) => row.outcome === 'not-run' || row.outcome === 'timeout' || row.outcome === 'error');
    if (unchecked && !survived) ids.add(id);
  }
  return ids;
}

function ownerFor(test: InventoryTest): string {
  return ownerIdFor('test', test.file, test.line, test.column, test.titlePath);
}

function relative(projectDir: string, file: string): string {
  return path.relative(projectDir, file).split(path.sep).join('/');
}

function firstProblemLine(stderr: string, stdout: string): string | undefined {
  for (const line of `${stderr}\n${stdout}`.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('at ') || trimmed.startsWith('at\t')) continue;
    if (/Error|error TS|SyntaxError|failed|Failed|Cannot|Unexpected/.test(trimmed)) return trimmed;
  }
  return undefined;
}

function parseReporter(stdout: string): { suites: unknown[]; roots: { rootDir?: string; testDirs: string[] } } | undefined {
  const start = stdout.indexOf('{');
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('suites' in parsed)) return undefined;
  const suites = (parsed as { suites?: unknown }).suites;
  if (!Array.isArray(suites)) return undefined;
  const config = (parsed as { config?: { rootDir?: unknown; projects?: unknown } }).config;
  const rootDir = config && typeof config.rootDir === 'string' ? config.rootDir : undefined;
  const testDirs: string[] = [];
  if (config && Array.isArray(config.projects)) {
    for (const project of config.projects) {
      if (typeof project !== 'object' || project === null) continue;
      const testDir = (project as { testDir?: unknown }).testDir;
      if (typeof testDir === 'string') testDirs.push(testDir);
    }
  }
  return { suites, roots: { rootDir, testDirs } };
}

function specsOnLine(
  suites: unknown[],
  roots: { rootDir?: string; testDirs: string[] },
  workspaceDir: string | undefined,
  file: string,
  line: number,
): JsonSpec[] {
  const found: JsonSpec[] = [];
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    const suite = value as JsonSuite;
    for (const spec of suite.specs ?? []) {
      const raw = typeof spec.file === 'string' ? spec.file : '';
      const specFile = raw ? specFileInProject(raw, roots, workspaceDir) : '';
      const column = typeof spec.column === 'number' ? spec.column : 0;
      if (specFile === file && spec.line === line) found.push({ ...spec, column });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of suites) walk(suite);
  return found;
}
