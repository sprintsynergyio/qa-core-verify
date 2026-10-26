import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig } from '../dist/config.js';
import { discoverSpecs } from '../dist/inventory/discover.js';
import { parseSpecFile } from '../dist/inventory/parse.js';
import { buildReport } from '../dist/report/model.js';
import { parseBaseline } from '../dist/runtime/baseline.js';
import { evaluateLocatorCheck } from '../dist/runtime/locator-check.js';
import { locatorFixtureSource } from '../dist/runtime/locator-evidence/fixture-source.js';
import { installFixture } from '../dist/runtime/locator-evidence/injected-fixture.js';
import { isAbsence, statusOf } from '../dist/rules/locator-status.js';
import { withCopiedProject } from '../dist/runtime/workspace.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'dist/cli.js');
const projectDir = path.join(repoRoot, 'example-project/saucedemo');
const clock = new Date('2026-10-26T12:00:00Z');

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
    timeout: 120000,
  });
}

function privateEnv(dir) {
  return { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir };
}

function use(overrides) {
  return {
    selector: '#banner',
    api: "locator('#banner')",
    url: 'https://www.saucedemo.com/inventory.html',
    matchCount: 2,
    phase: 'assertion',
    call: 'toBeVisible',
    negated: false,
    actionSucceeded: false,
    resolvedOnAction: false,
    parentCount: null,
    countExpected: null,
    nthIndex: null,
    optionAbsence: false,
    file: 'tests/a.spec.ts',
    line: 4,
    column: 3,
    testFile: 'tests/a.spec.ts',
    testLine: 2,
    testTitle: 'banner',
    ...overrides,
  };
}

test('mergeTests inside the spec is inventoried, and an empty mergeTests call is not a test', (t) => {
  const dir = tempDir(t, 'qcv-merge-');
  const file = path.join(dir, 'merged.spec.ts');
  fs.writeFileSync(
    file,
    `import { test as base, mergeTests, expect } from '@playwright/test';
const other = base.extend({});
const test = mergeTests(base, other);
test('merged', async () => {
  expect(1).toBe(1);
});
const empty = mergeTests();
empty('ignored', async () => {
  expect(2).toBe(2);
});
`,
  );
  const inventory = parseSpecFile(file, emptyConfig());
  assert.deepEqual(
    inventory.tests.map((entry) => entry.titlePath.join(' > ')),
    ['merged'],
  );
  assert.equal(inventory.tests[0].expects[0].matcher, 'toBe');
});

test('testIgnore drops matching files, and an unreadable testIgnore is named without dropping the config', (t) => {
  const dir = tempDir(t, 'qcv-ignore-');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'keep.spec.ts'), 'export {};\n');
  fs.writeFileSync(path.join(dir, 'tests', 'skip-me.spec.ts'), 'export {};\n');
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    "export default { testDir: './tests', testIgnore: '**/skip-*.spec.ts' };\n",
  );
  const ignored = discoverSpecs(dir, [], dir, path.join(dir, 'playwright.config.ts'));
  assert.deepEqual(
    ignored.files.map((file) => path.basename(file)),
    ['keep.spec.ts'],
  );
  assert.match(ignored.method, /testIgnore/);
  assert.match(ignored.method, /Playwright config playwright\.config\.ts/);
  assert.equal(ignored.method.includes('was not applied'), false);

  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    "const skip = ['**/skip-*.spec.ts'];\nexport default { testDir: './tests', testIgnore: skip };\n",
  );
  const unread = discoverSpecs(dir, [], dir, path.join(dir, 'playwright.config.ts'));
  assert.deepEqual(
    unread.files.map((file) => path.basename(file)).sort(),
    ['keep.spec.ts', 'skip-me.spec.ts'],
  );
  assert.match(unread.method, /testIgnore was not applied/);
  assert.match(unread.method, /testDir '\.\/tests'/);
});

