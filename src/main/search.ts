/**
 * Filename and content search.
 *
 * Deliberately no index and no bundled ripgrep: a bounded walk with sensible
 * exclusions, an early exit at maxResults and a wall-clock budget keeps real source
 * trees fast enough while leaving the app a single self-contained download. Every
 * search reports whether it stopped early so the model knows to narrow the scope.
 */

import { rawCreateReadStream as createReadStream, rawPromises as fs } from './rawfs.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { locateRipgrep } from './ripgrep.js';
import { isExcludedFolderName, sniffBinaryBytes, type TextEncoding } from './fsops.js';

/**
 * Skipped by default because they are large and rarely what anyone means. The model
 * can search them by passing an explicit exclude list (including an empty one), so
 * nothing is permanently unreachable.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.gradle',
  '.gradle-user',
  '.idea',
  '.vs',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.cache',
  '.turbo',
  '.go-build-cache',
  '.go-module-cache',
  '.go-tools',
  '.gopath',
  '.tmp',
  '.tmp-go-cache',
  '.tmp-go-path',
  // User-profile/tooling trees that are useful when explicitly opened, but extremely
  // noisy when a model recursively searches a broad root such as a home directory.
  // Because exclusions apply only to child folders, explicitly searching inside one
  // of these paths still works normally.
  '.android',
  '.bun',
  '.claude',
  '.claude-*',
  '.codex',
  '.cursor',
  '.gemini',
  '.npm',
  '.pnpm-store',
  '.yarn',
  // Packaged application output is generated and routinely contains hundreds of
  // Electron/runtime files. Source lives elsewhere and should win the default budget.
  'release',
  'release-*',
  'appdata'
];

/** Files above this are deliberately not fed into content matching; callers must be told. */
export const MAX_CONTENT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_SCANNED = 40_000;
const MAX_DIRECTORIES_SCANNED = 10_000;
const TIME_BUDGET_MS = 10_000;
const CONTENT_CONCURRENCY = 12;
const MAX_LINE_CHARS = 300;

export interface SearchHit {
  path: string;
  /** Present for content matches only. */
  line?: number;
  /** Trimmed matching line, for content matches only. */
  text?: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  filesScanned: number;
  truncated: boolean;
  /** Why the search stopped early, if it did. */
  stoppedBecause: 'limit' | 'time' | 'files' | 'size' | null;
  elapsedMs: number;
}

export interface SearchRequest {
  realDir: string;
  virtualDir: string;
  query: string;
  mode: 'name' | 'content';
  include?: string | undefined;
  exclude: readonly string[];
  caseSensitive: boolean;
  regex?: boolean;
  maxResults: number;
  /** Absolute whole-tool deadline shared by every approved root. */
  deadline?: number;
}

/** Translates a glob into a regex. Supports *, ?, ** and nothing else, on purpose. */
export function globToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" spans zero or more directories; a bare "**" spans anything.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, caseSensitive ? '' : 'i');
}

function compileIncludeMatcher(pattern: string, caseSensitive: boolean): (relPath: string) => boolean {
  const re = globToRegExp(pattern, caseSensitive);
  const matchBaseName = !pattern.includes('/');
  return (relPath: string): boolean => {
    if (re.test(relPath)) return true;
    // A pattern with no slash is conventionally matched against the file name alone.
    return matchBaseName && re.test(path.basename(relPath));
  };
}

