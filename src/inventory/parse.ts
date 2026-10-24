import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { matchesAssertionHelper, type VerifyConfig } from '../config.js';
import { ToolError } from '../tool-error.js';

export type TestModifier = 'only' | 'skip' | 'fixme';

export interface ExpectCall {
  matcher: string;
  not: boolean;
  soft: boolean;
  poll: boolean;
  awaited: boolean;
  subjectSource: string;
  line: number;
  column: number;
}

export interface LocatorCall {
  source: string;
  line: number;
  column: number;
}

export interface HelperCall {
  name: string;
  source: string;
  line: number;
  column: number;
}

export interface InventoryTest {
  title: string;
  titlePath: string[];
  file: string;
  line: number;
  column: number;
  modifiers: TestModifier[];
  expects: ExpectCall[];
  locators: LocatorCall[];
  helpers: HelperCall[];
}

export interface SuiteInventory {
  tests: InventoryTest[];
}

interface Bindings {
  testLocals: Set<string>;
  expectLocals: Set<string>;
  namespaces: Set<string>;
}

interface SuiteContext {
  titles: string[];
  modifiers: TestModifier[];
}

interface ExpectShape {
  not: boolean;
  soft: boolean;
  poll: boolean;
  subject: ts.Expression | undefined;
}

const HOOKS = new Set([
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'use',
  'setTimeout',
  'info',
]);

/**
 * Read one spec with the TypeScript parser. The file is not executed.
 * `test` and `expect` must be imported. Named imports may come from
 * `@playwright/test`, `playwright`, `playwright/test`, or a relative fixture
 * file. The import is not loaded or followed.
 */
export function parseSpecFile(filePath: string, config: VerifyConfig): SuiteInventory {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new ToolError(`Spec path does not exist: ${filePath}`);
  }
  const text = fs.readFileSync(absolute, 'utf8');
  const sourceFile = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.ES2022,
    true,
    scriptKindFor(absolute),
  );
  const diagnostics = parseDiagnosticsOf(sourceFile);
  const first = diagnostics[0];
  if (first) {
    const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
    const pos = positionAt(sourceFile, first.start ?? 0);
    throw new ToolError(`Parse error in ${absolute}: ${message} (${pos.line}:${pos.column}).`);
  }

  const bindings = collectBindings(sourceFile);
  const tests: InventoryTest[] = [];
  walkSuite(sourceFile, { titles: [], modifiers: [] }, sourceFile, bindings, config, tests);
  return { tests };
}

function walkSuite(
  node: ts.Node,
  ctx: SuiteContext,
  sourceFile: ts.SourceFile,
  bindings: Bindings,
  config: VerifyConfig,
  tests: InventoryTest[],
): void {
  if (ts.isCallExpression(node)) {
    const kind = classifyCall(node, bindings);
    if (kind?.type === 'describe') {
      const callback = callbackOf(node);
      const next: SuiteContext = {
        titles: [...ctx.titles, readTitle(node, sourceFile)],
        modifiers: dedupeModifiers([...ctx.modifiers, ...kind.modifiers]),
      };
      if (callback) walkSuite(callback.body, next, sourceFile, bindings, config, tests);
      return;
    }
    if (kind?.type === 'test') {
      recordTest(node, kind.modifiers, ctx, sourceFile, bindings, config, tests);
      return;
    }
  }
  if (isNestedFunction(node)) return;
  ts.forEachChild(node, (child) => walkSuite(child, ctx, sourceFile, bindings, config, tests));
}

function recordTest(
  call: ts.CallExpression,
  ownModifiers: readonly TestModifier[],
  ctx: SuiteContext,
  sourceFile: ts.SourceFile,
  bindings: Bindings,
  config: VerifyConfig,
  tests: InventoryTest[],
): void {
  const callback = callbackOf(call);
  if (!callback) return;
  const title = readTitle(call, sourceFile);
  const pos = positionOf(call, sourceFile);
  const test: InventoryTest = {
    title,
    titlePath: [...ctx.titles, title],
    file: sourceFile.fileName,
    line: pos.line,
    column: pos.column,
    modifiers: dedupeModifiers([...ctx.modifiers, ...ownModifiers]),
    expects: [],
    locators: [],
    helpers: [],
  };
  collectBody(callback.body, test, sourceFile, bindings, config);
  tests.push(test);
}

