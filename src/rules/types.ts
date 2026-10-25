/** Static weak-assertion, live locator, or cannot-fail check. Coverage is later. */
export type CheckName = 'weak-assertion' | 'locator' | 'cannot-fail';

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  ruleId: string;
  check: CheckName;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  testTitle: string;
  message: string;
  evidence: string;
  fixHint: string;
  /** Set when eslint-plugin-playwright has the same or a close rule. eslint is not a dependency. */
  relatedLintRule?: string;
}
