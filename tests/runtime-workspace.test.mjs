import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEvidence, callSiteFromStack, evidenceWithoutActionMatchCount } from '../dist/runtime/locator-evidence/evidence.js';
import { collectLocatorEvidence, rewritePlaywrightImports } from '../dist/runtime/locator-evidence/injected-fixture.js';
import { assertWorkspaceFile, formatWorkspacePath, listDescendantPids } from '../dist/runtime/workspace.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sauceDemo = path.join(repoRoot, 'example-project/saucedemo');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function privateTempEnv(dir) {
  return { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir };
}

// node:test runs t.after hooks in registration order. One hook, registered first,
// stops processes and then removes directories. QCV_INJECT_FAIL is a test-only
// switch: after-spawn, after-profile, browser-up, after-signal.
function injectFailure(stage) {
  if (process.env.QCV_INJECT_FAIL === stage) throw new Error(`injected failure at ${stage}`);
}

function bindCleanup(t) {
  const stops = [];
  const checks = [];
  const removals = [];
  const tracked = { pids: new Set(), pgrps: new Set(), sids: new Set() };
  t.after(() => {
    const steps = [...stops];
    if (process.platform === 'linux') steps.push(() => assertNoLeftovers(tracked, 'teardown'));
    steps.push(...checks, ...removals);
    if (process.env.QCV_INJECT_TEARDOWN === '1') {
      steps.unshift(async () => {
        throw new Error('injected teardown failure');
      });
    }
    return runSteps(steps);
  });
  return {
    tracked,
    stop(fn) {
      stops.push(fn);
    },
    check(fn) {
      checks.push(fn);
    },
    noteTree(rootPid) {
      if (!rootPid || process.platform !== 'linux') return;
      absorbIds(tracked, rootPid);
    },
    dir(prefix) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      removals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      return dir;
    },
    remove(dir) {
      removals.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    },
  };
}

function procIds(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { pid, pgrp: Number(rest[2]), sid: Number(rest[3]) };
}

function absorbIds(tracked, rootPid) {
  const mine = procIds(process.pid);
  for (const pid of [rootPid, ...listDescendantPids(rootPid)]) {
    tracked.pids.add(pid);
    try {
      const info = procIds(pid);
      if (info.pgrp && info.pgrp !== mine.pgrp) tracked.pgrps.add(info.pgrp);
      if (info.sid && info.sid !== mine.sid) tracked.sids.add(info.sid);
    } catch {
      // The process exited before its ids could be read.
    }
  }
}

// The test process shares its session with the runner, so that session is not
// required to be empty. Processes recorded from this test's tree must be gone,
// including a detached child whose process group or session is not the test's.
// A failing check kills those processes before it throws, so they are not left alive.
// A grandchild that calls setsid before noteTree runs is not in this set: a double
// fork into a new session is not seen, and this check cannot kill it.
function assertNoLeftovers(tracked, label) {
  const left = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let info;
    try {
      info = procIds(pid);
    } catch {
      continue;
    }
    if (tracked.pids.has(pid) || tracked.pgrps.has(info.pgrp) || tracked.sids.has(info.sid)) left.push(pid);
  }
  const descendants = listDescendantPids(process.pid);
  for (const pid of [...left, ...descendants]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  assert.deepEqual(left, [], `${label} left pids ${left.join(',')}`);
  assert.deepEqual(descendants, [], `${label} left descendants ${descendants.join(',')}`);
}

function parseWorkspaceLine(stderr, stdout) {
  assert.equal(stdout.includes('Workspace:'), false, stdout);
  const lines = stderr.split(/\r?\n/).filter((line) => line.startsWith('Workspace: '));
  assert.equal(lines.length, 1, stderr);
  const shown = lines[0].slice('Workspace: '.length);
  assert.equal(shown.includes('~'), false, shown);
  assert.equal(shown, formatWorkspacePath(shown));
  assert.equal(path.isAbsolute(shown), true, shown);
  return shown;
}

async function runSteps(steps) {
  let failure;
  let index = 0;
  const next = async () => {
    if (index >= steps.length) return;
    const step = steps[index];
    index += 1;
    try {
      await step();
    } catch (error) {
      failure ??= error;
    } finally {
      await next();
    }
  };
  await next();
  if (failure) throw failure;
}

function signalTree(pid, signal, alive) {
  if (!pid || !alive()) return;
  const members = new Set([pid, ...listDescendantPids(pid)]);
  for (const member of members) {
    if (!alive()) return;
    try {
      process.kill(member, signal);
    } catch {
      // already gone
    }
  }
  for (const member of members) {
    if (!alive()) return;
    try {
      process.kill(-member, signal);
    } catch {
      // not a process group leader
    }
  }
}

function watchChild(child) {
  let exited = child.exitCode !== null || child.signalCode !== null;
  const onExit = () => {
    exited = true;
  };
  child.once('exit', onExit);
  return {
    alive() {
      return !exited && child.exitCode === null && child.signalCode === null;
    },
    close() {
      child.off('exit', onExit);
    },
  };
}

async function stopCli(child) {
  const watch = watchChild(child);
  try {
    if (!watch.alive()) return;
    try {
      child.kill('SIGINT');
    } catch {
      // already gone
    }
    const interrupted = await waitForExitQuiet(child, 5_000);
    if (interrupted || !watch.alive()) return;
    signalTree(child.pid, 'SIGTERM', () => watch.alive());
    const termed = await waitForExitQuiet(child, 2_000);
    if (termed || !watch.alive()) return;
    signalTree(child.pid, 'SIGKILL', () => watch.alive());
    await waitForExitQuiet(child, 2_000);
  } finally {
    watch.close();
  }
}

async function stopHelper(child, timeoutMs) {
  const watch = watchChild(child);
  try {
    if (!watch.alive()) return;
    try {
      child.stdin.write('close\n');
      child.stdin.end();
    } catch {
      // stdin may already be closed
    }
    const closed = await waitForExitQuiet(child, timeoutMs);
    if (closed || !watch.alive()) return;
    signalTree(child.pid, 'SIGKILL', () => watch.alive());
    await waitForExitQuiet(child, 2_000);
  } finally {
    watch.close();
  }
}

