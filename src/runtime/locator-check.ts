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
import { groupRecords, matchInventory, ownerFor, summaryFor } from '../rules/locator-status.js';
import { ToolError } from '../tool-error.js';
import { baselineKey, parseBaseline, type BaselineSummary } from './baseline.js';
import { buildEvidence, type EvidenceFile, type RawEvidencePart } from './locator-evidence/evidence.js';
import { evidenceWriteErrors, installFixture, readEvidenceErrors, readParts, writeEvidenceFile } from './locator-evidence/injected-fixture.js';
import { readPlaywrightVersion, resolveNodeModules, runPlaywrightInWorkspace, type PlaywrightRun } from './workspace.js';

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
  now?: () => Date;
}): Promise<LocatorCheckRun> {
  const projectDir = path.resolve(options.projectDir);
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const version = readPlaywrightVersion(resolveNodeModules(projectDir));
  const partsHolder: { parts: RawEvidencePart[]; errors: string[] } = { parts: [], errors: [] };
  let baselineRun: PlaywrightRun | undefined;
  const run = await runPlaywrightInWorkspace(projectDir, {
    keep: options.keepWorkspace,
    configFile: options.configFile,
    playwrightArgs: ['test', '--retries=0', '--reporter=json', '--output=test-results-baseline'],
    after: (_workspaceDir, playwright) => {
      baselineRun = playwright;
      const parsed = parseBaseline(playwright.stdout, playwright.stderr, playwright.exitCode);
      if (!parsed.ok) throw new BaselineStartError(playwright);
    },
    second: {
      env: { QCV_EVIDENCE_DIR: PARTS_DIR },
      playwrightArgs: ['test', '--retries=0', '--reporter=line', '--output=test-results'],
      prepare: (workspaceDir) => {
        installFixture(workspaceDir, options.configFile);
      },
      after: (workspaceDir) => {
        const partsDir = path.join(workspaceDir, PARTS_DIR);
        partsHolder.parts = readParts(partsDir);
        partsHolder.errors = readEvidenceErrors(partsDir);
      },
    },
  });
  if (!baselineRun) throw new ToolError('Baseline Playwright run did not start.');
  const logged = evidenceWriteErrors(partsHolder.errors, run.playwright.stderr);
  if (logged.length > 0) {
    throw new ToolError(`Locator evidence write failed: ${logged.join('; ')}`);
  }
  const baseline = parseBaseline(baselineRun.stdout, baselineRun.stderr, baselineRun.exitCode);
  const evidence = buildEvidence({
    parts: partsHolder.parts,
    workspaceDir: run.workspaceDir,
    projectDir,
    tool: readToolIdentity(),
    playwrightVersion: version,
    playwrightExitCode: run.playwright.exitCode,
  });
  const evidencePath = writeEvidenceFile(evidence, options.outDir);
  const inventory = readInventory(projectDir);
  const { findings, baselineRed, summaries } = evaluateLocatorCheck(projectDir, inventory.tests, evidence, baseline);
  const report = buildReport({
    projectDir,
    configFile: findPlaywrightConfig(projectDir),
    specCount: inventory.specCount,
    tests: inventory.tests,
    skippedDescribes: inventory.skippedDescribes,
    findings,
    checksRun: ['locator'],
    startedAt,
    finishedAt: now(),
    baselineRed,
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

function readInventory(projectDir: string): {
  specCount: number;
  tests: InventoryTest[];
  skippedDescribes: SkippedDescribe[];
} {
  const config = loadVerifyConfig(projectDir);
  const discovery = discoverSpecs(projectDir, []);
  const tests: InventoryTest[] = [];
  const skippedDescribes: SkippedDescribe[] = [];
  for (const file of discovery.files) {
    const inventory = parseSpecFile(file, config);
    tests.push(...inventory.tests);
    skippedDescribes.push(...inventory.skippedDescribes);
  }
  return { specCount: discovery.files.length, tests, skippedDescribes };
}

export function evaluateLocatorCheck(
  projectDir: string,
  tests: readonly InventoryTest[],
  evidence: EvidenceFile,
  baseline: BaselineSummary,
): { findings: Finding[]; baselineRed: Set<string>; summaries: Map<string, ReportLocator[]> } {
  const baselineRed = new Set<string>();
  const live: InventoryTest[] = [];
  for (const test of tests) {
    const relative = path.relative(projectDir, test.file).split(path.sep).join('/');
    if (baseline.failedKeys.has(baselineKey(relative, test.line))) {
      baselineRed.add(ownerIdFor('test', test.file, test.line, test.column, test.titlePath));
    } else live.push(test);
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
    const test = matchInventory(live, projectDir, group);
    if (!test) continue;
    const id = ownerFor(test);
    const list = summaries.get(id) ?? [];
    list.push(summaryFor(group));
    summaries.set(id, list);
  }
  return { findings, baselineRed, summaries };
}