function collectBody(
  body: ts.Node,
  test: InventoryTest,
  sourceFile: ts.SourceFile,
  bindings: Bindings,
  config: VerifyConfig,
): void {
  const locatorNames = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isLocatorExpression(node.initializer, locatorNames)
    ) {
      locatorNames.add(node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isLocatorExpression(node.right, locatorNames)
    ) {
      locatorNames.add(node.left.text);
    }

    if (ts.isCallExpression(node)) {
      const kind = classifyCall(node, bindings);
      if (kind?.type === 'step') {
        const callback = callbackOf(node);
        if (callback) walk(callback.body);
        return;
      }
      if (kind?.type === 'test' || kind?.type === 'describe') return;

      const expectCall = asExpectMatcher(node, bindings, sourceFile);
      if (expectCall) {
        test.expects.push(expectCall);
      } else if (isLocatorCall(node, locatorNames)) {
        const pos = positionOf(node, sourceFile);
        test.locators.push({ source: node.getText(sourceFile), line: pos.line, column: pos.column });
      } else {
        const helper = asHelper(node, bindings, config, sourceFile);
        if (helper) test.helpers.push(helper);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
}

function asExpectMatcher(
  call: ts.CallExpression,
  bindings: Bindings,
  sourceFile: ts.SourceFile,
): ExpectCall | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const matcher = call.expression.name.text;
  if (matcher === 'not' || matcher === 'soft' || matcher === 'poll') return null;
  const shape = expectShape(call.expression.expression, bindings);
  if (!shape) return null;
  const pos = positionOf(call, sourceFile);
  return {
    matcher,
    not: shape.not,
    soft: shape.soft,
    poll: shape.poll,
    awaited: isAwaited(call),
    subjectSource: shape.subject ? shape.subject.getText(sourceFile) : '',
    line: pos.line,
    column: pos.column,
  };
}

function expectShape(expr: ts.Expression, bindings: Bindings): ExpectShape | null {
  const unwrapped = unwrapExpression(expr);
  if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === 'not') {
    const inner = expectShape(unwrapped.expression, bindings);
    if (!inner || inner.not) return null;
    return { ...inner, not: true };
  }
  if (!ts.isCallExpression(unwrapped)) return null;
  const chain = propertyChain(unwrapped.expression);
  if (!chain) return null;
  const canon = canonical(chain, bindings);
  if (!canon || canon[0] !== 'expect') return null;
  const form = canon[1];
  const subject = unwrapped.arguments[0];
  if (canon.length === 1) return { not: false, soft: false, poll: false, subject };
  if (canon.length === 2 && form === 'soft') return { not: false, soft: true, poll: false, subject };
  if (canon.length === 2 && form === 'poll') return { not: false, soft: false, poll: true, subject };
  return null;
}

function asHelper(
  call: ts.CallExpression,
  bindings: Bindings,
  config: VerifyConfig,
  sourceFile: ts.SourceFile,
): HelperCall | null {
  const chain = propertyChain(call.expression);
  if (chain) {
    const canon = canonical(chain, bindings);
    const head = canon?.[0];
    if (head === 'expect' || head === 'test') return null;
  }
  const name = callName(call.expression);
  if (!name || !matchesAssertionHelper(name, config)) return null;
  const pos = positionOf(call, sourceFile);
  return { name, source: call.getText(sourceFile), line: pos.line, column: pos.column };
}

function isLocatorCall(call: ts.CallExpression, locatorNames: Set<string>): boolean {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const name = callee.name.text;
  if (!isLocatorMethod(name)) return false;
  if (isLocatorFactory(name)) return true;
  return isLocatorExpression(callee.expression, locatorNames);
}

