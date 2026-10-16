import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import { logWarn } from './logger.js';
import { usageDateKey } from '../shared/usage.js';
import {
  PROVIDER_USAGE_DAYS, claudeDayTotals, foldClaudeLine, foldCodexLine, newClaudeFileState, newCodexFileState,
  type ClaudeFileState, type ClaudeTokens, type CodexDayTokens, type CodexFileState, type CodexLimit, type ProviderUsage
} from '../shared/provider-usage.js';

/**
 * Reads Codex's and Claude Code's own local logs for the Usage page and the Core `usage` tool.
 *
 * Only files written in the last week are opened, and each only from where the previous read
 * ended: the logs run to gigabytes, and they are append-only. A line is parsed only when it can
 * hold a reading (`token_count`, an assistant message); nothing else, and no content, is kept.
 */
interface Tracked<S> { size: number; mtimeMs: number; offset: number; rest: string; state: S }

const CHUNK = 1 << 20;
/** A line this long holds no reading worth its memory; it is skipped to its end. */
const MAX_LINE = 4 << 20;
const CACHE_MS = 30_000;
const codexFiles = new Map<string, Tracked<CodexFileState>>();
const claudeFiles = new Map<string, Tracked<ClaudeFileState>>();
let flight: Promise<ProviderUsage> | null = null;
let cached: { at: number; value: ProviderUsage } | null = null;

export interface ProviderUsageHomes { codex: string; claude: string }
export function providerUsageHomes(env: NodeJS.ProcessEnv = process.env): ProviderUsageHomes {
  return {
    codex: env['CODEX_HOME']?.trim() || path.join(os.homedir(), '.codex'),
    claude: env['CLAUDE_CONFIG_DIR']?.trim() || path.join(os.homedir(), '.claude')
  };
}

export function readProviderUsage(options: { now?: number; homes?: ProviderUsageHomes; fresh?: boolean } = {}): Promise<ProviderUsage> {
  const now = options.now ?? Date.now();
  if (!options.fresh && !options.homes && cached && now - cached.at < CACHE_MS) return Promise.resolve(cached.value);
  return flight ??= compute(now, options.homes ?? providerUsageHomes())
    .then(value => { if (!options.homes) cached = { at: now, value }; return value; })
    .finally(() => { flight = null; });
}

/** Test seam: forgets every file read so far. */
export function resetProviderUsageForTests(): void {
  codexFiles.clear(); claudeFiles.clear(); cached = null; flight = null;
}

async function compute(now: number, homes: ProviderUsageHomes): Promise<ProviderUsage> {
  if (getConfig().ui.localAppUsage === false) return { enabled: false, readAt: now, codex: null, claude: null };
  const since = windowStart(now);
  const [codex, claude] = await Promise.all([readCodex(homes.codex, since, now), readClaude(homes.claude, since, now)]);
  return { enabled: true, readAt: now, codex, claude };
}

/** Local midnight, `PROVIDER_USAGE_DAYS - 1` days ago. */
function windowStart(now: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() - (PROVIDER_USAGE_DAYS - 1));
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function windowDays(now: number): string[] {
  const keys: string[] = [];
  for (let back = PROVIDER_USAGE_DAYS - 1; back >= 0; back--) {
    const date = new Date(now);
    date.setDate(date.getDate() - back);
    keys.push(usageDateKey(date));
  }
  return keys;
}

async function entries(dir: string): Promise<Array<{ name: string; directory: boolean }>> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
  } catch { return []; }
}

async function recentFiles(paths: string[], since: number): Promise<Array<{ file: string; size: number; mtimeMs: number }>> {
  const found: Array<{ file: string; size: number; mtimeMs: number }> = [];
  for (const file of paths) {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile() && stat.mtimeMs >= since) found.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch { /* removed while listing */ }
  }
  return found;
}

