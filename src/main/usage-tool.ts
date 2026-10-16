import type { ModelUsage } from '../shared/usage.js';
import type { ProviderUsage } from '../shared/provider-usage.js';

/**
 * The Core `usage` tool's answer (#482): what each provider reported, with its source and age,
 * kept apart from tokens counted from logs on this computer. Anything missing says so.
 */
const ago = (time: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  return minutes < 1 ? 'just now' : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};
const iso = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
const tokens = (value: number) => Math.round(value).toLocaleString('en-US');
const windowName = (seconds: number | null) => seconds === 604800 ? 'weekly' : seconds ? `${Math.round(seconds / 3600)}-hour` : '';

export function usageReport(chatgpt: ModelUsage[], other: ProviderUsage, now: number): { text: string; structured: Record<string, unknown> } {
  const lines: string[] = [];
  const left = (row: ModelUsage) => row.resetAt !== null && row.resetAt <= now ? 'reset since this reading'
    : row.remaining !== null ? `${tokens(row.remaining)} remaining` : row.remainingPercent !== null ? `${Math.round(row.remainingPercent)}% remaining` : 'not reported';
  const resets = (row: ModelUsage) => row.resetAt && row.resetAt > now ? `, resets ${iso(row.resetAt)}` : '';
  // ChatGPT's page also reports Codex's windows (wham/usage); they never limit chat messages.
  const codex = chatgpt.filter(row => row.scope === 'codex');
  chatgpt = chatgpt.filter(row => row.scope !== 'codex');
  if (!chatgpt.length) lines.push('ChatGPT limits: not reported yet (they are read when the ChatGPT page shows them).');
  else {
    lines.push(`ChatGPT (reported by ChatGPT, ${ago(Math.max(...chatgpt.map(row => row.observedAt)), now)}):`);
    for (const row of chatgpt) {
      const name = row.model;
      lines.push(`- ${name}: ${left(row)}${resets(row)}`);
    }
  }
  if (codex.length) {
    lines.push(`Codex (reported by ChatGPT, ${ago(Math.max(...codex.map(row => row.observedAt)), now)}; Codex usage, not ChatGPT chat messages):`);
    for (const row of codex) {
      const window = row.windowSeconds === 604800 ? 'weekly limit' : row.windowSeconds ? `${windowName(row.windowSeconds)} limit` : 'limit';
      lines.push(`- ${row.model === 'Codex' ? '' : `${row.model} `}${window}: ${left(row)}${resets(row)}`);
    }
  }
  if (!other.enabled) lines.push('Other apps: reading Codex and Claude Code usage is switched off in Settings › Usage.');
  else {
    if (!other.codex) lines.push('Codex: no logs on this computer.');
    else {
      for (const limit of other.codex.limits) {
        lines.push(`Codex (reported by Codex, ${ago(limit.observedAt, now)}${limit.plan ? `, plan ${limit.plan}` : ''}${limit.id !== 'codex' ? `, pool ${limit.id}` : ''}):`);
        for (const window of limit.windows) {
          const name = window.windowMinutes === 10080 ? 'weekly limit' : `${Math.round(window.windowMinutes / 60)}-hour limit`;
          const reset = window.resetsAt !== null && window.resetsAt <= now;
          lines.push(`- ${name}: ${reset ? 'reset since this reading' : `${Math.round(Math.max(0, 100 - window.usedPercent))}% remaining${window.resetsAt ? `, resets ${iso(window.resetsAt)}` : ''}`}`);
        }
        if (limit.reached) lines.push(`- limit reached: ${limit.reached.replace(/_/g, ' ')}`);
      }
      const days = other.codex.days;
      const today = days.at(-1);
      lines.push(`Codex tokens counted on this computer: ${tokens(today ? today.input + today.output : 0)} today, ${tokens(days.reduce((sum, day) => sum + day.input + day.output, 0))} in 7 days.`);
    }
    if (!other.claude) lines.push('Claude Code: no logs on this computer.');
    else {
      const total = (day: NonNullable<ProviderUsage['claude']>['days'][number]) =>
        day.models.reduce((sum, model) => sum + model.input + model.cacheWrite + model.cacheRead + model.output, 0);
      const days = other.claude.days;
      const today = days.at(-1);
      lines.push(`Claude Code tokens counted on this computer: ${tokens(today ? total(today) : 0)} today, ${tokens(days.reduce((sum, day) => sum + total(day), 0))} in 7 days.`);
      lines.push('Claude Code plan limits: not reported (Claude Code shows them in its own /usage).');
    }
  }
  return {
    text: lines.join('\n'),
    structured: { readAt: now, chatgpt: { source: 'reported by ChatGPT', limits: chatgpt, codex },
      otherApps: other.enabled ? 'on' : 'off', codex: other.codex, claude: other.claude }
  };
}
