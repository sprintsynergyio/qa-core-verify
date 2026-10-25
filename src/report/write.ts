import fs from 'node:fs';
import path from 'node:path';
import type { Report } from './model.js';
import { formatConsoleReport } from './console.js';
import { formatHtml } from './html.js';
import { reportJson } from './json.js';
import { formatMarkdown } from './markdown.js';
import { ToolError } from '../tool-error.js';

export const REPORT_FORMATS = ['console', 'json', 'md', 'html'] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export function parseFormats(value: string | undefined): ReportFormat[] {
  if (value === undefined) return [...REPORT_FORMATS];
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new ToolError('Missing --format value. Use console, json, md, html.');
  }
  const formats: ReportFormat[] = [];
  for (const part of parts) {
    if (!isFormat(part)) {
      throw new ToolError(`Unknown --format "${part}". Use console, json, md, html.`);
    }
    if (!formats.includes(part)) formats.push(part);
  }
  return formats;
}

export { reportJson } from './json.js';

/** Write the file formats and return the paths that were written, in format order. */
export function writeReportFiles(report: Report, outDir: string, formats: readonly ReportFormat[]): string[] {
  const files: Array<{ name: string; text: string }> = [];
  if (formats.includes('json')) files.push({ name: 'report.json', text: reportJson(report) });
  if (formats.includes('md')) files.push({ name: 'report.md', text: formatMarkdown(report) });
  if (formats.includes('html')) files.push({ name: 'report.html', text: formatHtml(report) });
  if (files.length === 0) return [];
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Cannot create report directory ${outDir}: ${message}`);
  }
  const written: string[] = [];
  for (const file of files) {
    const target = path.join(outDir, file.name);
    try {
      fs.writeFileSync(target, file.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Cannot write ${target}: ${message}`);
    }
    written.push(target);
  }
  return written;
}

export function consoleText(report: Report, reportPaths: readonly string[]): string {
  return formatConsoleReport(report, reportPaths);
}

function isFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}