function waitForExitQuiet(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function withPrivateTemp(t, run) {
  const dir = tempDir(t, 'qcv-sig-');
  const saved = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
  try {
    return await run(dir);
  } finally {
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function writeProject(dir, { retries = 0, spec = PASS_SPEC } = {}) {
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: ${retries}, testDir: '.' });\n`,
  );
  fs.writeFileSync(path.join(dir, 'retry.spec.ts'), spec);
}

const PASS_SPEC = `import { test, expect } from '@playwright/test';
test('adds', () => {
  expect(1 + 1).toBe(2);
});
`;

const FAIL_SPEC = `import { test, expect } from '@playwright/test';
import fs from 'node:fs';
test('retries would pass', () => {
  const file = process.env.QCV_ATTEMPT_FILE ?? '';
  const n = file && fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  fs.writeFileSync(file, String(n + 1));
  expect(n).toBeGreaterThan(0);
});
`;

function sourceFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.qa-core' || entry.name === 'node_modules' || entry.name === 'test-results') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  return files.sort();
}

test('call sites stay project relative, titles drop controls, and selectors keep them escaped', () => {
  const workspace = '/tmp/qcv-workspace-example';
  const stack = [
    'Error: sample',
    `    at record (file://${workspace}/qcv-locator-fixture.ts:23:5)`,
    `    at spec (${workspace}/tests/a.spec.ts:4:7)`,
  ].join('\n');
  const site = callSiteFromStack(stack, workspace);
  assert.ok(site);
  assert.equal(site.file, `${workspace}/tests/a.spec.ts`);
  assert.equal(site.line, 4);
  assert.equal(site.column, 7);

  const evidence = buildEvidence({
    parts: [
      {
        selector: 'see \u009B #\u202Ebanner',
        api: "locator('#banner')",
        url: 'https://www.saucedemo.com/',
        matchCount: 0,
        phase: 'assertion',
        call: 'toBeHidden',
        negated: false,
        stack,
        testFile: `${workspace}/tests/a.spec.ts`,
        testLine: 2,
        testTitle: 'banner \u2066hidden',
      },
      {
        selector: '\u202E',
        api: 'locator',
        url: '',
        matchCount: 1,
        phase: 'action',
        call: 'click',
        negated: false,
        stack,
        testFile: `${workspace}/tests/a.spec.ts`,
        testLine: 2,
        testTitle: 'gone',
      },
    ],
    workspaceDir: workspace,
    projectDir: '/anywhere/demo',
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    playwrightExitCode: 0,
  });
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.project.dir, 'demo');
  assert.equal(evidence.records.length, 2);
  const record = evidence.records.find((item) => item.call === 'toBeHidden');
  assert.ok(record);
  assert.equal(record.selector, 'see \\u009b #\\u202ebanner');
  assert.equal(record.selector.includes('\u009B'), false);
  assert.equal(record.selector.includes('\u202E'), false);
  assert.equal(record.file, 'tests/a.spec.ts');
  assert.equal(record.testFile, 'tests/a.spec.ts');
  assert.equal(record.testTitle, 'banner hidden');
  assert.equal(record.matchCount, 0);
  assert.equal(record.actionSucceeded, false);
  assert.equal(record.resolvedOnAction, false);
  const onlyMark = evidence.records.find((item) => item.call === 'click');
  assert.equal(onlyMark.selector, '\\u202e');
  assert.equal(JSON.stringify(evidence).includes('\u202E'), false);
  assert.equal(JSON.stringify(evidence).includes('\u009B'), false);
  assert.equal(JSON.stringify(evidence).includes('\u2066'), false);
});

test('project.dir strips control characters and bidi marks', () => {
  const marked = buildEvidence({
    parts: [],
    workspaceDir: '/tmp/qcv-workspace-example',
    projectDir: '/tmp/pre\u202Epost\u009B',
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    playwrightExitCode: 0,
  });
  assert.equal(marked.project.dir, 'prepost');
  assert.equal(JSON.stringify(marked).includes('\u202E'), false);
  assert.equal(JSON.stringify(marked).includes('\u009B'), false);

  const blank = buildEvidence({
    parts: [],
    workspaceDir: '/tmp/qcv-workspace-example',
    projectDir: '/tmp/\u0001\u202E',
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    playwrightExitCode: 0,
  });
  assert.equal(blank.project.dir, '.');
  assert.equal(JSON.stringify(blank).includes('\u0001'), false);
});

test('import rewrite points specs at the fixture and leaves the config import alone', () => {
  const source = "import { test, expect } from '@playwright/test';\nexport { test } from '@playwright/test';\n";
  const rewritten = rewritePlaywrightImports(source, './qcv-locator-fixture.js');
  assert.equal(rewritten.includes('@playwright/test'), false);
  assert.equal(rewritten.split('./qcv-locator-fixture.js').length, 3);
});

test('the default evidence run leaves the project bytes unchanged and removes the workspace', async (t) => {
  const project = tempDir(t, 'qcv-project-');
  writeProject(project);
  const before = new Map(sourceFiles(project).map((file) => [file, fs.readFileSync(file)]));
  const run = await withPrivateTemp(t, () =>
    collectLocatorEvidence({
      projectDir: project,
      outDir: path.join(project, '.qa-core', 'verify'),
      keepWorkspace: false,
    }),
  );
  assert.equal(run.evidence.playwrightExitCode, 0);
  assert.equal(run.kept, false);
  assert.equal(fs.existsSync(run.workspaceDir), false);
  assert.equal(fs.existsSync(path.join(project, '.qa-core', 'verify', 'locator-evidence.json')), true);
  assert.equal(fs.existsSync(path.join(project, 'test-results')), false);
  for (const [file, bytes] of before) {
    assert.equal(fs.readFileSync(file).equals(bytes), true, file);
    assert.match(fs.readFileSync(file, 'utf8'), /@playwright\/test/);
  }
  const evidence = JSON.parse(fs.readFileSync(run.evidencePath, 'utf8'));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.playwrightVersion.length > 0, true);
  assert.equal(evidence.records.every((record) => !record.file.startsWith('/')), true);
});

