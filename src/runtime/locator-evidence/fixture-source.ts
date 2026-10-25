/** Generated into the temp workspace. Playwright loads it instead of `@playwright/test`. */
export function locatorFixtureSource(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect as baseExpect } from '@playwright/test';

const wrapped = Symbol('qcvWrapped');
const storeKey = Symbol('qcvStore');
const evidenceDir = process.env.QCV_EVIDENCE_DIR || '';

const CHAIN = ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'filter', 'and', 'or', 'first', 'last', 'nth'];
const ACTIONS = ['click', 'dblclick', 'tap', 'fill', 'press', 'pressSequentially', 'type', 'check', 'uncheck', 'selectOption', 'setInputFiles', 'hover', 'focus', 'clear', 'dragTo'];

function isLocator(value) {
  return !!value && typeof value.count === 'function' && typeof value._selector === 'string';
}

function callStack() {
  return new Error().stack || '';
}

async function record(store, locator, phase, call, negated) {
  let matchCount = null;
  try {
    matchCount = await locator.count();
  } catch {
    return;
  }
  if (typeof matchCount !== 'number') return;
  let url = '';
  try {
    const owner = typeof locator.page === 'function' ? locator.page() : store.page;
    url = owner.url();
  } catch {
    url = '';
  }
  const api = typeof locator.toString === 'function' ? locator.toString() : '';
  store.bucket.push({
    selector: locator._selector,
    api,
    url,
    matchCount,
    phase,
    call,
    negated,
    stack: callStack(),
    testFile: store.testInfo.file,
    testLine: store.testInfo.line,
    testTitle: store.testInfo.titlePath.slice(1).join(' > ') || store.testInfo.title,
  });
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
      await record(store, locator, 'action', name, false);
      return original.apply(locator, args);
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
          await record(store, actual, 'assertion', String(prop), negated);
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
      if (evidenceDir) {
        fs.mkdirSync(evidenceDir, { recursive: true });
        const name = [testInfo.testId, String(testInfo.retry), String(testInfo.repeatEachIndex)].join('-').replace(/[^A-Za-z0-9._-]+/g, '_');
        fs.writeFileSync(path.join(evidenceDir, name + '.json'), JSON.stringify(store.bucket));
      }
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
