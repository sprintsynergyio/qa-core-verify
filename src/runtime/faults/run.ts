import fs from 'node:fs';
import path from 'node:path';
import { loadVerifyConfig } from '../../config.js';
import { discoverSpecs, findPlaywrightConfig } from '../../inventory/discover.js';
import { parseSpecFile, type InventoryTest, type SkippedDescribe } from '../../inventory/parse.js';
import { buildReport, type Report } from '../../report/model.js';
import { columnsFor } from '../../rules/locator-status.js';
import type { Finding } from '../../rules/types.js';
import { ToolError } from '../../tool-error.js';
import { parseBaseline, type BaselineSummary } from '../baseline.js';
import { BaselineStartError } from '../locator-check.js';
import { configInsideProject, withCopiedProject, type PlaywrightRun } from '../workspace.js';
import { classifyFindings, ownerForTest, type ClassifiedTest, type FaultCell } from './findings.js';
import { installFaultFixture } from './install.js';
import { loadFaultFile, titleMatches, type Fault, type FaultResultName, type FaultType } from './types.js';

export const FAULT_NOT_APPLIED_REASON = 'The fault was not applied to a page this test used.';
export const BLANK_NOT_PRESENT_REASON = 'The blank page was not present when the test finished.';
export const FAULT_NOT_FOUND_REASON = 'The test was not found in the fault run.';
export const LOCATION_DRIFT_REASON = 'The baseline locations do not match the inventoried tests.';
export const UNEVALUATED_REASON = 'Every fault was not-run, so the cannot-fail check did not exercise this test.';
export const LOCATION_DRIFT_LINE =
  'Baseline locations match no inventoried test. Fault cells are not-run. This run exits 2.';
const FAIL_CELL_REASON = 'The test failed.';

export interface FaultCheckRun {
  report: Report;
  findings: Finding[];
  runRoot: string;
  kept: boolean;
  skippedLinks: string[];
  baseline: BaselineSummary;
  durationMs: number;
  /** One stderr line per fault, computed from the matrix. */
  faultLines: string[];
  /** Baseline ran tests and the report has no row for them. */
  unmatchedBaseline: boolean;
  /** Baseline ran tests and none of those locations match the inventory. */
  locationDrift: boolean;
}

/**
 * Baseline the suite, then run it once per fault in a temp copy.
 * The original project is not written. blank-app is always one of the faults.
 */
