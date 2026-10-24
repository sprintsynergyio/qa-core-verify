import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from './tool-error.js';

export const CONFIG_FILE_NAME = 'qa-core-verify.config.json';

export interface VerifyConfig {
  assertFunctionNames: string[];
  assertFunctionPatterns: string[];
}

const KNOWN_KEYS = new Set(['assertFunctionNames', 'assertFunctionPatterns']);

export function emptyConfig(): VerifyConfig {
  return { assertFunctionNames: [], assertFunctionPatterns: [] };
}

/**
 * Load the optional config from the project directory.
 * A missing file means no custom assertion helpers.
 */
export function loadVerifyConfig(projectDir: string): VerifyConfig {
  const file = path.join(projectDir, CONFIG_FILE_NAME);
  if (!fs.existsSync(file)) return emptyConfig();

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Cannot parse ${file}: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ToolError(`${file} must contain a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new ToolError(`Unknown key "${key}" in ${file}.`);
    }
  }

  const assertFunctionNames = readStringArray(record['assertFunctionNames'], 'assertFunctionNames', file);
  const assertFunctionPatterns = readStringArray(record['assertFunctionPatterns'], 'assertFunctionPatterns', file);
  for (const pattern of assertFunctionPatterns) {
    try {
      new RegExp(pattern);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Invalid assertFunctionPatterns entry "${pattern}" in ${file}: ${message}`);
    }
  }

  return { assertFunctionNames, assertFunctionPatterns };
}

export function matchesAssertionHelper(name: string, config: VerifyConfig): boolean {
  const trailing = trailingName(name);
  const candidates = trailing === name ? [name] : [name, trailing];
  if (candidates.some((candidate) => config.assertFunctionNames.includes(candidate))) return true;
  return config.assertFunctionPatterns.some((pattern) => {
    const expression = new RegExp(pattern);
    return candidates.some((candidate) => expression.test(candidate));
  });
}

function trailingName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

function readStringArray(value: unknown, key: string, file: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ToolError(`${key} in ${file} must be an array of strings.`);
  }
  return value;
}
