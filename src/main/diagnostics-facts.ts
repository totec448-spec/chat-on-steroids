/**
 * Facts for the diagnostics report that the log alone cannot give (user, 2026-10-15): how the app
 * was installed, the machine, crashes and restarts, the most frequent warnings, tool call numbers
 * and the state of each chat. A bug report with the report attached should need no follow-up
 * question. Everything here is a number, a state or a short option name; free text (the error
 * summary's sample lines) goes through the report's scrubber like the log does.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const DAY = 86_400_000;

// ---- Tool calls ---------------------------------------------------------------------------

export type ToolOutcome = 'ok' | 'error' | 'timeout';
interface ToolCallRecord { name: string; outcome: ToolOutcome; ms: number; at: number }
/** A day of calls for even a busy swarm; the oldest go first. */
const MAX_TOOL_CALLS = 20_000;
let toolCalls: ToolCallRecord[] = [];

/** Whether a tool's result was an answer, an error, or a wait that ran out. */
export function toolOutcome(result: { isError?: boolean; content?: unknown }): ToolOutcome {
  if (result?.isError !== true) return 'ok';
  const text = Array.isArray(result.content)
    ? result.content.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') ? (part as { text: string }).text : '').join(' ')
    : '';
  return /\bTIMEOUT\b|timed out/i.test(text.slice(0, 2000)) ? 'timeout' : 'error';
}

export function noteToolCall(name: string, outcome: ToolOutcome, ms: number, at = Date.now()): void {
  toolCalls.push({ name: name.slice(0, 60), outcome, ms: Math.max(0, Math.round(ms)), at });
  if (toolCalls.length > MAX_TOOL_CALLS) toolCalls = toolCalls.slice(-MAX_TOOL_CALLS);
}

export function toolCallLines(now = Date.now()): string[] {
  const byName = new Map<string, ToolCallRecord[]>();
  for (const call of toolCalls) {
    if (now - call.at > DAY || call.at > now + 60_000) continue;
    byName.set(call.name, [...(byName.get(call.name) ?? []), call]);
  }
  if (!byName.size) return ['(no tool calls in the last 24 hours)'];
  return [...byName.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([name, calls]) => {
    const times = calls.map(call => call.ms).sort((a, b) => a - b);
    const median = times[Math.floor((times.length - 1) / 2)]!;
    const count = (outcome: ToolOutcome) => calls.filter(call => call.outcome === outcome).length;
    return `${name}: ${calls.length} call(s), ${count('error')} error(s), ${count('timeout')} timeout(s), median ${median} ms`;
  });
}

// ---- Error summary ------------------------------------------------------------------------

interface ErrorKind { level: string; sample: string; count: number; first: number; last: number }
/** Distinct kinds kept; past this a new kind replaces the rarest, so memory stays bounded. */
const MAX_ERROR_KINDS = 500;
const errorKinds = new Map<string, ErrorKind>();

/** Numbers, ids and quoted values vary from line to line; the rest says what went wrong. */
const kindOf = (message: string): string => message
  .replace(/'[^']*'|"[^"]*"/g, '"…"')
  .replace(/\b[0-9a-f]{6,}(?:-[0-9a-f]{2,})*\b/gi, '#')
  .replace(/\d+/g, '#')
  .slice(0, 200);

export function tallyLogEntry(entry: { time: number; level: string; message: string }): void {
  if (entry.level !== 'warn' && entry.level !== 'error') return;
  const key = `${entry.level} ${kindOf(entry.message)}`;
  const known = errorKinds.get(key);
  if (known) { known.count += 1; known.last = entry.time; return; }
  if (errorKinds.size >= MAX_ERROR_KINDS) {
    let rarest: string | null = null;
    for (const [candidate, kind] of errorKinds) if (!rarest || kind.count < errorKinds.get(rarest)!.count) rarest = candidate;
    if (rarest) errorKinds.delete(rarest);
  }
  errorKinds.set(key, { level: entry.level, sample: entry.message.slice(0, 300), count: 1, first: entry.time, last: entry.time });
}

