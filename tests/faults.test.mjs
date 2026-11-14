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
import { classifyFindings, ownerForTest } from '../dist/runtime/faults/findings.js';
import { FAULT_NOT_FOUND_REASON, faultRunGap } from '../dist/runtime/faults/run.js';
import { faultFixtureSource } from '../dist/runtime/faults/fixture.js';
import { loadFaultFile, titleMatches, validateFaultFile } from '../dist/runtime/faults/types.js';
import { validateSchema } from './schema-validate.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'dist/cli.js');
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schema/report.schema.json'), 'utf8'));

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
    timeout: 300000,
  });
}

function privateEnv(dir) {
  return { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir };
}

function entry(overrides) {
  return {
    id: 'sample',
    type: 'remove-element',
    params: { selector: '#a' },
    expectedToBreak: ['alpha'],
    ...overrides,
  };
}

test('fault fixture source applies DOM faults and blocked requests', () => {
  const source = faultFixtureSource();
  assert.equal(source.includes('context.addInitScript'), true);
  assert.equal(source.includes('context.route'), true);
  assert.equal(source.includes('page.route'), false);
  assert.equal(source.includes('isClosed'), true);
  assert.equal(source.includes('pages: 0'), false);
  assert.equal(source.includes('inTestScope'), true);
  assert.equal(source.includes('fixtureScope'), true);
  assert.equal(source.includes('qcvCaptureStackTrace'), true);
  assert.equal(source.includes('endTestScope'), true);
  assert.equal(source.includes('browser.newContext'), true);
  assert.equal(source.includes('page.setContent'), true);
  assert.equal(source.includes('MutationObserver'), true);
  assert.equal(source.includes('blank-app'), true);
  assert.equal(source.includes('data-qcv-blank'), true);
  assert.equal(source.includes('route.abort'), true);
  assert.equal(source.includes("export * from '@playwright/test'"), true);
  assert.equal(source.includes('export function mergeTests'), true);
  assert.equal(source.includes("process.on('exit'"), true);
  assert.equal(source.includes('originalPrepareStackTrace'), true);
  assert.equal(source.includes('page.close'), true);
  assert.equal(source.includes('qcv blank check timed out'), true);
  assert.equal(source.includes("line + '\\n'"), true);
  assert.equal(source.includes("line + '\\\\n'"), false);
});

test('fault file schema accepts the six types and rejects a bad file', (t) => {
  const dir = tempDir(t, 'qcv-fault-schema-');
  assert.deepEqual(loadFaultFile(dir).map((fault) => fault.id), ['blank-app']);

  const omitted = validateFaultFile([entry({ id: 'drop', type: 'remove-element' })]);
  assert.deepEqual(loadFaultFile(writeFaults(dir, omitted)).map((fault) => fault.type), ['blank-app', 'remove-element']);

  const accepted = validateFaultFile([
    entry({ id: 'blank-app', type: 'blank-app', params: {}, expectedToBreak: [] }),
    entry({ id: 'hide', type: 'hide-element', params: { selector: '#b' } }),
    entry({ id: 'text', type: 'change-text', params: { selector: '#c', text: '' } }),
    entry({ id: 'block', type: 'block-request', params: { urlPattern: '**/secret.txt' } }),
    entry({ id: 'swap', type: 'user-swap', params: { env: { SAUCE_USER: 'other' } }, expectedToBreak: ['login'] }),
  ]);
  assert.deepEqual(accepted.map((fault) => fault.type), ['blank-app', 'hide-element', 'change-text', 'block-request', 'user-swap']);
  assert.equal(titleMatches('login', ['Login suite', 'login lands']), true);
  assert.equal(titleMatches('^login$', ['Login suite', 'login lands']), false);
  assert.equal(titleMatches('Login suite > login', ['Login suite', 'login lands']), true);

  assert.throws(() => validateFaultFile({ id: 'nope' }), /must be a JSON array/);
  assert.throws(() => validateFaultFile([entry({ id: 'Bad id' })]), /fault id/);
  assert.throws(() => validateFaultFile([entry(), entry()]), /repeats fault id/);
  assert.throws(
    () => loadFaultFile(writeFaults(dir, [entry({ id: 'blank-app', type: 'remove-element', params: { selector: 'h1' }, expectedToBreak: [] })])),
    /uses the id "blank-app" for a fault that is not type blank-app/,
  );
  assert.throws(() => validateFaultFile([entry({ extra: true })]), /unknown field/);
  assert.throws(() => validateFaultFile([entry({ type: 'nope' })]), /unknown type/);
  assert.throws(() => validateFaultFile([entry({ id: 'blank-app', type: 'blank-app', params: { selector: '#a' } })]), /params must be empty/);
  assert.throws(
    () => validateFaultFile([
      entry({ id: 'blank-app', type: 'blank-app', params: {}, expectedToBreak: [] }),
      entry({ id: 'blank-2', type: 'blank-app', params: {}, expectedToBreak: [] }),
    ]),
    /more than one blank-app/,
  );
  assert.throws(() => validateFaultFile([entry({ expectedToBreak: ['['] })]), /bad expectedToBreak pattern/);
  assert.throws(() => validateFaultFile([entry({ type: 'change-text', params: { selector: '#c' } })]), /missing param text/);
  assert.throws(() => validateFaultFile([entry({ type: 'user-swap', params: { env: {} } })]), /at least one variable/);
  assert.throws(() => validateFaultFile([entry({ type: 'user-swap', params: { env: { '1bad': 'x' } } })]), /bad env name/);
  assert.throws(() => validateFaultFile([entry({ type: 'user-swap', params: { env: { QCV_FAULT: 'x' } } })]), /must not start with QCV_/);
  assert.throws(() => validateFaultFile([entry({ type: 'user-swap', params: { env: { QCV_FAULT_LOG: 'x' } } })]), /must not start with QCV_/);
  assert.throws(
    () => validateFaultFile([entry({ id: 'Blank-App', type: 'remove-element', params: { selector: 'h1' } })]),
    /matches the built-in id "blank-app"/,
  );
  assert.throws(
    () => validateFaultFile([
      entry({ id: 'Hide-Note', type: 'hide-element', params: { selector: 'h1' } }),
      entry({ id: 'hide-note', type: 'hide-element', params: { selector: 'h1' } }),
    ]),
    /when case is ignored/,
  );
  fs.writeFileSync(path.join(dir, 'qa-core-verify.faults.json'), '{');
  assert.throws(() => loadFaultFile(dir), /Cannot read qa-core-verify\.faults\.json/);
});

