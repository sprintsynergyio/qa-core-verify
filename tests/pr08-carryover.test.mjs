import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig } from '../dist/config.js';
import { parseSpecFile } from '../dist/inventory/parse.js';
import { buildReport } from '../dist/report/model.js';
import { formatConsoleReport } from '../dist/report/console.js';
import { evaluateLocatorCheck } from '../dist/runtime/locator-check.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'dist/cli.js');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args, env, cwd = repoRoot) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: 180000,
  });
}

function privateEnv(dir) {
  return { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir };
}

function writeConfig(dir, extra = '') {
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({ retries: 0, timeout: 10000, testDir: '.', use: { headless: true }${extra} });
`,
  );
}

test('a relative namespace, a const alias, and a comma call are inventory rows', (t) => {
  const dir = tempDir(t, 'qcv-alias-');
  fs.writeFileSync(
    path.join(dir, 'fixtures.ts'),
    "import { test, expect } from '@playwright/test';\nexport { test, expect };\n",
  );
  fs.writeFileSync(
    path.join(dir, 'alias.spec.ts'),
    `import { test, expect } from '@playwright/test';
import * as pw from './fixtures';
const it = test;
it('aliased', () => { expect(1).toBe(1); });
(0, test)('comma', () => { expect(1).toBe(1); });
pw.test('from namespace', async ({ page }) => {
  await pw.expect(page.locator('#login')).toBeVisible();
});
test.describe(() => {
  const spec = test;
  spec('inside describe', () => { expect(1).toBe(1); });
});
test.describe(() => {
  test('a8', () => { expect(1).toBe(1); });
});
test /* c */ ('a7', () => { expect(1).toBe(1); }); test('a8b', () => { expect(1).toBe(1); });
`,
  );
  const inventory = parseSpecFile(path.join(dir, 'alias.spec.ts'), emptyConfig());
  const titles = inventory.tests.map((item) => item.titlePath.join(' > '));
  assert.deepEqual(titles, ['aliased', 'comma', 'from namespace', 'inside describe', 'a8', 'a7', 'a8b']);
  const namespace = inventory.tests.find((item) => item.title === 'from namespace');
  assert.equal(namespace.expects[0].matcher, 'toBeVisible');
  assert.equal(namespace.expects[0].subjectSource, "page.locator('#login')");
  const commented = inventory.tests.find((item) => item.title === 'a7');
  const source = fs.readFileSync(path.join(dir, 'alias.spec.ts'), 'utf8');
  const line = source.split('\n').find((entry) => entry.includes('a7'));
  const paren = line.indexOf('(') + 1;
  assert.equal(commented.evidenceColumns.includes(paren), true, commented.evidenceColumns.join(','));
  assert.equal(titles.some((title) => title.includes('=>')), false);
});

test('a directory with no playwright config names that fact', (t) => {
  const dir = tempDir(t, 'qcv-noconfig-');
  const scratch = tempDir(t, 'qcv-noconfig-tmp-');
  const result = runCli([dir, '--only', 'faults', '--config', dir], privateEnv(scratch), dir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /The directory holds no playwright\.config\.\* file/);
  assert.equal(result.stderr.includes('Playwright config does not exist'), false);
});

test('a test that fails only in the evidence run prints the reason', () => {
  const projectDir = path.join(repoRoot, 'example-project/saucedemo');
  const file = path.join(projectDir, 'tests/a.spec.ts');
  const item = {
    title: 'banner',
    titlePath: ['banner'],
    file,
    line: 2,
    column: 1,
    evidenceColumns: [1],
    modifiers: [],
    modifierSites: [],
    expects: [],
    locators: [],
    helpers: [],
    events: [],
    unresolved: [],
    floatingCalls: [],
  };
  const seen = new Set(['tests/a.spec.ts:2:1']);
  const baseline = {
    ok: true,
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    failedKeys: new Set(),
    seenKeys: seen,
    skippedKeys: new Set(),
    stdout: '',
    stderr: '',
  };
  const evidenceRun = {
    ...baseline,
    exitCode: 1,
    passed: 0,
    failed: 1,
    failedKeys: new Set(['tests/a.spec.ts:2:1']),
  };
  const evidence = {
    schemaVersion: 1,
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    project: { dir: 'example' },
    playwrightExitCode: 1,
    records: [],
  };
  const result = evaluateLocatorCheck(projectDir, [item], evidence, baseline, evidenceRun);
  const report = buildReport({
    projectDir,
    specCount: 1,
    tests: [item],
    skippedDescribes: [],
    findings: result.findings,
    checksRun: ['locator'],
    startedAt: new Date('2026-10-27T00:00:00Z'),
    finishedAt: new Date('2026-10-27T00:00:00Z'),
    baselineRed: result.baselineRed,
    notRun: result.notRun,
    locatorSummaries: result.summaries,
    statusReasons: result.statusReasons,
  });
  assert.equal(report.tests[0].verdict, 'not-run');
  assert.equal(report.tests[0].reason, 'The test did not pass in the evidence run.');
  assert.match(formatConsoleReport(report, []), /Reason: The test did not pass in the evidence run\./);
});

test('a mode 444 spec still finishes inversion and prints the workspace', (t) => {
  const project = tempDir(t, 'qcv-ro-');
  const scratch = tempDir(t, 'qcv-ro-tmp-');
  const out = tempDir(t, 'qcv-ro-out-');
  writeConfig(project);
  const spec = path.join(project, 'ro.spec.ts');
  fs.writeFileSync(
    spec,
    "import { test, expect } from '@playwright/test';\ntest('adds', () => { expect(1).toBe(1); });\n",
  );
  fs.chmodSync(spec, 0o444);
  const before = fs.readFileSync(spec);
  const result = runCli([project, '--only', 'inversion', '--keep-workspace', '--out', out], privateEnv(scratch));
  assert.equal(result.status === 0 || result.status === 1, true, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr.includes('EACCES'), false, result.stderr);
  assert.match(result.stderr, /Workspace:/);
  const baselineAt = result.stderr.indexOf('Baseline:');
  const planAt = result.stderr.indexOf('Inversion plan:');
  const timeAt = result.stderr.indexOf('Inversion time:');
  assert.equal(baselineAt >= 0 && planAt > baselineAt && timeAt > planAt, true, result.stderr);
  assert.match(result.stderr, /Control runs are already finished/);
  assert.deepEqual(fs.readFileSync(spec), before);
  assert.equal(fs.statSync(spec).mode & 0o777, 0o444);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const outcomes = (report.tests[0].assertions ?? []).map((assertion) => assertion.outcome);
  assert.equal(outcomes.includes('killed'), true, JSON.stringify(report.tests[0].assertions));
  assert.equal(fs.existsSync(path.join(out, 'report.json')), true);
});

test('a broken config maps the temp copy path back to the project', (t) => {
  const project = tempDir(t, 'qcv-remap-');
  const scratch = tempDir(t, 'qcv-remap-tmp-');
  const out = tempDir(t, 'qcv-remap-out-');
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "throw new Error('CONFIG_MARKER_ERROR');\n",
  );
  fs.writeFileSync(
    path.join(project, 'sample.spec.ts'),
    "import { test, expect } from '@playwright/test';\ntest('adds', () => { expect(1).toBe(1); });\n",
  );
  const result = runCli([project, '--only', 'inversion', '--keep-workspace', '--out', out], privateEnv(scratch));
  assert.equal(result.status === 1 || result.status === 2, true, result.stderr);
  assert.match(result.stderr, /Playwright produced no baseline report/);
  assert.match(result.stderr, /CONFIG_MARKER_ERROR/);
  const withoutWorkspace = result.stderr.replace(/Workspace:.*\n/g, '');
  assert.equal(withoutWorkspace.includes('qcv-run-'), false, result.stderr);
  assert.match(result.stderr, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.stderr, /Workspace:/);
});

test('duplicate titles print the load error and exit 2', (t) => {
  const project = tempDir(t, 'qcv-dup-');
  const scratch = tempDir(t, 'qcv-dup-tmp-');
  const out = tempDir(t, 'qcv-dup-out-');
  writeConfig(project);
  fs.writeFileSync(
    path.join(project, 'dup.spec.ts'),
    `import { test, expect } from '@playwright/test';
test('same', () => { expect(1).toBe(1); });
test('same', () => { expect(1).toBe(1); });
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Playwright failed to load the suite/);
  assert.equal(result.stderr.includes('after a green baseline'), false, result.stderr);
  assert.equal(result.stderr.includes('Baseline:'), false, result.stderr);
  assert.equal(result.stderr.includes('qcv-run-'), false, result.stderr);
  assert.match(result.stderr, /dup\.spec\.ts/);
  assert.equal(fs.existsSync(path.join(out, 'report.json')), false);
});

