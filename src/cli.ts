#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadVerifyConfig } from './config.js';
import { exitCodeFor, isSeverity } from './exit-code.js';
import { discoverSpecs, findPlaywrightConfig } from './inventory/discover.js';
import { parseSpecFile, type InventoryTest, type SkippedDescribe } from './inventory/parse.js';
import { buildReport } from './report/model.js';
import { consoleReportPaths, escapeControls } from './report/paths.js';
import { consoleText, parseFormats, reportJson, writeReportFiles, type ReportFormat } from './report/write.js';
import { collectInversion } from './runtime/inversion/run.js';
import { collectFaults } from './runtime/faults/run.js';
import { BaselineStartError, collectLocatorCheck } from './runtime/locator-check.js';
import { collectLocatorEvidence } from './runtime/locator-evidence/injected-fixture.js';
import { keptRunRoot, remapCopyPath, workspaceLine } from './runtime/workspace.js';
import { CHECKS_RUN, collectFindings } from './rules/index.js';
import type { Severity } from './rules/types.js';
import { ToolError } from './tool-error.js';

export const HELP = `qa-core-verify <project-dir> [spec globs...] [--json] [--format console,json,md,html] [--out <dir>] [--fail-on error|warn|info] [--only locator|locator-evidence|inversion|faults] [--config <file>] [--max-runs <n>] [--keep-workspace]

Audit a Playwright suite for weak assertions (QCV-W000 through QCV-W010).
--only locator runs QCV-L001 through QCV-L004 against a temp copy of the suite.
--only inversion runs QCV-F001 by inverting one assertion at a time in a temp copy.
--only faults runs QCV-F002, QCV-F003, and QCV-F004 against a temp copy. blank-app always runs.

Options:
  --json              Print the JSON report to stdout and nothing else to stdout.
                      Not accepted with --only locator-evidence.
  --format <list>     Comma-separated outputs: console, json, md, html.
                      The default is console,json,md,html.
                      Not accepted with --only locator-evidence.
  --out <dir>         Directory for the report files, or for locator-evidence.json.
                      The default is <project>/.qa-core/verify.
                      Inside the project, the console prints paths relative to that folder.
                      Outside the project, the console prints the --out path as it was typed.
                      C0, DEL, C1, and bidi controls in that typed path are escaped as \\u plus four hex digits.
  --fail-on <level>   Exit with code 1 when a finding is at or above this level.
                      Levels are error (default), warn, and info.
                      Not accepted with --only locator-evidence.
  --only <name>       Run one check instead of the static audit.
                      locator runs the hallucinated locator check and writes the report.
                      locator-evidence runs Playwright in a temp copy and writes locator-evidence.json.
                      inversion runs QCV-F001 and writes the report.
                      Each inversion run is one assertion. The plan line is printed after the control runs.
                      Control runs are not part of the plan count and are not part of --max-runs.
                      faults runs QCV-F002, QCV-F003, and QCV-F004 and writes the report.
                      One fault runs at a time. The fault file is qa-core-verify.faults.json.
  --config <file>     Playwright config forwarded to the temp run and not rewritten.
                      A directory uses the playwright.config file inside that directory.
                      The project directory itself is accepted, including --config .
                      A directory that holds no playwright.config.* file is refused before the temp copy.
                      Playwright would run that directory with its defaults. This checker refuses it and exits 2.
                      A path that is not a config file is refused before the temp copy is made.
                      playwright.config.ts, .js, .mts, .mjs, .cts, and .cjs are never rewritten.
                      Requires --only locator, --only locator-evidence, --only inversion, or --only faults.
  --max-runs <n>      Stop inversion after n mutant runs. Requires --only inversion.
                      n is a whole number, zero or greater. Unchecked assertions are not-run.
                      stderr prints Stopped at limit when the cap is hit.
  --keep-workspace    Keep the temp run directory. Requires --only locator-evidence, --only locator, --only inversion, or --only faults.
                      stderr prints Workspace: and the absolute qcv-run directory.
                      That directory contains project, the copied tree.
                      The same line is printed after SIGINT, SIGTERM, and SIGHUP.
                      A backslash is doubled. C0, DEL, C1, and bidi controls are escaped as \\u plus four hex digits.
                      The path is not shortened with ~.
                      A tool error before the copy exists prints no Workspace line, because nothing is kept.
  -h, --help          Show this help.

Exit codes:
  0  No findings at or above --fail-on. For locator-evidence, Playwright exited 0.
  1  Findings at or above --fail-on. For locator-evidence, Playwright exited 1.
     The evidence file is still written. A broken config with no records prints the Playwright output tail.
  2  Tool error, such as a bad path, a parse failure, or a Playwright exit other than 0 or 1.
`;

