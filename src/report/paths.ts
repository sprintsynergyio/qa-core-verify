import path from 'node:path';

/** Base name of the project folder. The filesystem root has an empty base name, so it is `.`. */
export function projectDirLabel(projectDir: string): string {
  const base = path.basename(path.resolve(projectDir));
  return base.length === 0 ? '.' : base;
}

/** Path relative to the project folder, with `/` separators. The project folder itself is `.`. */
export function toProjectPath(file: string, projectDir: string): string {
  const relative = path.relative(path.resolve(projectDir), path.resolve(file));
  if (relative === '') return '.';
  return relative.split(path.sep).join('/');
}

/** Replace newline runs, U+2028, and U+2029 with one space so a title or path stays on one line. */
export function collapseNewlines(value: string): string {
  return value.replace(/(?:\r\n|[\n\r\u2028\u2029])+/g, ' ').trim();
}

/**
 * Collapse newlines and remove control characters: C0 (including ESC and DEL),
 * C1 (U+0080 through U+009F), line separators U+2028 and U+2029, and bidi overrides
 * (U+202A through U+202E, U+200E, U+200F, and U+2066 through U+2069).
 */
export function displayText(value: string): string {
  const collapsed = value.replace(/(?:\r\n|[\n\r\u2028\u2029])+/g, ' ');
  return collapsed
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
}

/**
 * Keep `\n` for fenced and pre blocks. C0, DEL, C1, and bidi overrides are removed.
 * U+2028 and U+2029 become newlines.
 */
export function preserveBlock(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u2028\u2029]/g, '\n');
  return normalized.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
    '',
  );
}

/** Write C0, DEL, C1, line separators, and bidi controls as `\u` plus four lowercase hex digits. */
export function escapeControls(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/**
 * Keep every code point in a selector. Controls, DEL, C1, line separators, and bidi
 * overrides are written as `\u` plus four lowercase hex digits instead of being dropped.
 */
export function escapeSelector(value: string): string {
  return escapeControls(value);
}

/** True when `target` is not the project directory and not inside it. */
export function isOutsideProject(target: string, projectDir: string): boolean {
  const relative = path.relative(path.resolve(projectDir), path.resolve(target));
  if (relative === '') return false;
  return relative.startsWith('..') || path.isAbsolute(relative);
}

/**
 * Report file paths for the console. Inside the project, paths are relative to that folder.
 * Outside it, each path keeps the `--out` value as typed, plus the file name.
 */
export function consoleReportPaths(
  written: readonly string[],
  projectDir: string,
  typedOut: string | undefined,
  cwd: string,
): string[] {
  const outside = typedOut !== undefined && isOutsideProject(path.resolve(cwd, typedOut), projectDir);
  if (!outside) return written.map((file) => toProjectPath(file, projectDir));
  const typed = typedOut.split(path.sep).join('/').replace(/\/+$/, '');
  return written.map((file) => `${typed}/${path.basename(file)}`);
}
