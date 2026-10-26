import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { locatorFixtureSource } from '../dist/runtime/locator-evidence/fixture-source.js';
import { collectLocatorEvidence, installFixture } from '../dist/runtime/locator-evidence/injected-fixture.js';
import { playwrightSupervisorSource } from '../dist/runtime/workspace.js';

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
    timeout: 120000,
  });
}

function workspaceFrom(stderr) {
  const line = stderr.split(/\r?\n/).find((item) => item.startsWith('Workspace: '));
  assert.ok(line, stderr);
  return line.slice('Workspace: '.length);
}

function writeTiny(dir, spec) {
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0, testDir: '.', timeout: 10000 });\n",
  );
  fs.writeFileSync(path.join(dir, 'sample.spec.ts'), spec);
}

const ADD_SPEC = `import { test, expect } from '@playwright/test';
test('adds', () => {
  expect(1 + 1).toBe(2);
});
`;

test('the fixture re-exports @playwright/test and skips playwright config files', (t) => {
  const source = locatorFixtureSource();
  assert.match(source, /export \* from '@playwright\/test'/);
  assert.match(source, /function wrapFrame/);
  assert.match(source, /context\.newPage/);
  assert.match(source, /context\.on\('page'/);
  assert.match(source, /if \(counted === null && !actionSucceeded\) return/);
  assert.match(source, /const stack = callStack\(\)/);
  assert.match(source, /fs\.writeSync\(fd, JSON\.stringify\(entry\)/);
  const project = tempDir(t, 'qcv-config-skip-');
  fs.writeFileSync(path.join(project, 'playwright.config.cts'), "import { devices } from '@playwright/test';\nexport default { projects: [{ name: 'c', use: devices['Desktop Chrome'] }] };\n");
  fs.writeFileSync(path.join(project, 'custom.config.ts'), "import { defineConfig } from '@playwright/test';\nexport default defineConfig({});\n");
  fs.writeFileSync(path.join(project, 'sample.spec.ts'), "import { test } from '@playwright/test';\ntest('x', () => {});\n");
  installFixture(project, 'custom.config.ts');
  assert.match(fs.readFileSync(path.join(project, 'playwright.config.cts'), 'utf8'), /@playwright\/test/);
  assert.match(fs.readFileSync(path.join(project, 'custom.config.ts'), 'utf8'), /@playwright\/test/);
  assert.equal(fs.readFileSync(path.join(project, 'sample.spec.ts'), 'utf8').includes('@playwright/test'), false);
});

test('a later run leaves a kept workspace and an unrelated qcv-workspace directory', (t) => {
  const scratch = tempDir(t, 'qcv-nosweep-');
  const notes = path.join(scratch, 'qcv-workspace-my-notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'note.txt'), 'keep me\n');
  const project = tempDir(t, 'qcv-nosweep-proj-');
  const out = tempDir(t, 'qcv-nosweep-out-');
  writeTiny(project, ADD_SPEC);
  const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
  const first = runCli([project, '--only', 'locator-evidence', '--keep-workspace', '--out', out], env);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const kept = workspaceFrom(first.stderr);
  t.after(() => fs.rmSync(kept, { recursive: true, force: true }));
  assert.equal(fs.existsSync(path.join(kept, 'project', 'sample.spec.ts')), true);
  const second = runCli([project, '--only', 'locator-evidence', '--out', out], env);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(fs.readFileSync(path.join(notes, 'note.txt'), 'utf8'), 'keep me\n');
  assert.equal(fs.existsSync(path.join(kept, 'project', 'sample.spec.ts')), true);
});

test('the parent-death watchdog stops the child and removes the run', { skip: process.platform !== 'linux' }, async (t) => {
  const root = tempDir(t, 'qcv-watch-');
  const runRoot = path.join(root, 'qcv-run-watched');
  fs.mkdirSync(runRoot);
  const script = path.join(root, 'qcv-supervisor.mjs');
  fs.writeFileSync(script, playwrightSupervisorSource());
  const child = spawn(process.execPath, [script, process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    env: {
      ...process.env,
      QCV_PARENT_PID: '2147483646',
      QCV_RUN_ROOT: runRoot,
      QCV_KEEP: '0',
      QCV_BROWSER_TMP: '',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // The watchdog already stopped it.
    }
  });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 4000);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 1);
  assert.equal(fs.existsSync(runRoot), false);
});

test('a broken config prints the Playwright tail when no records were written', (t) => {
  const project = tempDir(t, 'qcv-broken-');
  const scratch = tempDir(t, 'qcv-broken-tmp-');
  const out = tempDir(t, 'qcv-broken-out-');
  fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {\n');
  fs.writeFileSync(path.join(project, 'sample.spec.ts'), ADD_SPEC);
  const result = runCli([project, '--only', 'locator-evidence', '--out', out], {
    ...process.env,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Records: 0/);
  assert.match(result.stderr, /Playwright produced no locator records/);
  assert.match(result.stderr, /BABEL_PARSE_ERROR|UnexpectedToken|SyntaxError|playwright\.config/);
  assert.equal(result.stderr.split('\n').filter((line) => line.trim().length > 0).length > 1, true);
});

test('two cli evidence runs with no --out are byte identical and leave the suite unchanged', (t) => {
  const project = tempDir(t, 'qcv-bytes-');
  const scratch = tempDir(t, 'qcv-bytes-tmp-');
  writeTiny(project, ADD_SPEC);
  const before = fs.readFileSync(path.join(project, 'sample.spec.ts'));
  const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
  const first = runCli([project, '--only', 'locator-evidence'], env);
  assert.equal(first.status, 0, first.stderr);
  const evidencePath = path.join(project, '.qa-core', 'verify', 'locator-evidence.json');
  const bytes = fs.readFileSync(evidencePath);
  const second = runCli([project, '--only', 'locator-evidence'], env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(evidencePath).equals(bytes), true);
  assert.equal(fs.readFileSync(path.join(project, 'sample.spec.ts')).equals(before), true);
  assert.match(first.stdout, /Locator evidence:/);
});

test('a typed --out with a control character is escaped on the console', (t) => {
  const project = tempDir(t, 'qcv-out-');
  const scratch = tempDir(t, 'qcv-out-tmp-');
  const parent = tempDir(t, 'qcv-out-parent-');
  writeTiny(project, ADD_SPEC);
  const out = path.join(parent, 'rep\u0001ort');
  const result = runCli([project, '--only', 'locator-evidence', '--out', out], {
    ...process.env,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('\u0001'), false);
  assert.match(result.stdout, /\\u0001/);
  assert.equal(fs.existsSync(path.join(out, 'locator-evidence.json')), true);
  assert.equal(result.stdout.includes(out), false);
});

test('a missing project with --keep-workspace prints no Workspace line', (t) => {
  const scratch = tempDir(t, 'qcv-missing-');
  const result = runCli([path.join(scratch, 'missing'), '--only', 'locator-evidence', '--keep-workspace'], {
    ...process.env,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not exist/);
  assert.doesNotMatch(result.stderr, /Workspace:/);
  assert.equal(result.stdout, '');
});

test('wrapped pages, frames, parent counts, and skipped links are recorded', async (t) => {
  const project = tempDir(t, 'qcv-carry-');
  const scratch = tempDir(t, 'qcv-carry-tmp-');
  writeTiny(
    project,
    `import { test, expect, devices, chromium } from '@playwright/test';

test('exports names', () => {
  expect(devices['Desktop Chrome'].defaultBrowserType).toBe('chromium');
  expect(typeof chromium.launch).toBe('function');
});

test('frame button', async ({ page }) => {
  await page.setContent('<iframe srcdoc="<button id=ok>Ok</button>"></iframe>');
  await page.frameLocator('iframe').locator('#ok').click();
});

test('second page', async ({ page }) => {
  const created = await page.context().newPage();
  await created.setContent('<button id="p">P</button>');
  await created.locator('#p').click();
});

test('popup page', async ({ page }) => {
  await page.setContent('<button id="open">open</button>');
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('#open').evaluate((button) => {
      button.addEventListener('click', () => window.open('about:blank'));
      button.click();
    }),
  ]);
  await popup.setContent('<button id="x">x</button>');
  await popup.locator('#x').click();
});

test('narrows', async ({ page }) => {
  await page.setContent('<button id="a">A</button><button id="b">B</button>');
  await page.locator('button').first().click();
});

test('floating expect', async ({ page }) => {
  await page.setContent('<p>Products</p>');
  expect(page.getByText('Products')).toBeTruthy();
});

test('keeps a control in the test id', async ({ page }) => {
  await page.setContent('<div data-testid="a\\u0085b">z</div>');
  await page.getByTestId('a\\u0085b').click();
});

test('two clicks', async ({ page }) => {
  await page.setContent('<button id="a">A</button><button id="b">B</button>');
  await page.locator('#a').click();
  await page.locator('#b').click();
});
`,
  );
  fs.symlinkSync(path.join(project, 'no-such-target'), path.join(project, 'dangling-link'));
  fs.symlinkSync('self-loop', path.join(project, 'self-loop'));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = scratch;
  process.env.TMP = scratch;
  process.env.TEMP = scratch;
  let run;
  try {
    run = await collectLocatorEvidence({
      projectDir: project,
      outDir: path.join(project, '.qa-core', 'verify'),
      keepWorkspace: true,
    });
  } finally {
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  t.after(() => fs.rmSync(run.runRoot, { recursive: true, force: true }));
  assert.equal(run.evidence.playwrightExitCode, 0, `${run.stderr}\n${run.stdout}`);
  assert.equal(run.skippedLinks.some((link) => link.includes('dangling-link') && link.includes('dangling')), true);
  assert.equal(run.skippedLinks.some((link) => link.includes('self-loop') && link.includes('loop')), true);
  const records = run.evidence.records;
  assert.equal(records.some((record) => record.testTitle === 'frame button' && record.selector.includes('#ok')), true);
  assert.equal(records.some((record) => record.testTitle === 'second page' && record.selector.includes('#p')), true);
  const narrowed = records.find((record) => record.testTitle === 'narrows');
  assert.ok(narrowed);
  assert.equal(narrowed.parentCount, 2);
  assert.equal(narrowed.matchCount, 1);
  const floatingLine = fs.readFileSync(path.join(project, 'sample.spec.ts'), 'utf8').split('\n').findIndex((line) => line.includes('toBeTruthy()')) + 1;
  const floating = records.find((record) => record.testTitle === 'floating expect' && record.call === 'toBeTruthy');
  assert.ok(floating, JSON.stringify(records.filter((record) => record.testTitle === 'floating expect')));
  assert.equal(floating.line, floatingLine);
  assert.equal(floating.column > 1, true);
  const marked = records.find((record) => record.testTitle === 'keeps a control in the test id');
  assert.ok(marked);
  assert.equal(marked.selector.includes('\u0085'), false);
  assert.match(marked.selector, /\\u0085/);
  assert.equal(marked.selector.includes('ab') && !marked.selector.includes('a\\u0085b') && marked.selector === 'ab', false);
  const popup = records.find((record) => record.testTitle === 'popup page' && record.selector.includes('#x'));
  assert.ok(popup, JSON.stringify(records.filter((record) => record.testTitle === 'popup page')));
  assert.equal(popup.actionSucceeded, true);
  assert.equal(popup.matchCount, 1);
  const partsDir = path.join(run.workspaceDir, '.qa-core', 'locator-parts');
  const partText = fs.readdirSync(partsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => fs.readFileSync(path.join(partsDir, name), 'utf8'))
    .join('\n');
  assert.equal(partText.includes('\n{') || partText.trim().split('\n').length > 1, true);
  assert.equal(partText.trim().startsWith('['), false);
});

test('a baseline failure is baseline-red and gets no locator finding', (t) => {
  const project = tempDir(t, 'qcv-base-');
  const scratch = tempDir(t, 'qcv-base-tmp-');
  const out = tempDir(t, 'qcv-base-out-');
  writeTiny(
    project,
    `import { test, expect } from '@playwright/test';
test('missing banner', async ({ page }) => {
  await page.setContent('<p>hi</p>');
  await expect(page.locator('#nope')).toBeHidden();
});
test('clicks nothing', async ({ page }) => {
  await page.setContent('<p>hi</p>');
  await page.locator('#gone').click({ timeout: 300 });
});
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], {
    ...process.env,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const hidden = report.tests.find((entry) => entry.titlePath.join(' > ') === 'missing banner');
  const missed = report.tests.find((entry) => entry.titlePath.join(' > ') === 'clicks nothing');
  assert.equal(hidden.verdict, 'review');
  assert.equal(hidden.findings.some((finding) => finding.ruleId === 'QCV-L002'), true);
  assert.equal(hidden.findings.some((finding) => finding.ruleId === 'QCV-L001'), false);
  assert.equal(missed.verdict, 'baseline-red');
  assert.deepEqual(missed.findings, []);
  assert.equal(missed.locators, undefined);
  assert.match(result.stdout, /baseline-red/);
  assert.match(result.stdout, /This test stays green even if this element does not exist/);
  assert.match(result.stderr, /Baseline:/);
  assert.notEqual(missed.verdict, 'trusted');
});

function privateEnv(scratch) {
  return { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
}

test('a subfolder testDir maps the red spec onto baseline-red', (t) => {
  const project = tempDir(t, 'qcv-testdir-');
  const scratch = tempDir(t, 'qcv-testdir-tmp-');
  const out = tempDir(t, 'qcv-testdir-out-');
  fs.mkdirSync(path.join(project, 'tests'));
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0, testDir: './tests', timeout: 10000 });\n",
  );
  fs.writeFileSync(
    path.join(project, 'tests', 'b.spec.ts'),
    `import { test, expect } from '@playwright/test';
test('hidden', async ({ page }) => {
  await page.setContent('<p>hi</p>');
  await expect(page.locator('#nope')).toBeHidden();
});
test('clicks nothing', async ({ page }) => {
  await page.setContent('<p>hi</p>');
  await page.locator('#gone').click({ timeout: 300 });
});
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 1 passed, 1 failed, 0 skipped/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const hidden = report.tests.find((entry) => entry.titlePath.join(' > ') === 'hidden');
  const missed = report.tests.find((entry) => entry.titlePath.join(' > ') === 'clicks nothing');
  assert.equal(hidden.file, 'tests/b.spec.ts');
  assert.equal(hidden.verdict, 'review');
  assert.equal(hidden.findings.some((finding) => finding.ruleId === 'QCV-L002'), true);
  assert.equal(hidden.findings.some((finding) => finding.ruleId === 'QCV-L001'), false);
  assert.equal(missed.file, 'tests/b.spec.ts');
  assert.equal(missed.verdict, 'baseline-red');
  assert.notEqual(missed.verdict, 'trusted');
  assert.deepEqual(missed.findings, []);
  assert.equal(report.summary.verdict['baseline-red'], 1);
  assert.equal(report.summary.verdict.trusted, 0);
});

test('two projects with different testDirs keep the red test baseline-red', (t) => {
  const project = tempDir(t, 'qcv-projects-');
  const scratch = tempDir(t, 'qcv-projects-tmp-');
  const out = tempDir(t, 'qcv-projects-out-');
  fs.mkdirSync(path.join(project, 'tests-a'));
  fs.mkdirSync(path.join(project, 'tests-b'));
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({
  retries: 0,
  timeout: 10000,
  testDir: './tests-a',
  projects: [
    { name: 'a', testDir: './tests-a' },
    { name: 'b', testDir: './tests-b' },
  ],
});
`,
  );
  fs.writeFileSync(
    path.join(project, 'tests-a', 'green.spec.ts'),
    `import { test, expect } from '@playwright/test';
test('hidden', async ({ page }) => {
  await page.setContent('<p>hi</p>');
  await expect(page.locator('#nope')).toBeHidden();
});
`,
  );
  fs.writeFileSync(
    path.join(project, 'tests-b', 'red.spec.ts'),
    `import { test } from '@playwright/test';
test('clicks nothing', async ({ page }) => {
  await page.setContent('<p>hi</p>');
  await page.locator('#gone').click({ timeout: 300 });
});
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 1 passed, 1 failed, 0 skipped/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const hidden = report.tests.find((entry) => entry.file === 'tests-a/green.spec.ts');
  const missed = report.tests.find((entry) => entry.file === 'tests-b/red.spec.ts');
  assert.ok(hidden, JSON.stringify(report.tests.map((entry) => entry.file)));
  assert.ok(missed);
  assert.equal(hidden.verdict, 'review');
  assert.equal(hidden.findings.some((finding) => finding.ruleId === 'QCV-L002'), true);
  assert.equal(missed.verdict, 'baseline-red');
  assert.notEqual(missed.verdict, 'trusted');
  assert.deepEqual(missed.findings, []);
  assert.equal(report.tests.some((entry) => entry.verdict === 'trusted'), false);
});

test('a symlink to a copied directory is not a loop', (t) => {
  const project = tempDir(t, 'qcv-fx-');
  const scratch = tempDir(t, 'qcv-fx-tmp-');
  const out = tempDir(t, 'qcv-fx-out-');
  fs.mkdirSync(path.join(project, 'fixtures'));
  fs.mkdirSync(path.join(project, 'tests'));
  fs.writeFileSync(path.join(project, 'fixtures', 'data.txt'), 'ok\n');
  fs.symlinkSync(path.join('..', 'fixtures'), path.join(project, 'tests', 'fx'));
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0, testDir: './tests', timeout: 10000 });\n",
  );
  fs.writeFileSync(
    path.join(project, 'tests', 'read.spec.ts'),
    `import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
test('reads both paths', ({}, testInfo) => {
  const dir = path.dirname(testInfo.file);
  const direct = fs.readFileSync(path.join(dir, '..', 'fixtures', 'data.txt'), 'utf8');
  const via = fs.readFileSync(path.join(dir, 'fx', 'data.txt'), 'utf8');
  expect(direct).toBe('ok\\n');
  expect(via).toBe('ok\\n');
});
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.stderr.includes('Skipped symlink tests/fx (loop)'), false, result.stderr);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 1 passed, 0 failed, 0 skipped/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const row = report.tests.find((entry) => entry.titlePath.join(' > ') === 'reads both paths');
  assert.ok(row);
  assert.notEqual(row.verdict, 'baseline-red');
  assert.equal(report.tests.some((entry) => entry.verdict === 'trusted' && report.summary.verdict['baseline-red'] > 0), false);
});

test('option absence assertions are L002 and toHaveCount(0) is L002', (t) => {
  const project = tempDir(t, 'qcv-absence-');
  const scratch = tempDir(t, 'qcv-absence-tmp-');
  const out = tempDir(t, 'qcv-absence-out-');
  writeTiny(
    project,
    `import { test, expect } from '@playwright/test';
test('option forms', async ({ page }) => {
  await page.setContent('<button id="b" disabled>x</button><input id="c" type="checkbox"><input id="e" readonly>');
  await expect(page.locator('#missing')).toBeVisible({ visible: false });
  await expect(page.locator('#gone')).toBeAttached({ attached: false });
  await expect(page.locator('#zero')).toHaveCount(0);
  await expect(page.locator('#b')).toBeEnabled({ enabled: false });
  await expect(page.locator('#c')).toBeChecked({ checked: false });
  await expect(page.locator('#e')).toBeEditable({ editable: false });
});
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 1 passed, 0 failed, 0 skipped/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const row = report.tests.find((entry) => entry.titlePath.join(' > ') === 'option forms');
  assert.ok(row);
  assert.equal(row.verdict, 'review');
  assert.equal(row.findings.some((finding) => finding.ruleId === 'QCV-L001'), false);
  const absence = row.findings.filter((finding) => finding.ruleId === 'QCV-L002');
  assert.equal(absence.length, 3);
  const evidence = JSON.parse(fs.readFileSync(path.join(out, 'locator-evidence.json'), 'utf8'));
  const byCall = (call, selector) => evidence.records.find((record) => record.call === call && record.selector.includes(selector));
  assert.equal(byCall('toBeVisible', 'missing').optionAbsence, true);
  assert.equal(byCall('toBeAttached', 'gone').optionAbsence, true);
  assert.equal(byCall('toHaveCount', 'zero').countExpected, 0);
  assert.equal(byCall('toHaveCount', 'zero').optionAbsence, false);
  assert.equal(byCall('toBeEnabled', '#b').optionAbsence, false);
  assert.equal(byCall('toBeChecked', '#c').optionAbsence, false);
  assert.equal(byCall('toBeEditable', '#e').optionAbsence, false);
  assert.equal(row.findings.some((finding) => finding.ruleId === 'QCV-L002' && finding.evidence.includes('#b')), false);
  assert.equal(row.findings.some((finding) => finding.ruleId === 'QCV-L002' && finding.evidence.includes('#c')), false);
  assert.equal(row.findings.some((finding) => finding.ruleId === 'QCV-L002' && finding.evidence.includes('#e')), false);
  assert.equal(row.locators.some((locator) => locator.selector.includes('missing') && locator.status === 'never-matched'), true);
});

test('parameterized titles keep the finding on the source row', (t) => {
  const project = tempDir(t, 'qcv-param-');
  const scratch = tempDir(t, 'qcv-param-tmp-');
  const out = tempDir(t, 'qcv-param-out-');
  writeTiny(
    project,
    `import { test, expect } from '@playwright/test';
for (const n of [1, 2]) {
  test(\`param \${n}\`, async ({ page }) => {
    await page.setContent('<p>hi</p>');
    await expect(page.locator('#nope')).toBeHidden();
  });
}
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 2 passed, 0 failed, 0 skipped/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.tests.length, 1);
  const row = report.tests[0];
  assert.equal(row.titlePath.join(' > '), 'param ${n}');
  assert.equal(row.verdict, 'review');
  assert.notEqual(row.verdict, 'trusted');
  assert.equal(row.findings.some((finding) => finding.ruleId === 'QCV-L002'), true);
  assert.match(row.findings.map((finding) => finding.evidence).join('\n'), /param 1/);
  assert.match(row.findings.map((finding) => finding.evidence).join('\n'), /param 2/);
  const evidence = JSON.parse(fs.readFileSync(path.join(out, 'locator-evidence.json'), 'utf8'));
  const titles = [...new Set(evidence.records.map((record) => record.testTitle))].sort();
  assert.deepEqual(titles, ['param 1', 'param 2']);
});

test('two parameterized tests on one line keep the absence finding', (t) => {
  const project = tempDir(t, 'qcv-twocol-');
  const scratch = tempDir(t, 'qcv-twocol-tmp-');
  const out = tempDir(t, 'qcv-twocol-out-');
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0, testDir: './tests', timeout: 10000 });\n",
  );
  fs.mkdirSync(path.join(project, 'tests'));
  const spec = `import { test, expect } from '@playwright/test';\n\n\n\n\n\n\n\nfor (const n of [1, 2]) { test(\`left \${n}\`, async ({ page }) => { await page.setContent('<p>x</p>'); await expect(page.locator('#left-ghost')).toBeHidden(); }); test(\`right \${n}\`, async ({ page }) => { await page.setContent('<p id="r">x</p>'); await expect(page.locator('#r')).toBeVisible(); }); }\n`;
  fs.writeFileSync(path.join(project, 'tests', 'p.spec.ts'), spec);
  const line = spec.split('\n')[8];
  const leftColumn = line.indexOf('test(`left') + 1;
  const rightColumn = line.indexOf('test(`right') + 1;
  assert.equal(line.includes('for (const n of [1, 2])'), true);
  assert.equal(leftColumn > 0, true);
  assert.equal(rightColumn > leftColumn, true);
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 4 passed, 0 failed, 0 skipped/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const left = report.tests.find((entry) => entry.titlePath.join(' > ') === 'left ${n}');
  const right = report.tests.find((entry) => entry.titlePath.join(' > ') === 'right ${n}');
  assert.ok(left, report.tests.map((entry) => entry.id).join('\n'));
  assert.ok(right);
  assert.equal(left.id, `tests/p.spec.ts:9:${leftColumn}:left \${n}`);
  assert.equal(right.id, `tests/p.spec.ts:9:${rightColumn}:right \${n}`);
  assert.notEqual(leftColumn, rightColumn);
  assert.equal(left.verdict, 'review');
  assert.notEqual(left.verdict, 'trusted');
  assert.equal(left.findings.some((finding) => finding.ruleId === 'QCV-L002'), true);
  assert.match(left.findings.map((finding) => finding.evidence).join('\n'), /left-ghost/);
  assert.match(left.findings.map((finding) => finding.evidence).join('\n'), /left 1/);
  assert.match(left.findings.map((finding) => finding.evidence).join('\n'), /left 2/);
  assert.equal(right.verdict, 'trusted');
  assert.equal(right.findings.length, 0);
  const evidence = JSON.parse(fs.readFileSync(path.join(out, 'locator-evidence.json'), 'utf8'));
  const ghost = evidence.records.filter((record) => record.selector.includes('left-ghost'));
  assert.equal(ghost.length, 2);
  assert.equal(ghost.every((record) => record.testColumn === leftColumn + 4), true);
  assert.equal(ghost.some((record) => record.testColumn === rightColumn), false);
  assert.equal(ghost.some((record) => record.testColumn === leftColumn), false);
});

test('grep filtered tests are not-run', (t) => {
  const project = tempDir(t, 'qcv-grep-');
  const scratch = tempDir(t, 'qcv-grep-tmp-');
  const out = tempDir(t, 'qcv-grep-out-');
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ grep: /keep/, retries: 0, timeout: 10000 });\n",
  );
  fs.writeFileSync(
    path.join(project, 'sample.spec.ts'),
    `import { test, expect } from '@playwright/test';
test('keep me', async ({ page }) => {
  await page.setContent('<p>hi</p>');
  await expect(page.locator('#nope')).toBeHidden();
});
test('dropped by grep', async ({ page }) => {
  await page.locator('#never').click({ timeout: 300 });
});
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 1 passed, 0 failed, 0 skipped/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const dropped = report.tests.find((entry) => entry.titlePath.join(' > ') === 'dropped by grep');
  const kept = report.tests.find((entry) => entry.titlePath.join(' > ') === 'keep me');
  assert.ok(dropped);
  assert.equal(dropped.verdict, 'not-run');
  assert.notEqual(dropped.verdict, 'trusted');
  assert.equal(dropped.findings.length, 0);
  assert.equal(kept.verdict, 'review');
  assert.equal(report.summary.verdict['not-run'], 1);
  assert.equal(report.summary.verdict.trusted, 0);
});

test('a custom config supplies the inventory and a test outside it is not trusted', (t) => {
  const project = tempDir(t, 'qcv-custom-');
  const scratch = tempDir(t, 'qcv-custom-tmp-');
  const out = tempDir(t, 'qcv-custom-out-');
  fs.mkdirSync(path.join(project, 'conf'));
  fs.mkdirSync(path.join(project, 'tests'));
  fs.mkdirSync(path.join(project, 'e2e'));
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0, testDir: './tests', timeout: 10000 });\n",
  );
  fs.writeFileSync(
    path.join(project, 'conf', 'custom.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0, testDir: '../e2e', timeout: 10000 });\n",
  );
  fs.writeFileSync(
    path.join(project, 'tests', 'r.spec.ts'),
    `import { test, expect } from '@playwright/test';
test('root ghost', async ({ page }) => {
  await page.setContent('<p>hi</p>');
  await expect(page.locator('#root-ghost')).toBeHidden();
});
`,
  );
  fs.writeFileSync(
    path.join(project, 'e2e', 'e.spec.ts'),
    `import { test, expect } from '@playwright/test';
test('e2e ghost', async ({ page }) => {
  await page.setContent('<p>hi</p>');
  await expect(page.locator('#e2e-ghost')).toBeHidden();
});
`,
  );
  const result = runCli(
    [project, '--only', 'locator', '--config', 'conf/custom.config.ts', '--out', out],
    privateEnv(scratch),
    project,
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 1 passed, 0 failed, 0 skipped/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.project.configFile, 'conf/custom.config.ts');
  const ghost = report.tests.find((entry) => entry.titlePath.join(' > ') === 'e2e ghost');
  const root = report.tests.find((entry) => entry.titlePath.join(' > ') === 'root ghost');
  assert.ok(ghost, report.tests.map((entry) => entry.id).join('\n'));
  assert.equal(ghost.file, 'e2e/e.spec.ts');
  assert.equal(ghost.verdict, 'review');
  assert.equal(ghost.findings.some((finding) => finding.ruleId === 'QCV-L002' && finding.evidence.includes('e2e-ghost')), true);
  assert.equal(root, undefined);
  assert.equal(report.tests.some((entry) => entry.file === 'tests/r.spec.ts' && entry.verdict === 'trusted'), false);
  assert.equal(report.summary.verdict.trusted, 0);
});

test('enabled, checked, and editable false options are not L002', (t) => {
  const project = tempDir(t, 'qcv-state-');
  const scratch = tempDir(t, 'qcv-state-tmp-');
  const out = tempDir(t, 'qcv-state-out-');
  writeTiny(
    project,
    `import { test, expect } from '@playwright/test';
test('enabled false on a missing element', async ({ page }) => {
  await page.setContent('<p>x</p>');
  await expect(page.locator('#gone')).toBeEnabled({ enabled: false, timeout: 300 });
});
test('checked false on a missing element', async ({ page }) => {
  await page.setContent('<p>x</p>');
  await expect(page.locator('#gone')).toBeChecked({ checked: false, timeout: 300 });
});
test('editable false on a missing element', async ({ page }) => {
  await page.setContent('<p>x</p>');
  await expect(page.locator('#gone')).toBeEditable({ editable: false, timeout: 300 });
});
`,
  );
  const result = runCli([project, '--only', 'locator', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 0 passed, 3 failed, 0 skipped/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.tests.length, 3);
  assert.equal(report.tests.every((entry) => entry.verdict === 'baseline-red'), true);
  assert.equal(report.tests.some((entry) => entry.verdict === 'trusted'), false);
  assert.equal(report.tests.some((entry) => entry.findings.some((finding) => finding.ruleId === 'QCV-L002')), false);
  assert.equal(report.summary.verdict['baseline-red'], 3);
  assert.equal(report.summary.verdict.review, 0);
});

function writeMarkedProject(project) {
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0, testDir: '.', timeout: 10000 });\n",
  );
  fs.writeFileSync(
    path.join(project, 'sample.spec.ts'),
    `import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
test('hidden', async ({ page }, testInfo) => {
  fs.writeFileSync(path.join(path.dirname(testInfo.file), 'ran.txt'), 'yes\\n');
  await page.setContent('<p>hi</p>');
  await expect(page.locator('#nope')).toBeHidden();
});
`,
  );
}

test('an absolute --config runs the copy and not the original tree', (t) => {
  const parent = tempDir(t, 'qcv-abs-parent-');
  const project = path.join(parent, 'app');
  fs.mkdirSync(project);
  const scratch = tempDir(t, 'qcv-abs-tmp-');
  const out = tempDir(t, 'qcv-abs-out-');
  writeMarkedProject(project);
  const config = path.resolve(project, 'playwright.config.ts');
  const result = runCli(
    [project, '--only', 'locator', '--config', config, '--keep-workspace', '--out', out],
    privateEnv(scratch),
    parent,
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(project, 'ran.txt')), false);
  const kept = workspaceFrom(result.stderr);
  t.after(() => fs.rmSync(kept, { recursive: true, force: true }));
  assert.equal(fs.readFileSync(path.join(kept, 'project', 'ran.txt'), 'utf8'), 'yes\n');
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const row = report.tests.find((entry) => entry.titlePath.join(' > ') === 'hidden');
  assert.equal(row.verdict, 'review');
  const evidence = JSON.parse(fs.readFileSync(path.join(out, 'locator-evidence.json'), 'utf8'));
  assert.equal(evidence.records.length > 0, true);
});

test('a cwd-relative --config runs the copy', (t) => {
  const project = tempDir(t, 'qcv-rel-');
  const scratch = tempDir(t, 'qcv-rel-tmp-');
  const out = tempDir(t, 'qcv-rel-out-');
  writeMarkedProject(project);
  const result = runCli(
    ['.', '--only', 'locator', '--config', './playwright.config.ts', '--keep-workspace', '--out', out],
    privateEnv(scratch),
    project,
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(path.join(project, 'ran.txt')), false);
  const kept = workspaceFrom(result.stderr);
  t.after(() => fs.rmSync(kept, { recursive: true, force: true }));
  assert.equal(fs.readFileSync(path.join(kept, 'project', 'ran.txt'), 'utf8'), 'yes\n');
  const evidence = JSON.parse(fs.readFileSync(path.join(out, 'locator-evidence.json'), 'utf8'));
  assert.equal(evidence.records.length > 0, true);
});

test('a --config outside the project is refused and does not run Playwright', (t) => {
  const project = tempDir(t, 'qcv-outcfg-');
  const scratch = tempDir(t, 'qcv-outcfg-tmp-');
  const out = tempDir(t, 'qcv-outcfg-out-');
  writeTiny(project, ADD_SPEC);
  const marker = path.join(scratch, 'outside-ran.txt');
  const setup = path.join(scratch, 'outside-setup.mjs');
  const outside = path.join(scratch, 'outside.config.mjs');
  fs.writeFileSync(
    setup,
    `import fs from 'node:fs';\nexport default async function globalSetup() {\n  fs.writeFileSync(${JSON.stringify(marker)}, 'ran\\n');\n}\n`,
  );
  fs.writeFileSync(
    outside,
    `export default { testDir: ${JSON.stringify(project)}, globalSetup: ${JSON.stringify(setup)}, timeout: 10000 };\n`,
  );
  const result = runCli([project, '--only', 'locator', '--config', outside, '--out', out], privateEnv(scratch), project);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /outside the project/);
  assert.match(result.stderr, /original tree/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(out, 'report.json')), false);
  assert.equal(fs.readdirSync(scratch).some((name) => name.startsWith('qcv-run-')), false);
});
