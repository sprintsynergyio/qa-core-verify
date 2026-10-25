import ts from 'typescript';
import {
  isPageType,
  isRelativeSpecifier,
  loadRelative,
  indexParsedFile,
  type ClassBody,
  type FileIndex,
  type FunctionBody,
  type ImportRef,
} from './resolve.js';
import type {
  BodyEvent,
  ExpectCall,
  HelperCall,
  LocatorCall,
  PageReadKind,
  ScalarLiteral,
  SourceFact,
  SubjectKind,
  UnresolvedHelper,
} from './parse.js';

export interface ExpectParts {
  expect: ExpectCall;
  subject: ts.Expression | undefined;
}

export interface AnalyzeOptions<Bindings> {
  body: ts.ConciseBody;
  parameters: readonly ts.ParameterDeclaration[];
  sourceFile: ts.SourceFile;
  bindings: Bindings;
  specPath: string;
  readExpect: (call: ts.CallExpression, file: ts.SourceFile, bindings: Bindings) => ExpectParts | null;
  bindingsFor: (file: ts.SourceFile) => Bindings;
  isStep: (call: ts.CallExpression, bindings: Bindings) => boolean;
  isIgnoredSuiteCall: (call: ts.CallExpression, bindings: Bindings) => boolean;
  isLocatorCall: (call: ts.CallExpression, locatorNames: Set<string>) => boolean;
  isLocatorExpression: (expr: ts.Expression, locatorNames: Set<string>) => boolean;
  readHelper: (call: ts.CallExpression, bindings: Bindings, file: ts.SourceFile) => HelperCall | null;
}

export interface BodyAnalysis {
  expects: ExpectCall[];
  locators: LocatorCall[];
  helpers: HelperCall[];
  events: BodyEvent[];
  unresolved: UnresolvedHelper[];
}

const PAGE_READS = new Set<PageReadKind>(['textContent', 'innerText', 'getAttribute', 'inputValue', 'count']);

const LOCATOR_ACTIONS = new Set([
  'click',
  'dblclick',
  'tap',
  'fill',
  'press',
  'pressSequentially',
  'type',
  'check',
  'uncheck',
  'selectOption',
  'setInputFiles',
  'hover',
  'focus',
  'clear',
  'dragTo',
]);

const PAGE_ACTIONS = new Set([
  'goto',
  'goBack',
  'goForward',
  'reload',
  'setContent',
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'selectOption',
  'setInputFiles',
  'hover',
  'tap',
  'dragAndDrop',
]);

const ITERATION_METHODS = new Set([
  'forEach',
  'map',
  'filter',
  'flatMap',
  'every',
  'some',
  'reduce',
  'reduceRight',
]);

type ValueKind =
  | { type: 'locator' }
  | { type: 'page' }
  | { type: 'page-read'; read: PageReadKind }
  | { type: 'literal'; literal: ScalarLiteral }
  | { type: 'instance'; classBody: ClassBody }
  | { type: 'unknown' }
  | { type: 'other' };

interface SavedScope {
  sourceFile: ts.SourceFile;
  fileIndex: FileIndex;
  bindings: unknown;
  locatorNames: Set<string>;
  pageNames: Set<string>;
  pageReads: Map<string, PageReadKind>;
  instances: Map<string, ClassBody>;
  localFns: Map<string, FunctionBody>;
  thisPage: boolean;
  ownerClass: ClassBody | undefined;
  returnCounts: boolean;
  conditional: boolean;
  swallowed: boolean;
  eventCount: number;
}

/**
 * Walk one test body. Relative helpers and page objects are parsed one level
 * deep. A call that needs a second import is reported as unresolved instead of guessed.
 */
export function analyzeBody<Bindings>(options: AnalyzeOptions<Bindings>): BodyAnalysis {
  const walker = new BodyWalker(options);
  walker.run();
  return walker.finish();
}

