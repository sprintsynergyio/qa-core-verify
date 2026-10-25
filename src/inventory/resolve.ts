import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Parsed shape of one local function, arrow, or class method.
 * The file is parsed only. Nothing in it is executed.
 */
export interface FunctionBody {
  name: string;
  sourceFile: ts.SourceFile;
  filePath: string;
  parameters: readonly ts.ParameterDeclaration[];
  body: ts.ConciseBody;
  /** True when the function is declared `async`. */
  isAsync: boolean;
  exported: boolean;
  thisPage: boolean;
  ownerClass?: ClassBody;
  index: FileIndex;
}

/** An expression that defines a class field, captured so the walker can classify it later. */
export interface FieldBody {
  exprs: ts.Expression[];
  parameters: readonly ts.ParameterDeclaration[];
}

export interface ClassBody {
  name: string;
  exported: boolean;
  methods: Map<string, FunctionBody>;
  fields: Map<string, FieldBody>;
  thisPage: boolean;
  index: FileIndex;
}

export interface ImportRef {
  specifier: string;
  exportName: string;
  kind: 'named' | 'default' | 'namespace';
}

export interface FileIndex {
  filePath: string;
  sourceFile: ts.SourceFile;
  functions: Map<string, FunctionBody>;
  classes: Map<string, ClassBody>;
  imports: Map<string, ImportRef>;
}

const cache = new Map<string, FileIndex | null>();

export function indexParsedFile(sourceFile: ts.SourceFile): FileIndex {
  const cached = cache.get(sourceFile.fileName);
  if (cached) return cached;
  const index = buildIndex(sourceFile);
  cache.set(sourceFile.fileName, index);
  return index;
}

/** Load a relative module next to `fromFile`. Missing and unreadable files are skipped. */
export function loadRelative(fromFile: string, specifier: string): FileIndex | undefined {
  if (!isRelativeSpecifier(specifier)) return undefined;
  const resolved = resolveModule(fromFile, specifier);
  if (!resolved) return undefined;
  if (cache.has(resolved)) {
    const cached = cache.get(resolved);
    return cached ?? undefined;
  }
  const text = fs.readFileSync(resolved, 'utf8');
  const sourceFile = ts.createSourceFile(resolved, text, ts.ScriptTarget.ES2022, true, scriptKindFor(resolved));
  const extra = sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  if (extra.parseDiagnostics && extra.parseDiagnostics.length > 0) {
    cache.set(resolved, null);
    return undefined;
  }
  const index = buildIndex(sourceFile);
  cache.set(resolved, index);
  return index;
}

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function buildIndex(sourceFile: ts.SourceFile): FileIndex {
  const index: FileIndex = {
    filePath: sourceFile.fileName,
    sourceFile,
    functions: new Map(),
    classes: new Map(),
    imports: new Map(),
  };
  for (const statement of sourceFile.statements) {
    collectImports(statement, index);
    collectFunctions(statement, index);
    collectClasses(statement, index);
  }
  return index;
}

function collectImports(statement: ts.Statement, index: FileIndex): void {
  if (!ts.isImportDeclaration(statement) || !statement.importClause) return;
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
  const specifier = statement.moduleSpecifier.text;
  const clause = statement.importClause;
  if (clause.name) {
    index.imports.set(clause.name.text, { specifier, exportName: 'default', kind: 'default' });
  }
  const named = clause.namedBindings;
  if (!named) return;
  if (ts.isNamespaceImport(named)) {
    index.imports.set(named.name.text, { specifier, exportName: '*', kind: 'namespace' });
    return;
  }
  for (const element of named.elements) {
    const exported = element.propertyName?.text ?? element.name.text;
    index.imports.set(element.name.text, { specifier, exportName: exported, kind: 'named' });
  }
}

function collectFunctions(statement: ts.Statement, index: FileIndex): void {
  if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
    addFunction(
      index,
      statement.name.text,
      statement.parameters,
      statement.body,
      isExported(statement),
      functionIsAsync(statement),
      false,
    );
  }
  if (!ts.isVariableStatement(statement)) return;
  const exported = isExported(statement);
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const initializer = unwrap(declaration.initializer);
    if (!isFunctionLike(initializer) || !initializer.body) continue;
    addFunction(
      index,
      declaration.name.text,
      initializer.parameters,
      initializer.body,
      exported,
      functionIsAsync(initializer),
      false,
    );
  }
}

