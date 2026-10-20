/**
 * The .gitignore line for one project-relative path, anchored with a leading slash so it
 * matches that path in the project folder only, not a file of the same name elsewhere. Git's
 * pattern characters are escaped, so a name such as `a[1].txt` stays one literal path. Null when
 * no single line can name it (a line break in the name).
 */
export function gitignoreEntry(relative: string, folder: boolean): string | null {
  if (!relative || /[\r\n\0]/.test(relative)) return null;
  let escaped = relative.replace(/[\\*?[]/g, '\\$&');
  // Git drops unquoted trailing spaces; a folder line ends in "/", so only a file needs this.
  if (!folder) escaped = escaped.replace(/ +$/, spaces => '\\ '.repeat(spaces.length));
  return `/${escaped}${folder ? '/' : ''}`;
}

/** The file's text with `entry` as a new last line, in the file's own line endings. */
export function appendGitignoreEntry(text: string, entry: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = text === '' || text === '﻿' || text.endsWith('\n') ? '' : eol;
  return `${text}${separator}${entry}${eol}`;
}