/** Reads one append-only log from where the last read ended; a shorter or rewritten file is read again. */
async function follow<S>(known: Map<string, Tracked<S>>, file: { file: string; size: number; mtimeMs: number },
  fresh: () => S, marker: string, fold: (state: S, line: string) => void): Promise<S> {
  let tracked = known.get(file.file);
  if (!tracked || file.size < tracked.offset) tracked = { size: 0, mtimeMs: 0, offset: 0, rest: '', state: fresh() };
  if (tracked.offset < file.size) {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(file.file, 'r');
      const buffer = Buffer.alloc(CHUNK);
      while (tracked.offset < file.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, file.size - tracked.offset), tracked.offset);
        if (!bytesRead) break;
        tracked.offset += bytesRead;
        const lines = (tracked.rest + buffer.toString('utf8', 0, bytesRead)).split('\n');
        tracked.rest = lines.pop() ?? '';
        // An overlong line is dropped up to its end rather than held in memory.
        if (tracked.rest.length > MAX_LINE) tracked.rest = '\u0000';
        for (const line of lines) if (!line.startsWith('\u0000') && line.includes(marker)) fold(tracked.state, line);
      }
    } catch (error) {
      logWarn(`usage: could not read ${path.basename(file.file)}: ${String(error)}`);
    } finally { await handle?.close().catch(() => undefined); }
  }
  tracked.size = file.size; tracked.mtimeMs = file.mtimeMs;
  known.set(file.file, tracked);
  return tracked.state;
}

async function readCodex(home: string, since: number, now: number): Promise<ProviderUsage['codex']> {
  const root = path.join(home, 'sessions');
  // Sessions live in YYYY/MM/DD folders by start day; a long one started earlier may still be writing.
  const candidates: string[] = [];
  for (const year of await entries(root)) {
    if (!year.directory || !/^\d{4}$/.test(year.name)) continue;
    for (const month of await entries(path.join(root, year.name))) {
      if (!month.directory || !/^\d{2}$/.test(month.name)) continue;
      for (const day of await entries(path.join(root, year.name, month.name))) {
        if (!day.directory || !/^\d{2}$/.test(day.name)) continue;
        const started = new Date(Number(year.name), Number(month.name) - 1, Number(day.name)).getTime();
        if (started < since - 30 * 86_400_000) continue;
        const dir = path.join(root, year.name, month.name, day.name);
        for (const file of await entries(dir)) if (!file.directory && file.name.endsWith('.jsonl')) candidates.push(path.join(dir, file.name));
      }
    }
  }
  if (!candidates.length && !(await entries(root)).length) return null;
  const limits = new Map<string, CodexLimit>();
  const days = new Map<string, CodexDayTokens>();
  for (const file of await recentFiles(candidates, since)) {
    const state = await follow(codexFiles, file, newCodexFileState, '"token_count"', foldCodexLine);
    for (const limit of state.limits.values()) {
      const known = limits.get(limit.id);
      if (!known || known.observedAt < limit.observedAt) limits.set(limit.id, limit);
    }
    for (const [key, tokens] of state.days) {
      const day = days.get(key) ?? { input: 0, cachedInput: 0, output: 0 };
      days.set(key, { input: day.input + tokens.input, cachedInput: day.cachedInput + tokens.cachedInput, output: day.output + tokens.output });
    }
  }
  return {
    limits: [...limits.values()].sort((a, b) => (a.id === 'codex' ? -1 : b.id === 'codex' ? 1 : b.observedAt - a.observedAt)),
    days: windowDays(now).map(date => ({ date, ...(days.get(date) ?? { input: 0, cachedInput: 0, output: 0 }) }))
  };
}

async function readClaude(home: string, since: number, now: number): Promise<ProviderUsage['claude']> {
  const root = path.join(home, 'projects');
  const projects = await entries(root);
  if (!projects.length) return null;
  // projects/<project>/<session>.jsonl, and a session's sub-agents in <session>/subagents/*.jsonl.
  const candidates: string[] = [];
  for (const project of projects) {
    if (!project.directory) continue;
    const dir = path.join(root, project.name);
    for (const entry of await entries(dir)) {
      if (!entry.directory && entry.name.endsWith('.jsonl')) candidates.push(path.join(dir, entry.name));
      else if (entry.directory) {
        const agents = path.join(dir, entry.name, 'subagents');
        for (const file of await entries(agents)) if (!file.directory && file.name.endsWith('.jsonl')) candidates.push(path.join(agents, file.name));
      }
    }
  }
  const states: ClaudeFileState[] = [];
  for (const file of await recentFiles(candidates, since)) states.push(await follow(claudeFiles, file, newClaudeFileState, '"type":"assistant"', foldClaudeLine));
  const days = claudeDayTotals(states);
  return {
    days: windowDays(now).map(date => ({
      date, models: [...(days.get(date) ?? new Map<string, ClaudeTokens>()).entries()]
        .map(([model, tokens]) => ({ model, ...tokens })).sort((a, b) => a.model.localeCompare(b.model))
    }))
  };
}