export async function collectFaults(options: {
  projectDir: string;
  keepWorkspace: boolean;
  configFile?: string;
  cwd?: string;
  now?: () => Date;
}): Promise<FaultCheckRun> {
  const projectDir = path.resolve(options.projectDir);
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const wallStart = Date.now();
  const faults = loadFaultFile(projectDir);
  const inventory = readInventory(projectDir, options.configFile, cwd);
  const siblings = siblingCounts(projectDir, inventory.tests);
  let baselineRun: PlaywrightRun | undefined;
  let baselineSummary: BaselineSummary | undefined;
  const cells = new Map<string, FaultCell[]>();
  const counts = new Map<string, Map<string, Record<string, number>>>();
  const quietBroke = new Set<string>();
  const missingOwners = new Set<string>();
  const statusReasons = new Map<string, string>();
  let locationDrift = false;
  for (const test of inventory.tests) {
    cells.set(ownerForTest(test), []);
    counts.set(ownerForTest(test), new Map());
  }
  const run = await withCopiedProject(
    projectDir,
    { keep: options.keepWorkspace, configFile: inventory.forwardedConfig },
    async (session) => {
      installFaultFixture(session.workspaceDir, inventory.forwardedConfig);
      const baseline = await session.run(
        ['test', '--retries=0', '--workers=1', '--reporter=json', '--output=test-results-baseline'],
        { QCV_FAULT: '' },
      );
      baselineRun = baseline;
      const parsed = parseBaseline(baseline.stdout, baseline.stderr, baseline.exitCode, session.workspaceDir);
      if (!parsed.ok) throw new BaselineStartError(baseline, session.workspaceDir, projectDir, parsed.loadError ?? '');
      baselineSummary = parsed;
      console.error(`Baseline: ${parsed.passed} passed, ${parsed.failed} failed, ${parsed.skipped} skipped.`);
      for (const link of session.skippedLinks) console.error(`Copy note: Skipped symlink ${link}.`);
      warnUnmatchedPatterns(faults, inventory.tests);
      let index = 0;
      for (const fault of faults) {
        index += 1;
        const logFile = path.join(session.workspaceDir, '.qa-core', 'fault-log', `${fault.id}.jsonl`);
        const env: NodeJS.ProcessEnv = {
          QCV_FAULT: JSON.stringify(fault),
          QCV_FAULT_LOG: logFile,
        };
        if (fault.type === 'user-swap' && 'env' in fault.params) Object.assign(env, fault.params.env);
        const faultRun = await session.run(
          ['test', '--retries=0', '--workers=1', '--reporter=json', `--output=test-results-fault-${index}`],
          env,
        );
        const parsedFault = parseBaseline(faultRun.stdout, faultRun.stderr, faultRun.exitCode, session.workspaceDir);
        if (!parsedFault.ok) {
          const detail = parsedFault.loadError ?? `Playwright exited ${faultRun.exitCode} and produced no report.`;
          throw new ToolError(`Fault ${fault.id} failed. ${detail}`);
        }
        noteFault(
          projectDir,
          session.workspaceDir,
          inventory.tests,
          siblings,
          fault,
          parsed,
          parsedFault,
          logFile,
          cells,
          counts,
          quietBroke,
          missingOwners,
          statusReasons,
        );
      }
      if (inventoryMissesBaseline(parsed, inventory.tests, projectDir, siblings)) {
        locationDrift = true;
        console.error(LOCATION_DRIFT_LINE);
        for (const fault of faults) quietBroke.add(fault.id);
        for (const test of inventory.tests) {
          const ownerId = ownerForTest(test);
          const list = cells.get(ownerId) ?? [];
          for (const cell of list) {
            if (!cell.reason) cell.reason = LOCATION_DRIFT_REASON;
          }
          if (!statusReasons.has(ownerId)) statusReasons.set(ownerId, LOCATION_DRIFT_REASON);
        }
      }
      noteUnevaluated(parsed, inventory.tests, projectDir, siblings, cells, statusReasons);
      return baseline;
    },
  );
  if (!baselineRun || !baselineSummary) throw new ToolError('Baseline Playwright run did not start.');
  const baseline = baselineSummary;
  const classified = inventory.tests.map((test) => {
    const ownerId = ownerForTest(test);
    const row: ClassifiedTest = {
      test,
      ownerId,
      baseline: outcomeFor(baseline, projectDir, test, siblings),
      cells: cells.get(ownerId) ?? [],
      counts: counts.get(ownerId) ?? new Map(),
    };
    return row;
  });
  const findings = classifyFindings(projectDir, faults, classified);
  const faultLines = summaryLines(faults, classified, quietBroke);
  for (const line of faultLines) console.error(line);
  const durationMs = Date.now() - wallStart;
  console.error(`Fault time: ${durationMs} ms.`);
  const locatorUpgrade = findings.some((finding) => finding.ruleId === 'QCV-L002');
  const checksRun = locatorUpgrade ? ['cannot-fail', 'locator'] : ['cannot-fail'];
  const faultCells = new Map<string, FaultCell[]>();
  for (const row of classified) faultCells.set(row.ownerId, row.cells);
  const report = buildReport({
    projectDir,
    configFile: inventory.configFile,
    specCount: inventory.specCount,
    tests: inventory.tests,
    skippedDescribes: inventory.skippedDescribes,
    findings,
    checksRun,
    startedAt,
    finishedAt: now(),
    baselineRed: idsFor(classified, 'fail'),
    notRun: unionIds(idsFor(classified, 'not-run', 'skipped'), missingOwners),
    statusReasons,
    faultCells,
    faultRun: { faults: faults.map((fault) => ({ id: fault.id, type: fault.type })) },
  });
  return {
    report,
    findings,
    runRoot: run.runRoot,
    kept: run.kept,
    skippedLinks: run.skippedLinks,
    baseline: baselineSummary,
    durationMs,
    faultLines,
    unmatchedBaseline: inventory.tests.length === 0 && baselineRan(baseline),
    locationDrift,
  };
}