const clock = (at: number) => new Date(at).toISOString().slice(11, 16);

/** The 20 most frequent warning and error kinds since the app started, with one sample each. */
export function errorSummaryLines(limit = 20): string[] {
  const kinds = [...errorKinds.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, limit);
  if (!kinds.length) return ['(no warnings or errors since the app started)'];
  return kinds.map(kind => `${kind.count}× ${kind.level} ${clock(kind.first)}–${clock(kind.last)} UTC: ${kind.sample}`);
}

export function errorKindsForTests(): number { return errorKinds.size; }

// ---- Crashes, restarts and sleep ----------------------------------------------------------

const runtimeEvents = new Map<string, number>();

/** A page or helper process that ended, or the computer going to sleep, this run. */
export function noteRuntimeEvent(what: string): void {
  runtimeEvents.set(what, (runtimeEvents.get(what) ?? 0) + 1);
}

async function crashReportTimes(dir: string, depth = 0): Promise<number[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const times: number[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 3) times.push(...await crashReportTimes(full, depth + 1));
    else if (entry.isFile() && /\.dmp$/i.test(entry.name)) {
      const info = await stat(full).catch(() => null);
      if (info) times.push(info.mtimeMs);
    }
  }
  return times;
}

/** Crash report dates only: their names and contents can hold paths and memory. */
export async function crashLines(dir: string | null, now = Date.now()): Promise<string[]> {
  const recent = (dir ? await crashReportTimes(dir) : []).filter(at => now - at <= 30 * DAY).sort((a, b) => b - a);
  const dates = recent.slice(0, 10).map(at => new Date(at).toISOString().slice(0, 16) + 'Z');
  const events = [...runtimeEvents.entries()].map(([what, count]) => `${what} ×${count}`);
  return [
    `Crash reports in the last 30 days: ${recent.length}${dates.length ? ` (${dates.join(', ')})` : ''}`,
    events.length ? `This run: ${events.join(', ')}` : 'This run: no restarts or sleep recorded'
  ];
}

// ---- Install and system -------------------------------------------------------------------

const under = (parent: string | undefined, child: string, sep: string) =>
  !!parent && child.toLowerCase().startsWith(parent.replace(/[\\/]+$/, '').toLowerCase() + sep);

/** How the app was installed, in words that name no folder. */
export function installKind(platform: string, execPath: string, env: Record<string, string | undefined>): string {
  if (platform === 'win32') {
    if (env.PORTABLE_EXECUTABLE_DIR) return 'Windows portable';
    if (under(env.ProgramFiles, execPath, '\\') || under(env['ProgramFiles(x86)'], execPath, '\\')) return 'Windows installer, for all users (Program Files)';
    if (/\\AppData\\Local\\Programs\\/i.test(execPath)) return 'Windows installer, for this user';
    return 'Windows installer, custom folder';
  }
  if (platform === 'darwin') {
    if (execPath.includes('/AppTranslocation/')) return 'macOS app run from a translocated copy (not moved to Applications)';
    if (execPath.startsWith('/Applications/')) return 'macOS app in /Applications';
    return 'macOS app outside /Applications';
  }
  if (env.APPIMAGE) return 'Linux AppImage';
  if (env.SNAP) return 'Linux snap';
  if (execPath.startsWith('/opt/')) return 'Linux package (/opt)';
  return 'Linux, other';
}

export interface InstallFacts {
  kind: string;
  packaged: boolean;
  /** Whether the app can write its own folder; null when unknown. A silent update needs it (#1490). */
  folderWritable: boolean | null;
  /** macOS only: the download quarantine is still on the app; null elsewhere or unknown. */
  quarantined: boolean | null;
  update: { current: string; latest: string | null; stage: string; error: string | null; checkedAt: number | null; notInstalled?: string | null };
  now: number;
}

const yesNo = (value: boolean) => value ? 'yes' : 'no';

