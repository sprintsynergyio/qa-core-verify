import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig } from '../dist/config.js';
import { parseSpecFile } from '../dist/inventory/parse.js';
import { planMutations } from '../dist/runtime/inversion/mutate.js';
import { classifyMutantOutput } from '../dist/runtime/inversion/run.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'dist/cli.js');
const sauce = path.join(repoRoot, 'example-project/saucedemo');

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

function writeSuite(dir, spec) {
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0, testDir: '.', timeout: 15000, use: { headless: true } });\n",
  );
  fs.writeFileSync(path.join(dir, 'sample.spec.ts'), spec);
}

function privateEnv(dir) {
  return { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir };
}

function reporter(spec) {
  return JSON.stringify({
    config: { rootDir: '/tmp/qcv-example', projects: [{ testDir: '/tmp/qcv-example' }] },
    suites: [{ specs: [spec] }],
  });
}

const SAMPLE = `import { test, expect } from '@playwright/test';

test('maps', async ({ page }) => {
  await expect(page).toHaveTitle('Login');
  await expect.soft(page.locator('#a')).toBeVisible();
  await expect.poll(() => 1).toBe(1);
  await expect(page.locator('#b')).not.toBeHidden();
  await expect(page).toPass(async () => {});
  await expect(page).toBeCustom(1);
});
`;

test('inversion adds and removes .not, keeps soft and poll, and skips toPass and custom matchers', () => {
  const plans = planMutations('sample.spec.ts', SAMPLE);
  const byMatcher = Object.fromEntries(plans.map((plan) => [plan.matcher, plan]));
  assert.equal(plans.length, 6);

  const title = byMatcher.toHaveTitle;
  assert.equal(title.kind, 'invert');
  assert.equal(title.not, false);
  assert.equal(title.soft, false);
  assert.equal(title.poll, false);
  assert.match(title.mutated, /expect\(page\)\.not\.toHaveTitle\('Login'\)/);
  const titleMutantLine = title.mutated.split('\n').find((line) => line.includes('toHaveTitle'));
  assert.equal(titleMutantLine.includes('.soft'), false);
  assert.equal(titleMutantLine.includes('.not.toHaveTitle'), true);
  const titleLine = SAMPLE.split('\n').findIndex((line) => line.includes('toHaveTitle')) + 1;
  assert.equal(title.line, titleLine);
  assert.equal(title.column, SAMPLE.split('\n')[titleLine - 1].indexOf('expect(page)') + 1);

  const soft = byMatcher.toBeVisible;
  assert.equal(soft.kind, 'invert');
  assert.equal(soft.soft, true);
  assert.equal(soft.poll, false);
  assert.match(soft.mutated, /expect\.soft\(page\.locator\('#a'\)\)\.not\.toBeVisible\(\)/);

  const poll = byMatcher.toBe;
  assert.equal(poll.kind, 'invert');
  assert.equal(poll.poll, true);
  assert.equal(poll.soft, false);
  assert.match(poll.mutated, /expect\.poll\(\(\) => 1\)\.not\.toBe\(1\)/);

  const hidden = byMatcher.toBeHidden;
  assert.equal(hidden.kind, 'invert');
  assert.equal(hidden.not, true);
  assert.match(hidden.mutated, /expect\(page\.locator\('#b'\)\)\.toBeHidden\(\)/);
  assert.equal(hidden.mutated.includes('.not'), false);

  const pass = byMatcher.toPass;
  assert.equal(pass.kind, 'skip');
  assert.match(pass.reason, /toPass/);
  assert.equal(pass.mutated, undefined);

  const custom = byMatcher.toBeCustom;
  assert.equal(custom.kind, 'skip');
  assert.equal(custom.reason, 'Custom matcher toBeCustom is not inverted.');

  const file = path.join(sauce, 'tests/ai-style/cannot-fail.spec.ts');
  const text = fs.readFileSync(file, 'utf8');
  const inventory = parseSpecFile(file, emptyConfig());
  const mapped = planMutations(file, text);
  for (const expectCall of inventory.tests.flatMap((entry) => entry.expects)) {
    const plan = mapped.find((item) => item.line === expectCall.line && item.column === expectCall.column);
    assert.ok(plan, `${expectCall.matcher} at ${expectCall.line}:${expectCall.column}`);
    assert.equal(plan.matcher, expectCall.matcher);
  }
});

