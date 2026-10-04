export const PROJECT_COLORS = ['blue', 'green', 'amber', 'purple', 'rose', 'teal'] as const;
export type ProjectColor = typeof PROJECT_COLORS[number];

/** Explicit local folder selection. The project grants no filesystem permission. */
export interface LocalProject {
  id: string;
  name: string;
  path: string;
  /** Optional presentation-only sidebar accent. Never changes workspace or permission semantics. */
  color?: ProjectColor;
  createdAt: number;
  /** Removed sidebar group; existing conversations and queued work retain their folder. */
  ungrouped?: boolean;
}
