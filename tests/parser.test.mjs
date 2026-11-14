import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyConfig } from '../dist/config.js';
import { parseSpecFile } from '../dist/inventory/parse.js';
import { byTitle, lineAndColumn } from './support.mjs';

const parserDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/parser');
const config = emptyConfig();

test('records nested describe title paths', () => {
  const file = path.join(parserDir, 'nested.spec.ts');
  const inventory = parseSpecFile(file, config);
  const leaf = byTitle(inventory, 'leaf');
  assert.deepEqual(leaf.titlePath, ['outer', 'inner', 'leaf']);
  const parallel = byTitle(inventory, 'inside parallel');
  assert.deepEqual(parallel.titlePath, ['parallel suite', 'inside parallel']);
  assert.deepEqual(parallel.modifiers, []);
  assert.equal(inventory.tests.length, 2);
});

test('records only, skip, and fixme modifiers, including describe modifiers', () => {
  const file = path.join(parserDir, 'modifiers.spec.ts');
  const inventory = parseSpecFile(file, config);
  assert.deepEqual(byTitle(inventory, 'focused without assertion').modifiers, ['only']);
  assert.deepEqual(byTitle(inventory, 'skipped without assertion').modifiers, ['skip']);
  assert.deepEqual(byTitle(inventory, 'fixme without assertion').modifiers, ['fixme']);
  assert.deepEqual(byTitle(inventory, 'inside skipped describe').modifiers, ['skip']);
  assert.deepEqual(byTitle(inventory, 'inside fixme describe').modifiers, ['fixme']);
  assert.deepEqual(byTitle(inventory, 'plain with assertion').modifiers, []);
});

test('uses the test call line and column', () => {
  const file = path.join(parserDir, 'modifiers.spec.ts');
  const inventory = parseSpecFile(file, config);
  const focused = byTitle(inventory, 'focused without assertion');
  const expected = lineAndColumn(file, 'test.only(\'focused without assertion\'');
  assert.equal(focused.line, expected.line);
  assert.equal(focused.column, expected.column);
  assert.equal(focused.file, path.resolve(file));
});

test('reads expect metadata for not, soft, poll, and await', () => {
  const file = path.join(parserDir, 'expects.spec.ts');
  const found = byTitle(parseSpecFile(file, config), 'expect metadata');
  assert.deepEqual(
    found.expects.map((call) => ({
      matcher: call.matcher,
      not: call.not,
      soft: call.soft,
      poll: call.poll,
      awaited: call.awaited,
      subjectSource: call.subjectSource,
    })),
    [
      {
        matcher: 'toBeVisible',
        not: false,
        soft: false,
        poll: false,
        awaited: true,
        subjectSource: 'page.getByTestId(\'title\')',
      },
      {
        matcher: 'toBeHidden',
        not: true,
        soft: false,
        poll: false,
        awaited: false,
        subjectSource: 'page.getByText(\'Hello\')',
      },
      {
        matcher: 'toHaveURL',
        not: false,
        soft: true,
        poll: false,
        awaited: true,
        subjectSource: 'page',
      },
      {
        matcher: 'toBeDisabled',
        not: true,
        soft: true,
        poll: false,
        awaited: true,
        subjectSource: 'page.getByRole(\'button\')',
      },
      {
        matcher: 'toBe',
        not: false,
        soft: false,
        poll: true,
        awaited: true,
        subjectSource: 'async () => page.getByTestId(\'count\').textContent()',
      },
    ],
  );
  const first = found.expects[0];
  const expected = lineAndColumn(file, 'expect(page.getByTestId(\'title\')).toBeVisible()');
  assert.equal(first.line, expected.line);
  assert.equal(first.column, expected.column);
});

test('records locator factories and chains, including a locator saved in a const', () => {
  const file = path.join(parserDir, 'locators.spec.ts');
  const found = byTitle(parseSpecFile(file, config), 'locator chains');
  const sources = found.locators.map((locator) => locator.source);
  assert.ok(sources.includes('page.locator(\'.inventory_list\')'));
  assert.ok(sources.includes('page.locator(\'.inventory_list\').locator(\'.inventory_item\')'));
  assert.ok(
    sources.includes('page.locator(\'.inventory_list\').locator(\'.inventory_item\').filter({ hasText: \'Bike\' })'),
  );
  assert.ok(
    sources.includes(
      'page.locator(\'.inventory_list\').locator(\'.inventory_item\').filter({ hasText: \'Bike\' }).first()',
    ),
  );
  assert.ok(sources.includes('page.getByRole(\'listitem\')'));
  assert.ok(sources.includes('page.getByRole(\'listitem\').nth(0)'));
  assert.ok(sources.includes('page.getByRole(\'listitem\').last()'));
  assert.equal(sources.some((source) => source.includes('.click(')), false);
});