/** Translate the connector's deliberately small glob grammar into ripgrep's richer grammar. */
function ripgrepIncludeGlob(pattern: string): string {
  let out = '';
  for (const char of pattern) {
    // These are the only metacharacters the connector itself promises.
    if (char === '*' || char === '?' || char === '/') {
      out += char;
      continue;
    }
    // Ripgrep assigns extra meaning to these; the connector treats them literally.
    if (char === '\\' || char === '[' || char === ']' || char === '{' || char === '}' || char === '!') {
      out += `\\${char}`;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Converts the connector's folder-name exclude syntax to ripgrep's glob syntax.
 *
 * Excludes are deliberately much simpler than globs: a folder name is literal, except for one
 * optional trailing `*` meaning "this name prefix". The JS fallback enforces exactly that and is
 * case-insensitive, so passing the raw text to `rg --glob` was wrong in two ways: stored casing
 * such as `BUILD` bypassed `build`, and characters such as `[` acquired glob semantics. Escape
 * every glob metacharacter in the literal part and use `--iglob` for parity.
 */
function ripgrepExcludeGlob(raw: string): string {
  const prefix = raw.endsWith('*');
  const literal = prefix ? raw.slice(0, -1) : raw;
  const escaped = literal.replace(/[\\*?\[\]{}]/g, '\\$&');
  return `!**/${escaped}${prefix ? '*' : ''}/**`;
}

function textEncodingFromHead(head: Buffer): TextEncoding {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

async function searchWithRipgrep(
  executable: string,
  req: SearchRequest,
  realTarget: string,
  virtualTarget: string,
  targetIsFile = false
): Promise<SearchOutcome> {
  const started = Date.now();
  const deadline = Math.min(started + TIME_BUDGET_MS, req.deadline ?? Number.POSITIVE_INFINITY);
  if (deadline <= started) {
    return { hits: [], filesScanned: 0, truncated: true, stoppedBecause: 'time', elapsedMs: 0 };
  }
  const args = [
    '--json',
    '--line-number',
    '--color',
    'never',
    '--hidden',
    '--no-ignore',
    '--max-filesize',
    String(MAX_CONTENT_FILE_BYTES)
  ];
  if (!req.caseSensitive) args.push('--ignore-case');
  if (!req.regex) args.push('--fixed-strings');
  if (req.include) args.push(req.caseSensitive ? '--glob' : '--iglob', ripgrepIncludeGlob(req.include));
  for (const excluded of req.exclude) args.push('--iglob', ripgrepExcludeGlob(excluded));
  args.push('--', req.query, targetIsFile ? realTarget : '.');

  return new Promise<SearchOutcome>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: targetIsFile ? path.dirname(realTarget) : realTarget,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const hits: SearchHit[] = [];
    let filesScanned = 0;
    let stdout = '';
    let stderr = '';
    let stoppedBecause: SearchOutcome['stoppedBecause'] = null;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve({
        hits,
        filesScanned,
        truncated: stoppedBecause !== null,
        stoppedBecause,
        elapsedMs: Date.now() - started
      });
    };

    const consider = (line: string): void => {
      if (!line) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === 'summary') {
        // `begin` is emitted once per file that *has* a match, so counting it reported
        // matches, not coverage. The summary is the only event that knows how many files
        // were actually searched.
        const searches = Number(event?.data?.stats?.searches);
        if (Number.isSafeInteger(searches)) filesScanned = searches;
        return;
      }
      if (event?.type !== 'match') return;
      // Killing the child does not stop this. The pipe already holds whatever ripgrep
      // wrote before the signal landed, and every buffered line still arrives here, so
      // without this guard a maxResults of 3 could return 9.
      if (stoppedBecause !== null) return;
      const data = event.data;
      const lineNo = Number(data?.line_number);
      // With a target of "." and cwd set, ripgrep reports paths as ".\README.md". Left
      // alone that becomes "/root/./README.md" and no caller can match it against the
      // path it asked about.
      const rawPath = String(data?.path?.text ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '');
      const rawText = String(data?.lines?.text ?? '').replace(/\r?\n$/, '');
      const trimmed = rawText.trim();
      const hitPath = targetIsFile
        ? virtualTarget
        : `${virtualTarget}/${rawPath}`.replace(/\/+/g, '/').replace(/\/\.\//g, '/');
      hits.push({
        path: hitPath,
        line: Number.isSafeInteger(lineNo) ? lineNo : undefined,
        text: trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed
      });
      if (hits.length >= req.maxResults && stoppedBecause === null) {
        stoppedBecause = 'limit';
        child.kill();
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      let consumed = 0;
      for (;;) {
        const newline = stdout.indexOf('\n', consumed);
        if (newline === -1) break;
        consider(stdout.slice(consumed, newline).trim());
        consumed = newline + 1;
      }
      if (consumed > 0) stdout = stdout.slice(consumed);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8000);
    });
    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(new Error(`ripgrep could not start${code ? ` (${code})` : ''}`));
    });
    child.once('close', (code) => {
      if (stdout.trim()) consider(stdout.trim());
      // rg uses 1 for "no matches". A deliberate limit/time kill can return any code.
      if (stoppedBecause !== null || code === 0 || code === 1) finish();
      // Never surface rg's raw stderr here. For an exact file it can echo the hidden native
      // approved-root path after a rename/ACL race; the model only needs the backend verdict.
      else finish(new Error(`ripgrep search failed${code === null ? '' : ` (exit ${code})`}`));
    });
    const timer = setTimeout(() => {
      if (stoppedBecause === null) stoppedBecause = 'time';
      child.kill();
    }, Math.max(1, deadline - Date.now()));
  });
}

