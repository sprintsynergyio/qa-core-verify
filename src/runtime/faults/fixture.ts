/** Generated into the temp workspace. Playwright loads it instead of `@playwright/test`. */
export function faultFixtureSource(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect as baseExpect, mergeTests as baseMergeTests } from '@playwright/test';

export * from '@playwright/test';

const instrumentedContexts = new WeakSet();
const armedContexts = new Set();
const closedContexts = new WeakSet();
const armedPages = new Set();
const trackedPages = new WeakSet();
const wrappedBrowsers = new WeakSet();
let seenPages = new Set();
let seenContexts = new Set();
let testLocalPages = new Set();
let testLocalContexts = new Set();
let carriedPages = new Set();
let carriedContexts = new Set();
let inTestScope = false;
let fixtureScope = '';
let skipProxyFrame = false;
let state = null;

const originalCaptureStackTrace = Error.captureStackTrace;
const originalPrepareStackTrace = Error.prepareStackTrace;
function qcvCaptureStackTrace(targetObject, constructorOpt) {
  // QCV_TEST_LOCATION_DRIFT is test-only. It forces wrong locations so the drift guard can be tested.
  // Do not set it. A fault run then exits 2. user-swap cannot set it, because QCV_ names are refused.
  const hideWrapper = process.env.QCV_TEST_LOCATION_DRIFT === '1' || skipProxyFrame;
  skipProxyFrame = false;
  const limit = Error.stackTraceLimit;
  const prepare = Error.prepareStackTrace;
  // Playwright 1.60 sets stackTraceLimit to 2 and reads frame 1.
  // constructorOpt drops this wrapper. extend() adds one frame beyond that.
  const extra = hideWrapper ? 2 : 1;
  Error.stackTraceLimit = Math.max(limit, 0) + extra;
  if (hideWrapper && typeof prepare === 'function') {
    Error.prepareStackTrace = function(error, frames) {
      const user = frames.length > 2 ? frames[2] : frames[frames.length - 1];
      return prepare(error, [frames[0], user]);
    };
  }
  try {
    return originalCaptureStackTrace(targetObject, constructorOpt || qcvCaptureStackTrace);
  } finally {
    Error.stackTraceLimit = limit;
    // prepareStackTrace stays until the caller reads error.stack. The worker exit handler restores it.
  }
}
Error.captureStackTrace = qcvCaptureStackTrace;
function restoreStackHooks() {
  Error.captureStackTrace = originalCaptureStackTrace;
  Error.prepareStackTrace = originalPrepareStackTrace;
}
// The worker process is already finished when this runs. It does not change fault results.
process.on('exit', restoreStackHooks);
export { restoreStackHooks };

