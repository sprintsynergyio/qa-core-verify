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

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
      if (entry.name === '.qa-core') continue;
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
  assert.match(result.stdout, /--format/);
  assert.match(result.stdout, /--out/);
  assert.match(result.stdout, /--fail-on/);
  assert.match(result.stdout, /--only/);
  assert.match(result.stdout, /--keep-workspace/);
  assert.equal(result.stderr, '');
});

test('exit 1 for the bad fixture and exit 0 for the good fixture', (t) => {
  const out = tempDir(t, 'qa-core-verify-cli-out-');
  const bad = runCli(['--out', out, w001Dir, path.join(w001Dir, 'bad.spec.ts')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /clicks and does not assert/);
  assert.match(bad.stdout, /only logs/);
  assert.match(bad.stdout, /empty test/);
  assert.match(bad.stdout, /QCV-W001/);
  assert.doesNotMatch(bad.stdout, /expect in the body/);
  assert.match(bad.stdout, /Summary: 0 trusted, 0 review, 3 untrusted, 0 baseline-red, 0 not-run\. 3 errors, 0 warnings, 0 info findings\./);
  assert.doesNotMatch(bad.stderr, /No tests found/);

  const good = runCli(['--out', out, w001Dir, path.join(w001Dir, 'good.spec.ts')]);
  assert.equal(good.status, 0);
  assert.doesNotMatch(good.stdout, /QCV-W001/);
  assert.match(good.stdout, /Summary: 3 trusted, 0 review, 0 untrusted, 0 baseline-red, 0 not-run\. 0 errors, 0 warnings, 0 info findings\./);
});

test('the w001 directory reports only the bad file', (t) => {
  const out = tempDir(t, 'qa-core-verify-cli-out-');
  const result = runCli(['--out', out, w001Dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /bad\.spec\.ts/);
  assert.match(result.stderr, /No Playwright config found/);
  assert.match(result.stdout, /trusted[^\n]*good\.spec\.ts[^\n]*expect in the body/);
  assert.match(result.stdout, /trusted[^\n]*good\.spec\.ts[^\n]*expect inside a step/);
  assert.match(result.stdout, /trusted[^\n]*good\.spec\.ts[^\n]*configured helper/);
  assert.doesNotMatch(result.stdout, /untrusted[^\n]*good\.spec\.ts/);
  assert.match(result.stdout, /Summary: 3 trusted, 0 review, 3 untrusted, 0 baseline-red, 0 not-run\. 3 errors, 0 warnings, 0 info findings\./);
});

test('exit 2 for a path that does not exist', () => {
  const result = runCli(['does-not-exist']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does-not-exist/);
  assert.equal(result.stdout, '');
});

test('exit 2 for a spec that does not parse', (t) => {
  const dir = tempDir(t, 'qa-core-verify-cli-');
  fs.writeFileSync(path.join(dir, 'broken.spec.ts'), "import { test } from '@playwright/test';\ntest('broken', () => { const = ; });\n");
  const result = runCli([dir]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Parse error/);
});

test('--json prints only the report object', (t) => {
  const out = tempDir(t, 'qa-core-verify-cli-out-');
  const bad = runCli(['--json', '--out', out, w001Dir, path.join(w001Dir, 'bad.spec.ts')]);
  assert.equal(bad.status, 1);
  const parsed = JSON.parse(bad.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.tests.length, 3);
  assert.equal(parsed.tests.every((entry) => entry.verdict === 'untrusted'), true);
  assert.equal(parsed.tests.flatMap((entry) => entry.findings).every((finding) => finding.ruleId === 'QCV-W001'), true);
  assert.equal(bad.stdout.trimEnd(), JSON.stringify(parsed, null, 2));
  assert.doesNotMatch(bad.stdout, /Discovery/);
  assert.match(bad.stderr, /Discovery:/);

  const good = runCli(['--json', '--out', out, w001Dir, path.join(w001Dir, 'good.spec.ts')]);
  assert.equal(good.status, 0);
  const clean = JSON.parse(good.stdout);
  assert.equal(clean.tests.length, 3);
  assert.equal(clean.tests.every((entry) => entry.verdict === 'trusted' && entry.findings.length === 0), true);
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

test('a bad config file is a tool error', (t) => {
  const dir = tempDir(t, 'qa-core-verify-config-');
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

test('does not modify the project files', (t) => {
  const out = tempDir(t, 'qa-core-verify-cli-out-');
  const before = hashTree(w001Dir);
  const result = runCli(['--out', out, w001Dir]);
  assert.equal(result.status, 1);
  assert.equal(hashTree(w001Dir), before);
  assert.equal(fs.existsSync(path.join(w001Dir, '.qa-core')), false);
});

test('prints No tests found when no spec files match, and keeps exit 0', (t) => {
  const dir = tempDir(t, 'qa-core-verify-empty-');
  const result = runCli([dir]);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /No tests found\. No spec files matched\./);
  assert.match(result.stdout, /Summary: 0 trusted, 0 review, 0 untrusted, 0 baseline-red, 0 not-run\. 0 errors, 0 warnings, 0 info findings\./);
  assert.doesNotMatch(result.stdout, /QCV-W001/);

  const json = runCli(['--json', dir]);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.tests, []);
  assert.equal(parsed.summary.verdict.trusted, 0);
  assert.match(json.stderr, /Discovery:/);
  assert.match(json.stderr, /No tests found\. No spec files matched\./);
});

test('prints No tests found when spec files contain no tests, and keeps exit 0', (t) => {
  const dir = tempDir(t, 'qa-core-verify-annot-');
  fs.writeFileSync(
    path.join(dir, 'slow.spec.ts'),
    "import { test } from '@playwright/test';\ntest.slow(({ browserName }) => browserName === 'webkit');\n",
  );
  const result = runCli([dir]);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /No tests found\./);
  assert.doesNotMatch(result.stderr, /No spec files matched/);
  assert.match(result.stdout, /Summary: 0 trusted, 0 review, 0 untrusted, 0 baseline-red, 0 not-run\. 0 errors, 0 warnings, 0 info findings\./);
  assert.doesNotMatch(result.stdout, /QCV-W001/);
});

test('an extended test with no assertion exits 1', (t) => {
  const out = tempDir(t, 'qa-core-verify-cli-out-');
  const file = path.join(repoRoot, 'tests/fixtures/parser/extend.spec.ts');
  const result = runCli(['--out', out, path.dirname(file), file]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /chained extend without assertion/);
  assert.match(result.stdout, /Summary: 1 trusted, 0 review, 1 untrusted, 0 baseline-red, 0 not-run\. 1 error, 0 warnings, 0 info findings\./);
  assert.doesNotMatch(result.stderr, /No tests found/);
  assert.equal(fs.existsSync(path.join(path.dirname(file), '.qa-core')), false);
});

test('unknown --only and --keep-workspace without it are tool errors', () => {
  const unknown = runCli(['--only', 'trace', w001Dir]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown --only check/);
  assert.equal(fs.existsSync(path.join(w001Dir, '.qa-core')), false);

  const keep = runCli(['--keep-workspace', w001Dir]);
  assert.equal(keep.status, 2);
  assert.match(keep.stderr, /--keep-workspace requires --only locator-evidence, --only locator, --only inversion, or --only faults/);
  assert.equal(fs.existsSync(path.join(w001Dir, '.qa-core')), false);
});

test('--only locator-evidence rejects --json, --format, and --fail-on', () => {
  const cases = [
    ['--only', 'locator-evidence', '--json', w001Dir],
    ['--only', 'locator-evidence', '--format', 'console', w001Dir],
    ['--only', 'locator-evidence', '--fail-on', 'warn', w001Dir],
  ];
  for (const args of cases) {
    const result = runCli(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--only locator-evidence does not support --json, --format, or --fail-on/);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(w001Dir, '.qa-core')), false);
  }
});
