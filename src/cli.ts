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
import { consoleReportPaths, displayText } from './report/paths.js';
import { consoleText, parseFormats, reportJson, writeReportFiles, type ReportFormat } from './report/write.js';
import { collectLocatorEvidence } from './runtime/locator-evidence/injected-fixture.js';
import { CHECKS_RUN, collectFindings } from './rules/index.js';
import type { Severity } from './rules/types.js';
import { ToolError } from './tool-error.js';

export const HELP = `qa-core-verify <project-dir> [spec globs...] [--json] [--format console,json,md,html] [--out <dir>] [--fail-on error|warn|info] [--only locator-evidence] [--keep-workspace]

Audit a Playwright suite for weak assertions (QCV-W000 through QCV-W010).

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
  --fail-on <level>   Exit with code 1 when a finding is at or above this level.
                      Levels are error (default), warn, and info.
                      Not accepted with --only locator-evidence.
  --only <name>       Run one check instead of the static audit. The name is locator-evidence.
                      That check runs Playwright in a temp copy and writes locator-evidence.json.
  --keep-workspace    Keep the temp copy. Requires --only locator-evidence.
  -h, --help          Show this help.

Exit codes:
  0  No findings at or above --fail-on. For locator-evidence, Playwright exited 0.
  1  Findings at or above --fail-on. For locator-evidence, Playwright exited 1.
     The evidence file is still written.
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
  if (options.keepWorkspace && options.only !== 'locator-evidence') {
    console.error('--keep-workspace requires --only locator-evidence.');
    return 2;
  }
  if (options.only !== undefined && options.only !== 'locator-evidence') {
    console.error(`Unknown --only check "${options.only}". Use locator-evidence.`);
    return 2;
  }
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
    });
    const shown = consoleReportPaths([result.evidencePath], projectDir, options.outDir, cwd);
    const evidenceLine = displayText(shown[0] ?? result.evidencePath);
    process.stdout.write(
      `Locator evidence: ${evidenceLine}\nPlaywright exit: ${result.evidence.playwrightExitCode}\nRecords: ${result.evidence.records.length}\n`,
    );
    if (options.keepWorkspace) process.stdout.write(`Workspace: ${result.workspaceDir}\n`);
    const code = result.evidence.playwrightExitCode;
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

function outputTail(text: string): string {
  return text.trim().split('\n').slice(-20).join('\n').slice(-2000);
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