test('Playwright retries stay at zero in the temp copy', async (t) => {
  const project = tempDir(t, 'qcv-retry-');
  const attempts = path.join(tempDir(t, 'qcv-attempts-'), 'count.txt');
  writeProject(project, { retries: 2, spec: FAIL_SPEC });
  const previous = process.env.QCV_ATTEMPT_FILE;
  process.env.QCV_ATTEMPT_FILE = attempts;
  try {
    const run = await withPrivateTemp(t, () =>
      collectLocatorEvidence({
        projectDir: project,
        outDir: path.join(project, '.qa-core', 'verify'),
        keepWorkspace: false,
      }),
    );
    assert.equal(run.evidence.playwrightExitCode, 1);
    assert.equal(fs.readFileSync(attempts, 'utf8'), '1');
    assert.equal(fs.existsSync(run.evidencePath), true);
    assert.equal(fs.existsSync(run.workspaceDir), false);
  } finally {
    if (previous === undefined) delete process.env.QCV_ATTEMPT_FILE;
    else process.env.QCV_ATTEMPT_FILE = previous;
  }
});

test('keep-workspace retains the copy and the symlinked node_modules', async (t) => {
  const project = tempDir(t, 'qcv-keep-');
  writeProject(project);
  const modules = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'package.json');
  const marker = fs.readFileSync(modules);
  const run = await withPrivateTemp(t, () =>
    collectLocatorEvidence({
      projectDir: project,
      outDir: path.join(project, '.qa-core', 'verify'),
      keepWorkspace: true,
    }),
  );
  t.after(() => fs.rmSync(run.runRoot, { recursive: true, force: true }));
  assert.equal(run.kept, true);
  assert.equal(run.workspaceDir, path.join(run.runRoot, 'project'));
  assert.equal(path.basename(run.runRoot).startsWith('qcv-run-'), true);
  assert.deepEqual(fs.readdirSync(run.runRoot).sort(), ['project']);
  assert.equal(fs.existsSync(run.workspaceDir), true);
  const link = path.join(run.workspaceDir, 'node_modules');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  const spec = fs.readFileSync(path.join(run.workspaceDir, 'retry.spec.ts'), 'utf8');
  assert.match(spec, /qcv-locator-fixture\.js/);
  assert.equal(spec.includes('@playwright/test'), false);
  const config = fs.readFileSync(path.join(run.workspaceDir, 'playwright.config.ts'), 'utf8');
  assert.match(config, /@playwright\/test/);
  fs.rmSync(run.runRoot, { recursive: true, force: true });
  assert.equal(fs.readFileSync(modules).equals(marker), true);
});

test('the cli prints an outside --out path as typed and still writes the evidence file', (t) => {
  const parent = tempDir(t, 'qcv-cli-parent-');
  const project = path.join(parent, 'proj');
  fs.mkdirSync(project);
  writeProject(project);
  const cli = path.join(repoRoot, 'dist/cli.js');
  const scratch = tempDir(t, 'qcv-sig-');
  const result = spawnSync(
    process.execPath,
    [cli, '.', '--only', 'locator-evidence', '--out', '../evidence-out'],
    { cwd: project, encoding: 'utf8', env: privateTempEnv(scratch) },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Locator evidence: \.\.\/evidence-out\/locator-evidence\.json/);
  assert.match(result.stdout, /Playwright exit: 0/);
  const evidencePath = path.join(parent, 'evidence-out', 'locator-evidence.json');
  assert.equal(fs.existsSync(evidencePath), true);
  assert.equal(fs.existsSync(path.join(project, '.qa-core')), false);
  const failing = path.join(parent, 'fail');
  fs.mkdirSync(failing);
  writeProject(failing, { spec: "import { test, expect } from '@playwright/test';\ntest('bad', () => { expect(1).toBe(2); });\n" });
  const failedScratch = tempDir(t, 'qcv-sig-');
  const failed = spawnSync(process.execPath, [cli, failing, '--only', 'locator-evidence', '--out', path.join(parent, 'fail-out')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: privateTempEnv(failedScratch),
  });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(fs.existsSync(path.join(parent, 'fail-out', 'locator-evidence.json')), true);
});

test('locator evidence on SauceDemo is skipped unless QCV_LIVE=1', { skip: process.env.QCV_LIVE !== '1' }, async (t) => {
  const copy = tempDir(t, 'qcv-sauce-');
  const before = hashTree(sauceDemo);
  const hadRuntimeDir = fs.existsSync(path.join(sauceDemo, '.qa-core'));
  fs.cpSync(sauceDemo, copy, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return source === sauceDemo || !['node_modules', '.qa-core', 'test-results', 'playwright-report', '.git'].includes(base);
    },
  });
  const out = tempDir(t, 'qcv-sauce-out-');
  const run = await withPrivateTemp(t, () => collectLocatorEvidence({ projectDir: copy, outDir: out, keepWorkspace: false }));
  assert.equal(hashTree(sauceDemo), before);
  assert.equal(fs.existsSync(path.join(sauceDemo, '.qa-core')), hadRuntimeDir);
  assert.equal(run.evidence.playwrightExitCode, 0, `${run.stderr}\n${run.stdout}`);
  assert.equal(fs.existsSync(run.workspaceDir), false);
  const banner = run.evidence.records.find((record) => record.selector.includes('#login-error-banner'));
  const locked = run.evidence.records.find(
    (record) =>
      record.testTitle.includes('locked out user') &&
      (record.api === "getByTestId('error')" || record.selector === 'internal:testid=[data-test="error"s]'),
  );
  assert.ok(banner, 'missing #login-error-banner');
  assert.equal(banner.matchCount, 0);
  assert.ok(locked, 'missing locked out error locator');
  assert.equal(locked.matchCount, 1);
  assert.equal(
    run.evidence.records.every((record) => record.resolvedOnAction === record.actionSucceeded),
    true,
  );
  assert.equal(locked.resolvedOnAction, false);
  assert.equal(run.evidence.records.every((record) => !record.file.startsWith('/') && !record.testFile.startsWith('/')), true);
});