test('mutant outcomes are classified from recorded Playwright JSON', () => {
  const killed = classifyMutantOutput(
    reporter({
      file: 'tests/a.spec.ts',
      line: 4,
      column: 3,
      tests: [{ status: 'unexpected', results: [{ status: 'failed' }] }],
    }),
    '',
    1,
    'tests/a.spec.ts',
    4,
    [3],
  );
  assert.equal(killed.outcome, 'killed');

  const expectedFail = classifyMutantOutput(
    reporter({
      file: 'tests/a.spec.ts',
      line: 4,
      column: 3,
      tests: [{ status: 'expected', results: [{ status: 'failed' }] }],
    }),
    '',
    1,
    'tests/a.spec.ts',
    4,
    [3],
  );
  assert.equal(expectedFail.outcome, 'killed');

  const survived = classifyMutantOutput(
    reporter({
      file: 'tests/a.spec.ts',
      line: 4,
      column: 3,
      tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
    }),
    '',
    0,
    'tests/a.spec.ts',
    4,
    [3],
  );
  assert.equal(survived.outcome, 'survived');

  const unexpectedPass = classifyMutantOutput(
    reporter({
      file: 'tests/a.spec.ts',
      line: 4,
      column: 3,
      tests: [{ status: 'unexpected', results: [{ status: 'passed' }] }],
    }),
    '',
    1,
    'tests/a.spec.ts',
    4,
    [3],
  );
  assert.equal(unexpectedPass.outcome, 'survived');

  const timed = classifyMutantOutput(
    reporter({
      file: 'tests/a.spec.ts',
      line: 4,
      column: 3,
      tests: [{ status: 'unexpected', results: [{ status: 'timedOut' }, { status: 'failed' }] }],
    }),
    '',
    1,
    'tests/a.spec.ts',
    4,
    [3],
  );
  assert.equal(timed.outcome, 'timeout');
  assert.match(timed.reason, /timed out/);

  const interrupted = classifyMutantOutput(
    reporter({
      file: 'tests/a.spec.ts',
      line: 4,
      column: 3,
      tests: [{ results: [{ status: 'interrupted' }] }],
    }),
    '',
    1,
    'tests/a.spec.ts',
    4,
    [3],
  );
  assert.equal(interrupted.outcome, 'error');
  assert.match(interrupted.reason, /interrupted/);

  const missing = classifyMutantOutput('not json', 'Error: boom', 1, 'tests/a.spec.ts', 4, [3]);
  assert.equal(missing.outcome, 'error');
  assert.match(missing.reason, /Error: boom/);

  const otherLine = classifyMutantOutput(
    reporter({
      file: 'tests/a.spec.ts',
      line: 9,
      column: 3,
      tests: [{ results: [{ status: 'failed' }] }],
    }),
    '',
    1,
    'tests/a.spec.ts',
    4,
    [3],
  );
  assert.equal(otherLine.outcome, 'error');
});

const LOCAL_SPEC = `import { test, expect } from '@playwright/test';

test('visible', async ({ page }) => {
  await page.setContent('<p id="a">x</p>');
  await expect(page.locator('#a')).toBeVisible();
  await expect(page.locator('#gone')).toBeHidden();
});

test('dead', async ({ page }) => {
  await page.setContent('<p>x</p>');
  return;
  await expect(page).toHaveTitle('nope');
});

test('swallowed', async ({ page }) => {
  await page.setContent('<p>x</p>');
  try {
    await expect(page.locator('#nope')).toBeVisible({ timeout: 300 });
  } catch {
    // discarded
  }
});
`;