class BodyWalker<Bindings> {
  private readonly options: AnalyzeOptions<Bindings>;
  private readonly specPath: string;
  private sourceFile: ts.SourceFile;
  private fileIndex: FileIndex;
  private bindings: Bindings;
  private locatorNames = new Set<string>();
  private pageNames = new Set<string>();
  private pageReads = new Map<string, PageReadKind>();
  private instances = new Map<string, ClassBody>();
  private localFns = new Map<string, FunctionBody>();
  private thisPage = false;
  private ownerClass: ClassBody | undefined;
  private returnCounts = true;
  private conditional = false;
  private swallowed = false;
  private readonly expects: ExpectCall[] = [];
  private readonly locators: LocatorCall[] = [];
  private readonly helpers: HelperCall[] = [];
  private readonly events: BodyEvent[] = [];
  private readonly unresolved: UnresolvedHelper[] = [];
  private readonly unresolvedKeys = new Set<string>();
  private readonly stack = new Set<string>();
  private readonly kindStack = new Set<string>();

  constructor(options: AnalyzeOptions<Bindings>) {
    this.options = options;
    this.specPath = options.specPath;
    this.sourceFile = options.sourceFile;
    this.fileIndex = indexParsedFile(options.sourceFile);
    this.bindings = options.bindings;
    seedPageNames(options.parameters, this.pageNames);
  }

  run(): void {
    this.walk(this.options.body);
  }

  finish(): BodyAnalysis {
    return {
      expects: this.expects,
      locators: this.locators,
      helpers: this.helpers,
      events: this.events,
      unresolved: this.unresolved,
    };
  }

  private walk(node: ts.Node): void {
    if (isFunctionLike(node)) {
      this.walkFunction(node);
      return;
    }
    if (ts.isIfStatement(node)) {
      this.walk(node.expression);
      this.withConditional(() => this.walk(node.thenStatement));
      const elseStatement = node.elseStatement;
      if (elseStatement) this.withConditional(() => this.walk(elseStatement));
      return;
    }
    if (ts.isSwitchStatement(node)) {
      this.walk(node.expression);
      this.withConditional(() => {
        for (const clause of node.caseBlock.clauses) {
          for (const statement of clause.statements) this.walk(statement);
        }
      });
      return;
    }
    if (ts.isConditionalExpression(node)) {
      this.walk(node.condition);
      this.withConditional(() => this.walk(node.whenTrue));
      this.withConditional(() => this.walk(node.whenFalse));
      return;
    }
    if (ts.isTryStatement(node)) {
      const swallows = node.catchClause ? !catchRethrows(node.catchClause) : false;
      if (swallows) this.withSwallowed(() => this.walk(node.tryBlock));
      else this.walk(node.tryBlock);
      if (node.catchClause) this.withConditional(() => this.walk(node.catchClause as ts.CatchClause));
      if (node.finallyBlock) this.walk(node.finallyBlock);
      return;
    }
    if (ts.isForStatement(node)) {
      if (node.initializer) this.walk(node.initializer);
      if (node.condition) this.walk(node.condition);
      if (node.incrementor) this.walk(node.incrementor);
      if (forMayBeEmpty(node)) this.withConditional(() => this.walk(node.statement));
      else this.walk(node.statement);
      return;
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      this.walk(node.expression);
      this.withConditional(() => this.walk(node.statement));
      return;
    }
    if (ts.isWhileStatement(node)) {
      this.walk(node.expression);
      this.withConditional(() => this.walk(node.statement));
      return;
    }
    if (ts.isDoStatement(node)) {
      this.walk(node.statement);
      this.walk(node.expression);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if ((ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && initializer.body) {
        this.localFns.set(node.name.text, this.makeLocal(node.name.text, initializer.parameters, initializer.body));
        return;
      }
      this.applyBinding(node.name.text, this.valueKind(node.initializer));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      this.applyBinding(node.left.text, this.valueKind(node.right));
    }
    if (ts.isCallExpression(node)) {
      if (this.onCall(node) === 'done') return;
    }
    ts.forEachChild(node, (child) => this.walk(child));
  }

  private walkFunction(node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration): void {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.body) {
      this.localFns.set(node.name.text, this.makeLocal(node.name.text, node.parameters, node.body));
      return;
    }
    const body = node.body;
    if (!body) return;
    const savedReturn = this.returnCounts;
    const savedConditional = this.conditional;
    this.returnCounts = false;
    if (isIterationCallback(node)) this.conditional = true;
    this.walk(body);
    this.returnCounts = savedReturn;
    this.conditional = savedConditional;
  }