test('F002, F003, F004, and the L002 upgrade come from the fault matrix', (t) => {
  const dir = tempDir(t, 'qcv-fault-class-');
  const file = path.join(dir, 'sample.spec.ts');
  fs.writeFileSync(
    file,
    `import { test, expect } from '@playwright/test';
test('checks a constant', async ({ page }) => {
  await page.goto('/');
  expect('seeded').toContain('seeded');
});
test('absent banner stays hidden', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#absent')).toBeHidden();
});
test('shows the original text', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#rename')).toHaveText('Original');
});
`,
  );
  const inventory = parseSpecFile(file, emptyConfig());
  const faults = validateFaultFile([
    { id: 'blank-app', type: 'blank-app', params: {}, expectedToBreak: [] },
    {
      id: 'rename-note',
      type: 'change-text',
      params: { selector: '#rename', text: 'Changed' },
      expectedToBreak: ['shows the original text', 'checks a constant'],
    },
    {
      id: 'show-absent',
      type: 'change-text',
      params: { selector: '#absent', text: 'now' },
      expectedToBreak: ['absent banner stays hidden'],
    },
  ]);
  const rows = inventory.tests.map((item) => {
    const counts = new Map();
    if (item.title === 'absent banner stays hidden') counts.set('show-absent', { '#absent': 0 });
    if (item.title === 'shows the original text') counts.set('rename-note', { '#rename': 1 });
    const pageText = item.title === 'shows the original text';
    return {
      test: item,
      ownerId: ownerForTest(item),
      baseline: 'pass',
      cells: [
        { id: 'blank-app', result: pageText ? 'fail' : 'pass' },
        { id: 'rename-note', result: pageText ? 'fail' : 'pass' },
        { id: 'show-absent', result: 'pass' },
      ],
      counts,
    };
  });
  const findings = classifyFindings(dir, faults, rows);
  const ids = (title) => findings.filter((finding) => finding.testTitle === title).map((finding) => finding.ruleId);
  assert.deepEqual(ids('checks a constant'), ['QCV-F002', 'QCV-F003']);
  assert.deepEqual(ids('absent banner stays hidden'), ['QCV-F002', 'QCV-F003', 'QCV-L002']);
  assert.deepEqual(ids('shows the original text'), []);
  const renameOnly = faults.filter((fault) => fault.id === 'rename-note');
  const constantRow = rows.find((row) => row.test.title === 'checks a constant');
  const withoutBlank = classifyFindings(dir, renameOnly, [{
    ...constantRow,
    cells: [{ id: 'rename-note', result: 'pass' }],
  }]);
  assert.deepEqual(withoutBlank.map((finding) => finding.ruleId), ['QCV-F003', 'QCV-F004']);
  const l002 = findings.find((finding) => finding.ruleId === 'QCV-L002');
  assert.equal(l002.severity, 'error');
  assert.match(l002.evidence, /#absent/);
  assert.match(l002.message, /stays green even if this element does not exist/);
});

test('a local page proves each fault type', { timeout: 300000 }, async (t) => {
  const project = tempDir(t, 'qcv-fault-html-');
  const scratch = tempDir(t, 'qcv-fault-html-tmp-');
  const out = tempDir(t, 'qcv-fault-html-out-');
  const bare = tempDir(t, 'qcv-fault-bare-');
  const bareOut = tempDir(t, 'qcv-fault-bare-out-');
  writeProject(project, await reservePort(), true);
  writeProject(bare, await reservePort(), false);
  const result = runCli([project, '--only', 'faults', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline: 8 passed, 0 failed, 0 skipped/);
  const baselineAt = result.stderr.indexOf('Baseline:');
  const faultAt = result.stderr.indexOf('Fault blank-app:');
  const timeAt = result.stderr.indexOf('Fault time:');
  assert.equal(baselineAt >= 0 && baselineAt < faultAt && faultAt < timeAt, true, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(validateSchema(schema, report), []);
  const byTitle = (title) => report.tests.find((entry) => entry.titlePath.at(-1) === title);
  const cell = (title, id) => byTitle(title).faults.find((entry) => entry.id === id);
  assert.equal(cell('shows the page title', 'blank-app').result, 'fail');
  assert.match(cell('shows the page title', 'blank-app').reason, /\S/);
  assert.equal(cell('shows the removable text', 'remove-title').result, 'fail');
  assert.equal(cell('shows the hidden text', 'hide-note').result, 'fail');
  assert.equal(cell('shows the original text', 'rename-note').result, 'fail');
  assert.equal(cell('reads the blocked file', 'block-file').result, 'fail');
  assert.equal(cell('reads the marker env', 'swap-marker').result, 'fail');
  const constant = byTitle('checks a constant');
  assert.equal(cell('checks a constant', 'blank-app').result, 'pass');
  assert.equal(cell('checks a constant', 'rename-note').result, 'pass');
  const constantRules = constant.findings.map((finding) => finding.ruleId).sort();
  assert.deepEqual(constantRules, ['QCV-F002', 'QCV-F003']);
  assert.equal(constant.verdict, 'untrusted');
  const absent = byTitle('absent banner stays hidden');
  const l002 = absent.findings.find((finding) => finding.ruleId === 'QCV-L002');
  assert.equal(l002.severity, 'error');
  assert.equal(report.checksRun.includes('cannot-fail'), true);
  assert.equal(report.checksRun.includes('locator'), true);
  assert.match(result.stdout, /Faults: /);
  assert.equal(result.stdout.includes('qcv-run-'), false);
  const bareRun = runCli([bare, '--only', 'faults', '--out', bareOut], privateEnv(scratch));
  assert.equal(bareRun.status, 1, `${bareRun.stdout}\n${bareRun.stderr}`);
  const bareReport = JSON.parse(fs.readFileSync(path.join(bareOut, 'report.json'), 'utf8'));
  assert.deepEqual(bareReport.faultRun.faults.map((fault) => fault.id), ['blank-app']);
  const bareConstant = bareReport.tests.find((entry) => entry.titlePath.at(-1) === 'checks a constant');
  assert.equal(bareConstant.findings.some((finding) => finding.ruleId === 'QCV-F002'), true);
  assert.equal(bareConstant.faults[0].result, 'pass');
  const bareTitle = bareReport.tests.find((entry) => entry.titlePath.at(-1) === 'shows the page title');
  assert.equal(bareTitle.faults[0].result, 'fail');
});

test('a blank-app id with another type exits 2 before a copy', (t) => {
  const project = tempDir(t, 'qcv-fault-id-');
  const scratch = tempDir(t, 'qcv-fault-id-tmp-');
  const file = path.join(project, 'qa-core-verify.faults.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify([{ id: 'blank-app', type: 'remove-element', params: { selector: 'h1' }, expectedToBreak: [] }])}\n`,
  );
  const before = fs.readFileSync(file);
  const result = runCli([project, '--only', 'faults'], privateEnv(scratch));
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /qa-core-verify\.faults\.json uses the id "blank-app" for a fault that is not type blank-app\./);
  assert.equal(result.stderr.includes('Baseline:'), false);
  assert.equal(fs.readdirSync(scratch).length, 0, fs.readdirSync(scratch).join(','));
  assert.deepEqual(fs.readFileSync(file), before);
});

test('a fault that was not applied does not raise F002, F003, or F004', (t) => {
  const dir = tempDir(t, 'qcv-fault-gap-');
  const file = path.join(dir, 'gap.spec.ts');
  fs.writeFileSync(
    file,
    `import { test, expect } from '@playwright/test';
test('api only returns widget', async ({ request }) => {
  expect(1).toBe(1);
});
`,
  );
  const inventory = parseSpecFile(file, emptyConfig());
  const faults = validateFaultFile([
    { id: 'blank-app', type: 'blank-app', params: {}, expectedToBreak: [] },
    { id: 'block-data', type: 'block-request', params: { urlPattern: '**/data.json' }, expectedToBreak: ['api only returns widget'] },
  ]);
  const reason = 'The fault was not applied to a page this test used.';
  const rows = inventory.tests.map((item) => ({
    test: item,
    ownerId: ownerForTest(item),
    baseline: 'pass',
    cells: [
      { id: 'blank-app', result: 'not-run', reason },
      { id: 'block-data', result: 'not-run', reason },
    ],
    counts: new Map(),
  }));
  const findings = classifyFindings(dir, faults, rows);
  assert.deepEqual(findings, []);
});

test('a new context, setContent, a request, and a popup are judged from the page that ran', { timeout: 180000 }, async (t) => {
  const project = tempDir(t, 'qcv-fault-cover-');
  const scratch = tempDir(t, 'qcv-fault-cover-tmp-');
  const out = tempDir(t, 'qcv-fault-cover-out-');
  const port = await reservePort();
  fs.writeFileSync(
    path.join(project, 'server.mjs'),
    `import http from 'node:http';
const home = '<!doctype html><html><body><h1>Products</h1></body></html>';
const opener = '<!doctype html><html><body><a id="open" href="/popup.html" target="_blank">open</a></body></html>';
const popup = '<!doctype html><html><body><p id="name">loading</p><script>fetch("/data.json").then(function (response) { return response.json(); }).then(function (body) { document.getElementById("name").textContent = body.name; });</script></body></html>';
http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/data.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'widget' }));
    return;
  }
  if (url === '/api/widget') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'widget' }));
    return;
  }
  if (url === '/popup.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(popup);
    return;
  }
  if (url === '/opener.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(opener);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(home);
}).listen(${port}, '127.0.0.1');
`,
  );
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({
  retries: 0,
  timeout: 15000,
  testDir: '.',
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:${port}', timeout: 10000, reuseExistingServer: false },
  use: { baseURL: 'http://127.0.0.1:${port}', headless: true },
  expect: { timeout: 3000 },
});
`,
  );
  fs.writeFileSync(
    path.join(project, 'probe.spec.ts'),
    `import { test, expect } from '@playwright/test';

test('setContent page is visible', async ({ page }) => {
  await page.setContent('<h1>Products</h1>');
  await expect(page.locator('h1')).toHaveText('Products');
});

test('new context page shows title', async ({ browser }) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto('/');
  await expect(p.locator('h1')).toHaveText('Products');
  await ctx.close();
});

test('api only returns widget', async ({ request }) => {
  const response = await request.get('/api/widget');
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.name).toBe('widget');
});

test('popup loads data', async ({ page }) => {
  await page.goto('/opener.html');
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#open').click();
  const popup = await popupPromise;
  await expect(popup.locator('#name')).toHaveText('widget');
});
`,
  );
  writeFaults(project, [
    {
      id: 'block-data',
      type: 'block-request',
      params: { urlPattern: '**/data.json' },
      expectedToBreak: ['popup loads data'],
    },
  ]);
  const result = runCli([project, '--only', 'faults', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const row = (title) => report.tests.find((entry) => entry.titlePath.at(-1) === title);
  const cell = (title, id) => row(title).faults.find((entry) => entry.id === id);
  const rules = (title) => row(title).findings.map((finding) => finding.ruleId);
  assert.equal(cell('new context page shows title', 'blank-app').result, 'fail');
  assert.equal(rules('new context page shows title').includes('QCV-F002'), false);
  assert.equal(cell('setContent page is visible', 'blank-app').result, 'fail');
  assert.equal(rules('setContent page is visible').includes('QCV-F002'), false);
  assert.equal(cell('api only returns widget', 'blank-app').result, 'not-run');
  assert.match(cell('api only returns widget', 'blank-app').reason, /not applied to a page/);
  assert.equal(rules('api only returns widget').includes('QCV-F002'), false);
  assert.equal(rules('api only returns widget').includes('QCV-F004'), false);
  assert.equal(cell('popup loads data', 'block-data').result, 'fail');
  assert.equal(rules('popup loads data').includes('QCV-F003'), false);
  assert.equal(fs.readdirSync(scratch).length, 0, fs.readdirSync(scratch).join(','));
});

test('a page armed in beforeAll or a worker fixture stays applied', { timeout: 180000 }, async (t) => {
  const project = tempDir(t, 'qcv-fault-shared-');
  const scratch = tempDir(t, 'qcv-fault-shared-tmp-');
  const out = tempDir(t, 'qcv-fault-shared-out-');
  const port = await reservePort();
  fs.writeFileSync(
    path.join(project, 'server.mjs'),
    `import http from 'node:http';
const home = '<!doctype html><html><body><h1>Products</h1></body></html>';
http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/widget') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'widget' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(home);
}).listen(${port}, '127.0.0.1');
`,
  );
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({
  retries: 0,
  timeout: 15000,
  testDir: '.',
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:${port}', timeout: 10000, reuseExistingServer: false },
  use: { baseURL: 'http://127.0.0.1:${port}', headless: true },
  expect: { timeout: 3000 },
});
`,
  );
  fs.writeFileSync(
    path.join(project, 'probe.spec.ts'),
    `import { test, expect, type Page } from '@playwright/test';

let shared: Page;
test.describe('shared page', () => {
  test.beforeAll(async ({ browser }) => {
    shared = await browser.newPage({ baseURL: 'http://127.0.0.1:${port}' });
    await shared.goto('/');
  });
  test.afterAll(async () => {
    await shared.context().close();
  });

  test('shared page reads title', async () => {
    await expect(shared.locator('h1')).toHaveText('Products');
  });
  test('shared page vacuous', async () => {
    void shared;
    expect(1).toBe(1);
  });
});

let workerPage: Page | undefined;
const wtest = test.extend<{ wapp: Page }>({
  wapp: [async ({ browser }, use) => {
    workerPage = await browser.newPage({ baseURL: 'http://127.0.0.1:${port}' });
    await workerPage.goto('/');
    await use(workerPage);
  }, { scope: 'worker' }],
});

test.describe('worker page', () => {
  test.afterAll(async () => {
    if (workerPage) await workerPage.context().close();
  });
  wtest('worker page vacuous', async ({ wapp }) => {
    void wapp;
    expect(1).toBe(1);
  });
  wtest('worker page reads title', async ({ wapp }) => {
    await expect(wapp.locator('h1')).toHaveText('Products');
  });
});

test('api only returns widget', async ({ request }) => {
  const response = await request.get('/api/widget');
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.name).toBe('widget');
});
`,
  );
  writeFaults(project, [
    {
      id: 'no-h1',
      type: 'remove-element',
      params: { selector: 'h1' },
      expectedToBreak: [],
    },
  ]);
  const result = runCli([project, '--only', 'faults', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const row = (title) => report.tests.find((entry) => entry.titlePath.at(-1) === title);
  const cell = (title, id) => row(title).faults.find((entry) => entry.id === id);
  const rules = (title) => row(title).findings.map((finding) => finding.ruleId);
  assert.equal(cell('shared page reads title', 'blank-app').result, 'fail');
  assert.equal(cell('shared page reads title', 'no-h1').result, 'fail');
  assert.match(cell('shared page reads title', 'blank-app').reason, /\S/);
  assert.equal(rules('shared page reads title').includes('QCV-F002'), false);
  assert.equal(rules('shared page reads title').includes('QCV-F003'), false);
  assert.equal(cell('shared page vacuous', 'blank-app').result, 'pass');
  assert.equal(rules('shared page vacuous').includes('QCV-F002'), true);
  assert.equal(cell('worker page vacuous', 'blank-app').result, 'pass');
  assert.equal(cell('worker page vacuous', 'no-h1').result, 'pass');
  assert.equal(rules('worker page vacuous').includes('QCV-F002'), true);
  assert.equal(cell('worker page reads title', 'blank-app').result, 'fail');
  assert.equal(cell('worker page reads title', 'no-h1').result, 'fail');
  assert.match(cell('worker page reads title', 'blank-app').reason, /\S/);
  assert.equal(rules('worker page reads title').includes('QCV-F002'), false);
  assert.equal(cell('api only returns widget', 'blank-app').result, 'not-run');
  assert.match(cell('api only returns widget', 'blank-app').reason, /not applied to a page/);
  assert.equal(cell('api only returns widget', 'no-h1').result, 'not-run');
  assert.equal(rules('api only returns widget').includes('QCV-F002'), false);
  assert.equal(rules('api only returns widget').includes('QCV-F004'), false);
  assert.equal(row('api only returns widget').verdict, 'trusted');
  assert.equal(
    row('api only returns widget').reason,
    'Every fault was not-run, so the cannot-fail check did not exercise this test.',
  );
  assert.equal(fs.readdirSync(scratch).length, 0, fs.readdirSync(scratch).join(','));
});