/** True when the baseline ran tests and no inventoried test shares one of those locations. */
export function inventoryMissesBaseline(
  baseline: BaselineSummary,
  tests: readonly InventoryTest[],
  projectDir: string,
  siblings: Map<string, number>,
): boolean {
  if (!baselineRan(baseline) || tests.length === 0) return false;
  return tests.every((test) => outcomeFor(baseline, projectDir, test, siblings) === 'not-run');
}

function warnUnmatchedPatterns(faults: readonly Fault[], tests: readonly InventoryTest[]): void {
  for (const fault of faults) {
    for (const pattern of fault.expectedToBreak) {
      const matched = tests.some((test) => titleMatches(pattern, test.titlePath));
      if (!matched) {
        console.error(`Fault ${fault.id} expectedToBreak pattern "${pattern}" matched no test.`);
      }
    }
  }
}

function noteUnevaluated(
  baseline: BaselineSummary,
  tests: readonly InventoryTest[],
  projectDir: string,
  siblings: Map<string, number>,
  cells: Map<string, FaultCell[]>,
  statusReasons: Map<string, string>,
): void {
  for (const test of tests) {
    if (outcomeFor(baseline, projectDir, test, siblings) !== 'pass') continue;
    const ownerId = ownerForTest(test);
    const list = cells.get(ownerId) ?? [];
    if (list.length === 0 || !list.every((cell) => cell.result === 'not-run')) continue;
    if (!statusReasons.has(ownerId)) statusReasons.set(ownerId, UNEVALUATED_REASON);
  }
}

function baselineRan(summary: BaselineSummary): boolean {
  return summary.passed + summary.failed + summary.skipped > 0;
}

function unionIds(left: Set<string>, right: Set<string>): Set<string> {
  const ids = new Set(left);
  for (const id of right) ids.add(id);
  return ids;
}

/** How many baseline locations are absent from the fault run. */
export function faultRunGap(baseline: BaselineSummary, fault: BaselineSummary): number {
  const baseKeys = baseline.seenKeys;
  if (!baseKeys || baseKeys.size === 0) return 0;
  const faultKeys = fault.seenKeys;
  if (!faultKeys) return baseKeys.size;
  let missing = 0;
  for (const key of baseKeys) {
    if (!faultKeys.has(key)) missing += 1;
  }
  return missing;
}

