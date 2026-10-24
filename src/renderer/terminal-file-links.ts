import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { isMac } from './shortcuts.js';

/** A `path:line[:column]` (or `path(line,column)`) in terminal output that names a file in the project. */
export interface TerminalFileLink {
  /** UTF-16 offsets of the whole match in the scanned text. */
  start: number;
  end: number;
  /** Project-relative, `/`-separated, without `.` or `..` segments. */
  path: string;
  line: number;
  column: number;
}

// The last segment needs an extension starting with a letter, so times (12:30:45) and versions
// (1.2:3) stay plain text. The lookbehind keeps URLs (`https://host/a.ts:3`) and the middle of a
// longer path from matching.
const LOCATION = /(?<![\w/\\.:@~$-])((?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])?(?:[\w.@+~$-]+[\\/])*[\w.@+~$-]*\.[A-Za-z]\w*)(?::(\d+)(?::(\d+))?|\((\d+)(?:, ?(\d+))?\))(?!\w)/g;

// A path word right before the match, such as `src/my` in `src/my file.ts:2`. The match is then
// the tail of a path with a space in it, and `file.ts` at the project root is a different file.
const PATH_FRAGMENT_BEFORE = /(?:^|\s)(?:[A-Za-z]:)?[\w.@+~$\\/-]*[\\/][\w.@+~$-]+\s+$/;

/**
 * The project-relative path for one printed path, or null when it is not inside `root`.
 * Relative paths resolve against `root`, the tab's starting cwd; `..` may not climb above it.
 */
export function projectRelativePath(printed: string, root: string): string | null {
  const path = printed.replace(/\\/g, '/'), base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  let relative = path;
  if (/^[A-Za-z]:\//.test(path) || path.startsWith('/')) {
    // A drive-letter root is Windows, whose paths compare without case.
    const fold = (value: string): string => /^[A-Za-z]:/.test(base) ? value.toLowerCase() : value;
    if (!fold(path).startsWith(`${fold(base)}/`)) return null;
    relative = path.slice(base.length + 1);
  }
  const parts: string[] = [];
  for (const part of relative.split('/')) {
    if (part === '..') { if (parts.pop() === undefined) return null; }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/** Every file location in one line of output that resolves inside `root`. A path with a space in it is left unlinked. */
export function terminalFileLinks(text: string, root: string): TerminalFileLink[] {
  const links: TerminalFileLink[] = [];
  for (const match of text.matchAll(LOCATION)) {
    if (PATH_FRAGMENT_BEFORE.test(text.slice(0, match.index))) continue;
    const path = projectRelativePath(match[1]!, root);
    const line = Number(match[2] ?? match[4]), column = Number(match[3] ?? match[5] ?? 1);
    if (!path || !Number.isSafeInteger(line) || line < 1) continue;
    links.push({ start: match.index, end: match.index + match[0].length, path, line, column: Math.max(1, column) });
  }
  return links;
}

/**
 * Links file locations in a terminal's output. Ctrl+click (⌘+click on macOS) opens one; a plain
 * click stays a terminal click. A location wrapped onto the next row is not linked.
 */
export function terminalFileLinkProvider(term: Pick<Terminal, 'buffer'>, root: string,
  handlers: { open(link: TerminalFileLink): void; hover?(over: boolean): void }): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const row = term.buffer.active.getLine(y - 1);
      if (!row) { callback(undefined); return; }
      // Map string offsets to cells, so a wide character before a path keeps the range on it.
      let text = '';
      const cells: number[] = [];
      for (let x = 0; x < row.length; x++) {
        const cell = row.getCell(x);
        if (!cell || !cell.getWidth()) continue;
        const chars = cell.getChars() || ' ';
        text += chars;
        for (let at = 0; at < chars.length; at++) cells.push(x);
      }
      const links = terminalFileLinks(text, root).map((link): ILink => ({
        range: { start: { x: cells[link.start]! + 1, y }, end: { x: cells[link.end - 1]! + 1, y } },
        text: text.slice(link.start, link.end),
        decorations: { pointerCursor: true, underline: true },
        activate: event => { if (isMac() ? event.metaKey : event.ctrlKey) handlers.open(link); },
        hover: () => handlers.hover?.(true),
        leave: () => handlers.hover?.(false)
      }));
      callback(links.length ? links : undefined);
    }
  };
}
