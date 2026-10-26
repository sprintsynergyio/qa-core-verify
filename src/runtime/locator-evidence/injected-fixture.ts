import fs from 'node:fs';
import path from 'node:path';
import { readToolIdentity } from '../../report/model.js';
import { ToolError } from '../../tool-error.js';
import { assertWorkspaceFile, configInsideProject, configPathInCopy, readPlaywrightVersion, resolveNodeModules, runPlaywrightInWorkspace } from '../workspace.js';
import { buildEvidence, type EvidenceFile, type RawEvidencePart } from './evidence.js';
import { locatorFixtureSource } from './fixture-source.js';

const FIXTURE_NAME = 'qcv-locator-fixture.ts';
const PARTS_DIR = path.join('.qa-core', 'locator-parts');

export interface LocatorEvidenceRun {
  evidence: EvidenceFile;
  /** `qcv-run-XXXXXX`. `--keep-workspace` keeps this directory, which contains `project`. */
  runRoot: string;
  /** Copied project at `<runRoot>/project`. */
  workspaceDir: string;
  kept: boolean;
  evidencePath: string;
  stdout: string;
  stderr: string;
  skippedLinks: string[];
}

/**
 * Record locator match counts by rewriting `@playwright/test` imports in a temp copy.
 * The original project files are not changed. The JSON is written under `outDir`.
 */
export async function collectLocatorEvidence(options: {
  projectDir: string;
  outDir: string;
  keepWorkspace: boolean;
  /** Config forwarded to Playwright. Resolved from `cwd`, then mapped into the temp copy. */
  configFile?: string;
  /** Playwright resolves `--config` from this directory. Defaults to `process.cwd()`. */
  cwd?: string;
}): Promise<LocatorEvidenceRun> {
  const projectDir = path.resolve(options.projectDir);
  const configFile = options.configFile
    ? configInsideProject(options.configFile, projectDir, options.cwd ?? process.cwd())
    : undefined;
  const version = readPlaywrightVersion(resolveNodeModules(projectDir));
  const partsHolder: { parts: RawEvidencePart[]; errors: string[] } = { parts: [], errors: [] };
  const run = await runPlaywrightInWorkspace(projectDir, {
    keep: options.keepWorkspace,
    env: { QCV_EVIDENCE_DIR: PARTS_DIR },
    configFile,
    prepare: (workspaceDir) => {
      installFixture(workspaceDir, configFile);
    },
    after: (workspaceDir) => {
      const partsDir = path.join(workspaceDir, PARTS_DIR);
      partsHolder.parts = readParts(partsDir);
      partsHolder.errors = readEvidenceErrors(partsDir);
    },
  });
  const logged = evidenceWriteErrors(partsHolder.errors, run.playwright.stderr);
  if (logged.length > 0) {
    throw new ToolError(`Locator evidence write failed: ${logged.join('; ')}`);
  }
  const evidence = buildEvidence({
    parts: partsHolder.parts,
    workspaceDir: run.workspaceDir,
    projectDir,
    tool: readToolIdentity(),
    playwrightVersion: version,
    playwrightExitCode: run.playwright.exitCode,
  });
  const evidencePath = writeEvidenceFile(evidence, options.outDir);
  return {
    evidence,
    runRoot: run.runRoot,
    workspaceDir: run.workspaceDir,
    kept: run.kept,
    evidencePath,
    stdout: run.playwright.stdout,
    stderr: run.playwright.stderr,
    skippedLinks: run.skippedLinks,
  };
}