function noteFault(
  projectDir: string,
  workspaceDir: string,
  tests: readonly InventoryTest[],
  siblings: Map<string, number>,
  fault: Fault,
  baseline: BaselineSummary,
  summary: BaselineSummary,
  logFile: string,
  cells: Map<string, FaultCell[]>,
  counts: Map<string, Map<string, Record<string, number>>>,
  quietBroke: Set<string>,
  missingOwners: Set<string>,
  statusReasons: Map<string, string>,
): void {
  const logged = readCountLog(workspaceDir, logFile);
  const gap = faultRunGap(baseline, summary);
  const baselineHadTests = baselineRan(baseline);
  if (gap > 0 || (tests.length === 0 && baselineHadTests)) {
    quietBroke.add(fault.id);
    console.error(`Fault ${fault.id} did not include every test from the baseline. Missing tests are not-run.`);
  }
  for (const test of tests) {
    const ownerId = ownerForTest(test);
    const list = cells.get(ownerId) ?? [];
    const recorded = matchLog(workspaceDir, projectDir, test, siblings, logged);
    const baselineOutcome = outcomeFor(baseline, projectDir, test, siblings);
    const outcome = outcomeFor(summary, projectDir, test, siblings);
    if (baselineOutcome !== 'not-run' && outcome === 'not-run') {
      list.push({ id: fault.id, result: 'not-run', reason: FAULT_NOT_FOUND_REASON });
      missingOwners.add(ownerId);
      statusReasons.set(ownerId, FAULT_NOT_FOUND_REASON);
      quietBroke.add(fault.id);
    } else {
      const failReason = outcome === 'fail' ? failReasonFor(summary, projectDir, test, siblings) : undefined;
      list.push(cellFor(fault, outcome, recorded, failReason));
    }
    cells.set(ownerId, list);
    if (recorded && Object.keys(recorded.counts).length > 0 && outcome !== 'not-run') {
      const byFault = counts.get(ownerId) ?? new Map();
      byFault.set(fault.id, recorded.counts);
      counts.set(ownerId, byFault);
    }
  }
}

function cellFor(
  fault: Fault,
  outcome: FaultResultName,
  log: CountLog | undefined,
  failReason: string | undefined,
): FaultCell {
  if (outcome === 'fail') return { id: fault.id, result: 'fail', reason: failReason ?? FAIL_CELL_REASON };
  if (outcome === 'skipped' || outcome === 'not-run' || fault.type === 'user-swap') {
    return { id: fault.id, result: outcome };
  }
  if (!faultReached(fault.type, log)) {
    return { id: fault.id, result: 'not-run', reason: FAULT_NOT_APPLIED_REASON };
  }
  if (fault.type === 'blank-app' && log && log.blankMisses > 0 && outcome === 'pass') {
    return { id: fault.id, result: 'not-run', reason: BLANK_NOT_PRESENT_REASON };
  }
  return { id: fault.id, result: outcome };
}

function faultReached(type: FaultType, log: CountLog | undefined): boolean {
  if (!log) return false;
  if (type === 'block-request') return log.armedContexts > 0 || log.armedPages > 0;
  return log.armedPages > 0;
}

interface CountLog {
  file: string;
  line: number;
  column: number;
  counts: Record<string, number>;
  armedPages: number;
  armedContexts: number;
  blankMisses: number;
}

function readCountLog(workspaceDir: string, logFile: string): CountLog[] {
  if (!fs.existsSync(logFile)) return [];
  const rows: CountLog[] = [];
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as {
      file?: unknown;
      line?: unknown;
      column?: unknown;
      counts?: unknown;
      armedPages?: unknown;
      armedContexts?: unknown;
      blankMisses?: unknown;
    };
    if (typeof record.file !== 'string' || typeof record.line !== 'number') continue;
    const counts: Record<string, number> = {};
    if (typeof record.counts === 'object' && record.counts !== null) {
      for (const [key, value] of Object.entries(record.counts)) {
        if (typeof value === 'number') counts[key] = value;
      }
    }
    const relative = path.relative(workspaceDir, record.file).split(path.sep).join('/');
    rows.push({
      file: relative,
      line: record.line,
      column: typeof record.column === 'number' ? record.column : 0,
      counts,
      armedPages: typeof record.armedPages === 'number' ? record.armedPages : 0,
      armedContexts: typeof record.armedContexts === 'number' ? record.armedContexts : 0,
      blankMisses: typeof record.blankMisses === 'number' ? record.blankMisses : 0,
    });
  }
  return rows;
}

