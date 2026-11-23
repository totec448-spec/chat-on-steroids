import { beforeEach, expect, it, vi } from 'vitest';

const durable = vi.hoisted(() => ({ value: null as unknown, writes: 0, reads: 0, slowSecondRead: false }));
vi.mock('../src/main/durable.js', () => ({
  readDurable: async () => {
    const value = structuredClone(durable.value);
    durable.reads++;
    if (durable.slowSecondRead && durable.reads === 2) await new Promise(resolve => setTimeout(resolve, 20));
    return value;
  },
  writeDurableSoon: (_name: string, value: unknown) => { durable.value = structuredClone(value); durable.writes++; },
  writeDurableNow: async (_name: string, value: unknown) => { durable.value = structuredClone(value); durable.writes++; }
}));

const groups = await import('../src/main/chat-groups.js');
const { chatGroupName, chatGroupOf } = await import('../src/shared/chat-groups.js');
const exists = (id: string) => id === 'project-a' || id === 'project-b';
const chat = (id: string, projectId: string | null = 'project-a', worker = false) => ({ id, projectId, origin: worker ? { kind: 'worker' } : null });

beforeEach(() => { durable.value = null; durable.writes = 0; durable.reads = 0; durable.slowSecondRead = false; groups.resetChatGroupsForTests(); });

it('names a group trimmed and folded, and refuses an empty or overlong name', async () => {
  expect(chatGroupName('  Spanish\n\t round  ')).toBe('Spanish round');
  expect(chatGroupName('   ')).toBeNull();
  expect(chatGroupName('x'.repeat(60))).toBe('x'.repeat(60));
  expect(chatGroupName('x'.repeat(61))).toBeNull();
  expect(chatGroupName('😀'.repeat(60))).toBe('😀'.repeat(60));
  await expect(groups.createChatGroup('project-a', '  ', exists)).rejects.toThrow('A group name needs 1 to 60 characters');
  await expect(groups.createChatGroup('gone', 'Spanish', exists)).rejects.toThrow('This project is not available');
});

it('creates, renames, assigns and deletes a group without touching its chats', async () => {
  const { group } = await groups.createChatGroup('project-a', 'Spanish', exists);
  let state = await groups.assignChatGroup(chat('s1'), group.id);
  expect(chatGroupOf(state, chat('s1'))?.name).toBe('Spanish');
  state = await groups.renameChatGroup(group.id, 'Español');
  expect(chatGroupOf(state, chat('s1'))?.name).toBe('Español');
  // Moving within the same project to another group, then out of any group.
  const { group: second } = await groups.createChatGroup('project-a', 'Italian', exists);
  state = await groups.assignChatGroup(chat('s1'), second.id);
  expect(chatGroupOf(state, chat('s1'))?.id).toBe(second.id);
  state = await groups.assignChatGroup(chat('s1'), null);
  expect(chatGroupOf(state, chat('s1'))).toBeNull();
  state = await groups.assignChatGroup(chat('s2'), group.id);
  state = await groups.deleteChatGroup(group.id);
  expect(state.groups.map(row => row.name)).toEqual(['Italian']);
  expect(state.members).toEqual({});
  // What was written is what comes back after a restart.
  groups.resetChatGroupsForTests();
  expect((await groups.chatGroupsState()).groups.map(row => row.name)).toEqual(['Italian']);
});

it('keeps a chat to its own project\'s groups, and sub-agent chats out of groups', async () => {
  const { group } = await groups.createChatGroup('project-a', 'Spanish', exists);
  await expect(groups.assignChatGroup(chat('s1', 'project-b'), group.id)).rejects.toThrow("This chat is not in that group's project");
  await expect(groups.assignChatGroup(chat('s1', null), group.id)).rejects.toThrow("This chat is not in that group's project");
  await expect(groups.assignChatGroup(chat('w1', 'project-a', true), group.id)).rejects.toThrow('A sub-agent chat follows its main chat');
  await expect(groups.assignChatGroup(null, group.id)).rejects.toThrow('This chat no longer exists');
  await expect(groups.assignChatGroup(chat('s1'), 'missing')).rejects.toThrow('This group no longer exists');
  // A chat that later leaves the project falls back to no group, without a write.
  const state = await groups.assignChatGroup(chat('s1'), group.id);
  expect(chatGroupOf(state, chat('s1', 'project-b'))).toBeNull();
  expect(chatGroupOf(state, chat('s1', 'project-a', true))).toBeNull();
});