test('an array toHaveText of the same length and a stated nth index are not ambiguous', () => {
  assert.equal(statusOf([use({ call: 'toHaveText', countExpected: 2, matchCount: 2 })]), 'unique');
  assert.equal(statusOf([use({ call: 'toContainText', countExpected: 2, matchCount: 2 })]), 'unique');
  assert.equal(statusOf([use({ call: 'toHaveText', countExpected: 1, matchCount: 2 })]), 'ambiguous');
  assert.equal(statusOf([use({ matchCount: 1, parentCount: 2, nthIndex: 1 })]), 'unique');
  assert.equal(statusOf([use({ matchCount: 1, parentCount: 2, nthIndex: null })]), 'ambiguous');
});

test('not.toBeVisible({ visible: false }) is not an absence check', () => {
  assert.equal(isAbsence(use({ call: 'toBeVisible', negated: true, optionAbsence: true, matchCount: 0 })), false);
  assert.equal(isAbsence(use({ call: 'toBeAttached', negated: true, optionAbsence: true, matchCount: 0 })), false);
  assert.equal(isAbsence(use({ call: 'toBeVisible', negated: true, optionAbsence: false, matchCount: 0 })), true);
  assert.equal(isAbsence(use({ call: 'toBeVisible', negated: false, optionAbsence: true, matchCount: 0 })), true);
});

test('report rows sort by line and column as numbers', () => {
  const tests = [
    { title: 'late', titlePath: ['late'], file: path.join(projectDir, 'tests/a.spec.ts'), line: 9, column: 139, modifiers: [], modifierSites: [], expects: [], locators: [], helpers: [], events: [], unresolved: [], floatingCalls: [] },
    { title: 'early', titlePath: ['early'], file: path.join(projectDir, 'tests/a.spec.ts'), line: 9, column: 3, modifiers: [], modifierSites: [], expects: [], locators: [], helpers: [], events: [], unresolved: [], floatingCalls: [] },
  ];
  const report = buildReport({
    projectDir,
    specCount: 1,
    tests,
    skippedDescribes: [],
    findings: [],
    checksRun: ['weak-assertion'],
    startedAt: clock,
    finishedAt: clock,
  });
  assert.deepEqual(
    report.tests.map((entry) => entry.titlePath[0]),
    ['early', 'late'],
  );
});

test('a baseline failure on a shared line does not hide the other test', () => {
  const workspace = '/tmp/qcv-run-example/project';
  const stdout = JSON.stringify({
    config: { rootDir: workspace, projects: [{ testDir: workspace }] },
    suites: [
      {
        specs: [
          {
            file: 'tests/p.spec.ts',
            line: 2,
            column: 1,
            tests: [{ status: 'unexpected', results: [{ status: 'failed' }] }],
          },
          {
            file: 'tests/p.spec.ts',
            line: 2,
            column: 80,
            tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
          },
        ],
      },
    ],
  });
  const baseline = parseBaseline(stdout, '', 1, workspace);
  assert.equal(baseline.ok, true);
  assert.equal(baseline.failedKeys.has('tests/p.spec.ts:2:1'), true);
  assert.equal(baseline.failedKeys.has('tests/p.spec.ts:2:80'), false);
  const tests = [1, 80].map((column, index) => ({
    title: index === 0 ? 'fails' : 'ghost',
    titlePath: [index === 0 ? 'fails' : 'ghost'],
    file: path.join(projectDir, 'tests/p.spec.ts'),
    line: 2,
    column,
    evidenceColumns: [column, column + 4],
    modifiers: [],
    modifierSites: [],
    expects: [],
    locators: [],
    helpers: [],
    events: [],
    unresolved: [],
    floatingCalls: [],
  }));
  const evidence = {
    schemaVersion: 1,
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    project: { dir: 'example' },
    playwrightExitCode: 0,
    records: [
      use({
        selector: '#ghost',
        api: "locator('#ghost')",
        call: 'toBeHidden',
        matchCount: 0,
        testFile: 'tests/p.spec.ts',
        testLine: 2,
        testColumn: 80,
        testTitle: 'ghost',
        file: 'tests/p.spec.ts',
        line: 2,
      }),
    ],
  };
  const result = evaluateLocatorCheck(projectDir, tests, evidence, baseline);
  const report = buildReport({
    projectDir,
    specCount: 1,
    tests,
    skippedDescribes: [],
    findings: result.findings,
    checksRun: ['locator'],
    startedAt: clock,
    finishedAt: clock,
    baselineRed: result.baselineRed,
    notRun: result.notRun,
    locatorSummaries: result.summaries,
  });
  const fails = report.tests.find((entry) => entry.titlePath[0] === 'fails');
  const ghost = report.tests.find((entry) => entry.titlePath[0] === 'ghost');
  assert.equal(fails.verdict, 'baseline-red');
  assert.equal(ghost.verdict, 'review');
  assert.equal(ghost.findings.some((finding) => finding.ruleId === 'QCV-L002'), true);
});

