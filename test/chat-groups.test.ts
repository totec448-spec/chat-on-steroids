import { beforeEach, expect, it, vi } from 'vitest';

const durable = vi.hoisted(() => ({ value: null as unknown, writes: 0, reads: 0, slowSecondRead: false }));
vi.mock('../src/main/durable.js', () => ({
  readDurable: async () => {
    const value = structuredClone(durable.value);
    durable.reads++;
    if (durable.slowSecondRead && durable.reads === 2) await new Promise(resolve => setTimeout(resolve, 20));
    return value;
  },
  writeDurableSoon: (_name: string, value: unknown) => { durable.value = structuredClone(value); durable.writes++; }
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
