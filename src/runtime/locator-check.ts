import path from 'node:path';
import { loadVerifyConfig } from '../config.js';
import { discoverSpecs, findPlaywrightConfig } from '../inventory/discover.js';
import { parseSpecFile, type InventoryTest, type SkippedDescribe } from '../inventory/parse.js';
import { buildReport, type Report, type ReportLocator } from '../report/model.js';
import { readToolIdentity } from '../report/model.js';
import { ownerIdFor, type Finding } from '../rules/types.js';
import { findAmbiguous } from '../rules/l003-ambiguous.js';
import { findAbsenceOnUnseen } from '../rules/l002-absence-on-unseen.js';
import { findBrittleStyle } from '../rules/l004-brittle-style.js';
import { findNeverMatched } from '../rules/l001-never-matched.js';
import { columnsFor, groupRecords, matchInventory, ownerFor, summaryFor } from '../rules/locator-status.js';
import { ToolError } from '../tool-error.js';
import { baselineKey, parseBaseline, type BaselineSummary } from './baseline.js';
import { buildEvidence, type EvidenceFile, type RawEvidencePart } from './locator-evidence/evidence.js';
import { evidenceWriteErrors, installFixture, readEvidenceErrors, readParts, writeEvidenceFile } from './locator-evidence/injected-fixture.js';
import { configInsideProject, readPlaywrightVersion, resolveNodeModules, runPlaywrightInWorkspace, type PlaywrightRun } from './workspace.js';

const PARTS_DIR = path.join('.qa-core', 'locator-parts');

/** Playwright started, but stdout was not a JSON report. The evidence run is skipped. */
export class BaselineStartError extends Error {
  constructor(readonly run: PlaywrightRun) {
    super('Playwright produced no baseline report.');
  }
}

export interface LocatorCheckRun {
  report: Report;
  findings: Finding[];
  evidence: EvidenceFile;
  evidencePath: string;
  runRoot: string;
  kept: boolean;
  skippedLinks: string[];
  baseline: BaselineSummary;
  evidenceExitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Baseline Playwright run, then a locator-evidence run in the same temp copy.
 * Tests that fail the baseline are `baseline-red` and get no locator findings.
 * The original project is not modified.
 */
export async function collectLocatorCheck(options: {
  projectDir: string;
  outDir: string;
  keepWorkspace: boolean;
  configFile?: string;
  /** Playwright resolves `--config` from this directory. Defaults to `process.cwd()`. */
  cwd?: string;
  now?: () => Date;
}): Promise<LocatorCheckRun> {
  const projectDir = path.resolve(options.projectDir);
  const cwd = options.cwd ?? process.cwd();
  const configFile = options.configFile ? configInsideProject(options.configFile, projectDir, cwd) : undefined;
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const version = readPlaywrightVersion(resolveNodeModules(projectDir));
  const partsHolder: { parts: RawEvidencePart[]; errors: string[] } = { parts: [], errors: [] };
  let baselineRun: PlaywrightRun | undefined;
  let baselineSummary: BaselineSummary | undefined;
  const run = await runPlaywrightInWorkspace(projectDir, {
    keep: options.keepWorkspace,
    configFile,
    playwrightArgs: ['test', '--retries=0', '--reporter=json', '--output=test-results-baseline'],
    after: (workspaceDir, playwright) => {
      baselineRun = playwright;
      const parsed = parseBaseline(playwright.stdout, playwright.stderr, playwright.exitCode, workspaceDir);
      if (!parsed.ok) throw new BaselineStartError(playwright);
      baselineSummary = parsed;
    },
    second: {
      env: { QCV_EVIDENCE_DIR: PARTS_DIR },
      playwrightArgs: ['test', '--retries=0', '--reporter=line', '--output=test-results'],
      prepare: (workspaceDir) => {
        installFixture(workspaceDir, configFile);
      },
      after: (workspaceDir) => {
        const partsDir = path.join(workspaceDir, PARTS_DIR);
        partsHolder.parts = readParts(partsDir);
        partsHolder.errors = readEvidenceErrors(partsDir);
      },
    },
  });
  if (!baselineRun || !baselineSummary) throw new ToolError('Baseline Playwright run did not start.');
  const logged = evidenceWriteErrors(partsHolder.errors, run.playwright.stderr);
  if (logged.length > 0) {
    throw new ToolError(`Locator evidence write failed: ${logged.join('; ')}`);
  }
  const baseline = baselineSummary;
  const evidence = buildEvidence({
    parts: partsHolder.parts,
    workspaceDir: run.workspaceDir,
    projectDir,
    tool: readToolIdentity(),
    playwrightVersion: version,
    playwrightExitCode: run.playwright.exitCode,
  });
  const evidencePath = writeEvidenceFile(evidence, options.outDir);
  const inventory = readInventory(projectDir, configFile);
  const { findings, baselineRed, notRun, summaries } = evaluateLocatorCheck(projectDir, inventory.tests, evidence, baseline);
  const report = buildReport({
    projectDir,
    configFile: inventory.configFile,
    specCount: inventory.specCount,
    tests: inventory.tests,
    skippedDescribes: inventory.skippedDescribes,
    findings,
    checksRun: ['locator'],
    startedAt,
    finishedAt: now(),
    baselineRed,
    notRun,
    locatorSummaries: summaries,
  });
  return {
    report,
    findings,
    evidence,
    evidencePath,
    runRoot: run.runRoot,
    kept: run.kept,
    skippedLinks: run.skippedLinks,
    baseline,
    evidenceExitCode: run.playwright.exitCode,
    stdout: `${baselineRun.stdout}\n${run.playwright.stdout}`,
    stderr: `${baselineRun.stderr}\n${run.playwright.stderr}`,
  };
}

function readInventory(projectDir: string, configFile?: string): {
  specCount: number;
  tests: InventoryTest[];
  skippedDescribes: SkippedDescribe[];
  configFile: string | undefined;
} {
  const config = loadVerifyConfig(projectDir);
  const absoluteConfig = configFile ? path.resolve(projectDir, configFile) : undefined;
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
  };
}

