import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ToolError } from '../tool-error.js';

/** Used when the project has no readable Playwright config object. */
export const DEFAULT_SPEC_GLOBS = ['**/*.spec.ts', '**/*.spec.js', '**/*.test.ts', '**/*.test.js'];

/**
 * Playwright 1.60.0 looks for these names, in this order
 * (playwright/lib/common/index.js, resolveConfigFile2).
 */
const CONFIG_EXTENSIONS = ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs'];

/**
 * Playwright 1.60.0 default testMatch when the config omits it
 * (playwright/lib/common/index.js, FullProjectInternal).
 */
const PLAYWRIGHT_DEFAULT_TEST_MATCH = '**/*.@(spec|test).?(c|m)[jt]s?(x)';

/**
 * Extensions Playwright keeps after testMatch
 * (playwright/lib/runner/index.js, collectFilesForProject).
 */
const PLAYWRIGHT_TEST_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.mjs',
  '.mts',
  '.cjs',
  '.cts',
  '.jsx',
  '.tsx',
  '.mjsx',
  '.mtsx',
  '.cjsx',
  '.ctsx',
]);

export interface Discovery {
  files: string[];
  method: string;
}

interface MatchPattern {
  kind: 'glob' | 'regex';
  source: string;
  flags: string;
}

interface ScanTarget {
  testDir: string;
  testMatch: MatchPattern[];
  testIgnore: MatchPattern[];
  testDirLabel: string;
  testMatchLabel: string;
  testIgnoreLabel?: string;
}

/**
 * Find spec files for a project directory.
 * Spec arguments, when present, replace config discovery.
 * Otherwise read testDir and testMatch from a plain object literal in the
 * Playwright config (including the object passed to defineConfig).
 * Anything else falls back to the default globs, excluding node_modules.
 */
export function discoverSpecs(
  projectDir: string,
  specArgs: readonly string[],
  cwd = process.cwd(),
  configFile?: string,
): Discovery {
  if (specArgs.length > 0) {
    return {
      files: resolveSpecArgs(projectDir, specArgs, cwd),
      method: 'Discovery: spec paths from the command line.',
    };
  }

  if (configFile) {
    configFile = resolvePlaywrightConfigFile(configFile);
  } else {
    configFile = findPlaywrightConfig(projectDir);
  }
  if (!configFile) {
    return {
      files: collectByGlobs(projectDir, DEFAULT_SPEC_GLOBS),
      method: `Discovery: default globs ${DEFAULT_SPEC_GLOBS.join(', ')}. No Playwright config found.`,
    };
  }

  const configName = path.basename(configFile);
  const read = readPlaywrightConfig(configFile);
  if (read.kind === 'fallback') {
    return {
      files: collectByGlobs(projectDir, DEFAULT_SPEC_GLOBS),
      method: `Discovery: default globs ${DEFAULT_SPEC_GLOBS.join(', ')}. ${read.reason}`,
    };
  }

  const files = new Set<string>();
  for (const target of read.targets) {
    if (!fs.existsSync(target.testDir) || !fs.statSync(target.testDir).isDirectory()) continue;
    for (const file of walkFiles(target.testDir)) {
      if (!PLAYWRIGHT_TEST_EXTENSIONS.has(path.extname(file))) continue;
      if (!matchesTestMatch(file, target.testMatch)) continue;
      if (target.testIgnore.length > 0 && matchesTestMatch(file, target.testIgnore)) continue;
      files.add(file);
    }
  }
  const labels = read.targets.map((target) => `testDir ${target.testDirLabel}, testMatch ${target.testMatchLabel}`);
  const ignoreLabels = [...new Set(read.targets.map((target) => target.testIgnoreLabel).filter((label) => label !== undefined))];
  const ignoreParts = [...ignoreLabels];
  if (read.ignoreNote) ignoreParts.push(read.ignoreNote);
  const ignoreNote = ignoreParts.length > 0 ? ` testIgnore ${ignoreParts.join('; ')}.` : '';
  return {
    files: [...files].sort(comparePaths),
    method: `Discovery: Playwright config ${configName}. ${labels.join('; ')}.${ignoreNote}`,
  };
}