test('a page left open by an earlier test does not count for a later test', { timeout: 180000 }, async (t) => {
  const project = tempDir(t, 'qcv-fault-leak-');
  const scratch = tempDir(t, 'qcv-fault-leak-tmp-');
  const out = tempDir(t, 'qcv-fault-leak-out-');
  const port = await reservePort();
  fs.writeFileSync(
    path.join(project, 'server.mjs'),
    `import http from 'node:http';
const home = '<!doctype html><html><body><h1>Products</h1></body></html>';
http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/widget') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'widget' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(home);
}).listen(${port}, '127.0.0.1');
`,
  );
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({
  retries: 0,
  timeout: 15000,
  testDir: '.',
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:${port}', timeout: 10000, reuseExistingServer: false },
  use: { baseURL: 'http://127.0.0.1:${port}', headless: true },
  expect: { timeout: 3000 },
});
`,
  );
  fs.writeFileSync(
    path.join(project, 'probe.spec.ts'),
    `import { test, expect } from '@playwright/test';

test('leaves its page open', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  expect(1).toBe(1);
});

test('page less after an open page', async () => {
  expect(1).toBe(1);
});

test('request only after an open page', async ({ request }) => {
  const response = await request.get('/api/widget');
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.name).toBe('widget');
});

test('reads the title and leaves the page open', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Products');
});

