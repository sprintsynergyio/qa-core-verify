import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadVerifyConfig } from '../dist/config.js';
import { parseSpecFile } from '../dist/inventory/parse.js';
import { buildReport } from '../dist/report/model.js';
import { formatConsoleReport } from '../dist/report/console.js';
import { formatHtml } from '../dist/report/html.js';
import { reportJson } from '../dist/report/json.js';
import { formatMarkdown } from '../dist/report/markdown.js';
import { parseBaseline } from '../dist/runtime/baseline.js';
import { buildEvidence } from '../dist/runtime/locator-evidence/evidence.js';
import { evaluateLocatorCheck } from '../dist/runtime/locator-check.js';
import { L001_RULE_ID, findNeverMatched } from '../dist/rules/l001-never-matched.js';
import { L002_MESSAGE, L002_RULE_ID, findAbsenceOnUnseen } from '../dist/rules/l002-absence-on-unseen.js';
import { L003_RULE_ID, findAmbiguous } from '../dist/rules/l003-ambiguous.js';
import { L004_RULE_ID, brittleReasons, findBrittleStyle } from '../dist/rules/l004-brittle-style.js';
import { groupRecords, statusOf } from '../dist/rules/locator-status.js';
import { ownerIdFor } from '../dist/rules/types.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = path.join(repoRoot, 'example-project/saucedemo');
const clock = new Date('2026-10-25T12:00:00Z');

function use(overrides) {
  return {
    selector: '#banner',
    api: "locator('#banner')",
    url: 'https://www.saucedemo.com/',
    matchCount: 0,
    phase: 'assertion',
    call: 'toBeVisible',
    negated: false,
    actionSucceeded: false,
    resolvedOnAction: false,
    parentCount: null,
    countExpected: null,
    file: 'tests/a.spec.ts',
    line: 4,
    column: 3,
    testFile: 'tests/a.spec.ts',
    testLine: 2,
    testTitle: 'banner',
    ...overrides,
  };
}

function inventory(title, file = 'tests/a.spec.ts', extra = {}) {
  return {
    title,
    titlePath: [title],
    file: path.join(projectDir, file),
    line: 2,
    column: 1,
    modifiers: [],
    modifierSites: [],
    expects: [],
    locators: [],
    helpers: [],
    events: [],
    unresolved: [],
    floatingCalls: [],
    ...extra,
  };
}

function ids(findings) {
  return findings.map((finding) => finding.ruleId);
}

function evidenceFile(records) {
  return {
    schemaVersion: 1,
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    project: { dir: 'example' },
    playwrightExitCode: 0,
    records,
  };
}

function ranBaseline() {
  return { ok: true, exitCode: 0, passed: 1, failed: 0, skipped: 0, failedKeys: new Set(), stdout: '', stderr: '' };
}

function reportFor(tests, result) {
  return buildReport({
    projectDir,
    specCount: tests.length,
    tests,
    skippedDescribes: [],
    findings: result.findings,
    checksRun: ['locator'],
    startedAt: clock,
    finishedAt: clock,
    baselineRed: result.baselineRed,
    notRun: result.notRun,
    locatorSummaries: result.summaries,
  });
}

test('QCV-L001 flags an action or positive assertion that never matched', () => {
  const tests = [inventory('banner')];
  const missed = findNeverMatched(tests, groupRecords([use({ phase: 'action', call: 'click', actionSucceeded: false })]), projectDir);
  assert.deepEqual(ids(missed), [L001_RULE_ID]);
  assert.equal(missed[0].severity, 'error');
  assert.equal(missed[0].check, 'locator');
  assert.match(missed[0].fixHint, /qa-core-heal/);

  const positive = findNeverMatched(tests, groupRecords([use({ call: 'toBeVisible' })]), projectDir);
  assert.deepEqual(ids(positive), [L001_RULE_ID]);

  const resolved = findNeverMatched(
    tests,
    groupRecords([use({ phase: 'action', call: 'click', actionSucceeded: true, resolvedOnAction: true, matchCount: 0 })]),
    projectDir,
  );
  assert.deepEqual(resolved, []);

  const seen = findNeverMatched(tests, groupRecords([use({ matchCount: 1 })]), projectDir);
  assert.deepEqual(seen, []);

  const absenceOnly = findNeverMatched(tests, groupRecords([use({ call: 'toBeHidden' })]), projectDir);
  assert.deepEqual(absenceOnly, []);
});

test('QCV-L002 uses the absence message and stays quiet when the element was seen', () => {
  const tests = [inventory('banner')];
  const hidden = findAbsenceOnUnseen(tests, groupRecords([use({ call: 'toBeHidden' })]), projectDir);
  assert.deepEqual(ids(hidden), [L002_RULE_ID]);
  assert.equal(hidden[0].severity, 'warn');
  assert.equal(hidden[0].message, L002_MESSAGE);
  assert.equal(
    hidden[0].message,
    'This test stays green even if this element does not exist. Check the locator against a state where the element is shown.',
  );

  const negated = findAbsenceOnUnseen(
    tests,
    groupRecords([
      use({ call: 'toBeVisible', negated: true }),
      use({ call: 'toBeAttached', negated: true, line: 5 }),
      use({ call: 'toHaveCount', countExpected: 0, line: 6 }),
    ]),
    projectDir,
  );
  assert.deepEqual(ids(negated), [L002_RULE_ID]);

  const present = findAbsenceOnUnseen(tests, groupRecords([use({ call: 'toBeHidden', matchCount: 1 })]), projectDir);
  assert.deepEqual(present, []);

  const mixed = findAbsenceOnUnseen(
    tests,
    groupRecords([use({ call: 'toBeHidden' }), use({ call: 'toBeVisible', line: 8 })]),
    projectDir,
  );
  assert.deepEqual(mixed, []);

  const counted = findAbsenceOnUnseen(
    tests,
    groupRecords([use({ call: 'toHaveCount', countExpected: 1, matchCount: 0 })]),
    projectDir,
  );
  assert.deepEqual(counted, []);

  const optionForms = [
    use({ call: 'toBeVisible', optionAbsence: true }),
    use({ call: 'toBeAttached', optionAbsence: true, line: 9 }),
    use({ call: 'toHaveCount', countExpected: 0, line: 13 }),
  ];
  for (const sample of optionForms) {
    assert.deepEqual(ids(findNeverMatched(tests, groupRecords([sample]), projectDir)), [], sample.call);
    const absence = findAbsenceOnUnseen(tests, groupRecords([sample]), projectDir);
    assert.deepEqual(ids(absence), [L002_RULE_ID], sample.call);
  }
  for (const call of ['toBeEnabled', 'toBeChecked', 'toBeEditable']) {
    const sample = use({ call, optionAbsence: true, matchCount: 0, line: 10 });
    assert.deepEqual(ids(findAbsenceOnUnseen(tests, groupRecords([sample]), projectDir)), [], call);
  }
});