export async function search(req: SearchRequest): Promise<SearchOutcome> {
  if (req.mode === 'content') {
    const ripgrep = locateRipgrep();
    if (ripgrep) return searchWithRipgrep(ripgrep, req, req.realDir, req.virtualDir);
    if (req.regex) throw new Error('Regex content search requires the bundled ripgrep runtime.');
  }
  const started = Date.now();
  const deadline = Math.min(started + TIME_BUDGET_MS, req.deadline ?? Number.POSITIVE_INFINITY);
  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let directoriesScanned = 0;
  let stoppedBecause: SearchOutcome['stoppedBecause'] = null;

  const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
  const includeMatcher = req.include ? compileIncludeMatcher(req.include, req.caseSensitive) : null;
  const candidates: Array<{ real: string; rel: string }> = [];

  const outOfBudget = (): boolean => {
    if (Date.now() > deadline) {
      stoppedBecause = 'time';
      return true;
    }
    if (filesScanned >= MAX_FILES_SCANNED) {
      stoppedBecause = 'files';
      return true;
    }
    return false;
  };

  const pendingDirectories: Array<{ dir: string; rel: string }> = [{ dir: req.realDir, rel: '' }];
  // Queue head cursor rather than Array.shift(): a broad tree can enqueue thousands of
  // directories, and shifting the front reindexes the whole remaining array on every BFS
  // step. Keeping the same append-only breadth-first order makes traversal O(n) instead of
  // adding an avoidable O(n²) queue-management term.
  let directoryHead = 0;
  while (directoryHead < pendingDirectories.length && !outOfBudget()) {
    if (directoriesScanned >= MAX_DIRECTORIES_SCANNED) {
      stoppedBecause = 'files';
      break;
    }
    const current = pendingDirectories[directoryHead++]!;
    directoriesScanned++;
    let directory;
    try {
      directory = await fs.opendir(current.dir);
    } catch {
      continue;
    }
    try {
      for await (const dirent of directory) {
        if (outOfBudget()) break;
        const childRel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) {
          if (!isExcludedFolderName(dirent.name, req.exclude)) {
            pendingDirectories.push({ dir: path.join(current.dir, dirent.name), rel: childRel });
          }
          continue;
        }
        if (!dirent.isFile()) continue;
        filesScanned++;
        if (includeMatcher && !includeMatcher(childRel)) continue;
        if (req.mode === 'name') {
          const haystack = req.caseSensitive ? dirent.name : dirent.name.toLowerCase();
          if (needle === '' || haystack.includes(needle)) {
            hits.push({ path: `${req.virtualDir}/${childRel}` });
            if (hits.length >= req.maxResults) {
              stoppedBecause = 'limit';
              break;
            }
          }
        } else {
          candidates.push({ real: path.join(current.dir, dirent.name), rel: childRel });
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    if (stoppedBecause === 'limit') break;
  }

  if (req.mode === 'content' && stoppedBecause !== 'limit') {
    await scanContents(req, candidates, hits, deadline, (reason) => {
      stoppedBecause = reason;
    });
  }

  return {
    hits,
    filesScanned,
    truncated: stoppedBecause !== null,
    stoppedBecause,
    elapsedMs: Date.now() - started
  };
}

async function scanContents(
  req: SearchRequest,
  candidates: Array<{ real: string; rel: string }>,
  hits: SearchHit[],
  deadline: number,
  stop: (reason: 'limit' | 'time') => void
): Promise<void> {
  let index = 0;
  let done = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (done) return;
      if (Date.now() > deadline) {
        done = true;
        stop('time');
        return;
      }
      const item = candidates[index++];
      if (!item) return;
      if (hits.length >= req.maxResults) {
        done = true;
        stop('limit');
        return;
      }
      const found = await scanOneFile(item.real, req);
      for (const hit of found) {
        if (hits.length >= req.maxResults) {
          done = true;
          stop('limit');
          return;
        }
        hits.push({ path: `${req.virtualDir}/${item.rel}`, line: hit.line, text: hit.text });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONTENT_CONCURRENCY, candidates.length || 1) }, worker)
  );
}