test('page less after a failed open', async () => {
  expect(1).toBe(1);
});

test('request only after a failed open', async ({ request }) => {
  const response = await request.get('/api/widget');
  expect(response.ok()).toBeTruthy();
});
`,
  );
  writeFaults(project, [
    {
      id: 'no-h1',
      type: 'remove-element',
      params: { selector: 'h1' },
      expectedToBreak: ['page less after', 'request only after'],
    },
    {
      id: 'block-data',
      type: 'block-request',
      params: { urlPattern: '**/api/widget' },
      expectedToBreak: ['request only after'],
    },
  ]);
  const result = runCli([project, '--only', 'faults', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const row = (title) => report.tests.find((entry) => entry.titlePath.at(-1) === title);
  const cell = (title, id) => row(title).faults.find((entry) => entry.id === id);
  const rules = (title) => row(title).findings.map((finding) => finding.ruleId);
  assert.equal(cell('leaves its page open', 'blank-app').result, 'pass');
  assert.equal(rules('leaves its page open').includes('QCV-F002'), true);
  for (const title of ['page less after an open page', 'request only after an open page', 'page less after a failed open', 'request only after a failed open']) {
    assert.equal(cell(title, 'blank-app').result, 'not-run', title);
    assert.match(cell(title, 'blank-app').reason, /not applied to a page/);
    assert.equal(cell(title, 'no-h1').result, 'not-run', title);
    assert.equal(rules(title).includes('QCV-F002'), false, title);
    assert.equal(rules(title).includes('QCV-F003'), false, title);
    assert.equal(rules(title).includes('QCV-F004'), false, title);
  }
  assert.equal(cell('request only after an open page', 'block-data').result, 'not-run');
  assert.equal(cell('request only after a failed open', 'block-data').result, 'not-run');
  assert.equal(cell('reads the title and leaves the page open', 'blank-app').result, 'fail');
  assert.equal(cell('reads the title and leaves the page open', 'no-h1').result, 'fail');
  assert.equal(rules('reads the title and leaves the page open').includes('QCV-F002'), false);
  assert.equal(fs.readdirSync(scratch).length, 0, fs.readdirSync(scratch).join(','));
});

test('playwright stays pinned at 1.60.0', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@playwright/test'], '1.60.0');
  assert.equal(pkg.dependencies.playwright, '1.60.0');
});

test('a fault run that drops a baseline location is a gap', () => {
  const seen = new Set(['probe.spec.ts:4:1', 'probe.spec.ts:8:1']);
  const baseline = {
    ok: true,
    exitCode: 0,
    passed: 2,
    failed: 0,
    skipped: 0,
    failedKeys: new Set(),
    seenKeys: seen,
    skippedKeys: new Set(),
    stdout: '',
    stderr: '',
  };
  const fault = { ...baseline, seenKeys: new Set(['probe.spec.ts:4:1']) };
  assert.equal(faultRunGap(baseline, fault), 1);
  assert.equal(faultRunGap(baseline, baseline), 0);
  assert.equal(FAULT_NOT_FOUND_REASON, 'The test was not found in the fault run.');
});

test('mergeTests of imported fixtures is inventoried', (t) => {
  const dir = tempDir(t, 'qcv-merge-inv-');
  fs.writeFileSync(
    path.join(dir, 'fx.ts'),
    `import { test as base } from '@playwright/test';