test('an evidence run with no records and a non-zero exit is not-run', () => {
  const tests = [
    {
      title: 'ghost',
      titlePath: ['ghost'],
      file: path.join(projectDir, 'tests/m.spec.ts'),
      line: 2,
      column: 1,
      modifiers: [],
      modifierSites: [],
      expects: [],
      locators: [],
      helpers: [],
      events: [],
      unresolved: [],
      floatingCalls: [],
    },
  ];
  const seen = {
    ok: true,
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    failedKeys: new Set(),
    seenKeys: new Set(['tests/m.spec.ts:2:1']),
    skippedKeys: new Set(),
    stdout: '',
    stderr: '',
  };
  const emptyFailed = {
    schemaVersion: 1,
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    project: { dir: 'example' },
    playwrightExitCode: 1,
    records: [],
  };
  const failed = evaluateLocatorCheck(projectDir, tests, emptyFailed, seen);
  assert.equal(failed.notRun.size, 1);
  assert.equal(failed.findings.length, 0);
  const quiet = { ...emptyFailed, playwrightExitCode: 0 };
  const passed = evaluateLocatorCheck(projectDir, tests, quiet, seen);
  assert.equal(passed.notRun.size, 0);
});

test('the generated fixture wraps contentFrame and expect.configure, and an mjs spec points at the esm fixture', (t) => {
  const source = locatorFixtureSource();
  assert.match(source, /locator\.contentFrame = function/);
  assert.equal(/locator\.contentFrame = async function/.test(source), false);
  assert.match(source, /return remember\(frame, store\)/);
  assert.match(source, /function wrapFrame/);
  assert.match(source, /prop === 'configure'/);
  assert.match(source, /return wrapExpect\(configured\)/);
  assert.match(source, /name === 'nth'/);
  assert.match(source, /function listLength/);
  const project = tempDir(t, 'qcv-mjs-');
  fs.mkdirSync(path.join(project, 'tests'));
  fs.writeFileSync(
    path.join(project, 'tests', 'm.spec.mjs'),
    "import { test, expect } from '@playwright/test';\ntest('mjs ghost', async ({ page }) => { await expect(page.locator('#ghost')).toBeHidden(); });\n",
  );
  installFixture(project);
  assert.equal(fs.existsSync(path.join(project, 'qcv-locator-fixture.mjs')), true);
  const rewritten = fs.readFileSync(path.join(project, 'tests', 'm.spec.mjs'), 'utf8');
  assert.match(rewritten, /qcv-locator-fixture\.mjs/);
  assert.equal(rewritten.includes('@playwright/test'), false);
});

test('the QCV-L004 summary uses the finding call site', () => {
  const config = emptyConfig();
  const inventory = parseSpecFile(path.join(projectDir, 'tests/ai-style/locators.spec.ts'), config);
  const chain = inventory.tests.find((entry) => entry.titlePath.join(' > ') === 'login form through a long css chain');
  assert.ok(chain);
  const relative = 'tests/ai-style/locators.spec.ts';
  const evidence = {
    schemaVersion: 1,
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    project: { dir: 'saucedemo' },
    playwrightExitCode: 0,
    records: [
      use({
        selector: 'div#root > div.login_container',
        api: "locator('div#root > div.login_container > div.login_wrapper > div.login_wrapper-inner > div#login_button_container.form_column > div.login-box > form')",
        call: 'toBeVisible',
        matchCount: 1,
        file: relative,
        line: 27,
        column: 5,
        testFile: relative,
        testLine: chain.line,
        testColumn: chain.column,
        testTitle: 'login form through a long css chain',
      }),
    ],
  };
  const baseline = {
    ok: true,
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    failedKeys: new Set(),
    seenKeys: new Set([`${relative}:${chain.line}:${chain.column}`]),
    skippedKeys: new Set(),
    stdout: '',
    stderr: '',
  };
  const result = evaluateLocatorCheck(projectDir, inventory.tests, evidence, baseline);
  const id = [...result.summaries.keys()].find((key) => key.includes('login form through a long css chain'));
  assert.ok(id, [...result.summaries.keys()].join('\n'));
  const summary = result.summaries.get(id)[0];
  const finding = result.findings.find((entry) => entry.ruleId === 'QCV-L004');
  assert.equal(finding.line, 23);
  assert.equal(summary.line, finding.line);
  assert.equal(summary.column, finding.column);
});