function isLocatorExpression(expr: ts.Expression, locatorNames: Set<string>): boolean {
  const unwrapped = unwrapExpression(expr);
  if (ts.isCallExpression(unwrapped)) return isLocatorCall(unwrapped, locatorNames);
  if (ts.isIdentifier(unwrapped)) return locatorNames.has(unwrapped.text);
  return false;
}

function isLocatorFactory(name: string): boolean {
  return name === 'locator' || name === 'frameLocator' || /^getBy[A-Z]/.test(name);
}

function isLocatorMethod(name: string): boolean {
  return isLocatorFactory(name) || name === 'filter' || name === 'first' || name === 'last' || name === 'nth';
}

type SuiteCall =
  | { type: 'test'; modifiers: TestModifier[] }
  | { type: 'describe'; modifiers: TestModifier[] }
  | { type: 'step' };

function classifyCall(call: ts.CallExpression, bindings: Bindings): SuiteCall | null {
  const chain = propertyChain(call.expression);
  if (!chain) return null;
  const canon = canonical(chain, bindings);
  if (!canon || canon[0] !== 'test') return null;
  if (canon.length === 1) return { type: 'test', modifiers: [] };
  const second = canon[1];
  if (!second) return null;
  if (second === 'step') return { type: 'step' };
  if (second === 'describe') {
    const modifiers: TestModifier[] = [];
    for (const part of canon.slice(2)) {
      if (isModifier(part)) modifiers.push(part);
    }
    return { type: 'describe', modifiers };
  }
  if (second === 'expect' || HOOKS.has(second)) return null;
  if (canon.length === 2 && isModifier(second)) return { type: 'test', modifiers: [second] };
  if (canon.length === 2) return { type: 'test', modifiers: [] };
  return null;
}

function canonical(chain: readonly string[], bindings: Bindings): string[] | null {
  const root = chain[0];
  if (!root) return null;
  const isTest = bindings.testLocals.has(root);
  const isNamespace = bindings.namespaces.has(root);
  const isExpect = bindings.expectLocals.has(root);

  if (isExpect && !isTest && !isNamespace) return ['expect', ...chain.slice(1)];
  if (isNamespace && !isTest) {
    const second = chain[1];
    if (second === 'test' || second === 'expect') return chain.slice(1);
    return null;
  }
  if (isTest) {
    const asTest = ['test', ...chain.slice(1)];
    const second = asTest[1];
    if (second === 'test') return ['test', ...asTest.slice(2)];
    if (second === 'expect') return asTest.slice(1);
    return asTest;
  }
  return null;
}

function propertyChain(expr: ts.Expression): string[] | null {
  const parts: string[] = [];
  let current = unwrapExpression(expr);
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = unwrapExpression(current.expression);
  }
  if (!ts.isIdentifier(current)) return null;
  parts.unshift(current.text);
  return parts;
}

function callName(expr: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expr);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const left = callName(unwrapped.expression);
    if (!left) return null;
    return `${left}.${unwrapped.name.text}`;
  }
  return null;
}

function callbackOf(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let index = call.arguments.length - 1; index >= 0; index -= 1) {
    const arg = call.arguments[index];
    if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return arg;
  }
  return undefined;
}

function readTitle(call: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const arg = call.arguments[0];
  if (!arg) return '';
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return arg.getText(sourceFile);
}