export const a = base.extend<{ one: number }>({ one: async ({}, use) => { await use(1); } });
export const b = base.extend<{ two: number }>({ two: async ({}, use) => { await use(2); } });
`,
  );
  const file = path.join(dir, 'probe.spec.ts');
  fs.writeFileSync(
    file,
    `import { mergeTests, expect } from '@playwright/test';
import { a, b } from './fx';
const test = mergeTests(a, b);
test('merged leaky', async ({ one, two }) => { expect(one + two).toBe(3); });
test('page less after merged', async () => { expect(1).toBe(1); });
`,
  );
  const inventory = parseSpecFile(file, emptyConfig());
  assert.deepEqual(
    inventory.tests.map((entry) => entry.titlePath.at(-1)),
    ['merged leaky', 'page less after merged'],
  );
});

test('test, test.fail, and mergeTests keep the spec line', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-loc-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-loc-tmp-'));
  try {
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(project, 'node_modules'));
    fs.writeFileSync(path.join(project, 'fixture.mjs'), faultFixtureSource());
    fs.writeFileSync(
      path.join(project, 'fx.mjs'),
      `import { test as base } from './fixture.mjs';
export const a = base.extend({ one: async ({}, use) => { await use(1); } });
export const b = base.extend({ two: async ({}, use) => { await use(2); } });
`,
    );
    fs.writeFileSync(
      path.join(project, 'probe.spec.ts'),
      `import { mergeTests, expect } from './fixture.mjs';
import { a, b } from './fx.mjs';
const test = mergeTests(a, b);
test('merged', async ({ one, two }) => { expect(one + two).toBe(3); });
test.fail('fails', async () => { expect(1).toBe(2); });
test('plain', async () => { expect(1).toBe(1); });
`,
    );
    fs.writeFileSync(
      path.join(project, 'playwright.config.ts'),
      `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', retries: 0 });
`,
    );
    const listed = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', '@playwright/test', 'cli.js'),
        'test',
        '--list',
        '--config',
        path.join(project, 'playwright.config.ts'),
      ],
      { encoding: 'utf8', cwd: project, env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp } },
    );
    assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
    assert.equal(listed.stdout.includes('index.js'), false, listed.stdout);
    assert.match(listed.stdout, /probe\.spec\.ts:4:\d+ › merged/);
    assert.match(listed.stdout, /probe\.spec\.ts:5:\d+ › fails/);
    assert.match(listed.stdout, /probe\.spec\.ts:6:\d+ › plain/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a plain test in a fault run keeps its spec line', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-loc-run-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-loc-run-tmp-'));
  try {
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(project, 'node_modules'));
    fs.writeFileSync(path.join(project, 'fixture.mjs'), faultFixtureSource());
    const spec = [
      "import { test, expect } from './fixture.mjs';",
      "test('plain located', async () => { expect(1).toBe(1); });",
      '',
    ].join('\n');
    fs.writeFileSync(path.join(project, 'probe.spec.ts'), spec);
    fs.writeFileSync(
      path.join(project, 'playwright.config.ts'),
      `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', retries: 0 });
