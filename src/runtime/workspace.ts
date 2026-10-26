import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlaywrightConfigFile } from '../inventory/discover.js';
import { ToolError } from '../tool-error.js';

const SKIP_COPY = new Set(['node_modules', '.qa-core', 'test-results', 'playwright-report', '.git']);

interface ActiveWorkspace {
  keep: boolean;
  child?: ChildProcess;
  /** Copied project at `<runRoot>/project`. `--keep-workspace` retains `runRoot`, which then contains `project`. */
  projectCopy: string;
  /** Chromium temp directory. A sibling of `projectCopy`, removed even when the run root is kept. */
  browserTmp?: string;
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
      for (const [runRoot, state] of entries) {
        if (state.keep) {
          removeBrowserTemp(state);
          removeRunExtras(runRoot);
          fs.writeSync(2, workspaceLine(runRoot));
          continue;
        }
        try {
          fs.rmSync(runRoot, { recursive: true, force: true });
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

function removeBrowserTemp(state: ActiveWorkspace): void {
  if (!state.browserTmp) return;
  try {
    fs.rmSync(state.browserTmp, { recursive: true, force: true });
  } catch {
    // The run directory removal covers this when the workspace is not kept.
  }
  state.browserTmp = undefined;
}

/**
 * Absolute path for the Workspace line.
 * A backslash is doubled first, so a later `\u` escape cannot be confused with
 * those two characters already in the path. C0, DEL, C1, U+2028, U+2029, and
 * bidi controls (U+200E, U+200F, U+202A through U+202E, U+2066 through U+2069)
 * are then written as `\u` plus four lowercase hex digits. The path is not rewritten with `~`.
 */
export function formatWorkspacePath(dir: string): string {
  const resolved = path.resolve(dir);
  const slashed = resolved.replaceAll('\\', '\\\\');
  return slashed.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** `Workspace: <absolute path>` plus a newline. Both keep paths write this to stderr. */
export function workspaceLine(dir: string): string {
  return `Workspace: ${formatWorkspacePath(dir)}\n`;
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
  /** `qcv-run-XXXXXX`. `--keep-workspace` keeps this directory. After the browser temp is removed it contains `project`. */
  runRoot: string;
  /** Copied project at `<runRoot>/project`. Evidence paths are relative to this directory. */
  workspaceDir: string;
  kept: boolean;
  playwright: PlaywrightRun;
  /** Set when a baseline Playwright process ran before the evidence process. */
  baseline?: PlaywrightRun;
  /** Symlinks that were not copied because they were dangling or looped. Paths are relative to the project. */
  skippedLinks: string[];
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

export interface WorkspacePhase {
  env?: NodeJS.ProcessEnv;
  /** Replaces the default `test --retries=0 --reporter=line` arguments. */
  playwrightArgs?: string[];
  prepare?: (workspaceDir: string) => void;
  after?: (workspaceDir: string, playwright: PlaywrightRun) => void;
}

/**
 * Copy `projectDir` to a temp folder, symlink `node_modules`, and run Playwright there with `--retries=0`.
 * The copy is removed afterwards unless `keep` is set. The original project is not written.
 * `second` runs another Playwright process in the same copy, after the first one exits.
 */
export async function runPlaywrightInWorkspace(
  projectDir: string,
  options: {
    keep: boolean;
    env?: NodeJS.ProcessEnv;
    /** Project-relative Playwright `--config`, also skipped by the import rewrite. */
    configFile?: string;
    prepare?: (workspaceDir: string) => void;
    /** Runs after the copy is ready and before Playwright starts. */
    onWorkspace?: (workspaceDir: string) => void;
    /** Runs after Playwright exits and before the workspace is removed. */
    after?: (workspaceDir: string, playwright: PlaywrightRun) => void;
    playwrightArgs?: string[];
    /** A second Playwright process in the same copy. The returned `playwright` is this run. */
    second?: WorkspacePhase;
  },
): Promise<WorkspaceRun> {
  const source = path.resolve(projectDir);
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-run-'));
  const workspaceDir = path.join(runRoot, 'project');
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(runRoot, 'owner.pid'), `${process.pid}\n`);
  const state: ActiveWorkspace = { keep: options.keep, projectCopy: workspaceDir };
  activeWorkspaces.set(runRoot, state);
  installSignalCleanup();
  const modules = resolveNodeModules(source);
  try {
    const skippedLinks = copyProject(source, workspaceDir);
    const link = path.join(workspaceDir, 'node_modules');
    if (fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(modules, link, 'dir');
    options.prepare?.(workspaceDir);
    options.onWorkspace?.(workspaceDir);
    const first = await runPlaywright(workspaceDir, options.env, state, (child) => {
      state.child = child;
    }, commandArgs(workspaceDir, options.playwrightArgs, options.configFile));
    options.after?.(workspaceDir, first);
    let playwright = first;
    let baseline: PlaywrightRun | undefined;
    if (options.second) {
      baseline = first;
      if (!signalStop) removeBrowserTemp(state);
      options.second.prepare?.(workspaceDir);
      playwright = await runPlaywright(
        workspaceDir,
        { ...options.env, ...options.second.env },
        state,
        (child) => {
          state.child = child;
        },
        commandArgs(workspaceDir, options.second.playwrightArgs, options.configFile),
      );
      options.second.after?.(workspaceDir, playwright);
    }
    if (!signalStop) removeBrowserTemp(state);
    if (!options.keep && !signalStop) fs.rmSync(runRoot, { recursive: true, force: true });
    else if (options.keep && !signalStop) removeRunExtras(runRoot);
    if (signalStop) await new Promise(() => {});
    return { runRoot, workspaceDir, kept: options.keep, playwright, baseline, skippedLinks };
  } catch (error) {
    if (!signalStop) removeBrowserTemp(state);
    if (!options.keep && !signalStop) fs.rmSync(runRoot, { recursive: true, force: true });
    else if (options.keep && !signalStop) removeRunExtras(runRoot);
    if (signalStop) await new Promise(() => {});
    throw error;
  } finally {
    if (!signalStop) activeWorkspaces.delete(runRoot);
  }
}

/**
 * Playwright resolves `--config` from the process cwd, including an absolute path.
 * A directory is the `playwright.config.*` inside it. The result is a project-relative
 * file path. A missing config is refused here, before the temp copy. A file outside
 * the project is refused so the original tree is never the suite Playwright runs.
 */
export function configInsideProject(configFile: string, projectDir: string, cwd: string): string {
  const project = path.resolve(projectDir);
  const resolved = path.resolve(cwd, configFile);
  const relative = path.relative(project, resolved);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ToolError(
      `Refusing --config ${resolved} because it is outside the project. The checker will not run Playwright against the original tree.`,
    );
  }
  const config = resolvePlaywrightConfigFile(resolved);
  const configRelative = path.relative(project, config);
  if (configRelative.length === 0 || configRelative.startsWith('..') || path.isAbsolute(configRelative)) {
    throw new ToolError(
      `Refusing --config ${config} because it is outside the project. The checker will not run Playwright against the original tree.`,
    );
  }
  return configRelative.split(path.sep).join('/');
}

/** Absolute config path inside the temp copy. An absolute original path is refused. */
export function configPathInCopy(workspaceDir: string, configFile: string): string {
  const resolved = path.resolve(workspaceDir, configFile);
  const relative = path.relative(workspaceDir, resolved);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ToolError(
      `Refusing --config ${configFile} because it is outside the temp copy. The checker will not run Playwright against the original tree.`,
    );
  }
  return resolved;
}

function commandArgs(workspaceDir: string, args: string[] | undefined, configFile: string | undefined): string[] {
  const outputDir = path.join(workspaceDir, 'test-results');
  const command = args ?? ['test', '--retries=0', '--reporter=line', `--output=${outputDir}`];
  if (!configFile) return command;
  return [...command, `--config=${configPathInCopy(workspaceDir, configFile)}`];
}

function removeRunExtras(runRoot: string): void {
  for (const name of ['owner.pid', 'qcv-supervisor.mjs']) {
    try {
      fs.rmSync(path.join(runRoot, name), { force: true });
    } catch {
      // The signal path may already have removed the run.
    }
  }
}

interface SkippedLink {
  relativePath: string;
  reason: 'dangling' | 'loop';
}

function copyProject(source: string, dest: string): string[] {
  const skipped: SkippedLink[] = [];
  const stack: string[] = [];
  copyTree(source, dest, stack, skipped, source);
  return skipped.map((item) => `${item.relativePath} (${item.reason})`);
}

/**
 * A directory symlink is a loop only when its target is an ancestor of the link,
 * or that target is already on the current copy stack. A link to a directory copied
 * somewhere else is copied again.
 */
function copyTree(from: string, to: string, stack: string[], skipped: SkippedLink[], source: string): void {
  if (from !== source && SKIP_COPY.has(path.basename(from))) return;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(from);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return;
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Cannot copy ${from}: ${message}`);
  }
  if (stat.isSymbolicLink()) {
    copyLink(from, to, stack, skipped, source);
    return;
  }
  if (stat.isDirectory()) {
    copyDirectory(from, to, stack, skipped, source);
    return;
  }
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function copyDirectory(from: string, to: string, stack: string[], skipped: SkippedLink[], source: string): void {
  const real = realOf(from);
  if (stack.includes(real)) {
    skipped.push({ relativePath: projectRelative(source, from), reason: 'loop' });
    return;
  }
  stack.push(real);
  try {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (SKIP_COPY.has(entry)) continue;
      copyTree(path.join(from, entry), path.join(to, entry), stack, skipped, source);
    }
  } finally {
    stack.pop();
  }
}

function copyLink(from: string, to: string, stack: string[], skipped: SkippedLink[], source: string): void {
  const relativePath = projectRelative(source, from);
  let real: string;
  try {
    real = fs.realpathSync(from);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ELOOP') {
      skipped.push({ relativePath, reason: code === 'ELOOP' ? 'loop' : 'dangling' });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Cannot copy symlink ${relativePath}: ${message}`);
  }
  let target: fs.Stats;
  try {
    target = fs.statSync(real);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ELOOP') {
      skipped.push({ relativePath, reason: code === 'ELOOP' ? 'loop' : 'dangling' });
      return;
    }
    throw new ToolError(`Cannot copy symlink ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (target.isDirectory()) {
    if (stack.includes(real) || linkTargetIsAncestor(from, real)) {
      skipped.push({ relativePath, reason: 'loop' });
      return;
    }
    copyDirectory(real, to, stack, skipped, source);
    return;
  }
  if (target.isFile()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(real, to);
    return;
  }
  skipped.push({ relativePath, reason: 'dangling' });
}

function linkTargetIsAncestor(linkPath: string, targetReal: string): boolean {
  let dir = path.dirname(linkPath);
  const root = path.parse(dir).root;
  for (let depth = 0; depth < 128; depth += 1) {
    if (realOf(dir) === targetReal) return true;
    if (dir === root) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

function realOf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function projectRelative(source: string, file: string): string {
  return path.relative(source, file).split(path.sep).join('/');
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code);
  return '';
}

const SUPERVISOR_SOURCE = `import { spawn } from 'node:child_process';
import fs from 'node:fs';

const parent = Number(process.env.QCV_PARENT_PID || '0');
const runRoot = process.env.QCV_RUN_ROOT || '';
const keep = process.env.QCV_KEEP === '1';
const browserTmp = process.env.QCV_BROWSER_TMP || '';
const args = process.argv.slice(2);
const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: true,
});

function parentAlive(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && error.code === 'EPERM');
  }
}

