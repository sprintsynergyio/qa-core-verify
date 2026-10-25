/** Generated into the temp workspace. Playwright loads it instead of `@playwright/test`. */
export function locatorFixtureSource(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect as baseExpect } from '@playwright/test';

const wrapped = Symbol('qcvWrapped');
const storeKey = Symbol('qcvStore');
const evidenceDir = process.env.QCV_EVIDENCE_DIR || '';
let pendingRecords = 0;

const CHAIN = ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'filter', 'and', 'or', 'first', 'last', 'nth'];
const ACTIONS = ['click', 'dblclick', 'tap', 'fill', 'press', 'pressSequentially', 'type', 'check', 'uncheck', 'selectOption', 'setInputFiles', 'hover', 'focus', 'clear', 'dragTo'];

function isLocator(value) {
  return !!value && typeof value.count === 'function' && typeof value._selector === 'string';
}

function callStack() {
  return new Error().stack || '';
}

function assertWorkspaceWrite(file) {
  const root = process.env.QCV_WORKSPACE_DIR || '';
  if (!root) throw new Error('Refusing to write ' + file + ' because the temp workspace is not set.');
  const realRoot = fs.realpathSync(root);
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (stat) {
    if (!stat.isFile()) throw new Error('Refusing to write ' + file + ' because it is not a regular file in the temp workspace.');
    const realFile = fs.realpathSync(file);
    const relative = path.relative(realRoot, realFile);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Refusing to write ' + file + ' because it is outside the temp workspace.');
    }
    return;
  }
  const parent = path.dirname(file);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory()) throw new Error('Refusing to write ' + file + ' because its parent is not a real directory in the temp workspace.');
  const realParent = fs.realpathSync(parent);
  const relativeParent = path.relative(realRoot, realParent);
  if (relativeParent === '..' || relativeParent.startsWith('..' + path.sep) || path.isAbsolute(relativeParent)) {
    throw new Error('Refusing to write ' + file + ' because it is outside the temp workspace.');
  }
}

function partFile(store) {
  const name = [store.testInfo.testId, String(store.testInfo.retry), String(store.testInfo.repeatEachIndex)].join('-').replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(evidenceDir, name + '.json');
}

function persistStore(store) {
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = partFile(store);
  assertWorkspaceWrite(file);
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(store.bucket));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function record(store, locator, phase, call, negated, succeeded) {
  pendingRecords += 1;
  try {
    let matchCount = null;
    let counted = false;
    try {
      matchCount = await locator.count();
      counted = typeof matchCount === 'number' && Number.isInteger(matchCount) && matchCount >= 0;
    } catch {
      counted = false;
    }
    if (!counted) return;
    const actionSucceeded = phase === 'action' && succeeded === true;
    let url = '';
    try {
      const owner = typeof locator.page === 'function' ? locator.page() : store.page;
      url = owner.url();
    } catch {
      url = '';
    }
    let api = '';
    try {
      api = typeof locator.toString === 'function' ? locator.toString() : '';
    } catch {
      api = '';
    }
    let selector = '';
    try {
      if (typeof locator._selector === 'string') selector = locator._selector;
    } catch {
      selector = '';
    }
    store.bucket.push({
      selector,
      api,
      url,
      matchCount,
      phase,
      call,
      negated,
      actionSucceeded,
      resolvedOnAction: actionSucceeded,
      stack: callStack(),
      testFile: store.testInfo.file,
      testLine: store.testInfo.line,
      testTitle: store.testInfo.titlePath.slice(1).join(' > ') || store.testInfo.title,
    });
    persistStore(store);
  } catch {
    // A later field read failed. The count was not invented, and this call stays unrecorded.
  } finally {
    pendingRecords -= 1;
  }
}

function wrapLocator(locator, store) {
  if (!isLocator(locator) || locator[wrapped]) return locator;
  locator[wrapped] = true;
  locator[storeKey] = store;
  for (const name of CHAIN) {
    const original = locator[name];
    if (typeof original !== 'function') continue;
    locator[name] = function (...args) {
      const child = original.apply(locator, args);
      if (child && typeof child === 'object') wrapLocator(child, store);
      return child;
    };
  }
  for (const name of ACTIONS) {
    const original = locator[name];
    if (typeof original !== 'function') continue;
    locator[name] = async function (...args) {
      try {
        const result = await original.apply(locator, args);
        await record(store, locator, 'action', name, false, true);
        return result;
      } catch (error) {
        await record(store, locator, 'action', name, false, false);
        throw error;
      }
    };
  }
  return locator;
}

function wrapPage(page, store) {
  for (const name of ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'frameLocator']) {
    const original = page[name];
    if (typeof original !== 'function') continue;
    const bound = original.bind(page);
    page[name] = (...args) => {
      const created = bound(...args);
      if (created && typeof created === 'object') wrapLocator(created, store);
      return created;
    };
  }
  return page;
}

function wrapMatcherResult(result, actual, store, negated) {
  return new Proxy(result, {
    get(target, prop, receiver) {
      if (prop === 'not') {
        const value = Reflect.get(target, prop, receiver);
        return wrapMatcherResult(value, actual, store, !negated);
      }
      if (prop === 'soft' || prop === 'poll' || prop === 'resolves' || prop === 'rejects') {
        const value = Reflect.get(target, prop, receiver);
        return wrapMatcherResult(value, actual, store, negated);
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args) => {
        try {
          return await value.apply(target, args);
        } finally {
          await record(store, actual, 'assertion', String(prop), negated, false);
        }
      };
    },
  });
}

function callExpect(expectFn, thisArg, args) {
  const actual = args[0];
  const result = Reflect.apply(expectFn, thisArg, args);
  const store = actual && actual[storeKey];
  if (!store || !isLocator(actual)) return result;
  return wrapMatcherResult(result, actual, store, false);
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const store = { testInfo, page, bucket: [] };
    try {
      await use(wrapPage(page, store));
    } finally {
      const deadline = Date.now() + 2000;
      while (pendingRecords > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (evidenceDir) persistStore(store);
    }
  },
});

export const expect = new Proxy(baseExpect, {
  apply(target, thisArg, args) {
    return callExpect(target, thisArg, args);
  },
  get(target, prop, receiver) {
    if (prop === 'soft') {
      const soft = Reflect.get(target, prop, receiver);
      return new Proxy(soft, {
        apply(softTarget, thisArg, args) {
          return callExpect(softTarget, thisArg, args);
        },
      });
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

`;
}
