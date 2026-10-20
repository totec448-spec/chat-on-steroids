import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { appendGitignoreEntry, gitignoreEntry } from '../src/renderer/gitignore-entry.js';

it('anchors a path to the project folder and escapes Git pattern characters', () => {
  expect(gitignoreEntry('dist', true)).toBe('/dist/');
  expect(gitignoreEntry('src/new.ts', false)).toBe('/src/new.ts');
  expect(gitignoreEntry('a[1]*?.txt', false)).toBe('/a\\[1]\\*\\?.txt');
  expect(gitignoreEntry('#notes', false)).toBe('/#notes');
  expect(gitignoreEntry('!keep', false)).toBe('/!keep');
  expect(gitignoreEntry('trail  ', false)).toBe('/trail\\ \\ ');
  expect(gitignoreEntry('two\nlines', false)).toBeNull();
  expect(gitignoreEntry('', true)).toBeNull();
});

it('appends one line in the file\'s own line endings and keeps a byte order mark', () => {
  expect(appendGitignoreEntry('', '/dist/')).toBe('/dist/\n');
  expect(appendGitignoreEntry('node_modules', '/dist/')).toBe('node_modules\n/dist/\n');
  expect(appendGitignoreEntry('node_modules\n', '/dist/')).toBe('node_modules\n/dist/\n');
  expect(appendGitignoreEntry('a\r\nb', '/dist/')).toBe('a\r\nb\r\n/dist/\r\n');
  expect(appendGitignoreEntry('﻿', '/dist/')).toBe('﻿/dist/\n');
});

it('writes lines that Git reads as exactly the chosen path', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'cos-gitignore-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const lines = [gitignoreEntry('a[1]*.txt', false)!, gitignoreEntry('out', true)!, gitignoreEntry('#x', false)!];
    writeFileSync(path.join(repo, '.gitignore'), appendGitignoreEntry('', lines.join('\n')));
    const ignored = (file: string): boolean => {
      try { execFileSync('git', ['check-ignore', '-q', '--no-index', file], { cwd: repo }); return true; } catch { return false; }
    };
    expect(ignored('a[1]*.txt')).toBe(true);
    expect(ignored('a1b.txt')).toBe(false);
    expect(ignored('out/build.js')).toBe(true);
    expect(ignored('src/out/build.js')).toBe(false);
    expect(ignored('#x')).toBe(true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
