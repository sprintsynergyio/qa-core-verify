import ts from 'typescript';

const CHAIN = new Set(['then', 'catch', 'finally']);

function isTransparent(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node)
  );
}

function lift(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && isTransparent(current.parent) && !ts.isAwaitExpression(current.parent)) {
    current = current.parent;
  }
  return current;
}

/** The `.then`, `.catch`, or `.finally` call this node is the receiver of. */
export function chainCall(node: ts.Node): ts.CallExpression | undefined {
  const lifted = lift(node);
  const parent = lifted.parent;
  if (!parent || !ts.isPropertyAccessExpression(parent) || parent.expression !== lifted) return undefined;
  if (!CHAIN.has(parent.name.text)) return undefined;
  const call = parent.parent;
  if (!call || !ts.isCallExpression(call) || call.expression !== parent) return undefined;
  return call;
}

/**
 * True when `node` is awaited directly or through an awaited
 * `.then` / `.catch` / `.finally` chain.
 */
export function isAwaited(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  const seen = new Set<ts.Node>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const lifted = lift(current);
    const parent = lifted.parent;
    if (parent && ts.isAwaitExpression(parent)) return true;
    const next = chainCall(current);
    if (!next || next === current) return false;
    current = next;
  }
  return false;
}
