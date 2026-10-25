import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadVerifyConfig } from '../dist/config.js';
import { discoverSpecs } from '../dist/inventory/discover.js';
import { parseSpecFile } from '../dist/inventory/parse.js';
import { collectFindings } from '../dist/rules/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = path.join(repoRoot, 'example-project/saucedemo');

const SEEDED_RULES = [
  'QCV-W001',
  'QCV-W002',
  'QCV-W003',
  'QCV-W004',
  'QCV-W005',
  'QCV-W006',
  'QCV-W007',
  'QCV-W008',
  'QCV-W009',
  'QCV-W010',
  'QCV-L002',
  'QCV-L003',
  'QCV-L004',
  'QCV-F001',
  'QCV-F002',
];

function relativeToProject(file) {
  return path.relative(projectDir, file).split(path.sep).join('/');
}

function readManifest() {
  const parsed = JSON.parse(fs.readFileSync(path.join(projectDir, 'expected-findings.json'), 'utf8'));
  assert.ok(Array.isArray(parsed));
  return parsed;
}

function assertManifestShape(entry) {
  assert.equal(typeof entry, 'object');
  assert.ok(entry);
  const keys = Object.keys(entry).sort();
  const expectedKeys = entry.reason === undefined
    ? ['file', 'line', 'ruleId', 'status']
    : ['file', 'line', 'reason', 'ruleId', 'status'];
  assert.deepEqual(keys, expectedKeys);
  assert.equal(typeof entry.file, 'string');
  assert.equal(entry.file.startsWith('tests/ai-style/'), true);
  assert.equal(Number.isInteger(entry.line) && entry.line > 0, true);
  assert.match(entry.ruleId, /^QCV-[WLF]\d{3}$/);
  assert.equal(entry.status === 'active' || entry.status === 'pending', true);
  if (entry.reason !== undefined) {
    assert.equal(typeof entry.reason, 'string');
    assert.equal(entry.reason.length > 0, true);
  }
}

// SEEDED comments sit in a block on the lines above the problem.
// Two rules on one line use two comments. The manifest line is that problem line.
function seededComments(files) {
  const found = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\n/);
    let index = 0;
    while (index < lines.length) {
      if (!/^\s*\/\/ SEEDED:\s+(\S+)\s+(\S.*)$/.test(lines[index] ?? '')) {
        index += 1;
        continue;
      }
      const stack = [];
      while (index < lines.length) {
        const stacked = /^\s*\/\/ SEEDED:\s+(\S+)\s+(\S.*)$/.exec(lines[index] ?? '');
        if (!stacked) break;
        stack.push(stacked[1]);
        index += 1;
      }
      const next = lines[index];
      const where = `${relativeToProject(file)}:${index + 1}`;
      assert.equal(typeof next, 'string', `${where} is the last line`);
      assert.equal(next.trim() === '' || next.trim().startsWith('//'), false, `${where} must be the seeded line`);
      for (const ruleId of stack) {
        found.push({
          file: relativeToProject(file),
          line: index + 1,
          ruleId,
        });
      }
    }
  }
  return found;
}

function runPipeline() {
  const discovery = discoverSpecs(projectDir, []);
  const config = loadVerifyConfig(projectDir);
  const tests = [];
  const skippedDescribes = [];
  for (const file of discovery.files) {
    const inventory = parseSpecFile(file, config);
    tests.push(...inventory.tests);
    skippedDescribes.push(...inventory.skippedDescribes);
  }
  return { discovery, tests, skippedDescribes, findings: collectFindings(tests, skippedDescribes) };
}