function readFault() {
  const raw = process.env.QCV_FAULT;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isDom(fault) {
  return fault.type === 'blank-app' || fault.type === 'remove-element' || fault.type === 'hide-element' || fault.type === 'change-text';
}

function isBlock(fault) {
  return fault.type === 'block-request' && fault.params && typeof fault.params.urlPattern === 'string';
}

function contextIsClosed(context) {
  if (closedContexts.has(context)) return true;
  try {
    context.pages();
    return false;
  } catch {
    closedContexts.add(context);
    return true;
  }
}

function beginTestScope() {
  inTestScope = true;
  testLocalPages = new Set();
  testLocalContexts = new Set();
  for (const page of [...armedPages]) {
    if (page.isClosed()) armedPages.delete(page);
  }
  for (const context of [...armedContexts]) {
    if (contextIsClosed(context)) armedContexts.delete(context);
  }
  carriedPages = new Set(armedPages);
  carriedContexts = new Set(armedContexts);
  seenPages = new Set(armedPages);
  seenContexts = new Set(armedContexts);
  state = readFault() ? { blankChecks: 0, blankMisses: 0, blankUnknown: 0, counts: {} } : null;
}

function endTestScope() {
  for (const page of testLocalPages) armedPages.delete(page);
  for (const context of testLocalContexts) armedContexts.delete(context);
  testLocalPages.clear();
  testLocalContexts.clear();
  inTestScope = false;
}

function ownedByThisTest(carried, item) {
  return inTestScope && fixtureScope !== 'worker' && !carried.has(item);
}

function domScript(fault) {
  const payload = JSON.stringify({
    type: fault.type,
    selector: fault.params && typeof fault.params.selector === 'string' ? fault.params.selector : '',
    text: fault.params && typeof fault.params.text === 'string' ? fault.params.text : '',
  });
  return '(function () {\\n' +
    '  var fault = ' + payload + ';\\n' +
    '  var applying = false;\\n' +
    '  function alreadyBlank(body) {\\n' +
    '    return body.childNodes.length === 1 && body.firstElementChild && body.firstElementChild.getAttribute("data-qcv-blank") === "1" && body.firstElementChild.childNodes.length === 0;\\n' +
    '  }\\n' +
    '  function apply() {\\n' +
    '    if (applying || !document.body) return;\\n' +
    '    applying = true;\\n' +
    '    try {\\n' +
    '      if (fault.type === "blank-app") {\\n' +
    '        if (!alreadyBlank(document.body)) {\\n' +
    '          var empty = document.createElement("div");\\n' +
    '          empty.setAttribute("data-qcv-blank", "1");\\n' +
    '          document.body.replaceChildren(empty);\\n' +
    '        }\\n' +
    '      } else if (fault.type === "remove-element" && fault.selector) {\\n' +
    '        document.querySelectorAll(fault.selector).forEach(function (node) { node.remove(); });\\n' +
    '      } else if (fault.type === "hide-element" && fault.selector) {\\n' +
    '        document.querySelectorAll(fault.selector).forEach(function (node) {\\n' +
    '          if (node.style.getPropertyValue("display") !== "none") node.style.setProperty("display", "none", "important");\\n' +
    '          if (node.getAttribute("data-qcv-hidden") !== "1") node.setAttribute("data-qcv-hidden", "1");\\n' +
    '        });\\n' +
    '      } else if (fault.type === "change-text" && fault.selector) {\\n' +
    '        document.querySelectorAll(fault.selector).forEach(function (node) {\\n' +
    '          if (node.textContent !== fault.text) node.textContent = fault.text;\\n' +
    '        });\\n' +
    '      }\\n' +
    '      var counts = {};\\n' +
    '      if (fault.selector) {\\n' +
    '        try { counts[fault.selector] = document.querySelectorAll(fault.selector).length; }\\n' +
    '        catch (error) { counts[fault.selector] = 0; }\\n' +
    '      }\\n' +
    '      window.__qcvFaultCounts = counts;\\n' +
    '    } finally {\\n' +
    '      applying = false;\\n' +
    '    }\\n' +
    '  }\\n' +
    '  function arm() {\\n' +
    '    apply();\\n' +
    '    var root = document.documentElement || document;\\n' +
    '    var observer = new MutationObserver(function () { apply(); });\\n' +
    '    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });\\n' +
    '  }\\n' +
    '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arm);\\n' +
    '  else arm();\\n' +
    '})();\\n';
}

function trackPage(page, fault) {
  if (!page || page.isClosed()) return;
  seenPages.add(page);
  armedPages.add(page);
  if (trackedPages.has(page)) return;
  trackedPages.add(page);
  if (ownedByThisTest(carriedPages, page)) testLocalPages.add(page);
  const originalClose = page.close.bind(page);
  page.close = async (options) => {
    try {
      await rememberPage(page, fault);
    } catch {
      // The page is closing. The snapshot above is the last look at the body.
    }
    return originalClose(options);
  };
  if (!isDom(fault)) return;
  const script = domScript(fault);
  const original = page.setContent.bind(page);
  page.setContent = async (html, options) => {
    const result = await original(html, options);
    try {
      await page.evaluate((source) => {
        (0, eval)(source);
      }, script);
    } catch {
      // setContent replaced the document. Teardown records whether the blank body is still there.
    }
    return result;
  };
}

async function armContext(context, fault) {
  if (!fault || !context) return;
  const fresh = !instrumentedContexts.has(context);
  if (fresh) {
    instrumentedContexts.add(context);
    context.on('close', () => {
      closedContexts.add(context);
      armedContexts.delete(context);
      testLocalContexts.delete(context);
    });
    if (isDom(fault)) await context.addInitScript({ content: domScript(fault) });
    if (isBlock(fault)) {
      const pattern = fault.params.urlPattern;
      await context.route(pattern, (route) => route.abort());
    }
    context.on('page', (page) => {
      trackPage(page, fault);
    });
    for (const page of context.pages()) trackPage(page, fault);
  }
  if (contextIsClosed(context)) return;
  armedContexts.add(context);
  seenContexts.add(context);
  if (fresh && ownedByThisTest(carriedContexts, context)) testLocalContexts.add(context);
}

async function rememberSeen(fault) {
  if (!state || !isDom(fault)) return;
  for (const page of [...seenPages]) {
    if (page.isClosed()) continue;
    await rememberPage(page, fault);
  }
}

async function rememberPage(page, fault) {
  if (!state || !isDom(fault) || !page || page.isClosed()) return;
  let snap;
  let timer;
  try {
    const check = page.evaluate(() => {
      const body = document.body;
      const node = body && body.firstElementChild;
      const blank = !!(
        body &&
        node &&
        body.childNodes.length === 1 &&
        node.getAttribute('data-qcv-blank') === '1' &&
        node.childNodes.length === 0
      );
      return { counts: window.__qcvFaultCounts || {}, blank };
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('qcv blank check timed out')), 1000);
    });
    void check.catch(() => undefined);
    snap = await Promise.race([check, timeout]);
  } catch {
    if (state && fault && fault.type === 'blank-app') {
      state.blankChecks += 1;
      state.blankUnknown += 1;
    }
    return;
  } finally {
    clearTimeout(timer);
  }
  if (snap.counts && typeof snap.counts === 'object') {
    for (const key of Object.keys(snap.counts)) {
      if (typeof snap.counts[key] === 'number') state.counts[key] = snap.counts[key];
    }
  }
  if (fault.type === 'blank-app') {
    state.blankChecks += 1;
    if (!snap.blank) state.blankMisses += 1;
  }
}

