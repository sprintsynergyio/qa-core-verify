import type { Report, ReportFinding, ReportTest } from './model.js';

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
  lines.push(`- Directory: ${report.project.dir}`);
  lines.push(`- Config: ${report.project.configFile ?? 'none'}`);
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
  lines.push(`### ${test.titlePath.join(' > ')}`);
  lines.push('');
  lines.push(`- File: ${test.file}:${test.line}`);
  lines.push(`- Verdict: ${test.verdict}`);
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
    `#### ${finding.ruleId}`,
    '',
    `- Severity: ${finding.severity}`,
    `- Check: ${finding.check}`,
    `- Location: ${finding.file}:${finding.line}:${finding.column}`,
    `- Message: ${finding.message}`,
  ];
  if (finding.relatedLintRule) lines.push(`- Related Lint Rule: ${finding.relatedLintRule}`);
  lines.push('- Evidence:', '', fence(finding.evidence), '', '- Fix:', '', fence(finding.fixHint), '');
  return lines;
}

function fence(text: string): string {
  const marker = text.includes('```') ? '````' : '```';
  return `${marker}\n${text}\n${marker}`;
}