export function findPlaywrightConfig(projectDir: string): string | undefined {
  for (const extension of CONFIG_EXTENSIONS) {
    const candidate = path.join(projectDir, `playwright.config${extension}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Playwright's `resolveConfigFile2`: a file is used as given, and a directory
 * is the first `playwright.config.*` inside it. A missing path is refused here,
 * before any temp copy, when callers resolve `--config` up front.
 */
export function resolvePlaywrightConfigFile(configPath: string): string {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new ToolError(`Playwright config does not exist: ${resolved}`);
  }
  if (fs.statSync(resolved).isDirectory()) {
    const found = findPlaywrightConfig(resolved);
    if (!found) throw new ToolError(`Playwright config does not exist: ${resolved}`);
    return found;
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new ToolError(`Playwright config does not exist: ${resolved}`);
  }
  return resolved;
}

function resolveSpecArgs(projectDir: string, specArgs: readonly string[], cwd: string): string[] {
  const files: string[] = [];
  for (const arg of specArgs) {
    if (isGlob(arg)) {
      let expression: RegExp;
      try {
        expression = globToRegExp(arg);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolError(`Cannot read spec glob ${arg}: ${message}`);
      }
      const matches = walkFiles(projectDir).filter((file) => {
        const fromCwd = toPosix(path.relative(cwd, file));
        const fromProject = toPosix(path.relative(projectDir, file));
        return expression.test(fromCwd) || expression.test(fromProject) || expression.test(toPosix(file));
      });
      if (matches.length === 0) throw new ToolError(`No spec files matched ${arg}.`);
      files.push(...matches);
      continue;
    }

    const resolved = resolveExistingFile(projectDir, arg, cwd);
    if (!resolved) throw new ToolError(`Spec path does not exist: ${arg}.`);
    files.push(resolved);
  }
  return [...new Set(files)].sort(comparePaths);
}

function resolveExistingFile(projectDir: string, arg: string, cwd: string): string | undefined {
  const candidates = path.isAbsolute(arg) ? [arg] : [path.resolve(cwd, arg), path.resolve(projectDir, arg)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  if (candidates.some((candidate) => fs.existsSync(candidate))) {
    throw new ToolError(`Spec path is not a file: ${arg}.`);
  }
  return undefined;
}

function isGlob(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('[') || value.includes('{');
}

function collectByGlobs(root: string, globs: readonly string[]): string[] {
  const matchers = globs.map((pattern) => globToRegExp(pattern));
  const files: string[] = [];
  for (const file of walkFiles(root)) {
    const relative = toPosix(path.relative(root, file));
    if (matchers.some((matcher) => matcher.test(relative))) files.push(file);
  }
  return files.sort(comparePaths);
}

function matchesTestMatch(file: string, patterns: readonly MatchPattern[]): boolean {
  const posix = toPosix(file);
  for (const pattern of patterns) {
    if (pattern.kind === 'regex') {
      const expression = new RegExp(pattern.source, pattern.flags);
      if (expression.test(file) || expression.test(posix)) return true;
      continue;
    }
    const source = pattern.source.startsWith('**/') ? pattern.source : `**/${pattern.source}`;
    if (globToRegExp(source).test(posix)) return true;
  }
  return false;
}

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

type ConfigRead = { kind: 'ok'; targets: ScanTarget[]; ignoreNote?: string } | { kind: 'fallback'; reason: string };

function readPlaywrightConfig(configFile: string): ConfigRead {
  const name = path.basename(configFile);
  const text = fs.readFileSync(configFile, 'utf8');
  const sourceFile = ts.createSourceFile(configFile, text, ts.ScriptTarget.ES2022, true, scriptKindFor(configFile));
  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  const first = diagnostics?.[0];
  if (first) {
    const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
    throw new ToolError(`Parse error in ${configFile}: ${message}`);
  }

  const object = findConfigObject(sourceFile);
  if (object === 'missing') {
    return { kind: 'fallback', reason: `Playwright config ${name} has no default object literal.` };
  }
  if (object === 'not-literal') {
    return { kind: 'fallback', reason: `Playwright config ${name} is not a plain object literal.` };
  }

  const notes: { ignore?: string } = {};
  const targets = readTargets(object, path.dirname(configFile), notes);
  if (targets === 'unreadable') {
    return { kind: 'fallback', reason: `Playwright config ${name} is not a plain object literal.` };
  }
  if (typeof targets === 'string') {
    return { kind: 'fallback', reason: `Playwright config ${name} testMatch pattern is not supported yet: ${targets}.` };
  }
  return { kind: 'ok', targets, ignoreNote: notes.ignore };
}

function readTargets(
  object: ts.ObjectLiteralExpression,
  configDir: string,
  notes: { ignore?: string },
): ScanTarget[] | 'unreadable' | string {
  if (hasSpread(object)) return 'unreadable';
  const testDir = readStringProperty(object, 'testDir');
  const testMatch = readMatchProperty(object, 'testMatch');
  const projects = readProjectsProperty(object);
  const rootIgnore = readIgnore(object, notes);
  if (testDir === 'unreadable' || testMatch === 'unreadable' || projects === 'unreadable') return 'unreadable';
  if (typeof testMatch === 'string' && testMatch !== 'missing') return testMatch;

  const rootDir =
    testDir === 'missing'
      ? { directory: configDir, label: 'omitted, using the config directory' }
      : { directory: path.resolve(configDir, testDir.value), label: testDir.label };
  const rootMatch = testMatch === 'missing' ? defaultTestMatch() : testMatch;

  if (projects === 'missing') {
    return [
      {
        testDir: rootDir.directory,
        testMatch: rootMatch.patterns,
        testIgnore: rootIgnore.patterns,
        testDirLabel: rootDir.label,
        testMatchLabel: rootMatch.label,
        testIgnoreLabel: rootIgnore.label,
      },
    ];
  }

  const targets: ScanTarget[] = [];
  for (const project of projects) {
    if (hasSpread(project)) return 'unreadable';
    const projectDir = readStringProperty(project, 'testDir');
    const projectMatch = readMatchProperty(project, 'testMatch');
    const projectIgnore = readIgnore(project, notes);
    if (projectDir === 'unreadable' || projectMatch === 'unreadable') return 'unreadable';
    if (typeof projectMatch === 'string' && projectMatch !== 'missing') return projectMatch;
    const dir =
      projectDir === 'missing'
        ? rootDir
        : { directory: path.resolve(configDir, projectDir.value), label: projectDir.label };
    const match = projectMatch === 'missing' ? rootMatch : projectMatch;
    const ignore = projectIgnore.present ? projectIgnore : rootIgnore;
    targets.push({
      testDir: dir.directory,
      testMatch: match.patterns,
      testIgnore: ignore.patterns,
      testDirLabel: dir.label,
      testMatchLabel: match.label,
      testIgnoreLabel: ignore.label,
    });
  }
  return targets;
}

function defaultTestMatch(): { patterns: MatchPattern[]; label: string } {
  return {
    patterns: [{ kind: 'glob', source: PLAYWRIGHT_DEFAULT_TEST_MATCH, flags: '' }],
    label: `omitted, using Playwright's default "${PLAYWRIGHT_DEFAULT_TEST_MATCH}"`,
  };
}

function findConfigObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | 'missing' | 'not-literal' {
  let found: ts.ObjectLiteralExpression | 'missing' | 'not-literal' = 'missing';
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) found = asConfigObject(statement.expression);
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
    const binary = statement.expression;
    if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !isModuleExports(binary.left)) continue;
    found = asConfigObject(binary.right);
  }
  return found;
}

