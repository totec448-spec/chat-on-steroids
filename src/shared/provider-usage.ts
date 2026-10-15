/**
 * Usage of other AI apps on this computer, read from their own local logs (roadmap #482).
 *
 * Only numbers, never content. Two kinds, never mixed: limits an app's provider reported
 * (Codex writes the server's rate-limit windows into its session logs), and tokens counted from
 * the logs on this computer (a measurement of this computer's work, not a quota). Claude Code
 * keeps no plan limits on disk, so its limits read as not reported.
 */
import { usageDateKey } from './usage.js';

export interface CodexLimitWindow {
  windowMinutes: number;
  usedPercent: number;
  /** When this window resets, as Codex reported it; after that, the reading is no longer current. */
  resetsAt: number | null;
}

export interface CodexLimit {
  /** Codex's own pool id (`codex`, or another pool such as a workspace's credits). */
  id: string;
  plan: string | null;
  /** Why Codex stopped, when it reported a reached limit. */
  reached: string | null;
  observedAt: number;
  windows: CodexLimitWindow[];
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | number | null } | null;
}

export interface CodexDayTokens { input: number; cachedInput: number; output: number }
export interface ClaudeTokens { input: number; cacheWrite: number; cacheRead: number; output: number }

export interface ProviderUsage {
  /** Off in Settings: nothing is read. */
  enabled: boolean;
  readAt: number;
  /** Null when Codex has no session logs on this computer. */
  codex: null | {
    limits: CodexLimit[];
    days: Array<{ date: string } & CodexDayTokens>;
  };
  /** Null when Claude Code has no transcripts on this computer. */
  claude: null | {
    days: Array<{ date: string; models: Array<{ model: string } & ClaudeTokens> }>;
  };
}

/** Days of token counts kept, today included. */
export const PROVIDER_USAGE_DAYS = 7;

const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function parse(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) return null;
  try { return record(JSON.parse(line)); } catch { return null; }
}

function codexWindow(value: unknown): CodexLimitWindow | null {
  const window = record(value);
  if (!window || typeof window['used_percent'] !== 'number' || typeof window['window_minutes'] !== 'number') return null;
  const resets = window['resets_at'];
  return {
    windowMinutes: number(window['window_minutes']),
    usedPercent: Math.min(100, number(window['used_percent'])),
    resetsAt: typeof resets === 'number' && resets > 0 ? resets * 1000 : null
  };
}

/** One Codex `token_count` event: its running token total and, when present, the limits it reported. */
export function codexLineReading(line: string): { at: number; total: CodexDayTokens | null; limit: CodexLimit | null } | null {
  const event = parse(line);
  const payload = record(event?.['payload']);
  if (!event || event['type'] !== 'event_msg' || payload?.['type'] !== 'token_count') return null;
  const at = Date.parse(String(event['timestamp'] ?? ''));
  if (!Number.isFinite(at)) return null;
  const usage = record(record(payload['info'])?.['total_token_usage']);
  const total = usage ? { input: number(usage['input_tokens']), cachedInput: number(usage['cached_input_tokens']), output: number(usage['output_tokens']) } : null;
  const limits = record(payload['rate_limits']);
  const id = text(limits?.['limit_id']);
  let limit: CodexLimit | null = null;
  if (limits && id) {
    const credits = record(limits['credits']);
    const balance = credits?.['balance'];
    limit = {
      id, plan: text(limits['plan_type']), reached: text(limits['rate_limit_reached_type']), observedAt: at,
      windows: [codexWindow(limits['primary']), codexWindow(limits['secondary'])].filter((window): window is CodexLimitWindow => window !== null),
      credits: credits ? {
        hasCredits: credits['has_credits'] === true, unlimited: credits['unlimited'] === true,
        balance: typeof balance === 'number' || typeof balance === 'string' ? balance : null
      } : null
    };
  }
  return { at, total, limit };
}