it('caps the groups of one project, not of all projects', async () => {
  for (let at = 0; at < 100; at++) await groups.createChatGroup('project-a', `Group ${at}`, exists);
  await expect(groups.createChatGroup('project-a', 'One more', exists)).rejects.toThrow('A project can hold up to 100 groups');
  await expect(groups.createChatGroup('project-b', 'Elsewhere', exists)).resolves.toBeTruthy();
});

it('starts empty from a corrupt store and drops what it cannot trust', async () => {
  durable.value = 'not json state';
  expect(await groups.chatGroupsState()).toEqual({ version: 1, groups: [], members: {} });
  groups.resetChatGroupsForTests();
  durable.value = { version: 1, groups: [
    { id: 'g1', projectId: 'project-a', name: '  Kept  ', createdAt: 1 },
    { id: 'g1', projectId: 'project-a', name: 'Duplicate id', createdAt: 2 },
    { id: 'g2', projectId: 'project-a', name: '', createdAt: 3 },
    { id: 'g3', projectId: '', name: 'No project', createdAt: 4 }
  ], members: { s1: 'g1', s2: 'g2', s3: 42 } };
  expect(await groups.chatGroupsState()).toEqual({ version: 1, groups: [{ id: 'g1', projectId: 'project-a', name: 'Kept', createdAt: 1 }], members: { s1: 'g1' } });
});

it('forgets a deleted chat\'s membership and writes only when it had one', async () => {
  const { group } = await groups.createChatGroup('project-a', 'Spanish', exists);
  await groups.assignChatGroup(chat('s1'), group.id);
  const before = durable.writes;
  await groups.forgetChatGroupMember('never-grouped');
  expect(durable.writes).toBe(before);
  await groups.forgetChatGroupMember('s1');
  expect((await groups.chatGroupsState()).members).toEqual({});
  expect(durable.writes).toBe(before + 1);
});

// CodeRabbit on #1687: two group actions right after start both loaded the store; the slower load
// replaced the state the first action had already changed, and its new group was lost.
it('keeps both changes when two actions arrive before the store has loaded', async () => {
  durable.slowSecondRead = true;
  const [first, second] = await Promise.all([
    groups.createChatGroup('project-a', 'Spanish', exists),
    groups.createChatGroup('project-a', 'Italian', exists)
  ]);
  const state = await groups.chatGroupsState();
  expect(state.groups.map(group => group.id).sort()).toEqual([first.group.id, second.group.id].sort());
  expect(durable.reads).toBe(1);
});

it('places a moved chat in the group it was dropped on, or in none, and only in its new project (#1919)', async () => {
  const { group: a } = await groups.createChatGroup('project-a', 'A', exists);
  const { group: b } = await groups.createChatGroup('project-b', 'B', exists);
  await groups.assignChatGroup(chat('one'), a.id);
  expect((await groups.placeMovedChat('one', 'project-b', b.id)).members).toEqual({ one: b.id });
  await expect(groups.placeMovedChat('one', 'project-a', b.id)).rejects.toThrow("This chat is not in that group's project");
  await expect(groups.placeMovedChat('one', 'project-a', 'gone')).rejects.toThrow("This chat is not in that group's project");
  expect((await groups.placeMovedChat('one', 'project-a', null)).members).toEqual({});
  const writes = durable.writes;
  expect((await groups.placeMovedChat('one', null, null)).members).toEqual({});
  expect(durable.writes).toBe(writes);
});

