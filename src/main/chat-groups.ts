import { randomUUID } from 'node:crypto';
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import type { ChatGroup, ChatGroupsState } from '../shared/chat-groups.js';
import { logInfo, logWarn } from './logger.js';
import { MAX_CHAT_GROUP_MEMBERS, MAX_CHAT_GROUPS_PER_PROJECT, chatGroupName } from '../shared/chat-groups.js';

/**
 * Chat groups (#1038): named groups inside a project, one level deep, to sort its chats.
 *
 * Organisation only. A group never changes a chat's project, folder, permissions or anything a
 * tool call sees; the sidebar reads it, nothing else does. Membership is kept by session id and
 * counts only while that session is a chat of the group's own project (see `memberOf`), so a chat
 * that leaves its project falls back to "no group" without anything here being rewritten.
 */
const STORE = 'chat-groups';
/** One in-flight move, serialized with the catalog/members in the same atomic store write. */
interface GroupMove { sessionId: string; fromProjectId: string | null; projectId: string | null; groupId: string | null }
let state: ChatGroupsState = { version: 1, groups: [], members: {} };
/** The one load of the store; every caller waits for the same one (two early actions once both loaded it). */
let loading: Promise<void> | null = null;
// A project move holds this queue from group validation through placement. Other group mutations
// cannot delete its destination or consume its membership slot while session writes are pending.
let mutations: Promise<unknown> = Promise.resolve();
let pendingMutations = 0;
function mutate<T>(change: () => T | Promise<T>): Promise<T> {
  if (pendingMutations) logInfo('chat groups: waiting for an earlier group mutation to finish');
  pendingMutations++;
  const operation = mutations.then(async () => { await ready(); return change(); });
  const settled = () => { pendingMutations--; };
  mutations = operation.then(settled, settled);
  return operation;
}

export interface ChatGroupSession { id: string; projectId?: string | null; origin?: { kind?: string } | null }

function clean(raw: unknown): ChatGroupsState {
  const out: ChatGroupsState = { version: 1, groups: [], members: {} };
  if (!raw || typeof raw !== 'object') return out;
  const value = raw as Partial<ChatGroupsState>;
  const perProject = new Map<string, number>();
  for (const group of Array.isArray(value.groups) ? value.groups : []) {
    if (!group || typeof group !== 'object') continue;
    const name = typeof group.name === 'string' ? chatGroupName(group.name) : null;
    if (typeof group.id !== 'string' || !group.id || group.id.length > 64 || typeof group.projectId !== 'string' ||
        !group.projectId || group.projectId.length > 160 || !name || out.groups.some(known => known.id === group.id)) continue;
    const count = perProject.get(group.projectId) ?? 0;
    if (count >= MAX_CHAT_GROUPS_PER_PROJECT) continue;
    perProject.set(group.projectId, count + 1);
    out.groups.push({ id: group.id, projectId: group.projectId, name, createdAt: Number.isFinite(group.createdAt) ? Number(group.createdAt) : 0 });
  }
  const ids = new Set(out.groups.map(group => group.id));
  const members = value.members && typeof value.members === 'object' ? value.members : {};
  for (const [sessionId, groupId] of Object.entries(members)) {
    if (Object.keys(out.members).length >= MAX_CHAT_GROUP_MEMBERS) break;
    if (sessionId && sessionId.length <= 160 && typeof groupId === 'string' && ids.has(groupId)) out.members[sessionId] = groupId;
  }
  return out;
}

function savedMove(raw: unknown, groups: ChatGroupsState): GroupMove | null {
  const value = raw && typeof raw === 'object' ? (raw as { move?: Partial<GroupMove> }).move : null;
  const project = (id: unknown): id is string | null => id === null || (typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id));
  if (!value || typeof value !== 'object' || typeof value.sessionId !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(value.sessionId) ||
      !project(value.fromProjectId) || !project(value.projectId) || value.fromProjectId === value.projectId ||
      !(value.groupId === null || (typeof value.groupId === 'string' && groups.groups.some(group => group.id === value.groupId && group.projectId === value.projectId)))) return null;
  // A valid prepare reserved this slot before any project write. Do not trust an edited overflow.
  if (value.groupId && groups.members[value.sessionId] === undefined && Object.keys(groups.members).length >= MAX_CHAT_GROUP_MEMBERS) return null;
  return { sessionId: value.sessionId, fromProjectId: value.fromProjectId, projectId: value.projectId, groupId: value.groupId };
}

