import type { Finding, Severity } from './rules/types.js';

const RANK: Record<Severity, number> = {
  info: 0,
  warn: 1,
  error: 2,
};

/** 1 when any finding is at or above failOn, otherwise 0. */
export function exitCodeFor(findings: readonly Finding[], failOn: Severity): 0 | 1 {
  const threshold = RANK[failOn];
  return findings.some((finding) => RANK[finding.severity] >= threshold) ? 1 : 0;
}

export function isSeverity(value: string): value is Severity {
  return value === 'error' || value === 'warn' || value === 'info';
}
