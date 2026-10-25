import path from 'node:path';
import type { Report, ReportSummary } from './model.js';

export function formatConsoleReport(report: Report, reportPaths: readonly string[]): string {
  const lines: string[] = [];
  for (const test of report.tests) {
    lines.push(`${test.verdict}  ${test.file}:${test.line}  ${test.titlePath.join(' > ')}`);
    for (const finding of test.findings) {
      lines.push(`  ${finding.ruleId}  ${finding.severity}  ${finding.line}:${finding.column}  ${finding.message}`);
      lines.push(`    Evidence: ${oneLine(finding.evidence)}`);
      lines.push(`    Fix: ${oneLine(finding.fixHint)}`);
    }
    lines.push('');
  }
  lines.push(summaryLine(report.summary));
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

export function reportsLine(reportPaths: readonly string[]): string {
  if (reportPaths.length === 0) return 'Reports: none.';
  return `Reports: ${reportPaths.map((file) => file.split(path.sep).join('/')).join(', ')}.`;
}

export function toDisplayPath(file: string, cwd: string): string {
  const relative = path.relative(cwd, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return file.split(path.sep).join('/');
  return relative.split(path.sep).join('/');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
