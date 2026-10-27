/** Generated into the temp workspace. Playwright loads it instead of `@playwright/test`. */
export function faultFixtureSource(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect as baseExpect } from '@playwright/test';

export * from '@playwright/test';

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

export const test = base.extend({
  page: async ({ page, context }, use, testInfo) => {
    const fault = readFault();
    if (fault) {
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(15000);
    }
    if (fault && fault.type === 'block-request' && fault.params && typeof fault.params.urlPattern === 'string') {
      const pattern = fault.params.urlPattern;
      await page.route(pattern, (route) => route.abort());
    }
    if (
      fault &&
      (fault.type === 'blank-app' ||
        fault.type === 'remove-element' ||
        fault.type === 'hide-element' ||
        fault.type === 'change-text')
    ) {
      await context.addInitScript({ content: domScript(fault) });
    }
    await use(page);
    const logFile = process.env.QCV_FAULT_LOG;
    if (!logFile || !fault) return;
    let counts = {};
    try {
      counts = await page.evaluate(() => window.__qcvFaultCounts || {});
    } catch {
      counts = {};
    }
    const line = JSON.stringify({
      id: fault.id,
      file: testInfo.file,
      line: testInfo.line,
      column: testInfo.column,
      title: testInfo.titlePath.join(' > '),
      counts,
    });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + '\\n');
  },
});

export const expect = baseExpect;

export default test;
`;
}