function asConfigObject(expr: ts.Expression): ts.ObjectLiteralExpression | 'not-literal' {
  const unwrapped = unwrap(expr);
  if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;
  if (ts.isCallExpression(unwrapped) && unwrapped.arguments.length === 1) {
    const arg = unwrapped.arguments[0];
    if (arg && ts.isObjectLiteralExpression(unwrap(arg))) return unwrap(arg) as ts.ObjectLiteralExpression;
  }
  return 'not-literal';
}

function isModuleExports(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'module' &&
    expr.name.text === 'exports'
  );
}

function hasSpread(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some((property) => ts.isSpreadAssignment(property));
}

function readStringProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): { value: string; label: string } | 'missing' | 'unreadable' {
  const initializer = propertyInitializer(object, name);
  if (initializer === 'missing' || initializer === 'unreadable') return initializer;
  const value = literalString(initializer);
  if (value === undefined) return 'unreadable';
  return { value, label: initializer.getText() };
}

function readMatchProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): { patterns: MatchPattern[]; label: string } | 'missing' | 'unreadable' | string {
  const initializer = propertyInitializer(object, name);
  if (initializer === 'missing' || initializer === 'unreadable') return initializer;
  const patterns = matchPatterns(initializer);
  if (typeof patterns === 'string') return patterns;
  if (!patterns) return 'unreadable';
  return { patterns, label: initializer.getText() };
}

function readIgnore(
  object: ts.ObjectLiteralExpression,
  notes: { ignore?: string },
): { patterns: MatchPattern[]; label?: string; present: boolean } {
  const initializer = propertyInitializer(object, 'testIgnore');
  if (initializer === 'missing') return { patterns: [], present: false };
  if (initializer === 'unreadable') {
    notes.ignore = 'was not applied';
    return { patterns: [], present: true };
  }
  const patterns = matchPatterns(initializer);
  if (typeof patterns === 'string' || !patterns) {
    notes.ignore = 'was not applied';
    return { patterns: [], present: true };
  }
  return { patterns, label: initializer.getText(), present: true };
}