test('an existing .qa-core directory on a SauceDemo copy is left in place', (t) => {
  const before = hashTree(sauceDemo);
  const hadRuntimeDir = fs.existsSync(path.join(sauceDemo, '.qa-core'));
  const copy = tempDir(t, 'qcv-sauce-runtime-');
  fs.cpSync(sauceDemo, copy, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return source === sauceDemo || !['node_modules', '.qa-core', 'test-results', 'playwright-report', '.git'].includes(base);
    },
  });
  const runtime = path.join(copy, '.qa-core');
  const verify = path.join(runtime, 'verify');
  const stamp = path.join(verify, 'preexisting.txt');
  const note = path.join(runtime, 'note.txt');
  fs.mkdirSync(verify, { recursive: true });
  fs.writeFileSync(stamp, 'preexisting\n');
  fs.writeFileSync(note, 'keep\n');
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'dist/cli.js'), copy], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.readFileSync(stamp, 'utf8'), 'preexisting\n');
  assert.equal(fs.readFileSync(note, 'utf8'), 'keep\n');
  for (const name of ['report.json', 'report.md', 'report.html']) {
    assert.equal(fs.existsSync(path.join(verify, name)), true, name);
  }
  assert.match(result.stdout, /Reports: \.qa-core\/verify\/report\.json/);
  assert.equal(hashTree(sauceDemo), before);
  assert.equal(fs.existsSync(path.join(sauceDemo, '.qa-core')), hadRuntimeDir);
  assert.equal(fs.existsSync(path.join(sauceDemo, '.qa-core', 'verify', 'preexisting.txt')), false);
});

const HELPER_SOURCE = `import { expect } from '@playwright/test';
export function ping() {
  expect(1).toBe(1);
  return 1;
}
`;

const HELPER_SPEC = `import { test } from '@playwright/test';
import { ping } from './helper.js';
test('pings', () => {
  ping();
});
`;

function writeHelperProject(project, helperTarget) {
  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  fs.symlinkSync(helperTarget, path.join(project, 'tests', 'helper.ts'));
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n",
  );
  fs.writeFileSync(path.join(project, 'tests', 'uses-helper.spec.ts'), HELPER_SPEC);
}

