import { describe, expect, it } from 'vitest';
import { codexLineReading, claudeLineReading, newCodexFileState, newClaudeFileState, foldCodexLine, foldClaudeLine, claudeDayTotals } from '../src/shared/provider-usage.js';

const codexLine = (timestamp: string, total: { input: number; cached: number; output: number }, rateLimits: unknown = null) => JSON.stringify({
  timestamp, type: 'event_msg', payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: total.input, cached_input_tokens: total.cached, output_tokens: total.output, total_tokens: total.input + total.output } },
    rate_limits: rateLimits
  }
});
const limits = (used5h: number, usedWeek: number, extra: Record<string, unknown> = {}) => ({
  limit_id: 'codex', limit_name: null,
  primary: { used_percent: used5h, window_minutes: 300, resets_at: 1_792_019_257 },
  secondary: { used_percent: usedWeek, window_minutes: 10080, resets_at: 1_792_489_902 },
  credits: { has_credits: false, unlimited: false, balance: null }, plan_type: 'plus', rate_limit_reached_type: null, ...extra
});

describe('Codex session lines', () => {
  it('reads the limits Codex reports and when it reported them', () => {
    const reading = codexLineReading(codexLine('2026-10-14T18:37:35.041Z', { input: 10, cached: 5, output: 2 }, limits(17, 52)));
    expect(reading?.limit).toEqual({
      id: 'codex', plan: 'plus', reached: null, observedAt: Date.parse('2026-10-14T18:37:35.041Z'),
      windows: [
        { windowMinutes: 300, usedPercent: 17, resetsAt: 1_792_019_257_000 },
        { windowMinutes: 10080, usedPercent: 52, resetsAt: 1_792_489_902_000 }
      ],
      credits: { hasCredits: false, unlimited: false, balance: null }
    });
  });

  it('ignores other lines, broken JSON and a reading without limits', () => {
    expect(codexLineReading('{"type":"response_item","payload":{"type":"message"}}')).toBeNull();
    expect(codexLineReading('{not json')).toBeNull();
    expect(codexLineReading(codexLine('2026-10-14T18:37:35Z', { input: 1, cached: 0, output: 1 }))?.limit).toBeNull();
  });

  it('counts tokens per local day from the growth of the running total, so a repeated reading adds nothing', () => {
    const state = newCodexFileState();
    foldCodexLine(state, codexLine('2026-10-14T10:00:00Z', { input: 100, cached: 60, output: 10 }));
    foldCodexLine(state, codexLine('2026-10-14T10:00:01Z', { input: 100, cached: 60, output: 10 }));
    foldCodexLine(state, codexLine('2026-10-14T11:00:00Z', { input: 150, cached: 90, output: 30 }));
    const day = new Date(Date.parse('2026-10-14T10:00:00Z'));
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    expect(state.days.get(key)).toEqual({ input: 150, cachedInput: 90, output: 30 });
  });

  it('keeps the newest reported limit per limit id', () => {
    const state = newCodexFileState();
    foldCodexLine(state, codexLine('2026-10-14T10:00:00Z', { input: 1, cached: 0, output: 1 }, limits(10, 40)));
    foldCodexLine(state, codexLine('2026-10-14T09:00:00Z', { input: 2, cached: 0, output: 1 }, limits(5, 30)));
    foldCodexLine(state, codexLine('2026-10-14T11:00:00Z', { input: 3, cached: 0, output: 1 }, { limit_id: 'premium', primary: null, secondary: null,
      credits: { has_credits: false, unlimited: false, balance: null }, plan_type: null, rate_limit_reached_type: 'workspace_owner_credits_depleted' }));
    expect(state.limits.get('codex')?.windows[0]?.usedPercent).toBe(10);
    expect(state.limits.get('premium')).toMatchObject({ windows: [], reached: 'workspace_owner_credits_depleted' });
  });
});

const claudeLine = (id: string, timestamp: string, usage: Record<string, number>, model = 'claude-opus-5-5', type = 'assistant') =>
  JSON.stringify({ type, timestamp, requestId: 'req_' + id, message: { id, model, usage } });

describe('Claude Code transcript lines', () => {
  it('reads one assistant message’s usage', () => {
    expect(claudeLineReading(claudeLine('msg_1', '2026-10-14T11:06:23.269Z', { input_tokens: 2, cache_creation_input_tokens: 190, cache_read_input_tokens: 1000, output_tokens: 843 })))
      .toEqual({ id: 'msg_1', model: 'claude-opus-5-5', at: Date.parse('2026-10-14T11:06:23.269Z'),
        tokens: { input: 2, cacheWrite: 190, cacheRead: 1000, output: 843 } });
    expect(claudeLineReading(claudeLine('msg_2', '2026-10-14T11:06:23Z', { input_tokens: 1, output_tokens: 1 }, 'x', 'user'))).toBeNull();
    expect(claudeLineReading('{"type":"assistant","message":{"id":"m"}}')).toBeNull();
  });

  it('counts a message written once per content block only once, under its model and day', () => {
    const state = newClaudeFileState();
    const usage = { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 50 };
    foldClaudeLine(state, claudeLine('msg_1', '2026-10-14T11:00:00Z', usage));
    foldClaudeLine(state, claudeLine('msg_1', '2026-10-14T11:00:01Z', usage));
    foldClaudeLine(state, claudeLine('msg_2', '2026-10-14T12:00:00Z', { input_tokens: 1, output_tokens: 5 }, 'claude-sonnet-5-5'));
    const totals = [...claudeDayTotals([state]).values()].flatMap(day => [...day.entries()]);
    expect(Object.fromEntries(totals)).toEqual({
      'claude-opus-5-5': { input: 2, cacheWrite: 10, cacheRead: 100, output: 50 },
      'claude-sonnet-5-5': { input: 1, cacheWrite: 0, cacheRead: 0, output: 5 }
    });
  });

  it('counts a message carried into a resumed session’s new file only once', () => {
    const first = newClaudeFileState(), resumed = newClaudeFileState();
    const usage = { input_tokens: 3, output_tokens: 7 };
    foldClaudeLine(first, claudeLine('msg_1', '2026-10-14T11:00:00Z', usage));
    foldClaudeLine(resumed, claudeLine('msg_1', '2026-10-14T11:00:00Z', usage));
    foldClaudeLine(resumed, claudeLine('msg_2', '2026-10-14T11:30:00Z', usage));
    const totals = [...claudeDayTotals([first, resumed]).values()].flatMap(day => [...day.values()]);
    expect(totals).toEqual([{ input: 6, cacheWrite: 0, cacheRead: 0, output: 14 }]);
  });

  it('leaves out messages that used no tokens, such as Claude Code’s own synthetic notices', () => {
    const state = newClaudeFileState();
    foldClaudeLine(state, claudeLine('msg_s', '2026-10-14T11:00:00Z', { input_tokens: 0, output_tokens: 0 }, '<synthetic>'));
    expect(claudeDayTotals([state]).size).toBe(0);
  });
});
