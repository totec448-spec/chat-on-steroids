/** Sidebar-only grouping inside a local project. It never changes workspace or filesystem scope. */
export interface ProjectChatFolder {
  id: string;
  name: string;
  createdAt: number;
}

/** Durable project/session identities are the only membership keys. */
export interface ProjectChatFolderState {
  projectId: string;
  folders: ProjectChatFolder[];
  assignments: Record<string, string>;
}
