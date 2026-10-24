import path from 'node:path';
import type { Finding } from '../rules/types.js';

export function formatConsoleReport(findings: readonly Finding[], testsScanned: number): string {
  const lines: string[] = [];
  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.file) ?? [];
    list.push(finding);
    byFile.set(finding.file, list);
  }

  for (const file of [...byFile.keys()].sort((left, right) => left.localeCompare(right))) {
    lines.push(file);
    for (const finding of byFile.get(file) ?? []) {
      lines.push(
        `  ${finding.line}:${finding.column}  ${finding.ruleId}  ${finding.severity}  ${finding.testTitle}  ${finding.message}`,
      );
    }
    lines.push('');
  }

  const counts = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  lines.push(
    `Summary: ${countLabel(counts.error, 'error', 'errors')}, ${countLabel(counts.warn, 'warning', 'warnings')}, ${countLabel(counts.info, 'info finding', 'info findings')}. ${countLabel(testsScanned, 'test', 'tests')} scanned.`,
  );
  return lines.join('\n');
}

export function toDisplayPath(file: string, cwd: string): string {
  const relative = path.relative(cwd, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return file.split(path.sep).join('/');
  return relative.split(path.sep).join('/');
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
