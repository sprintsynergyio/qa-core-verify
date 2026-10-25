import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildEvidence } from '../dist/runtime/locator-evidence/evidence.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schema/locator-evidence.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function sample() {
  const workspace = '/tmp/qcv-workspace-example';
  return buildEvidence({
    parts: [
      {
        selector: 'a\u0085b',
        api: "getByTestId('a\\u0085b')",
        url: 'https://www.saucedemo.com/?x=1',
        matchCount: 0,
        phase: 'assertion',
        call: 'toBeHidden',
        negated: false,
        actionSucceeded: false,
        parentCount: null,
        countExpected: 0,
        stack: `Error\n    at spec (${workspace}/tests/a.spec.ts:4:2)`,
        testFile: `${workspace}/tests/a.spec.ts`,
        testLine: 2,
        testTitle: 'hidden',
      },
    ],
    workspaceDir: workspace,
    projectDir: path.join(repoRoot, 'example-project/saucedemo'),
    tool: { name: 'qa-core-verify', version: '0.0.1' },
    playwrightVersion: '1.60.0',
    playwrightExitCode: 0,
  });
}

test('locator-evidence.json matches schema/locator-evidence.schema.json', () => {
  const evidence = sample();
  assert.equal(validate(evidence), true, ajv.errorsText(validate.errors));
  assert.equal(evidence.records[0].selector, 'a\\u0085b');
  const extra = { ...evidence, extra: true };
  assert.equal(validate(extra), false);
  const badCount = structuredClone(evidence);
  badCount.records[0].matchCount = -1;
  assert.equal(validate(badCount), false);
  const missing = structuredClone(evidence);
  delete missing.records[0].parentCount;
  assert.equal(validate(missing), false);
});