  private onCall(call: ts.CallExpression): 'done' | 'children' {
    if (this.options.isStep(call, this.bindings)) {
      const callback = callbackOf(call);
      if (callback) {
        const savedReturn = this.returnCounts;
        this.returnCounts = false;
        this.walk(callback.body);
        this.returnCounts = savedReturn;
      }
      return 'done';
    }
    if (this.options.isIgnoredSuiteCall(call, this.bindings)) return 'done';

    const parts = this.options.readExpect(call, this.sourceFile, this.bindings);
    if (parts) {
      this.decorateExpect(parts.expect, parts.subject, call);
      this.expects.push(parts.expect);
      this.events.push({ type: 'expect', expect: parts.expect });
      return 'children';
    }

    if (this.options.isLocatorCall(call, this.locatorNames)) {
      const pos = positionOf(call, this.sourceFile);
      this.locators.push({ source: call.getText(this.sourceFile), line: pos.line, column: pos.column });
      return 'children';
    }

    if (this.isWait(call)) {
      this.events.push({ type: 'wait', fact: this.fact(call) });
      return 'children';
    }
    if (this.isAction(call)) {
      this.events.push({ type: 'action', fact: this.fact(call) });
      return 'children';
    }

    const resolved = this.resolveCallee(call);
    if (resolved && resolved !== 'unresolved') {
      if (this.isAssertionShaped(call)) this.inline(resolved, call);
    } else if (resolved === 'unresolved' && this.isAssertionShaped(call)) {
      this.noteUnresolved(call, calleeName(call));
    }
    this.recordHelper(call);
    return 'children';
  }

  private decorateExpect(expect: ExpectCall, subject: ts.Expression | undefined, call: ts.CallExpression): void {
    const kind = subject ? this.valueKind(subject) : ({ type: 'other' } as const);
    expect.subjectKind = subjectKindOf(kind);
    if (kind.type === 'page-read') expect.pageRead = kind.read;
    if (kind.type === 'literal') expect.subjectLiteral = kind.literal;
    const argument = call.arguments[0];
    if (argument) {
      expect.argumentSource = argument.getText(this.sourceFile);
      const argumentKind = this.valueKind(argument);
      if (argumentKind.type === 'literal') expect.argumentLiteral = argumentKind.literal;
    } else {
      expect.argumentSource = '';
    }
    const subjectText = subject ? subject.getText(this.sourceFile) : '';
    expect.sameSource = subjectText.length > 0 && subjectText === expect.argumentSource;
    expect.returned = this.isReturnedNode(call);
    expect.conditional = this.conditional;
    expect.swallowed = this.swallowed;
    expect.file = this.sourceFile.fileName;
  }

  private inline(fn: FunctionBody, call: ts.CallExpression): void {
    const key = functionKey(fn);
    if (this.stack.has(key)) {
      this.noteUnresolved(call, fn.name);
      return;
    }
    const awaited = isAwaited(call);
    const returned = this.isReturnedNode(call);
    this.stack.add(key);
    const saved = this.save();
    this.install(fn);
    this.walk(fn.body);
    for (let index = saved.eventCount; index < this.events.length; index += 1) {
      const event = this.events[index];
      if (!event || event.type !== 'expect' || !event.expect.returned) continue;
      event.expect.awaited = event.expect.awaited || awaited;
      event.expect.returned = returned;
    }
    this.restore(saved);
    this.stack.delete(key);
  }