test('QCV-L003 warns on an unaccounted multi-match and on first, last, and nth', () => {
  const tests = [inventory('banner')];
  const many = findAmbiguous(tests, groupRecords([use({ matchCount: 3, call: 'click', phase: 'action' })]), projectDir);
  assert.deepEqual(ids(many), [L003_RULE_ID]);
  assert.equal(many[0].severity, 'warn');
  assert.match(many[0].evidence, /Match count 3/);

  const named = findAmbiguous(
    tests,
    groupRecords([use({ call: 'toHaveCount', countExpected: 6, matchCount: 6 })]),
    projectDir,
  );
  assert.deepEqual(named, []);
  assert.equal(statusOf([use({ call: 'toHaveCount', countExpected: 6, matchCount: 6 })]), 'unique');

  const wrongCount = findAmbiguous(
    tests,
    groupRecords([use({ call: 'toHaveCount', countExpected: 2, matchCount: 4 })]),
    projectDir,
  );
  assert.deepEqual(ids(wrongCount), [L003_RULE_ID]);

  const narrowed = findAmbiguous(
    tests,
    groupRecords([use({ call: 'toBeVisible', matchCount: 1, parentCount: 8 })]),
    projectDir,
  );
  assert.deepEqual(ids(narrowed), [L003_RULE_ID]);
  assert.match(narrowed[0].evidence, /Parent match count 8/);
  assert.equal(statusOf([use({ matchCount: 1, parentCount: 8 })]), 'ambiguous');
  assert.equal(statusOf([use({ matchCount: 0 })]), 'never-matched');
  assert.equal(statusOf([use({ matchCount: 1 })]), 'unique');
});

test('QCV-L004 flags long css, xpath, nth-child, and styling classes', () => {
  assert.deepEqual(brittleReasons('div > span > a'), []);
  assert.deepEqual(brittleReasons('#login-error-banner'), []);
  assert.ok(brittleReasons('div > span > a > b').some((reason) => reason.startsWith('CSS chain')));
  assert.ok(brittleReasons('a b c d').some((reason) => reason.includes('3 combinators')));
  assert.deepEqual(brittleReasons('//div[@id="x"]'), ['XPath']);
  assert.ok(brittleReasons('xpath=//button').includes('XPath'));
  assert.ok(brittleReasons('div:nth-child(2)').includes('nth-child'));
  assert.ok(brittleReasons('div.login_container').some((reason) => reason.includes('.login_container')));

  const config = loadVerifyConfig(projectDir);
  const locators = parseSpecFile(path.join(projectDir, 'tests/ai-style/locators.spec.ts'), config);
  const good = parseSpecFile(path.join(projectDir, 'tests/good/shopping.spec.ts'), config);
  const findings = findBrittleStyle([...locators.tests, ...good.tests]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, L004_RULE_ID);
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].line, 23);
  assert.match(findings[0].evidence, /CSS chain/);
  assert.match(findings[0].fixHint, /https:\/\/playwright\.dev\/docs\/locators/);
  assert.equal(
    findings.some((finding) => finding.file.endsWith('tests/good/shopping.spec.ts')),
    false,
  );
});

