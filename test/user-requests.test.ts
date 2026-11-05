import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  answerUserRequest, createSession, fileUserRequest, flushSessions, initSessionStore, readSessionUserRequests,
  resetSessionStoreForTests, sessionsRoot, setSessionOrigin
} from '../src/main/session/store.js';
import { prepareHandoff } from '../src/main/session/handoff.js';
import { goalUserRequestsContext } from '../src/main/goal-user-requests.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { USER_REQUEST_LIMITS } from '../src/shared/user-requests.js';
import { getLog } from '../src/main/logger.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// Steps handed to the person (#1695): kept per session beside its plan, answered only by the person.
let dir: string;
beforeAll(async () => { dir = await makeTempDir('clf-user-requests-'); initDurableStore(dir); initSessionStore(dir); });
afterAll(async () => { await flushSessions(); await flushDurable(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(dir); });

const step = (command: string, conversationId: string) => ({
  command, folder: '/work/app', remote: false, purpose: `Run ${command} with the hardware key`, expected: [{ path: 'out.bin', real: '/work/app/out.bin' }], conversationId
});

it('keeps a step across a restart, answers it once, and makes room by dropping the oldest answered steps', async () => {
  const session = await createSession({ conversationId: 'steps-keep' });
  const first = await fileUserRequest(session.id, step('flash', 'steps-keep'), 100);
  if (!('request' in first)) throw new Error('refused');
  expect(first.existing).toBe(false);
  await flushSessions(); resetSessionStoreForTests(); initSessionStore(dir);
  expect((await readSessionUserRequests(session.id))[0]).toMatchObject({ id: first.request.id, state: 'open', createdAt: 100 });
  expect(await answerUserRequest(session.id, 'ur_000000000000', 'done')).toBeNull();
  expect(await answerUserRequest(session.id, first.request.id, 'skipped', 200)).toMatchObject({ changed: true, request: { state: 'skipped', answeredAt: 200 } });
  expect(await answerUserRequest(session.id, first.request.id, 'done', 300)).toMatchObject({ changed: false, request: { state: 'skipped' } });
  // A skipped step asked again is a new step: the person may want to run it after all.
  const again = await fileUserRequest(session.id, step('flash', 'steps-keep'), 400);
  expect('request' in again && again.request.id).not.toBe(first.request.id);

  for (let index = 0; index < USER_REQUEST_LIMITS.kept + 5; index++) {
    const filed = await fileUserRequest(session.id, step(`run ${index}`, 'steps-keep'), 500 + index);
    if ('request' in filed) await answerUserRequest(session.id, filed.request.id, 'done', 600 + index);
  }
  const kept = await readSessionUserRequests(session.id);
  expect(kept).toHaveLength(USER_REQUEST_LIMITS.kept);
  expect(kept.some(request => request.command === 'run 0')).toBe(false);
  expect(kept.at(-1)!.command).toBe(`run ${USER_REQUEST_LIMITS.kept + 4}`);
});

it('returns the same open step for the same command and folder, and refuses past the open limit', async () => {
  const session = await createSession({ conversationId: 'steps-limit' });
  const one = await fileUserRequest(session.id, step('a', 'steps-limit'));
  const same = await fileUserRequest(session.id, { ...step(' a ', 'steps-limit'), purpose: 'other words' });
  expect('request' in one && 'request' in same && same.existing && same.request.id === one.request.id).toBe(true);
  const elsewhere = await fileUserRequest(session.id, { ...step('a', 'steps-limit'), folder: '/work/other' });
  expect('request' in elsewhere && elsewhere.existing).toBe(false);
  for (let index = 2; index < USER_REQUEST_LIMITS.open; index++) await fileUserRequest(session.id, step(`b${index}`, 'steps-limit'));
  expect(await fileUserRequest(session.id, step('one too many', 'steps-limit'))).toEqual({ refused: 'open-limit' });
  expect((await readSessionUserRequests(session.id)).filter(request => request.state === 'open')).toHaveLength(USER_REQUEST_LIMITS.open);
});

it('keeps an unreadable steps file aside instead of overwriting it', async () => {
  const session = await createSession({ conversationId: 'steps-damaged' });
  const folder = path.join(sessionsRoot(), session.id);
  await fs.writeFile(path.join(folder, 'requests.json'), '{"version":1,"requests":[{"id":', 'utf8');
  // A reader outside the session queue only reads: it must not move a file a queued write may
  // just have replaced (CodeRabbit on #2049).
  expect(await readSessionUserRequests(session.id)).toEqual([]);
  // The screen reads it every few hundred ms while a chat works: said once, not on every read.
  expect(await readSessionUserRequests(session.id)).toEqual([]);
  const warned = () => getLog().filter(entry => entry.message.includes(`session ${session.id}: steps for the person are unreadable`)).length;
  expect(warned()).toBe(1);
  expect((await fs.readdir(folder)).filter(name => name.startsWith('requests.json.unreadable-'))).toHaveLength(0);
  expect(await fs.readFile(path.join(folder, 'requests.json'), 'utf8')).toBe('{"version":1,"requests":[{"id":');
  // The queued write keeps it aside before it writes anything new.
  const fresh = await fileUserRequest(session.id, step('fresh', 'steps-damaged'));
  expect('request' in fresh).toBe(true);
  const aside = (await fs.readdir(folder)).filter(name => name.startsWith('requests.json.unreadable-'));
  expect(aside).toHaveLength(1);
  expect(await fs.readFile(path.join(folder, aside[0]!), 'utf8')).toBe('{"version":1,"requests":[{"id":');
  expect((await readSessionUserRequests(session.id)).map(row => row.command)).toEqual(['fresh']);
  // Damaged again later: said again, once.
  await fs.writeFile(path.join(folder, 'requests.json'), 'broken', 'utf8');
  expect(await readSessionUserRequests(session.id)).toEqual([]);
  expect(await readSessionUserRequests(session.id)).toEqual([]);
  expect(warned()).toBe(2);
});

it('reads a full steps file of the largest allowed steps', async () => {
  const session = await createSession({ conversationId: 'steps-large' });
  const big = (index: number) => ({
    // A control character takes six bytes in JSON (\u0001), so a full file is several MB (CodeRabbit on #2049).
    command: `${index} ${'\u0001'.repeat(USER_REQUEST_LIMITS.commandBytes - 8)}`,
    folder: '/work/app', remote: false, purpose: 'p'.repeat(USER_REQUEST_LIMITS.purpose),
    expected: Array.from({ length: USER_REQUEST_LIMITS.expected }, (_, file) => ({ path: `${'d/'.repeat(240)}${file}`, real: `/work/app/${'d/'.repeat(240)}${file}` })),
    constraints: 'c'.repeat(USER_REQUEST_LIMITS.constraints), conversationId: 'steps-large'
  });
  for (let index = 0; index < USER_REQUEST_LIMITS.kept; index++) {
    const filed = await fileUserRequest(session.id, big(index));
    if (!('request' in filed)) throw new Error('refused');
    if (index < USER_REQUEST_LIMITS.kept - USER_REQUEST_LIMITS.open) await answerUserRequest(session.id, filed.request.id, 'done');
  }
  const stat = await fs.stat(path.join(sessionsRoot(), session.id, 'requests.json'));
  expect(stat.size).toBeGreaterThan(2 * 1024 * 1024);
  const read = await readSessionUserRequests(session.id);
  expect(read).toHaveLength(USER_REQUEST_LIMITS.kept);
  expect(read.filter(row => row.state === 'open')).toHaveLength(USER_REQUEST_LIMITS.open);
  // Still read, so the open limit holds instead of a set-aside file starting empty.
  expect(await fileUserRequest(session.id, step('one more', 'steps-large'))).toEqual({ refused: 'open-limit' });
});

it('writes nothing over a damaged steps file it could not keep aside', async () => {
  const session = await createSession({ conversationId: 'steps-locked' });
  const target = path.join(sessionsRoot(), session.id, 'requests.json');
  await fs.writeFile(target, 'not json', 'utf8');
  const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).includes('.unreadable-')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    throw new Error(`unexpected rename ${String(from)}`);
  });
  try {
    await expect(fileUserRequest(session.id, step('blocked', 'steps-locked'))).rejects.toThrow(/could not be kept aside/);
  } finally { rename.mockRestore(); }
  expect(await fs.readFile(target, 'utf8')).toBe('not json');
});

