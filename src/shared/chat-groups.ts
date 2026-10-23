/** Chat groups (#1038): named groups inside a project, one level deep. See src/main/chat-groups.ts. */
export interface ChatGroup {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
}

export interface ChatGroupsState {
  version: 1;
  groups: ChatGroup[];
  /** Session id → group id. Counts only while the session is a chat of the group's own project. */
  members: Record<string, string>;
}

export const CHAT_GROUP_NAME_MAX = 60;
export const MAX_CHAT_GROUPS_PER_PROJECT = 100;
export const MAX_CHAT_GROUP_MEMBERS = 5000;

/** A group's name as kept: trimmed, inner whitespace folded to single spaces; null when empty or too long. */
export function chatGroupName(value: string): string | null {
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return name && [...name].length <= CHAT_GROUP_NAME_MAX ? name : null;
}

/** The group a chat is shown in: its member group, while that group belongs to the chat's own project. */
export function chatGroupOf(state: ChatGroupsState, session: { id: string; projectId?: string | null; origin?: { kind?: string } | null }): ChatGroup | null {
  if (session.origin?.kind === 'worker' || !session.projectId) return null;
  const groupId = state.members[session.id];
  const group = groupId ? state.groups.find(row => row.id === groupId) : undefined;
  return group && group.projectId === session.projectId ? group : null;
}