export function installLines(facts: InstallFacts): string[] {
  const { update } = facts;
  const checked = update.checkedAt === null ? 'not checked yet' : `checked ${Math.round((facts.now - update.checkedAt) / 60_000)} min ago`;
  return [
    `Installed as: ${facts.kind} (${facts.packaged ? 'packaged' : 'development build'})`,
    `App folder writable by the app: ${facts.folderWritable === null ? 'unknown' : yesNo(facts.folderWritable)}`,
    ...(facts.quarantined === null ? [] : [`macOS download quarantine still set: ${yesNo(facts.quarantined)}`]),
    // After a check, no `latest` means nothing newer was published.
    update.checkedAt !== null && update.latest === null && update.stage === 'idle'
      ? `Update: up to date (${update.current}), ${checked}`
      : `Update: ${update.stage}, latest ${update.latest ?? 'unknown'}, ${checked}`,
    ...(update.error ? [`Last update error: ${update.error.slice(0, 300)}`] : []),
    ...(update.notInstalled ? [`Handed to the installer but not installed: ${update.notInstalled}`] : [])
  ];
}

export interface SystemFacts {
  totalBytes: number; freeBytes: number; cpuModel: string; cpuCount: number;
  diskFreeBytes: number | null; uptimeSeconds: number; scaleFactors: number[];
}

const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

export function systemLines(facts: SystemFacts): string[] {
  const minutes = Math.floor(facts.uptimeSeconds / 60);
  return [
    `Memory: ${gb(facts.totalBytes)} total, ${gb(facts.freeBytes)} free`,
    `CPU: ${facts.cpuModel.replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown'}, ${facts.cpuCount} cores`,
    `Free disk space where the app keeps its data: ${facts.diskFreeBytes === null ? 'unknown' : gb(facts.diskFreeBytes)}`,
    `App running for ${Math.floor(minutes / 60)} h ${minutes % 60} min`,
    `Display scale: ${facts.scaleFactors.length ? facts.scaleFactors.join(', ') : 'unknown'}`
  ];
}

// ---- Chats --------------------------------------------------------------------------------

export interface ChatFactsSession {
  id: string; updatedAt: number; endedAt: number | null; toolCalls: number;
  /** Present on real sessions; never reported. */
  title?: string;
  processExitNonzero?: number; toolRejected?: number; lastToolCallAt?: number | null;
  selectedModel?: { model?: string } | null; workerAssignment?: unknown;
}

/** The most recently active chats are listed; the rest are only counted. */
const MAX_CHAT_LINES = 15;

/** Chats active in the last day, newest first and numbered; never their ids, titles or tasks. */
export function chatLines(sessions: ChatFactsSession[], inputs: Array<{ sessionId: string | null; state: string }>, now = Date.now()): string[] {
  const active = sessions.filter(session => session.endedAt === null && now - session.updatedAt <= DAY)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const lines = active.slice(0, MAX_CHAT_LINES).map((session, index) => {
    const mine = inputs.filter(input => input.sessionId === session.id);
    const states = [...new Set(mine.map(input => input.state))].map(state => `${state} ${mine.filter(input => input.state === state).length}`);
    const model = session.selectedModel?.model && /^[A-Za-z0-9._:-]{1,40}$/.test(session.selectedModel.model) ? `, model ${session.selectedModel.model}` : '';
    return `#${index + 1} ${session.workerAssignment ? 'worker' : 'main'} chat${model}: active ${Math.round((now - session.updatedAt) / 60_000)} min ago, ` +
      `${session.toolCalls} tool call(s), ${session.processExitNonzero ?? 0} failed command(s), ${session.toolRejected ?? 0} refused, ` +
      `inputs: ${states.length ? states.join(', ') : 'none'}`;
  });
  const known = new Set(sessions.map(session => session.id));
  const orphaned = inputs.filter(input => !input.sessionId || !known.has(input.sessionId)).length;
  const unlisted = active.length - lines.length;
  return [...lines, `Older or ended chats: ${sessions.length - active.length}; inputs without a chat: ${orphaned}` +
    (unlisted > 0 ? `; ${unlisted} more active chat(s) not listed` : '')];
}

export function resetDiagnosticsFactsForTests(): void {
  toolCalls = [];
  errorKinds.clear();
  runtimeEvents.clear();
}