test('a local suite kills a real assertion and reports a dead assertion and a swallowed assertion', (t) => {
  const project = tempDir(t, 'qcv-inv-local-');
  const scratch = tempDir(t, 'qcv-inv-local-tmp-');
  const out = tempDir(t, 'qcv-inv-local-out-');
  writeSuite(project, LOCAL_SPEC);
  const before = fs.readFileSync(path.join(project, 'sample.spec.ts'));
  const result = runCli([project, '--only', 'inversion', '--out', out], privateEnv(scratch), project);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Inversion plan: 4 mutants, 4 runs\./);
  assert.match(result.stderr, /Baseline: 3 passed, 0 failed, 0 skipped/);
  assert.equal(fs.readdirSync(scratch).length, 0, scratch);
  assert.deepEqual(fs.readFileSync(path.join(project, 'sample.spec.ts')), before);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(report.checksRun, ['cannot-fail']);
  assert.equal(report.inversion.runs, 4);
  assert.equal(report.inversion.stoppedAtLimit, false);
  const rows = report.tests.flatMap((entry) => entry.assertions ?? []);
  const byMatcher = (title, matcher) => {
    const testRow = report.tests.find((entry) => entry.titlePath.join(' > ') === title);
    return testRow.assertions.find((entry) => entry.matcher === matcher);
  };
  assert.equal(byMatcher('visible', 'toBeVisible').outcome, 'killed');
  assert.equal(byMatcher('visible', 'toBeHidden').outcome, 'killed');
  assert.equal(byMatcher('dead', 'toHaveTitle').outcome, 'survived');
  assert.equal(byMatcher('swallowed', 'toBeVisible').outcome, 'survived');
  const f001 = report.tests.flatMap((entry) => entry.findings).filter((finding) => finding.ruleId === 'QCV-F001' && finding.severity === 'error');
  assert.equal(f001.length, 2);
  assert.equal(rows.filter((entry) => entry.outcome === 'survived').length, 2);
  assert.equal(report.summary.verdict.untrusted >= 2, true);
});

test('--max-runs stops inversion and marks the rest not-run', (t) => {
  const project = tempDir(t, 'qcv-inv-max-');
  const scratch = tempDir(t, 'qcv-inv-max-tmp-');
  const out = tempDir(t, 'qcv-inv-max-out-');
  writeSuite(
    project,
    `import { test, expect } from '@playwright/test';
test('two', async ({ page }) => {
  await page.setContent('<p id="a">x</p>');
  await expect(page.locator('#a')).toBeVisible();
  await expect(page.locator('#gone')).toBeHidden();
});
`,
  );
  const before = fs.readFileSync(path.join(project, 'sample.spec.ts'));
  const result = runCli([project, '--only', 'inversion', '--max-runs', '1', '--out', out], privateEnv(scratch), project);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Inversion plan: 2 mutants, 1 runs\./);
  assert.match(result.stderr, /Stopped at limit\. 1 assertions were not run\./);
  assert.match(result.stdout, /Stopped at limit/);
  assert.deepEqual(fs.readFileSync(path.join(project, 'sample.spec.ts')), before);
  assert.equal(fs.readdirSync(scratch).length, 0);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.inversion.mutants, 2);
  assert.equal(report.inversion.runs, 1);
  assert.equal(report.inversion.stoppedAtLimit, true);
  assert.equal(report.inversion.outcomes.killed, 1);
  assert.equal(report.inversion.outcomes['not-run'], 1);
  const stopped = report.tests.flatMap((entry) => entry.assertions ?? []).find((entry) => entry.outcome === 'not-run');
  assert.equal(stopped.reason, 'Stopped at limit.');
  assert.equal(stopped.matcher, 'toBeHidden');
});

