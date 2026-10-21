import { randomUUID } from 'node:crypto';
import { readDurable, writeDurableSoon } from './durable.js';
import type { ChatGroup, ChatGroupsState } from '../shared/chat-groups.js';
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
let state: ChatGroupsState = { version: 1, groups: [], members: {} };
/** The one load of the store; every caller waits for the same one (two early actions once both loaded it). */
let loading: Promise<void> | null = null;

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

function ready(): Promise<void> {
  // A corrupt or unreadable store starts empty: grouping is never worth a sidebar that will not open.
  loading ??= readDurable<unknown>(STORE).catch(() => null).then(raw => { state = clean(raw); });
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
  await ready();
  if (!projectExists(projectId)) throw new Error('This project is not available');
  const clean = chatGroupName(name);
  if (!clean) throw new Error('A group name needs 1 to 60 characters');
  if (state.groups.filter(group => group.projectId === projectId).length >= MAX_CHAT_GROUPS_PER_PROJECT) {
    throw new Error('A project can hold up to 100 groups');
  }
  const group: ChatGroup = { id: randomUUID(), projectId, name: clean, createdAt: Date.now() };
  state.groups.push(group);
  return { group: { ...group }, state: save() };
}

export async function renameChatGroup(id: string, name: string): Promise<ChatGroupsState> {
  await ready();
  const group = state.groups.find(row => row.id === id);
  if (!group) throw new Error('This group no longer exists');
  const clean = chatGroupName(name);
  if (!clean) throw new Error('A group name needs 1 to 60 characters');
  group.name = clean;
  return save();
}

/** Removes the group. Its chats stay in their project, ungrouped; nothing about them changes. */
export async function deleteChatGroup(id: string): Promise<ChatGroupsState> {
  await ready();
  if (!state.groups.some(group => group.id === id)) return snapshot();
  state.groups = state.groups.filter(group => group.id !== id);
  for (const [sessionId, groupId] of Object.entries(state.members)) if (groupId === id) delete state.members[sessionId];
  return save();
}

/** Puts a chat into one of its project's groups, or takes it out with `groupId` null. */
export async function assignChatGroup(session: ChatGroupSession | null, groupId: string | null): Promise<ChatGroupsState> {
  await ready();
  if (!session) throw new Error('This chat no longer exists');
  if (groupId === null) {
    if (!(session.id in state.members)) return snapshot();
    delete state.members[session.id];
    return save();
  }
  const group = state.groups.find(row => row.id === groupId);
  if (!group) throw new Error('This group no longer exists');
  // A sub-agent's chat follows its prime and is never listed on its own.
  if (session.origin?.kind === 'worker') throw new Error('A sub-agent chat follows its main chat');
  if (session.projectId !== group.projectId) throw new Error("This chat is not in that group's project");
  if (state.members[session.id] === groupId) return snapshot();
  if (!(session.id in state.members) && Object.keys(state.members).length >= MAX_CHAT_GROUP_MEMBERS) {
    throw new Error('Too many grouped chats');
  }
  state.members[session.id] = groupId;
  return save();
}

/** A chat that no longer exists leaves its group. */
export async function forgetChatGroupMember(sessionId: string): Promise<void> {
  await ready();
  if (!(sessionId in state.members)) return;
  delete state.members[sessionId];
  save();
}

export function resetChatGroupsForTests(): void {
  state = { version: 1, groups: [], members: {} };
  loading = null;
}
