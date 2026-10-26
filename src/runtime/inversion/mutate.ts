import ts from 'typescript';

/**
 * Matchers Playwright 1.60.0 ships on `expect`.
 * `toPass` is in this set and is still skipped: `.not` is not a meaningful inversion.
 */
const PLAYWRIGHT_MATCHERS = new Set([
  'toBe',
  'toBeAttached',
  'toBeChecked',
  'toBeCloseTo',
  'toBeDefined',
  'toBeDisabled',
  'toBeEditable',
  'toBeEmpty',
  'toBeEnabled',
  'toBeFalsy',
  'toBeFocused',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeHidden',
  'toBeInViewport',
  'toBeInstanceOf',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeNaN',
  'toBeNull',
  'toBeOK',
  'toBeTruthy',
  'toBeUndefined',
  'toBeVisible',
  'toContain',
  'toContainEqual',
  'toContainText',
  'toEqual',
  'toHaveAccessibleDescription',
  'toHaveAccessibleErrorMessage',
  'toHaveAccessibleName',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveCount',
  'toHaveCSS',
  'toHaveId',
  'toHaveJSProperty',
  'toHaveLength',
  'toHaveProperty',
  'toHaveRole',
  'toHaveScreenshot',
  'toHaveText',
  'toHaveTitle',
  'toHaveURL',
  'toHaveValue',
  'toHaveValues',
  'toMatch',
  'toMatchAriaSnapshot',
  'toMatchObject',
  'toPass',
  'toStrictEqual',
  'toThrow',
  'toThrowError',
]);

export interface MutationPlan {
  line: number;
  column: number;
  matcher: string;
  /** The expect call as it is written, including `.soft` and `.poll` when present. */
  source: string;
  not: boolean;
  soft: boolean;
  poll: boolean;
  kind: 'invert' | 'skip';
  /** Why inversion was skipped. Set only when `kind` is `skip`. */
  reason?: string;
  /** The file with this one assertion inverted. Absent when `kind` is `skip`. */
  mutated?: string;
}

interface ExpectChain {
  not: boolean;
  soft: boolean;
  poll: boolean;
  /** Start of the `.not` identifier, when `not` is true. */
  notNameStart?: number;
  /** End of the `.not` identifier, when `not` is true. */
  notNameEnd?: number;
}

/**
 * One plan per `expect` call. `.not` is added when it is absent and removed when it is present.
 * `.soft` and `.poll` stay. `toPass` and custom matchers are skipped with a reason.
 * `line` and `column` are the start of the `expect(...)` call, the same site the inventory records.
 */
export function planMutations(fileName: string, text: string): MutationPlan[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const expects = expectNames(sourceFile);
  const plans: MutationPlan[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const matcher = node.expression.name.text;
      if (matcher !== 'not' && matcher !== 'soft' && matcher !== 'poll' && matcher !== 'resolves' && matcher !== 'rejects') {
        const chain = readChain(node.expression.expression, expects);
        if (chain) {
          const start = node.getStart(sourceFile);
          const pos = sourceFile.getLineAndCharacterOfPosition(start);
          const source = node.getText(sourceFile);
          if (matcher === 'toPass') {
            plans.push({
              line: pos.line + 1,
              column: pos.character + 1,
              matcher,
              source,
              not: chain.not,
              soft: chain.soft,
              poll: chain.poll,
              kind: 'skip',
              reason: 'toPass retries until its callback passes, so adding or removing .not is not a meaningful inversion.',
            });
          } else if (!PLAYWRIGHT_MATCHERS.has(matcher)) {
            plans.push({
              line: pos.line + 1,
              column: pos.character + 1,
              matcher,
              source,
              not: chain.not,
              soft: chain.soft,
              poll: chain.poll,
              kind: 'skip',
              reason: `Custom matcher ${matcher} is not inverted.`,
            });
          } else {
            plans.push({
              line: pos.line + 1,
              column: pos.character + 1,
              matcher,
              source,
              not: chain.not,
              soft: chain.soft,
              poll: chain.poll,
              kind: 'invert',
              mutated: invertCall(text, node, sourceFile, chain),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  plans.sort((left, right) => left.line - right.line || left.column - right.column || left.matcher.localeCompare(right.matcher));
  return plans;
}

function invertCall(text: string, call: ts.CallExpression, sourceFile: ts.SourceFile, chain: ExpectChain): string {
  const matcher = call.expression;
  if (!ts.isPropertyAccessExpression(matcher)) return text;
  if (chain.not && chain.notNameStart !== undefined && chain.notNameEnd !== undefined) {
    const dot = dotBefore(text, chain.notNameStart);
    return text.slice(0, dot) + text.slice(chain.notNameEnd);
  }
  const nameStart = matcher.name.getStart(sourceFile);
  return text.slice(0, nameStart) + 'not.' + text.slice(nameStart);
}

/** Index of the `.` that introduces `not`, scanning back over spaces. */
function dotBefore(text: string, nameStart: number): number {
  let index = nameStart;
  while (index > 0 && (text[index - 1] === ' ' || text[index - 1] === '\t')) index -= 1;
  if (index > 0 && text[index - 1] === '.') return index - 1;
  return nameStart;
}

function readChain(expr: ts.Expression, expects: ReadonlySet<string>): ExpectChain | null {
  const unwrapped = unwrap(expr);
  if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === 'not') {
    const inner = readChain(unwrapped.expression, expects);
    if (!inner || inner.not) return null;
    return {
      ...inner,
      not: true,
      notNameStart: unwrapped.name.getStart(),
      notNameEnd: unwrapped.name.getEnd(),
    };
  }
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    (unwrapped.name.text === 'resolves' || unwrapped.name.text === 'rejects' || unwrapped.name.text === 'soft' || unwrapped.name.text === 'poll')
  ) {
    const inner = readChain(unwrapped.expression, expects);
    if (!inner) return null;
    if (unwrapped.name.text === 'soft') return { ...inner, soft: true };
    if (unwrapped.name.text === 'poll') return { ...inner, poll: true };
    return inner;
  }
  if (!ts.isCallExpression(unwrapped)) return null;
  const callee = unwrap(unwrapped.expression);
  if (ts.isIdentifier(callee) && expects.has(callee.text)) return { not: false, soft: false, poll: false };
  if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'soft' || callee.name.text === 'poll')) {
    const base = unwrap(callee.expression);
    if (ts.isIdentifier(base) && expects.has(base.text)) {
      return { not: false, soft: callee.name.text === 'soft', poll: callee.name.text === 'poll' };
    }
  }
  return null;
}

/** `expect` bindings: the import, `const` aliases, and `expect.configure()`. `let` and `var` are not followed. */
function expectNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause && isPlaywright(node.moduleSpecifier)) {
      const named = node.importClause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === 'expect') names.add(element.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isConst(node)) {
      const init = unwrap(node.initializer);
      if (ts.isIdentifier(init) && names.has(init.text)) names.add(node.name.text);
      if (ts.isCallExpression(init) && isConfigure(init, names)) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function isConfigure(call: ts.CallExpression, names: ReadonlySet<string>): boolean {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'configure') return false;
  const base = unwrap(callee.expression);
  return ts.isIdentifier(base) && names.has(base.text);
}

function isConst(node: ts.VariableDeclaration): boolean {
  const list = node.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
}

function isPlaywright(expr: ts.Expression): boolean {
  return ts.isStringLiteral(expr) && (expr.text === '@playwright/test' || expr.text === 'playwright/test');
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
