import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverSpecs, globToRegExp } from '../dist/inventory/discover.js';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-verify-discover-'));
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('the Playwright default testMatch glob matches spec and test files', () => {
  const expression = globToRegExp('**/*.@(spec|test).?(c|m)[jt]s?(x)');
  for (const name of ['foo.spec.ts', 'foo.test.js', 'dir/foo.spec.mjs', 'dir/foo.test.tsx', 'foo.spec.cjs']) {
    assert.equal(expression.test(name), true, name);
  }
  assert.equal(expression.test('foo.e2e.ts'), false);
  assert.equal(expression.test('foo.spec.txt'), false);
});

test('uses default globs when no Playwright config exists, and skips node_modules', () => {
  const dir = makeProject();
  write(path.join(dir, 'a.spec.ts'), '');
  write(path.join(dir, 'nested/b.spec.js'), '');
  write(path.join(dir, 'nested/c.test.ts'), '');
  write(path.join(dir, 'nested/d.test.js'), '');
  write(path.join(dir, 'nested/e.test.mjs'), '');
  write(path.join(dir, 'nested/f.spec.tsx'), '');
  write(path.join(dir, 'node_modules/pkg/hidden.spec.ts'), '');
  const found = discoverSpecs(dir, []);
  assert.match(found.method, /No Playwright config found/);
  assert.deepEqual(
    found.files.map((file) => path.relative(dir, file)).sort(),
    ['a.spec.ts', 'nested/b.spec.js', 'nested/c.test.ts', 'nested/d.test.js'].sort(),
  );
});

test('reads testDir and testMatch from the object passed to defineConfig', () => {
  const dir = makeProject();
  write(
    path.join(dir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\nexport default defineConfig({\n  testDir: './specs',\n  testMatch: '**/*.spec.ts',\n});\n",
  );
  write(path.join(dir, 'specs/login.spec.ts'), '');
  write(path.join(dir, 'specs/nested/cart.spec.ts'), '');
  write(path.join(dir, 'specs/login.test.js'), '');
  write(path.join(dir, 'other/nope.spec.ts'), '');
  write(path.join(dir, 'specs/node_modules/hidden.spec.ts'), '');
  const found = discoverSpecs(dir, []);
  assert.match(found.method, /Playwright config playwright\.config\.ts/);
  assert.match(found.method, /testDir '\.\/specs'/);
  assert.match(found.method, /testMatch '\*\*\/\*\.spec\.ts'/);
  assert.deepEqual(
    found.files.map((file) => path.relative(dir, file)).sort(),
    ['specs/login.spec.ts', 'specs/nested/cart.spec.ts'].sort(),
  );
});

test('reads a module.exports object and a regular expression testMatch', () => {
  const dir = makeProject();
  write(
    path.join(dir, 'playwright.config.js'),
    "module.exports = {\n  testDir: './specs',\n  testMatch: /login\\.spec\\.js/,\n};\n",
  );
  write(path.join(dir, 'specs/login.spec.js'), '');
  write(path.join(dir, 'specs/other.spec.js'), '');
  const found = discoverSpecs(dir, []);
  assert.match(found.method, /Playwright config playwright\.config\.js/);
  assert.deepEqual(found.files.map((file) => path.relative(dir, file)), ['specs/login.spec.js']);
});

test('uses the config directory and Playwright default testMatch when those fields are omitted', () => {
  const dir = makeProject();
  write(path.join(dir, 'playwright.config.ts'), 'export default {};\n');
  write(path.join(dir, 'a.spec.ts'), '');
  write(path.join(dir, 'nested/b.test.tsx'), '');
  write(path.join(dir, 'nested/c.spec.mjs'), '');
  write(path.join(dir, 'nested/d.e2e.ts'), '');
  const found = discoverSpecs(dir, []);
  assert.match(found.method, /testDir omitted, using the config directory/);
  assert.match(found.method, /using Playwright's default "\*\*\/\*\.@\(spec\|test\)\.\?\(c\|m\)\[jt\]s\?\(x\)"/);
  assert.deepEqual(
    found.files.map((file) => path.relative(dir, file)).sort(),
    ['a.spec.ts', 'nested/b.test.tsx', 'nested/c.spec.mjs'].sort(),
  );
});

test('falls back when the config is not a plain object literal', () => {
  const dir = makeProject();
  write(
    path.join(dir, 'playwright.config.ts'),
    "const testDir = './specs';\nexport default { testDir };\n",
  );
  write(path.join(dir, 'specs/login.spec.ts'), '');
  write(path.join(dir, 'also.test.js'), '');
  const found = discoverSpecs(dir, []);
  assert.match(found.method, /not a plain object literal/);
  assert.deepEqual(
    found.files.map((file) => path.relative(dir, file)).sort(),
    ['also.test.js', 'specs/login.spec.ts'].sort(),
  );
});

test('reads testDir from each plain project entry', () => {
  const dir = makeProject();
  write(
    path.join(dir, 'playwright.config.ts'),
    "export default {\n  projects: [\n    { name: 'a', testDir: './specs-a', testMatch: '**/*.spec.ts' },\n    { name: 'b', testDir: './specs-b', testMatch: '**/*.test.js' },\n  ],\n};\n",
  );
  write(path.join(dir, 'specs-a/login.spec.ts'), '');
  write(path.join(dir, 'specs-a/skip.test.js'), '');
  write(path.join(dir, 'specs-b/cart.test.js'), '');
  write(path.join(dir, 'specs-b/skip.spec.ts'), '');
  const found = discoverSpecs(dir, []);
  assert.match(found.method, /Playwright config playwright\.config\.ts/);
  assert.deepEqual(
    found.files.map((file) => path.relative(dir, file)).sort(),
    ['specs-a/login.spec.ts', 'specs-b/cart.test.js'].sort(),
  );
});

test('uses spec paths from the command line', () => {
  const dir = makeProject();
  write(path.join(dir, 'keep.spec.ts'), 'export {}\n');
  write(path.join(dir, 'skip.spec.ts'), 'export {}\n');
  const found = discoverSpecs(dir, ['keep.spec.ts'], dir);
  assert.equal(found.method, 'Discovery: spec paths from the command line.');
  assert.deepEqual(found.files.map((file) => path.relative(dir, file)), ['keep.spec.ts']);
});

test('fails when a spec path does not exist', () => {
  const dir = makeProject();
  assert.throws(() => discoverSpecs(dir, ['missing.spec.ts'], dir), /Spec path does not exist/);
});
