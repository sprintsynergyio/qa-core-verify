import type { Report, ReportSummary } from './model.js';
import { trustNote } from './model.js';
import { collapseNewlines, displayText, escapeControls } from './paths.js';

export function formatConsoleReport(report: Report, reportPaths: readonly string[]): string {
  const lines: string[] = [];
  for (const test of report.tests) {
    const title = test.titlePath.map((part) => displayText(part)).join(' > ');
    lines.push(`${test.verdict}  ${displayText(test.file)}:${test.line}  ${title}`);
    for (const finding of test.findings) {
      lines.push(`  ${finding.ruleId}  ${finding.severity}  ${finding.line}:${finding.column}  ${collapseNewlines(finding.message)}`);
      lines.push(`    Evidence: ${oneLine(finding.evidence)}`);
      lines.push(`    Fix: ${oneLine(finding.fixHint)}`);
    }
    for (const locator of test.locators ?? []) {
      const counts = locator.counts.length === 0 ? 'count unknown' : `count ${locator.counts.join(', ')}`;
      const parent = locator.parentCounts.length === 0 ? '' : `  parent ${locator.parentCounts.join(', ')}`;
      lines.push(
        `  Locator ${locator.status}  ${displayText(locator.file)}:${locator.line}:${locator.column}  ${oneLine(locator.api)}  ${counts}${parent}`,
      );
    }
    lines.push('');
  }
  lines.push(summaryLine(report.summary));
  lines.push(checksLine(report.checksRun));
  const note = trustNote(report.checksRun);
  if (note) lines.push(note);
  lines.push(reportsLine(reportPaths));
  return lines.join('\n');
}

export function summaryLine(summary: ReportSummary): string {
  const verdict = summary.verdict;
  const severity = summary.severity;
  return [
    'Summary:',
    `${verdict.trusted} trusted,`,
    `${verdict.review} review,`,
    `${verdict.untrusted} untrusted,`,
    `${verdict['baseline-red']} baseline-red,`,
    `${verdict['not-run']} not-run.`,
    `${countLabel(severity.error, 'error', 'errors')},`,
    `${countLabel(severity.warn, 'warning', 'warnings')},`,
    `${countLabel(severity.info, 'info finding', 'info findings')}.`,
  ].join(' ');
}

export function checksLine(checksRun: readonly string[]): string {
  if (checksRun.length === 0) return 'Checks run: none.';
  return `Checks run: ${checksRun.join(', ')}.`;
}

export function reportsLine(reportPaths: readonly string[]): string {
  if (reportPaths.length === 0) return 'Reports: none.';
  return `Reports: ${reportPaths.map((file) => escapeControls(file)).join(', ')}.`;
}

function oneLine(text: string): string {
  return displayText(text).replace(/\s+/g, ' ').trim();
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