test('a comment between test and the parenthesis still matches the locator row', (t) => {
  const project = tempDir(t, 'qcv-col-');
  const scratch = tempDir(t, 'qcv-col-tmp-');
  const out = tempDir(t, 'qcv-col-out-');
  writeConfig(project);
  fs.writeFileSync(
    path.join(project, 'cols.spec.ts'),
    `import { test, expect } from '@playwright/test';
test /* c */ ('a7', () => { expect(1).toBe(1); }); test('a8', () => { expect(1).toBe(1); });
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const rows = report.tests.map((entry) => `${entry.titlePath.at(-1)} ${entry.verdict}`);
  assert.deepEqual(rows, ['a7 trusted', 'a8 trusted']);
  assert.equal(report.tests.some((entry) => entry.reason), false);
});

test('frameLocator owner is recorded', async (t) => {
  const project = tempDir(t, 'qcv-owner-');
  const scratch = tempDir(t, 'qcv-owner-tmp-');
  const out = tempDir(t, 'qcv-owner-out-');
  const port = await reservePort();
  fs.writeFileSync(
    path.join(project, 'server.mjs'),
    `import http from 'node:http';
const page = '<!doctype html><iframe id="frame" src="/frame.html"></iframe>';
const frame = '<!doctype html><p id="inside">Inside</p>';
http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(url === '/frame.html' ? frame : page);
}).listen(${port}, '127.0.0.1');
`,
  );
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({
  retries: 0,
  timeout: 10000,
  testDir: '.',
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:${port}', timeout: 10000, reuseExistingServer: false },
  use: { baseURL: 'http://127.0.0.1:${port}', headless: true },
});
`,
  );
  fs.writeFileSync(
    path.join(project, 'owner.spec.ts'),
    `import { test, expect } from '@playwright/test';
test('frame owner', async ({ page }) => {
  await page.goto('/page.html');
  await expect(page.frameLocator('#frame').owner()).toBeVisible();
});
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.status === 0 || result.status === 1, true, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const row = report.tests.find((entry) => entry.titlePath.includes('frame owner'));
  assert.ok(row, report.tests.map((entry) => entry.titlePath.join(' > ')).join('\n'));
  assert.equal(row.verdict === 'not-run', false, JSON.stringify(row));
  assert.equal((row.locators ?? []).length > 0, true, JSON.stringify(row));
});

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
