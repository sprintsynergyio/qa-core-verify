export interface BaselineSummary {
  /** False when Playwright did not print a JSON report. */
  ok: boolean;
  exitCode: number;
  passed: number;
  failed: number;
  skipped: number;
  /** `path/file.ts:line` for a test that failed, timed out, or was interrupted. */
  failedKeys: Set<string>;
  stdout: string;
  stderr: string;
}

interface JsonSuite {
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

interface JsonSpec {
  file?: string;
  line?: number;
  tests?: JsonTest[];
}

interface JsonTest {
  status?: string;
  results?: Array<{ status?: string }>;
}

/** Read the JSON reporter document. A broken config leaves stdout empty or non-JSON. */
export function parseBaseline(stdout: string, stderr: string, exitCode: number): BaselineSummary {
  const failedKeys = new Set<string>();
  const summary: BaselineSummary = {
    ok: false,
    exitCode,
    passed: 0,
    failed: 0,
    skipped: 0,
    failedKeys,
    stdout,
    stderr,
  };
  const start = stdout.indexOf('{');
  if (start < 0) return summary;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return summary;
  }
  if (typeof parsed !== 'object' || parsed === null || !('suites' in parsed)) return summary;
  const suites = (parsed as { suites?: unknown }).suites;
  if (!Array.isArray(suites)) return summary;
  for (const suite of suites) walkSuite(suite, summary);
  summary.ok = true;
  return summary;
}

export function baselineKey(file: string, line: number): string {
  return `${file.split('\\').join('/')}:${line}`;
}

function walkSuite(value: unknown, summary: BaselineSummary): void {
  if (typeof value !== 'object' || value === null) return;
  const suite = value as JsonSuite;
  for (const spec of suite.specs ?? []) classifySpec(spec, summary);
  for (const child of suite.suites ?? []) walkSuite(child, summary);
}

function classifySpec(spec: JsonSpec, summary: BaselineSummary): void {
  const file = typeof spec.file === 'string' ? spec.file.split('\\').join('/') : '';
  const line = spec.line;
  for (const test of spec.tests ?? []) {
    const results = (test.results ?? []).map((result) => result.status ?? '');
    const failed = test.status === 'unexpected' || results.some((status) => status === 'failed' || status === 'timedOut' || status === 'interrupted');
    const skipped = !failed && (test.status === 'skipped' || (results.length > 0 && results.every((status) => status === 'skipped')));
    if (failed) {
      summary.failed += 1;
      if (file && typeof line === 'number') summary.failedKeys.add(baselineKey(file, line));
    } else if (skipped) summary.skipped += 1;
    else summary.passed += 1;
  }
}