/** What one Codex session file adds up to, kept between reads so a growing file is read only from where it ended. */
export interface CodexFileState {
  last: CodexDayTokens | null;
  days: Map<string, CodexDayTokens>;
  limits: Map<string, CodexLimit>;
}
export const newCodexFileState = (): CodexFileState => ({ last: null, days: new Map(), limits: new Map() });

export function foldCodexLine(state: CodexFileState, line: string): void {
  const reading = codexLineReading(line);
  if (!reading) return;
  if (reading.limit) {
    const known = state.limits.get(reading.limit.id);
    if (!known || known.observedAt <= reading.limit.observedAt) state.limits.set(reading.limit.id, reading.limit);
  }
  if (!reading.total) return;
  // The total only grows within a session; a repeated reading adds nothing, a smaller one restarts.
  const previous = state.last ?? { input: 0, cachedInput: 0, output: 0 };
  const grew = (key: keyof CodexDayTokens) => reading.total![key] >= previous[key] ? reading.total![key] - previous[key] : reading.total![key];
  const delta = { input: grew('input'), cachedInput: grew('cachedInput'), output: grew('output') };
  state.last = reading.total;
  if (!delta.input && !delta.cachedInput && !delta.output) return;
  const key = usageDateKey(new Date(reading.at));
  const day = state.days.get(key) ?? { input: 0, cachedInput: 0, output: 0 };
  state.days.set(key, { input: day.input + delta.input, cachedInput: day.cachedInput + delta.cachedInput, output: day.output + delta.output });
}

/** One Claude Code assistant message's usage. */
export function claudeLineReading(line: string): { id: string; model: string; at: number; tokens: ClaudeTokens } | null {
  const event = parse(line);
  if (!event || event['type'] !== 'assistant') return null;
  const message = record(event['message']);
  const usage = record(message?.['usage']);
  const id = text(message?.['id']);
  const at = Date.parse(String(event['timestamp'] ?? ''));
  if (!message || !usage || !id || !Number.isFinite(at)) return null;
  return {
    id, model: text(message['model']) ?? 'unknown', at,
    tokens: {
      input: number(usage['input_tokens']), cacheWrite: number(usage['cache_creation_input_tokens']),
      cacheRead: number(usage['cache_read_input_tokens']), output: number(usage['output_tokens'])
    }
  };
}

export interface ClaudeFileState {
  /**
   * Each message once, by id: Claude Code writes a message once per content block, each line with
   * the same usage, and a resumed session can carry earlier messages into a new file.
   */
  messages: Map<string, { day: string; model: string; tokens: ClaudeTokens }>;
}
export const newClaudeFileState = (): ClaudeFileState => ({ messages: new Map() });

export function foldClaudeLine(state: ClaudeFileState, line: string): void {
  const reading = claudeLineReading(line);
  if (!reading || state.messages.has(reading.id)) return;
  // Claude Code's own notices (model `<synthetic>`) use no tokens and are no model's work.
  const { input, cacheWrite, cacheRead, output } = reading.tokens;
  if (!input && !cacheWrite && !cacheRead && !output) return;
  state.messages.set(reading.id, { day: usageDateKey(new Date(reading.at)), model: reading.model, tokens: reading.tokens });
}

/** Tokens per day and model across files, each message counted once. */
export function claudeDayTotals(states: Iterable<ClaudeFileState>): Map<string, Map<string, ClaudeTokens>> {
  const seen = new Set<string>();
  const days = new Map<string, Map<string, ClaudeTokens>>();
  for (const state of states) for (const [id, message] of state.messages) {
    if (seen.has(id)) continue;
    seen.add(id);
    const day = days.get(message.day) ?? new Map<string, ClaudeTokens>();
    const known = day.get(message.model) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    day.set(message.model, {
      input: known.input + message.tokens.input, cacheWrite: known.cacheWrite + message.tokens.cacheWrite,
      cacheRead: known.cacheRead + message.tokens.cacheRead, output: known.output + message.tokens.output
    });
    days.set(message.day, day);
  }
  return days;
}
