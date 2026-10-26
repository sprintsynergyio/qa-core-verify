import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { matchesAssertionHelper, type VerifyConfig } from '../config.js';
import { analyzeBody } from './body.js';
import { isAwaited } from './settled.js';
import { ToolError } from '../tool-error.js';

export type TestModifier = 'only' | 'skip' | 'fixme';

export type SubjectKind = 'locator' | 'page' | 'page-read' | 'literal' | 'unknown' | 'other';

export type PageReadKind = 'textContent' | 'innerText' | 'getAttribute' | 'inputValue' | 'count';

export type ScalarLiteral =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'undefined' };

export interface ExpectCall {
  matcher: string;
  not: boolean;
  soft: boolean;
  poll: boolean;
  /** True for `expect(promise).resolves`. Every matcher on it returns a promise. */
  resolves: boolean;
  /** True for `expect(promise).rejects`. Every matcher on it returns a promise. */
  rejects: boolean;
  awaited: boolean;
  /** True when the test or the current helper returns this expect call. */
  returned: boolean;
  subjectSource: string;
  subjectKind: SubjectKind;
  pageRead?: PageReadKind;
  argumentSource: string;
  subjectLiteral?: ScalarLiteral;
  argumentLiteral?: ScalarLiteral;
  /** True when the subject text and the first argument text are the same. */
  sameSource: boolean;
  /** True when the expect sits in a branch or a loop that may not run. */
  conditional: boolean;
  /** True when the expect sits in a try whose catch does not rethrow. */
  swallowed: boolean;
  evidence: string;
  file: string;
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

export interface SourceFact {
  file: string;
  source: string;
  line: number;
  column: number;
}

export interface UnresolvedHelper extends SourceFact {
  name: string;
}

export interface ModifierSite {
  modifier: TestModifier;
  source: string;
  line: number;
  column: number;
}

export type BodyEvent =
  | { type: 'expect'; expect: ExpectCall }
  | { type: 'action'; fact: SourceFact }
  | { type: 'wait'; fact: SourceFact }
  | { type: 'helper'; fact: SourceFact }
  | { type: 'unresolved'; helper: UnresolvedHelper };

export interface InventoryTest {
  title: string;
  titlePath: string[];
  file: string;
  line: number;
  column: number;
  /**
   * Columns Playwright may store for this call. A TypeScript `test()` call records the
   * character after `test`. A `test.skip()` call records the property name. The source
   * column is included too, so a JavaScript call still matches.
   */
  evidenceColumns: number[];
  modifiers: TestModifier[];
  modifierSites: ModifierSite[];
  expects: ExpectCall[];
  locators: LocatorCall[];
  helpers: HelperCall[];
  events: BodyEvent[];
  unresolved: UnresolvedHelper[];
  /**
   * An unawaited `test.step` with a block body that contains an assertion,
   * or an unawaited call to an async helper that contains an assertion.
   */
  floatingCalls: SourceFact[];
}

/** One `test.describe.skip` block. The finding is on the block, not on each inner test. */
export interface SkippedDescribe {
  titlePath: string[];
  file: string;
  line: number;
  column: number;
  source: string;
}

export interface SuiteInventory {
  tests: InventoryTest[];
  skippedDescribes: SkippedDescribe[];
}

interface Bindings {
  testLocals: Set<string>;
  expectLocals: Set<string>;
  /** Const names bound to `expect.soft`. `let` and `var` are never added. */
  softLocals: Set<string>;
  namespaces: Set<string>;
  /** Names bound to `mergeTests` from `@playwright/test` or a fixture file. */
  mergeLocals: Set<string>;
}

interface SuiteContext {
  titles: string[];
  modifiers: TestModifier[];
  modifierSites: ModifierSite[];
  expectAliases: Set<string>;
  softAliases: Set<string>;
}

interface ExpectShape {
  not: boolean;
  soft: boolean;
  poll: boolean;
  resolves: boolean;
  rejects: boolean;
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

const SUITE_HOOK_NAMES = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);

const TIMER_NAMES = new Set(['setTimeout', 'setInterval', 'setImmediate']);

/**
 * Read one spec with the TypeScript parser. The file is not executed.
 * `test` and `expect` must be imported. Named imports may come from
 * `@playwright/test`, `playwright`, `playwright/test`, or a relative fixture
 * file. Those imports are not executed. A relative helper or page object file
 * is parsed one level deep so a test can see its assertions and locators.
 * A second import level is not opened. A call to `extend` on a known test
 * binding, and `expect.configure`, become bindings too. Condition-only
 * `skip`, `fixme`, `fail`, and `slow` calls are annotations. At suite level,
 * callbacks passed to other calls are searched so data-driven tests are found.
 * Callbacks of beforeEach, afterEach, beforeAll, afterAll, setTimeout,
 * setInterval, and setImmediate are not searched. An expect in one of those
 * hooks is not an assertion of the test.
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
  const skippedDescribes: SkippedDescribe[] = [];
  walkSuite(
    sourceFile,
    { titles: [], modifiers: [], modifierSites: [], expectAliases: new Set(), softAliases: new Set() },
    sourceFile,
    bindings,
    config,
    tests,
    skippedDescribes,
  );
  return { tests, skippedDescribes };
}

function walkSuite(
  node: ts.Node,
  ctx: SuiteContext,
  sourceFile: ts.SourceFile,
  bindings: Bindings,
  config: VerifyConfig,
  tests: InventoryTest[],
  skippedDescribes: SkippedDescribe[],
): void {
  if (ts.isVariableStatement(node)) noteSuiteAliases(node, ctx, bindings);
  if (ts.isCallExpression(node)) {
    const kind = classifyCall(node, bindings);
    if (kind?.type === 'describe') {
      const callback = callbackOf(node);
      const titlePath = [...ctx.titles, readTitle(node, sourceFile)];
      const sites = sitesFor(node, kind.modifiers, sourceFile);
      if (kind.modifiers.includes('skip')) {
        const pos = positionOf(node, sourceFile);
        skippedDescribes.push({
          titlePath,
          file: sourceFile.fileName,
          line: pos.line,
          column: pos.column,
          source: node.expression.getText(sourceFile),
        });
      }
      const next: SuiteContext = {
        titles: titlePath,
        modifiers: dedupeModifiers([...ctx.modifiers, ...kind.modifiers]),
        // describe.skip is reported once on the block. only and fixme still apply to each test.
        modifierSites: [...ctx.modifierSites, ...sites.filter((site) => site.modifier !== 'skip')],
        expectAliases: new Set(ctx.expectAliases),
        softAliases: new Set(ctx.softAliases),
      };
      if (callback) walkSuite(callback.body, next, sourceFile, bindings, config, tests, skippedDescribes);
      return;
    }
    if (kind?.type === 'test') {
      recordTest(node, kind.modifiers, ctx, sourceFile, bindings, config, tests);
      return;
    }
    if (kind?.type === 'annotation') return;
    // forEach and map can declare tests. Hook and timer callbacks do not.
    if (isSuiteHookCall(node) || isTimerCall(node)) return;
    for (const arg of node.arguments) {
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
        walkSuite(arg.body, ctx, sourceFile, bindings, config, tests, skippedDescribes);
      } else {
        walkSuite(arg, ctx, sourceFile, bindings, config, tests, skippedDescribes);
      }
    }
    return;
  }
  if (isNestedFunction(node)) return;
  ts.forEachChild(node, (child) => walkSuite(child, ctx, sourceFile, bindings, config, tests, skippedDescribes));
}

function noteSuiteAliases(statement: ts.VariableStatement, ctx: SuiteContext, bindings: Bindings): void {
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return;
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const name = declaration.name.text;
    const init = unwrapExpression(declaration.initializer);
    if (isSoftAliasInitializer(init, bindings, ctx)) {
      ctx.softAliases.add(name);
      ctx.expectAliases.delete(name);
      continue;
    }
    if (ts.isIdentifier(init) && (bindings.expectLocals.has(init.text) || ctx.expectAliases.has(init.text))) {
      ctx.expectAliases.add(name);
      ctx.softAliases.delete(name);
    }
  }
}

/** `expect.soft`, or a const that is already a soft alias. `let` and `var` never reach this function. */
function isSoftAliasInitializer(expr: ts.Expression, bindings: Bindings, ctx: SuiteContext): boolean {
  if (ts.isIdentifier(expr)) return ctx.softAliases.has(expr.text) || bindings.softLocals.has(expr.text);
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 'soft') return false;
  const base = unwrapExpression(expr.expression);
  if (!ts.isIdentifier(base)) return false;
  return bindings.expectLocals.has(base.text) || ctx.expectAliases.has(base.text);
}