function runKeptEvidence(t, project) {
  const scratch = tempDir(t, 'qcv-sig-');
  const out = tempDir(t, 'qcv-symlink-out-');
  const cli = path.join(repoRoot, 'dist/cli.js');
  const result = spawnSync(
    process.execPath,
    [cli, project, '--only', 'locator-evidence', '--keep-workspace', '--out', out],
    { cwd: repoRoot, encoding: 'utf8', env: privateTempEnv(scratch) },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const runRoot = parseWorkspaceLine(result.stderr, result.stdout);
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  return path.join(runRoot, 'project');
}

test('a symlink inside the project is copied as a file and the original stays unchanged', (t) => {
  const project = tempDir(t, 'qcv-symlink-in-');
  fs.mkdirSync(path.join(project, 'support'));
  const helperPath = path.join(project, 'support', 'helper.ts');
  fs.writeFileSync(helperPath, HELPER_SOURCE);
  const before = fs.readFileSync(helperPath);
  writeHelperProject(project, path.join('..', 'support', 'helper.ts'));
  const workspace = runKeptEvidence(t, project);
  assert.equal(fs.readFileSync(helperPath).equals(before), true);
  assert.match(fs.readFileSync(helperPath, 'utf8'), /from '@playwright\/test'/);
  assert.equal(fs.lstatSync(path.join(project, 'tests', 'helper.ts')).isSymbolicLink(), true);
  const copied = path.join(workspace, 'tests', 'helper.ts');
  assert.equal(fs.lstatSync(copied).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(copied).isFile(), true);
  assert.match(fs.readFileSync(copied, 'utf8'), /qcv-locator-fixture\.js/);
  assert.equal(fs.readFileSync(copied, 'utf8').includes('@playwright/test'), false);
});

test('a symlink pointing outside the project does not change the outside file', (t) => {
  const project = tempDir(t, 'qcv-symlink-outproj-');
  const outside = tempDir(t, 'qcv-symlink-outside-');
  const outsideFile = path.join(outside, 'helper.ts');
  fs.writeFileSync(outsideFile, HELPER_SOURCE);
  const before = fs.readFileSync(outsideFile);
  writeHelperProject(project, outsideFile);
  const workspace = runKeptEvidence(t, project);
  assert.equal(fs.readFileSync(outsideFile).equals(before), true);
  assert.match(fs.readFileSync(outsideFile, 'utf8'), /from '@playwright\/test'/);
  assert.equal(fs.lstatSync(path.join(project, 'tests', 'helper.ts')).isSymbolicLink(), true);
  const copied = path.join(workspace, 'tests', 'helper.ts');
  assert.equal(fs.lstatSync(copied).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(copied).isFile(), true);
  const copiedText = fs.readFileSync(copied, 'utf8');
  assert.match(copiedText, /qcv-locator-fixture\.js/);
  assert.equal(copiedText.includes('@playwright/test'), false);
  const realCopied = fs.realpathSync(copied);
  assert.equal(realCopied.startsWith(`${workspace}${path.sep}`), true);
  assert.equal(realCopied === fs.realpathSync(outsideFile), false);
});

test('assertWorkspaceFile refuses a symlink and a file reached through a directory symlink', (t) => {
  const root = tempDir(t, 'qcv-guard-');
  const inside = path.join(root, 'real.ts');
  fs.writeFileSync(inside, 'export const n = 1;\n');
  assert.doesNotThrow(() => assertWorkspaceFile(root, inside));

  const link = path.join(root, 'link.ts');
  fs.symlinkSync(inside, link);
  assert.throws(() => assertWorkspaceFile(root, link), /not a regular file/);

  const outside = tempDir(t, 'qcv-guard-out-');
  const outsideFile = path.join(outside, 'secret.ts');
  fs.writeFileSync(outsideFile, 'export const n = 2;\n');
  fs.symlinkSync(outside, path.join(root, 'out'));
  assert.throws(() => assertWorkspaceFile(root, path.join(root, 'out', 'secret.ts')), /outside the temp workspace/);
});

test('a raw post-action count is kept and resolvedOnAction follows the action', async (t) => {
  const project = tempDir(t, 'qcv-action-');
  writeProject(project, {
    spec: `import { test } from '@playwright/test';
test('click removes the button', async ({ page }) => {
  await page.setContent('<button id="stay">Stay</button><button id="gone">Go</button>');
  await page.locator('#stay').click();
  await page.locator('#gone').evaluate((element) => {
    element.addEventListener('click', () => element.remove());
  });
  await page.locator('#gone').click({ force: true });
});
test('click missing fails', async ({ page }) => {
  await page.setContent('<p>none</p>');
  await page.locator('#missing').click({ timeout: 300 });
});
`,
  });
  const run = await withPrivateTemp(t, () =>
    collectLocatorEvidence({
      projectDir: project,
      outDir: path.join(project, '.qa-core', 'verify'),
      keepWorkspace: false,
    }),
  );
  assert.equal(run.evidence.playwrightExitCode, 1, `${run.stderr}\n${run.stdout}`);
  const stay = run.evidence.records.find((record) => record.call === 'click' && record.selector === '#stay');
  assert.ok(stay, `missing click on #stay\n${JSON.stringify(run.evidence.records)}\n${run.stderr}\n${run.stdout}`);
  assert.equal(stay.actionSucceeded, true);
  assert.equal(stay.resolvedOnAction, true);
  assert.equal(stay.matchCount, 1);
  const gone = run.evidence.records.find((record) => record.call === 'click' && record.selector === '#gone');
  assert.ok(gone, `missing click that removes its target\n${JSON.stringify(run.evidence.records)}\n${run.stderr}\n${run.stdout}`);
  assert.equal(gone.actionSucceeded, true);
  assert.equal(gone.resolvedOnAction, true);
  assert.equal(Number.isInteger(gone.matchCount) && gone.matchCount >= 0, true);
  const missing = run.evidence.records.find((record) => record.call === 'click' && record.selector === '#missing');
  assert.ok(missing, 'missing failed click');
  assert.equal(missing.actionSucceeded, false);
  assert.equal(missing.resolvedOnAction, false);
  assert.equal(missing.matchCount, 0);
});

test('resolvedOnAction is derived from actionSucceeded and matchCount is not clamped', () => {
  const workspace = '/tmp/qcv-workspace-example';
  const stack = [`Error: sample`, `    at spec (${workspace}/retry.spec.ts:4:3)`].join('\n');
  const evidence = buildEvidence({
    parts: [
      {
        selector: '#gone',
        api: "locator('#gone')",
        url: 'about:blank',
        matchCount: 0,
        phase: 'action',
        call: 'click',
        negated: false,
        actionSucceeded: true,
        stack,
        testFile: `${workspace}/retry.spec.ts`,
        testLine: 2,
        testTitle: 'click removes the button',
      },
      {
        selector: '#missing',
        api: "locator('#missing')",
        url: 'about:blank',
        matchCount: 0,
        phase: 'action',
        call: 'click',
        negated: false,
        actionSucceeded: false,
        stack,
        testFile: `${workspace}/retry.spec.ts`,
        testLine: 6,
        testTitle: 'click missing fails',
      },
    ],
    workspaceDir: workspace,
    projectDir: '/anywhere/demo',
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    playwrightExitCode: 1,
  });
  assert.equal(evidence.records.length, 2);
  const gone = evidence.records.find((record) => record.selector === '#gone');
  const missing = evidence.records.find((record) => record.selector === '#missing');
  assert.equal(gone.matchCount, 0);
  assert.equal(gone.actionSucceeded, true);
  assert.equal(gone.resolvedOnAction, true);
  assert.equal(missing.matchCount, 0);
  assert.equal(missing.actionSucceeded, false);
  assert.equal(missing.resolvedOnAction, false);

  const other = buildEvidence({
    parts: [
      {
        selector: '#gone',
        api: "locator('#gone')",
        url: 'about:blank',
        matchCount: 1,
        phase: 'action',
        call: 'click',
        negated: false,
        actionSucceeded: true,
        stack,
        testFile: `${workspace}/retry.spec.ts`,
        testLine: 2,
        testTitle: 'click removes the button',
      },
      {
        selector: '#missing',
        api: "locator('#missing')",
        url: 'about:blank',
        matchCount: 0,
        phase: 'action',
        call: 'click',
        negated: false,
        actionSucceeded: false,
        stack,
        testFile: `${workspace}/retry.spec.ts`,
        testLine: 6,
        testTitle: 'click missing fails',
      },
    ],
    workspaceDir: workspace,
    projectDir: '/anywhere/demo',
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    playwrightExitCode: 1,
  });
  assert.notEqual(JSON.stringify(evidence), JSON.stringify(other));
  assert.equal(
    JSON.stringify(evidenceWithoutActionMatchCount(evidence)),
    JSON.stringify(evidenceWithoutActionMatchCount(other)),
  );
  const stripped = JSON.stringify(evidenceWithoutActionMatchCount(evidence));
  assert.equal(stripped.includes('matchCount'), false);
  assert.equal(stripped.includes('"resolvedOnAction":true'), true);
});

test('record order does not follow action matchCount', (t) => {
  const workspace = tempDir(t, 'qcv-order-');
  const stack = `Error\n    at login (${workspace}/support/login.ts:8:5)`;
  const part = (title, line, matchCount) => ({
    selector: '#login-button',
    api: "getByRole('button', { name: 'Login' })",
    url: 'https://www.saucedemo.com/',
    matchCount,
    phase: 'action',
    call: 'click',
    negated: false,
    actionSucceeded: true,
    stack,
    testFile: `${workspace}/tests/good/shopping.spec.ts`,
    testLine: line,
    testTitle: title,
  });
  const input = {
    workspaceDir: workspace,
    projectDir: '/anywhere/demo',
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    playwrightExitCode: 0,
  };
  const lowThenHigh = buildEvidence({
    ...input,
    parts: [part('checks out', 37, 1), part('adds a product', 17, 0)],
  });
  const highThenLow = buildEvidence({
    ...input,
    parts: [part('checks out', 37, 0), part('adds a product', 17, 1)],
  });
  const titles = (evidence) => evidence.records.map((record) => record.testTitle);
  assert.deepEqual(titles(lowThenHigh), ['adds a product', 'checks out']);
  assert.deepEqual(titles(highThenLow), titles(lowThenHigh));
  const sortedByCount = {
    ...lowThenHigh,
    records: [...lowThenHigh.records].sort((left, right) => right.matchCount - left.matchCount),
  };
  assert.deepEqual(titles(sortedByCount), ['checks out', 'adds a product']);
  assert.equal(
    JSON.stringify(evidenceWithoutActionMatchCount(sortedByCount)),
    JSON.stringify(evidenceWithoutActionMatchCount(lowThenHigh)),
  );
  assert.equal(
    JSON.stringify(evidenceWithoutActionMatchCount(highThenLow)),
    JSON.stringify(evidenceWithoutActionMatchCount(lowThenHigh)),
  );
});

test('Workspace paths stay absolute and escape control characters', () => {
  const home = path.join(os.homedir(), 'qcv', 'project');
  assert.equal(formatWorkspacePath(home), path.resolve(home));
  assert.equal(formatWorkspacePath(home).includes('~'), false);
  const outside = path.join(os.tmpdir(), 'qcv-not-home', 'project');
  assert.equal(formatWorkspacePath(outside), path.resolve(outside));
  const messy = path.join(os.tmpdir(), 'qcv-\u0001-run\n\u007f\u0085');
  const formatted = formatWorkspacePath(messy);
  assert.equal(formatted.includes('\u0001'), false);
  assert.equal(formatted.includes('\n'), false);
  assert.equal(formatted.includes('\u007f'), false);
  assert.equal(formatted.includes('\u0085'), false);
  assert.equal(formatted.includes('~'), false);
  assert.match(formatted, /\\u0001/);
  assert.match(formatted, /\\u000a/);
  assert.match(formatted, /\\u007f/);
  assert.match(formatted, /\\u0085/);
  const marked = path.join(os.tmpdir(), 'qcv-\u202Edir\\name');
  const markedPath = formatWorkspacePath(marked);
  assert.equal(markedPath.includes('\u202E'), false);
  assert.match(markedPath, /\\u202e/);
  assert.match(markedPath, /\\\\/);
});

test('planted .qcv-tmp folders are copied byte-identical and the run passes', (t) => {
  const project = tempDir(t, 'qcv-existing-tmp-');
  const scratch = tempDir(t, 'qcv-sig-');
  const out = tempDir(t, 'qcv-signal-out-');
  const top = path.join(project, '.qcv-tmp', 'data.txt');
  const nested = path.join(project, 'tests', '.qcv-tmp', 'data.txt');
  fs.mkdirSync(path.dirname(top));
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  const topBytes = Buffer.from('top-bytes\n');
  const nestedBytes = Buffer.from('nested-bytes\n');
  fs.writeFileSync(top, topBytes);
  fs.writeFileSync(nested, nestedBytes);
  writeProject(project, {
    spec: `import { test, expect } from '@playwright/test';
import fs from 'node:fs';
test('reads user temp files', () => {
  expect(fs.readFileSync('.qcv-tmp/data.txt', 'utf8')).toBe('top-bytes\\n');
  expect(fs.readFileSync('tests/.qcv-tmp/data.txt', 'utf8')).toBe('nested-bytes\\n');
});
`,
  });
  const cli = path.join(repoRoot, 'dist/cli.js');
  const first = spawnSync(
    process.execPath,
    [cli, project, '--only', 'locator-evidence', '--keep-workspace', '--out', out],
    { cwd: repoRoot, encoding: 'utf8', env: privateTempEnv(scratch) },
  );
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(fs.readFileSync(top).equals(topBytes), true);
  assert.equal(fs.readFileSync(nested).equals(nestedBytes), true);
  const kept = parseWorkspaceLine(first.stderr, first.stdout);
  const keptProject = path.join(kept, 'project');
  assert.equal(path.basename(kept).startsWith('qcv-run-'), true, kept);
  assert.equal(kept.startsWith(`${scratch}${path.sep}`), true, kept);
  assert.deepEqual(fs.readdirSync(kept).sort(), ['project']);
  assert.equal(fs.readFileSync(path.join(keptProject, '.qcv-tmp', 'data.txt')).equals(topBytes), true);
  assert.equal(fs.readFileSync(path.join(keptProject, 'tests', '.qcv-tmp', 'data.txt')).equals(nestedBytes), true);
  assert.equal(fs.readdirSync(scratch).some((name) => name.startsWith('.qcv-browser-')), false);

  const scratchAgain = tempDir(t, 'qcv-sig-');
  const outAgain = tempDir(t, 'qcv-signal-out-');
  const again = spawnSync(
    process.execPath,
    [cli, keptProject, '--only', 'locator-evidence', '--keep-workspace', '--out', outAgain],
    { cwd: repoRoot, encoding: 'utf8', env: privateTempEnv(scratchAgain) },
  );
  assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
  assert.equal(fs.readFileSync(top).equals(topBytes), true);
  assert.equal(fs.readFileSync(nested).equals(nestedBytes), true);
  assert.equal(fs.readFileSync(path.join(keptProject, '.qcv-tmp', 'data.txt')).equals(topBytes), true);
  assert.equal(fs.readFileSync(path.join(keptProject, 'tests', '.qcv-tmp', 'data.txt')).equals(nestedBytes), true);
  const keptAgain = parseWorkspaceLine(again.stderr, again.stdout);
  const againProject = path.join(keptAgain, 'project');
  assert.deepEqual(fs.readdirSync(keptAgain).sort(), ['project']);
  assert.equal(fs.readFileSync(path.join(againProject, '.qcv-tmp', 'data.txt')).equals(topBytes), true);
  assert.equal(fs.readFileSync(path.join(againProject, 'tests', '.qcv-tmp', 'data.txt')).equals(nestedBytes), true);
  assert.equal(fs.readdirSync(scratchAgain).some((name) => name.startsWith('.qcv-browser-')), false);
});

test(
  'SIGINT, a second SIGINT, SIGTERM, and SIGHUP leave the private temp directory empty',
  { skip: process.platform !== 'linux' && 'needs /proc', timeout: 120_000 },
  async (t) => {
    const cleanup = bindCleanup(t);
    const project = cleanup.dir('qcv-signal-project-');
    const token = `qcv-signal-marker-${process.pid}.txt`;
    fs.writeFileSync(path.join(project, token), 'marker');
    writeProject(project, {
      spec: `import { test } from '@playwright/test';
test('hang', async ({ page }) => {
  await page.setContent('<p>x</p>');
  await new Promise(() => {});
});
`,
    });
    const cli = path.join(repoRoot, 'dist/cli.js');
    const cases = [
      { signal: 'SIGINT', code: 130, again: false },
      { signal: 'SIGINT', code: 130, again: true },
      { signal: 'SIGTERM', code: 143, again: false },
      { signal: 'SIGHUP', code: 129, again: false },
    ];
    for (const item of cases) {
      const scratch = cleanup.dir('qcv-sig-');
      const out = cleanup.dir('qcv-signal-out-');
      const child = spawn(process.execPath, [cli, project, '--only', 'locator-evidence', '--out', out], {
        stdio: 'ignore',
        env: privateTempEnv(scratch),
      });
      cleanup.stop(() => stopCli(child));
      cleanup.noteTree(child.pid);
      injectFailure('after-spawn');
      const workspace = await waitForMarkedWorkspace(scratch, token, 20_000);
      assert.equal(workspace.startsWith(`${scratch}${path.sep}`), true, workspace);
      const profile = await waitForUserDataDir(scratch, 20_000);
      assert.equal(profile.startsWith(`${scratch}${path.sep}`), true, profile);
      injectFailure('after-profile');
      const browserUp = await waitForBrowser(child.pid, 20_000);
      assert.equal(browserUp, true, `${item.signal} browser did not start`);
      cleanup.noteTree(child.pid);
      await new Promise((resolve) => setTimeout(resolve, 500));
      injectFailure('browser-up');
      cleanup.noteTree(child.pid);
      const exitedPromise = waitForExitCode(child, 15_000);
      child.kill(item.signal);
      if (item.again) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        try {
          child.kill(item.signal);
        } catch {
          // The first signal may already have exited the CLI.
        }
      }
      const exited = await exitedPromise;
      const label = item.again ? `${item.signal} twice` : item.signal;
      assert.equal(exited.code, item.code, `${label} exited ${exited.code} signal ${exited.signal}`);
      injectFailure('after-signal');
      assert.equal(fs.existsSync(workspace), false, workspace);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const left = fs.readdirSync(scratch);
      assert.deepEqual(left, [], `${label} left ${left.join(', ')} in ${scratch}`);
      cleanup.noteTree(child.pid);
      assertNoLeftovers(cleanup.tracked, label);
    }
  },
);

