import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../../tool-error.js';

export const FAULT_FILE_NAME = 'qa-core-verify.faults.json';

export const FAULT_TYPES = [
  'blank-app',
  'remove-element',
  'hide-element',
  'change-text',
  'block-request',
  'user-swap',
] as const;

export type FaultType = (typeof FAULT_TYPES)[number];

export type FaultResultName = 'pass' | 'fail' | 'skipped' | 'not-run';

export interface Fault {
  id: string;
  type: FaultType;
  params: FaultParams;
  /** JavaScript regular expressions matched against the title path and the test title. */
  expectedToBreak: string[];
}

export type FaultParams =
  | Record<string, never>
  | { selector: string }
  | { selector: string; text: string }
  | { urlPattern: string }
  | { env: Record<string, string> };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Built in. Every suite runs this fault, including a suite with no fault file. */
export function blankAppFault(): Fault {
  return { id: 'blank-app', type: 'blank-app', params: {}, expectedToBreak: [] };
}

/**
 * Read `qa-core-verify.faults.json` from the project root.
 * A missing file is the built-in blank-app fault and nothing else.
 * A file that omits blank-app still runs the built-in fault first.
 */
export function loadFaultFile(projectDir: string): Fault[] {
  const file = path.join(projectDir, FAULT_FILE_NAME);
  if (!fs.existsSync(file)) return [blankAppFault()];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Cannot read ${FAULT_FILE_NAME}: ${message}`);
  }
  const faults = validateFaultFile(parsed);
  const claimed = faults.find((fault) => fault.id === 'blank-app' && fault.type !== 'blank-app');
  if (claimed) {
    throw new ToolError(`${FAULT_FILE_NAME} uses the id "blank-app" for a fault that is not type blank-app.`);
  }
  if (!faults.some((fault) => fault.type === 'blank-app')) return [blankAppFault(), ...faults];
  const blank = faults.filter((fault) => fault.type === 'blank-app');
  const rest = faults.filter((fault) => fault.type !== 'blank-app');
  return [...blank, ...rest];
}

export function validateFaultFile(value: unknown): Fault[] {
  if (!Array.isArray(value)) throw new ToolError(`${FAULT_FILE_NAME} must be a JSON array.`);
  const faults: Fault[] = [];
  const seen = new Set<string>();
  for (const entry of value) faults.push(validateFault(entry, seen));
  const blanks = faults.filter((fault) => fault.type === 'blank-app');
  if (blanks.length > 1) throw new ToolError(`${FAULT_FILE_NAME} has more than one blank-app fault.`);
  return faults;
}

export function validateFault(value: unknown, seen: Set<string>): Fault {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolError(`${FAULT_FILE_NAME} entries must be JSON objects.`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const allowed = ['expectedToBreak', 'id', 'params', 'type'];
  for (const key of keys) {
    if (!allowed.includes(key)) throw new ToolError(`${FAULT_FILE_NAME} entry has an unknown field "${key}".`);
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ToolError(`${FAULT_FILE_NAME} entry is missing ${key}.`);
    }
  }
  const id = record.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new ToolError(`${FAULT_FILE_NAME} fault id must be letters, digits, ".", "_", or "-".`);
  }
  if (seen.has(id)) throw new ToolError(`${FAULT_FILE_NAME} repeats fault id "${id}".`);
  seen.add(id);
  const type = record.type;
  if (typeof type !== 'string' || !isFaultType(type)) {
    throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" has an unknown type.`);
  }
  const params = validateParams(id, type, record.params);
  const expectedToBreak = validatePatterns(id, record.expectedToBreak);
  return { id, type, params, expectedToBreak };
}

export function titleMatches(pattern: string, titlePath: readonly string[]): boolean {
  const expression = new RegExp(pattern);
  const full = titlePath.join(' > ');
  if (expression.test(full)) return true;
  const title = titlePath[titlePath.length - 1] ?? '';
  return title !== full && expression.test(title);
}

function validatePatterns(id: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" expectedToBreak must be an array.`);
  }
  const patterns: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" has an empty expectedToBreak pattern.`);
    }
    try {
      void new RegExp(entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" has a bad expectedToBreak pattern: ${message}`);
    }
    patterns.push(entry);
  }
  return patterns;
}

function validateParams(id: string, type: FaultType, value: unknown): FaultParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" params must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (type === 'blank-app') {
    if (Object.keys(record).length > 0) {
      throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" blank-app params must be empty.`);
    }
    return {};
  }
  if (type === 'remove-element' || type === 'hide-element') {
    return { selector: requireString(id, record, 'selector', ['selector']) };
  }
  if (type === 'change-text') {
    const selector = requireString(id, record, 'selector', ['selector', 'text']);
    const text = requireString(id, record, 'text', ['selector', 'text'], true);
    return { selector, text };
  }
  if (type === 'block-request') {
    return { urlPattern: requireString(id, record, 'urlPattern', ['urlPattern']) };
  }
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'env') {
    throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" user-swap params must be { env }.`);
  }
  const env = record.env;
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" env must be an object.`);
  }
  const vars: Record<string, string> = {};
  for (const [name, entry] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" has a bad env name "${name}".`);
    if (typeof entry !== 'string') throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" env ${name} must be a string.`);
    vars[name] = entry;
  }
  if (Object.keys(vars).length === 0) {
    throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" env must set at least one variable.`);
  }
  return { env: vars };
}

function requireString(
  id: string,
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  allowEmpty = false,
): string {
  for (const name of Object.keys(record)) {
    if (!allowed.includes(name)) {
      throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" has an unknown param "${name}".`);
    }
  }
  for (const name of allowed) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" is missing param ${name}.`);
    }
  }
  const value = record[key];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new ToolError(`${FAULT_FILE_NAME} fault "${id}" param ${key} must be a string.`);
  }
  return value;
}

function isFaultType(value: string): value is FaultType {
  return (FAULT_TYPES as readonly string[]).includes(value);
}