test('spec.file relative to testDir maps onto the project and is not trusted', () => {
  const workspace = '/tmp/qcv-run-example/project';
  const stdout = JSON.stringify({
    config: {
      rootDir: `${workspace}/tests`,
      projects: [
        { name: 'a', testDir: `${workspace}/tests` },
        { name: 'b', testDir: `${workspace}/other` },
      ],
    },
    suites: [
      {
        specs: [
          {
            file: 'b.spec.ts',
            line: 6,
            tests: [{ status: 'unexpected', results: [{ status: 'failed' }] }],
          },
        ],
      },
      {
        specs: [
          {
            file: '../other/c.spec.ts',
            line: 4,
            tests: [{ status: 'unexpected', results: [{ status: 'timedOut' }] }],
          },
        ],
      },
      {
        specs: [
          {
            file: 'ok.spec.ts',
            line: 2,
            tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
          },
        ],
      },
    ],
  });
  const baseline = parseBaseline(stdout, '', 1, workspace);
  assert.equal(baseline.ok, true);
  assert.equal(baseline.passed, 1);
  assert.equal(baseline.failed, 2);
  assert.equal(baseline.failedKeys.has('tests/b.spec.ts:6:0'), true);
  assert.equal(baseline.failedKeys.has('other/c.spec.ts:4:0'), true);
  assert.equal(baseline.failedKeys.has('b.spec.ts:6'), false);
  const tests = [
    inventory('clicks nothing', 'tests/b.spec.ts', { line: 6 }),
    inventory('clicks nothing too', 'other/c.spec.ts', { line: 4 }),
    inventory('hidden', 'tests/ok.spec.ts', { line: 2 }),
  ];
  const evidence = {
    schemaVersion: 1,
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    project: { dir: 'example' },
    playwrightExitCode: 1,
    records: [use({ testFile: 'tests/b.spec.ts', testLine: 6, testTitle: 'clicks nothing', file: 'tests/b.spec.ts', line: 8 })],
  };
  const result = evaluateLocatorCheck(projectDir, tests, evidence, baseline);
  assert.equal(result.baselineRed.size, 2);
  assert.equal(result.findings.some((finding) => finding.file.endsWith('tests/b.spec.ts')), false);
  const report = buildReport({
    projectDir,
    specCount: 3,
    tests,
    skippedDescribes: [],
    findings: result.findings,
    checksRun: ['locator'],
    startedAt: clock,
    finishedAt: clock,
    baselineRed: result.baselineRed,
    locatorSummaries: result.summaries,
  });
  const red = report.tests.filter((entry) => entry.file === 'tests/b.spec.ts' || entry.file === 'other/c.spec.ts');
  assert.equal(red.length, 2);
  assert.equal(red.every((entry) => entry.verdict === 'baseline-red'), true);
  assert.equal(red.some((entry) => entry.verdict === 'trusted'), false);
});

test('parameterized runtime titles stay on the inventory row', () => {
  const tests = [inventory('param ${n}', 'tests/a.spec.ts', { line: 3, column: 1 })];
  const records = [1, 2].map((n) =>
    use({
      testTitle: `param ${n}`,
      testLine: 3,
      testColumn: 1,
      call: 'toBeHidden',
      file: 'tests/a.spec.ts',
      line: 4,
    }),
  );
  const groups = groupRecords(records);
  assert.equal(groups.length, 1);
  const findings = findAbsenceOnUnseen(tests, groups, projectDir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].testTitle, 'param ${n}');
  assert.match(findings[0].evidence, /Runtime titles: param 1, param 2/);
  const result = evaluateLocatorCheck(
    projectDir,
    tests,
    {
      schemaVersion: 1,
      tool: { name: 'qa-core-verify', version: '0.0.1' },
      playwrightVersion: '1.60.0',
      project: { dir: 'example' },
      playwrightExitCode: 0,
      records,
    },
    { ok: true, exitCode: 0, passed: 2, failed: 0, skipped: 0, failedKeys: new Set(), stdout: '', stderr: '' },
  );
  const report = buildReport({
    projectDir,
    specCount: 1,
    tests,
    skippedDescribes: [],
    findings: result.findings,
    checksRun: ['locator'],
    startedAt: clock,
    finishedAt: clock,
    baselineRed: result.baselineRed,
    locatorSummaries: result.summaries,
  });
  assert.equal(report.tests.length, 1);
  assert.equal(report.tests[0].titlePath.join(' > '), 'param ${n}');
  assert.equal(report.tests[0].verdict, 'review');
  assert.match(report.tests[0].findings[0].evidence, /param 1/);
  assert.match(report.tests[0].findings[0].evidence, /param 2/);
});

test('two tests on one line keep the finding on the call Playwright records', () => {
  const tests = [
    inventory('left ${n}', 'tests/p.spec.ts', { line: 9, column: 3, evidenceColumns: [3, 7] }),
    inventory('right ${n}', 'tests/p.spec.ts', { line: 9, column: 139, evidenceColumns: [139, 143] }),
  ];
  const records = [1, 2].map((n) =>
    use({
      selector: '#left-ghost',
      api: "locator('#left-ghost')",
      call: 'toBeHidden',
      testFile: 'tests/p.spec.ts',
      testLine: 9,
      testColumn: 7,
      testTitle: `left ${n}`,
      file: 'tests/p.spec.ts',
      line: 9,
    }),
  );
  const result = evaluateLocatorCheck(projectDir, tests, evidenceFile(records), ranBaseline());
  const report = reportFor(tests, result);
  const left = report.tests.find((entry) => entry.titlePath.join(' > ') === 'left ${n}');
  const right = report.tests.find((entry) => entry.titlePath.join(' > ') === 'right ${n}');
  assert.equal(left.id.endsWith('tests/p.spec.ts:9:3:left ${n}') || left.id.includes(':9:3:'), true);
  assert.match(left.id, /:9:3:/);
  assert.match(right.id, /:9:139:/);
  assert.equal(left.verdict, 'review');
  assert.equal(left.findings.some((finding) => finding.ruleId === L002_RULE_ID), true);
  assert.match(left.findings.map((finding) => finding.evidence).join('\n'), /left-ghost/);
  assert.equal(right.verdict, 'trusted');
  assert.equal(right.findings.length, 0);
});

