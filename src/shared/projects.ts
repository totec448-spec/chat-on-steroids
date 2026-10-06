export const PROJECT_COLORS = ['blue', 'green', 'amber', 'purple', 'rose', 'teal'] as const;
export type ProjectColor = typeof PROJECT_COLORS[number];

export interface ChatGptProjectLink {
  provider: 'chatgpt';
  /** Provider routing identity only. Display names and slugs are deliberately excluded. */
  projectId: string;
  linkedAt: number;
  lastObservedAt: number;
}

/** Stable ChatGPT Project routing identity used by native /g/<id>/... routes. */
export function normalizeChatGptProjectId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase();
  return /^g-p-[0-9a-f]{32}$/.test(candidate) ? candidate : null;
}

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
  /** Read-only provider association. Never grants filesystem or ChatGPT mutation authority. */
  remote?: ChatGptProjectLink;
}