it('keeps an explicit group choice for a moved chat, null included (#1965)', () => {
  expect(groups.movedChatGroup(null, 'g1', 'project-a', 'g0')).toBeNull();
  expect(groups.movedChatGroup('project-a', null, 'project-a', 'g0')).toBeNull();
  expect(groups.movedChatGroup('project-a', 'g1', 'project-a', 'g0')).toBe('g1');
  expect(groups.movedChatGroup('project-a', undefined, 'project-a', 'g0')).toBe('g0');
  expect(groups.movedChatGroup('project-b', undefined, 'project-a', 'g0')).toBeNull();
});

it('keeps group placement unchanged when the project write fails and releases the mutation queue', async () => {
  const { group: a } = await groups.createChatGroup('project-a', 'A', exists);
  const { group: b } = await groups.createChatGroup('project-b', 'B', exists);
  await groups.assignChatGroup(chat('one'), a.id);
  await expect(groups.moveChatGroup(chat('one'), 'project-b', b.id, async () => {
    throw new Error('project write failed');
  })).rejects.toThrow('project write failed');
  expect((await groups.chatGroupsState()).members.one).toBe(a.id);
  await expect(groups.deleteChatGroup(b.id)).resolves.toMatchObject({ members: { one: a.id } });
});

it('checks the membership limit before starting a project move', async () => {
  const { MAX_CHAT_GROUP_MEMBERS } = await import('../src/shared/chat-groups.js');
  durable.value = { version: 1, groups: [{ id: 'target', projectId: 'project-b', name: 'B', createdAt: 1 }],
    members: Object.fromEntries(Array.from({ length: MAX_CHAT_GROUP_MEMBERS }, (_, index) => [`chat-${index}`, 'target'])) };
  const move = vi.fn(async () => undefined);
  await expect(groups.moveChatGroup(chat('one'), 'project-b', 'target', move)).rejects.toThrow('Too many grouped chats');
  expect(move).not.toHaveBeenCalled();
  // Existing members can still change projects/groups at the limit, without adding another membership.
  expect((await groups.chatGroupsState()).members['chat-0']).toBe('target');
  await expect(groups.moveChatGroup(chat('chat-0'), 'project-b', 'target', move)).resolves.toBeTruthy();
  expect(move).toHaveBeenCalledTimes(1);
});

it('logs a queued group mutation once, but not an immediate one', async () => {
  const { onLog } = await import('../src/main/logger.js');
  const waits: string[] = [];
  const stop = onLog(entry => { if (entry.message.startsWith('chat groups: waiting')) waits.push(entry.message); });
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let moving: Promise<unknown> | undefined, deleting: Promise<unknown> | undefined;
  try {
    const { group } = await groups.createChatGroup('project-b', 'B', exists);
    expect(waits).toEqual([]);
    moving = groups.moveChatGroup(chat('one'), 'project-b', group.id, async () => { enter(); await gate; });
    await entered;
    deleting = groups.deleteChatGroup(group.id);
    expect(waits).toHaveLength(1);
    release(); await moving; await deleting;
    await groups.createChatGroup('project-a', 'A', exists);
    expect(waits).toHaveLength(1);
  } finally { release(); await moving; await deleting; stop(); }
});


it.each([
  { sessionId: '../../bad', fromProjectId: 'a', projectId: 'b', groupId: null },
  { sessionId: 'valid-chat', fromProjectId: null, projectId: null, groupId: null },
  { sessionId: 'valid-chat', fromProjectId: null, projectId: 'a'.repeat(36), groupId: 'missing' }
])('ignores an invalid move intent without losing legacy groups (%j)', async move => {
  const legacy = { version: 1, groups: [{ id: 'kept', projectId: 'project-a', name: 'Kept', createdAt: 1 }], members: { one: 'kept' } };
  durable.value = { ...legacy, move };
  expect(await groups.chatGroupsState()).toEqual(legacy);
});