test('a same-line locator stays on the test that recorded it', () => {
  const tests = [
    inventory('fails', 'tests/same.spec.ts', { line: 1, column: 50, evidenceColumns: [50, 54] }),
    inventory('ghost', 'tests/same.spec.ts', { line: 1, column: 179, evidenceColumns: [179, 183] }),
  ];
  const records = [
    use({
      selector: '#never',
      api: "locator('#never')",
      phase: 'action',
      call: 'click',
      matchCount: 0,
      actionSucceeded: false,
      resolvedOnAction: false,
      testFile: 'tests/same.spec.ts',
      testLine: 1,
      testColumn: 63,
      testTitle: 'fails',
      file: 'tests/same.spec.ts',
      line: 1,
      column: 159,
    }),
    use({
      selector: '#ghost',
      api: "locator('#ghost')",
      call: 'toBeHidden',
      testFile: 'tests/same.spec.ts',
      testLine: 1,
      testColumn: 192,
      testTitle: 'ghost',
      file: 'tests/same.spec.ts',
      line: 1,
      column: 296,
    }),
  ];
  const baseline = {
    ok: true,
    exitCode: 1,
    passed: 1,
    failed: 1,
    skipped: 0,
    failedKeys: new Set(['tests/same.spec.ts:1:54']),
    seenKeys: new Set(['tests/same.spec.ts:1:54', 'tests/same.spec.ts:1:183']),
    skippedKeys: new Set(),
    stdout: '',
    stderr: '',
  };
  const result = evaluateLocatorCheck(projectDir, tests, evidenceFile(records), baseline);
  const report = reportFor(tests, result);
  const fails = report.tests.find((entry) => entry.titlePath.join(' > ') === 'fails');
  const ghost = report.tests.find((entry) => entry.titlePath.join(' > ') === 'ghost');
  assert.equal(fails.verdict, 'baseline-red');
  assert.equal(fails.findings.length, 0);
  assert.equal(ghost.verdict, 'review');
  assert.deepEqual(ghost.findings.map((finding) => finding.ruleId), [L002_RULE_ID]);
  assert.equal(ghost.findings.some((finding) => finding.evidence.includes('#never')), false);
  assert.equal(ghost.findings.some((finding) => finding.evidence.includes('Runtime titles: fails')), false);
  assert.match(ghost.findings[0].evidence, /#ghost/);
});

test('a test that fails the evidence run is not-run and not trusted', () => {
  const tests = [inventory('blows', 'tests/g.spec.ts', { line: 4, column: 1, evidenceColumns: [1, 5] })];
  const records = [
    use({
      selector: '#ghost',
      api: "locator('#ghost')",
      call: 'toBeHidden',
      testFile: 'tests/g.spec.ts',
      testLine: 4,
      testColumn: 5,
      testTitle: 'blows',
      file: 'tests/g.spec.ts',
      line: 4,
    }),
  ];
  const baseline = {
    ok: true,
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    failedKeys: new Set(),
    seenKeys: new Set(['tests/g.spec.ts:4:5']),
    skippedKeys: new Set(),
    stdout: '',
    stderr: '',
  };
  const trustedIfIgnored = evaluateLocatorCheck(projectDir, tests, evidenceFile(records), baseline);
  assert.equal(reportFor(tests, trustedIfIgnored).tests[0].verdict, 'review');
  const evidenceRun = {
    ok: true,
    exitCode: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    failedKeys: new Set(['tests/g.spec.ts:4:5']),
    seenKeys: new Set(['tests/g.spec.ts:4:5']),
    skippedKeys: new Set(),
    stdout: '',
    stderr: '',
  };
  const result = evaluateLocatorCheck(projectDir, tests, evidenceFile(records), baseline, evidenceRun);
  assert.equal(result.findings.length, 0);
  assert.equal(result.notRun.size, 1);
  assert.equal(reportFor(tests, result).tests[0].verdict, 'not-run');
});

test('a column and a title that match no row are not given to every test on the line', () => {
  const tests = [
    inventory('left ${n}', 'tests/p.spec.ts', { line: 9, column: 3, evidenceColumns: [3, 7] }),
    inventory('right ${n}', 'tests/p.spec.ts', { line: 9, column: 139, evidenceColumns: [139, 143] }),
  ];
  const records = [
    use({
      selector: '#left-ghost',
      api: "locator('#left-ghost')",
      call: 'toBeHidden',
      testFile: 'tests/p.spec.ts',
      testLine: 9,
      testColumn: 50,
      testTitle: 'left 1',
      file: 'tests/p.spec.ts',
      line: 9,
    }),
  ];
  const report = reportFor(tests, evaluateLocatorCheck(projectDir, tests, evidenceFile(records), ranBaseline()));
  assert.equal(report.tests.length, 2);
  assert.equal(report.tests.every((entry) => entry.findings.length === 0), true);
  assert.equal(report.tests.every((entry) => entry.verdict === 'trusted'), true);
});

test('a record with no column and no title stays on every test on the line', () => {
  const tests = [
    inventory('left ${n}', 'tests/p.spec.ts', { line: 9, column: 3, evidenceColumns: [3, 7] }),
    inventory('right ${n}', 'tests/p.spec.ts', { line: 9, column: 139, evidenceColumns: [139, 143] }),
  ];
  const records = [
    use({
      selector: '#left-ghost',
      api: "locator('#left-ghost')",
      call: 'toBeHidden',
      testFile: 'tests/p.spec.ts',
      testLine: 9,
      testColumn: 0,
      testTitle: '',
      file: 'tests/p.spec.ts',
      line: 9,
    }),
  ];
  const report = reportFor(tests, evaluateLocatorCheck(projectDir, tests, evidenceFile(records), ranBaseline()));
  assert.equal(report.tests.length, 2);
  assert.equal(report.tests.every((entry) => entry.verdict !== 'trusted'), true);
  assert.equal(report.tests.every((entry) => entry.findings.some((finding) => finding.ruleId === L002_RULE_ID)), true);
});

test('three tests on one line do not inherit a baseline-red locator', () => {
  const tests = [
    inventory('t1 fails', 'tests/three.spec.ts', { line: 3, column: 1, evidenceColumns: [1, 5] }),
    inventory('t2 ghost', 'tests/three.spec.ts', { line: 3, column: 200, evidenceColumns: [200, 204] }),
    inventory('t3 clean', 'tests/three.spec.ts', { line: 3, column: 400, evidenceColumns: [400, 404] }),
  ];
  const records = [
    use({
      selector: '#never1',
      api: "locator('#never1')",
      phase: 'action',
      call: 'click',
      matchCount: 0,
      testFile: 'tests/three.spec.ts',
      testLine: 3,
      testColumn: 80,
      testTitle: 't1 fails',
      file: 'tests/three.spec.ts',
      line: 3,
      column: 105,
    }),
    use({
      selector: '#ghost2',
      api: "locator('#ghost2')",
      call: 'toBeHidden',
      testFile: 'tests/three.spec.ts',
      testLine: 3,
      testColumn: 250,
      testTitle: 't2 ghost',
      file: 'tests/three.spec.ts',
      line: 3,
      column: 280,
    }),
    use({
      selector: '#user-name',
      api: "locator('#user-name')",
      call: 'toBeVisible',
      matchCount: 1,
      testFile: 'tests/three.spec.ts',
      testLine: 3,
      testColumn: 450,
      testTitle: 't3 clean',
      file: 'tests/three.spec.ts',
      line: 3,
      column: 470,
    }),
  ];
  const baseline = {
    ok: true,
    exitCode: 1,
    passed: 2,
    failed: 1,
    skipped: 0,
    failedKeys: new Set(['tests/three.spec.ts:3:5']),
    seenKeys: new Set(['tests/three.spec.ts:3:5', 'tests/three.spec.ts:3:204', 'tests/three.spec.ts:3:404']),
    skippedKeys: new Set(),
    stdout: '',
    stderr: '',
  };
  const report = reportFor(tests, evaluateLocatorCheck(projectDir, tests, evidenceFile(records), baseline));
  const fails = report.tests.find((entry) => entry.titlePath.join(' > ') === 't1 fails');
  const ghost = report.tests.find((entry) => entry.titlePath.join(' > ') === 't2 ghost');
  const clean = report.tests.find((entry) => entry.titlePath.join(' > ') === 't3 clean');
  assert.equal(fails.verdict, 'baseline-red');
  assert.equal(fails.findings.length, 0);
  assert.equal(ghost.verdict, 'review');
  assert.deepEqual(ghost.findings.map((finding) => finding.ruleId), [L002_RULE_ID]);
  assert.equal(ghost.findings.some((finding) => finding.evidence.includes('#never1')), false);
  assert.equal(ghost.findings.some((finding) => finding.column === 105), false);
  assert.equal(clean.verdict, 'trusted');
  assert.equal(clean.findings.length, 0);
});

test('three passing tests on one line keep a locator on the test that recorded it', () => {
  const tests = [
    inventory('t1 passes', 'tests/three.spec.ts', { line: 3, column: 1, evidenceColumns: [1, 5] }),
    inventory('t2 ghost', 'tests/three.spec.ts', { line: 3, column: 200, evidenceColumns: [200, 204] }),
    inventory('t3 clean', 'tests/three.spec.ts', { line: 3, column: 400, evidenceColumns: [400, 404] }),
  ];
  const records = [
    use({
      selector: '#never1',
      api: "locator('#never1')",
      phase: 'action',
      call: 'click',
      matchCount: 0,
      testFile: 'tests/three.spec.ts',
      testLine: 3,
      testColumn: 80,
      testTitle: 't1 passes',
      file: 'tests/three.spec.ts',
      line: 3,
      column: 105,
    }),
    use({
      selector: '#ghost2',
      api: "locator('#ghost2')",
      call: 'toBeHidden',
      testFile: 'tests/three.spec.ts',
      testLine: 3,
      testColumn: 250,
      testTitle: 't2 ghost',
      file: 'tests/three.spec.ts',
      line: 3,
      column: 280,
    }),
    use({
      selector: '#user-name',
      api: "locator('#user-name')",
      call: 'toBeVisible',
      matchCount: 1,
      testFile: 'tests/three.spec.ts',
      testLine: 3,
      testColumn: 450,
      testTitle: 't3 clean',
      file: 'tests/three.spec.ts',
      line: 3,
      column: 470,
    }),
  ];
  const baseline = {
    ok: true,
    exitCode: 0,
    passed: 3,
    failed: 0,
    skipped: 0,
    failedKeys: new Set(),
    seenKeys: new Set(['tests/three.spec.ts:3:5', 'tests/three.spec.ts:3:204', 'tests/three.spec.ts:3:404']),
    skippedKeys: new Set(),
    stdout: '',
    stderr: '',
  };
  const report = reportFor(tests, evaluateLocatorCheck(projectDir, tests, evidenceFile(records), baseline));
  const passes = report.tests.find((entry) => entry.titlePath.join(' > ') === 't1 passes');
  const ghost = report.tests.find((entry) => entry.titlePath.join(' > ') === 't2 ghost');
  const clean = report.tests.find((entry) => entry.titlePath.join(' > ') === 't3 clean');
  assert.equal(passes.verdict, 'untrusted');
  assert.deepEqual(passes.findings.map((finding) => finding.ruleId), [L001_RULE_ID]);
  assert.equal(passes.findings[0].column, 105);
  assert.match(passes.findings[0].evidence, /#never1/);
  assert.equal(ghost.verdict, 'review');
  assert.deepEqual(ghost.findings.map((finding) => finding.ruleId), [L002_RULE_ID]);
  assert.equal(ghost.findings.some((finding) => finding.evidence.includes('#never1')), false);
  assert.equal(clean.verdict, 'trusted');
  assert.equal(clean.findings.length, 0);
});

test('parseBaseline records a skipped spec by file, line, and column', () => {
  const workspace = '/tmp/qcv-run-example/project';
  const stdout = JSON.stringify({
    config: { rootDir: workspace },
    suites: [
      {
        specs: [
          {
            file: 's.spec.ts',
            line: 3,
            column: 7,
            tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }],
          },
          {
            file: 's.spec.ts',
            line: 9,
            column: 5,
            tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
          },
          {
            file: 's.spec.ts',
            line: 14,
            column: 5,
            tests: [{ status: 'unexpected', results: [{ status: 'failed' }] }],
          },
        ],
      },
    ],
  });
  const baseline = parseBaseline(stdout, '', 1, workspace);
  assert.equal(baseline.ok, true);
  assert.equal(baseline.passed, 1);
  assert.equal(baseline.failed, 1);
  assert.equal(baseline.skipped, 1);
  assert.equal(baseline.skippedKeys.has('s.spec.ts:3:7'), true);
  assert.equal(baseline.skippedKeys.has('s.spec.ts:9:5'), false);
  assert.equal(baseline.skippedKeys.has('s.spec.ts:14:5'), false);
  assert.equal(baseline.seenKeys.has('s.spec.ts:3:7'), true);
  assert.equal(baseline.failedKeys.has('s.spec.ts:14:5'), true);
});