export function rewritePlaywrightImports(source: string, specifier: string): string {
  const fromClause = /((?:from|import)\s*\(?\s*)(['"])@playwright\/test\2/g;
  const required = /(require\(\s*)(['"])@playwright\/test\2/g;
  return source.replace(fromClause, `$1$2${specifier}$2`).replace(required, `$1$2${specifier}$2`);
}

const CONFIG_EXTENSIONS = ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs'];

/** True for the config names Playwright 1.60.0 discovers, in any directory. */
export function isPlaywrightConfig(name: string): boolean {
  return CONFIG_EXTENSIONS.some((extension) => name === `playwright.config${extension}`);
}

function rewriteProjectImports(workspaceDir: string, fixturePath: string, configFile?: string): void {
  const custom = configFile ? configPathInCopy(workspaceDir, configFile) : undefined;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.qa-core' || entry.name === 'test-results') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (isPlaywrightConfig(entry.name)) continue;
      if (custom && path.resolve(full) === custom) continue;
      if (full === fixturePath) continue;
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|cts|mts)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const next = rewritePlaywrightImports(text, specifierFor(full, fixturePath));
      if (next !== text) {
        assertWorkspaceFile(workspaceDir, full);
        fs.writeFileSync(full, next);
      }
    }
  };
  walk(workspaceDir);
}

export function installFixture(workspaceDir: string, configFile?: string): void {
  const fixturePath = path.join(workspaceDir, FIXTURE_NAME);
  assertWorkspaceFile(workspaceDir, fixturePath);
  fs.writeFileSync(fixturePath, locatorFixtureSource());
  rewriteProjectImports(workspaceDir, fixturePath, configFile);
  fs.mkdirSync(path.join(workspaceDir, PARTS_DIR), { recursive: true });
}

function specifierFor(fromFile: string, fixturePath: string): string {
  let relative = path.relative(path.dirname(fromFile), fixturePath).split(path.sep).join('/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative.replace(/\.ts$/, '.js');
}

/** Errors from the part file and from `QCV_EVIDENCE_ERROR` lines on stderr. */
export function evidenceWriteErrors(fileErrors: readonly string[], stderr: string): string[] {
  const fromStderr = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('QCV_EVIDENCE_ERROR:'))
    .map((line) => line.slice('QCV_EVIDENCE_ERROR:'.length).trim());
  return [...fileErrors, ...fromStderr];
}

export function readEvidenceErrors(partsDir: string): string[] {
  const file = path.join(partsDir, 'errors.txt');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Read JSON lines, and a JSON array from an older part file. */
export function readParts(partsDir: string): RawEvidencePart[] {
  if (!fs.existsSync(partsDir)) return [];
  const parts: RawEvidencePart[] = [];
  for (const name of fs.readdirSync(partsDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const text = fs.readFileSync(path.join(partsDir, name), 'utf8');
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('[')) {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) parts.push(asPart(item));
      continue;
    }
    for (const line of text.split('\n')) {
      const row = line.trim();
      if (row.length === 0) continue;
      parts.push(asPart(JSON.parse(row)));
    }
  }
  return parts;
}

function asPart(value: unknown): RawEvidencePart {
  if (typeof value !== 'object' || value === null) throw new ToolError('Locator evidence part is not an object.');
  const record = value as Record<string, unknown>;
  const phase = record.phase;
  if (phase !== 'action' && phase !== 'assertion') throw new ToolError('Locator evidence part has a bad phase.');
  if (typeof record.selector !== 'string' || typeof record.api !== 'string' || typeof record.url !== 'string') {
    throw new ToolError('Locator evidence part is missing a string field.');
  }
  if (typeof record.call !== 'string' || typeof record.stack !== 'string' || typeof record.testFile !== 'string') {
    throw new ToolError('Locator evidence part is missing a string field.');
  }
  if (typeof record.testTitle !== 'string' || typeof record.testLine !== 'number') {
    throw new ToolError('Locator evidence part is missing a number field.');
  }
  if (record.matchCount !== null && typeof record.matchCount !== 'number') {
    throw new ToolError('Locator evidence part is missing a number field.');
  }
  if (typeof record.actionSucceeded !== 'boolean') {
    throw new ToolError('Locator evidence part is missing actionSucceeded.');
  }
  const parentCount = record.parentCount;
  const countExpected = record.countExpected;
  const testColumn = record.testColumn;
  return {
    selector: record.selector,
    api: record.api,
    url: record.url,
    matchCount: record.matchCount,
    phase,
    call: record.call,
    negated: record.negated === true,
    actionSucceeded: record.actionSucceeded,
    parentCount: typeof parentCount === 'number' || parentCount === null ? parentCount : null,
    countExpected: typeof countExpected === 'number' || countExpected === null ? countExpected : null,
    optionAbsence: record.optionAbsence === true,
    stack: record.stack,
    testFile: record.testFile,
    testLine: record.testLine,
    testColumn: typeof testColumn === 'number' ? testColumn : undefined,
    testTitle: record.testTitle,
  };
}

export function writeEvidenceFile(evidence: EvidenceFile, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'locator-evidence.json');
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  return target;
}
