import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.env.QCV_LIVE === '1';

test('SauceDemo locator check matches the active manifest', { skip: !live, timeout: 180000 }, (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-live-'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-live-tmp-'));
  t.after(() => {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const result = spawnSync(process.execPath, ['dist/cli.js', 'example-project/saucedemo', '--only', 'locator', '--out', out], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    timeout: 170000,
  });
  assert.equal(result.status === 0 || result.status === 1, true, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const findings = report.tests.flatMap((entry) => entry.findings.map((finding) => ({ ...finding, file: finding.file })));
  const keys = findings.map((finding) => `${finding.file}:${finding.line}:${finding.ruleId}`).sort();
  for (const expected of [
    'tests/ai-style/locators.spec.ts:10:QCV-L002',
    'tests/ai-style/locators.spec.ts:16:QCV-L003',
    'tests/ai-style/locators.spec.ts:23:QCV-L004',
  ]) {
    assert.equal(keys.includes(expected), true, keys.join('\n'));
  }
  const good = report.tests.filter((entry) => entry.file.startsWith('tests/good/'));
  assert.equal(good.length > 0, true);
  for (const entry of good) {
    assert.equal(entry.verdict, 'trusted', entry.titlePath.join(' > '));
    assert.equal(entry.findings.some((finding) => finding.severity === 'warn' || finding.severity === 'error'), false);
  }
  const l002 = findings.filter((finding) => finding.ruleId === 'QCV-L002');
  assert.equal(l002.length, 1);
  assert.match(l002[0].evidence, /#login-error-banner/);
  assert.equal(
    findings.some((finding) => finding.evidence.includes("getByTestId('error')") || finding.evidence.includes('[data-test="error"]')),
    false,
  );
  const login = report.tests.find((entry) => entry.titlePath.includes('locked out user sees the error'));
  assert.ok(login);
  assert.equal(login.locators.some((locator) => locator.api.includes('error') && locator.status === 'unique'), true);
  assert.equal(report.checksRun.includes('locator'), true);
});