test(
  'keep-workspace prints the run directory on stderr for a normal finish and for SIGINT, SIGTERM, and SIGHUP',
  { skip: process.platform !== 'linux' && 'needs /proc', timeout: 120_000 },
  async (t) => {
    const cleanup = bindCleanup(t);
    const homeTmp = fs.mkdtempSync(path.join(os.homedir(), 'qcv-home-tmp-'));
    cleanup.remove(homeTmp);
    const cli = path.join(repoRoot, 'dist/cli.js');
    const quick = path.join(homeTmp, 'quick');
    const quickScratch = path.join(homeTmp, 'quick-scratch');
    const quickOut = path.join(homeTmp, 'quick-out');
    fs.mkdirSync(quick);
    fs.mkdirSync(quickScratch);
    fs.mkdirSync(quickOut);
    writeProject(quick);
    const finished = spawnSync(
      process.execPath,
      [cli, quick, '--only', 'locator-evidence', '--keep-workspace', '--out', quickOut],
      { cwd: repoRoot, encoding: 'utf8', env: privateTempEnv(quickScratch) },
    );
    assert.equal(finished.status, 0, `${finished.stdout}\n${finished.stderr}`);
    const finishedRun = parseWorkspaceLine(finished.stderr, finished.stdout);
    assert.equal(finishedRun.startsWith(`${homeTmp}${path.sep}`), true, finishedRun);
    assert.equal(path.basename(finishedRun).startsWith('qcv-run-'), true, finishedRun);
    assert.deepEqual(fs.readdirSync(finishedRun).sort(), ['project']);
    assert.equal(fs.existsSync(path.join(finishedRun, 'project', 'retry.spec.ts')), true);

    const project = path.join(homeTmp, 'hang');
    fs.mkdirSync(project);
    const token = `qcv-signal-marker-${process.pid}-keep.txt`;
    fs.writeFileSync(path.join(project, token), 'marker');
    const userFile = path.join(project, 'keep-me.txt');
    fs.writeFileSync(userFile, 'user-owned');
    writeProject(project, {
      spec: `import { test } from '@playwright/test';
test('hang', async ({ page }) => {
  await page.setContent('<p>x</p>');
  await new Promise(() => {});
});
`,
    });
    const signals = [
      { signal: 'SIGINT', code: 130 },
      { signal: 'SIGTERM', code: 143 },
      { signal: 'SIGHUP', code: 129 },
    ];
    for (const item of signals) {
      const scratch = fs.mkdtempSync(path.join(homeTmp, 'qcv-sig-'));
      const out = fs.mkdtempSync(path.join(homeTmp, 'qcv-signal-out-'));
      const child = spawn(
        process.execPath,
        [cli, project, '--only', 'locator-evidence', '--keep-workspace', '--out', out],
        { stdio: ['ignore', 'pipe', 'pipe'], env: privateTempEnv(scratch) },
      );
      cleanup.stop(() => stopCli(child));
      cleanup.noteTree(child.pid);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      const workspace = await waitForMarkedWorkspace(scratch, token, 20_000);
      const browserUp = await waitForBrowser(child.pid, 20_000);
      assert.equal(browserUp, true, `${item.signal} keep-workspace browser did not start`);
      cleanup.noteTree(child.pid);
      await new Promise((resolve) => setTimeout(resolve, 500));
      cleanup.noteTree(child.pid);
      const exitedPromise = waitForExitCode(child, 15_000);
      child.kill(item.signal);
      const exited = await exitedPromise;
      if (!child.stdout.readableEnded) await new Promise((resolve) => child.stdout.once('end', resolve));
      if (!child.stderr.readableEnded) await new Promise((resolve) => child.stderr.once('end', resolve));
      assert.equal(exited.code, item.code, `${item.signal} exited ${exited.code} signal ${exited.signal}`);
      const shown = parseWorkspaceLine(stderr, stdout);
      assert.equal(shown, formatWorkspacePath(path.dirname(workspace)), stderr);
      assert.equal(shown.startsWith(`${homeTmp}${path.sep}`), true, shown);
      assert.equal(path.basename(shown).startsWith('qcv-run-'), true, shown);
      assert.deepEqual(fs.readdirSync(shown).sort(), ['project']);
      assert.equal(fs.readFileSync(path.join(shown, 'project', token), 'utf8'), 'marker');
      assert.equal(fs.readFileSync(userFile, 'utf8'), 'user-owned');
      assert.equal(fs.readdirSync(scratch).some((name) => name.startsWith('.qcv-browser-')), false);
      cleanup.noteTree(child.pid);
      assertNoLeftovers(cleanup.tracked, item.signal);
    }
  },
);

