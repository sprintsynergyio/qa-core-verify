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
  assert.match(rules, /QCV-L001/);
  assert.match(rules, /QCV-L002/);
  assert.match(rules, /This test stays green even if this element does not exist/);
  assert.match(rules, /https:\/\/playwright\.dev\/docs\/locators/);
});
