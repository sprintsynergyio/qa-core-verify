#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadVerifyConfig } from './config.js';
import { exitCodeFor, isSeverity } from './exit-code.js';
import { discoverSpecs, findPlaywrightConfig } from './inventory/discover.js';
import { parseSpecFile, type InventoryTest, type SkippedDescribe } from './inventory/parse.js';
import { toDisplayPath } from './report/console.js';
import { buildReport } from './report/model.js';
import { consoleText, parseFormats, reportJson, writeReportFiles, type ReportFormat } from './report/write.js';
import { CHECKS_RUN, collectFindings } from './rules/index.js';
import type { Severity } from './rules/types.js';
import { ToolError } from './tool-error.js';

export const HELP = `qa-core-verify <project-dir> [spec globs...] [--json] [--format console,json,md,html] [--out <dir>] [--fail-on error|warn|info]

Audit a Playwright suite for weak assertions (QCV-W000 through QCV-W010).

Options:
  --json              Print the JSON report to stdout and nothing else to stdout.
  --format <list>     Comma-separated outputs: console, json, md, html.
                      The default is console,json,md,html.
  --out <dir>         Directory for report.json, report.md, and report.html.
                      The default is <project>/.qa-core/verify.
  --fail-on <level>   Exit with code 1 when a finding is at or above this level.
                      Levels are error (default), warn, and info.
  -h, --help          Show this help.

Exit codes:
  0  No findings at or above --fail-on.
  1  Findings at or above --fail-on.
  2  Tool error, such as a bad path or a parse failure.
`;

interface CliOptions {
  help: boolean;
  json: boolean;
  formats: ReportFormat[];
  outDir: string | undefined;
  failOn: Severity;
  projectDir: string | undefined;
  specArgs: string[];
}

export function run(argv: readonly string[], cwd = process.cwd()): number {
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
  if (!options.projectDir) {
    console.error('Missing project directory.');
    console.error(HELP);
    return 2;
  }

  const startedAt = new Date();
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
      cwd,
      projectDir,
      configFile,
      specCount: discovery.files.length,
      tests,
      skippedDescribes,
      findings,
      checksRun: CHECKS_RUN,
      startedAt,
      finishedAt: new Date(),
    });
    const outDir = options.outDir ? path.resolve(cwd, options.outDir) : path.join(projectDir, '.qa-core', 'verify');
    const written = writeReportFiles(report, outDir, options.formats).map((file) => toDisplayPath(file, cwd));

    console.error(discovery.method);
    if (emptyNotice) console.error(emptyNotice);
    if (options.json) {
      process.stdout.write(reportJson(report));
    } else if (options.formats.includes('console')) {
      process.stdout.write(`${consoleText(report, written)}\n`);
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
  let values: { help?: boolean; json?: boolean; format?: string; out?: string; 'fail-on'?: string };
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
    outDir: values.out,
    failOn: requested,
    projectDir,
    specArgs: positionals.slice(1),
  };
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
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