test('parses arrow and function bodies in TypeScript and JavaScript', () => {
  const tsFile = path.join(parserDir, 'bodies.spec.ts');
  const tsInventory = parseSpecFile(tsFile, config);
  assert.equal(byTitle(tsInventory, 'arrow body').expects[0].matcher, 'toHaveURL');
  assert.equal(byTitle(tsInventory, 'function body').expects[0].matcher, 'toHaveURL');

  const jsFile = path.join(parserDir, 'plain.spec.js');
  const jsInventory = parseSpecFile(jsFile, config);
  const arrow = byTitle(jsInventory, 'js arrow');
  assert.deepEqual(arrow.titlePath, ['js suite', 'js arrow']);
  assert.equal(arrow.expects[0].matcher, 'toHaveTitle');
  assert.equal(arrow.expects[0].awaited, true);
  const fn = byTitle(jsInventory, 'js function');
  assert.equal(fn.expects[0].matcher, 'toBeVisible');
  assert.equal(fn.expects[0].awaited, false);
  assert.equal(fn.expects[0].subjectSource, 'page.locator(\'#login\')');
});

test('follows renamed imports, namespace imports, default imports, and require', () => {
  const aliases = parseSpecFile(path.join(parserDir, 'aliases.spec.ts'), config);
  const alias = byTitle(aliases, 'alias test');
  assert.deepEqual(alias.titlePath, ['alias suite', 'alias test']);
  assert.equal(alias.expects.length, 2);
  assert.equal(alias.expects[0].matcher, 'toHaveURL');
  assert.equal(alias.expects[1].soft, true);
  assert.equal(alias.expects[1].matcher, 'toBeVisible');
  const namespace = byTitle(aliases, 'namespace test');
  assert.equal(namespace.expects[0].matcher, 'toBeVisible');
  assert.equal(namespace.expects[0].subjectSource, 'page.locator(\'#login\')');

  const imported = byTitle(parseSpecFile(path.join(parserDir, 'default-import.spec.ts'), config), 'default import');
  assert.equal(imported.expects[0].matcher, 'toBe');
  assert.equal(imported.expects[0].awaited, true);

  const required = parseSpecFile(path.join(parserDir, 'require-call.spec.js'), config);
  assert.equal(byTitle(required, 'require default call').expects[0].matcher, 'toBe');
  assert.deepEqual(byTitle(required, 'require skip').modifiers, ['skip']);
});

test('counts expect inside test.step as part of the test', () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/w001/good.spec.ts');
  const inventory = parseSpecFile(file, config);
  const step = byTitle(inventory, 'expect inside a step');
  assert.equal(step.expects.length, 1);
  assert.equal(step.expects[0].matcher, 'toHaveTitle');
  assert.equal(inventory.tests.some((entry) => entry.title === 'check title'), false);
});

test('does not treat a hook expect as the test assertion', () => {
  const inventory = parseSpecFile(path.join(parserDir, 'hooks.spec.ts'), config);
  assert.equal(inventory.tests.length, 1);
  assert.equal(byTitle(inventory, 'after hook only').expects.length, 0);
});

test('reads test and expect imported from a relative fixture without loading it', () => {
  const file = path.join(parserDir, 'relative-import.spec.ts');
  assert.equal(fs.existsSync(path.join(parserDir, 'local-fixtures.ts')), false);
  const inventory = parseSpecFile(file, config);
  const good = byTitle(inventory, 'relative good');
  assert.deepEqual(good.titlePath, ['relative', 'relative good']);
  assert.equal(good.expects[0].matcher, 'toHaveTitle');
  assert.equal(byTitle(inventory, 'relative bad').expects.length, 0);
});

test('does not treat an unbound test function as a Playwright test', () => {
  const inventory = parseSpecFile(path.join(parserDir, 'not-playwright.spec.ts'), config);
  assert.equal(inventory.tests.length, 0);
});

test('a namespace import from chai is not a Playwright test', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-chai-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chai.spec.ts');
  fs.writeFileSync(
    file,
    `import * as chai from 'chai';
import * as nodeFs from 'node:fs';
import { test, expect } from '@playwright/test';
chai.test('not a row', () => {});
nodeFs.test('not a node row', () => {});
test('real', () => { expect(1).toBe(1); });
`,
  );
  const inventory = parseSpecFile(file, config);
  assert.deepEqual(inventory.tests.map((entry) => entry.title), ['real']);
});

test('an anonymous describe.skip prints a placeholder title', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcv-anon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'skip.spec.ts');
  fs.writeFileSync(
    file,
    `import { test } from '@playwright/test';
test.describe.skip(() => {
  test('inside', () => {});
});
`,
  );
  const inventory = parseSpecFile(file, config);
  assert.deepEqual(inventory.skippedDescribes[0].titlePath, ['(anonymous describe)']);
});

