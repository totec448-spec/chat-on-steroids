import type http from 'node:http';
export interface WebLocalOwnerView {
  projects: Array<{ name: string }>;
}
export interface WebLocalService {
  server: http.Server;
  issueActivation(): string;
  revokeActivation(path: string): void;
  stop(): Promise<void>;
}
export function createWebLocalServer(options: {
  read(): Promise<WebLocalOwnerView>;
  now?: () => number;
  readDeadlineMs?: number;
  drainMs?: number;
  /** Fixed, bounded diagnostics only; never receives request or credential values. */
  onDecision?: (kind: 'activation_accepted' | 'projects_view_served' | 'owner_read_unavailable') => void;
  /** The selected UI language, re-read on browser refresh; unsupported tags use English. */
  language?: string | (() => string);
}): WebLocalService;