function readProjectsProperty(object: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression[] | 'missing' | 'unreadable' {
  const initializer = propertyInitializer(object, 'projects');
  if (initializer === 'missing' || initializer === 'unreadable') return initializer;
  if (!ts.isArrayLiteralExpression(initializer)) return 'unreadable';
  const projects: ts.ObjectLiteralExpression[] = [];
  for (const element of initializer.elements) {
    const unwrapped = unwrap(element);
    if (!ts.isObjectLiteralExpression(unwrapped)) return 'unreadable';
    projects.push(unwrapped);
  }
  return projects;
}

function propertyInitializer(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | 'missing' | 'unreadable' {
  let found: ts.Expression | 'missing' | 'unreadable' = 'missing';
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) return 'unreadable';
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return 'unreadable';
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyName(property.name) !== name) continue;
    found = unwrap(property.initializer);
  }
  return found;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

function literalString(expr: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return undefined;
}

function matchPatterns(expr: ts.Expression): MatchPattern[] | string | undefined {
  if (ts.isArrayLiteralExpression(expr)) {
    const patterns: MatchPattern[] = [];
    for (const element of expr.elements) {
      const one = onePattern(unwrap(element));
      if (typeof one === 'string') return one;
      if (!one) return undefined;
      patterns.push(one);
    }
    return patterns;
  }
  const one = onePattern(expr);
  if (typeof one === 'string' || one === undefined) return one;
  return [one];
}

function onePattern(expr: ts.Expression): MatchPattern | string | undefined {
  const asString = literalString(expr);
  if (asString !== undefined) {
    try {
      const source = asString.startsWith('**/') ? asString : `**/${asString}`;
      globToRegExp(source);
    } catch {
      return asString;
    }
    return { kind: 'glob', source: asString, flags: '' };
  }
  if (!ts.isRegularExpressionLiteral(expr)) return undefined;
  const parsed = parseRegexLiteral(expr.text);
  if (!parsed) return undefined;
  return { kind: 'regex', source: parsed.source, flags: parsed.flags };
}

function parseRegexLiteral(text: string): { source: string; flags: string } | undefined {
  const lastSlash = text.lastIndexOf('/');
  if (!text.startsWith('/') || lastSlash <= 0) return undefined;
  return { source: text.slice(1, lastSlash), flags: text.slice(lastSlash + 1) };
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

/**
 * Glob subset used by the default spec globs and by Playwright's default testMatch:
 * `**`, `*`, `?`, `@(a|b)`, `?(a|b)`, `{a,b}`, and a simple `[abc]` class.
 */
export function globToRegExp(pattern: string): RegExp {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (!char) break;
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
      continue;
    }
    if (char === '*') {
      expression += '[^/]*';
      continue;
    }
    if (char === '?' && pattern[index + 1] === '(') {
      const group = readGroup(pattern, index + 1);
      expression += `(?:${group.body})?`;
      index = group.end;
      continue;
    }
    if (char === '?') {
      expression += '[^/]';
      continue;
    }
    if (char === '@' && pattern[index + 1] === '(') {
      const group = readGroup(pattern, index + 1);
      expression += `(?:${group.body})`;
      index = group.end;
      continue;
    }
    if (char === '{') {
      const end = pattern.indexOf('}', index + 1);
      if (end === -1) throw new Error(`unsupported glob "${pattern}"`);
      const body = pattern
        .slice(index + 1, end)
        .split(',')
        .map((part) => escapeRegExp(part))
        .join('|');
      expression += `(?:${body})`;
      index = end;
      continue;
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1);
      const body = end === -1 ? '' : pattern.slice(index + 1, end);
      if (end === -1 || !/^[A-Za-z0-9-]+$/.test(body)) throw new Error(`unsupported glob "${pattern}"`);
      expression += `[${body}]`;
      index = end;
      continue;
    }
    if (char === '+' || char === '!' || (char === '(' && pattern[index - 1] !== '@')) {
      if (pattern[index + 1] === '(' || char === '(') throw new Error(`unsupported glob "${pattern}"`);
    }
    expression += escapeRegExp(char);
  }
  return new RegExp(`^${expression}$`, 'i');
}

function readGroup(pattern: string, openIndex: number): { body: string; end: number } {
  const end = pattern.indexOf(')', openIndex + 1);
  if (pattern[openIndex] !== '(' || end === -1) throw new Error(`unsupported glob "${pattern}"`);
  const body = pattern
    .slice(openIndex + 1, end)
    .split('|')
    .map((part) => escapeRegExp(part))
    .join('|');
  return { body, end };
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+*?.()|[\]{}]/g, '\\$&');
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}
