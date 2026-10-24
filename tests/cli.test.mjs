import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exitCodeFor } from '../dist/exit-code.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const w001Dir = path.join(repoRoot, 'tests/fixtures/w001');

function runCli(args, cwd = repoRoot) {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function hashTree(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
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

test('--help exits 0 and prints usage', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /qa-core-verify <project-dir>/);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /--fail-on/);
  assert.equal(result.stderr, '');
});

test('exit 1 for the bad fixture and exit 0 for the good fixture', () => {
  const bad = runCli([w001Dir, path.join(w001Dir, 'bad.spec.ts')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /clicks and does not assert/);
  assert.match(bad.stdout, /only logs/);
  assert.match(bad.stdout, /empty test/);
  assert.match(bad.stdout, /QCV-W001/);
  assert.doesNotMatch(bad.stdout, /expect in the body/);
  assert.match(bad.stdout, /Summary: 3 errors, 0 warnings, 0 info findings\. 3 tests scanned\./);

  const good = runCli([w001Dir, path.join(w001Dir, 'good.spec.ts')]);
  assert.equal(good.status, 0);
  assert.doesNotMatch(good.stdout, /QCV-W001/);
  assert.match(good.stdout, /Summary: 0 errors, 0 warnings, 0 info findings\. 3 tests scanned\./);
});

test('the w001 directory reports only the bad file', () => {
  const result = runCli([w001Dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /bad\.spec\.ts/);
  assert.match(result.stdout, /No Playwright config found/);
  assert.doesNotMatch(result.stdout, /expect in the body/);
  assert.doesNotMatch(result.stdout, /expect inside a step/);
  assert.doesNotMatch(result.stdout, /configured helper/);
  assert.match(result.stdout, /6 tests scanned/);
});

test('exit 2 for a path that does not exist', () => {
  const result = runCli(['does-not-exist']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does-not-exist/);
  assert.equal(result.stdout, '');
});

test('exit 2 for a spec that does not parse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-verify-cli-'));
  fs.writeFileSync(path.join(dir, 'broken.spec.ts'), "import { test } from '@playwright/test';\ntest('broken', () => { const = ; });\n");
  const result = runCli([dir]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Parse error/);
});

test('--json prints only the findings array', () => {
  const bad = runCli(['--json', w001Dir, path.join(w001Dir, 'bad.spec.ts')]);
  assert.equal(bad.status, 1);
  const parsed = JSON.parse(bad.stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 3);
  assert.equal(parsed.every((finding) => finding.ruleId === 'QCV-W001'), true);
  assert.doesNotMatch(bad.stdout, /Discovery|Summary/);
  assert.match(bad.stderr, /Discovery:/);

  const good = runCli(['--json', w001Dir, path.join(w001Dir, 'good.spec.ts')]);
  assert.equal(good.status, 0);
  assert.deepEqual(JSON.parse(good.stdout), []);
});

test('rejects an unknown --fail-on level', () => {
  const result = runCli(['--fail-on', 'nope', w001Dir]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown --fail-on level/);
});

test('exit code follows the fail-on threshold', () => {
  const errorFinding = { severity: 'error' };
  const warnFinding = { severity: 'warn' };
  const infoFinding = { severity: 'info' };
  assert.equal(exitCodeFor([errorFinding], 'error'), 1);
  assert.equal(exitCodeFor([warnFinding], 'error'), 0);
  assert.equal(exitCodeFor([warnFinding], 'warn'), 1);
  assert.equal(exitCodeFor([infoFinding], 'warn'), 0);
  assert.equal(exitCodeFor([infoFinding], 'info'), 1);
  assert.equal(exitCodeFor([], 'info'), 0);
});

test('a bad config file is a tool error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-verify-config-'));
  fs.writeFileSync(path.join(dir, 'qa-core-verify.config.json'), '{');
  fs.writeFileSync(path.join(dir, 'empty.spec.ts'), "import { test } from '@playwright/test';\ntest('empty', async () => {});\n");
  const invalid = runCli([dir]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Cannot parse/);

  fs.writeFileSync(path.join(dir, 'qa-core-verify.config.json'), '{"assertFunctionPatterns":["("]}\n');
  const badPattern = runCli([dir]);
  assert.equal(badPattern.status, 2);
  assert.match(badPattern.stderr, /Invalid assertFunctionPatterns/);
});

test('does not modify the project files', () => {
  const before = hashTree(w001Dir);
  const result = runCli([w001Dir]);
  assert.equal(result.status, 1);
  assert.equal(hashTree(w001Dir), before);
});