test('an expected test.fail is passed and an unexpected pass is a failure', () => {
  const workspace = '/tmp/qcv-run-example/project';
  const stdout = JSON.stringify({
    config: { rootDir: workspace },
    suites: [
      {
        specs: [
          {
            file: 'fail.spec.ts',
            line: 2,
            column: 5,
            tests: [{ status: 'expected', expectedStatus: 'failed', results: [{ status: 'failed' }] }],
          },
          {
            file: 'fail.spec.ts',
            line: 8,
            column: 5,
            tests: [{ status: 'unexpected', expectedStatus: 'failed', results: [{ status: 'passed' }] }],
          },
        ],
      },
    ],
  });
  const baseline = parseBaseline(stdout, '', 1, workspace);
  assert.equal(baseline.passed, 1);
  assert.equal(baseline.failed, 1);
  assert.equal(baseline.skipped, 0);
  assert.equal(baseline.failedKeys.has('fail.spec.ts:2'), false);
  assert.equal(baseline.failedKeys.has('fail.spec.ts:8:5'), true);
  const tests = [
    inventory('expected failure fails', 'fail.spec.ts', { line: 2, column: 1, evidenceColumns: [1, 5] }),
    inventory('unexpected pass', 'fail.spec.ts', { line: 8, column: 1, evidenceColumns: [1, 5] }),
  ];
  const records = [
    use({
      selector: '#ghost',
      api: "locator('#ghost')",
      call: 'toBeHidden',
      testFile: 'fail.spec.ts',
      testLine: 2,
      testColumn: 5,
      testTitle: 'expected failure fails',
      file: 'fail.spec.ts',
      line: 4,
    }),
    use({
      selector: '#ghost',
      api: "locator('#ghost')",
      call: 'toBeHidden',
      testFile: 'fail.spec.ts',
      testLine: 8,
      testColumn: 5,
      testTitle: 'unexpected pass',
      file: 'fail.spec.ts',
      line: 9,
    }),
  ];
  const report = reportFor(tests, evaluateLocatorCheck(projectDir, tests, evidenceFile(records), baseline));
  const expected = report.tests.find((entry) => entry.titlePath.join(' > ') === 'expected failure fails');
  const unexpected = report.tests.find((entry) => entry.titlePath.join(' > ') === 'unexpected pass');
  assert.equal(expected.verdict, 'review');
  assert.equal(expected.findings.some((finding) => finding.ruleId === L002_RULE_ID), true);
  assert.equal(unexpected.verdict, 'baseline-red');
  assert.equal(unexpected.findings.length, 0);
});