  private valueKind(expr: ts.Expression): ValueKind {
    let current = unwrap(expr);
    if (ts.isAwaitExpression(current)) current = unwrap(current.expression);
    const literal = readLiteral(current);
    if (literal) return { type: 'literal', literal };
    if (ts.isIdentifier(current)) {
      if (this.pageNames.has(current.text)) return { type: 'page' };
      if (this.locatorNames.has(current.text)) return { type: 'locator' };
      const read = this.pageReads.get(current.text);
      if (read) return { type: 'page-read', read };
      const instance = this.instances.get(current.text);
      if (instance) return { type: 'instance', classBody: instance };
      return { type: 'other' };
    }
    if (this.isThisPage(current)) return { type: 'page' };
    if (ts.isNewExpression(current) && current.expression && ts.isIdentifier(current.expression)) {
      const found = this.resolveClass(current.expression.text);
      if (found === 'unresolved') {
        this.noteUnresolved(current, current.expression.text);
        return { type: 'unknown' };
      }
      if (found) return { type: 'instance', classBody: found };
      return { type: 'other' };
    }
    if (ts.isCallExpression(current)) {
      const read = this.pageReadOf(current);
      if (read) return { type: 'page-read', read };
      if (this.options.isLocatorExpression(current, this.locatorNames)) return { type: 'locator' };
      const resolved = this.resolveCallee(current);
      if (resolved === 'unresolved') {
        this.noteUnresolved(current, calleeName(current));
        return { type: 'unknown' };
      }
      if (resolved) return this.returnKindOf(resolved);
    }
    return { type: 'other' };
  }

  private returnKindOf(fn: FunctionBody): ValueKind {
    const key = functionKey(fn);
    if (this.kindStack.has(key)) return { type: 'other' };
    this.kindStack.add(key);
    const saved = this.save();
    this.install(fn);
    const exprs = collectReturnExprs(fn.body);
    const kinds = exprs.map((expr) => this.valueKind(expr));
    const result = mergeKinds(kinds);
    this.restore(saved);
    this.kindStack.delete(key);
    return result;
  }

