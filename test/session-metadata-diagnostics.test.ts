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