interface CliOptions {
  help: boolean;
  json: boolean;
  formats: ReportFormat[];
  formatSet: boolean;
  outDir: string | undefined;
  failOn: Severity;
  failOnSet: boolean;
  only: string | undefined;
  configFile: string | undefined;
  maxRuns: number | undefined;
  keepWorkspace: boolean;
  projectDir: string | undefined;
  specArgs: string[];
}

/** `now` supplies `startedAt` and `finishedAt`. Tests pass a fixed clock. */
export function run(
  argv: readonly string[],
  cwd = process.cwd(),
  now: () => Date = () => new Date(),
): number | Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const runtimeMode =
    options.only === 'locator' ||
    options.only === 'locator-evidence' ||
    options.only === 'inversion' ||
    options.only === 'faults';
  if (options.keepWorkspace && !runtimeMode) {
    console.error('--keep-workspace requires --only locator-evidence, --only locator, --only inversion, or --only faults.');
    return 2;
  }
  if (options.configFile && !runtimeMode) {
    console.error('--config requires --only locator-evidence, --only locator, --only inversion, or --only faults.');
    return 2;
  }
  if (options.maxRuns !== undefined && options.only !== 'inversion') {
    console.error('--max-runs requires --only inversion.');
    return 2;
  }
  if (options.only !== undefined && !runtimeMode) {
    console.error(`Unknown --only check "${options.only}". Use locator, locator-evidence, inversion, or faults.`);
    return 2;
  }
  if (options.only === 'faults') return runFaults(options, cwd, now);
  if (options.only === 'inversion') return runInversion(options, cwd, now);
  if (options.only === 'locator') return runLocatorCheck(options, cwd, now);
  if (options.only === 'locator-evidence') return runLocatorEvidence(options, cwd);
  if (!options.projectDir) {
    console.error('Missing project directory.');
    console.error(HELP);
    return 2;
  }

  const startedAt = now();
  try {
    const projectDir = path.resolve(cwd, options.projectDir);
    if (!fs.existsSync(projectDir)) {
      throw new ToolError(`Path does not exist: ${options.projectDir}`);
    }
    if (!fs.statSync(projectDir).isDirectory()) {
      throw new ToolError(`Not a directory: ${options.projectDir}`);
    }

    const config = loadVerifyConfig(projectDir);
    const discovery = discoverSpecs(projectDir, options.specArgs, cwd);
    const tests: InventoryTest[] = [];
    const skippedDescribes: SkippedDescribe[] = [];
    for (const file of discovery.files) {
      const inventory = parseSpecFile(file, config);
      tests.push(...inventory.tests);
      skippedDescribes.push(...inventory.skippedDescribes);
    }
    const findings = collectFindings(tests, skippedDescribes);
    const emptyNotice = emptySuiteNotice(discovery.files.length, tests.length);
    const configFile = findPlaywrightConfig(projectDir);
    const report = buildReport({
      projectDir,
      configFile,
      specCount: discovery.files.length,
      tests,
      skippedDescribes,
      findings,
      checksRun: CHECKS_RUN,
      startedAt,
      finishedAt: now(),
    });
    const outDir = options.outDir ? path.resolve(cwd, options.outDir) : path.join(projectDir, '.qa-core', 'verify');
    const written = writeReportFiles(report, outDir, options.formats);
    const shown = consoleReportPaths(written, projectDir, options.outDir, cwd);

    console.error(discovery.method);
    if (emptyNotice) console.error(emptyNotice);
    if (options.json) {
      process.stdout.write(reportJson(report));
    } else if (options.formats.includes('console')) {
      process.stdout.write(`${consoleText(report, shown)}\n`);
    }
    return exitCodeFor(findings, options.failOn);
  } catch (error) {
    if (error instanceof ToolError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

function parseCli(argv: readonly string[]): CliOptions {
  let values: {
    help?: boolean;
    json?: boolean;
    format?: string;
    out?: string;
    'fail-on'?: string;
        only?: string;
    config?: string;
    'max-runs'?: string;
    'keep-workspace'?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        out: { type: 'string' },
        'fail-on': { type: 'string' },
        only: { type: 'string' },
        config: { type: 'string' },
        'max-runs': { type: 'string' },
        'keep-workspace': { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(message);
  }

  const requested = values['fail-on'] ?? 'error';
  if (!isSeverity(requested)) {
    throw new ToolError(`Unknown --fail-on level "${requested}". Use error, warn, or info.`);
  }
  const projectDir = positionals[0];
  return {
    help: values.help === true,
    json: values.json === true,
    formats: parseFormats(values.format),
    formatSet: values.format !== undefined,
    outDir: values.out,
    failOn: requested,
    failOnSet: values['fail-on'] !== undefined,
    only: values.only,
    configFile: values.config,
    maxRuns: parseMaxRuns(values['max-runs']),
    keepWorkspace: values['keep-workspace'] === true,
    projectDir,
    specArgs: positionals.slice(1),
  };
}

async function runLocatorEvidence(options: CliOptions, cwd: string): Promise<number> {
  if (options.json || options.formatSet || options.failOnSet) {
    console.error('--only locator-evidence does not support --json, --format, or --fail-on.');
    return 2;
  }
  if (!options.projectDir) {
    console.error('Missing project directory.');
    console.error(HELP);
    return 2;
  }
  if (options.specArgs.length > 0) {
    console.error('--only locator-evidence runs the whole Playwright project. Do not pass spec paths.');
    return 2;
  }
  try {
    const projectDir = path.resolve(cwd, options.projectDir);
    if (!fs.existsSync(projectDir)) throw new ToolError(`Path does not exist: ${options.projectDir}`);
    if (!fs.statSync(projectDir).isDirectory()) throw new ToolError(`Not a directory: ${options.projectDir}`);
    const outDir = options.outDir ? path.resolve(cwd, options.outDir) : path.join(projectDir, '.qa-core', 'verify');
    const result = await collectLocatorEvidence({
      projectDir,
      outDir,
      keepWorkspace: options.keepWorkspace,
      configFile: options.configFile,
      cwd,
    });
    for (const link of result.skippedLinks) console.error(`Skipped symlink ${link}.`);
    const shown = consoleReportPaths([result.evidencePath], projectDir, options.outDir, cwd);
    const evidenceLine = escapeControls(shown[0] ?? result.evidencePath);
    process.stdout.write(
      `Locator evidence: ${evidenceLine}\nPlaywright exit: ${result.evidence.playwrightExitCode}\nRecords: ${result.evidence.records.length}\n`,
    );
    if (options.keepWorkspace) fs.writeSync(2, workspaceLine(result.runRoot));
    const code = result.evidence.playwrightExitCode;
    if (code === 1 && result.evidence.records.length === 0) {
      console.error('Playwright produced no locator records.');
      const tail = outputTail(`${result.stderr}\n${result.stdout}`);
      if (tail) console.error(tail);
      return 1;
    }
    if (code === 0 || code === 1) return code;
    console.error(`Playwright exited ${code}.`);
    const tail = outputTail(result.stderr || result.stdout);
    if (tail) console.error(tail);
    return 2;
  } catch (error) {
    if (error instanceof ToolError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

async function runLocatorCheck(options: CliOptions, cwd: string, now: () => Date): Promise<number> {
  if (!options.projectDir) {
    console.error('Missing project directory.');
    console.error(HELP);
    return 2;
  }
  if (options.specArgs.length > 0) {
    console.error('--only locator runs the whole Playwright project. Do not pass spec paths.');
    return 2;
  }
  try {
    const projectDir = path.resolve(cwd, options.projectDir);
    if (!fs.existsSync(projectDir)) throw new ToolError(`Path does not exist: ${options.projectDir}`);
    if (!fs.statSync(projectDir).isDirectory()) throw new ToolError(`Not a directory: ${options.projectDir}`);
    const outDir = options.outDir ? path.resolve(cwd, options.outDir) : path.join(projectDir, '.qa-core', 'verify');
    const result = await collectLocatorCheck({
      projectDir,
      outDir,
      keepWorkspace: options.keepWorkspace,
      configFile: options.configFile,
      cwd,
      now,
    });
    for (const link of result.skippedLinks) console.error(`Skipped symlink ${link}.`);
    console.error(
      `Baseline: ${result.baseline.passed} passed, ${result.baseline.failed} failed, ${result.baseline.skipped} skipped.`,
    );
    const written = writeReportFiles(result.report, outDir, options.formats);
    const shown = consoleReportPaths([...written, result.evidencePath], projectDir, options.outDir, cwd);
    if (options.json) {
      process.stdout.write(reportJson(result.report));
    } else if (options.formats.includes('console')) {
      process.stdout.write(`${consoleText(result.report, shown)}\n`);
    }
    if (options.keepWorkspace) fs.writeSync(2, workspaceLine(result.runRoot));
    const code = exitCodeFor(result.findings, options.failOn);
    const copyPath = path.join(result.runRoot, 'project');
    if (result.evidenceExitCode !== 0 && result.evidenceExitCode !== 1) {
      console.error(`Playwright exited ${result.evidenceExitCode} during the evidence run.`);
      const tail = outputTail(remapCopyPath(result.stderr || result.stdout, copyPath, projectDir));
      if (tail) console.error(tail);
      return 2;
    }
    if (result.evidenceExitCode === 1 && result.baseline.failed === 0 && code === 0) {
      console.error('Playwright exited 1 during the evidence run after a green baseline.');
      const tail = outputTail(remapCopyPath(result.stderr || result.stdout, copyPath, projectDir));
      if (tail) console.error(tail);
      return 1;
    }
    return code;
  } catch (error) {
    noteKeptWorkspace(options.keepWorkspace, error);
    if (error instanceof BaselineStartError) return explainBaseline(error);
    if (error instanceof ToolError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

function parseMaxRuns(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new ToolError(`Unknown --max-runs value "${value}". Use a whole number, zero or greater.`);
  }
  return Number(value);
}

/**
 * The last 20 lines, plus the first error line when that line is not already in the tail.
 * A broken config can fill the tail with stack frames and hide the message.
 */
function outputTail(text: string): string {
  const lines = text.trim().split('\n');
  const tailLines = lines.slice(-20);
  const tail = tailLines.join('\n').slice(-2000);
  const firstError = lines.find((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('at ') || trimmed.startsWith('at\t')) return false;
    return /Error|error TS|SyntaxError|failed|Failed|Cannot|Unexpected/.test(trimmed);
  });
  if (!firstError || tailLines.some((line) => line.trim() === firstError)) return tail;
  return `${firstError}\n${tail}`.slice(-4000);
}

async function runInversion(options: CliOptions, cwd: string, now: () => Date): Promise<number> {
  if (!options.projectDir) {
    console.error('Missing project directory.');
    console.error(HELP);
    return 2;
  }
  if (options.specArgs.length > 0) {
    console.error('--only inversion runs the whole Playwright project. Do not pass spec paths.');
    return 2;
  }
  try {
    const projectDir = path.resolve(cwd, options.projectDir);
    if (!fs.existsSync(projectDir)) throw new ToolError(`Path does not exist: ${options.projectDir}`);
    if (!fs.statSync(projectDir).isDirectory()) throw new ToolError(`Not a directory: ${options.projectDir}`);
    const outDir = options.outDir ? path.resolve(cwd, options.outDir) : path.join(projectDir, '.qa-core', 'verify');
    const result = await collectInversion({
      projectDir,
      keepWorkspace: options.keepWorkspace,
      configFile: options.configFile,
      cwd,
      now,
      maxRuns: options.maxRuns,
    });
    const written = writeReportFiles(result.report, outDir, options.formats);
    const shown = consoleReportPaths(written, projectDir, options.outDir, cwd);
    if (options.json) {
      process.stdout.write(reportJson(result.report));
    } else if (options.formats.includes('console')) {
      process.stdout.write(`${consoleText(result.report, shown)}\n`);
    }
    if (options.keepWorkspace) fs.writeSync(2, workspaceLine(result.runRoot));
    return exitCodeFor(result.findings, options.failOn);
  } catch (error) {
    noteKeptWorkspace(options.keepWorkspace, error);
    if (error instanceof BaselineStartError) return explainBaseline(error);
    if (error instanceof ToolError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

async function runFaults(options: CliOptions, cwd: string, now: () => Date): Promise<number> {
  if (!options.projectDir) {
    console.error('Missing project directory.');
    console.error(HELP);
    return 2;
  }
  if (options.specArgs.length > 0) {
    console.error('--only faults runs the whole Playwright project. Do not pass spec paths.');
    return 2;
  }
  const projectDir = path.resolve(cwd, options.projectDir);
  try {
    if (!fs.existsSync(projectDir)) throw new ToolError(`Path does not exist: ${options.projectDir}`);
    if (!fs.statSync(projectDir).isDirectory()) throw new ToolError(`Not a directory: ${options.projectDir}`);
    const outDir = options.outDir ? path.resolve(cwd, options.outDir) : path.join(projectDir, '.qa-core', 'verify');
    const result = await collectFaults({
      projectDir,
      keepWorkspace: options.keepWorkspace,
      configFile: options.configFile,
      cwd,
      now,
    });
    const written = writeReportFiles(result.report, outDir, options.formats);
    const shown = consoleReportPaths(written, projectDir, options.outDir, cwd);
    if (options.json) {
      process.stdout.write(reportJson(result.report));
    } else if (options.formats.includes('console')) {
      process.stdout.write(`${consoleText(result.report, shown)}\n`);
    }
    if (options.keepWorkspace) fs.writeSync(2, workspaceLine(result.runRoot));
    return exitCodeFor(result.findings, options.failOn);
  } catch (error) {
    noteKeptWorkspace(options.keepWorkspace, error);
    if (error instanceof BaselineStartError) return explainBaseline(error);
    if (error instanceof ToolError) {
      const root = keptRunRoot(error);
      const message = root ? remapCopyPath(error.message, path.join(root, 'project'), projectDir) : error.message;
      console.error(message);
      return 2;
    }
    throw error;
  }
}

function noteKeptWorkspace(keep: boolean, error: unknown): void {
  if (!keep) return;
  const root = keptRunRoot(error);
  if (root) fs.writeSync(2, workspaceLine(root));
}

function explainBaseline(error: BaselineStartError): number {
  const text = remapCopyPath(`${error.run.stderr}\n${error.run.stdout}`, error.workspaceDir, error.projectDir);
  if (error.loadError) {
    console.error('Playwright failed to load the suite.');
    console.error(remapCopyPath(error.loadError, error.workspaceDir, error.projectDir));
    return 2;
  }
  console.error('Playwright produced no baseline report.');
  const detail = outputTail(text);
  if (detail) console.error(detail);
  return error.run.exitCode === 1 ? 1 : 2;
}

function emptySuiteNotice(specFileCount: number, testCount: number): string | undefined {
  if (specFileCount === 0) return 'No tests found. No spec files matched.';
  if (testCount === 0) return 'No tests found.';
  return undefined;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  try {
    const result = run(process.argv.slice(2));
    if (result instanceof Promise) {
      result.then(
        (code) => {
          process.exitCode = code;
        },
        (error: unknown) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 2;
        },
      );
    } else {
      process.exitCode = result;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
