import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from '../tool-error.js';

const SKIP_COPY = new Set(['node_modules', '.qa-core', 'test-results', 'playwright-report', '.git']);

export interface PlaywrightRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WorkspaceRun {
  workspaceDir: string;
  kept: boolean;
  playwright: PlaywrightRun;
}

/** `node_modules` that contains `@playwright/test`, preferring the project's own. */
export function resolveNodeModules(projectDir: string): string {
  let current = path.resolve(projectDir);
  const root = path.parse(current).root;
  while (true) {
    const candidate = path.join(current, 'node_modules');
    if (fs.existsSync(path.join(candidate, '@playwright', 'test', 'package.json'))) return candidate;
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', 'node_modules');
  if (fs.existsSync(path.join(bundled, '@playwright', 'test', 'package.json'))) return bundled;
  throw new ToolError('Cannot find node_modules with @playwright/test to symlink into the workspace.');
}

export function readPlaywrightVersion(nodeModules: string): string {
  const file = path.join(nodeModules, 'playwright', 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Cannot read ${file}: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new ToolError(`${file} must contain a JSON object.`);
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) throw new ToolError(`${file} is missing a version.`);
  return version;
}

/**
 * Copy `projectDir` to a temp folder, symlink `node_modules`, and run Playwright there with `--retries=0`.
 * The copy is removed afterwards unless `keep` is set. The original project is not written.
 */
export async function runPlaywrightInWorkspace(
  projectDir: string,
  options: {
    keep: boolean;
    env?: NodeJS.ProcessEnv;
    prepare?: (workspaceDir: string) => void;
    /** Runs after Playwright exits and before the workspace is removed. */
    after?: (workspaceDir: string, playwright: PlaywrightRun) => void;
  },
): Promise<WorkspaceRun> {
  const source = path.resolve(projectDir);
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-workspace-'));
  const modules = resolveNodeModules(source);
  try {
    copyProject(source, workspaceDir);
    const link = path.join(workspaceDir, 'node_modules');
    if (fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(modules, link, 'dir');
    options.prepare?.(workspaceDir);
    const playwright = await runPlaywright(workspaceDir, options.env);
    options.after?.(workspaceDir, playwright);
    if (!options.keep) fs.rmSync(workspaceDir, { recursive: true, force: true });
    return { workspaceDir, kept: options.keep, playwright };
  } catch (error) {
    if (!options.keep) fs.rmSync(workspaceDir, { recursive: true, force: true });
    throw error;
  }
}

function copyProject(source: string, dest: string): void {
  fs.cpSync(source, dest, {
    recursive: true,
    filter: (src) => src === source || !SKIP_COPY.has(path.basename(src)),
  });
}

function runPlaywright(workspaceDir: string, extraEnv: NodeJS.ProcessEnv | undefined): Promise<PlaywrightRun> {
  const cli = path.join(workspaceDir, 'node_modules', 'playwright', 'cli.js');
  if (!fs.existsSync(cli)) throw new ToolError(`Playwright CLI is missing at ${cli}.`);
  const outputDir = path.join(workspaceDir, 'test-results');
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, FORCE_COLOR: '0' };
  delete env.NO_COLOR;
  if (typeof env.QCV_EVIDENCE_DIR === 'string' && env.QCV_EVIDENCE_DIR.length > 0 && !path.isAbsolute(env.QCV_EVIDENCE_DIR)) {
    env.QCV_EVIDENCE_DIR = path.resolve(workspaceDir, env.QCV_EVIDENCE_DIR);
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '--retries=0', '--reporter=line', `--output=${outputDir}`], {
      cwd: workspaceDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      reject(new ToolError(`Cannot start Playwright: ${error.message}`));
    });
    child.on('close', (exitCode) => {
      if (exitCode === null) {
        reject(new ToolError('Playwright exited without a status code.'));
        return;
      }
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}
