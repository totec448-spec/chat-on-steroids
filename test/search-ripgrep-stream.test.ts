import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { search } from '../src/main/search.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../src/main/ripgrep.js', () => ({ locateRipgrep: () => 'synthetic-ripgrep' }));
beforeEach(() => { vi.clearAllMocks(); });

it.each([true, false])('keeps Japanese paths and emoji when UTF-8 arrives byte by byte (final newline: %s)', async newline => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const result = search({ realDir: '/synthetic', virtualDir: '/project', query: '日本語', mode: 'content',
    exclude: [], caseSensitive: true, maxResults: 50 });
  const line = JSON.stringify({ type: 'match', data: { path: { text: './日本語😀.txt' }, line_number: 3,
    lines: { text: '日本語の結果 😀 café\n' } } });
  const bytes = Buffer.from(line + (newline ? '\n' : ''));
  // Real Node stream decoding, split inside every multibyte character; no timer or pipe-size assumption.
  for (let at = 0; at < bytes.length; at++) child.stdout.write(bytes.subarray(at, at + 1));
  child.stdout.end();
  child.emit('close', 0);
  expect((await result).hits).toEqual([{ path: '/project/日本語😀.txt', line: 3, text: '日本語の結果 😀 café' }]);
});