function callCalleeName(call: ts.CallExpression): string | undefined {
  const expr = unwrapExpression(call.expression);
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function isSuiteHookCall(call: ts.CallExpression): boolean {
  const name = callCalleeName(call);
  return name !== undefined && SUITE_HOOK_NAMES.has(name);
}

function isTimerCall(call: ts.CallExpression): boolean {
  const name = callCalleeName(call);
  return name !== undefined && TIMER_NAMES.has(name);
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
    evidenceColumns: evidenceColumnsFor(call, sourceFile),
    modifiers: dedupeModifiers([...ctx.modifiers, ...ownModifiers]),
    modifierSites: [...ctx.modifierSites, ...sitesFor(call, ownModifiers, sourceFile)],
    expects: [],
    locators: [],
    helpers: [],
    events: [],
    unresolved: [],
    floatingCalls: [],
  };
  collectBody(callback, test, sourceFile, bindings, config, ctx.expectAliases, ctx.softAliases);
  tests.push(test);
}

function collectBody(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  test: InventoryTest,
  sourceFile: ts.SourceFile,
  bindings: Bindings,
  config: VerifyConfig,
  expectAliases: ReadonlySet<string>,
  softAliases: ReadonlySet<string>,
): void {
  const analyzed = analyzeBody({
    body: callback.body,
    parameters: callback.parameters,
    sourceFile,
    bindings,
    specPath: sourceFile.fileName,
    readExpect: (call, file, active) => readExpectParts(call, active, file),
    bindingsFor: (file) => collectBindings(file),
    isStep: (call, active) => classifyCall(call, active)?.type === 'step',
    isIgnoredSuiteCall: (call, active) => {
      const kind = classifyCall(call, active);
      return kind?.type === 'test' || kind?.type === 'describe' || kind?.type === 'annotation';
    },
    isLocatorCall: (call, names) => isLocatorCall(call, names),
    isLocatorExpression: (expr, names) => isLocatorExpression(expr, names),
    readHelper: (call, active, file) => asHelper(call, active, config, file),
    expectAliases,
    softAliases,
    isExpectName: (name, active) => active.expectLocals.has(name),
    isSoftName: (name, active) => active.softLocals.has(name),
    withExpectAliases: (active, aliases, softAliases) => withExpectAliases(active, aliases, softAliases),
  });
  test.expects = analyzed.expects;
  test.locators = analyzed.locators;
  test.helpers = analyzed.helpers;
  test.events = analyzed.events;
  test.unresolved = analyzed.unresolved;
  test.floatingCalls = analyzed.floatingCalls;
}