test(
  'an outside Chromium profile and a decoy folder survive signal cleanup',
  { skip: process.platform !== 'linux' && 'needs /proc', timeout: 90_000 },
  async (t) => {
    const cleanup = bindCleanup(t);
    const decoy = cleanup.dir('playwright_chromiumdev_profile-');
    fs.writeFileSync(path.join(decoy, 'keep.txt'), 'decoy');
    const holder = cleanup.dir('qcv-outside-browser-');
    const playwright = pathToFileURL(path.join(repoRoot, 'node_modules/@playwright/test/index.js')).href;
    const script = path.join(holder, 'hold.mjs');
    fs.writeFileSync(
      script,
      `import pkg from ${JSON.stringify(playwright)};
const { chromium } = pkg;
const browser = await chromium.launch({ headless: true });
process.stdout.write('ready\\n');
await new Promise((resolve) => {
  process.stdin.once('data', async () => {
    await browser.close();
    resolve();
  });
});
`,
    );
    const child = spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: privateTempEnv(holder),
    });
    let holderErr = '';
    child.stderr.on('data', (chunk) => {
      holderErr += chunk.toString('utf8');
    });
    cleanup.stop(() => stopHelper(child, 5_000));
    cleanup.noteTree(child.pid);
    injectFailure('after-spawn');
    await readLine(child.stdout, 20_000).catch((error) => {
      throw new Error(`${error.message}\n${holderErr}`);
    });
    const profile = await waitForUserDataDir(holder, 20_000);
    assert.equal(profile.startsWith(`${holder}${path.sep}`), true, profile);
    assert.equal(profile === decoy, false);
    assert.equal(fs.existsSync(path.join(decoy, 'keep.txt')), true);
    assert.equal(commandUsesPath(profile), true, 'outside browser was not using its profile');
    cleanup.noteTree(child.pid);
    injectFailure('after-profile');

    const project = cleanup.dir('qcv-signal-project-');
    const token = `qcv-signal-marker-${process.pid}-decoy.txt`;
    fs.writeFileSync(path.join(project, token), 'marker');
    writeProject(project, {
      spec: `import { test } from '@playwright/test';
test('hang', async ({ page }) => {
  await page.setContent('<p>x</p>');
  await new Promise(() => {});
});
`,
    });
    const scratch = cleanup.dir('qcv-sig-');
    const out = cleanup.dir('qcv-signal-out-');
    const cli = path.join(repoRoot, 'dist/cli.js');
    const cliChild = spawn(process.execPath, [cli, project, '--only', 'locator-evidence', '--out', out], {
      stdio: 'ignore',
      env: privateTempEnv(scratch),
    });
    cleanup.stop(() => stopCli(cliChild));
    cleanup.noteTree(cliChild.pid);
    const workspace = await waitForMarkedWorkspace(scratch, token, 20_000);
    assert.equal(workspace.startsWith(`${scratch}${path.sep}`), true, workspace);
    const browserUp = await waitForBrowser(cliChild.pid, 20_000);
    assert.equal(browserUp, true, 'signal browser did not start');
    cleanup.noteTree(cliChild.pid);
    await new Promise((resolve) => setTimeout(resolve, 500));
    injectFailure('browser-up');
    cleanup.noteTree(cliChild.pid);
    const exitedPromise = waitForExitCode(cliChild, 15_000);
    cliChild.kill('SIGINT');
    const exited = await exitedPromise;
    assert.equal(exited.code, 130, `SIGINT exited ${exited.code} signal ${exited.signal}`);
    injectFailure('after-signal');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const left = fs.readdirSync(scratch);
    assert.deepEqual(left, [], `SIGINT left ${left.join(', ')} in ${scratch}`);
    assert.equal(fs.existsSync(path.join(decoy, 'keep.txt')), true, 'decoy profile was removed');
    assert.equal(fs.existsSync(profile), true, 'outside Chromium profile was removed');
    assert.equal(commandUsesPath(profile), true, 'outside browser died');
    await stopHelper(child, 15_000);
    cleanup.noteTree(child.pid);
    cleanup.noteTree(cliChild.pid);
    assertNoLeftovers(cleanup.tracked, 'outside profile');
  },
);

