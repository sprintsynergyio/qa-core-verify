import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../dist/cli.js';
import { formatConsoleReport } from '../dist/report/console.js';
import { formatHtml } from '../dist/report/html.js';
import { formatMarkdown } from '../dist/report/markdown.js';
import { formatIsoOffset, trustNote, verdictFor } from '../dist/report/model.js';
import { projectDirLabel } from '../dist/report/paths.js';
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
  assert.equal(verdictFor('test', [], [{ severity: 'info' }]), 'trusted');
  assert.equal(verdictFor('test', [], [{ severity: 'warn' }]), 'review');
  assert.equal(verdictFor('test', [], [{ severity: 'warn' }, { severity: 'info' }]), 'review');
  assert.equal(verdictFor('test', [], [{ severity: 'error' }]), 'untrusted');
  assert.equal(verdictFor('test', [], [{ severity: 'error' }, { severity: 'warn' }]), 'untrusted');
  assert.equal(verdictFor('test', ['skip'], [{ severity: 'error' }]), 'not-run');
  assert.equal(verdictFor('test', ['fixme'], []), 'not-run');
  assert.equal(verdictFor('test', ['only'], [{ severity: 'info' }]), 'trusted');
  assert.equal(verdictFor('describe', ['skip'], [{ severity: 'info' }]), 'not-run');
  assert.equal(verdictFor('test', [], [{ severity: 'error' }]) === 'baseline-red', false);
});