export async function searchOneFile(
  realPath: string,
  virtualPath: string,
  req: Pick<SearchRequest, 'query' | 'mode' | 'include' | 'caseSensitive' | 'regex' | 'maxResults' | 'deadline'>
): Promise<SearchOutcome> {
  const started = Date.now();
  const rel = path.basename(virtualPath);
  // Ripgrep deliberately ignores glob filters when the search target is one explicit file.
  // Apply the connector's include contract before selecting either backend so both paths agree.
  if (req.include && !compileIncludeMatcher(req.include, req.caseSensitive)(rel)) {
    return { hits: [], filesScanned: 1, truncated: false, stoppedBecause: null, elapsedMs: Date.now() - started };
  }
  if (req.mode === 'content') {
    // Both the bundled-rg path (`--max-filesize`) and the JS fallback intentionally skip files
    // above this ceiling. For an explicitly named file, returning plain "No matches" is false:
    // the file was never searched. Surface the stop reason before either backend can hide it.
    try {
      const stat = await fs.stat(realPath);
      if (stat.size > MAX_CONTENT_FILE_BYTES) {
        return {
          hits: [],
          filesScanned: 0,
          truncated: true,
          stoppedBecause: 'size',
          elapsedMs: Date.now() - started
        };
      }
    } catch {
      // Preserve the backend's existing missing/unreadable-file behaviour below.
    }
  }
  if (req.mode === 'content') {
    const ripgrep = locateRipgrep();
    if (ripgrep) {
      return searchWithRipgrep(
        ripgrep,
        { ...req, realDir: path.dirname(realPath), virtualDir: path.dirname(virtualPath).replace(/\\/g, '/'), exclude: [] },
        realPath,
        virtualPath,
        true
      );
    }
    if (req.regex) throw new Error('Regex content search requires the bundled ripgrep runtime.');
  }
  if (req.mode === 'name') {
    const haystack = req.caseSensitive ? rel : rel.toLowerCase();
    const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
    const hits = needle === '' || haystack.includes(needle) ? [{ path: virtualPath }] : [];
    return { hits, filesScanned: 1, truncated: false, stoppedBecause: null, elapsedMs: Date.now() - started };
  }
  const found = await scanOneFile(realPath, {
    realDir: path.dirname(realPath),
    virtualDir: path.dirname(virtualPath).replace(/\\/g, '/'),
    query: req.query,
    mode: 'content',
    include: req.include,
    exclude: [],
    caseSensitive: req.caseSensitive,
    maxResults: req.maxResults
  });
  const limited = found.slice(0, req.maxResults);
  return {
    hits: limited.map((hit) => ({ path: virtualPath, line: hit.line, text: hit.text })),
    filesScanned: 1,
    truncated: found.length > limited.length,
    stoppedBecause: found.length > limited.length ? 'limit' : null,
    elapsedMs: Date.now() - started
  };
}

async function scanOneFile(
  realPath: string,
  req: SearchRequest
): Promise<Array<{ line: number; text: string }>> {
  let stat;
  try {
    stat = await fs.stat(realPath);
  } catch {
    return [];
  }
  if (stat.size === 0 || stat.size > MAX_CONTENT_FILE_BYTES) return [];
  const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
  let regex: RegExp | null = null;
  if (req.regex) {
    try {
      regex = new RegExp(req.query, req.caseSensitive ? '' : 'i');
    } catch (error) {
      throw new Error(`Invalid search regex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const results: Array<{ line: number; text: string }> = [];
  let lineNo = 0;
  let carry = '';
  let decoder: TextDecoder | null = null;

  const consider = (line: string): void => {
    lineNo++;
    const haystack = req.caseSensitive ? line : line.toLowerCase();
    if (regex ? !regex.test(line) : !haystack.includes(needle)) return;
    const trimmed = line.trim();
    results.push({
      line: lineNo,
      text: trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed
    });
  };

  const stream = createReadStream(realPath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const data = chunk as Buffer;
      if (decoder === null) {
        if (sniffBinaryBytes(data.subarray(0, Math.min(8192, data.length)))) return [];
        decoder = new TextDecoder(textEncodingFromHead(data));
      }
      carry += decoder.decode(data, { stream: true });
      let at = carry.indexOf('\n');
      while (at !== -1) {
        consider(carry.slice(0, at).replace(/\r$/, ''));
        carry = carry.slice(at + 1);
        at = carry.indexOf('\n');
      }
      // A file with no newlines would otherwise grow `carry` without bound.
      if (carry.length > MAX_CONTENT_FILE_BYTES) break;
    }
    if (decoder !== null) carry += decoder.decode();
    if (carry.length > 0) consider(carry.replace(/\r$/, ''));
  } catch {
    return results;
  } finally {
    stream.destroy();
  }
  return results;
}
