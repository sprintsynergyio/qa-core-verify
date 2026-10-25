import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatConsoleReport } from '../dist/report/console.js';
import { formatHtml } from '../dist/report/html.js';
import { formatMarkdown } from '../dist/report/markdown.js';
import { verdictFor } from '../dist/report/model.js';
import { validateSchema } from './schema-validate.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schema/report.schema.json'), 'utf8'));

const fixedReport = {
  schemaVersion: 1,
  tool: { name: 'qa-core-verify', version: '0.0.1' },
  startedAt: '2026-10-25T00:00:00.000+00:00',
  finishedAt: '2026-10-25T00:00:01.000+00:00',
  project: {
    dir: 'fixture',
    configFile: 'fixture/playwright.config.ts',
    specCount: 1,
    testCount: 2,
  },
  checksRun: ['weak-assertion'],
  summary: {
    severity: { error: 1, warn: 0, info: 0 },
    verdict: { trusted: 1, review: 0, untrusted: 1, 'baseline-red': 0, 'not-run': 0 },
  },
  tests: [
    {
      id: 'fixture/a.spec.ts:3:1:passes',
      file: 'fixture/a.spec.ts',
      line: 3,
      titlePath: ['passes'],
      verdict: 'trusted',
      findings: [],
    },
    {
      id: 'fixture/a.spec.ts:8:1:needs a look',
      file: 'fixture/a.spec.ts',
      line: 8,
      titlePath: ['needs a look'],
      verdict: 'untrusted',
      findings: [
        {
          ruleId: 'QCV-W001',
          check: 'weak-assertion',
          severity: 'error',
          file: 'fixture/a.spec.ts',
          line: 8,
          column: 1,
          message: 'Test has no assertion.',
          evidence: 'No expect call and no configured assertion helper in this test.',
          fixHint: 'Add an expect assertion, or call a helper named in qa-core-verify.config.json.',
          relatedLintRule: 'expect-expect',
        },
      ],
    },
  ],
};

test('verdict mapping follows severity and skip', () => {
  assert.equal(verdictFor('test', [], []), 'trusted');
  assert.equal(verdictFor('test', [], [{ severity: 'info' }]), 'review');
  assert.equal(verdictFor('test', [], [{ severity: 'warn' }]), 'review');
  assert.equal(verdictFor('test', [], [{ severity: 'error' }]), 'untrusted');
  assert.equal(verdictFor('test', [], [{ severity: 'error' }, { severity: 'info' }]), 'untrusted');
  assert.equal(verdictFor('test', ['skip'], [{ severity: 'error' }]), 'not-run');
  assert.equal(verdictFor('test', ['fixme'], []), 'not-run');
  assert.equal(verdictFor('test', ['only'], [{ severity: 'info' }]), 'review');
  assert.equal(verdictFor('describe', ['skip'], [{ severity: 'info' }]), 'not-run');
  assert.equal(verdictFor('test', [], [{ severity: 'error' }]) === 'baseline-red', false);
});

test('console and markdown snapshots stay fixed', () => {
  const consoleText = formatConsoleReport(fixedReport, [
    'fixture/.qa-core/verify/report.json',
    'fixture/.qa-core/verify/report.md',
    'fixture/.qa-core/verify/report.html',
  ]);
  const markdown = formatMarkdown(fixedReport);
  assert.equal(consoleText, fs.readFileSync(path.join(repoRoot, 'tests/fixtures/report/console.txt'), 'utf8'));
  assert.equal(markdown, fs.readFileSync(path.join(repoRoot, 'tests/fixtures/report/markdown.md'), 'utf8'));
  assert.equal(validateSchema(schema, fixedReport).length, 0);
});

test('html escapes a script title and does not reference the network', () => {
  const report = {
    ...fixedReport,
    tests: [
      {
        id: 'fixture/a.spec.ts:1:1:<script>',
        file: 'fixture/a.spec.ts',
        line: 1,
        titlePath: ['<script>alert(1)</script>'],
        verdict: 'untrusted',
        findings: [
          {
            ruleId: 'QCV-W001',
            check: 'weak-assertion',
            severity: 'error',
            file: 'fixture/a.spec.ts',
            line: 1,
            column: 1,
            message: 'Title <script>alert(1)</script>',
            evidence: 'a < b & c',
            fixHint: 'Use "quotes" and \'apostrophes\'.',
          },
        ],
      },
    ],
  };
  const html = formatHtml(report);
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
  assert.equal(html.includes('a &lt; b &amp; c'), true);
  assert.equal(html.includes('&quot;quotes&quot;'), true);
  assert.equal(html.includes('http'), false);
  assert.equal(html.includes('href'), false);
  assert.equal(html.includes('@import'), false);
  assert.equal(html.includes('src='), false);
});

function runCli(args, cwd = repoRoot) {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd, encoding: 'utf8' });
}

function recomputed(report) {
  const severity = { error: 0, warn: 0, info: 0 };
  const verdict = { trusted: 0, review: 0, untrusted: 0, 'baseline-red': 0, 'not-run': 0 };
  for (const entry of report.tests) {
    verdict[entry.verdict] += 1;
    for (const finding of entry.findings) severity[finding.severity] += 1;
  }
  return { severity, verdict };
}

test('the saucedemo run writes three files and the json matches the schema', () => {
  const project = path.join(repoRoot, 'example-project/saucedemo');
  const result = runCli([project]);
  assert.equal(result.status, 1, result.stderr);
  const dir = path.join(project, '.qa-core/verify');
  for (const name of ['report.json', 'report.md', 'report.html']) {
    assert.equal(fs.existsSync(path.join(dir, name)), true, name);
  }
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.deepEqual(validateSchema(schema, report), []);
  assert.deepEqual(report.summary, recomputed(report));
  assert.equal(report.summary.verdict['baseline-red'], 0);
  assert.equal(report.checksRun.includes('weak-assertion'), true);
  assert.equal(report.project.testCount, report.tests.filter((entry) => !entry.findings.some((finding) => finding.message === 'Describe block is skipped.')).length);
  const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
  assert.equal(html.includes('http'), false, html.match(/http.{0,40}/)?.[0]);
  assert.equal(html.includes('href'), false);
  assert.equal(html.includes('@import'), false);

  const json = runCli(['--json', '--format', 'json', project]);
  assert.equal(json.status, 1);
  const fromStdout = JSON.parse(json.stdout);
  assert.deepEqual(validateSchema(schema, fromStdout), []);
  assert.doesNotMatch(json.stdout, /Discovery/);
  assert.match(json.stderr, /Discovery:/);
});

test('--format console does not write report files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-verify-format-'));
  fs.writeFileSync(path.join(dir, 'empty.spec.ts'), "import { test, expect } from '@playwright/test';\ntest('ok', async () => { expect(1).toBe(2); });\n");
  const result = runCli(['--format', 'console', dir]);
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(path.join(dir, '.qa-core')), false);
  assert.match(result.stdout, /Reports: none\./);
  assert.match(result.stdout, /trusted/);
});

test('an unknown format is a tool error', () => {
  const result = runCli(['--format', 'pdf', 'example-project/saucedemo']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown --format/);
});

test('the schema rejects a report with an extra field', () => {
  const broken = { ...fixedReport, extra: true };
  const errors = validateSchema(schema, broken);
  assert.equal(errors.some((error) => error.includes('extra')), true);
});
