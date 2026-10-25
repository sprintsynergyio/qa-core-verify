import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEvidence, callSiteFromStack, evidenceWithoutActionMatchCount } from '../dist/runtime/locator-evidence/evidence.js';
import { collectLocatorEvidence, rewritePlaywrightImports } from '../dist/runtime/locator-evidence/injected-fixture.js';
import { assertWorkspaceFile, listDescendantPids } from '../dist/runtime/workspace.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sauceDemo = path.join(repoRoot, 'example-project/saucedemo');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
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

test('call sites and evidence paths stay project relative and drop control characters', () => {
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
  assert.equal(evidence.records.length, 1);
  const record = evidence.records[0];
  assert.equal(record.selector, 'see  #banner');
  assert.equal(record.file, 'tests/a.spec.ts');
  assert.equal(record.testFile, 'tests/a.spec.ts');
  assert.equal(record.testTitle, 'banner hidden');
  assert.equal(record.matchCount, 0);
  assert.equal(record.actionSucceeded, false);
  assert.equal(record.resolvedOnAction, false);
  assert.equal(JSON.stringify(evidence).includes('\u202E'), false);
  assert.equal(JSON.stringify(evidence).includes('\u009B'), false);
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
  const run = await collectLocatorEvidence({
    projectDir: project,
    outDir: path.join(project, '.qa-core', 'verify'),
    keepWorkspace: false,
  });
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
    const run = await collectLocatorEvidence({
      projectDir: project,
      outDir: path.join(project, '.qa-core', 'verify'),
      keepWorkspace: false,
    });
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
  const run = await collectLocatorEvidence({
    projectDir: project,
    outDir: path.join(project, '.qa-core', 'verify'),
    keepWorkspace: true,
  });
  t.after(() => fs.rmSync(run.workspaceDir, { recursive: true, force: true }));
  assert.equal(run.kept, true);
  assert.equal(fs.existsSync(run.workspaceDir), true);
  const link = path.join(run.workspaceDir, 'node_modules');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  const spec = fs.readFileSync(path.join(run.workspaceDir, 'retry.spec.ts'), 'utf8');
  assert.match(spec, /qcv-locator-fixture\.js/);
  assert.equal(spec.includes('@playwright/test'), false);
  const config = fs.readFileSync(path.join(run.workspaceDir, 'playwright.config.ts'), 'utf8');
  assert.match(config, /@playwright\/test/);
  fs.rmSync(run.workspaceDir, { recursive: true, force: true });
  assert.equal(fs.readFileSync(modules).equals(marker), true);
});

test('the cli prints an outside --out path as typed and still writes the evidence file', (t) => {
  const parent = tempDir(t, 'qcv-cli-parent-');
  const project = path.join(parent, 'proj');
  fs.mkdirSync(project);
  writeProject(project);
  const cli = path.join(repoRoot, 'dist/cli.js');
  const result = spawnSync(
    process.execPath,
    [cli, '.', '--only', 'locator-evidence', '--out', '../evidence-out'],
    { cwd: project, encoding: 'utf8' },
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
  const failed = spawnSync(process.execPath, [cli, failing, '--only', 'locator-evidence', '--out', path.join(parent, 'fail-out')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(fs.existsSync(path.join(parent, 'fail-out', 'locator-evidence.json')), true);
});

test('locator evidence on SauceDemo is skipped unless QCV_LIVE=1', { skip: process.env.QCV_LIVE !== '1' }, async (t) => {
  const copy = tempDir(t, 'qcv-sauce-');
  const before = hashTree(sauceDemo);
  fs.cpSync(sauceDemo, copy, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return source === sauceDemo || !['node_modules', '.qa-core', 'test-results', 'playwright-report', '.git'].includes(base);
    },
  });
  const out = tempDir(t, 'qcv-sauce-out-');
  const run = await collectLocatorEvidence({ projectDir: copy, outDir: out, keepWorkspace: false });
  assert.equal(hashTree(sauceDemo), before);
  assert.equal(fs.existsSync(path.join(sauceDemo, '.qa-core')), false);
  assert.equal(run.evidence.playwrightExitCode, 0);
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
  const out = tempDir(t, 'qcv-symlink-out-');
  const cli = path.join(repoRoot, 'dist/cli.js');
  const result = spawnSync(
    process.execPath,
    [cli, project, '--only', 'locator-evidence', '--keep-workspace', '--out', out],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const match = /Workspace: (\S+)/.exec(result.stdout);
  assert.ok(match, result.stdout);
  const workspace = match[1];
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
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
  const run = await collectLocatorEvidence({
    projectDir: project,
    outDir: path.join(project, '.qa-core', 'verify'),
    keepWorkspace: false,
  });
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

test('record order does not follow action matchCount', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-order-'));
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

test('SIGINT, a second SIGINT, SIGTERM, and SIGHUP remove the temp workspace after the page is open', { timeout: 120_000 }, async (t) => {
  const project = tempDir(t, 'qcv-signal-project-');
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
    const out = tempDir(t, 'qcv-signal-out-');
    const child = spawn(process.execPath, [cli, project, '--only', 'locator-evidence', '--out', out], {
      stdio: 'ignore',
    });
    t.after(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The CLI may already have exited.
      }
    });
    const workspace = await waitForMarkedWorkspace(token, 20_000);
    const browserUp = await waitForBrowser(child.pid, 20_000);
    assert.equal(browserUp, true, `${item.signal} browser did not start`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const exitedPromise = waitForExit(child, 15_000);
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
    assert.equal(fs.existsSync(workspace), false, workspace);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(fs.existsSync(workspace), false, `${label} left ${workspace}`);
  }
});

function waitForMarkedWorkspace(token, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      let names = [];
      try {
        names = fs.readdirSync(os.tmpdir());
      } catch {
        names = [];
      }
      for (const name of names) {
        if (!name.startsWith('qcv-workspace-')) continue;
        const dir = path.join(os.tmpdir(), name);
        if (fs.existsSync(path.join(dir, token))) {
          resolve(dir);
          return;
        }
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

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child did not exit'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function hashTree(dir) {
  const files = sourceFiles(dir);
  return files.map((file) => `${path.relative(dir, file)}:${fs.readFileSync(file).toString('hex')}`).join('\n');
}
