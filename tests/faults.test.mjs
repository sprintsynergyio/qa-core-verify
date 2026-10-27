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
  assert.equal(source.includes('browser.newContext'), true);
  assert.equal(source.includes('page.setContent'), true);
  assert.equal(source.includes('MutationObserver'), true);
  assert.equal(source.includes('blank-app'), true);
  assert.equal(source.includes('data-qcv-blank'), true);
  assert.equal(source.includes('route.abort'), true);
  assert.equal(source.includes("export * from '@playwright/test'"), true);
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
  assert.deepEqual(ids('checks a constant'), ['QCV-F002', 'QCV-F003', 'QCV-F004']);
  assert.deepEqual(ids('absent banner stays hidden'), ['QCV-F002', 'QCV-F003', 'QCV-F004', 'QCV-L002']);
  assert.deepEqual(ids('shows the original text'), []);
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
  assert.equal(cell('shows the removable text', 'remove-title').result, 'fail');
  assert.equal(cell('shows the hidden text', 'hide-note').result, 'fail');
  assert.equal(cell('shows the original text', 'rename-note').result, 'fail');
  assert.equal(cell('reads the blocked file', 'block-file').result, 'fail');
  assert.equal(cell('reads the marker env', 'swap-marker').result, 'fail');
  const constant = byTitle('checks a constant');
  assert.equal(cell('checks a constant', 'blank-app').result, 'pass');
  assert.equal(cell('checks a constant', 'rename-note').result, 'pass');
  const constantRules = constant.findings.map((finding) => finding.ruleId).sort();
  assert.deepEqual(constantRules, ['QCV-F002', 'QCV-F003', 'QCV-F004']);
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
  expect(process.env.QCV_DEMO_MARKER ?? 'plain').toBe('plain');
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
    { id: 'swap-marker', type: 'user-swap', params: { env: { QCV_DEMO_MARKER: 'swapped' } }, expectedToBreak: ['reads the marker env'] },
    {
      id: 'show-absent',
      type: 'change-text',
      params: { selector: '#absent', text: 'now' },
      expectedToBreak: ['absent banner stays hidden'],
    },
  ]);
}
