import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig } from '../dist/config.js';
import { parseSpecFile } from '../dist/inventory/parse.js';
import { collectFindings } from '../dist/rules/index.js';
import { lineAndColumn } from './support.mjs';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function findingsIn(file) {
  const inventory = parseSpecFile(file, emptyConfig());
  return collectFindings(inventory.tests, inventory.skippedDescribes);
}

function titlesFor(findings, ruleId) {
  return findings.filter((finding) => finding.ruleId === ruleId).map((finding) => finding.testTitle).sort();
}

const cases = [
  {
    dir: 'w002',
    ruleId: 'QCV-W002',
    severity: 'error',
    relatedLintRule: 'no-unnecessary-assertions',
    titles: ['inline locator', 'not falsy', 'not null', 'not undefined', 'variable locator'],
    needle: 'expect(button).toBeDefined()',
    evidence: 'expect(button).toBeDefined()',
  },
  {
    dir: 'w003',
    ruleId: 'QCV-W003',
    severity: 'error',
    relatedLintRule: 'missing-playwright-await',
    titles: [
      'alias not awaited',
      'closure call',
      'contain class',
      'fixture locator',
      'match aria snapshot',
      'not awaited',
      'page url',
      'poll',
      'response ok',
      'soft text',
      'to pass',
      'unawaited imported helper',
      'unawaited local helper',
      'unawaited rejects',
      'unawaited resolves',
      'unawaited step block',
    ],
    needle: 'expect(page).toHaveURL',
    evidence: 'expect(page).toHaveURL(\'/inventory.html\')',
  },
  {
    dir: 'w004',
    ruleId: 'QCV-W004',
    severity: 'error',
    titles: ['one to one', 'same source', 'same text different quotes', 'true to true'],
    needle: 'expect(true).toBe(true)',
    evidence: 'expect(true).toBe(true)',
  },
  {
    dir: 'w005',
    ruleId: 'QCV-W005',
    severity: 'warn',
    titles: ['attribute', 'count at least zero', 'inner text variable', 'input value', 'text content'],
    needle: 'expect(text).toBeDefined()',
    evidence: 'expect(text).toBeDefined()',
  },
  {
    dir: 'w006',
    ruleId: 'QCV-W006',
    severity: 'warn',
    titles: ['attached and in viewport', 'presence after the last click', 'visible after click'],
    needle: 'await expect(page.getByTestId(\'inventory-list\')).toBeVisible()',
    evidence: 'await expect(page.getByTestId(\'inventory-list\')).toBeVisible()',
  },
  {
    dir: 'w007',
    ruleId: 'QCV-W007',
    severity: 'warn',
    relatedLintRule: 'no-conditional-expect',
    titles: ['and', 'catch', 'for each', 'for of', 'if', 'nullish', 'or', 'switch', 'ternary', 'ternary', 'while'],
    needle: 'await expect(page.getByTestId(\'title\')).toHaveText(\'Products\')',
    evidence: 'await expect(page.getByTestId(\'title\')).toHaveText(\'Products\')',
  },
  {
    dir: 'w008',
    ruleId: 'QCV-W008',
    severity: 'error',
    titles: ['empty catch', 'logs and continues', 'rethrows only inside if'],
    needle: 'await expect(page.locator(\'#login-error-banner\')).toBeVisible()',
    evidence: 'await expect(page.locator(\'#login-error-banner\')).toBeVisible()',
  },
  {
    dir: 'w009',
    ruleId: 'QCV-W009',
    severity: 'info',
    titles: [
      'empty skipped suite',
      'fixme',
      'fixme suite > inside fixme',
      'focused',
      'focused suite > inside only',
      'skipped',
      'skipped suite',
    ],
    needle: 'test.skip(\'skipped\'',
    evidence: 'test.skip',
  },
  {
    dir: 'w010',
    ruleId: 'QCV-W010',
    severity: 'info',
    relatedLintRule: 'no-wait-for-timeout',
    titles: ['text then wait', 'wait then end'],
    needle: 'await page.waitForTimeout(1000)',
    evidence: 'page.waitForTimeout(1000)',
    extra: { 'wait then end': ['QCV-W001'] },
  },
];

for (const entry of cases) {
  test(`${entry.ruleId} fires on every bad case and on nothing in the good file`, () => {
    const badFile = path.join(fixtures, entry.dir, 'bad.spec.ts');
    const goodFile = path.join(fixtures, entry.dir, 'good.spec.ts');
    const bad = findingsIn(badFile);
    const good = findingsIn(goodFile);
    assert.deepEqual(titlesFor(bad, entry.ruleId), entry.titles);
    assert.deepEqual(good, []);
    const sample = bad.find((finding) => finding.evidence === entry.evidence);
    assert.ok(sample, bad.map((finding) => finding.evidence).join('\n'));
    assert.equal(sample.ruleId, entry.ruleId);
    assert.equal(sample.check, 'weak-assertion');
    assert.equal(sample.severity, entry.severity);
    assert.equal(sample.file, path.resolve(badFile));
    const expected = lineAndColumn(badFile, entry.needle);
    assert.equal(sample.line, expected.line);
    assert.equal(sample.fixHint.length > 0, true);
    if (entry.relatedLintRule) assert.equal(sample.relatedLintRule, entry.relatedLintRule);
    const extras = entry.extra ?? {};
    for (const finding of bad) {
      if (finding.ruleId === entry.ruleId) continue;
      const allowed = extras[finding.testTitle] ?? [];
      assert.equal(allowed.includes(finding.ruleId), true, `${finding.testTitle} ${finding.ruleId}`);
    }
  });
}