  private resolveCallee(call: ts.CallExpression): FunctionBody | 'unresolved' | undefined {
    const expr = unwrap(call.expression);
    if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword && this.ownerClass) {
      return this.ownerClass.methods.get(expr.name.text);
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      const instance = this.instances.get(expr.expression.text);
      if (instance) return instance.methods.get(expr.name.text);
      const imported = this.fileIndex.imports.get(expr.expression.text);
      if (imported?.kind === 'namespace' && isRelativeSpecifier(imported.specifier)) {
        return this.functionFromImport(imported, expr.name.text);
      }
      return undefined;
    }
    if (!ts.isIdentifier(expr)) return undefined;
    const local = this.localFns.get(expr.text);
    if (local) return local;
    const fileFn = this.fileIndex.functions.get(expr.text);
    if (fileFn) return fileFn;
    const imported = this.fileIndex.imports.get(expr.text);
    if (!imported || imported.kind === 'namespace' || !isRelativeSpecifier(imported.specifier)) return undefined;
    return this.functionFromImport(imported, imported.exportName);
  }

  private functionFromImport(imported: ImportRef, exportName: string): FunctionBody | 'unresolved' | undefined {
    if (this.fileIndex.filePath !== this.specPath) return 'unresolved';
    const loaded = loadRelative(this.fileIndex.filePath, imported.specifier);
    if (!loaded) return 'unresolved';
    const fn = loaded.functions.get(exportName);
    if (!fn || !fn.exported) return 'unresolved';
    return fn;
  }

  private resolveClass(name: string): ClassBody | 'unresolved' | undefined {
    const local = this.fileIndex.classes.get(name);
    if (local) return local;
    const imported = this.fileIndex.imports.get(name);
    if (!imported || imported.kind === 'namespace' || !isRelativeSpecifier(imported.specifier)) return undefined;
    if (this.fileIndex.filePath !== this.specPath) return 'unresolved';
    const loaded = loadRelative(this.fileIndex.filePath, imported.specifier);
    if (!loaded) return 'unresolved';
    const found = loaded.classes.get(imported.exportName);
    if (!found || !found.exported) return 'unresolved';
    return found;
  }

  private pageReadOf(call: ts.CallExpression): PageReadKind | undefined {
    const expr = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(expr)) return undefined;
    const name = expr.name.text;
    if (!isPageReadName(name)) return undefined;
    if (this.options.isLocatorExpression(expr.expression, this.locatorNames) || this.isPageExpr(expr.expression)) return name;
    return undefined;
  }

  private isAction(call: ts.CallExpression): boolean {
    const expr = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(expr)) return false;
    const name = expr.name.text;
    if (LOCATOR_ACTIONS.has(name) && this.options.isLocatorExpression(expr.expression, this.locatorNames)) return true;
    if (PAGE_ACTIONS.has(name) && this.isPageExpr(expr.expression)) return true;
    return false;
  }

  private isWait(call: ts.CallExpression): boolean {
    const expr = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 'waitForTimeout') return false;
    return this.isPageExpr(expr.expression);
  }

  private isPageExpr(expr: ts.Expression): boolean {
    const node = unwrap(expr);
    if (ts.isIdentifier(node)) return this.pageNames.has(node.text);
    return this.isThisPage(node);
  }

  private isThisPage(expr: ts.Expression): boolean {
    return (
      this.thisPage &&
      ts.isPropertyAccessExpression(expr) &&
      expr.expression.kind === ts.SyntaxKind.ThisKeyword &&
      expr.name.text === 'page'
    );
  }

  private isAssertionShaped(call: ts.CallExpression): boolean {
    let node: ts.Node = call;
    let parent = node.parent;
    while (parent && isTransparent(parent)) {
      node = parent;
      parent = parent.parent;
    }
    if (parent && ts.isExpressionStatement(parent)) return true;
    if (parent && ts.isReturnStatement(parent)) return true;
    if (parent && ts.isArrowFunction(parent) && parent.body === node) return true;
    return false;
  }

  private isReturnedNode(call: ts.CallExpression): boolean {
    if (!this.returnCounts) return false;
    let node: ts.Node = call;
    let parent = node.parent;
    while (parent && isTransparent(parent)) {
      node = parent;
      parent = parent.parent;
    }
    if (parent && ts.isReturnStatement(parent)) return true;
    if (parent && ts.isArrowFunction(parent) && parent.body === node) return true;
    return false;
  }

  private applyBinding(name: string, kind: ValueKind): void {
    this.locatorNames.delete(name);
    this.pageNames.delete(name);
    this.pageReads.delete(name);
    this.instances.delete(name);
    if (kind.type === 'locator') this.locatorNames.add(name);
    if (kind.type === 'page') this.pageNames.add(name);
    if (kind.type === 'page-read') this.pageReads.set(name, kind.read);
    if (kind.type === 'instance') this.instances.set(name, kind.classBody);
  }

  private noteUnresolved(node: ts.Node, name: string): void {
    const pos = positionOf(node, this.sourceFile);
    const key = `${this.sourceFile.fileName}:${pos.line}:${pos.column}:${name}`;
    if (this.unresolvedKeys.has(key)) return;
    this.unresolvedKeys.add(key);
    const helper: UnresolvedHelper = {
      file: this.sourceFile.fileName,
      source: node.getText(this.sourceFile),
      line: pos.line,
      column: pos.column,
      name,
    };
    this.unresolved.push(helper);
    this.events.push({ type: 'unresolved', helper });
  }

  private recordHelper(call: ts.CallExpression): void {
    const helper = this.options.readHelper(call, this.bindings, this.sourceFile);
    if (!helper) return;
    this.helpers.push(helper);
    this.events.push({
      type: 'helper',
      fact: { file: this.sourceFile.fileName, source: helper.source, line: helper.line, column: helper.column },
    });
  }

  private fact(node: ts.Node): SourceFact {
    const pos = positionOf(node, this.sourceFile);
    return {
      file: this.sourceFile.fileName,
      source: node.getText(this.sourceFile),
      line: pos.line,
      column: pos.column,
    };
  }

  private makeLocal(name: string, parameters: readonly ts.ParameterDeclaration[], body: ts.ConciseBody): FunctionBody {
    return {
      name,
      sourceFile: this.sourceFile,
      filePath: this.sourceFile.fileName,
      parameters,
      body,
      exported: true,
      thisPage: this.thisPage,
      ownerClass: this.ownerClass,
      index: this.fileIndex,
    };
  }

  private install(fn: FunctionBody): void {
    this.sourceFile = fn.sourceFile;
    this.fileIndex = fn.index;
    this.bindings = this.options.bindingsFor(fn.sourceFile);
    this.locatorNames = new Set();
    this.pageNames = new Set();
    this.pageReads = new Map();
    this.instances = new Map();
    this.localFns = new Map();
    this.thisPage = fn.thisPage;
    this.ownerClass = fn.ownerClass;
    this.returnCounts = true;
    seedPageNames(fn.parameters, this.pageNames);
  }

  private save(): SavedScope {
    return {
      sourceFile: this.sourceFile,
      fileIndex: this.fileIndex,
      bindings: this.bindings,
      locatorNames: this.locatorNames,
      pageNames: this.pageNames,
      pageReads: this.pageReads,
      instances: this.instances,
      localFns: this.localFns,
      thisPage: this.thisPage,
      ownerClass: this.ownerClass,
      returnCounts: this.returnCounts,
      conditional: this.conditional,
      swallowed: this.swallowed,
      eventCount: this.events.length,
    };
  }

  private restore(saved: SavedScope): void {
    this.sourceFile = saved.sourceFile;
    this.fileIndex = saved.fileIndex;
    this.bindings = saved.bindings as Bindings;
    this.locatorNames = saved.locatorNames;
    this.pageNames = saved.pageNames;
    this.pageReads = saved.pageReads;
    this.instances = saved.instances;
    this.localFns = saved.localFns;
    this.thisPage = saved.thisPage;
    this.ownerClass = saved.ownerClass;
    this.returnCounts = saved.returnCounts;
    this.conditional = saved.conditional;
    this.swallowed = saved.swallowed;
  }

  private withConditional(run: () => void): void {
    const saved = this.conditional;
    this.conditional = true;
    run();
    this.conditional = saved;
  }

  private withSwallowed(run: () => void): void {
    const saved = this.swallowed;
    this.swallowed = true;
    run();
    this.swallowed = saved;
  }
}

