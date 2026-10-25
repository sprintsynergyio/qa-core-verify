import type { Report, ReportSummary } from './model.js';
import { trustNote } from './model.js';
import { collapseNewlines, displayText } from './paths.js';

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
  return `Reports: ${reportPaths.map((file) => displayText(file)).join(', ')}.`;
}

function oneLine(text: string): string {
  return displayText(text).replace(/\s+/g, ' ').trim();
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
