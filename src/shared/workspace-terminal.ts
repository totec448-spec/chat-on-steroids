export interface WorkspaceTerminalInfo {
  id: string;
  projectId: string | null;
  cwd: string;
  shell: string;
}
export type WorkspaceTerminalEvent =
  | { id: string; data: string }
  | { id: string; exitCode: number };
