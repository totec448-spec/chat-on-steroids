export const PROJECT_COLORS = ['blue', 'green', 'amber', 'purple', 'rose', 'teal'] as const;
export type ProjectColor = typeof PROJECT_COLORS[number];

/** Explicit local folder selection. The project grants no filesystem permission. */
export interface LocalProject {
  id: string;
  name: string;
  path: string;
  /** A folder on a server (#1469); `path` is then its `host[:port]:/path` identity. */
  remote?: import('./types.js').RemoteFolder;
  /** Optional presentation-only sidebar accent. Never changes workspace or permission semantics. */
  color?: ProjectColor;
  createdAt: number;
  /** Removed sidebar group; existing conversations and queued work retain their folder. */
  ungrouped?: boolean;
  /** The secrets shield is off for this project's chats (on everywhere else, unless off in Settings). */
  secretsShieldOff?: boolean;
  /**
   * The native ChatGPT Project this CoS project's new chats open in. Only projects created after
   * this existed have one; it grants no filesystem permission.
   */
  chatgpt?: ChatgptProjectLink;
  /**
   * The model and effort a new chat in this project starts with, in place of the Settings
   * new-chat default (`ui.defaultChatModel`). A chat that has its own selection keeps it.
   */
  chatDefaults?: ProjectChatDefaults;
}

/** Why a new chat did not start on its project's own pair (the Settings default is used instead). */
export const PROJECT_CHAT_DEFAULTS_SKIPS = ['no-picker', 'model-gone', 'effort-gone'] as const;
export type ProjectChatDefaultsSkip = typeof PROJECT_CHAT_DEFAULTS_SKIPS[number];

/** A project's own new-chat model and effort; both are always set together. */
export interface ProjectChatDefaults {
  model: string;
  reasoningEffort: import('./session.js').ReasoningEffort;
}

/**
 * One CoS project's native ChatGPT Project, from request to verified identity.
 *
 * `requested` and `claimed` are before any click, so nothing can exist remotely yet.
 * `creating` is written before the click that creates it, so from there ChatGPT may hold a Project
 * whose id never came back: that ends as `linked` (its id seen on its own page) or `uncertain`,
 * which is never retried on its own because a retry could create a second Project.
 */
export type ChatgptProjectLink =
  | { state: 'requested'; requestId: string; updatedAt: number }
  | { state: 'claimed'; requestId: string; owner: string; updatedAt: number }
  | { state: 'creating'; requestId: string; owner: string; updatedAt: number }
  | { state: 'linked'; id: string; updatedAt: number }
  | { state: 'failed'; requestId: string; error: string; updatedAt: number }
  | { state: 'uncertain'; requestId: string; error: string; updatedAt: number };

/** ChatGPT addresses a Project as `g-p-` and 32 hex digits; nothing else is one. */
export const CHATGPT_PROJECT_ID = /^g-p-[0-9a-f]{32}$/;