function ready(): Promise<void> {
  if (!loading) loading = (async () => {
    // Keep readable legacy/corrupt values tolerant, but never overwrite an unreadable recovery record.
    const raw = await readDurable<unknown>(STORE, { strict: true }).catch(error => {
      if (error?.damaged) {
        logWarn('chat groups: saved grouping is damaged; starting with empty grouping');
        return null;
      }
      throw error;
    });
    const restored = clean(raw);
    const move = savedMove(raw, restored);
    if (raw && typeof raw === 'object' && 'move' in raw && !move) logWarn('chat groups: ignored an invalid saved project move intent');
    if (move) {
      // The session's saved project decides the outcome; grouping never moves a chat itself.
      const { getSessionOrNullIfMissing } = await import('./session/store.js');
      const session = await getSessionOrNullIfMissing(move.sessionId);
      const committed = !!session && (session.projectId ?? null) === move.projectId;
      if (committed && move.groupId) restored.members[move.sessionId] = move.groupId;
      else if (committed || !session) delete restored.members[move.sessionId];
      // Retire the intent only after recovery is durable, before another group operation can start.
      await writeDurableNow(STORE, restored);
      logInfo(!session ? 'chat groups: retired a saved group move for a missing chat after restart'
        : `chat groups: ${committed ? 'restored group placement for a committed' : 'retired an uncommitted'} project move after restart`);
    }
    state = restored;
  })().catch(error => {
    loading = null;
    logWarn('chat groups: could not load or recover saved groups; kept the stored state for retry');
    throw error;
  });
  return loading;
}

function save(): ChatGroupsState {
  writeDurableSoon(STORE, state);
  return snapshot();
}

function snapshot(): ChatGroupsState {
  return { version: 1, groups: state.groups.map(group => ({ ...group })), members: { ...state.members } };
}

/** The current groups and memberships. */
export async function chatGroupsState(): Promise<ChatGroupsState> {
  await ready();
  return snapshot();
}

export async function createChatGroup(projectId: string, name: string, projectExists: (id: string) => boolean): Promise<{ group: ChatGroup; state: ChatGroupsState }> {
  return mutate(() => {
    if (!projectExists(projectId)) throw new Error('This project is not available');
    const clean = chatGroupName(name);
    if (!clean) throw new Error('A group name needs 1 to 60 characters');
    if (state.groups.filter(group => group.projectId === projectId).length >= MAX_CHAT_GROUPS_PER_PROJECT) {
      throw new Error('A project can hold up to 100 groups');
    }
    const group: ChatGroup = { id: randomUUID(), projectId, name: clean, createdAt: Date.now() };
    state.groups.push(group);
    return { group: { ...group }, state: save() };
  });
}

export async function renameChatGroup(id: string, name: string): Promise<ChatGroupsState> {
  return mutate(() => {
    const group = state.groups.find(row => row.id === id);
    if (!group) throw new Error('This group no longer exists');
    const clean = chatGroupName(name);
    if (!clean) throw new Error('A group name needs 1 to 60 characters');
    group.name = clean;
    return save();
  });
}

/** Removes the group. Its chats stay in their project, ungrouped; nothing about them changes. */
export async function deleteChatGroup(id: string): Promise<ChatGroupsState> {
  return mutate(() => {
    if (!state.groups.some(group => group.id === id)) return snapshot();
    state.groups = state.groups.filter(group => group.id !== id);
    for (const [sessionId, groupId] of Object.entries(state.members)) if (groupId === id) delete state.members[sessionId];
    return save();
  });
}