function withExpectAliases(
  bindings: Bindings,
  aliases: ReadonlySet<string>,
  softAliases: ReadonlySet<string>,
): Bindings {
  if (aliases.size === 0 && softAliases.size === 0) return bindings;
  const expectLocals = new Set(bindings.expectLocals);
  for (const name of aliases) expectLocals.add(name);
  const softLocals = new Set(bindings.softLocals);
  for (const name of softAliases) softLocals.add(name);
  return {
    testLocals: bindings.testLocals,
    expectLocals,
    softLocals,
    namespaces: bindings.namespaces,
    mergeLocals: bindings.mergeLocals,
  };
}

function readExpectParts(
  call: ts.CallExpression,
  bindings: Bindings,
  sourceFile: ts.SourceFile,
): { expect: ExpectCall; subject: ts.Expression | undefined } | null {
  const expect = asExpectMatcher(call, bindings, sourceFile);
  if (!expect) return null;
  const shape = ts.isPropertyAccessExpression(call.expression) ? expectShape(call.expression.expression, bindings) : null;
  return { expect, subject: shape?.subject };
}

function sitesFor(
  call: ts.CallExpression,
  modifiers: readonly TestModifier[],
  sourceFile: ts.SourceFile,
): ModifierSite[] {
  if (modifiers.length === 0) return [];
  const pos = positionOf(call, sourceFile);
  const source = call.expression.getText(sourceFile);
  return modifiers.map((modifier) => ({ modifier, source, line: pos.line, column: pos.column }));
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
  const argument = call.arguments[0];
  return {
    matcher,
    not: shape.not,
    soft: shape.soft,
    poll: shape.poll,
    resolves: shape.resolves,
    rejects: shape.rejects,
    awaited: isAwaited(call),
    returned: false,
    subjectSource: shape.subject ? shape.subject.getText(sourceFile) : '',
    subjectKind: 'other',
    argumentSource: argument ? argument.getText(sourceFile) : '',
    sameSource: false,
    conditional: false,
    swallowed: false,
    evidence: evidenceText(call, sourceFile),
    file: sourceFile.fileName,
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
  if (ts.isPropertyAccessExpression(unwrapped) && (unwrapped.name.text === 'resolves' || unwrapped.name.text === 'rejects')) {
    const inner = expectShape(unwrapped.expression, bindings);
    if (!inner || inner.resolves || inner.rejects) return null;
    if (unwrapped.name.text === 'resolves') return { ...inner, resolves: true };
    return { ...inner, rejects: true };
  }
  if (!ts.isCallExpression(unwrapped)) return null;
  const callee = unwrapExpression(unwrapped.expression);
  if (ts.isIdentifier(callee) && bindings.softLocals.has(callee.text)) {
    return { not: false, soft: true, poll: false, resolves: false, rejects: false, subject: unwrapped.arguments[0] };
  }
  if (isExpectConfigure(unwrapped.expression, bindings)) {
    return { not: false, soft: false, poll: false, resolves: false, rejects: false, subject: unwrapped.arguments[0] };
  }
  const chain = propertyChain(unwrapped.expression);
  if (!chain) return null;
  const canon = canonical(chain, bindings);
  if (!canon || canon[0] !== 'expect') return null;
  const form = canon[1];
  const subject = unwrapped.arguments[0];
  if (canon.length === 1) return { not: false, soft: false, poll: false, resolves: false, rejects: false, subject };
  if (canon.length === 2 && form === 'soft') {
    return { not: false, soft: true, poll: false, resolves: false, rejects: false, subject };
  }
  if (canon.length === 2 && form === 'poll') {
    return { not: false, soft: false, poll: true, resolves: false, rejects: false, subject };
  }
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
  | { type: 'step' }
  | { type: 'annotation' };

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
  // test.slow never declares a test. skip, fixme, and fail do only when the first argument is a title.
  if (second === 'slow') return { type: 'annotation' };
  if (second === 'skip' || second === 'fixme' || second === 'fail') {
    if (!isDeclaredTest(call)) return { type: 'annotation' };
    if (second === 'skip' || second === 'fixme') return { type: 'test', modifiers: [second] };
    return { type: 'test', modifiers: [] };
  }
  if (canon.length === 2 && isModifier(second)) return { type: 'test', modifiers: [second] };
  if (canon.length === 2) {
    if (!isDeclaredTest(call)) return null;
    return { type: 'test', modifiers: [] };
  }
  return null;
}

/** A declared test has a title first and a body function. A condition callback is not a title. */
function isDeclaredTest(call: ts.CallExpression): boolean {
  const first = call.arguments[0];
  if (!first) return false;
  if (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) return false;
  return callbackOf(call) !== undefined;
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
  if (ts.isTemplateExpression(arg)) return stripWrappingBackticks(arg.getText(sourceFile));
  return arg.getText(sourceFile);
}

function stripWrappingBackticks(text: string): string {
  if (text.startsWith('`') && text.endsWith('`') && text.length >= 2) return text.slice(1, -1);
  return text;
}

function evidenceText(call: ts.CallExpression, sourceFile: ts.SourceFile): string {
  let node: ts.Node = call;
  let parent = node.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    node = parent;
    parent = parent.parent;
  }
  if (parent && ts.isAwaitExpression(parent)) return parent.getText(sourceFile);
  return call.getText(sourceFile);
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
  const softLocals = new Set<string>();
  const namespaces = new Set<string>();
  const mergeLocals = new Set<string>();
  const bindings: Bindings = { testLocals, expectLocals, softLocals, namespaces, mergeLocals };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause && isTestSpecifier(node.moduleSpecifier)) {
      bindImport(node.importClause, isPlaywrightSpecifier(node.moduleSpecifier), testLocals, expectLocals, namespaces, mergeLocals);
    }
    if (ts.isVariableDeclaration(node)) {
      bindRequire(node, testLocals, expectLocals, namespaces, mergeLocals);
      if (ts.isIdentifier(node.name) && node.initializer) {
        if (isTestExtend(node.initializer, bindings) || isMergeTestsCall(node.initializer, bindings)) {
          testLocals.add(node.name.text);
        }
        if (isExpectConfigure(node.initializer, bindings)) expectLocals.add(node.name.text);
        const init = unwrapExpression(node.initializer);
        const list = node.parent;
        const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
        if (isConst && isFileScope(node) && isFileSoftAlias(init, expectLocals, softLocals)) {
          softLocals.add(node.name.text);
          expectLocals.delete(node.name.text);
        } else if (isConst && isFileScope(node) && ts.isIdentifier(init) && expectLocals.has(init.text)) {
          expectLocals.add(node.name.text);
          softLocals.delete(node.name.text);
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      if (isTestExtend(node.right, bindings) || isMergeTestsCall(node.right, bindings)) testLocals.add(node.left.text);
      if (isExpectConfigure(node.right, bindings)) expectLocals.add(node.left.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function isFileSoftAlias(expr: ts.Expression, expectLocals: Set<string>, softLocals: Set<string>): boolean {
  if (ts.isIdentifier(expr)) return softLocals.has(expr.text);
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 'soft') return false;
  const base = unwrapExpression(expr.expression);
  return ts.isIdentifier(base) && expectLocals.has(base.text);
}

function isFileScope(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessor(current) ||
      ts.isSetAccessor(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

function isTestExtend(expr: ts.Expression, bindings: Bindings): boolean {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isCallExpression(unwrapped)) return false;
  const callee = unwrapExpression(unwrapped.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'extend') return false;
  return isTestReceiver(callee.expression, bindings);
}

function isTestReceiver(expr: ts.Expression, bindings: Bindings): boolean {
  const unwrapped = unwrapExpression(expr);
  if (ts.isIdentifier(unwrapped) && bindings.testLocals.has(unwrapped.text)) return true;
  if (ts.isCallExpression(unwrapped) && isTestExtend(unwrapped, bindings)) return true;
  if (ts.isCallExpression(unwrapped) && isMergeTestsCall(unwrapped, bindings)) return true;
  const chain = propertyChain(unwrapped);
  if (!chain) return false;
  const canon = canonical(chain, bindings);
  return canon?.[0] === 'test' && canon.length === 1;
}

function isMergeTestsCall(expr: ts.Expression, bindings: Bindings): boolean {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isCallExpression(unwrapped)) return false;
  const callee = unwrapExpression(unwrapped.expression);
  if (!ts.isIdentifier(callee) || !bindings.mergeLocals.has(callee.text)) return false;
  if (unwrapped.arguments.length === 0) return false;
  return unwrapped.arguments.every((arg) => isTestReceiver(arg, bindings));
}

function isExpectConfigure(expr: ts.Expression, bindings: Bindings): boolean {
  const unwrapped = unwrapExpression(expr);
  return ts.isCallExpression(unwrapped) && isConfigureCall(unwrapped, bindings);
}

function isConfigureCall(expr: ts.CallExpression, bindings: Bindings): boolean {
  const callee = unwrapExpression(expr.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'configure') return false;
  return isExpectReceiver(callee.expression, bindings);
}

function isExpectReceiver(expr: ts.Expression, bindings: Bindings): boolean {
  const unwrapped = unwrapExpression(expr);
  if (ts.isIdentifier(unwrapped) && bindings.expectLocals.has(unwrapped.text)) return true;
  if (ts.isCallExpression(unwrapped) && isConfigureCall(unwrapped, bindings)) return true;
  const chain = propertyChain(unwrapped);
  if (!chain) return false;
  const canon = canonical(chain, bindings);
  return canon?.[0] === 'expect' && canon.length === 1;
}

function bindImport(
  clause: ts.ImportClause,
  playwright: boolean,
  testLocals: Set<string>,
  expectLocals: Set<string>,
  namespaces: Set<string>,
  mergeLocals: Set<string>,
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
    if (imported === 'mergeTests') mergeLocals.add(element.name.text);
  }
}

function bindRequire(
  declaration: ts.VariableDeclaration,
  testLocals: Set<string>,
  expectLocals: Set<string>,
  namespaces: Set<string>,
  mergeLocals: Set<string>,
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
    if (imported === 'mergeTests') mergeLocals.add(element.name.text);
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

/**
 * Playwright records `CallSite.getColumnNumber()` after its TypeScript transform.
 * For `test()` that column is the character after the name. For `test.skip()` it is
 * the property. The source column stays in the list so an untransformed file still matches.
 */
function evidenceColumnsFor(call: ts.CallExpression, sourceFile: ts.SourceFile): number[] {
  const start = positionOf(call, sourceFile).column;
  const columns = new Set<number>([start]);
  const expr = unwrapExpression(call.expression);
  const extension = path.extname(sourceFile.fileName).toLowerCase();
  const typescript = extension === '.ts' || extension === '.tsx' || extension === '.mts' || extension === '.cts';
  if (ts.isPropertyAccessExpression(expr)) {
    columns.add(positionOf(expr.name, sourceFile).column);
  } else if (typescript && ts.isIdentifier(expr)) {
    columns.add(start + expr.text.length);
  }
  return [...columns].sort((left, right) => left - right);
}

function positionAt(sourceFile: ts.SourceFile, position: number): { line: number; column: number } {
  const located = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: located.line + 1, column: located.character + 1 };
}
