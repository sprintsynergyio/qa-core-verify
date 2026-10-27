import fs from 'node:fs';
import path from 'node:path';
import { assertWorkspaceFile, configPathInCopy } from '../workspace.js';
import { isPlaywrightConfig, rewritePlaywrightImports } from '../locator-evidence/injected-fixture.js';
import { faultFixtureSource } from './fixture.js';

const FIXTURE_NAME = 'qcv-fault-fixture.ts';
const FIXTURE_ESM_NAME = 'qcv-fault-fixture.mjs';

/** Rewrite `@playwright/test` imports in the temp copy so one fault can wrap every page. */
export function installFaultFixture(workspaceDir: string, configFile?: string): void {
  const fixturePath = path.join(workspaceDir, FIXTURE_NAME);
  const esmPath = path.join(workspaceDir, FIXTURE_ESM_NAME);
  assertWorkspaceFile(workspaceDir, fixturePath);
  assertWorkspaceFile(workspaceDir, esmPath);
  const source = faultFixtureSource();
  fs.writeFileSync(fixturePath, source);
  fs.writeFileSync(esmPath, source);
  rewriteProjectImports(workspaceDir, fixturePath, configFile);
}

function rewriteProjectImports(workspaceDir: string, fixturePath: string, configFile?: string): void {
  const custom = configFile ? configPathInCopy(workspaceDir, configFile) : undefined;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.qa-core' || entry.name === 'test-results') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (isPlaywrightConfig(entry.name)) continue;
      if (custom && path.resolve(full) === custom) continue;
      if (full === fixturePath || path.basename(full) === FIXTURE_ESM_NAME) continue;
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|cts|mts)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const next = rewritePlaywrightImports(text, specifierFor(full, fixturePath));
      if (next !== text) {
        assertWorkspaceFile(workspaceDir, full);
        fs.writeFileSync(full, next);
      }
    }
  };
  walk(workspaceDir);
}

function specifierFor(fromFile: string, fixturePath: string): string {
  const extension = path.extname(fromFile).toLowerCase();
  const esm = extension === '.mjs' || extension === '.mts';
  const target = esm ? path.join(path.dirname(fixturePath), FIXTURE_ESM_NAME) : fixturePath;
  let relative = path.relative(path.dirname(fromFile), target).split(path.sep).join('/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  if (!esm) relative = relative.replace(/\.ts$/, '.js');
  return relative;
}
