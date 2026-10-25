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

/** Collapse newlines and remove other control characters, including ESC. */
export function displayText(value: string): string {
  const collapsed = value.replace(/(?:\r\n|[\n\r])+/g, ' ');
  return collapsed.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}
