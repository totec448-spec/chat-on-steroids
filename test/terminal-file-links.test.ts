import { expect, it, vi } from 'vitest';
import type { IBufferCell, ILink, Terminal } from '@xterm/xterm';
import { projectRelativePath, terminalFileLinkProvider, terminalFileLinks } from '../src/renderer/terminal-file-links.js';

const found = (text: string, root: string) => terminalFileLinks(text, root).map(({ path, line, column }) => `${path}:${line}:${column}`);

it('links tsc, Node and Python locations inside the project, relative or absolute', () => {
  expect(found("src/app.ts:42:7 - error TS2322: Type 'string' is not assignable", '/home/you/project')).toEqual(['src/app.ts:42:7']);
  expect(found('src/app.ts(42,7): error TS2322', '/home/you/project')).toEqual(['src/app.ts:42:7']);
  expect(found('    at run (/home/you/project/lib/run.js:10:5)', '/home/you/project')).toEqual(['lib/run.js:10:5']);
  expect(found('./tools/check.py:3: warning', '/home/you/project')).toEqual(['tools/check.py:3:1']);
  expect(found('C:\\Users\\you\\project\\src\\app.ts:9:2 and c:/users/you/project/a.d.ts:1', 'C:\\Users\\you\\project'))
    .toEqual(['src/app.ts:9:2', 'a.d.ts:1:1']);
  expect(found('src\\app.ts:4', 'C:\\Users\\you\\project')).toEqual(['src/app.ts:4:1']);
});

it('leaves paths outside the project, URLs, times and versions unlinked', () => {
  expect(found('/home/you/other/app.ts:1:1 /home/you/project-b/x.ts:2', '/home/you/project')).toEqual([]);
  expect(found('../secret.ts:3 src/../../escape.ts:4 D:\\project\\a.ts:5', 'C:\\project')).toEqual([]);
  expect(found('see https://example.com/app.ts:443 at 12:30:45, v1.2:3, src/app.ts:0', '/home/you/project')).toEqual([]);
  expect(projectRelativePath('src/./lib/../app.ts', '/p')).toBe('src/app.ts');
  expect(projectRelativePath('/home/you/project', '/home/you/project')).toBeNull();
});

it('leaves a path with a space in it unlinked instead of linking its tail', () => {
  // `file.ts` at the project root is another file than `src/my file.ts`.
  expect(found('src/my file.ts:2', '/home/you/project')).toEqual([]);
  expect(found('error in ./src/my file.ts(2,3): bad', '/home/you/project')).toEqual([]);
  expect(found('C:\\project\\my docs\\a file.ts:7', 'C:\\project')).toEqual([]);
  // A word or a finished location before the match is not a path fragment.
  expect(found('at src/a.ts:1 src/b.ts:2 and error: c.ts:3', '/home/you/project')).toEqual(['src/a.ts:1:1', 'src/b.ts:2:1', 'c.ts:3:1']);
});

const row = (text: string, wide = new Set<number>()) => {
  // Each wide character takes its cell and a zero-width continuation cell, as xterm stores it.
  const cells: Array<{ chars: string; width: number }> = [];
  [...text].forEach((chars, index) => {
    if (wide.has(index)) cells.push({ chars, width: 2 }, { chars: '', width: 0 });
    else cells.push({ chars, width: 1 });
  });
  return {
    length: cells.length,
    getCell: (x: number) => cells[x] && ({ getChars: () => cells[x]!.chars, getWidth: () => cells[x]!.width } as unknown as IBufferCell)
  };
};
const provide = (text: string, wide?: Set<number>) => {
  const open = vi.fn(), term = { buffer: { active: { getLine: (y: number) => y === 2 ? row(text, wide) : undefined } } };
  let links: ILink[] | undefined;
  terminalFileLinkProvider(term as unknown as Pick<Terminal, 'buffer'>, '/home/you/project', { open }).provideLinks(3, value => { links = value; });
  return { links, open };
};

it.each([['MacIntel', 'metaKey', 'ctrlKey'], ['Win32', 'ctrlKey', 'metaKey'], ['Linux x86_64', 'ctrlKey', 'metaKey']] as const)(
  'on %s opens a location only on its primary-key click and keeps its range on the cells it occupies', (platform, primary, other) => {
  vi.stubGlobal('navigator', { ...globalThis.navigator, platform });
  try {
    const { links, open } = provide('错 src/app.ts:42:7 - error', new Set([0]));
    expect(links).toHaveLength(1);
    // The wide character takes cells 1-2 (1-based), so the path starts on cell 4 and ends on cell 18.
    expect(links![0]!.range).toEqual({ start: { x: 4, y: 3 }, end: { x: 18, y: 3 } });
    expect(links![0]!.text).toBe('src/app.ts:42:7');
    const click = (key?: 'ctrlKey' | 'metaKey') =>
      links![0]!.activate({ ctrlKey: key === 'ctrlKey', metaKey: key === 'metaKey' } as MouseEvent, links![0]!.text);
    click();
    // Ctrl+click on macOS is a right click, and ⌘ elsewhere is the system key: neither opens.
    click(other);
    expect(open).not.toHaveBeenCalled();
    click(primary);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/app.ts', line: 42, column: 7 }));
    expect(provide('no locations here').links).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});
