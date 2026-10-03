/** Explicit local folder selection. The project grants no filesystem permission. */
export interface LocalProject {
  id: string;
  name: string;
  /** Authoritative default workspace and project-instruction directory. */
  path: string;
  /** Canonical approved folders addressable only when a caller targets one explicitly. */
  additionalPaths?: string[];
  createdAt: number;
  /** Removed sidebar group; existing conversations and queued work retain their folder. */
  ungrouped?: boolean;
}
