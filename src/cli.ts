#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadVerifyConfig } from './config.js';
import { exitCodeFor, isSeverity } from './exit-code.js';
import { discoverSpecs } from './inventory/discover.js';
import { parseSpecFile, type InventoryTest } from './inventory/parse.js';
import { formatConsoleReport, toDisplayPath } from './report/console.js';
import { findTestsWithNoAssertion } from './rules/w001-no-assertion.js';
import type { Finding, Severity } from './rules/types.js';
import { ToolError } from './tool-error.js';

export const HELP = `qa-core-verify <project-dir> [spec globs...] [--json] [--fail-on error|warn|info]

Audit a Playwright suite and report tests with no assertion (QCV-W001).

Options:
  --json              Print the raw findings array as JSON. This format is unstable.
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
    for (const file of discovery.files) {
      tests.push(...parseSpecFile(file, config).tests);
    }
    const findings = findTestsWithNoAssertion(tests).map((finding) => displayFinding(finding, cwd));

    if (options.json) {
      console.error(discovery.method);
      console.log(JSON.stringify(findings, null, 2));
    } else {
      console.log(discovery.method);
      console.log(formatConsoleReport(findings, tests.length));
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
  let values: { help?: boolean; json?: boolean; 'fail-on'?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        json: { type: 'boolean', default: false },
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
    failOn: requested,
    projectDir,
    specArgs: positionals.slice(1),
  };
}

function displayFinding(finding: Finding, cwd: string): Finding {
  return { ...finding, file: toDisplayPath(finding.file, cwd) };
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
