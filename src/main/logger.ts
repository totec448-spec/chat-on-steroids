/**
 * The Activity log: a bounded in-memory ring for the diagnostics panel, mirrored to one
 * bounded file so a run can still be read after the app has quit.
 *
 * Callers are responsible for not passing secrets; as a backstop, anything that looks like
 * an OpenAI key or a tunnel token is masked before it is stored, so a mistake upstream
 * cannot leak a credential into the UI or the file.
 *
 * A line written while a tool call is running inherits that call's agent, which is what
 * makes the per-agent Activity filter mean anything. Lines written outside a call —
 * startup, the tunnel, the servers — stay unattributed, because they genuinely are.
 *
 * The file exists because the 2026-09-02 compaction failure had to be reconstructed from
 * session logs and durable state alone: the five hundred lines in memory were gone with the
 * process, and they were the only record of what the bridge decided and why.
 */

import { appendFileSync, renameSync, statSync } from 'node:fs';
import type { LogEntry } from '../shared/types.js';
import { currentAgent } from './mcp/call-context.js';

const MAX_ENTRIES = 500;
/** One rotation keeps the previous file, so the last two of these are always on disk. */
const MAX_LOG_FILE_BYTES = 4 * 1024 * 1024;

const entries: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

let logFile: string | null = null;
let logFileBytes = 0;

/**
 * Mirrors every line from here on to `file`, rotating it once to `file.1` when it fills.
 *
 * Synchronous and unconditional: the lines worth having are the ones written during a
 * crash or teardown, when nothing asynchronous is guaranteed to run. A write failure is
 * swallowed — the log is the reporting channel — and disables the mirror for this process.
 */
export function initLogFile(file: string): void {
  logFile = file;
  try {
    logFileBytes = statSync(file).size;
  } catch {
    logFileBytes = 0;
  }
}

function mirrorToFile(entry: LogEntry): void {
  if (!logFile) return;
  const line = `${new Date(entry.time).toISOString()}  ${entry.level.padEnd(5)}  ${entry.agent ? `[${entry.agent}] ` : ''}${entry.message}\n`;
  try {
    if (logFileBytes >= MAX_LOG_FILE_BYTES) {
      renameSync(logFile, `${logFile}.1`);
      logFileBytes = 0;
    }
    appendFileSync(logFile, line, 'utf8');
    logFileBytes += Buffer.byteLength(line, 'utf8');
  } catch {
    logFile = null;
  }
}

/** Masks anything shaped like a credential, wherever it appears in a message. */
export function redact(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '***jwt***')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (match) =>
      // Long opaque strings are tokens far more often than they are prose.
      /^[A-Za-z0-9_-]+$/.test(match) ? '***' : match
    );
}

/**
 * Opt-in console echo for troubleshooting a start-up that never reaches the UI.
 * Off unless CLF_DEBUG=1, so logs are not exposed by default, and it prints the
 * redacted text so enabling it can never surface a credential.
 */
const ECHO_TO_CONSOLE = process.env['CLF_DEBUG'] === '1';

export function log(level: LogEntry['level'], message: string): void {
  const agent = currentAgent();
  const entry: LogEntry = {
    time: Date.now(),
    level,
    message: redact(message),
    ...(agent ? { agent } : {})
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  mirrorToFile(entry);
  if (ECHO_TO_CONSOLE) process.stderr.write(`[${level}] ${entry.message}\n`);
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // Writing a log line must never be able to break the code that wrote it. Listeners run
      // synchronously on the caller's stack, and the one that matters here reaches the
      // renderer — which can already be gone while teardown is still logging its own progress.
      // A throw from there used to propagate into the shutdown step doing the logging and kill
      // it outright; that is how a force-close timer stopped forcing anything and left the app
      // draining a half-closed socket forever. There is nowhere useful to report this: the log
      // is the reporting channel.
    }
  }
}

export const logInfo = (message: string): void => log('info', message);
export const logWarn = (message: string): void => log('warn', message);
export const logError = (message: string): void => log('error', message);

export function getLog(): LogEntry[] {
  return [...entries];
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatLogForClipboard(): string {
  return entries
    .map((e) => `${new Date(e.time).toISOString()}  ${e.level.padEnd(5)}  ${e.message}`)
    .join('\n');
}

/** Machine-readable diagnostics export. Messages are already redacted on insertion. */
export function formatLogAsJson(): string {
  return JSON.stringify(
    entries.map((e) => ({
      time: new Date(e.time).toISOString(),
      level: e.level,
      message: e.message
    })),
    null,
    2
  );
}