function findingKey(file, line, ruleId) {
  return `${file}:${line}:${ruleId}`;
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function hashTree(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test-results' || entry.name === 'playwright-report' || entry.name === '.qa-core') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(dir, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

test('reports every active expected finding and no findings under tests/good', () => {
  const manifest = readManifest();
  for (const entry of manifest) assertManifestShape(entry);
  const { findings } = runPipeline();
  const reported = findings.map((finding) =>
    findingKey(relativeToProject(finding.file), finding.line, finding.ruleId),
  );
  const active = manifest
    .filter((entry) => entry.status === 'active')
    .map((entry) => findingKey(entry.file, entry.line, entry.ruleId));
  assert.deepEqual(reported.sort(), active.sort());
  assert.equal(
    findings.some((finding) => relativeToProject(finding.file).startsWith('tests/good/')),
    false,
  );
  const severityByRule = {
    'QCV-W000': 'info',
    'QCV-W001': 'error',
    'QCV-W002': 'error',
    'QCV-W003': 'error',
    'QCV-W004': 'error',
    'QCV-W005': 'warn',
    'QCV-W006': 'warn',
    'QCV-W007': 'warn',
    'QCV-W008': 'error',
    'QCV-W009': 'info',
    'QCV-W010': 'info',
  };
  for (const finding of findings) {
    assert.equal(finding.severity, severityByRule[finding.ruleId], `${finding.ruleId} ${finding.file}:${finding.line}`);
    if (finding.ruleId === 'QCV-W003') assert.equal(finding.message, 'Async assertion is not awaited.');
  }
});

test('seeded comments and the manifest list the same file, line, and rule', () => {
  const manifest = readManifest();
  const { discovery } = runPipeline();
  const seeded = seededComments(discovery.files);
  const manifestKeys = manifest.map((entry) => findingKey(entry.file, entry.line, entry.ruleId)).sort();
  const seededKeys = seeded.map((entry) => findingKey(entry.file, entry.line, entry.ruleId)).sort();
  assert.deepEqual(seededKeys, manifestKeys);
  assert.equal(new Set(seededKeys).size, seededKeys.length);
});

test('QCV-W001 through QCV-W010 are active, and the skipped test records why it does not pass', () => {
  const manifest = readManifest();
  const activeRules = [...new Set(manifest.filter((entry) => entry.status === 'active').map((entry) => entry.ruleId))].sort();
  assert.deepEqual(activeRules, [
    'QCV-W001',
    'QCV-W002',
    'QCV-W003',
    'QCV-W004',
    'QCV-W005',
    'QCV-W006',
    'QCV-W007',
    'QCV-W008',
    'QCV-W009',
    'QCV-W010',
  ]);
  const pendingRules = [...new Set(manifest.filter((entry) => entry.status === 'pending').map((entry) => entry.ruleId))].sort();
  assert.deepEqual(pendingRules, ['QCV-F001', 'QCV-F002', 'QCV-L002', 'QCV-L003', 'QCV-L004']);
  const covered = new Set(manifest.map((entry) => entry.ruleId));
  for (const ruleId of SEEDED_RULES) assert.equal(covered.has(ruleId), true, ruleId);
  const withReason = manifest.filter((entry) => entry.reason !== undefined);
  assert.equal(withReason.length, 1);
  assert.equal(withReason[0].ruleId, 'QCV-W009');
  assert.equal(withReason[0].status, 'active');
  assert.match(withReason[0].reason, /skips this test/);
});

test('the demo config is read and the cli agrees with the static pipeline', (t) => {
  const { discovery, tests, skippedDescribes, findings } = runPipeline();
  assert.match(discovery.method, /Playwright config playwright\.config\.ts/);
  assert.match(discovery.method, /testDir '\.\/tests'/);
  const before = hashTree(projectDir);
  const hadRuntimeDir = fs.existsSync(path.join(projectDir, '.qa-core'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-verify-golden-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['dist/cli.js', 'example-project/saucedemo', '--out', out], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(hashTree(projectDir), before);
  assert.equal(fs.existsSync(path.join(projectDir, '.qa-core')), hadRuntimeDir);
  assert.equal(fs.existsSync(path.join(out, 'report.json')), true);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /opens the login page and stops/);
  assert.match(result.stdout, /waits and then ends/);
  assert.match(result.stdout, /trusted[^\n]*login lands on the inventory page/);
  assert.match(result.stdout, /trusted[^\n]*add to cart updates the cart badge/);
  assert.match(result.stdout, /trusted[^\n]*locked out user sees the error/);
  assert.match(result.stdout, /trusted[^\n]*checkout overview shows the backpack item total/);
  assert.doesNotMatch(result.stdout, /untrusted[^\n]*login lands on the inventory page/);
  assert.doesNotMatch(result.stdout, /untrusted[^\n]*add to cart updates the cart badge/);
  assert.doesNotMatch(result.stdout, /untrusted[^\n]*locked out user sees the error/);
  assert.doesNotMatch(result.stdout, /untrusted[^\n]*checkout overview shows the backpack item total/);
  assert.equal(result.stdout.includes(projectDir), false);
  const typedOut = out.split(path.sep).join('/');
  const escapedOut = typedOut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    result.stdout,
    new RegExp(`Reports: ${escapedOut}/report.json, ${escapedOut}/report.md, ${escapedOut}/report.html`),
  );
  const counts = { error: 0, warn: 0, info: 0 };
  const verdicts = { trusted: 0, review: 0, untrusted: 0, 'baseline-red': 0, 'not-run': 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  for (const entry of tests) {
    const owned = findings.filter((finding) => finding.testTitle === entry.titlePath.join(' > ') && finding.file === entry.file);
    if (entry.modifiers.includes('skip') || entry.modifiers.includes('fixme')) verdicts['not-run'] += 1;
    else if (owned.some((finding) => finding.severity === 'error')) verdicts.untrusted += 1;
    else if (owned.some((finding) => finding.severity === 'warn')) verdicts.review += 1;
    else verdicts.trusted += 1;
  }
  verdicts['not-run'] += skippedDescribes.length;
  const summary = [
    'Summary:',
    `${verdicts.trusted} trusted,`,
    `${verdicts.review} review,`,
    `${verdicts.untrusted} untrusted,`,
    `${verdicts['baseline-red']} baseline-red,`,
    `${verdicts['not-run']} not-run.`,
    countLabel(counts.error, 'error', 'errors') + ',',
    countLabel(counts.warn, 'warning', 'warnings') + ',',
    countLabel(counts.info, 'info finding', 'info findings') + '.',
  ].join(' ');
  assert.ok(result.stdout.includes(summary), result.stdout);
  assert.match(result.stdout, /Checks run: weak-assertion\./);
  assert.doesNotMatch(result.stderr, /No tests found/);
});
