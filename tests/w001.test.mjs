import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig, loadVerifyConfig } from '../dist/config.js';
import { parseSpecFile } from '../dist/inventory/parse.js';
import { findTestsWithNoAssertion } from '../dist/rules/w001-no-assertion.js';
import { lineAndColumn } from './support.mjs';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const w001Dir = path.join(fixtures, 'w001');
const parserDir = path.join(fixtures, 'parser');

function findingsFor(file, config) {
  return findTestsWithNoAssertion(parseSpecFile(file, config).tests);
}

test('flags a test that clicks and does not assert', () => {
  const file = path.join(w001Dir, 'bad.spec.ts');
  const findings = findingsFor(file, emptyConfig());
  const finding = findings.find((entry) => entry.testTitle === 'clicks and does not assert');
  const expected = lineAndColumn(file, 'test(\'clicks and does not assert\'');
  assert.ok(finding);
  assert.equal(finding.ruleId, 'QCV-W001');
  assert.equal(finding.check, 'weak-assertion');
  assert.equal(finding.severity, 'error');
  assert.equal(finding.file, path.resolve(file));
  assert.equal(finding.line, expected.line);
  assert.equal(finding.column, expected.column);
  assert.equal(finding.message, 'Test has no assertion.');
});

test('flags a test that only logs', () => {
  const file = path.join(w001Dir, 'bad.spec.ts');
  const findings = findingsFor(file, emptyConfig());
  const finding = findings.find((entry) => entry.testTitle === 'only logs');
  assert.ok(finding);
  assert.equal(finding.line, lineAndColumn(file, 'test(\'only logs\'').line);
});

test('flags an empty test', () => {
  const file = path.join(w001Dir, 'bad.spec.ts');
  const findings = findingsFor(file, emptyConfig());
  const finding = findings.find((entry) => entry.testTitle === 'empty test');
  assert.ok(finding);
  assert.equal(finding.line, lineAndColumn(file, 'test(\'empty test\'').line);
  assert.equal(findings.length, 3);
});

test('does not flag a test with expect in the body', () => {
  const file = path.join(w001Dir, 'good.spec.ts');
  const findings = findingsFor(file, loadVerifyConfig(w001Dir));
  assert.equal(findings.some((entry) => entry.testTitle === 'expect in the body'), false);
});

test('does not flag a test with expect inside test.step', () => {
  const file = path.join(w001Dir, 'good.spec.ts');
  const findings = findingsFor(file, loadVerifyConfig(w001Dir));
  assert.equal(findings.some((entry) => entry.testTitle === 'expect inside a step'), false);
});

test('does not flag a test that calls a configured helper name', () => {
  const file = path.join(w001Dir, 'good.spec.ts');
  const withConfig = findingsFor(file, loadVerifyConfig(w001Dir));
  assert.equal(withConfig.some((entry) => entry.testTitle === 'configured helper'), false);
  const withoutConfig = findingsFor(file, emptyConfig());
  assert.equal(withoutConfig.some((entry) => entry.testTitle === 'configured helper'), true);
});

test('does not flag a helper that matches assertFunctionPatterns', () => {
  const file = path.join(fixtures, 'helpers/pattern.spec.ts');
  const config = loadVerifyConfig(path.join(fixtures, 'helpers'));
  const findings = findingsFor(file, config);
  assert.deepEqual(
    findings.map((entry) => entry.testTitle),
    ['not a configured helper'],
  );
  const withoutConfig = findingsFor(file, emptyConfig());
  assert.deepEqual(
    withoutConfig.map((entry) => entry.testTitle).sort(),
    ['member pattern helper', 'not a configured helper', 'pattern helper'],
  );
});

test('flags a test with no assertion when test is imported from a relative fixture', () => {
  const findings = findingsFor(path.join(parserDir, 'relative-import.spec.ts'), emptyConfig());
  assert.deepEqual(
    findings.map((entry) => entry.testTitle),
    ['relative > relative bad'],
  );
});

test('does not flag test.skip or test.fixme', () => {
  const findings = findingsFor(path.join(parserDir, 'modifiers.spec.ts'), emptyConfig());
  const titles = findings.map((entry) => entry.testTitle);
  assert.deepEqual(titles, ['active > focused without assertion']);
  assert.equal(titles.includes('active > skipped without assertion'), false);
  assert.equal(titles.includes('active > fixme without assertion'), false);
  assert.equal(titles.includes('skipped suite > inside skipped describe'), false);
  assert.equal(titles.includes('fixme suite > inside fixme describe'), false);
  assert.equal(titles.includes('plain with assertion'), false);
});

test('still flags a test when the only expect is in beforeEach', () => {
  const findings = findingsFor(path.join(parserDir, 'hooks.spec.ts'), emptyConfig());
  assert.deepEqual(
    findings.map((entry) => entry.testTitle),
    ['after hook only'],
  );
});

test('flags an extended test that has no assertion', () => {
  const findings = findingsFor(path.join(parserDir, 'extend.spec.ts'), emptyConfig());
  assert.deepEqual(
    findings.map((entry) => entry.testTitle),
    ['chained extend without assertion'],
  );
});

test('does not flag condition annotations, and still flags an empty test.fail and an in-body skip', () => {
  const findings = findingsFor(path.join(parserDir, 'annotations.spec.ts'), emptyConfig());
  assert.deepEqual(
    findings.map((entry) => entry.testTitle),
    ['annotations > failing and empty', 'annotations > skips inside the body'],
  );
});

test('flags a generated test that has no assertion', () => {
  const findings = findingsFor(path.join(parserDir, 'generated.spec.ts'), emptyConfig());
  assert.deepEqual(
    findings.map((entry) => entry.testTitle),
    ['generated > mapped ${name}'],
  );
});

test('does not flag inline or aliased expect.configure', () => {
  const findings = findingsFor(path.join(parserDir, 'configure.spec.ts'), emptyConfig());
  assert.deepEqual(
    findings.map((entry) => entry.testTitle),
    ['still empty'],
  );
});