test('console and markdown snapshots stay fixed', () => {
  const consoleText = formatConsoleReport(fixedReport, [
    '.qa-core/verify/report.json',
    '.qa-core/verify/report.md',
    '.qa-core/verify/report.html',
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

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
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

test('the saucedemo run writes three files and the json matches the schema', (t) => {
  const project = path.join(repoRoot, 'example-project/saucedemo');
  const hadRuntimeDir = fs.existsSync(path.join(project, '.qa-core'));
  const out = tempDir(t, 'qa-core-verify-sauce-out-');
  const result = runCli(['--out', out, project]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(path.join(project, '.qa-core')), hadRuntimeDir);
  for (const name of ['report.json', 'report.md', 'report.html']) {
    assert.equal(fs.existsSync(path.join(out, name)), true, name);
  }
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(validateSchema(schema, report), []);
  assert.deepEqual(report.summary, recomputed(report));
  assert.equal(report.summary.verdict['baseline-red'], 0);
  assert.equal(report.project.dir, 'saucedemo');
  assert.equal(report.project.configFile, 'playwright.config.ts');
  assert.equal(report.tests.every((entry) => entry.file.startsWith('tests/')), true);
  assert.equal(report.checksRun.includes('weak-assertion'), true);
  assert.equal(report.project.testCount, report.tests.filter((entry) => !entry.findings.some((finding) => finding.message === 'Describe block is skipped.')).length);
  const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
  assert.equal(html.includes('http'), false, html.match(/http.{0,40}/)?.[0]);
  assert.equal(html.includes('href'), false);
  assert.equal(html.includes('@import'), false);

  const json = runCli(['--json', '--format', 'json', '--out', out, project]);
  assert.equal(json.status, 1);
  const fromStdout = JSON.parse(json.stdout);
  assert.deepEqual(validateSchema(schema, fromStdout), []);
  assert.doesNotMatch(json.stdout, /Discovery/);
  assert.match(json.stderr, /Discovery:/);

  const copy = tempDir(t, 'qa-core-verify-sauce-copy-');
  fs.cpSync(project, copy, {
    recursive: true,
    filter: (source) => path.basename(source) !== '.qa-core',
  });
  const copied = runCli([copy]);
  assert.equal(copied.status, 1, copied.stderr);
  const defaultDir = path.join(copy, '.qa-core', 'verify');
  for (const name of ['report.json', 'report.md', 'report.html']) {
    assert.equal(fs.existsSync(path.join(defaultDir, name)), true, name);
  }
  assert.match(copied.stdout, /Reports: \.qa-core\/verify\/report\.json/);
  assert.equal(fs.existsSync(path.join(project, '.qa-core')), hadRuntimeDir);
});

test('--format console does not write report files', (t) => {
  const dir = tempDir(t, 'qa-core-verify-format-');
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

test('describe.only with only an info finding is trusted', (t) => {
  const dir = tempDir(t, 'qa-core-verify-only-');
  fs.writeFileSync(
    path.join(dir, 'only.spec.ts'),
    [
      "import { test, expect } from '@playwright/test';",
      "test.describe.only('b', () => {",
      "  test('t', async ({ page }) => {",
      "    await expect(page).toHaveTitle('x');",
      '  });',
      '});',
      '',
    ].join('\n'),
  );
  const result = runCli(['--json', '--format', 'json', dir]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.tests.length, 1);
  assert.deepEqual(report.tests[0].titlePath, ['b', 't']);
  assert.equal(report.tests[0].verdict, 'trusted');
  assert.equal(report.tests[0].findings.length, 1);
  assert.equal(report.tests[0].findings[0].ruleId, 'QCV-W009');
  assert.equal(report.tests[0].findings[0].severity, 'info');
  assert.equal(report.summary.verdict.trusted, 1);
  assert.equal(report.summary.verdict.review, 0);
});

test('reports name the checks that ran', () => {
  const bothMissing = trustNote(['weak-assertion']);
  assert.equal(
    bothMissing,
    'Trusted means no warn or error findings from the checks that ran. Locator and cannot-fail checks did not run.',
  );
  const markdown = formatMarkdown(fixedReport);
  const html = formatHtml(fixedReport);
  const consoleText = formatConsoleReport(fixedReport, []);
  assert.match(markdown, /## Checks Run\n\n- weak-assertion/);
  assert.equal(markdown.includes(bothMissing), true);
  assert.equal(html.includes('Checks run: weak-assertion.'), true);
  assert.equal(html.includes(bothMissing), true);
  assert.match(html, /<header>[\s\S]*Checks run:[\s\S]*<\/header>/);
  assert.match(consoleText, /Checks run: weak-assertion\./);
  assert.equal(consoleText.includes(bothMissing), true);
  const full = { ...fixedReport, checksRun: ['weak-assertion', 'locator', 'cannot-fail'] };
  assert.equal(trustNote(full.checksRun), undefined);
  assert.equal(formatMarkdown(full).includes('did not run'), false);
  assert.equal(formatHtml(full).includes('did not run'), false);
  assert.equal(formatConsoleReport(full, []).includes('did not run'), false);
  assert.match(formatConsoleReport(full, []), /Checks run: weak-assertion, locator, cannot-fail\./);
  const locatorOnly = { ...fixedReport, checksRun: ['weak-assertion', 'locator'] };
  const cannotFailMissing = 'Trusted means no warn or error findings from the checks that ran. Cannot-fail check did not run.';
  assert.equal(trustNote(locatorOnly.checksRun), cannotFailMissing);
  assert.equal(formatMarkdown(locatorOnly).includes(cannotFailMissing), true);
  assert.equal(formatHtml(locatorOnly).includes(cannotFailMissing), true);
  assert.equal(formatConsoleReport(locatorOnly, []).includes(cannotFailMissing), true);
  assert.equal(
    trustNote(['weak-assertion', 'cannot-fail']),
    'Trusted means no warn or error findings from the checks that ran. Locator check did not run.',
  );
});

test('timestamps use local time and a +05:00 offset', () => {
  const date = new Date(2026, 0, 15, 5, 30, 9, 8);
  const text = formatIsoOffset(date);
  assert.equal(text.slice(0, 23), '2026-01-15T05:30:09.008');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  assert.equal(text.slice(23), `${sign}${hours}:${minutes}`);

  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { formatIsoOffset } from './dist/report/model.js'; process.stdout.write(formatIsoOffset(new Date('2026-01-15T00:00:00.000Z')));",
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Karachi' },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '2026-01-15T05:00:00.000+05:00');
});

test('the project directory label is the base name', () => {
  assert.equal(projectDirLabel('/'), '.');
  assert.equal(projectDirLabel('/tmp/saucedemo/'), 'saucedemo');
});

const probeReport = {
  schemaVersion: 1,
  tool: { name: 'qa-core-verify', version: '0.0.1' },
  startedAt: '2026-01-15T05:00:00.000+05:00',
  finishedAt: '2026-01-15T05:00:01.000+05:00',
  project: {
    dir: 'probes',
    configFile: 'playwright.config.ts',
    specCount: 1,
    testCount: 5,
  },
  checksRun: ['weak-assertion'],
  summary: {
    severity: { error: 1, warn: 0, info: 0 },
    verdict: { trusted: 4, review: 0, untrusted: 1, 'baseline-red': 0, 'not-run': 0 },
  },
  tests: [
    {
      id: 'img',
      file: 'bad/<img>.spec.ts',
      line: 1,
      titlePath: ['<img src=x onerror=alert(4)>'],
      verdict: 'trusted',
      findings: [],
    },
    {
      id: 'lines',
      file: 'dir/file\nname.spec.ts',
      line: 2,
      titlePath: ['line one\nline two'],
      verdict: 'trusted',
      findings: [],
    },
    {
      id: 'marks',
      file: 'pipe.spec.ts',
      line: 3,
      titlePath: ['a | b', '<b>bold</b>'],
      verdict: 'trusted',
      findings: [],
    },
    {
      id: 'link',
      file: 'link.spec.ts',
      line: 4,
      titlePath: ['[link](javascript:...)'],
      verdict: 'untrusted',
      findings: [
        {
          ruleId: 'QCV-W001',
          check: 'weak-assertion',
          severity: 'error',
          file: 'link.spec.ts',
          line: 4,
          column: 1,
          message: 'sees <b> and | and [link](javascript:...)',
          evidence: 'seen ``` and ````` here',
          fixHint: 'fix ```` hint',
        },
      ],
    },
    {
      id: 'controls',
      file: 'esc/\u001bname~.spec.ts',
      line: 5,
      titlePath: ['bell\u0007 and \u001b[31mred\u001b[0m ~tilde'],
      verdict: 'trusted',
      findings: [],
    },
  ],
};

test('markdown escapes titles, paths, and messages', () => {
  const markdown = formatMarkdown(probeReport);
  const consoleText = formatConsoleReport(probeReport, ['.qa-core/verify/report.md']);
  assert.equal(markdown, fs.readFileSync(path.join(repoRoot, 'tests/fixtures/report/markdown-probes.md'), 'utf8'));
  assert.equal(consoleText, fs.readFileSync(path.join(repoRoot, 'tests/fixtures/report/console-probes.txt'), 'utf8'));
  assert.equal(markdown.includes('<img'), false);
  assert.equal(markdown.includes('<b>'), false);
  assert.equal(markdown.includes('[link](javascript:'), false);
  assert.equal(markdown.includes('\nline two'), false);
  assert.match(markdown, /^``````$/m);
  assert.equal(consoleText.includes('\nline two'), false);
  assert.match(consoleText, /line one line two/);
  assert.match(consoleText, /dir\/file name\.spec\.ts/);
  assert.equal(markdown.includes('\u001b'), false);
  assert.equal(markdown.includes('\u0007'), false);
  assert.match(markdown, /\\~tilde/);
  assert.match(markdown, /esc\/name\\~\.spec\.ts/);
  assert.equal(consoleText.includes('\u001b'), false);
  assert.equal(consoleText.includes('\u0007'), false);
  assert.match(consoleText, /esc\/name~\.spec\.ts:5  bell and \[31mred\[0m ~tilde/);
  const html = formatHtml(probeReport);
  assert.equal(html.includes('\u001b'), false);
  assert.equal(html.includes('\u0007'), false);
  assert.match(html, /bell and \[31mred\[0m ~tilde/);
});

test('report paths stay relative to the project from any working directory', (t) => {
  const project = tempDir(t, 'qa-core-verify-paths-');
  fs.mkdirSync(path.join(project, 'nested'));
  fs.writeFileSync(
    path.join(project, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: '.' });\n",
  );
  fs.writeFileSync(
    path.join(project, 'a.spec.ts'),
    "import { test, expect } from '@playwright/test';\ntest('kept', async ({ page }) => { await expect(page).toHaveTitle('x'); });\n",
  );
  const out = tempDir(t, 'qa-core-verify-path-out-');
  const started = new Date(2026, 0, 15, 1, 2, 3, 4);
  const finished = new Date(2026, 0, 15, 1, 2, 8, 9);
  const clock = () => {
    const times = [started, finished];
    let index = 0;
    return () => {
      const value = times[Math.min(index, times.length - 1)];
      index += 1;
      return value;
    };
  };
  const args = (projectArg) => ['--format', 'console,json,md,html', '--out', out, projectArg];
  const inside = captureRun(args('.'), project, clock());
  const insideFiles = readReports(out);
  const nested = captureRun(args('..'), path.join(project, 'nested'), clock());
  const nestedFiles = readReports(out);
  const outsideDir = tempDir(t, 'qa-core-verify-outside-');
  const outside = captureRun(args(project), outsideDir, clock());
  const outsideFiles = readReports(out);

  assert.equal(inside.status, 0, inside.err);
  assert.equal(nested.status, 0, nested.err);
  assert.equal(outside.status, 0, outside.err);
  assert.equal(nested.out, inside.out);
  assert.equal(outside.out, inside.out);
  assert.equal(nested.err, inside.err);
  assert.equal(outside.err, inside.err);
  assert.deepEqual(nestedFiles, insideFiles);
  assert.deepEqual(outsideFiles, insideFiles);

  const report = JSON.parse(insideFiles.json);
  assert.equal(report.project.dir, path.basename(project));
  assert.notEqual(report.project.dir, '');
  assert.equal(report.project.dir.startsWith('/'), false);
  assert.equal(report.project.configFile, 'playwright.config.ts');
  assert.equal(report.tests[0].file, 'a.spec.ts');
  assert.equal(report.startedAt, formatIsoOffset(started));
  assert.equal(report.finishedAt, formatIsoOffset(finished));
  for (const [label, text] of [
    ['console', inside.out],
    ['json', insideFiles.json],
    ['markdown', insideFiles.md],
    ['html', insideFiles.html],
  ]) {
    assertNoAbsolutePath(text, label);
    assert.equal(text.includes(project), false, label);
  }
});

function captureRun(argv, cwd, now) {
  let out = '';
  let err = '';
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  process.stderr.write = (chunk) => {
    err += chunk;
    return true;
  };
  try {
    const status = run(argv, cwd, now);
    return { status, out, err };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

function readReports(dir) {
  return {
    json: fs.readFileSync(path.join(dir, 'report.json'), 'utf8'),
    md: fs.readFileSync(path.join(dir, 'report.md'), 'utf8'),
    html: fs.readFileSync(path.join(dir, 'report.html'), 'utf8'),
  };
}

function assertNoAbsolutePath(text, label) {
  for (const token of text.split(/[\s"'`,<>]+/)) {
    const absolute = token.startsWith('/') && token.slice(1).includes('/');
    assert.equal(absolute, false, `${label}: ${token}`);
    assert.equal(/^[A-Za-z]:[\\/]/.test(token), false, `${label}: ${token}`);
  }
}