`,
    );
    const run = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', '@playwright/test', 'cli.js'),
        'test',
        '--retries=0',
        '--reporter=json',
        '--config',
        path.join(project, 'playwright.config.ts'),
      ],
      {
        encoding: 'utf8',
        cwd: project,
        env: {
          ...process.env,
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
          QCV_FAULT: JSON.stringify({ id: 'blank-app', type: 'blank-app', params: {}, expectedToBreak: [] }),
        },
      },
    );
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const start = run.stdout.indexOf('{');
    const report = JSON.parse(run.stdout.slice(start));
    const specs = [];
    const walk = (suite) => {
      for (const spec of suite.specs ?? []) specs.push(spec);
      for (const child of suite.suites ?? []) walk(child);
    };
    for (const suite of report.suites ?? []) walk(suite);
    const plain = specs.find((spec) => (spec.title ?? '').includes('plain located') || (spec.tests ?? []).some((entry) => entry.title === 'plain located'));
    assert.ok(plain, JSON.stringify(specs.map((spec) => spec.title)));
    assert.equal(plain.line, 2, JSON.stringify(plain));
    assert.equal(String(plain.file).endsWith('probe.spec.ts'), true, plain.file);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a page leaked by beforeEach does not count for the next test', { timeout: 180000 }, async (t) => {
  const port = await reservePort();
  const { result, report } = await runBlankSuite(
    t,
    'qcv-fault-each-',
    port,
    `import { test, expect, type Page } from '@playwright/test';
test.describe('each', () => {
  let pg: Page;
  test.beforeEach(async ({ browser }) => { pg = await browser.newPage({ baseURL: 'http://127.0.0.1:${port}' }); await pg.goto('/'); });
  test('beforeEach leak vacuous', async () => { void pg; expect(1).toBe(1); });
});
test('page less after beforeEach leak', async () => { expect(1).toBe(1); });
`,
  );
  assertLeak(result, report, 'beforeEach leak vacuous', 'page less after beforeEach leak');
});

test('a page leaked by a test scoped fixture does not count for the next test', { timeout: 180000 }, async (t) => {
  const port = await reservePort();
  const { result, report } = await runBlankSuite(
    t,
    'qcv-fault-fixleak-',
    port,
    `import { test as base, expect, type Page } from '@playwright/test';
const test = base.extend<{ leaky: Page }>({
  leaky: async ({ browser }, use) => {
    const p = await browser.newPage({ baseURL: 'http://127.0.0.1:${port}' });
    await p.goto('/');
    await use(p);
  },
});
test('fixture leak vacuous', async ({ leaky }) => { void leaky; expect(1).toBe(1); });
test('page less after fixture leak', async () => { expect(1).toBe(1); });
`,
  );
  assertLeak(result, report, 'fixture leak vacuous', 'page less after fixture leak');
});

test('a page leaked by test.fail does not count for the next test', { timeout: 180000 }, async (t) => {
  const port = await reservePort();
  const { result, report } = await runBlankSuite(
    t,
    'qcv-fault-fail-',
    port,
    `import { test, expect } from '@playwright/test';
test.fail('expected failure leaks page', async ({ browser }) => {
  const p = await browser.newPage({ baseURL: 'http://127.0.0.1:${port}' });
  await p.goto('/');
  expect(1).toBe(2);
});
test('page less after test.fail', async () => { expect(1).toBe(1); });
`,
  );
  assertLeak(result, report, 'expected failure leaks page', 'page less after test.fail');
});

test('a page in a test.skip or test.fixme body does not count for the next test', { timeout: 180000 }, async (t) => {
  const port = await reservePort();
  const { result, report } = await runBlankSuite(
    t,
    'qcv-fault-skip-',
    port,
    `import { test, expect } from '@playwright/test';
test.skip('skip body leaks page', async ({ browser }) => {
  const p = await browser.newPage({ baseURL: 'http://127.0.0.1:${port}' });
  await p.goto('/');
  expect(1).toBe(1);
});
test('page less after test.skip', async () => { expect(1).toBe(1); });
test.fixme('fixme body leaks page', async ({ browser }) => {
  const p = await browser.newPage({ baseURL: 'http://127.0.0.1:${port}' });
  await p.goto('/');
  expect(1).toBe(1);
});
test('page less after test.fixme', async () => { expect(1).toBe(1); });
`,
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const { cell, rules } = faultView(report);
  for (const title of ['page less after test.skip', 'page less after test.fixme']) {
    assert.equal(cell(title, 'blank-app').result, 'not-run', title);
    assert.match(cell(title, 'blank-app').reason, /not applied to a page/);
    assert.equal(rules(title).includes('QCV-F002'), false, title);
    assert.equal(rules(title).includes('QCV-F004'), false, title);
  }
});

test('mergeTests keeps fault results on the spec tests', { timeout: 180000 }, async (t) => {
  const project = tempDir(t, 'qcv-fault-merge-');
  const scratch = tempDir(t, 'qcv-fault-merge-tmp-');
  const out = tempDir(t, 'qcv-fault-merge-out-');
  const port = await reservePort();
  writeBlankServer(project, port);
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    blankConfig(port),
  );
  fs.writeFileSync(
    path.join(project, 'fx.ts'),
    `import { test as base } from '@playwright/test';
export const a = base.extend<{ one: number }>({ one: async ({}, use) => { await use(1); } });
export const b = base.extend<{ two: number }>({ two: async ({}, use) => { await use(2); } });
`,
  );
  fs.writeFileSync(
    path.join(project, 'probe.spec.ts'),
    `import { mergeTests, expect } from '@playwright/test';