function matchLog(
  workspaceDir: string,
  projectDir: string,
  test: InventoryTest,
  siblings: Map<string, number>,
  rows: readonly CountLog[],
): CountLog | undefined {
  void workspaceDir;
  const file = path.relative(projectDir, test.file).split(path.sep).join('/');
  const onLine = rows.filter((row) => row.file === file && row.line === test.line);
  if (onLine.length === 0) return undefined;
  const count = siblings.get(`${file}:${test.line}`) ?? 1;
  if (count <= 1) return onLine[0];
  const columns = columnsFor(test);
  return onLine.find((row) => columns.includes(row.column)) ?? onLine[0];
}

function summaryLines(faults: readonly Fault[], rows: readonly ClassifiedTest[], quietBroke: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  for (const fault of faults) {
    const tally = { pass: 0, fail: 0, skipped: 0, 'not-run': 0 };
    let brokeGreen = 0;
    for (const row of rows) {
      const cell = row.cells.find((entry) => entry.id === fault.id);
      if (!cell) continue;
      tally[cell.result] += 1;
      if (row.baseline === 'pass' && cell.result === 'fail') brokeGreen += 1;
    }
    lines.push(
      `Fault ${fault.id}: ${tally.fail} fail, ${tally.pass} pass, ${tally.skipped} skipped, ${tally['not-run']} not-run.`,
    );
    if (brokeGreen === 0 && !quietBroke.has(fault.id)) {
      lines.push(`Fault ${fault.id} broke no test that passed the baseline.`);
    }
  }
  return lines;
}

function idsFor(rows: readonly ClassifiedTest[], ...kinds: FaultResultName[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (kinds.includes(row.baseline)) ids.add(row.ownerId);
  }
  return ids;
}

function outcomeFor(
  summary: BaselineSummary,
  projectDir: string,
  test: InventoryTest,
  siblings: Map<string, number>,
): FaultResultName {
  const file = path.relative(projectDir, test.file).split(path.sep).join('/');
  const columns = columnsFor(test);
  const count = siblings.get(`${file}:${test.line}`) ?? 1;
  if (hits(summary.failedKeys, file, test.line, columns, count)) return 'fail';
  if (summary.skippedKeys && hits(summary.skippedKeys, file, test.line, columns, count)) return 'skipped';
  if (!summary.seenKeys || hits(summary.seenKeys, file, test.line, columns, count)) return 'pass';
  return 'not-run';
}

function failReasonFor(
  summary: BaselineSummary,
  projectDir: string,
  test: InventoryTest,
  siblings: Map<string, number>,
): string | undefined {
  const reasons = summary.failReasons;
  if (!reasons || reasons.size === 0) return undefined;
  const file = path.relative(projectDir, test.file).split(path.sep).join('/');
  const columns = columnsFor(test);
  const count = siblings.get(`${file}:${test.line}`) ?? 1;
  const prefix = `${file}:${test.line}:`;
  for (const column of columns) {
    const hit = reasons.get(`${prefix}${column}`);
    if (hit) return hit;
  }
  if (count > 1) return undefined;
  for (const [key, value] of reasons) {
    if (key.startsWith(prefix)) return value;
  }
  return undefined;
}

function hits(keys: Set<string>, file: string, line: number, columns: readonly number[], siblings: number): boolean {
  const lineKey = `${file}:${line}`;
  if (siblings <= 1 && keys.has(lineKey)) return true;
  const prefix = `${lineKey}:`;
  let seen = 0;
  let columnHit = false;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    seen += 1;
    const column = Number(key.slice(prefix.length));
    if (columns.includes(column)) columnHit = true;
  }
  if (seen === 0) return false;
  if (siblings <= 1) return true;
  return columnHit;
}

function siblingCounts(projectDir: string, tests: readonly InventoryTest[]): Map<string, number> {
  const siblings = new Map<string, number>();
  for (const test of tests) {
    const key = `${path.relative(projectDir, test.file).split(path.sep).join('/')}:${test.line}`;
    siblings.set(key, (siblings.get(key) ?? 0) + 1);
  }
  return siblings;
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
