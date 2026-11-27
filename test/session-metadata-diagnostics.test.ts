import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { getLog } from '../src/main/logger.js';
import {
  appendEvent, createSession, flushSessions, getSession, initSessionStore,
  resetSessionStoreForTests, sessionsRoot
} from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('cos-metadata-diagnostics-');
  initConfigPath(dir);
  initSessionStore(dir);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

async function recordedSession() {
  const session = await createSession({ title: 'Metadata diagnostics fixture' });
  await appendEvent(session.id, {
    time: 100, source: 'extension', kind: 'turn_start', turnId: 'fixture-turn'
  });
  await flushSessions();
  const file = path.join(sessionsRoot(), session.id, 'meta.json');
  const checkpoint = JSON.parse(await fs.readFile(file, 'utf8'));
  resetSessionStoreForTests();
  return { id: session.id, file, checkpoint };
}

describe('metadata migration diagnostics', () => {
  it.each(['indexes', 'legacy watermark', 'token estimate'])('migrates %s without a corruption warning and reuses the saved projection after restart', async (kind) => {
    const { id, file, checkpoint } = await recordedSession();
    if (kind === 'indexes') {
      delete checkpoint.timelineTurns;
      delete checkpoint.requestTurns;
      delete checkpoint.nativeQuestion;
    } else if (kind === 'legacy watermark') delete checkpoint.__historySeq;
    else delete checkpoint.__tokenEstimate;
    await fs.writeFile(file, JSON.stringify(checkpoint));

    expect((await getSession(id))?.timelineTurns?.['fixture-turn']).toMatchObject({ time: 100 });
    const logs = () => getLog().filter(entry => entry.message.includes(`session ${id}:`));
    expect(logs()).toEqual([expect.objectContaining({ level: 'info', message: expect.stringContaining('normal version migration') })]);
    const saved = await fs.readFile(file, 'utf8');
    resetSessionStoreForTests();
    await getSession(id);
    expect(await fs.readFile(file, 'utf8')).toBe(saved);
    expect(logs()).toHaveLength(1);
  });

  it('keeps a stale-checkpoint recovery warning even when new indexes are missing', async () => {
    const { id, file, checkpoint } = await recordedSession();
    checkpoint.__historySeq = 0;
    delete checkpoint.timelineTurns;
    await fs.writeFile(file, JSON.stringify(checkpoint));
    expect((await getSession(id))?.timelineTurns?.['fixture-turn']).toMatchObject({ time: 100 });
    expect(getLog().filter(entry => entry.message.includes(`session ${id}:`))).toEqual([
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('history checkpoint out of date') })
    ]);
  });

  it('does not report a completed migration or recovery when publishing the checkpoint fails', async () => {
    const { id, file, checkpoint } = await recordedSession();
    delete checkpoint.timelineTurns;
    await fs.writeFile(file, JSON.stringify(checkpoint));
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === file) throw Object.assign(new Error('fixture write refused'), { code: 'EACCES' });
      return rename(from, to);
    });
    await expect(getSession(id)).rejects.toThrow('fixture write refused');
    expect(getLog().filter(entry => entry.message.includes(`session ${id}:`))).toEqual([]);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).timelineTurns).toBeUndefined();
  });
});

describe('rebuilding a long session\'s metadata', () => {
  it('loses no event when a line straddles the 64 KiB read block', async () => {
    const conversationId = '11111111-2222-4333-8444-555555555555';
    const session = await createSession({ title: 'Straddle', conversationId });
    await appendEvent(session.id, { time: 100, source: 'extension', kind: 'turn_start', turnId: 'straddle-turn' });
    for (let i = 0; i < 400; i++) {
      await appendEvent(session.id, { time: 200 + i, source: 'mcp', kind: 'tool_call', turnId: 'straddle-turn', call: {
        callId: `call-${i}`, requestId: `request-${i}`, tool: 'read', attribution: 'request_id', attributionMethod: 'request_id', conversationId,
        args: { text: '{}', chars: 2, truncated: false }, result: { text: 'ok', chars: 2, truncated: false }, durationMs: 1, outcome: 'ok',
        summary: { title: 'Read', tone: 'neutral', kind: 'read' }
      } } as never);
    }
    await flushSessions();
    const file = path.join(sessionsRoot(), session.id, 'meta.json');
    const checkpoint = JSON.parse(await fs.readFile(file, 'utf8'));
    const toolCalls = checkpoint.toolCalls;
    resetSessionStoreForTests();
    checkpoint.__historySeq = 0;
    delete checkpoint.requestTurns;
    await fs.writeFile(file, JSON.stringify(checkpoint));
    const rebuilt = await getSession(session.id);
    // The journal is larger than one read block, so a line ends up split between two reads.
    expect((await fs.stat(path.join(sessionsRoot(), session.id, 'events.jsonl'))).size).toBeGreaterThan(64 * 1024);
    const have = new Set(Object.keys(rebuilt?.requestTurns ?? {}));
    expect(Array.from({ length: 400 }, (_, i) => `request-${i}`).filter(id => !have.has(id))).toEqual([]);
    expect(rebuilt?.toolCalls).toBe(toolCalls);
  });
  it('replays thousands of attributed calls in linear time (a 83 MB journal took 94 s)', async () => {
    const conversationId = '11111111-2222-4333-8444-555555555555';
    const session = await createSession({ title: 'Long session', conversationId });
    await appendEvent(session.id, { time: 100, source: 'extension', kind: 'turn_start', turnId: 'long-turn' });
    for (let i = 0; i < 6000; i++) {
      await appendEvent(session.id, { time: 200 + i, source: 'mcp', kind: 'tool_call', turnId: 'long-turn', call: {
        callId: `call-${i}`, requestId: `request-${i}`, tool: 'read', attribution: 'request_id', attributionMethod: 'request_id', conversationId,
        args: { text: '{}', chars: 2, truncated: false }, result: { text: 'ok', chars: 2, truncated: false }, durationMs: 1, outcome: 'ok',
        summary: { title: 'Read', tone: 'neutral', kind: 'read' }
      } } as never);
    }
    await flushSessions();
    const file = path.join(sessionsRoot(), session.id, 'meta.json');
    const checkpoint = JSON.parse(await fs.readFile(file, 'utf8'));
    resetSessionStoreForTests();
    // A checkpoint that lags the journal (a crash, or a migration) makes the next open replay every event.
    checkpoint.__historySeq = 0;
    delete checkpoint.requestTurns;
    await fs.writeFile(file, JSON.stringify(checkpoint));
    const started = Date.now();
    const rebuilt = await getSession(session.id);
    expect(Date.now() - started).toBeLessThan(3000);
    const have = new Set(Object.keys(rebuilt?.requestTurns ?? {}));
    expect(Array.from({ length: 6000 }, (_, i) => `request-${i}`).filter(id => !have.has(id))).toEqual([]);
    expect(rebuilt?.requestTurns?.['request-5999']).toMatchObject({ turnId: 'long-turn', conversationId });
  }, 120_000);
});
