import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STATIC_RULE_IDS } from '../dist/rules/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function uniqueInOrder(values) {
  const seen = new Set();
  const ordered = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

test('the README static rule list matches src/rules/index.ts', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const listed = [...readme.matchAll(/^\| (QCV-W\d{3}) \|/gm)].map((match) => match[1]);
  assert.deepEqual(listed, [...STATIC_RULE_IDS]);
  assert.equal(uniqueInOrder(listed).length, listed.length);
});

test('package.json is publishable at 0.1.0 and points at this repository', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.repository.url, 'git+https://github.com/sprintsynergyio/qa-core-verify.git');
  assert.equal(pkg.homepage, 'https://github.com/sprintsynergyio/qa-core-verify#readme');
  assert.equal(pkg.bugs.url, 'https://github.com/sprintsynergyio/qa-core-verify/issues');
  assert.equal(pkg.files.includes('dist'), true);
  assert.equal(JSON.stringify(pkg).includes('sprintsynergyhq'), false);
});
