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

/** Replace newline runs with one space so a title or path stays on one line. */
export function collapseNewlines(value: string): string {
  return value.replace(/(?:\r\n|[\n\r])+/g, ' ').trim();
}

/**
 * Collapse newlines and remove control characters: C0 (including ESC and DEL),
 * C1 (U+0080 through U+009F), and bidi overrides (U+202A through U+202E and U+2066 through U+2069).
 */
export function displayText(value: string): string {
  const collapsed = value.replace(/(?:\r\n|[\n\r])+/g, ' ');
  return collapsed.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\u202A-\u202E\u2066-\u2069]/g, '').trim();
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
