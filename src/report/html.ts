import type { Report, ReportFinding, Verdict } from './model.js';
import { VERDICTS, trustNote } from './model.js';
import { collapseNewlines, displayText, preserveBlock } from './paths.js';

const VERDICT_LABEL: Record<Verdict, string> = {
  trusted: 'Trusted',
  review: 'Review',
  untrusted: 'Untrusted',
  'baseline-red': 'Baseline-Red',
  'not-run': 'Not Run',
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** One HTML file. Styles are inline. Filters use checkboxes, so the file makes no network requests. */
export function formatHtml(report: Report): string {
  const rules = [...new Set(report.tests.flatMap((test) => test.findings.map((finding) => finding.ruleId)))].sort();
  const parts: string[] = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en">');
  parts.push('<head>');
  parts.push('<meta charset="utf-8">');
  parts.push('<title>qa-core-verify Report</title>');
  parts.push(`<style>${css(rules)}</style>`);
  parts.push('</head>');
  parts.push('<body>');
  parts.push('<header>');
  parts.push('<h1>qa-core-verify Report</h1>');
  parts.push(
    `<p>${escapeHtml(report.tool.name)} ${escapeHtml(report.tool.version)}</p>`,
  );
  parts.push(`<p>Started ${escapeHtml(report.startedAt)}. Finished ${escapeHtml(report.finishedAt)}.</p>`);
  const checks = report.checksRun.length === 0 ? 'none' : report.checksRun.join(', ');
  parts.push(`<p>Checks run: ${escapeHtml(checks)}.</p>`);
  const note = trustNote(report.checksRun);
  if (note) parts.push(`<p>${escapeHtml(note)}</p>`);
  parts.push('</header>');
  parts.push('<section>');
  parts.push('<h2>Project</h2>');
  parts.push('<ul>');
  parts.push(`<li>Directory: ${escapeHtml(displayText(report.project.dir))}</li>`);
  parts.push(`<li>Config: ${escapeHtml(displayText(report.project.configFile ?? 'none'))}</li>`);
  parts.push(`<li>Specs: ${report.project.specCount}</li>`);
  parts.push(`<li>Tests: ${report.project.testCount}</li>`);
  parts.push('</ul>');
  parts.push('</section>');
  parts.push('<section>');
  parts.push('<h2>Summary</h2>');
  parts.push('<h3>Severity</h3>');
  parts.push('<ul>');
  parts.push(`<li>Error: ${report.summary.severity.error}</li>`);
  parts.push(`<li>Warning: ${report.summary.severity.warn}</li>`);
  parts.push(`<li>Info: ${report.summary.severity.info}</li>`);
  parts.push('</ul>');
  parts.push('<h3>Verdict</h3>');
  parts.push('<ul>');
  for (const verdict of VERDICTS) {
    parts.push(`<li>${escapeHtml(VERDICT_LABEL[verdict])}: ${report.summary.verdict[verdict]}</li>`);
  }
  parts.push('</ul>');
  parts.push('</section>');
  parts.push('<section class="filters">');
  parts.push('<h2>Filters</h2>');
  parts.push('<h3>Verdict</h3>');
  parts.push('<div class="choices">');
  for (const verdict of VERDICTS) {
    const id = `filter-verdict-${verdict}`;
    parts.push(
      `<input id="${id}" type="checkbox" checked><label for="${id}">${escapeHtml(VERDICT_LABEL[verdict])}</label>`,
    );
  }
  parts.push('</div>');
  if (rules.length > 0) {
    parts.push('<h3>Rule</h3>');
    parts.push('<div class="choices">');
    for (const rule of rules) {
      const id = `filter-rule-${rule}`;
      parts.push(`<input id="${id}" type="checkbox" checked><label for="${id}">${escapeHtml(rule)}</label>`);
    }
    parts.push('</div>');
  }
  parts.push('</section>');
  parts.push('<section>');
  parts.push('<h2>Tests</h2>');
  if (report.tests.length === 0) parts.push('<p>No tests.</p>');
  for (const test of report.tests) {
    const ruleClasses = [...new Set(test.findings.map((finding) => `rule-${finding.ruleId}`))].join(' ');
    parts.push(`<article class="test verdict-${test.verdict} ${ruleClasses}">`);
    parts.push(`<h3>${escapeHtml(test.titlePath.map((part) => displayText(part)).join(' > '))}</h3>`);
    parts.push(
      `<p class="meta">${escapeHtml(displayText(test.file))}:${test.line} <span class="badge verdict-${test.verdict}">${escapeHtml(test.verdict)}</span></p>`,
    );
    if (test.locators && test.locators.length > 0) {
      parts.push('<ul class="locators">');
      for (const locator of test.locators) {
        const counts = locator.counts.length === 0 ? 'count unknown' : `count ${locator.counts.join(', ')}`;
        const parent = locator.parentCounts.length === 0 ? '' : `, parent ${locator.parentCounts.join(', ')}`;
        parts.push(
          `<li>${escapeHtml(locator.status)} ${escapeHtml(displayText(locator.api))} (${escapeHtml(counts + parent)})</li>`,
        );
      }
      parts.push('</ul>');
    }
    if (test.findings.length === 0) parts.push('<p>No findings.</p>');
    for (const finding of test.findings) parts.push(findingHtml(finding));
    parts.push('</article>');
  }
  parts.push('</section>');
  parts.push('</body>');
  parts.push('</html>');
  return parts.join('\n');
}

function findingHtml(finding: ReportFinding): string {
  const lines = [
    `<section class="finding rule-${escapeHtml(finding.ruleId)}">`,
    `<h4>${escapeHtml(finding.ruleId)} <span class="severity">${escapeHtml(finding.severity)}</span></h4>`,
    `<p>${escapeHtml(displayText(finding.file))}:${finding.line}:${finding.column}</p>`,
    `<p>${escapeHtml(collapseNewlines(finding.message))}</p>`,
    '<p class="label">Evidence</p>',
    `<pre>${escapeHtml(preserveBlock(finding.evidence))}</pre>`,
    '<p class="label">Fix</p>',
    `<pre>${escapeHtml(preserveBlock(finding.fixHint))}</pre>`,
  ];
  if (finding.relatedLintRule) {
    lines.push(`<p>Related lint rule: ${escapeHtml(finding.relatedLintRule)}</p>`);
  }
  lines.push('</section>');
  return lines.join('\n');
}

function css(rules: readonly string[]): string {
  const hideVerdicts = VERDICTS.map(
    (verdict) => `body:not(:has(#filter-verdict-${verdict}:checked)) article.verdict-${verdict}{display:none !important}`,
  );
  const hideFindings = rules.map(
    (rule) => `body:not(:has(#filter-rule-${rule}:checked)) .finding.rule-${rule}{display:none}`,
  );
  // A test with findings stays hidden until one of its rules is checked, so clearing every rule hides the whole test.
  const hideTestsWithFindings = 'article.test:has(.finding){display:none}';
  const showTests = rules.map(
    (rule) => `body:has(#filter-rule-${rule}:checked) article.test.rule-${rule}{display:block}`,
  );
  return [
    'body{margin:0;padding:24px;font-family:Georgia,serif;color:#1c1915;background:#f6f3ec}',
    'h1,h2,h3,h4{font-family:"Segoe UI",Helvetica,Arial,sans-serif;margin:0 0 8px}',
    'header,section{margin-bottom:24px}',
    'article{background:#fffdf8;border:1px solid #ddd4c4;border-radius:8px;padding:16px;margin:0 0 12px}',
    '.meta{color:#5c564c}',
    '.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-family:"Segoe UI",Helvetica,Arial,sans-serif;font-size:12px}',
    '.badge.verdict-trusted{background:#e5f2e5}',
    '.badge.verdict-review{background:#f8efd2}',
    '.badge.verdict-untrusted{background:#f8d9d4}',
    '.badge.verdict-baseline-red{background:#f3d0dc}',
    '.badge.verdict-not-run{background:#e6e6e6}',
    '.finding{margin-top:12px;padding-top:12px;border-top:1px solid #eee6d8}',
    '.severity{font-weight:normal;color:#5c564c}',
    '.label{margin:8px 0 4px;font-family:"Segoe UI",Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:#5c564c}',
    'pre{white-space:pre-wrap;background:#f6f3ec;padding:8px;border-radius:6px;margin:0}',
    '.choices{display:flex;flex-wrap:wrap;gap:8px 16px;margin-bottom:12px}',
    '.choices label{font-family:"Segoe UI",Helvetica,Arial,sans-serif}',
    hideTestsWithFindings,
    ...showTests,
    ...hideFindings,
    ...hideVerdicts,
  ].join('');
}
