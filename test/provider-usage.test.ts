import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { readProviderUsage, resetProviderUsageForTests } from '../src/main/provider-usage.js';
import { usageDateKey } from '../src/shared/usage.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime();
const today = usageDateKey(new Date(NOW));
let dir: string;
let homes: { codex: string; claude: string };

const codexEvent = (at: number, total: number, used = 17) => JSON.stringify({
  timestamp: new Date(at).toISOString(), type: 'event_msg', payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: total, cached_input_tokens: total / 2, output_tokens: total / 10 } },
    rate_limits: { limit_id: 'codex', primary: { used_percent: used, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 3600 },
      secondary: { used_percent: 40, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) + 86_400 },
      credits: null, plan_type: 'plus', rate_limit_reached_type: null }
  }
}) + '\n';
const claudeEvent = (id: string, at: number, output: number) => JSON.stringify({
  type: 'assistant', timestamp: new Date(at).toISOString(),
  message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'never kept' }], usage: { input_tokens: 1, output_tokens: output } }
}) + '\n';

async function codexFile(name: string, lines: string, mtime = NOW): Promise<string> {
  const day = path.join(homes.codex, 'sessions', '2026', '10', '14');
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, name);
  await fs.writeFile(file, lines);
  await fs.utimes(file, mtime / 1000, mtime / 1000);
  return file;
}

beforeEach(async () => {
  dir = await makeTempDir('clf-provider-usage-');
  initConfigPath(dir);
  await saveConfig(defaultConfig());
  homes = { codex: path.join(dir, 'codex'), claude: path.join(dir, 'claude') };
  resetProviderUsageForTests();
});
afterEach(async () => { vi.restoreAllMocks(); await removeTempDir(dir); });

describe('usage of other apps on this computer', () => {
  it('reports nothing for apps that have no logs here', async () => {
    expect(await readProviderUsage({ now: NOW, homes })).toEqual({ enabled: true, readAt: NOW, codex: null, claude: null });
  });

  it('reads Codex’s reported limits and its tokens, and only the growth of a file on the next read', async () => {
    const file = await codexFile('rollout-a.jsonl', codexEvent(NOW - 3_600_000, 1000));
    let usage = await readProviderUsage({ now: NOW, homes });
    expect(usage.codex?.limits).toEqual([expect.objectContaining({ id: 'codex', plan: 'plus', observedAt: NOW - 3_600_000,
      windows: [expect.objectContaining({ windowMinutes: 300, usedPercent: 17 }), expect.objectContaining({ windowMinutes: 10080, usedPercent: 40 })] })]);
    expect(usage.codex?.days.find(day => day.date === today)).toEqual({ date: today, input: 1000, cachedInput: 500, output: 100 });
    expect(usage.codex?.days).toHaveLength(7);

    const opened = vi.spyOn(fs, 'open');
    await fs.appendFile(file, codexEvent(NOW - 60_000, 1500, 30));
    await fs.utimes(file, NOW / 1000, NOW / 1000);
    usage = await readProviderUsage({ now: NOW, homes });
    expect(usage.codex?.limits[0]?.windows[0]?.usedPercent).toBe(30);
    expect(usage.codex?.days.find(day => day.date === today)).toMatchObject({ input: 1500 });
    // Unchanged files are not opened again.
    opened.mockClear();
    await readProviderUsage({ now: NOW, homes });
    expect(opened).not.toHaveBeenCalled();
  });

  it('skips logs nobody wrote to this week', async () => {
    await codexFile('rollout-old.jsonl', codexEvent(NOW - 20 * 86_400_000, 999), NOW - 20 * 86_400_000);
    const usage = await readProviderUsage({ now: NOW, homes });
    expect(usage.codex).toEqual({ limits: [], days: expect.any(Array) });
    expect(usage.codex?.days.every(day => day.input === 0)).toBe(true);
  });

  it('counts Claude Code tokens per model and day, sub-agents included, each message once', async () => {
    const project = path.join(homes.claude, 'projects', '-work-app');
    await fs.mkdir(path.join(project, 'session-1', 'subagents'), { recursive: true });
    await fs.writeFile(path.join(project, 'session-1.jsonl'), claudeEvent('msg_1', NOW - 1000, 10) + claudeEvent('msg_1', NOW - 999, 10));
    await fs.writeFile(path.join(project, 'session-1', 'subagents', 'agent-1.jsonl'), claudeEvent('msg_2', NOW - 500, 5));
    const usage = await readProviderUsage({ now: NOW, homes });
    expect(usage.claude?.days.find(day => day.date === today)?.models).toEqual([
      { model: 'claude-opus-5-5', input: 2, cacheWrite: 0, cacheRead: 0, output: 15 }
    ]);
    expect(JSON.stringify(usage)).not.toContain('never kept');
  });

  it('reads nothing while switched off', async () => {
    await codexFile('rollout-a.jsonl', codexEvent(NOW - 1000, 10));
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, localAppUsage: false } });
    const opened = vi.spyOn(fs, 'readdir');
    expect(await readProviderUsage({ now: NOW, homes })).toEqual({ enabled: false, readAt: NOW, codex: null, claude: null });
    expect(opened).not.toHaveBeenCalled();
  });
});
