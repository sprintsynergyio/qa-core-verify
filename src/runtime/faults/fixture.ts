/** Generated into the temp workspace. Playwright loads it instead of `@playwright/test`. */
export function faultFixtureSource(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect as baseExpect } from '@playwright/test';

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
let inTestBody = false;
let skipProxyFrame = false;
let state = null;

const originalCaptureStackTrace = Error.captureStackTrace;
Error.captureStackTrace = function(targetObject, constructorOpt) {
  if (skipProxyFrame && typeof Error.prepareStackTrace === 'function') {
    const prepare = Error.prepareStackTrace;
    const limit = Error.stackTraceLimit;
    // Playwright keeps two frames and reads frame 1 as the caller. This wrapper
    // is frame 0 and the proxy apply is frame 2, so the spec call is frame 3.
    Error.stackTraceLimit = Math.max(limit, 0) + 2;
    Error.prepareStackTrace = function(error, frames) {
      const user = frames.length > 3 ? frames[3] : frames[frames.length - 1];
      return prepare(error, [frames[0], user]);
    };
    skipProxyFrame = false;
  }
  return originalCaptureStackTrace.call(this, targetObject, constructorOpt);
};

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
  inTestBody = false;
  testLocalPages = new Set();
  testLocalContexts = new Set();
  for (const page of [...armedPages]) {
    if (page.isClosed()) armedPages.delete(page);
  }
  for (const context of [...armedContexts]) {
    if (contextIsClosed(context)) armedContexts.delete(context);
  }
  seenPages = new Set(armedPages);
  seenContexts = new Set(armedContexts);
  state = readFault() ? { blankChecks: 0, blankMisses: 0, counts: {} } : null;
}

function endTestScope() {
  for (const page of testLocalPages) armedPages.delete(page);
  for (const context of testLocalContexts) armedContexts.delete(context);
  testLocalPages.clear();
  testLocalContexts.clear();
  inTestBody = false;
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
  if (inTestBody) testLocalPages.add(page);
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
  if (fresh && inTestBody) testLocalContexts.add(context);
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
  try {
    snap = await page.evaluate(() => {
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
  } catch {
    return;
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

function wrapBody(fn) {
  if (typeof fn !== 'function' || fn.__qcvWrapped) return fn;
  const wrapped = async function(args, testInfo) {
    inTestBody = true;
    return await fn.call(this, args, testInfo);
  };
  wrapped.__qcvWrapped = true;
  wrapped.toString = function() {
    return fn.toString();
  };
  return wrapped;
}

function wrapTestArgs(args) {
  const copy = args.slice();
  for (let i = 0; i < copy.length; i++) {
    if (typeof copy[i] === 'function') copy[i] = wrapBody(copy[i]);
  }
  return copy;
}

function proxyTest(inner) {
  return new Proxy(inner, {
    apply(target, thisArg, args) {
      skipProxyFrame = true;
      try {
        return Reflect.apply(target, thisArg, wrapTestArgs(args));
      } finally {
        skipProxyFrame = false;
      }
    },
    get(target, prop, receiver) {
      if (prop === 'extend') {
        const extend = Reflect.get(target, prop, receiver);
        return function() {
          skipProxyFrame = true;
          try {
            return proxyTest(extend.apply(target, arguments));
          } finally {
            skipProxyFrame = false;
          }
        };
      }
      if (prop === 'only') {
        const only = Reflect.get(target, prop, receiver);
        return new Proxy(only, {
          apply(fn, thisArg, args) {
            skipProxyFrame = true;
            try {
              return Reflect.apply(fn, thisArg, wrapTestArgs(args));
            } finally {
              skipProxyFrame = false;
            }
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export const test = proxyTest(base.extend({
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
}));

export const expect = baseExpect;

export default test;
`;
}
