import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { emptyEvidence } from '../src/main/mcp/call-context.js';
import { recordToolCall, resetRecorderForTests } from '../src/main/session/recorder.js';
import { createSession, flushSessions, initSessionStore, readEvents, resetSessionStoreForTests } from '../src/main/session/store.js';
import { summarizeToolCall } from '../src/main/session/summarize.js';
import { WINDOWS_COMPUTER_METHODS, WINDOWS_COMPUTER_READ_METHODS } from '../src/shared/windows-computer.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeAll(async () => {
  dir = await makeTempDir('windows-desktop-recording-');
  initConfigPath(dir); initSessionStore(dir);
  await saveConfig(defaultConfig());
});
afterAll(async () => {
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await removeTempDir(dir);
});

describe('Windows desktop recording', () => {
  it('summarizes every public method without echoing private input or overstating launch receipts', () => {
    const secret = 'private-input-fixture-do-not-record-in-summary';
    for (const tool of [...WINDOWS_COMPUTER_METHODS, 'read_clipboard', 'write_clipboard']) {
      const args = { text: secret, value: secret, key: secret, action: secret, app: secret, window: { id: 1, app: secret, title: secret } };
      const summary = summarizeToolCall({ tool, args, evidence: emptyEvidence(), outcome: 'ok', durationMs: 1 });
      const kind = tool.endsWith('_clipboard') ? 'clipboard' : WINDOWS_COMPUTER_READ_METHODS.some(name => name === tool) ? 'screen' : 'input';
      expect(summary.kind, tool).toBe(kind);
      expect(summary.title, tool).not.toBe(`Ran ${tool}`);
      expect(JSON.stringify(summary), tool).not.toContain(secret);
      const refused = summarizeToolCall({ tool, args, evidence: emptyEvidence(), outcome: 'tool_rejected', durationMs: 1 });
      expect(refused.title, tool).toMatch(/^Refused to /);
      expect(JSON.stringify(refused), tool).not.toContain(secret);
      if (tool === 'launch_app') expect(summary.title).toBe('Requested an app launch');
    }
  });

  it('redacts standalone clipboard writes and both textual/structured reads in real stored session events', async () => {
    const conversationId = 'windows-recording-privacy';
    const session = await createSession({ title: 'Windows recording fixture', conversationId });
    const secret = 'clipboard-fixture-confidential-value';
    const common = { conversationId, sessionId: session.id, durationMs: 1, startedAt: Date.now(), outcome: 'ok' as const };
    const write = await recordToolCall({ ...common, tool: 'write_clipboard', args: { text: secret }, content: [{ type: 'text', text: 'Clipboard updated.' }] });
    const read = await recordToolCall({ ...common, tool: 'read_clipboard', args: {}, content: [{ type: 'text', text: secret }], protocolResult: { structuredContent: { value: secret }, content: [{ type: 'text', text: secret }] } });
    const failedRead = await recordToolCall({ ...common, tool: 'read_clipboard', args: {}, outcome: 'tool_rejected', content: [{ type: 'text', text: secret }] });
    expect(write).not.toBeNull(); expect(read).not.toBeNull(); expect(failedRead).not.toBeNull();
    expect(JSON.stringify(write!.args)).toContain('characters not stored');
    expect(JSON.stringify(read!.result)).toContain('clipboard text not stored');
    expect(JSON.stringify(failedRead!.summary)).toContain('clipboard text not stored');
    await flushSessions();
    const events = await readEvents(session.id, { kinds: ['tool_call'] });
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain(secret);
    // Inspect persisted shards too: hiding a value in the readback projection is insufficient.
    const sessionDir = path.join(dir, 'sessions', session.id);
    for (const entry of await fs.readdir(sessionDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const bytes = await fs.readFile(path.join(entry.parentPath, entry.name));
      expect(bytes.includes(Buffer.from(secret)), entry.name).toBe(false);
    }
  });
});