function collectClasses(statement: ts.Statement, index: FileIndex): void {
  if (!ts.isClassDeclaration(statement)) return;
  const exported = isExported(statement);
  const className = statement.name?.text;
  if (!className) return;
  const thisPage = classExposesPage(statement);
  const classBody: ClassBody = {
    name: className,
    exported,
    methods: new Map(),
    fields: new Map(),
    thisPage,
    index,
  };
  const ctor = statement.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member));
  const ctorParams = ctor?.parameters ?? [];
  const buckets = new Map<string, FieldBucket>();
  for (const member of statement.members) {
    if (ts.isMethodDeclaration(member) && member.body && ts.isIdentifier(member.name)) {
      const method = addFunction(
        index,
        member.name.text,
        member.parameters,
        member.body,
        exported,
        functionIsAsync(member),
        thisPage,
        classBody,
      );
      classBody.methods.set(member.name.text, method);
    }
    if (ts.isPropertyDeclaration(member) && member.initializer && ts.isIdentifier(member.name)) {
      fieldBucket(buckets, member.name.text).init = member.initializer;
    }
    if (ts.isGetAccessor(member) && member.body && ts.isIdentifier(member.name)) {
      fieldBucket(buckets, member.name.text).getter = returnExprs(member.body);
    }
  }
  if (ctor?.body) collectFieldAssignments(ctor.body, buckets);
  for (const [name, bucket] of buckets) {
    const fromCtor = bucket.assigns.length > 0;
    const exprs = fromCtor ? bucket.assigns : bucket.init ? [bucket.init] : bucket.getter;
    if (exprs.length === 0) continue;
    classBody.fields.set(name, { exprs, parameters: fromCtor ? ctorParams : [] });
  }
  index.classes.set(className, classBody);
  if (isDefaultExport(statement)) index.classes.set('default', classBody);
}

interface FieldBucket {
  init?: ts.Expression;
  assigns: ts.Expression[];
  getter: ts.Expression[];
}

function fieldBucket(buckets: Map<string, FieldBucket>, name: string): FieldBucket {
  const found = buckets.get(name);
  if (found) return found;
  const created: FieldBucket = { assigns: [], getter: [] };
  buckets.set(name, created);
  return created;
}

function collectFieldAssignments(body: ts.Block, buckets: Map<string, FieldBucket>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(node.left.name)
    ) {
      fieldBucket(buckets, node.left.name.text).assigns.push(node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

function returnExprs(body: ts.ConciseBody): ts.Expression[] {
  if (!ts.isBlock(body)) return [body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

export function functionIsAsync(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function addFunction(
  index: FileIndex,
  name: string,
  parameters: readonly ts.ParameterDeclaration[],
  body: ts.ConciseBody,
  exported: boolean,
  isAsync: boolean,
  thisPage: boolean,
  ownerClass?: ClassBody,
): FunctionBody {
  const fn: FunctionBody = {
    name,
    sourceFile: index.sourceFile,
    filePath: index.filePath,
    parameters,
    body,
    isAsync,
    exported,
    thisPage,
    index,
  };
  if (ownerClass) fn.ownerClass = ownerClass;
  if (!ownerClass) index.functions.set(name, fn);
  return fn;
}

function classExposesPage(node: ts.ClassDeclaration): boolean {
  const ctor = node.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member));
  if (!ctor) return false;
  for (const param of ctor.parameters) {
    if (!ts.isIdentifier(param.name)) continue;
    const isPage = param.name.text === 'page' || isPageType(param.type);
    if (!isPage) continue;
    if (isParameterProperty(param)) return true;
  }
  if (!ctor.body) return false;
  let assigned = false;
  const visit = (child: ts.Node): void => {
    if (assigned) return;
    if (
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(child.left) &&
      child.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      child.left.name.text === 'page'
    ) {
      assigned = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(ctor.body);
  return assigned;
}

function isParameterProperty(param: ts.ParameterDeclaration): boolean {
  return (
    param.modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PublicKeyword ||
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
        modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    ) ?? false
  );
}

export function isPageType(typeNode: ts.TypeNode | undefined): boolean {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return false;
  if (ts.isIdentifier(typeNode.typeName)) return typeNode.typeName.text === 'Page';
  return typeNode.typeName.getText() === 'Page';
}

function isExported(node: ts.Node): boolean {
  return modifierKinds(node).includes(ts.SyntaxKind.ExportKeyword);
}

function isDefaultExport(node: ts.Node): boolean {
  return modifierKinds(node).includes(ts.SyntaxKind.DefaultKeyword);
}

function modifierKinds(node: ts.Node): ts.SyntaxKind[] {
  if (!ts.canHaveModifiers(node)) return [];
  return (ts.getModifiers(node) ?? []).map((modifier) => modifier.kind);
}

function isFunctionLike(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
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

function resolveModule(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const extension = path.extname(base);
  const candidates = [base];
  if (extension) {
    const stem = base.slice(0, -extension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.js`, `${stem}.mjs`);
  } else {
    candidates.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.js`,
      `${base}.mjs`,
      path.join(base, 'index.ts'),
      path.join(base, 'index.js'),
    );
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