test('--config . is accepted when the project directory holds a playwright config', (t) => {
  const project = tempDir(t, 'qcv-dotcfg-');
  const scratch = tempDir(t, 'qcv-dotcfg-tmp-');
  const out = tempDir(t, 'qcv-dotcfg-out-');
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0, testDir: '.', timeout: 10000 });\n",
  );
  fs.writeFileSync(
    path.join(project, 'sample.spec.ts'),
    "import { test, expect } from '@playwright/test';\ntest('adds', () => { expect(1 + 1).toBe(2); });\n",
  );
  const result = runCli([project, '--only', 'locator', '--config', '.', '--out', out], privateEnv(scratch), project);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 1 passed, 0 failed, 0 skipped/);
  assert.equal(result.stderr.includes('outside the project'), false);
  assert.equal(fs.readdirSync(scratch).length, 0);
});

test('a broken config prints the first error line with the Playwright tail', (t) => {
  const project = tempDir(t, 'qcv-badtail-');
  const scratch = tempDir(t, 'qcv-badtail-tmp-');
  const out = tempDir(t, 'qcv-badtail-out-');
  const frames = Array.from({ length: 30 }, (_, index) => `    at stackFrame${index} (/tmp/x.js:${index}:1)`).join('\n');
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    `throw new Error(['CONFIG_MARKER_ERROR', ${JSON.stringify(frames)}].join('\\n'));\n`,
  );
  fs.writeFileSync(
    path.join(project, 'sample.spec.ts'),
    "import { test, expect } from '@playwright/test';\ntest('adds', () => { expect(1).toBe(1); });\n",
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch), project);
  assert.equal(result.status === 1 || result.status === 2, true, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Playwright produced no baseline report/);
  assert.match(result.stderr, /CONFIG_MARKER_ERROR/);
  assert.equal(fs.existsSync(path.join(out, 'report.json')), false);
});

test('a symlink loop message names the path in the copy', async (t) => {
  const project = tempDir(t, 'qcv-loop-');
  fs.mkdirSync(path.join(project, 'sibA'));
  fs.mkdirSync(path.join(project, 'sibB'));
  fs.writeFileSync(path.join(project, 'sibA', 'note.txt'), 'a\n');
  fs.symlinkSync('../sibB', path.join(project, 'sibA', 'toB'));
  fs.symlinkSync('../sibA', path.join(project, 'sibB', 'toA'));
  const copied = await withCopiedProject(project, { keep: false }, async (session) => session.skippedLinks);
  const links = copied.result.join('\n');
  assert.match(links, /sibA\/toB\/toA/);
  assert.match(links, /\(real sibA\)/);
});

test('a directory link dag stops at the copy byte cap', async (t) => {
  const project = tempDir(t, 'qcv-dag-');
  const base = path.join(project, 'base');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'blob.bin'), Buffer.alloc(128 * 1024, 1));
  let previous = 'base';
  for (let level = 1; level <= 6; level += 1) {
    const dir = path.join(project, `l${level}`);
    fs.mkdirSync(dir);
    fs.symlinkSync(`../${previous}`, path.join(dir, 'a'));
    fs.symlinkSync(`../${previous}`, path.join(dir, 'b'));
    previous = `l${level}`;
  }
  await assert.rejects(
    () => withCopiedProject(project, { keep: false }, async () => {}),
    /The temp copy stopped at \d+ bytes/,
  );
});