function subjectKindOf(kind: ValueKind): SubjectKind {
  if (kind.type === 'locator' || kind.type === 'page' || kind.type === 'page-read' || kind.type === 'literal') return kind.type;
  if (kind.type === 'unknown') return 'unknown';
  return 'other';
}

function mergeKinds(kinds: readonly ValueKind[]): ValueKind {
  const first = kinds[0];
  if (!first) return { type: 'other' };
  if (kinds.some((kind) => kind.type === 'unknown')) return { type: 'unknown' };
  if (kinds.every((kind) => kind.type === 'locator')) return { type: 'locator' };
  if (kinds.every((kind) => kind.type === 'page')) return { type: 'page' };
  if (first.type === 'page-read' && kinds.every((kind) => kind.type === 'page-read' && kind.read === first.read)) return first;
  return { type: 'other' };
}

function isPageReadName(name: string): name is PageReadKind {
  return PAGE_READS.has(name as PageReadKind);
}

function collectReturnExprs(body: ts.ConciseBody): ts.Expression[] {
  if (!ts.isBlock(body)) return [body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function forMayBeEmpty(node: ts.ForStatement): boolean {
  const initializer = node.initializer;
  if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return true;
  const declaration = initializer.declarations[0];
  if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer) return true;
  if (!isNumericValue(declaration.initializer, 0)) return true;
  const name = declaration.name.text;
  const condition = node.condition;
  if (!condition || !ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return true;
  if (!ts.isIdentifier(condition.left) || condition.left.text !== name) return true;
  const limit = numericValue(condition.right);
  if (limit === undefined || limit <= 0) return true;
  const increment = node.incrementor;
  if (!increment) return true;
  if (
    (ts.isPostfixUnaryExpression(increment) || ts.isPrefixUnaryExpression(increment)) &&
    increment.operator === ts.SyntaxKind.PlusPlusToken &&
    ts.isIdentifier(increment.operand) &&
    increment.operand.text === name
  ) {
    return false;
  }
  if (
    ts.isBinaryExpression(increment) &&
    increment.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    ts.isIdentifier(increment.left) &&
    increment.left.text === name &&
    isNumericValue(increment.right, 1)
  ) {
    return false;
  }
  return true;
}

function catchRethrows(clause: ts.CatchClause): boolean {
  return blockThrows(clause.block);
}

function blockThrows(block: ts.Block): boolean {
  for (const statement of block.statements) {
    if (statementThrows(statement)) return true;
  }
  return false;
}

function statementThrows(statement: ts.Statement): boolean {
  if (ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) return blockThrows(statement);
  return false;
}

function isIterationCallback(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (!parent.arguments.some((argument) => argument === node)) return false;
  const expr = unwrap(parent.expression);
  return ts.isPropertyAccessExpression(expr) && ITERATION_METHODS.has(expr.name.text);
}

function readLiteral(expr: ts.Expression): ScalarLiteral | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { kind: 'string', value: expr.text };
  if (ts.isNumericLiteral(expr)) return { kind: 'number', value: Number(expr.text) };
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'boolean', value: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'boolean', value: false };
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null' };
  if (ts.isIdentifier(expr) && expr.text === 'undefined') return { kind: 'undefined' };
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return { kind: 'number', value: -Number(expr.operand.text) };
  }
  return undefined;
}