function readLine(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      stream.off('data', onData);
      reject(new Error(`timed out waiting for a line: ${buf}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      stream.off('data', onData);
      resolve(buf.slice(0, nl).trim());
    };
    stream.on('data', onData);
  });
}

function commandUsesPath(dir) {
  let names = [];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return false;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let command = '';
    try {
      command = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (command.includes(dir)) return true;
  }
  return false;
}

function findTokenDir(root, token, depth) {
  if (depth < 0) return '';
  try {
    if (fs.lstatSync(path.join(root, token)).isFile()) return root;
  } catch {
    // The marker is not in this directory.
  }
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findTokenDir(path.join(root, entry.name), token, depth - 1);
    if (found) return found;
  }
  return '';
}

function waitForMarkedWorkspace(root, token, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = findTokenDir(root, token, 4);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for workspace ${token}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

function waitForBrowser(rootPid, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const poll = () => {
      const pids = [rootPid, ...listDescendantPids(rootPid)];
      for (const pid of pids) {
        let command = '';
        try {
          command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        } catch {
          command = '';
        }
        if (/chrome|chromium|headless_shell/i.test(command)) {
          resolve(true);
          return;
        }
      }
      if (Date.now() - started > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

function waitForExitCode(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      fn();
    };
    const onExit = (code, signal) => finish(() => resolve({ code, signal }));
    const timer = setTimeout(() => finish(() => reject(new Error('child did not exit'))), timeoutMs);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(() => resolve({ code: child.exitCode, signal: child.signalCode }));
    }
  });
}

function waitForUserDataDir(prefix, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = readUserDataDir(prefix);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for --user-data-dir under ${prefix}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

function readUserDataDir(prefix) {
  let names = [];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return '';
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let command = '';
    try {
      command = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    const match = /--user-data-dir=([^\0]+)/.exec(command);
    const dir = match?.[1];
    if (dir && (dir === prefix || dir.startsWith(`${prefix}${path.sep}`))) return dir;
  }
  return '';
}

function hashTree(dir) {
  const files = sourceFiles(dir);
  return files.map((file) => `${path.relative(dir, file)}:${fs.readFileSync(file).toString('hex')}`).join('\n');
}