import { a, b } from './fx';
const test = mergeTests(a, b);
test('merged leaky', async ({ browser, one, two }) => {
  const p = await browser.newPage({ baseURL: 'http://127.0.0.1:${port}' });
  await p.goto('/');
  expect(one + two).toBe(3);
});
test('page less after merged', async () => { expect(1).toBe(1); });
`,
  );
  writeFaults(project, []);
  const result = runCli([project, '--only', 'faults', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assertLeak(result, report, 'merged leaky', 'page less after merged');
  assert.equal(result.stderr.includes('0 fail, 0 pass, 0 skipped, 0 not-run'), false, result.stderr);
  assert.equal(result.stderr.includes('did not include every test'), false, result.stderr);
  assert.equal(fs.readdirSync(scratch).length, 0, fs.readdirSync(scratch).join(','));
});

test('a closed page is judged from the body it had before close', { timeout: 180000 }, async (t) => {
  const port = await reservePort();
  const { result, report } = await runBlankSuite(
    t,
    'qcv-fault-close-',
    port,
    `import { test, expect } from '@playwright/test';
test('replaces the body then closes', async ({ browser }) => {
  const p = await browser.newPage({ baseURL: 'http://127.0.0.1:${port}' });
  await p.goto('/');
  await p.evaluate(() => {
    document.open();
    document.write('<html><body><h1>Replaced</h1></body></html>');
    document.close();
  });
  await expect(p.locator('h1')).toHaveText('Replaced');
  await p.close();
});
`,
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const { cell, rules, row } = faultView(report);
  assert.equal(cell('replaces the body then closes', 'blank-app').result, 'not-run');
  assert.match(cell('replaces the body then closes', 'blank-app').reason, /blank page was not present/);
  assert.equal(rules('replaces the body then closes').includes('QCV-F002'), false);
  assert.equal(row('replaces the body then closes').verdict, 'trusted');
});

test('an expectedToBreak pattern that matches nothing is printed', { timeout: 120000 }, async (t) => {
  const project = tempDir(t, 'qcv-fault-miss-');
  const scratch = tempDir(t, 'qcv-fault-miss-tmp-');
  const out = tempDir(t, 'qcv-fault-miss-out-');
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({ retries: 0, timeout: 15000, testDir: '.' });
`,
  );
  fs.writeFileSync(
    path.join(project, 'probe.spec.ts'),
    `import { test, expect } from '@playwright/test';
test('alpha', async () => { expect(1).toBe(1); });
`,
  );
  writeFaults(project, [
    { id: 'blank-app', type: 'blank-app', params: {}, expectedToBreak: ['no such test'] },
  ]);
  const result = runCli([project, '--only', 'faults', '--out', out], privateEnv(scratch));
  assert.equal(result.status === 0 || result.status === 1, true, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Fault blank-app expectedToBreak pattern "no such test" matched no test\./);
});

test('baseline locations that match no inventoried test exit 2', { timeout: 120000 }, async (t) => {
  const project = tempDir(t, 'qcv-fault-drift-');
  const scratch = tempDir(t, 'qcv-fault-drift-tmp-');
  const out = tempDir(t, 'qcv-fault-drift-out-');
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({ retries: 0, timeout: 15000, testDir: '.' });
`,
  );
  fs.writeFileSync(
    path.join(project, 'probe.spec.ts'),
    `import { test, expect } from '@playwright/test';
test('alpha', async () => { expect(1).toBe(1); });
`,
  );
  const result = runCli([project, '--only', 'faults', '--out', out], {
    ...privateEnv(scratch),
    QCV_TEST_LOCATION_DRIFT: '1',
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Baseline locations match no inventoried test/);
  assert.equal(result.stderr.includes('broke no test'), false, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const row = report.tests.find((entry) => entry.titlePath.at(-1) === 'alpha');
  assert.equal(row.verdict, 'not-run');
  assert.equal(row.reason, 'The baseline locations do not match the inventoried tests.');
  assert.equal(row.faults[0].result, 'not-run');
  assert.equal(row.faults[0].reason, 'The baseline locations do not match the inventoried tests.');
});

test('a worker fixture on mergeTests().extend counts for a later test', { timeout: 180000 }, async (t) => {
  const port = await reservePort();
  const project = tempDir(t, 'qcv-fault-merge-worker-');
  const scratch = tempDir(t, 'qcv-fault-merge-worker-tmp-');
  const out = tempDir(t, 'qcv-fault-merge-worker-out-');
  writeBlankServer(project, port);
  fs.writeFileSync(path.join(project, 'playwright.config.ts'), blankConfig(port));
  fs.writeFileSync(
    path.join(project, 'fx.ts'),
    `import { test as base } from '@playwright/test';
export const a = base.extend<{ one: number }>({ one: async ({}, use) => { await use(1); } });
export const b = base.extend<{ two: number }>({ two: async ({}, use) => { await use(2); } });
`,
  );
  fs.writeFileSync(
    path.join(project, 'probe.spec.ts'),
    `import { mergeTests, expect } from '@playwright/test';
import { a, b } from './fx';
const test = mergeTests(a, b).extend({
  wapp: [async ({ browser }, use) => {
    const p = await browser.newPage({ baseURL: 'http://127.0.0.1:${port}' });
    await p.goto('/');
    await use(p);
  }, { scope: 'worker' }],
});
test('before the worker page', async () => { expect(1).toBe(1); });
test('uses the worker page', async ({ wapp }) => { void wapp; expect(1).toBe(1); });
test('after the worker page', async () => { expect(1).toBe(1); });
`,
  );
  writeFaults(project, []);
  const result = runCli([project, '--only', 'faults', '--out', out], privateEnv(scratch));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const { cell, rules } = faultView(report);
  assert.equal(cell('before the worker page', 'blank-app').result, 'not-run');
  assert.equal(cell('uses the worker page', 'blank-app').result, 'pass');
  assert.equal(rules('uses the worker page').includes('QCV-F002'), true);
  assert.equal(cell('after the worker page', 'blank-app').result, 'pass');
  assert.equal(rules('after the worker page').includes('QCV-F002'), true);
  assert.equal(fs.readdirSync(scratch).length, 0, fs.readdirSync(scratch).join(','));
});

function assertLeak(result, report, leaker, follower) {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const { row, cell, rules } = faultView(report);
  assert.equal(cell(leaker, 'blank-app').result, 'pass', leaker);
  assert.equal(cell(leaker, 'blank-app').reason, undefined, leaker);
  assert.equal(rules(leaker).includes('QCV-F002'), true, leaker);
  assert.equal(row(leaker).verdict, 'untrusted', leaker);
  assert.equal(cell(follower, 'blank-app').result, 'not-run', follower);
  assert.match(cell(follower, 'blank-app').reason, /not applied to a page/);
  assert.equal(rules(follower).includes('QCV-F002'), false, follower);
  assert.equal(rules(follower).includes('QCV-F003'), false, follower);
  assert.equal(rules(follower).includes('QCV-F004'), false, follower);
  assert.equal(result.stderr.includes('did not include every test'), false, result.stderr);
}

function faultView(report) {
  const row = (title) => report.tests.find((entry) => entry.titlePath.at(-1) === title);
  const cell = (title, id) => row(title).faults.find((entry) => entry.id === id);
  const rules = (title) => row(title).findings.map((finding) => finding.ruleId);
  return { row, cell, rules };
}

async function runBlankSuite(t, prefix, port, spec) {
  const project = tempDir(t, prefix);
  const scratch = tempDir(t, `${prefix}tmp-`);
  const out = tempDir(t, `${prefix}out-`);
  writeBlankServer(project, port);
  fs.writeFileSync(path.join(project, 'playwright.config.ts'), blankConfig(port));
  fs.writeFileSync(path.join(project, 'probe.spec.ts'), spec);
  writeFaults(project, []);
  const result = runCli([project, '--only', 'faults', '--out', out], privateEnv(scratch));
  const reportPath = path.join(out, 'report.json');
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
  assert.equal(fs.readdirSync(scratch).length, 0, fs.readdirSync(scratch).join(','));
  return { result, report };
}

function writeBlankServer(project, port) {
  fs.writeFileSync(
    path.join(project, 'server.mjs'),
    `import http from 'node:http';
const home = '<!doctype html><html><body><h1>Products</h1><span id="badge">3</span></body></html>';
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(home);
}).listen(${port}, '127.0.0.1');
`,
  );
}

function blankConfig(port) {
  return `import { defineConfig } from '@playwright/test';
