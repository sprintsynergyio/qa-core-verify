import type { Report } from './model.js';

/** Pretty JSON with a trailing newline. schemaVersion lives on the report. */
export function reportJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
