import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadVerifyConfig } from '../dist/config.js';
import { discoverSpecs } from '../dist/inventory/discover.js';
import { parseSpecFile } from '../dist/inventory/parse.js';
import { findTestsWithNoAssertion } from '../dist/rules/w001-no-assertion.js';

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

// A SEEDED comment sits on the line above the problem.
// The manifest line is that problem line. QCV-W001 reports the same line.
function seededComments(files) {
  const found = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^\s*\/\/ SEEDED:\s+(\S+)\s+(\S.*)$/.exec(lines[index] ?? '');
      if (!match) continue;
      const next = lines[index + 1];
      const where = `${relativeToProject(file)}:${index + 1}`;
      assert.equal(typeof next, 'string', `${where} is the last line`);
      assert.equal(next.trim() === '' || next.trim().startsWith('//'), false, `${where} must sit on the line above the problem`);
      found.push({
        file: relativeToProject(file),
        line: index + 2,
        ruleId: match[1],
      });
    }
  }
  return found;
}

function runPipeline() {
  const discovery = discoverSpecs(projectDir, []);
  const config = loadVerifyConfig(projectDir);
  const tests = [];
  for (const file of discovery.files) {
    tests.push(...parseSpecFile(file, config).tests);
  }
  return { discovery, tests, findings: findTestsWithNoAssertion(tests) };
}

function findingKey(file, line, ruleId) {
  return `${file}:${line}:${ruleId}`;
}

function hashTree(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'test-results' || entry.name === 'playwright-report') continue;
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
  assert.equal(findings.every((finding) => finding.ruleId === 'QCV-W001' && finding.severity === 'error'), true);
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

test('only QCV-W001 entries are active, and the skipped test records why it does not pass', () => {
  const manifest = readManifest();
  const activeRules = [...new Set(manifest.filter((entry) => entry.status === 'active').map((entry) => entry.ruleId))];
  assert.deepEqual(activeRules, ['QCV-W001']);
  const covered = new Set(manifest.map((entry) => entry.ruleId));
  for (const ruleId of SEEDED_RULES) assert.equal(covered.has(ruleId), true, ruleId);
  const withReason = manifest.filter((entry) => entry.reason !== undefined);
  assert.equal(withReason.length, 1);
  assert.equal(withReason[0].ruleId, 'QCV-W009');
  assert.equal(withReason[0].status, 'pending');
  assert.match(withReason[0].reason, /skips this test/);
});

test('the demo config is read and the cli agrees with the static pipeline', () => {
  const { discovery, tests, findings } = runPipeline();
  assert.match(discovery.method, /Playwright config playwright\.config\.ts/);
  assert.match(discovery.method, /testDir '\.\/tests'/);
  const before = hashTree(projectDir);
  const result = spawnSync(process.execPath, ['dist/cli.js', 'example-project/saucedemo'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(hashTree(projectDir), before);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /opens the login page and stops/);
  assert.match(result.stdout, /waits and then ends/);
  assert.doesNotMatch(result.stdout, /login lands on the inventory page/);
  assert.doesNotMatch(result.stdout, /add to cart updates the cart badge/);
  assert.doesNotMatch(result.stdout, /locked out user sees the error/);
  assert.doesNotMatch(result.stdout, /checkout overview shows the backpack item total/);
  assert.match(
    result.stdout,
    new RegExp(
      `Summary: ${findings.length} errors, 0 warnings, 0 info findings\\. ${tests.length} tests scanned\\.`,
    ),
  );
  assert.doesNotMatch(result.stderr, /No tests found/);
});
