import { describe, expect, it } from 'vitest';
import { usageReport } from '../src/main/usage-tool.js';
import type { ProviderUsage } from '../src/shared/provider-usage.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const off: ProviderUsage = { enabled: false, readAt: NOW, codex: null, claude: null };

describe('the Core usage tool’s answer', () => {
  it('names each source and age, and keeps reported limits apart from counted tokens', () => {
    const report = usageReport([
      { model: 'gpt-6-pro', scope: 'model', remaining: 12, remainingPercent: null, resetAt: NOW + 3_600_000, windowSeconds: 604800, observedAt: NOW - 120_000 },
      { model: 'shared', scope: 'shared', remaining: null, remainingPercent: 40, resetAt: null, windowSeconds: 18000, observedAt: NOW - 120_000 }
    ], {
      enabled: true, readAt: NOW,
      codex: { limits: [{ id: 'codex', plan: 'plus', reached: null, observedAt: NOW - 600_000, credits: null, windows: [
        { windowMinutes: 300, usedPercent: 30, resetsAt: NOW + 3_600_000 }, { windowMinutes: 10080, usedPercent: 65, resetsAt: NOW - 1 }] }],
      days: [{ date: '2026-10-13', input: 100, cachedInput: 50, output: 10 }, { date: '2026-10-14', input: 1000, cachedInput: 600, output: 50 }] },
      claude: { days: [{ date: '2026-10-14', models: [{ model: 'claude-opus-5-5', input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }] }] }
    }, NOW);
    expect(report.text).toContain('ChatGPT (reported by ChatGPT, 2 min ago)');
    expect(report.text).toContain('gpt-6-pro: 12 remaining');
    expect(report.text).toContain('5-hour shared limit: 40% remaining');
    expect(report.text).toContain('Codex (reported by Codex, 10 min ago, plan plus):');
    expect(report.text).toContain('5-hour limit: 70% remaining');
    expect(report.text).toContain('weekly limit: reset since this reading');
    expect(report.text).toContain('Codex tokens counted on this computer: 1,050 today, 1,160 in 7 days');
    expect(report.text).toContain('Claude Code tokens counted on this computer: 10 today, 10 in 7 days');
    expect(report.text).toContain('Claude Code plan limits: not reported');
    expect(report.structured).toMatchObject({ chatgpt: { limits: [expect.objectContaining({ model: 'gpt-6-pro' }), expect.anything()] },
      codex: { limits: [expect.objectContaining({ id: 'codex' })] }, claude: { days: [expect.anything()] } });
  });

  it('says what is not reported or switched off instead of guessing', () => {
    const report = usageReport([], off, NOW);
    expect(report.text).toContain('ChatGPT limits: not reported yet');
    expect(report.text).toContain('Other apps: reading Codex and Claude Code usage is switched off in Settings › Usage');
    expect(usageReport([], { enabled: true, readAt: NOW, codex: null, claude: null }, NOW).text)
      .toContain('Codex: no logs on this computer');
  });
});
