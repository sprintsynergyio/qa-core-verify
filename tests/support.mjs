import fs from 'node:fs';

export function lineAndColumn(file, needle) {
  const lines = fs.readFileSync(file, 'utf8').split(/\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`Cannot find ${JSON.stringify(needle)} in ${file}`);
  const text = lines[index];
  return { line: index + 1, column: text.indexOf(needle) + 1, text };
}

export function byTitle(inventory, title) {
  const found = inventory.tests.find((test) => test.title === title);
  if (!found) throw new Error(`Missing test ${title}`);
  return found;
}