test('project specs that share a test are combined before skip and failure', () => {
  const workspace = '/tmp/qcv-run-example/project';
  const stdout = JSON.stringify({
    config: { rootDir: workspace },
    suites: [
      {
        specs: [
          { file: 'p.spec.ts', line: 2, column: 5, tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] },
          { file: 'p.spec.ts', line: 8, column: 5, tests: [{ status: 'unexpected', results: [{ status: 'failed' }] }] },
          { file: 'p.spec.ts', line: 14, column: 5, tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] },
        ],
      },
      {
        specs: [
          { file: 'p.spec.ts', line: 2, column: 5, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] },
          { file: 'p.spec.ts', line: 8, column: 5, tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] },
          { file: 'p.spec.ts', line: 14, column: 5, tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] },
        ],
      },
    ],
  });
  const baseline = parseBaseline(stdout, '', 1, workspace);
  assert.equal(baseline.passed, 1);
  assert.equal(baseline.failed, 1);
  assert.equal(baseline.skipped, 4);
  assert.equal(baseline.skippedKeys.has('p.spec.ts:2:5'), false);
  assert.equal(baseline.failedKeys.has('p.spec.ts:2'), false);
  assert.equal(baseline.failedKeys.has('p.spec.ts:8:5'), true);
  assert.equal(baseline.skippedKeys.has('p.spec.ts:8:5'), false);
  assert.equal(baseline.skippedKeys.has('p.spec.ts:14:5'), true);
  const tests = [
    inventory('skipped in a, runs in b ghost', 'p.spec.ts', { line: 2, column: 1, evidenceColumns: [1, 5] }),
    inventory('fails in a, skipped in b', 'p.spec.ts', { line: 8, column: 1, evidenceColumns: [1, 5] }),
    inventory('skipped in both', 'p.spec.ts', { line: 14, column: 1, evidenceColumns: [1, 5] }),
  ];
  const records = [
    use({
      selector: '#ghost',
      api: "locator('#ghost')",
      call: 'toBeHidden',
      testFile: 'p.spec.ts',
      testLine: 2,
      testColumn: 5,
      testTitle: 'skipped in a, runs in b ghost',
      file: 'p.spec.ts',
      line: 4,
    }),
  ];
  const report = reportFor(tests, evaluateLocatorCheck(projectDir, tests, evidenceFile(records), baseline));
  const ran = report.tests.find((entry) => entry.titlePath.join(' > ') === 'skipped in a, runs in b ghost');
  const failed = report.tests.find((entry) => entry.titlePath.join(' > ') === 'fails in a, skipped in b');
  const both = report.tests.find((entry) => entry.titlePath.join(' > ') === 'skipped in both');
  assert.equal(ran.verdict, 'review');
  assert.equal(ran.findings.some((finding) => finding.ruleId === L002_RULE_ID), true);
  assert.equal(failed.verdict, 'baseline-red');
  assert.equal(failed.findings.length, 0);
  assert.equal(both.verdict, 'not-run');
  assert.notEqual(both.verdict, 'trusted');
  assert.equal(both.findings.length, 0);
});

