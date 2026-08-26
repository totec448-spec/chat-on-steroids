/**
 * Minimal in-memory log for the diagnostics panel.
 *
 * Nothing here is written to disk. Callers are responsible for not passing secrets;
 * as a backstop, anything that looks like an OpenAI key or a tunnel token is masked
 * before it is stored, so a mistake upstream cannot leak a credential into the UI.
 *
 * A line written while a tool call is running inherits that call's agent, which is what
 * makes the per-agent Activity filter mean anything. Lines written outside a call —
 * startup, the tunnel, the servers — stay unattributed, because they genuinely are.
 */

import type { LogEntry } from '../shared/types.js';
import { currentAgent } from './mcp/call-context.js';

const MAX_ENTRIES = 500;

const entries: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

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