function numericValue(expr: ts.Expression): number | undefined {
  const literal = readLiteral(unwrap(expr));
  if (literal?.kind === 'number') return literal.value;
  return undefined;
}

function isNumericValue(expr: ts.Expression, expected: number): boolean {
  return numericValue(expr) === expected;
}

function functionKey(fn: FunctionBody): string {
  return `${fn.filePath}#${fn.ownerClass?.name ?? ''}#${fn.name}`;
}

function calleeName(node: ts.Node): string {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const expr = node.expression ? unwrap(node.expression) : undefined;
    if (expr && ts.isIdentifier(expr)) return expr.text;
    if (expr && ts.isPropertyAccessExpression(expr)) return expr.name.text;
  }
  return 'helper';
}

function seedPageNames(parameters: readonly ts.ParameterDeclaration[], pageNames: Set<string>): void {
  for (const param of parameters) {
    if (ts.isIdentifier(param.name)) {
      if (param.name.text === 'page' || isPageType(param.type)) pageNames.add(param.name.text);
      continue;
    }
    if (!ts.isObjectBindingPattern(param.name)) continue;
    for (const element of param.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const property =
        element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
      if (property === 'page') pageNames.add(element.name.text);
    }
  }
}

function isFunctionLike(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
}

function callbackOf(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let index = call.arguments.length - 1; index >= 0; index -= 1) {
    const arg = call.arguments[index];
    if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return arg;
  }
  return undefined;
}

function isAwaited(node: ts.Node): boolean {
  let parent = node.parent;
  while (parent && isTransparent(parent) && !ts.isAwaitExpression(parent)) parent = parent.parent;
  return !!parent && ts.isAwaitExpression(parent);
}

function isTransparent(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node)
  );
}

function unwrap(expr: ts.Expression): ts.Expression {
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

function positionOf(node: ts.Node, sourceFile: ts.SourceFile): { line: number; column: number } {
  const located = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: located.line + 1, column: located.character + 1 };
}