test('a baseline skip is not-run and the ghost finding is dropped', () => {
  const tests = [
    inventory('bare skip in body', 'tests/s.spec.ts', { line: 3, column: 1, evidenceColumns: [1, 5] }),
    inventory('ran', 'tests/s.spec.ts', { line: 9, column: 1, evidenceColumns: [1, 5] }),
  ];
  const baseline = {
    ok: true,
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 1,
    failedKeys: new Set(),
    seenKeys: new Set(['tests/s.spec.ts:3:7', 'tests/s.spec.ts:9:5']),
    skippedKeys: new Set(['tests/s.spec.ts:3:7']),
    stdout: '',
    stderr: '',
  };
  const records = [
    use({
      selector: '#ghost',
      api: "locator('#ghost')",
      call: 'toBeHidden',
      testFile: 'tests/s.spec.ts',
      testLine: 3,
      testColumn: 7,
      testTitle: 'bare skip in body',
      file: 'tests/s.spec.ts',
      line: 5,
    }),
  ];
  const report = reportFor(tests, evaluateLocatorCheck(projectDir, tests, evidenceFile(records), baseline));
  const skipped = report.tests.find((entry) => entry.titlePath.join(' > ') === 'bare skip in body');
  const ran = report.tests.find((entry) => entry.titlePath.join(' > ') === 'ran');
  assert.equal(skipped.verdict, 'not-run');
  assert.notEqual(skipped.verdict, 'trusted');
  assert.equal(skipped.findings.length, 0);
  assert.equal(ran.verdict, 'trusted');
  assert.equal(report.summary.verdict['not-run'], 1);
  assert.equal(report.summary.verdict.trusted, 1);
});

test('a test missing from the baseline is not-run', () => {
  const tests = [
    inventory('keep me', 'tests/a.spec.ts', { line: 2, column: 1, evidenceColumns: [1, 5] }),
    inventory('dropped by grep', 'tests/a.spec.ts', { line: 9, column: 1, evidenceColumns: [1, 5] }),
  ];
  const baseline = {
    ok: true,
    exitCode: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    failedKeys: new Set(),
    seenKeys: new Set(['tests/a.spec.ts:2:5']),
    stdout: '',
    stderr: '',
  };
  const report = reportFor(tests, evaluateLocatorCheck(projectDir, tests, evidenceFile([]), baseline));
  const dropped = report.tests.find((entry) => entry.titlePath.join(' > ') === 'dropped by grep');
  const kept = report.tests.find((entry) => entry.titlePath.join(' > ') === 'keep me');
  assert.equal(dropped.verdict, 'not-run');
  assert.notEqual(dropped.verdict, 'trusted');
  assert.equal(kept.verdict, 'trusted');
  assert.equal(report.summary.verdict['not-run'], 1);
});

test('a baseline failure drops locator findings and the locator summary', () => {
  const tests = [inventory('banner'), inventory('other', 'tests/b.spec.ts')];
  const evidence = {
    schemaVersion: 1,
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    project: { dir: 'saucedemo' },
    playwrightExitCode: 1,
    records: [
      use({ testTitle: 'banner' }),
      use({ testFile: 'tests/b.spec.ts', testTitle: 'other', file: 'tests/b.spec.ts', call: 'toBeHidden' }),
    ],
  };
  const baseline = {
    ok: true,
    exitCode: 1,
    passed: 1,
    failed: 1,
    skipped: 0,
    failedKeys: new Set(['tests/a.spec.ts:2']),
    stdout: '',
    stderr: '',
  };
  const result = evaluateLocatorCheck(projectDir, tests, evidence, baseline);
  assert.equal(result.baselineRed.size, 1);
  assert.equal(result.findings.some((finding) => finding.testTitle === 'banner'), false);
  assert.equal(result.findings.some((finding) => finding.ruleId === L002_RULE_ID), true);
  const redId = ownerIdFor('test', tests[0].file, tests[0].line, tests[0].column, tests[0].titlePath);
  assert.equal(result.summaries.has(redId), false);
  const kept = [...result.summaries.values()][0];
  assert.equal(kept[0].status, 'never-matched');
});

test('evidence urls drop the query string and keep the hash', () => {
  const workspace = '/tmp/qcv-workspace-example';
  const evidence = buildEvidence({
    parts: [
      {
        selector: '#ok',
        api: "locator('#ok')",
        url: 'https://www.saucedemo.com/inventory.html?session=1&x=2#cart',
        matchCount: 1,
        phase: 'assertion',
        call: 'toBeVisible',
        negated: false,
        actionSucceeded: false,
        stack: `Error\n    at spec (${workspace}/tests/a.spec.ts:4:3)`,
        testFile: `${workspace}/tests/a.spec.ts`,
        testLine: 2,
        testTitle: 'sees it',
      },
    ],
    workspaceDir: workspace,
    projectDir: projectDir,
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    playwrightExitCode: 0,
  });
  assert.equal(evidence.records[0].url, 'https://www.saucedemo.com/inventory.html#cart');
});

