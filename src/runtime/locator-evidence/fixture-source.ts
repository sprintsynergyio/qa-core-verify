/** Generated into the temp workspace. Playwright loads it instead of `@playwright/test`. */
export function locatorFixtureSource(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect as baseExpect } from '@playwright/test';

export * from '@playwright/test';

const wrapped = Symbol('qcvWrapped');
const storeKey = Symbol('qcvStore');
const parentKey = Symbol('qcvParent');
const nthKey = Symbol('qcvNth');
const evidenceDir = process.env.QCV_EVIDENCE_DIR || '';
let pendingRecords = 0;

const CHAIN = ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'filter', 'and', 'or', 'first', 'last', 'nth', 'frameLocator'];
const NARROW = new Set(['first', 'last', 'nth']);
const ACTIONS = ['click', 'dblclick', 'tap', 'fill', 'press', 'pressSequentially', 'type', 'check', 'uncheck', 'selectOption', 'setInputFiles', 'hover', 'focus', 'clear', 'dragTo'];

function isLocator(value) {
  return !!value && typeof value.count === 'function' && typeof value._selector === 'string';
}

function isFrameLocator(value) {
  return !!value && !isLocator(value) && typeof value.locator === 'function' && typeof value.frameLocator === 'function';
}

function callStack() {
  return new Error().stack || '';
}

function noteEvidenceError(error) {
  const message = error && error.message ? String(error.message) : String(error);
  try {
    fs.writeSync(2, 'QCV_EVIDENCE_ERROR: ' + message + '\\n');
  } catch {
    // stderr may already be closed.
  }
  try {
    if (!evidenceDir) return;
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.appendFileSync(path.join(evidenceDir, 'errors.txt'), message + '\\n');
  } catch {
    // The stderr line is the record the parent reads if this file cannot be written.
  }
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

function persistRecord(entry, store) {
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = partFile(store);
  assertWorkspaceWrite(file);
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(entry) + '\\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function readCount(locator) {
  try {
    const matchCount = await locator.count();
    if (typeof matchCount === 'number' && Number.isInteger(matchCount) && matchCount >= 0) return matchCount;
  } catch {
    return null;
  }
  return null;
}

function absenceOption(name, args) {
  const options = args.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg));
  if (!options) return false;
  if (name === 'toBeVisible') return options.visible === false;
  if (name === 'toBeAttached') return options.attached === false;
  return false;
}

function listLength(name, args) {
  if (name !== 'toHaveText' && name !== 'toContainText') return null;
  const first = args[0];
  return Array.isArray(first) ? first.length : null;
}

async function record(store, locator, phase, call, negated, succeeded, stack, countExpected, optionAbsence) {
  pendingRecords += 1;
  try {
    const counted = await readCount(locator);
    let parentCount = null;
    const parent = locator[parentKey];
    if (parent && typeof parent.count === 'function') parentCount = await readCount(parent);
    const actionSucceeded = phase === 'action' && succeeded === true;
    if (counted === null && !actionSucceeded) return;
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
    const entry = {
      selector,
      api,
      url,
      matchCount: counted,
      phase,
      call,
      negated,
      actionSucceeded,
      resolvedOnAction: actionSucceeded,
      parentCount,
      countExpected: typeof countExpected === 'number' ? countExpected : null,
      nthIndex: typeof locator[nthKey] === 'number' ? locator[nthKey] : null,
      optionAbsence: optionAbsence === true,
      stack,
      testFile: store.testInfo.file,
      testLine: store.testInfo.line,
      testColumn: typeof store.testInfo.column === 'number' ? store.testInfo.column : 0,
      testTitle: store.testInfo.titlePath.slice(1).join(' > ') || store.testInfo.title,
    };
    store.bucket.push(entry);
    persistRecord(entry, store);
  } catch (error) {
    noteEvidenceError(error);
  } finally {
    pendingRecords -= 1;
  }
}

function remember(created, store) {
  if (isLocator(created)) return wrapLocator(created, store);
  if (isFrameLocator(created)) return wrapFrame(created, store);
  return created;
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
      const wrappedChild = remember(child, store);
      if (NARROW.has(name) && wrappedChild && typeof wrappedChild === 'object') {
        try {
          wrappedChild[parentKey] = locator;
          if (name === 'nth' && typeof args[0] === 'number') wrappedChild[nthKey] = args[0];
        } catch {
          // A sealed child still returns. The parent count stays unset.
        }
      }
      return wrappedChild;
    };
  }
  for (const name of ACTIONS) {
    const original = locator[name];
    if (typeof original !== 'function') continue;
    locator[name] = async function (...args) {
      const stack = callStack();
      try {
        const result = await original.apply(locator, args);
        await record(store, locator, 'action', name, false, true, stack, null, false);
        return result;
      } catch (error) {
        await record(store, locator, 'action', name, false, false, stack, null, false);
        throw error;
      }
    };
  }
  const originalContentFrame = locator.contentFrame;
  if (typeof originalContentFrame === 'function') {
    locator.contentFrame = async function (...args) {
      const frame = await originalContentFrame.apply(locator, args);
      if (!frame) return frame;
      return wrapFrame(frame, store);
    };
  }
  return locator;
}

function wrapFrame(frame, store) {
  if (!frame || frame[wrapped]) return frame;
  try {
    frame[wrapped] = true;
  } catch {
    return frame;
  }
  for (const name of CHAIN) {
    const original = frame[name];
    if (typeof original !== 'function') continue;
    frame[name] = function (...args) {
      return remember(original.apply(frame, args), store);
    };
  }
  return frame;
}

function wrapPage(page, store) {
  if (!page || page[wrapped]) return page;
  try {
    page[wrapped] = true;
  } catch {
    return page;
  }
  for (const name of CHAIN) {
    const original = page[name];
    if (typeof original !== 'function') continue;
    const bound = original.bind(page);
    page[name] = (...args) => remember(bound(...args), store);
  }
  return page;
}

function wrapContext(context, store) {
  if (!context || context[wrapped]) return context;
  try {
    context[wrapped] = true;
  } catch {
    return context;
  }
  const originalNewPage = context.newPage;
  if (typeof originalNewPage === 'function') {
    context.newPage = async function (...args) {
      const created = await originalNewPage.apply(context, args);
      return wrapPage(created, store);
    };
  }
  if (typeof context.on === 'function') {
    context.on('page', (page) => {
      wrapPage(page, store);
    });
  }
  return context;
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
        const stack = callStack();
        const countedArg = prop === 'toHaveCount' && typeof args[0] === 'number' ? args[0] : null;
        const listed = listLength(String(prop), args);
        const countExpected = countedArg === null ? listed : countedArg;
        const optionAbsence = absenceOption(String(prop), args);
        try {
          return await value.apply(target, args);
        } finally {
          await record(store, actual, 'assertion', String(prop), negated, false, stack, countExpected, optionAbsence);
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
      wrapContext(page.context(), store);
      await use(wrapPage(page, store));
    } finally {
      const deadline = Date.now() + 2000;
      while (pendingRecords > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  },
});

function wrapExpect(expectFn) {
  return new Proxy(expectFn, {
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
      if (prop === 'configure') {
        const configure = Reflect.get(target, prop, receiver);
        if (typeof configure !== 'function') return configure;
        return function (...args) {
          const configured = Reflect.apply(configure, target, args);
          return wrapExpect(configured);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const expect = wrapExpect(baseExpect);

export default test;
`;
}
