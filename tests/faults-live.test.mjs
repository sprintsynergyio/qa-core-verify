import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = path.join(repoRoot, 'example-project/saucedemo');
const live = process.env.QCV_LIVE === '1';

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
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(dir, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

test('SauceDemo fault injection is skipped unless QCV_LIVE=1', { skip: !live, timeout: 300000 }, (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-fault-live-'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-fault-live-tmp-'));
  t.after(() => {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const before = hashTree(projectDir);
  const result = spawnSync(process.execPath, ['dist/cli.js', projectDir, '--only', 'faults', '--out', out], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    timeout: 280000,
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.equal(hashTree(projectDir), before);
  assert.equal(fs.readdirSync(scratch).length, 0, fs.readdirSync(scratch).join(', '));
  assert.match(result.stderr, /Baseline: 18 passed, 0 failed, 1 skipped/);
  assert.equal(result.stderr.includes('broke no test'), false, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const good = report.tests.filter((entry) => entry.file.startsWith('tests/good/'));
  assert.equal(good.length, 4);
  for (const entry of good) {
    const blank = entry.faults.find((cell) => cell.id === 'blank-app');
    assert.equal(blank.result, 'fail', entry.titlePath.join(' > '));
    const nonBlank = entry.faults.filter((cell) => cell.id !== 'blank-app');
    const allNonBlankPass = nonBlank.length > 0 && nonBlank.every((cell) => cell.result === 'pass');
    const title = entry.titlePath.join(' > ');
    if (allNonBlankPass) {
      assert.equal(entry.verdict, 'review', title);
      assert.equal(entry.findings.some((finding) => finding.ruleId === 'QCV-F004'), true, title);
    } else {
      assert.equal(entry.verdict, 'trusted', `${title} ${entry.findings.map((finding) => finding.ruleId).join(',')}`);
      assert.equal(entry.findings.some((finding) => finding.ruleId === 'QCV-F004'), false, title);
    }
  }
  const seeded = report.tests.find((entry) => entry.titlePath.includes('does not read the page'));
  assert.deepEqual(seeded.findings.map((finding) => finding.ruleId).sort(), ['QCV-F002', 'QCV-F003', 'QCV-F004']);
  assert.equal(seeded.verdict, 'untrusted');
  const ids = report.faultRun.faults.map((fault) => fault.id);
  for (const id of ids) {
    const broke = report.tests.some((entry) => entry.file.startsWith('tests/good/') && entry.faults.some((cell) => cell.id === id && cell.result === 'fail'));
    assert.equal(broke, true, id);
  }
  assert.equal(report.summary.verdict['not-run'], 1);
  assert.equal(report.summary.verdict['baseline-red'], 0);
});