test('a null count on a successful action is kept', () => {
  const workspace = '/tmp/qcv-workspace-example';
  const evidence = buildEvidence({
    parts: [
      {
        selector: '#x',
        api: "locator('#x')",
        url: 'about:blank',
        matchCount: null,
        phase: 'action',
        call: 'click',
        negated: false,
        actionSucceeded: true,
        stack: `Error\n    at spec (${workspace}/tests/a.spec.ts:4:3)`,
        testFile: `${workspace}/tests/a.spec.ts`,
        testLine: 2,
        testTitle: 'closes',
      },
    ],
    workspaceDir: workspace,
    projectDir: projectDir,
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    playwrightExitCode: 0,
  });
  assert.equal(evidence.records.length, 1);
  assert.equal(evidence.records[0].matchCount, null);
  assert.equal(evidence.records[0].resolvedOnAction, true);
  assert.equal(statusOf(evidence.records), 'unique');
});

test('titles do not let U+2028 or U+2029 through, and evidence keeps newlines in md and html', () => {
  const file = path.join(projectDir, 'tests/a.spec.ts');
  const title = 'before\u2028after\u2029end';
  const testRow = inventory('ignored', 'tests/a.spec.ts', { title, titlePath: [title], file, line: 3, column: 1 });
  const ownerId = ownerIdFor('test', file, 3, 1, [title]);
  const report = buildReport({
    projectDir,
    configFile: undefined,
    specCount: 1,
    tests: [testRow],
    skippedDescribes: [],
    findings: [
      {
        ruleId: L002_RULE_ID,
        check: 'locator',
        severity: 'warn',
        file,
        line: 4,
        column: 1,
        testTitle: title,
        message: 'stays green',
        evidence: 'alpha\nbeta',
        fixHint: 'gamma\ndelta',
        ownerId,
      },
    ],
    checksRun: ['locator'],
    startedAt: clock,
    finishedAt: clock,
    locatorSummaries: new Map([
      [ownerId, [{ selector: '#banner', api: "locator('#banner')", status: 'never-matched', file: 'tests/a.spec.ts', line: 4, column: 1, counts: [0], parentCounts: [] }]],
    ]),
  });
  const json = reportJson(report);
  const markdown = formatMarkdown(report);
  const html = formatHtml(report);
  const consoleText = formatConsoleReport(report, []);
  for (const text of [json, markdown, html, consoleText]) {
    assert.equal(text.includes('\u2028'), false, 'U+2028');
    assert.equal(text.includes('\u2029'), false, 'U+2029');
    assert.match(text, /before after end/);
  }
  assert.match(markdown, /```\nalpha\nbeta\n```/);
  assert.match(markdown, /```\ngamma\ndelta\n```/);
  assert.match(html, /<pre>alpha\nbeta<\/pre>/);
  assert.match(html, /<pre>gamma\ndelta<\/pre>/);
  assert.match(consoleText, /Locator never-matched/);
  assert.match(markdown, /never-matched/);
  assert.match(html, /never-matched/);
});

test('the docs name the locator limits from the PR 05 review', () => {
  const decision = fs.readFileSync(path.join(repoRoot, 'docs/decisions/0001-locator-evidence.md'), 'utf8');
  const schemaDoc = fs.readFileSync(path.join(repoRoot, 'docs/report-schema.md'), 'utf8');
  const rules = fs.readFileSync(path.join(repoRoot, 'docs/rules.md'), 'utf8');
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.equal(schemaDoc.includes('In the plan'), false);
  assert.match(decision, /frameLocator/);
  assert.match(decision, /context\.newPage/);
  assert.match(decision, /re-exports every value from `@playwright\/test`/);
  assert.match(decision, /outside the project folder/);
  assert.match(decision, /qcv-locator-fixture\.ts/);
  assert.match(decision, /query string/);
  assert.match(decision, /parentCount/);
  assert.match(decision, /backslash anywhere in `TMPDIR`/);
  assert.match(decision, /no Workspace line/);
  assert.match(decision, /ancestor of the link/);
  assert.match(decision, /Startup does not delete `qcv-run-\*` or `qcv-workspace-\*`/);
  assert.match(rules, /toBeVisible\(\{ visible: false \}\)/);
  assert.match(rules, /toHaveCount\(0\)/);
  assert.equal(rules.includes('toBeEnabled({ enabled: false })'), false);
  assert.equal(rules.includes('toBeChecked({ checked: false })'), false);
  assert.equal(rules.includes('toBeEditable({ editable: false })'), false);
  assert.match(rules, /QCV-L001/);
  assert.match(rules, /QCV-L002/);
  assert.match(rules, /This test stays green even if this element does not exist/);
  assert.match(rules, /https:\/\/playwright\.dev\/docs\/locators/);
  assert.match(readme, /testInfo\.skip\(\)/);
  assert.match(readme, /test\.describe\.serial/);
  assert.match(readme, /test\.fail\(\)/);
  assert.match(readme, /no project ran it/);
  assert.match(readme, /--retries=0/);
  assert.match(readme, /fails its first attempt/);
  assert.match(schemaDoc, /baseline report marks skipped/);
  assert.match(schemaDoc, /test\.fail\(\)/);
  assert.match(schemaDoc, /no project ran it/);
  assert.match(schemaDoc, /--retries=0/);
  assert.match(schemaDoc, /fails its first attempt/);
});