function isAwaited(node: ts.Node): boolean {
  let parent = node.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    parent = parent.parent;
  }
  return !!parent && ts.isAwaitExpression(parent);
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isNestedFunction(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

function isModifier(value: string): value is TestModifier {
  return value === 'only' || value === 'skip' || value === 'fixme';
}

function dedupeModifiers(modifiers: readonly TestModifier[]): TestModifier[] {
  const seen = new Set<TestModifier>();
  const result: TestModifier[] = [];
  for (const modifier of modifiers) {
    if (seen.has(modifier)) continue;
    seen.add(modifier);
    result.push(modifier);
  }
  return result;
}

function collectBindings(sourceFile: ts.SourceFile): Bindings {
  const testLocals = new Set<string>();
  const expectLocals = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && isTestSpecifier(statement.moduleSpecifier)) {
      const playwright = isPlaywrightSpecifier(statement.moduleSpecifier);
      bindImport(statement.importClause, playwright, testLocals, expectLocals, namespaces);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bindRequire(declaration, testLocals, expectLocals, namespaces);
      }
    }
  }
  return { testLocals, expectLocals, namespaces };
}

function bindImport(
  clause: ts.ImportClause,
  playwright: boolean,
  testLocals: Set<string>,
  expectLocals: Set<string>,
  namespaces: Set<string>,
): void {
  // A default or namespace import is the Playwright test object only for the Playwright package.
  // A named import from a relative fixture file is still the test binding. The import is not loaded.
  if (playwright && clause.name) testLocals.add(clause.name.text);
  const named = clause.namedBindings;
  if (!named) return;
  if (ts.isNamespaceImport(named)) {
    if (playwright) namespaces.add(named.name.text);
    return;
  }
  for (const element of named.elements) {
    const imported = element.propertyName?.text ?? element.name.text;
    if (imported === 'test') testLocals.add(element.name.text);
    if (imported === 'expect') expectLocals.add(element.name.text);
  }
}

function bindRequire(
  declaration: ts.VariableDeclaration,
  testLocals: Set<string>,
  expectLocals: Set<string>,
  namespaces: Set<string>,
): void {
  if (!declaration.initializer || !isTestRequire(declaration.initializer)) return;
  const playwright = isPlaywrightRequire(declaration.initializer);
  if (playwright && ts.isIdentifier(declaration.name)) {
    // module.exports of @playwright/test is the test function, with named exports copied on.
    testLocals.add(declaration.name.text);
    namespaces.add(declaration.name.text);
    return;
  }
  if (!ts.isObjectBindingPattern(declaration.name)) return;
  for (const element of declaration.name.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
    const imported =
      element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
    if (imported === 'test') testLocals.add(element.name.text);
    if (imported === 'expect') expectLocals.add(element.name.text);
  }
}

function isPlaywrightRequire(expr: ts.Expression): boolean {
  return isRequireFrom(expr, isPlaywrightModule);
}

function isTestRequire(expr: ts.Expression): boolean {
  return isRequireFrom(expr, isTestModule);
}

function isRequireFrom(expr: ts.Expression, accept: (specifier: string) => boolean): boolean {
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== 'require') return false;
  const arg = expr.arguments[0];
  return !!arg && ts.isStringLiteral(arg) && accept(arg.text);
}

function isPlaywrightSpecifier(expr: ts.Expression): boolean {
  return ts.isStringLiteral(expr) && isPlaywrightModule(expr.text);
}

function isTestSpecifier(expr: ts.Expression): boolean {
  return ts.isStringLiteral(expr) && isTestModule(expr.text);
}

function isTestModule(specifier: string): boolean {
  return isPlaywrightModule(specifier) || specifier.startsWith('./') || specifier.startsWith('../');
}

function isPlaywrightModule(specifier: string): boolean {
  return (
    specifier === '@playwright/test' ||
    specifier === 'playwright' ||
    specifier === 'playwright/test' ||
    specifier.endsWith('/@playwright/test') ||
    specifier.endsWith('/playwright/test')
  );
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parseDiagnosticsOf(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  const extra = sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  return extra.parseDiagnostics ?? [];
}

function positionOf(node: ts.Node, sourceFile: ts.SourceFile): { line: number; column: number } {
  return positionAt(sourceFile, node.getStart(sourceFile));
}

function positionAt(sourceFile: ts.SourceFile, position: number): { line: number; column: number } {
  const located = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: located.line + 1, column: located.character + 1 };
}