function ppidOf(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(rest[1] || '0');
  } catch {
    return 0;
  }
}

function killTree(root) {
  const pending = [root];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    let names = [];
    try { names = fs.readdirSync('/proc'); } catch { names = []; }
    for (const name of names) {
      if (!/^[0-9]+$/.test(name)) continue;
      const pid = Number(name);
      if (ppidOf(pid) === current) pending.push(pid);
    }
  }
  for (const pid of seen) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function stopChild() {
  const pid = child.pid;
  if (!pid) return;
  killTree(pid);
}

const timer = setInterval(() => {
  if (parentAlive(parent)) return;
  clearInterval(timer);
  stopChild();
  if (browserTmp) {
    try { fs.rmSync(browserTmp, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  if (!keep && runRoot) {
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch { /* already gone */ }
  } else if (keep && runRoot) {
    for (const name of ['owner.pid', 'qcv-supervisor.mjs']) {
      try { fs.rmSync(runRoot + '/' + name, { force: true }); } catch { /* already gone */ }
    }
  }
  process.exit(1);
}, 250);

child.on('error', (error) => {
  clearInterval(timer);
  try { fs.writeSync(2, String(error && error.message ? error.message : error) + '\\n'); } catch { /* stderr closed */ }
  process.exit(1);
});

child.on('exit', (code) => {
  clearInterval(timer);
  process.exit(code === null || code === undefined ? 1 : code);
});
`;

/** Parent-death watchdog started in front of Playwright. Tests spawn this source directly. */
export function playwrightSupervisorSource(): string {
  return SUPERVISOR_SOURCE;
}

function runPlaywright(
  workspaceDir: string,
  extraEnv: NodeJS.ProcessEnv | undefined,
  state: ActiveWorkspace,
  onChild: (child: ChildProcess) => void,
  args: string[],
): Promise<PlaywrightRun> {
  const cli = path.join(workspaceDir, 'node_modules', 'playwright', 'cli.js');
  if (!fs.existsSync(cli)) throw new ToolError(`Playwright CLI is missing at ${cli}.`);
  // A signal kills Chromium before it can remove its profile. Keep that profile, and any
  // .org.chromium.Chromium.* file, in a sibling of the project copy. The copy itself stays
  // the user's tree, so a kept workspace does not carry this directory into the next run.
  const browserTmp = state.browserTmp ?? fs.mkdtempSync(path.join(path.dirname(workspaceDir), '.qcv-browser-'));
  state.browserTmp = browserTmp;
  const runRoot = path.dirname(workspaceDir);
  const supervisor = path.join(runRoot, 'qcv-supervisor.mjs');
  fs.writeFileSync(supervisor, SUPERVISOR_SOURCE);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    FORCE_COLOR: '0',
    QCV_WORKSPACE_DIR: workspaceDir,
    QCV_PARENT_PID: String(process.pid),
    QCV_RUN_ROOT: runRoot,
    QCV_KEEP: state.keep ? '1' : '0',
    QCV_BROWSER_TMP: browserTmp,
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
    const child = spawn(process.execPath, [supervisor, cli, ...args], {
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