/** A live caller resolves the session inside the queue; snapshot callers keep their existing contract. */
export async function assignChatGroup(session: ChatGroupSession | null | (() => Promise<ChatGroupSession | null>), groupId: string | null): Promise<ChatGroupsState> {
  return mutate(async () => {
    const current = typeof session === 'function' ? await session() : session;
    if (!current) throw new Error('This chat no longer exists');
    if (groupId === null) {
      if (!(current.id in state.members)) return snapshot();
      delete state.members[current.id];
      return save();
    }
    const group = state.groups.find(row => row.id === groupId);
    if (!group) throw new Error('This group no longer exists');
    // A sub-agent's chat follows its prime and is never listed on its own.
    if (current.origin?.kind === 'worker') throw new Error('A sub-agent chat follows its main chat');
    if (current.projectId !== group.projectId) throw new Error("This chat is not in that group's project");
    if (state.members[current.id] === groupId) return snapshot();
    if (!(current.id in state.members) && Object.keys(state.members).length >= MAX_CHAT_GROUP_MEMBERS) {
      throw new Error('Too many grouped chats');
    }
    state.members[current.id] = groupId;
    return save();
  });
}

/**
 * The group a moved chat ends in (#1919): none out of a project; the one asked for, `null` included;
 * when none was asked for, its old group if it stayed in the same project, else none.
 */
export function movedChatGroup(projectId: string | null, requested: string | null | undefined, from: string | null, fromGroup: string | null): string | null {
  if (projectId === null) return null;
  if (requested !== undefined) return requested;
  return from === projectId ? fromGroup : null;
}

function validatePlacement(sessionId: string, projectId: string | null, groupId: string | null): void {
  const target = groupId ? state.groups.find(group => group.id === groupId) : undefined;
  if (groupId && (!target || target.projectId !== projectId)) throw new Error("This chat is not in that group's project");
  if (groupId && state.members[sessionId] === undefined && Object.keys(state.members).length >= MAX_CHAT_GROUP_MEMBERS) {
    throw new Error('Too many grouped chats');
  }
}
function place(sessionId: string, groupId: string | null, retireMove = false): ChatGroupsState {
  if (state.members[sessionId] === (groupId ?? undefined)) return retireMove ? save() : snapshot();
  if (groupId) state.members[sessionId] = groupId;
  else delete state.members[sessionId];
  return save();
}
/**
 * A chat the person moved to another project (#1919) leaves its old project's group, and joins
 * `groupId` when it was dropped onto a group of its new project.
 */
export async function placeMovedChat(sessionId: string, projectId: string | null, groupId: string | null): Promise<ChatGroupsState> {
  return mutate(() => {
    validatePlacement(sessionId, projectId, groupId);
    return place(sessionId, groupId);
  });
}

/** Validate organisation before changing a chat's project, and keep it valid until placement. */
export function moveChatGroup<T>(session: ChatGroupSession, projectId: string | null, requested: string | null | undefined,
  move: () => Promise<T>): Promise<{ result: T; fromGroup: string | null; groups: ChatGroupsState }> {
  return mutate(async () => {
    const fromGroup = state.members[session.id] ?? null;
    const target = movedChatGroup(projectId, requested, session.projectId ?? null, fromGroup);
    try { validatePlacement(session.id, projectId, target); } catch (error) {
      logInfo(`chat groups: refused project move before changing the chat or its workers: ${(error as Error).message}`);
      throw error;
    }
    const fromProjectId = session.projectId ?? null;
    const journal = fromProjectId !== projectId && (fromGroup !== null || target !== null);
    if (journal) {
      // Catalog, old membership and intended placement cross disk together, before the session.
      const intent: GroupMove = { sessionId: session.id, fromProjectId, projectId, groupId: target };
      try { await writeDurableNow(STORE, { ...snapshot(), move: intent }); } catch (error) {
        // Supersede the durable writer's retained retry: no project write was admitted.
        save();
        logInfo('chat groups: refused project move because its recovery intent could not be saved');
        throw error;
      }
    }
    try {
      const result = await move();
      return { result, fromGroup, groups: place(session.id, target, journal) };
    } catch (error) {
      if (journal) save(); // The failed callback keeps its old placement, as before.
      throw error;
    }
  });
}

/** A chat that no longer exists leaves its group. */
export async function forgetChatGroupMember(sessionId: string): Promise<void> {
  return mutate(() => {
    if (!(sessionId in state.members)) return;
    delete state.members[sessionId];
    save();
  });
}

export function resetChatGroupsForTests(): void {
  state = { version: 1, groups: [], members: {} };
  loading = null;
  mutations = Promise.resolve();
  pendingMutations = 0;
}