it('tells the next chat after Compact & Resume, and Goal or Loop, which steps still wait for the person', async () => {
  const session = await createSession({ conversationId: 'steps-handoff' });
  const text = 'Continue the existing work and preserve the verified results. '.repeat(6);
  expect((await prepareHandoff({ sessionId: session.id, text })).text).toBe(text.trim());
  expect(await goalUserRequestsContext(session.id)).toEqual([]);
  const filed = await fileUserRequest(session.id, step('flash', 'steps-handoff'));
  if (!('request' in filed)) throw new Error('refused');
  const brief = (await prepareHandoff({ sessionId: session.id, text })).text;
  expect(brief).toContain('Steps still waiting for the person');
  expect(brief).toContain(filed.request.id);
  expect(brief).toContain('Command: flash');
  expect(brief).toContain('user_request_status');
  const [context] = await goalUserRequestsContext(session.id);
  expect(context).toContain('Run flash with the hardware key');
  expect(context).toContain('do not ask the chat to run them itself');
  await answerUserRequest(session.id, filed.request.id, 'done');
  expect((await prepareHandoff({ sessionId: session.id, text })).text).toBe(text.trim());
  expect(await goalUserRequestsContext(session.id)).toEqual([]);
});

it("lists a sub-agent's open steps in its main chat, labelled, and only open ones", async () => {
  const { userRequestViews } = await import('../src/main/bridge.js');
  const main = await createSession({ conversationId: 'steps-main' });
  const worker = await createSession({ conversationId: 'steps-worker' });
  const grandchild = await createSession({ conversationId: 'steps-grandchild' });
  const unrelated = await createSession({ conversationId: 'steps-unrelated' });
  await setSessionOrigin(worker.id, { kind: 'worker', fromSessionId: main.id, agentId: 'worker-1', task: 'Build' }, 'Build the firmware');
  await setSessionOrigin(grandchild.id, { kind: 'worker', fromSessionId: worker.id, agentId: 'worker-2', task: 'Flash' }, 'Flash it');
  const workerStep = await fileUserRequest(worker.id, step('flash', 'steps-worker'));
  const answered = await fileUserRequest(worker.id, step('done already', 'steps-worker'));
  if (!('request' in workerStep) || !('request' in answered)) throw new Error('refused');
  await answerUserRequest(worker.id, answered.request.id, 'done');
  await fileUserRequest(grandchild.id, step('deeper', 'steps-grandchild'));
  await fileUserRequest(unrelated.id, step('not mine', 'steps-unrelated'));
  const views = await userRequestViews(main.id);
  expect(views.map(view => [view.command, view.from?.sessionId, view.from?.title])).toEqual([
    ['flash', worker.id, 'Build the firmware'], ['deeper', grandchild.id, 'Flash it']
  ]);
  // The worker's own list holds its steps without a "from".
  expect((await userRequestViews(worker.id)).filter(view => !view.from).map(view => view.command)).toEqual(['flash', 'done already']);
});
