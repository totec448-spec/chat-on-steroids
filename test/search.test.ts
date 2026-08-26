import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDES, globToRegExp, search, searchOneFile } from '../src/main/search.js';
import { ripgrepExecutableName } from '../src/main/ripgrep.js';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

describe('ripgrep executable naming', () => {
  it('uses .exe only on Windows', () => {
    expect(ripgrepExecutableName('win32')).toBe('rg.exe');
    expect(ripgrepExecutableName('darwin')).toBe('rg');
    expect(ripgrepExecutableName('linux')).toBe('rg');
  });
});

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-search-');
  await writeTree(dir, {
    'src/index.ts': 'export const answer = 42;\nconsole.log(answer);\n',
    'src/util.ts': 'export function helper(): void {}\n',
    'src/deep/nested.ts': 'const NEEDLE = "findme";\n',
    'src/notes.md': '# Notes\nfindme in markdown\n',
    'README.md': 'findme at the top level\n',
    'node_modules/pkg/index.js': 'findme in a dependency\n',
    'dist/bundle.js': 'findme in a build artifact\n',
    '.git/config': 'findme in git\n',
    '.claude-acct2/history/noise.txt': 'findme in a profile cache\n',
    'CaseTest.txt': 'MixedCase content here\n'
  });
  await fs.writeFile(path.join(dir, 'src', 'blob.bin'), Buffer.from('findme\0binary'));
  await fs.writeFile(
    path.join(dir, 'src', 'utf16.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\nfindme utf16\n', 'utf16le')])
  );
});

afterAll(async () => {
  await removeTempDir(dir);
});

function req(overrides: Partial<Parameters<typeof search>[0]> = {}) {
  return {
    realDir: dir,
    virtualDir: '/root',
    query: '',
    mode: 'name' as const,
    exclude: DEFAULT_EXCLUDES,
    caseSensitive: false,
    maxResults: 100,
    ...overrides
  };
}

describe('globToRegExp', () => {
  it('matches * within one path segment only', () => {
    const re = globToRegExp('*.ts', false);
    expect(re.test('index.ts')).toBe(true);
    expect(re.test('src/index.ts')).toBe(false);
  });

  it('matches **/ across segments, including zero', () => {
    const re = globToRegExp('**/*.ts', false);
    expect(re.test('index.ts')).toBe(true);
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('src/deep/nested.ts')).toBe(true);
    expect(re.test('src/index.js')).toBe(false);
  });

  it('matches ? as a single character', () => {
    const re = globToRegExp('a?c.txt', false);
    expect(re.test('abc.txt')).toBe(true);
    expect(re.test('ac.txt')).toBe(false);
  });

  it('escapes regex metacharacters in the literal parts', () => {
    const re = globToRegExp('a+b(c).txt', false);
    expect(re.test('a+b(c).txt')).toBe(true);
    expect(re.test('aab(c).txt')).toBe(false);
  });

  it('honours case sensitivity', () => {
    expect(globToRegExp('*.TS', false).test('index.ts')).toBe(true);
    expect(globToRegExp('*.TS', true).test('index.ts')).toBe(false);
  });
});

describe('name search', () => {
  it('keeps the breadth-first directory queue append-only instead of shifting its front', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'search.ts'), 'utf8');
    expect(source).toContain('let directoryHead = 0;');
    expect(source).toContain('pendingDirectories[directoryHead++]');
    expect(source).not.toContain('pendingDirectories.shift()');
  });

  it('finds files by substring', async () => {
    const out = await search(req({ query: 'index' }));
    expect(out.hits.map((h) => h.path)).toContain('/root/src/index.ts');
  });

  it('returns virtual paths, never real ones', async () => {
    const out = await search(req({ query: '.ts' }));
    for (const hit of out.hits) {
      expect(hit.path.startsWith('/root/')).toBe(true);
      expect(hit.path).not.toContain('\\');
    }
  });

  it('skips build, dependency and prefix-matched tooling folders by default', async () => {
    const index = await search(req({ query: 'index' }));
    const indexPaths = index.hits.map((h) => h.path);
    expect(indexPaths).not.toContain('/root/node_modules/pkg/index.js');
    expect(indexPaths).not.toContain('/root/dist/bundle.js');

    const profile = await search(req({ query: 'noise' }));
    expect(profile.hits.map((h) => h.path)).not.toContain('/root/.claude-acct2/history/noise.txt');
  });

  it('searches everywhere when the exclude list is empty', async () => {
    const out = await search(req({ query: 'index', exclude: [] }));
    expect(out.hits.map((h) => h.path)).toContain('/root/node_modules/pkg/index.js');
    const profile = await search(req({ query: 'noise', exclude: [] }));
    expect(profile.hits.map((h) => h.path)).toContain('/root/.claude-acct2/history/noise.txt');
  });

  it('applies an include glob', async () => {
    const out = await search(req({ query: '', include: '**/*.md' }));
    const paths = out.hits.map((h) => h.path).sort();
    expect(paths).toEqual(['/root/README.md', '/root/src/notes.md']);
  });

  it('matches a slash-free include glob against the file name', async () => {
    const out = await search(req({ query: '', include: '*.md' }));
    expect(out.hits.map((h) => h.path).sort()).toEqual(['/root/README.md', '/root/src/notes.md']);
  });

  it('is case-insensitive by default and exact when asked', async () => {
    expect((await search(req({ query: 'casetest' }))).hits).toHaveLength(1);
    expect((await search(req({ query: 'casetest', caseSensitive: true }))).hits).toHaveLength(0);
    expect((await search(req({ query: 'CaseTest', caseSensitive: true }))).hits).toHaveLength(1);
  });

  it('stops at maxResults and says why', async () => {
    const out = await search(req({ query: '', maxResults: 2 }));
    expect(out.hits).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.stoppedBecause).toBe('limit');
  });

  it('reports no truncation when everything fit', async () => {
    const out = await search(req({ query: 'README' }));
    expect(out.truncated).toBe(false);
    expect(out.stoppedBecause).toBeNull();
  });
});