test('QCV-W003 does not flag an assertion returned from the test', () => {
  const findings = findingsIn(path.join(fixtures, 'w003/good.spec.ts'));
  assert.deepEqual(findings, []);
});

test('QCV-W003 message says the async assertion is not awaited', () => {
  const findings = findingsIn(path.join(fixtures, 'w003/bad.spec.ts'));
  assert.equal(findings.every((finding) => finding.message === 'Async assertion is not awaited.'), true);
  const step = findings.find((finding) => finding.testTitle === 'unawaited step block');
  assert.match(step.evidence, /test\.step/);
  const helper = findings.find((finding) => finding.testTitle === 'unawaited imported helper');
  assert.equal(helper.evidence, 'checkTitle(page)');
  const resolves = findings.find((finding) => finding.testTitle === 'unawaited resolves');
  assert.match(resolves.evidence, /\.resolves\.toBe/);
});

test('a const alias of expect counts, and a let alias does not', () => {
  const file = path.join(fixtures, 'w003/alias.spec.ts');
  const findings = findingsIn(file);
  assert.deepEqual(
    findings.map((finding) => `${finding.ruleId} ${finding.testTitle}`).sort(),
    ['QCV-W001 let alias is not seen', 'QCV-W003 alias not awaited'],
  );
});

test('QCV-W009 uses the focused lint rule for test.only and the skipped lint rule for test.skip', () => {
  const findings = findingsIn(path.join(fixtures, 'w009/bad.spec.ts'));
  const focused = findings.find((finding) => finding.testTitle === 'focused');
  const skipped = findings.find((finding) => finding.testTitle === 'skipped suite');
  assert.equal(focused.relatedLintRule, 'no-focused-test');
  assert.equal(focused.evidence, 'test.only');
  assert.equal(skipped.relatedLintRule, 'no-skipped-test');
  assert.equal(skipped.evidence, 'test.describe.skip');
  assert.equal(skipped.message, 'Describe block is skipped.');
  assert.equal(findings.filter((finding) => finding.testTitle === 'skipped suite').length, 1);
  assert.equal(findings.some((finding) => finding.testTitle === 'skipped suite > inside skip'), false);
  assert.equal(findings.some((finding) => finding.testTitle === 'skipped suite > also inside skip'), false);
});

test('a helper imported one level counts as the test assertion', () => {
  const findings = findingsIn(path.join(fixtures, 'helpers-resolve/one-level.spec.ts'));
  assert.deepEqual(findings, []);
});

test('a locator helper imported one level is still a locator for QCV-W002', () => {
  const findings = findingsIn(path.join(fixtures, 'helpers-resolve/locator-one.spec.ts'));
  assert.deepEqual(titlesFor(findings, 'QCV-W002'), ['truthy helper locator']);
  assert.equal(findings.length, 1);
  assert.match(findings[0].evidence, /loginButton\(page\)/);
  assert.match(findings[0].fixHint, /toBeVisible/);
});

test('a second import level is QCV-W000 and is not treated as a missing assertion', () => {
  const findings = findingsIn(path.join(fixtures, 'helpers-resolve/two-level.spec.ts'));
  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.equal(finding.ruleId, 'QCV-W000');
  assert.equal(finding.severity, 'info');
  assert.equal(finding.message, 'Could Not Resolve Helper');
  assert.equal(finding.evidence, 'deepAssert(page)');
  assert.match(finding.fixHint, /deepAssert/);
  assert.equal(titlesFor(findings, 'QCV-W001').length, 0);
});

test('a locator returned through a second import is not guessed', () => {
  const findings = findingsIn(path.join(fixtures, 'helpers-resolve/locator-two.spec.ts'));
  assert.equal(titlesFor(findings, 'QCV-W002').length, 0);
  assert.deepEqual(titlesFor(findings, 'QCV-W000'), ['two level locator']);
  assert.equal(findings[0].evidence, 'title(page)');
  assert.equal(findings[0].message, 'Could Not Resolve Helper');
});

test('a page object class imported one level is resolved', () => {
  const findings = findingsIn(path.join(fixtures, 'helpers-resolve/class-page.spec.ts'));
  assert.deepEqual(
    findings.map((finding) => `${finding.ruleId} ${finding.testTitle}`),
    ['QCV-W002 page object locator is truthy'],
  );
});

test('page object fields and getters keep their locator or page read kind', () => {
  const bad = findingsIn(path.join(fixtures, 'helpers-resolve/field-locators.spec.ts'));
  assert.deepEqual(
    bad.map((finding) => `${finding.ruleId} ${finding.testTitle}`).sort(),
    [
      'QCV-W002 constructor field is truthy',
      'QCV-W002 getter field is truthy',
      'QCV-W002 initializer field is truthy',
      'QCV-W003 constructor field is not awaited',
      'QCV-W005 page read field is truthy',
    ],
  );
  assert.deepEqual(findingsIn(path.join(fixtures, 'helpers-resolve/field-locators-good.spec.ts')), []);
});