export default defineConfig({
  retries: 0,
  timeout: 15000,
  testDir: '.',
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:${port}', timeout: 10000, reuseExistingServer: false },
  use: { baseURL: 'http://127.0.0.1:${port}', headless: true },
  expect: { timeout: 3000 },
});
`;
}

function writeFaults(dir, faults) {
  fs.writeFileSync(path.join(dir, 'qa-core-verify.faults.json'), `${JSON.stringify(faults, null, 2)}\n`);
  return dir;
}

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

function writeProject(dir, port, withFaultFile) {
  fs.writeFileSync(
    path.join(dir, 'server.mjs'),
    `import http from 'node:http';
const page = ${JSON.stringify(`<!doctype html>
<html><body>
<h1 id="title">Hello</h1>
<p id="remove-me">Remove</p>
<p id="hide-me">Hide</p>
<p id="rename">Original</p>
<script>
setTimeout(function () {
  function node(tag, id, text) {
    var found = document.getElementById(id);
    if (!found) {
      found = document.createElement(tag);
      found.id = id;
      document.body.appendChild(found);
    }
    found.textContent = text;
    found.style.removeProperty('display');
    return found;
  }
  node('h1', 'title', 'Hello');
  node('p', 'remove-me', 'Remove');
  node('p', 'hide-me', 'Hide');
  node('p', 'rename', 'Original');
}, 200);
</script>
</body></html>`)};
http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/blocked.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('secret');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
}).listen(${port}, '127.0.0.1');
`,
  );
  fs.writeFileSync(
    path.join(dir, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';
export default defineConfig({
  retries: 0,
  timeout: 10000,
  testDir: '.',
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:${port}', timeout: 10000, reuseExistingServer: false },
  use: { baseURL: 'http://127.0.0.1:${port}', headless: true },
  expect: { timeout: 3000 },
});
`,
  );
  fs.writeFileSync(
    path.join(dir, 'faults.spec.ts'),
    `import { test, expect } from '@playwright/test';

test('shows the page title', async ({ page }) => {
  await page.goto('/page.html');
  await expect(page.locator('#title')).toHaveText('Hello');
});

test('shows the removable text', async ({ page }) => {
  await page.goto('/page.html');
  await expect(page.locator('#remove-me')).toBeVisible();
});

test('shows the hidden text', async ({ page }) => {
  await page.goto('/page.html');
  await expect(page.locator('#hide-me')).toBeVisible();
});

test('shows the original text', async ({ page }) => {
  await page.goto('/page.html');
  await expect(page.locator('#rename')).toHaveText('Original');
});

test('reads the blocked file', async ({ page }) => {
  await page.goto('/page.html');
  const status = await page.evaluate(async () => {
    const response = await fetch('/blocked.txt');
    return response.status;
  });
  expect(status).toBe(200);
});

test('reads the marker env', () => {
  expect(process.env.DEMO_MARKER ?? 'plain').toBe('plain');
});

test('checks a constant', async ({ page }) => {
  await page.goto('/page.html');
  expect('seeded').toContain('seeded');
});

test('absent banner stays hidden', async ({ page }) => {
  await page.goto('/page.html');
  await expect(page.locator('#absent')).toBeHidden();
});
`,
  );
  if (!withFaultFile) return;
  writeFaults(dir, [
    { id: 'blank-app', type: 'blank-app', params: {}, expectedToBreak: [] },
    { id: 'remove-title', type: 'remove-element', params: { selector: '#remove-me' }, expectedToBreak: ['shows the removable text'] },
    { id: 'hide-note', type: 'hide-element', params: { selector: '#hide-me' }, expectedToBreak: ['shows the hidden text'] },
    {
      id: 'rename-note',
      type: 'change-text',
      params: { selector: '#rename', text: 'Changed' },
      expectedToBreak: ['shows the original text', 'checks a constant'],
    },
    { id: 'block-file', type: 'block-request', params: { urlPattern: '**/blocked.txt' }, expectedToBreak: ['reads the blocked file'] },
    { id: 'swap-marker', type: 'user-swap', params: { env: { DEMO_MARKER: 'swapped' } }, expectedToBreak: ['reads the marker env'] },
    {
      id: 'show-absent',
      type: 'change-text',
      params: { selector: '#absent', text: 'now' },
      expectedToBreak: ['absent banner stays hidden'],
    },
  ]);
}