describe('single-file search', () => {
  it('applies include filters to an explicitly named content file before ripgrep can ignore them', async () => {
    const out = await searchOneFile(path.join(dir, 'src', 'index.ts'), '/root/src/index.ts', {
      query: 'console.log',
      mode: 'content',
      include: '*.md',
      caseSensitive: false,
      maxResults: 10
    });
    expect(out.hits).toEqual([]);
  });

  it('reports that an oversized explicit content file was not searched instead of claiming no matches', async () => {
    const oversized = path.join(dir, 'src', 'oversized.log');
    const handle = await fs.open(oversized, 'w');
    try {
      await handle.truncate(2 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    try {
      const out = await searchOneFile(oversized, '/root/src/oversized.log', {
        query: 'needle',
        mode: 'content',
        caseSensitive: false,
        maxResults: 10
      });
      expect(out.hits).toEqual([]);
      expect(out.filesScanned).toBe(0);
      expect(out.truncated).toBe(true);
      expect(out.stoppedBecause).toBe('size');
    } finally {
      await fs.rm(oversized, { force: true });
    }
  });

  it('searches the exact file without walking its parent directory', async () => {
    const real = path.join(dir, 'src', 'index.ts');
    const out = await searchOneFile(real, '/root/src/index.ts', {
      query: 'console.log',
      mode: 'content',
      caseSensitive: false,
      maxResults: 10
    });
    expect(out.filesScanned).toBe(1);
    expect(out.hits).toEqual([
      { path: '/root/src/index.ts', line: 2, text: 'console.log(answer);' }
    ]);
  });

  it('also supports filename matching against the exact file', async () => {
    const out = await searchOneFile(path.join(dir, 'src', 'index.ts'), '/root/src/index.ts', {
      query: 'index',
      mode: 'name',
      caseSensitive: false,
      maxResults: 10
    });
    expect(out.hits.map((hit) => hit.path)).toEqual(['/root/src/index.ts']);
  });

  it('searches BOM-marked UTF-16 text correctly', async () => {
    const out = await searchOneFile(path.join(dir, 'src', 'utf16.txt'), '/root/src/utf16.txt', {
      query: 'findme',
      mode: 'content',
      caseSensitive: false,
      maxResults: 10
    });
    expect(out.hits).toEqual([
      { path: '/root/src/utf16.txt', line: 2, text: 'findme utf16' }
    ]);
  });
});

describe('content search', () => {
  it('treats ripgrep-only include metacharacters literally like the connector matcher', async () => {
    const tree = await makeTempDir('clf-search-include-literal-');
    try {
      await writeTree(tree, {
        'sandbo[x].ts': 'needle literal bracket\n',
        'sandbox.ts': 'needle wildcard trap\n'
      });
      const out = await search(
        req({ realDir: tree, query: 'needle', mode: 'content', include: 'sandbo[x].ts', exclude: [] })
      );
      expect(out.hits.map((hit) => hit.path)).toEqual(['/root/sandbo[x].ts']);
    } finally {
      await removeTempDir(tree);
    }
  });

  it('returns the line number and the matching line', async () => {
    const out = await search(req({ query: 'findme', mode: 'content' }));
    const hit = out.hits.find((h) => h.path === '/root/README.md');
    expect(hit?.line).toBe(1);
    expect(hit?.text).toBe('findme at the top level');
  });

  it('finds matches on later lines', async () => {
    const out = await search(req({ query: 'findme', mode: 'content', include: '**/*.md' }));
    const hit = out.hits.find((h) => h.path === '/root/src/notes.md');
    expect(hit?.line).toBe(2);
  });

  it('skips binary files', async () => {
    const out = await search(req({ query: 'findme', mode: 'content' }));
    expect(out.hits.map((h) => h.path)).not.toContain('/root/src/blob.bin');
  });

  it('honours the default exclusions', async () => {
    const out = await search(req({ query: 'findme', mode: 'content' }));
    const paths = out.hits.map((h) => h.path);
    expect(paths).not.toContain('/root/node_modules/pkg/index.js');
    expect(paths).not.toContain('/root/.git/config');
  });

  it('gives ripgrep the same literal, case-insensitive folder-exclude semantics as the JS fallback', async () => {
    const tree = await makeTempDir('clf-search-exclude-parity-');
    try {
      await writeTree(tree, {
        'BUILD/hidden.txt': 'needle\n',
        'odd[dir]/hidden.txt': 'needle\n',
        'oddd/visible.txt': 'needle\n',
        'keep/visible.txt': 'needle\n'
      });
      const out = await search(
        req({
          realDir: tree,
          query: 'needle',
          mode: 'content',
          exclude: ['build', 'odd[dir]']
        })
      );
      const paths = out.hits.map((hit) => hit.path);
      expect(paths).not.toContain('/root/BUILD/hidden.txt');
      expect(paths).not.toContain('/root/odd[dir]/hidden.txt');
      expect(paths).toContain('/root/oddd/visible.txt');
      expect(paths).toContain('/root/keep/visible.txt');
    } finally {
      await removeTempDir(tree);
    }
  });

  it('caps results', async () => {
    const out = await search(req({ query: 'e', mode: 'content', maxResults: 3 }));
    expect(out.hits.length).toBeLessThanOrEqual(3);
    expect(out.truncated).toBe(true);
  });

  it('honours the cap exactly, even when the pipe is already full of matches', async () => {
    // ripgrep is killed the moment the cap is reached, but the kill is asynchronous and
    // whatever it already wrote is sitting in the pipe. Every one of those buffered lines
    // still arrives, so the cap has to hold on the reading side too.
    const flood = await makeTempDir('clf-search-flood-');
    try {
      const lines = Array.from({ length: 4000 }, (_, i) => `needle ${i}`).join('\n');
      await writeTree(flood, { 'a.txt': `${lines}\n`, 'b.txt': `${lines}\n` });
      const out = await search(
        req({ realDir: flood, query: 'needle', mode: 'content', maxResults: 3, exclude: [] })
      );
      expect(out.hits).toHaveLength(3);
      expect(out.truncated).toBe(true);
      expect(out.stoppedBecause).toBe('limit');
    } finally {
      await removeTempDir(flood);
    }
  });

  it('reports paths without ripgrep relative-directory prefix', async () => {
    // rg runs with cwd set and "." as the target, so it reports ".\README.md". Left alone
    // that becomes "/root/./README.md", which matches nothing the caller can name.
    const out = await search(req({ query: 'findme', mode: 'content' }));
    for (const hit of out.hits) {
      expect(hit.path.startsWith('/root/')).toBe(true);
      expect(hit.path).not.toContain('/./');
      expect(hit.path).not.toContain('\\');
    }
    expect(out.hits.map((h) => h.path)).toContain('/root/README.md');
  });

  it('counts files it searched, not files that matched', async () => {
    const tree = await makeTempDir('clf-search-count-');
    try {
      await writeTree(tree, {
        'hit.txt': 'needle\n',
        'miss-one.txt': 'nothing here\n',
        'miss-two.txt': 'nothing here either\n'
      });
      const out = await search(
        req({ realDir: tree, query: 'needle', mode: 'content', exclude: [] })
      );
      expect(out.hits).toHaveLength(1);
      expect(out.filesScanned).toBe(3);
    } finally {
      await removeTempDir(tree);
    }
  });
});

describe('bounded output', () => {
  it('truncates a very long matching line', async () => {
    const long = await makeTempDir('clf-search-long-');
    try {
      await writeTree(long, { 'wide.txt': `${'z'.repeat(5000)}needle\n` });
      const out = await search(
        req({ realDir: long, query: 'needle', mode: 'content', exclude: [] })
      );
      expect(out.hits).toHaveLength(1);
      expect(out.hits[0]?.text?.length).toBeLessThanOrEqual(301);
      expect(out.hits[0]?.text?.endsWith('…')).toBe(true);
    } finally {
      await removeTempDir(long);
    }
  });

  it('survives a large file with no newlines', async () => {
    const wide = await makeTempDir('clf-search-wide-');
    try {
      await fs.writeFile(path.join(wide, 'oneline.txt'), 'a'.repeat(3 * 1024 * 1024));
      const out = await search(req({ realDir: wide, query: 'zzz', mode: 'content', exclude: [] }));
      expect(out.hits).toHaveLength(0);
    } finally {
      await removeTempDir(wide);
    }
  });
});
