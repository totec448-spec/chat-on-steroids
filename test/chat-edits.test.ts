import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { addProject } from '../src/main/projects.js';
import { readChatEdits, reviewChatEditPath } from '../src/main/session/chat-edits.js';
import { appendEvent, bindSessionProject, createSession, flushSessions, initSessionStore, readToolEditReview, rebindSession,
  resetSessionStoreForTests, writeAsset } from '../src/main/session/store.js';
import type { SessionEvent, ToolCallRecord } from '../src/shared/session.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string, projectId: string, project: string, sessionId: string;
const conversationId = 'sample-chat';

beforeEach(async () => {
  dir = await makeTempDir('cos-chat-edits-');
  project = path.join(await fs.realpath(dir), 'sample');
  await fs.mkdir(project);
  initConfigPath(dir);
  initDurableStore(dir);
  initSessionStore(dir);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: await fs.realpath(dir) }] });
  projectId = (await addProject(project)).id;
  sessionId = (await createSession({ title: 'Sample', conversationId })).id;
  await bindSessionProject(sessionId, projectId);
});

afterEach(async () => {
  await flushSessions();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

async function record(name: string, options: Partial<ToolCallRecord> = {}, owner = sessionId) {
  const stored = { text: 'Edited imagined.txt', chars: 19, truncated: false };
  const asset = await writeAsset(owner, Buffer.from(JSON.stringify({ before: 'previous\n',
    after: options.summary?.kind === 'delete' ? '' : 'recorded\n' })), 'text/plain');
  const call: ToolCallRecord = {
    callId: randomUUID(), tool: 'apply_patch', outcome: 'ok', attribution: 'request_id', attributionMethod: 'request_id',
    conversationId, requestId: 'sample-request', durationMs: 1, summary: { kind: 'edit', title: 'Edited', tone: 'good' },
    args: stored, result: stored, changes: [{ path: `/work/sample/${name}`, added: 1, removed: 1, approximate: false, reviewAssetId: asset.id }],
    ...options
  };
  await appendEvent(owner, { kind: 'tool_call', time: Date.now(), source: 'mcp', call });
  return call;
}

const list = () => readChatEdits(sessionId, projectId);
const diff = (call: ToolCallRecord) => readToolEditReview(sessionId, call.callId, 0,
  async (event: Extract<SessionEvent, { kind: 'tool_call' }>, index) => (await reviewChatEditPath(sessionId, projectId, event, index)) !== null);

it('lists only successful edits recorded for this chat, using the latest record per project path', async () => {
  await fs.writeFile(path.join(project, 'file.txt'), 'unrelated live bytes');
  await record('file.txt');
  const latest = await record('file.txt');
  await record('guessed.txt', { tool: 'exec_command' });
  await record('failed.txt', { outcome: 'tool_execution_error' });
  await record('provisional.txt', { attribution: 'generation', attributionMethod: 'generation' });
  await record('wrong-chat.txt', { conversationId: 'other-chat' });
  await record('../other/file.txt');
  const other = await createSession({ title: 'Other', conversationId: 'other-chat' });
  await bindSessionProject(other.id, projectId);
  await record('other.txt', { conversationId: 'other-chat' }, other.id);
  expect(await list()).toMatchObject({ rows: [{ path: 'file.txt', callId: latest.callId, state: 'changed', reviewable: true }], limited: false });
  expect(await diff(latest)).toMatchObject({ currentText: 'recorded\n' });
});

it('keeps a deleted file as historical and opens its recorded diff', async () => {
  const call = await record('deleted.txt', { summary: { kind: 'delete', title: 'Deleted', tone: 'good' } });
  expect(await list()).toMatchObject({ rows: [{ path: 'deleted.txt', state: 'deleted', reviewable: true }] });
  expect(await diff(call)).toMatchObject({ baseText: 'previous\n', currentText: '' });
});

it('does not follow a rename or substitute the replacement’s contents', async () => {
  await fs.writeFile(path.join(project, 'old.txt'), 'live before rename');
  const call = await record('old.txt');
  await fs.rename(path.join(project, 'old.txt'), path.join(project, 'new.txt'));
  expect(await list()).toMatchObject({ rows: [{ path: 'old.txt', state: 'missing', reviewable: true }] });
  expect(await diff(call)).toMatchObject({ currentText: 'recorded\n' });
  await fs.writeFile(path.join(project, 'old.txt'), 'unrelated replacement');
  expect(await diff(call)).toMatchObject({ currentText: 'recorded\n' });
});

it('returns an empty list for a chat with no recorded edits', async () => {
  await fs.writeFile(path.join(project, 'untracked.txt'), 'not a recorded edit');
  expect(await list()).toEqual({ rows: [], limited: false });
});

it('checks the session project and revoked roots without changing the existing historical reader', async () => {
  const call = await record('file.txt');
  expect(await readChatEdits(sessionId, randomUUID())).toBeNull();
  await saveConfig({ ...defaultConfig(), roots: [] });
  expect(await list()).toBeNull();
  expect(await diff(call)).toBeNull();
  expect(await readToolEditReview(sessionId, call.callId, 0)).toMatchObject({ currentText: 'recorded\n' });
});

it('retains the exact local session history after a committed Compact & Resume', async () => {
  const call = await record('before-resume.txt');
  expect(await rebindSession(sessionId, conversationId, 'resumed-chat', 'sample-handoff')).toBe(true);
  await flushSessions();
  resetSessionStoreForTests();
  expect(await list()).toMatchObject({ rows: [{ path: 'before-resume.txt', callId: call.callId }] });
});

it('never resolves a recorded path through a symlink or junction', async () => {
  const call = await record('redirect/file.txt');
  const sibling = path.join(path.dirname(project), 'sibling');
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'file.txt'), 'other project');
  await fs.symlink(sibling, path.join(project, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(await list()).toMatchObject({ rows: [{ path: 'redirect/file.txt', state: 'unavailable', reviewable: false }] });
  expect(await diff(call)).toBeNull();
});
