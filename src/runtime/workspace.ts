import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from '../tool-error.js';

const SKIP_COPY = new Set(['node_modules', '.qa-core', 'test-results', 'playwright-report', '.git', '.qcv-tmp']);

interface ActiveWorkspace {
  keep: boolean;
  child?: ChildProcess;
}

const activeWorkspaces = new Map<string, ActiveWorkspace>();
let signalHooksInstalled = false;
let signalStop = false;

const SIGNAL_GRACE_MS = 2000;
const SIGNAL_KILL_MS = 1000;

/** Child pids of `root`, including grandchildren. A dead process is omitted. */
export function listDescendantPids(root: number): number[] {
  const byParent = new Map<number, number[]>();
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let status: string;
    try {
      status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
    } catch {
      continue;
    }
    const match = /^PPid:\s+(\d+)/m.exec(status);
    const ppidText = match?.[1];
    if (!ppidText) continue;
    const ppid = Number(ppidText);
    const list = byParent.get(ppid);
    if (list) list.push(pid);
    else byParent.set(ppid, [pid]);
  }
  const out: number[] = [];
  const stack = [...(byParent.get(root) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) continue;
    out.push(pid);
    const kids = byParent.get(pid);
    if (kids) stack.push(...kids);
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may already be gone.
  }
}

function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve) => {
    const poll = (): void => {
      if (done() || Date.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

/**
 * Stop Playwright and every process it started, including Chromium.
 * SIGTERM first. After the grace period, SIGKILL any process that is still alive.
 */
async function terminateChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const members = new Set<number>([pid, ...listDescendantPids(pid)]);
  const killSet = (signal: NodeJS.Signals): void => {
    if (pidAlive(pid)) {
      for (const extra of listDescendantPids(pid)) members.add(extra);
    }
    for (const member of members) signalPid(member, signal);
    try {
      process.kill(-pid, signal);
    } catch {
      signalPid(pid, signal);
    }
  };
  const gone = (): boolean => [...members].every((member) => !pidAlive(member));
  killSet('SIGTERM');
  await waitUntil(gone, SIGNAL_GRACE_MS);
  if (!gone()) {
    killSet('SIGKILL');
    await waitUntil(gone, SIGNAL_KILL_MS);
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGHUP') return 129;
  return 143;
}

function installSignalCleanup(): void {
  if (signalHooksInstalled) return;
  signalHooksInstalled = true;
  let cleanupStarted = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    signalStop = true;
    const exitCode = signalExitCode(signal);
    const entries = [...activeWorkspaces.entries()];
    void (async () => {
      for (const [, state] of entries) {
        if (state.child) await terminateChild(state.child);
      }
      for (const [dir, state] of entries) {
        if (state.keep) continue;
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Still exit below so the signal does not leave this process running.
        }
      }
      activeWorkspaces.clear();
      process.exit(exitCode);
    })();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('SIGHUP'));
}

function isOutsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Refuse to write `file` unless it is a regular file inside `workspaceDir`.
 * A missing file is allowed only when its parent is a real directory inside the workspace.
 * A symlink fails this check, including one that points outside the temp copy.
 */
export function assertWorkspaceFile(workspaceDir: string, file: string): void {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workspaceDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Refusing to write ${file}: ${message}`);
  }
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT') {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Refusing to write ${file}: ${message}`);
    }
  }
  if (stat) {
    if (!stat.isFile()) {
      throw new ToolError(`Refusing to write ${file} because it is not a regular file in the temp workspace.`);
    }
    let realFile: string;
    try {
      realFile = fs.realpathSync(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Refusing to write ${file}: ${message}`);
    }
    if (isOutsideRoot(realRoot, realFile)) {
      throw new ToolError(`Refusing to write ${file} because it is outside the temp workspace.`);
    }
    return;
  }
  const parent = path.dirname(file);
  let parentStat: fs.Stats;
  try {
    parentStat = fs.lstatSync(parent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Refusing to write ${file}: ${message}`);
  }
  if (!parentStat.isDirectory()) {
    throw new ToolError(`Refusing to write ${file} because its parent is not a real directory in the temp workspace.`);
  }
  let realParent: string;
  try {
    realParent = fs.realpathSync(parent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Refusing to write ${file}: ${message}`);
  }
  if (isOutsideRoot(realRoot, realParent)) {
    throw new ToolError(`Refusing to write ${file} because it is outside the temp workspace.`);
  }
}

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
    /** Runs after the copy is ready and before Playwright starts. */
    onWorkspace?: (workspaceDir: string) => void;
    /** Runs after Playwright exits and before the workspace is removed. */
    after?: (workspaceDir: string, playwright: PlaywrightRun) => void;
  },
): Promise<WorkspaceRun> {
  const source = path.resolve(projectDir);
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-workspace-'));
  const state: ActiveWorkspace = { keep: options.keep };
  activeWorkspaces.set(workspaceDir, state);
  installSignalCleanup();
  const modules = resolveNodeModules(source);
  try {
    copyProject(source, workspaceDir);
    const link = path.join(workspaceDir, 'node_modules');
    if (fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(modules, link, 'dir');
    options.prepare?.(workspaceDir);
    options.onWorkspace?.(workspaceDir);
    const playwright = await runPlaywright(workspaceDir, options.env, (child) => {
      state.child = child;
    });
    options.after?.(workspaceDir, playwright);
    if (!options.keep && !signalStop) fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (signalStop) await new Promise(() => {});
    return { workspaceDir, kept: options.keep, playwright };
  } catch (error) {
    if (!options.keep && !signalStop) fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (signalStop) await new Promise(() => {});
    throw error;
  } finally {
    if (!signalStop) activeWorkspaces.delete(workspaceDir);
  }
}

function copyProject(source: string, dest: string): void {
  fs.cpSync(source, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => src === source || !SKIP_COPY.has(path.basename(src)),
  });
}

function runPlaywright(
  workspaceDir: string,
  extraEnv: NodeJS.ProcessEnv | undefined,
  onChild: (child: ChildProcess) => void,
): Promise<PlaywrightRun> {
  const cli = path.join(workspaceDir, 'node_modules', 'playwright', 'cli.js');
  if (!fs.existsSync(cli)) throw new ToolError(`Playwright CLI is missing at ${cli}.`);
  const outputDir = path.join(workspaceDir, 'test-results');
  // A signal kills Chromium before it can remove its profile. Keep that profile, and any
  // .org.chromium.Chromium.* file, inside the workspace this process deletes after the child exits.
  // mkdtemp avoids EEXIST when the copied project already contains a browser temp directory.
  // .qcv-tmp is not copied, so a user's directory of that name is left untouched.
  const browserTmp = fs.mkdtempSync(path.join(workspaceDir, '.qcv-browser-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    FORCE_COLOR: '0',
    QCV_WORKSPACE_DIR: workspaceDir,
    TMPDIR: browserTmp,
    TMP: browserTmp,
    TEMP: browserTmp,
  };
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
      detached: true,
    });
    onChild(child);
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