test('does not execute spec source', () => {
  const inventory = parseSpecFile(path.join(parserDir, 'side-effect.spec.ts'), config);
  assert.equal(byTitle(inventory, 'parsed without running').title, 'parsed without running');
});

test('reports a syntax error instead of executing the file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-verify-parse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'broken.spec.ts');
  fs.writeFileSync(file, "import { test } from '@playwright/test';\ntest('broken', async () => { const = ; });\n");
  assert.throws(() => parseSpecFile(file, config), /Parse error/);
});

test('binds test created with extend, including a chained extend', () => {
  const inventory = parseSpecFile(path.join(parserDir, 'extend.spec.ts'), config);
  assert.deepEqual(
    inventory.tests.map((entry) => entry.title),
    ['uses extended test', 'chained extend without assertion'],
  );
  assert.equal(byTitle(inventory, 'uses extended test').expects[0].matcher, 'toHaveURL');
  assert.equal(byTitle(inventory, 'chained extend without assertion').expects.length, 0);
});

test('treats condition, boolean, and no-arg skip, fail, fixme, and slow as annotations', () => {
  const inventory = parseSpecFile(path.join(parserDir, 'annotations.spec.ts'), config);
  assert.deepEqual(
    inventory.tests.map((entry) => ({ title: entry.title, modifiers: entry.modifiers })),
    [
      { title: 'skipped declaration', modifiers: ['skip'] },
      { title: 'expected fail', modifiers: [] },
      { title: 'failing and empty', modifiers: [] },
      { title: 'real test', modifiers: [] },
      { title: 'skips inside the body', modifiers: [] },
    ],
  );
  assert.equal(byTitle(inventory, 'expected fail').expects[0].matcher, 'toHaveTitle');
  assert.equal(byTitle(inventory, 'failing and empty').expects.length, 0);
  assert.equal(byTitle(inventory, 'skips inside the body').expects.length, 0);
  const titles = inventory.tests.map((entry) => entry.title);
  assert.equal(titles.includes('boolean skip'), false);
  assert.equal(titles.includes('not today'), false);
});

test('does not inventory tests inside hooks or timer callbacks', () => {
  const inventory = parseSpecFile(path.join(parserDir, 'callbacks.spec.ts'), config);
  assert.deepEqual(
    inventory.tests.map((entry) => entry.title),
    ['kept ${name}', 'mapped ${name}', 'describe for each ${name}', 'real empty'],
  );
  assert.deepEqual(byTitle(inventory, 'describe for each ${name}').titlePath, [
    'wrapped',
    'describe for each ${name}',
  ]);
  assert.equal(byTitle(inventory, 'kept ${name}').expects[0].matcher, 'toHaveURL');
  assert.equal(byTitle(inventory, 'mapped ${name}').expects.length, 0);
  assert.equal(inventory.tests.some((entry) => entry.title.startsWith('inside')), false);
  assert.equal(inventory.tests.some((entry) => entry.title.startsWith('timer')), false);
  assert.equal(inventory.tests.some((entry) => entry.title.startsWith('hook inside')), false);
});

test('finds tests created inside forEach and map, and strips template backticks', () => {
  const inventory = parseSpecFile(path.join(parserDir, 'generated.spec.ts'), config);
  assert.deepEqual(
    inventory.tests.map((entry) => entry.title),
    ['for each ${name}', 'mapped ${name}', 'plain template'],
  );
  assert.deepEqual(byTitle(inventory, 'for each ${name}').titlePath, ['generated', 'for each ${name}']);
  assert.equal(byTitle(inventory, 'for each ${name}').expects[0].matcher, 'toHaveURL');
  assert.equal(byTitle(inventory, 'mapped ${name}').expects.length, 0);
  assert.equal(inventory.tests.some((entry) => entry.title.includes('`')), false);
  assert.equal(inventory.tests.some((entry) => entry.title === 'inside a function declaration'), false);
});

test('accepts inline expect.configure and an expect.configure alias', () => {
  const inventory = parseSpecFile(path.join(parserDir, 'configure.spec.ts'), config);
  const inline = byTitle(inventory, 'inline configure').expects[0];
  assert.equal(inline.matcher, 'toHaveURL');
  assert.equal(inline.subjectSource, 'page');
  assert.equal(inline.awaited, true);
  assert.equal(inline.not, false);
  assert.equal(inline.soft, false);
  assert.equal(inline.poll, false);
  const alias = byTitle(inventory, 'aliased configure').expects[0];
  assert.equal(alias.matcher, 'toBeVisible');
  assert.equal(alias.subjectSource, 'page');
  assert.equal(alias.awaited, true);
  assert.equal(byTitle(inventory, 'still empty').expects.length, 0);
});