export function evaluateLocatorCheck(
  projectDir: string,
  tests: readonly InventoryTest[],
  evidence: EvidenceFile,
  baseline: BaselineSummary,
): { findings: Finding[]; baselineRed: Set<string>; notRun: Set<string>; summaries: Map<string, ReportLocator[]> } {
  const baselineRed = new Set<string>();
  const notRun = new Set<string>();
  const live: InventoryTest[] = [];
  const siblings = new Map<string, number>();
  for (const test of tests) {
    const relative = path.relative(projectDir, test.file).split(path.sep).join('/');
    const key = `${relative}:${test.line}`;
    siblings.set(key, (siblings.get(key) ?? 0) + 1);
  }
  for (const test of tests) {
    const relative = path.relative(projectDir, test.file).split(path.sep).join('/');
    const id = ownerIdFor('test', test.file, test.line, test.column, test.titlePath);
    const columns = columnsFor(test);
    const siblingsOnLine = siblings.get(`${relative}:${test.line}`) ?? 1;
    if (keyHits(baseline.failedKeys, relative, test.line, columns, siblingsOnLine)) {
      baselineRed.add(id);
    } else if (baselineSkipped(baseline, relative, test.line, columns, siblingsOnLine)) {
      notRun.add(id);
    } else if (!baselineSaw(baseline, relative, test.line, columns, siblingsOnLine)) {
      notRun.add(id);
    } else live.push(test);
  }
  if (evidence.records.length === 0 && evidence.playwrightExitCode !== 0) {
    live.length = 0;
    for (const test of tests) {
      const id = ownerIdFor('test', test.file, test.line, test.column, test.titlePath);
      if (!baselineRed.has(id)) notRun.add(id);
    }
  }
  const groups = groupRecords(evidence.records);
  const findings = [
    ...findNeverMatched(live, groups, projectDir),
    ...findAbsenceOnUnseen(live, groups, projectDir),
    ...findAmbiguous(live, groups, projectDir),
    ...findBrittleStyle(live),
  ].sort((left, right) => {
    const byFile = left.file.localeCompare(right.file);
    if (byFile !== 0) return byFile;
    if (left.line !== right.line) return left.line - right.line;
    if (left.column !== right.column) return left.column - right.column;
    return left.ruleId.localeCompare(right.ruleId);
  });
  const summaries = new Map<string, ReportLocator[]>();
  for (const group of groups) {
    for (const test of matchInventory(live, projectDir, group)) {
      const id = ownerFor(test);
      const list = summaries.get(id) ?? [];
      list.push(summaryFor(group));
      summaries.set(id, list);
    }
  }
  alignBrittleCallSites(projectDir, findings, summaries);
  return { findings, baselineRed, notRun, summaries };
}

/**
 * QCV-L004 is reported on the `expect(` call. The evidence stack points at the matcher.
 * When both describe the same locator, the summary uses the finding's call site.
 */
function alignBrittleCallSites(projectDir: string, findings: readonly Finding[], summaries: Map<string, ReportLocator[]>): void {
  for (const finding of findings) {
    if (finding.ruleId !== 'QCV-L004') continue;
    const list = summaries.get(finding.ownerId);
    if (!list) continue;
    const file = path.relative(projectDir, finding.file).split(path.sep).join('/');
    for (const locator of list) {
      if (locator.file !== file) continue;
      const same =
        (locator.selector.length > 0 && finding.evidence.includes(locator.selector)) ||
        (locator.api.length > 0 && finding.evidence.includes(locator.api));
      if (!same) continue;
      locator.line = finding.line;
      locator.column = finding.column;
    }
  }
}

/** A test ran when the baseline report contains it. One row on a line accepts any column from that line. */
function baselineSaw(
  baseline: BaselineSummary,
  file: string,
  line: number,
  columns: readonly number[],
  siblings: number,
): boolean {
  if (!baseline.seenKeys) return true;
  return keyHits(baseline.seenKeys, file, line, columns, siblings);
}

/** A runtime skip or fixme, including a serial test that did not run. Missing keys mean the fixture did not record skips. */
function baselineSkipped(
  baseline: BaselineSummary,
  file: string,
  line: number,
  columns: readonly number[],
  siblings: number,
): boolean {
  if (!baseline.skippedKeys) return false;
  return keyHits(baseline.skippedKeys, file, line, columns, siblings);
}

function keyHits(
  keys: Set<string>,
  file: string,
  line: number,
  columns: readonly number[],
  siblings: number,
): boolean {
  const lineKey = baselineKey(file, line);
  if (siblings <= 1 && keys.has(lineKey)) return true;
  const prefix = `${lineKey}:`;
  let hits = 0;
  let columnHit = false;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    hits += 1;
    const column = Number(key.slice(prefix.length));
    if (columns.includes(column)) columnHit = true;
  }
  if (hits === 0) return false;
  if (siblings <= 1) return true;
  return columnHit;
}
