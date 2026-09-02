/**
 * The entire renderer-facing API.
 *
 * Each function maps to exactly one named IPC channel. No channel name is ever taken
 * from the caller, so the renderer cannot reach a handler that is not listed here, and
 * ipcRenderer itself is never exposed.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppState, Capabilities, Config, Diagnosis, LogEntry } from '../shared/types.js';
import type {
  Handoff,
  SessionEvent,
  SessionSummary,
  ClearAgentResult,
  SwarmState,
  TokenPressure
} from '../shared/session.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

const call = <T>(channel: string, payload?: unknown): Promise<Reply<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<Reply<T>>;

export interface SettingsPatch {
  capabilities: Capabilities;
  readOnly: boolean;
  tunnel: Config['tunnel'];
  ui: Config['ui'];
  sessions: Config['sessions'];
  compaction: Config['compaction'];
  multiAgent: Config['multiAgent'];
  goal: Config['goal'];
}

/** One page of the OpenRouter catalogue, as the model picker asks for it. */
export interface GoalModelPage {
  models: Array<{ id: string; name: string; created: number; contextLength: number }>;
  total: number;
}

export interface SessionList {
  sessions: SessionSummary[];
  activeId: string | null;
  /** ChatGPT conversation ids the user has blocked from using local tools. */
  blocked: string[];
  pressure: Array<TokenPressure & { id: string }>;
  /** Total retained sessions, not merely the current IPC page. */
  total: number;
  nextCursor: SessionListCursor | null;
}

export interface SessionListCursor {
  updatedAt: number;
  id: string;
}

export interface SessionDetail {
  summary: SessionSummary | null;
  events: SessionEvent[];
  total: number;
  /** First sequence not represented by this response; pass back as `from` for live deltas. */
  nextFrom: number;
}

const api = {
  getState: () => call<AppState>('state:get'),
  saveSettings: (patch: SettingsPatch, base: SettingsPatch) => call<AppState>('settings:save', { patch, base }),
  addRoot: () => call<AppState>('roots:add'),
  /** A folder dropped on the window; only the preload can learn a dropped File's path. */
  addRootPath: (file: File) => call<AppState>('roots:addPath', { path: webUtils.getPathForFile(file) }),
  removeRoot: (name: string) => call<AppState>('roots:remove', { name }),
  renameRoot: (name: string, newName: string) => call<AppState>('roots:rename', { name, newName }),
  setApiKey: (value: string) => call<AppState>('secret:set', { value }),
  // The goal loop's own credential. Same channel, named slot; the value only ever goes in.
  setGoalKey: (value: string) => call<AppState>('secret:set', { value, key: 'openRouterApiKey' }),
  listGoalModels: (offset: number) => call<GoalModelPage>('goal:models', { offset }),
  pickBinary: () => call<AppState>('binary:pick'),
  connect: () => call<AppState>('connection:connect'),
  disconnect: () => call<AppState>('connection:disconnect'),
  runDiagnostics: () => call<Diagnosis>('diagnostics:run'),
  requestDesktopAccessibility: () => call<AppState>('desktop:requestAccessibility'),
  getLog: () => call<LogEntry[]>('log:get'),
  getLogText: () => call<string>('log:text'),
  getLogJson: () => call<string>('log:json'),
  writeClipboard: (text: string) => call<boolean>('clipboard:write', { text }),
  openLink: (url: string) => call<boolean>('link:open', { url }),

  // Sessions, compaction and the browser bridge. Everything here is read-only or a
  // named action; there is still no channel that takes a path or a command.
  listSessions: (options?: { cursor?: SessionListCursor; limit?: number }) =>
    call<SessionList>('sessions:list', options ?? {}),
  getSession: (id: string, options?: { from?: number; limit?: number }) =>
    call<SessionDetail>('sessions:events', { id, ...options }),
  openSessionChat: (id: string) => call<boolean>('sessions:openChat', { id }),
  // Stops a chat this app cannot stop in the page: every tool call it has already been proved
  // to own is refused until it is released. Returns the whole blocked set, so one press
  // repaints without a second read.
  setSessionBlocked: (id: string, blocked: boolean) => call<string[]>('sessions:block', { id, blocked }),
  deleteSession: (id: string) => call<boolean>('sessions:delete', { id }),
  getHandoff: (id: string, handoffId?: string) => call<Handoff | null>('handoff:get', { id, handoffId }),

  unpairExtension: () => call<AppState>('bridge:unpair'),
  downloadExtension: () => call<boolean>('bridge:downloadExtension'),
  // The renderer can ask where the extension is and ask for it to be opened, but the
  // path it gets back is only ever displayed: the open happens in the main process
  // against a folder the renderer never chose.
  extensionPath: () => call<string | null>('bridge:extensionPath'),
  openExtensionFolder: () => call<string>('bridge:openExtensionFolder'),

  getSwarm: () => call<SwarmState>('swarm:get'),
  resetSwarm: () => call<SwarmState>('swarm:reset'),
  // Clearing the prime ends the run; clearing a worker frees that slot. Which of the two
  // happened comes back in the result — the renderer does not decide it.
  clearAgent: (id: string) => call<ClearAgentResult>('swarm:clearAgent', id),

  onStateChanged: (listener: (state: AppState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: AppState): void => listener(state);
    ipcRenderer.on('state:changed', wrapped);
    return () => ipcRenderer.removeListener('state:changed', wrapped);
  },
  onLogEntry: (listener: (entry: LogEntry) => void): (() => void) => {
    const wrapped = (_event: unknown, entry: LogEntry): void => listener(entry);
    ipcRenderer.on('log:entry', wrapped);
    return () => ipcRenderer.removeListener('log:entry', wrapped);
  },
  onSessionChanged: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('session:changed', wrapped);
    return () => ipcRenderer.removeListener('session:changed', wrapped);
  },
  onSwarmChanged: (listener: (state: SwarmState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: SwarmState): void => listener(state);
    ipcRenderer.on('swarm:changed', wrapped);
    return () => ipcRenderer.removeListener('swarm:changed', wrapped);
  }
};

export type AppApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