test('SIGINT during inversion removes the temp copy and leaves the project bytes unchanged', { skip: process.platform !== 'linux' }, async (t) => {
  const project = tempDir(t, 'qcv-inv-sig-proj-');
  const scratch = tempDir(t, 'qcv-inv-sig-tmp-');
  const out = tempDir(t, 'qcv-inv-sig-out-');
  const spec = `import { test } from '@playwright/test';
test('hang', async ({ page }) => {
  await page.setContent('<p>x</p>');
  await new Promise(() => {});
});
`;
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ retries: 0, testDir: '.', timeout: 60000 });\n",
  );
  fs.writeFileSync(path.join(project, 'sample.spec.ts'), spec);
  const before = fs.readFileSync(path.join(project, 'sample.spec.ts'));
  const child = spawn(process.execPath, [cli, project, '--only', 'inversion', '--out', out], {
    cwd: project,
    env: privateEnv(scratch),
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process already exited.
    }
  });
  const started = Date.now();
  let workspace = '';
  while (Date.now() - started < 20000) {
    const names = fs.readdirSync(scratch).filter((name) => name.startsWith('qcv-run-'));
    if (names.length > 0) {
      workspace = path.join(scratch, names[0]);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(workspace.length > 0, true, 'inversion workspace did not appear');
  const exited = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: 'timeout', signal: null }), 20000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  child.kill('SIGINT');
  const result = await exited;
  assert.equal(result.code, 130, `SIGINT exited ${result.code} signal ${result.signal}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(fs.readdirSync(scratch), [], `SIGINT left ${fs.readdirSync(scratch).join(', ')}`);
  assert.deepEqual(fs.readFileSync(path.join(project, 'sample.spec.ts')), before);
});

test('SauceDemo inversion is skipped unless QCV_LIVE=1', { skip: process.env.QCV_LIVE !== '1' }, (t) => {
  const scratch = tempDir(t, 'qcv-inv-live-tmp-');
  const out = tempDir(t, 'qcv-inv-live-out-');
  const before = hashTree(sauce);
  const started = Date.now();
  const result = runCli([sauce, '--only', 'inversion', '--out', out], privateEnv(scratch), repoRoot);
  const elapsed = Date.now() - started;
  assert.equal(result.status === 0 || result.status === 1, true, `${result.stdout}\n${result.stderr}`);
  assert.equal(hashTree(sauce), before);
  assert.equal(fs.readdirSync(scratch).length, 0, `${result.stderr}\n${fs.readdirSync(scratch).join(', ')}`);
  assert.match(result.stderr, /Baseline: 18 passed, 0 failed, 1 skipped/, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const assertions = report.tests.flatMap((entry) =>
    (entry.assertions ?? []).map((assertion) => ({ ...assertion, title: entry.titlePath.join(' > '), verdict: entry.verdict })),
  );
  const good = assertions.filter((entry) => entry.file.startsWith('tests/good/'));
  assert.equal(good.length > 0, true, 'tests/good had no assertions');
  assert.equal(
    good.every((entry) => entry.outcome === 'killed'),
    true,
    JSON.stringify(good.filter((entry) => entry.outcome !== 'killed')),
  );
  const survived = assertions.filter((entry) => entry.outcome === 'survived');
  const survivedKeys = survived.map((entry) => `${entry.file}:${entry.line}:${entry.matcher}`).sort();
  const f001 = report.tests
    .flatMap((entry) => entry.findings)
    .filter((finding) => finding.ruleId === 'QCV-F001' && finding.severity === 'error')
    .map((finding) => `${finding.file.split('saucedemo/').pop()}:${finding.line}`)
    .sort();
  const swallowed = survived.find((entry) => entry.source.includes('#login-error-banner') && entry.matcher === 'toBeVisible');
  const branched = survived.find((entry) => entry.matcher === 'toHaveText' && entry.source.includes('will not run'));
  const dead = survived.find((entry) => entry.file.endsWith('cannot-fail.spec.ts') && entry.matcher === 'toHaveTitle');
  const unawaited = assertions.find((entry) => entry.source.includes("getByTestId('login-button')") && entry.matcher === 'toBeVisible');
  assert.ok(swallowed, survivedKeys.join('\n'));
  assert.ok(branched, survivedKeys.join('\n'));
  assert.ok(dead, survivedKeys.join('\n'));
  assert.equal(unawaited && unawaited.outcome, 'killed', survivedKeys.join('\n'));
  assert.equal(f001.some((entry) => entry.includes('cannot-fail.spec.ts')), true, f001.join('\n'));
  assert.equal(f001.some((entry) => entry.includes('weak-assertions.spec.ts')), true, f001.join('\n'));
  assert.equal(survived.length, 3, survivedKeys.join('\n'));
  fs.writeFileSync(
    path.join(out, 'live-summary.json'),
    JSON.stringify({ elapsed, status: result.status, survivedKeys, f001, inversion: report.inversion, summary: report.summary }, null, 2),
  );
  console.error(`LIVE_INVERSION_MS ${elapsed}`);
  console.error(`LIVE_SURVIVED ${survivedKeys.join(' | ')}`);
  console.error(`LIVE_F001 ${f001.join(' | ')}`);
  console.error(result.stdout);
  console.error(result.stderr);
});

function hashTree(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test-results' || entry.name === 'playwright-report' || entry.name === '.qa-core') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  return files
    .sort()
    .map((file) => `${path.relative(dir, file)}\0${fs.readFileSync(file).toString('base64')}`)
    .join('\n');
}
