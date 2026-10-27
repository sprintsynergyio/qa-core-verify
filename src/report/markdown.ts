import type { Report, ReportFinding, ReportTest } from './model.js';
import { trustNote } from './model.js';
import { collapseNewlines, displayText, preserveBlock } from './paths.js';

export function formatMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push('# qa-core-verify Report');
  lines.push('');
  lines.push(`- Tool: ${report.tool.name} ${report.tool.version}`);
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Finished: ${report.finishedAt}`);
  lines.push('');
  lines.push('## Project');
  lines.push('');
  lines.push(`- Directory: ${inline(displayText(report.project.dir))}`);
  lines.push(`- Config: ${report.project.configFile === null ? 'none' : inline(displayText(report.project.configFile))}`);
  lines.push(`- Specs: ${report.project.specCount}`);
  lines.push(`- Tests: ${report.project.testCount}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('### Severity');
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Error | ${report.summary.severity.error} |`);
  lines.push(`| Warning | ${report.summary.severity.warn} |`);
  lines.push(`| Info | ${report.summary.severity.info} |`);
  lines.push('');
  lines.push('### Verdict');
  lines.push('');
  lines.push('| Verdict | Count |');
  lines.push('| --- | --- |');
  lines.push(`| trusted | ${report.summary.verdict.trusted} |`);
  lines.push(`| review | ${report.summary.verdict.review} |`);
  lines.push(`| untrusted | ${report.summary.verdict.untrusted} |`);
  lines.push(`| baseline-red | ${report.summary.verdict['baseline-red']} |`);
  lines.push(`| not-run | ${report.summary.verdict['not-run']} |`);
  lines.push('');
  const note = trustNote(report.checksRun);
  if (note) {
    lines.push(note);
    lines.push('');
  }
  lines.push('## Checks Run');
  lines.push('');
  if (report.checksRun.length === 0) lines.push('None.');
  for (const check of report.checksRun) lines.push(`- ${check}`);
  lines.push('');
  lines.push('## Tests');
  lines.push('');
  if (report.tests.length === 0) lines.push('No tests.');
  for (const test of report.tests) lines.push(...formatTest(test));
  return lines.join('\n');
}

function formatTest(test: ReportTest): string[] {
  const lines: string[] = [];
  lines.push(`### ${inline(test.titlePath.map((part) => displayText(part)).join(' > '))}`);
  lines.push('');
  lines.push(`- File: ${inline(displayText(test.file))}:${test.line}`);
  lines.push(`- Verdict: ${test.verdict}`);
  if (test.assertions && test.assertions.length > 0) {
    lines.push('- Assertions:');
    for (const assertion of test.assertions) {
      const reason = assertion.reason ? ` (${inline(assertion.reason)})` : '';
      lines.push(`  - ${assertion.outcome}: ${inline(assertion.matcher)} at ${assertion.line}:${assertion.column}${reason}`);
    }
  }
  if (test.locators && test.locators.length > 0) {
    lines.push('- Locators:');
    for (const locator of test.locators) {
      const counts = locator.counts.length === 0 ? 'count unknown' : `count ${locator.counts.join(', ')}`;
      const parent = locator.parentCounts.length === 0 ? '' : `, parent ${locator.parentCounts.join(', ')}`;
      lines.push(`  - ${locator.status}: ${inline(locator.api)} (${counts}${parent})`);
    }
  }
  if (test.findings.length === 0) {
    lines.push('- Findings: none');
    lines.push('');
    return lines;
  }
  lines.push('');
  for (const finding of test.findings) lines.push(...formatFinding(finding));
  return lines;
}

function formatFinding(finding: ReportFinding): string[] {
  const lines = [
    `#### ${inline(finding.ruleId)}`,
    '',
    `- Severity: ${finding.severity}`,
    `- Check: ${inline(finding.check)}`,
    `- Location: ${inline(displayText(finding.file))}:${finding.line}:${finding.column}`,
    `- Message: ${inline(finding.message)}`,
  ];
  if (finding.relatedLintRule) lines.push(`- Related Lint Rule: ${inline(finding.relatedLintRule)}`);
  lines.push('- Evidence:', '', fence(preserveBlock(finding.evidence)), '', '- Fix:', '', fence(preserveBlock(finding.fixHint)), '');
  return lines;
}

/** One backtick longer than the longest backtick run in `text`, and at least three. */
function fence(text: string): string {
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return `${marker}\n${text}\n${marker}`;
}

/** Collapse newlines, then escape Markdown and HTML specials so user text cannot change the document. */
function inline(value: string): string {
  const collapsed = collapseNewlines(value);
  const marked = collapsed.replace(/[\\`*_{}[\]()#+!|~]/g, (char) => `\\${char}`);
  return marked
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