function writeLog(testInfo, fault) {
  const logFile = process.env.QCV_FAULT_LOG;
  if (!logFile || !fault || !state) return;
  const titlePath = Array.isArray(testInfo.titlePath) ? testInfo.titlePath : [testInfo.title || ''];
  const line = JSON.stringify({
    id: fault.id,
    file: testInfo.file,
    line: testInfo.line,
    column: testInfo.column,
    title: titlePath.join(' > '),
    armedPages: seenPages.size,
    armedContexts: seenContexts.size,
    blankChecks: state.blankChecks,
    blankMisses: state.blankMisses,
    blankUnknown: state.blankUnknown,
    counts: state.counts,
  });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, line + '\\n');
}

function installBrowser(browser) {
  if (wrappedBrowsers.has(browser)) return;
  wrappedBrowsers.add(browser);
  const originalNewContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await originalNewContext(options);
    const fault = readFault();
    if (fault) await armContext(context, fault);
    return context;
  };
  const originalNewPage = browser.newPage.bind(browser);
  browser.newPage = async (options) => {
    const page = await originalNewPage(options);
    const fault = readFault();
    if (fault) await armContext(page.context(), fault);
    return page;
  };
}

function wrapFixtureFn(fn, scope) {
  if (typeof fn !== 'function' || fn.__qcvFixture) return fn;
  const wrapped = async function(fixtures, use, info) {
    const previous = fixtureScope;
    fixtureScope = scope;
    try {
      return await fn.call(this, fixtures, async (value) => {
        fixtureScope = previous;
        try {
          await use(value);
        } finally {
          fixtureScope = scope;
        }
      }, info);
    } finally {
      fixtureScope = previous;
    }
  };
  wrapped.__qcvFixture = true;
  wrapped.toString = function() {
    return fn.toString();
  };
  return wrapped;
}

function wrapFixtureValue(value) {
  let scope = 'test';
  if (Array.isArray(value)) {
    const options = value[1];
    if (options && typeof options === 'object' && options.scope === 'worker') scope = 'worker';
    if (typeof value[0] !== 'function') return value;
    const copy = value.slice();
    copy[0] = wrapFixtureFn(value[0], scope);
    return copy;
  }
  if (typeof value === 'function') return wrapFixtureFn(value, scope);
  return value;
}

function wrapFixtureBag(bag) {
  const copy = {};
  for (const key of Object.keys(bag)) copy[key] = wrapFixtureValue(bag[key]);
  return copy;
}

function installExtend(inner) {
  const extend = inner.extend.bind(inner);
  inner.extend = function(fixtures) {
    skipProxyFrame = true;
    try {
      return installExtend(extend(wrapFixtureBag(fixtures)));
    } finally {
      skipProxyFrame = false;
    }
  };
  return inner;
}

export function mergeTests(...args) {
  return installExtend(baseMergeTests(...args));
}

export const test = installExtend(base.extend(wrapFixtureBag({
  _qcvFaultLog: [async ({}, use, testInfo) => {
    const fault = readFault();
    beginTestScope();
    try {
      await use();
      if (fault) {
        await rememberSeen(fault);
        writeLog(testInfo, fault);
      }
    } finally {
      endTestScope();
    }
  }, { auto: true }],
  browser: async ({ browser }, use) => {
    if (readFault()) installBrowser(browser);
    await use(browser);
  },
  context: async ({ context }, use) => {
    const fault = readFault();
    if (fault) await armContext(context, fault);
    await use(context);
  },
  page: async ({ page }, use) => {
    const fault = readFault();
    if (fault) {
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(15000);
      trackPage(page, fault);
    }
    await use(page);
    if (fault) await rememberPage(page, fault);
  },
})));

export const expect = baseExpect;

export default test;
`;
}
