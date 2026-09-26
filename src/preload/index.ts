import type { WorkspaceTerminalEvent, WorkspaceTerminalInfo } from '../shared/workspace-terminal.js';
import type { ChatModelCatalog } from '../shared/chat-models.js';
import type { GoalModel } from '../shared/goal-reasoning.js';
import type { TaskProgress } from '../shared/task-progress.js';
import type { BrowserPreferences } from '../shared/browser-preferences.js';
import type { BrowserUseBounds, BrowserUseDesignContext, BrowserUseRequest, BrowserUseState } from '../shared/browser-use.js';
import type { SessionControlsView } from '../main/bridge.js';
import type { InputAttachment } from '../shared/input.js';
import type { UsageOverview } from '../shared/usage.js';
import type { InputArgs, InputEntry } from '../main/session/input.js';
import type { LocalProject } from '../shared/projects.js';
import type { ProjectDirectoryListing, ProjectFileMutationResult, ProjectFilePreview, ProjectFileSaveResult, ProjectFilesChanged } from '../shared/project-files.js';
import type { ProjectGitChanged, ProjectGitDiff, ProjectGitSnapshot } from '../shared/project-git.js';
import type { ToolEditReview } from '../shared/session.js';
import type { SkillSummary, ManagedSkill, GitHubSkillUpdateCheck, SkillLibrary, SkillsDraftScope } from '../shared/skills.js';
import type { PluginSnapshot, PluginInstallRequest, PluginConfigPatch } from '../shared/plugins.js';
import type { PetLibraryState, PetOverlayControlState, PetRuntimeAsset } from '../shared/pets.js';
import type { ViewMenuCommand, ViewMenuToggleRequest, ViewMenuToggleState } from '../shared/view-menu.js';
/**
 * The entire renderer-facing API.
 *
 * Each function maps to exactly one named IPC channel. No channel name is ever taken
 * from the caller, so the renderer cannot reach a handler that is not listed here, and
 * ipcRenderer itself is never exposed.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppState, Capabilities, CompanionDiagnostics, Config, Diagnosis, LogEntry } from '../shared/types.js';
import type {
  Handoff,
  ImageStorageClearMode,
  ImageStorageClearResult,
  ImageStorageInfo,
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
  mcp: Config['mcp'];
}

/** One page of the model catalogue, as the model picker asks for it. */
export interface GoalModelPage {
  models: GoalModel[];
  total: number;
  selectedModel?: GoalModel;
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
  petsList: () => call<PetLibraryState>('pets:list'),
  petsOverlayState: () => call<PetOverlayControlState>('pets:overlayState'),
  petsSetOverlayVisible: (visible: boolean) => call<PetOverlayControlState>('pets:overlayVisible', { visible }),
  petsImport: () => call<PetLibraryState | null>('pets:import'),
  petsSetEnabled: (id: string, enabled: boolean) => call<PetLibraryState>('pets:enabled', { id, enabled }),
  petsSetFavorite: (id: string, favorite: boolean) => call<PetLibraryState>('pets:favorite', { id, favorite }),
  petsDelete: (id: string) => call<PetLibraryState>('pets:delete', { id }),
  petsAsset: (id: string, preview = false) => call<PetRuntimeAsset>('pets:asset', { id, preview }),
  onPetOverlayStateChanged: (listener: (state: PetOverlayControlState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: PetOverlayControlState): void => listener(state);
    ipcRenderer.on('pet-overlay:stateChanged', wrapped);
    return () => ipcRenderer.removeListener('pet-overlay:stateChanged', wrapped);
  },
  onPetOverlayOpenOwner: (listener: (screen: 'chat' | 'pets') => void): (() => void) => {
    const wrapped = (_event: unknown, screen: 'chat' | 'pets'): void => listener(screen);
    ipcRenderer.on('pet-overlay:openOwner', wrapped);
    return () => ipcRenderer.removeListener('pet-overlay:openOwner', wrapped);
  },
  terminalCreate: (id: string, projectId: string, cols: number, rows: number) => call<WorkspaceTerminalInfo>('workspaceTerminal:request', { action: 'create', id, projectId, cols, rows }),
  terminalWrite: (id: string, data: string) => call<void>('workspaceTerminal:request', { action: 'write', id, data }),
  terminalResize: (id: string, cols: number, rows: number) => call<void>('workspaceTerminal:request', { action: 'resize', id, cols, rows }),
  terminalAck: (id: string, count: number) => call<void>('workspaceTerminal:request', { action: 'ack', id, count }),
  terminalClose: (id: string) => call<void>('workspaceTerminal:request', { action: 'close', id }),
  onTerminalEvent: (listener: (event: WorkspaceTerminalEvent) => void): (() => void) => {
    const wrapped = (_event: unknown, value: WorkspaceTerminalEvent): void => listener(value);
    ipcRenderer.on('workspaceTerminal:event', wrapped);
    return () => ipcRenderer.removeListener('workspaceTerminal:event', wrapped);
  },
  openLegalNotices: () => call<void>('plugins:legalNotices'),
  pluginsSnapshot: () => call<PluginSnapshot>('plugins:snapshot'),
  pluginsInstall: (request: PluginInstallRequest) => call<PluginSnapshot>('plugins:install', request),
  pluginsConfigure: (id: string, patch: PluginConfigPatch) => call<PluginSnapshot>('plugins:configure', { id, patch }),
  pluginsRestart: (id: string) => call<PluginSnapshot>('plugins:restart', { id }),
  pluginsAuthenticate: (id: string) => call<PluginSnapshot>('plugins:authenticate', { id }),
  pluginsCancelAuthentication: (id: string) => call<PluginSnapshot>('plugins:cancelAuthentication', { id }),
  pluginsUpdate: (id: string) => call<PluginSnapshot>('plugins:update', { id }),
  pluginsUninstall: (id: string) => call<PluginSnapshot>('plugins:uninstall', { id }),
  pluginsSetEnabled: (id: string, enabled: boolean) => call<PluginSnapshot>('plugins:enabled', { id, enabled }),
  pluginsSetToolEnabled: (id: string, name: string, enabled: boolean) => call<PluginSnapshot>('plugins:tool', { id, name, enabled }),
  pluginsImportBundle: () => call<string | null>('plugins:importBundle'),
  onPluginsChanged: (listener: (snapshot: PluginSnapshot) => void): (() => void) => {
    const wrapped = (_event: unknown, snapshot: PluginSnapshot): void => listener(snapshot);
    ipcRenderer.on('plugins:changed', wrapped);
    return () => ipcRenderer.removeListener('plugins:changed', wrapped);
  },
  chooseFiles: () => call<InputAttachment[]>('sessions:files'),
  listSkills: () => call<SkillSummary[]>('skills:list'),
  listManagedSkills: () => call<ManagedSkill[]>('skills:managed'),
  skillsImport: (kind: 'folder' | 'file') => call<ManagedSkill[] | null>('skills:import', { kind }),
  skillsImportGithub: (url: string) => call<ManagedSkill[]>('skills:githubImport', { url }),
  skillsLinkGithub: (id: string, url: string) => call<ManagedSkill[]>('skills:githubLink', { id, url }),
  skillsCheckGithub: (id: string) => call<GitHubSkillUpdateCheck[]>('skills:githubCheck', { id }),
  skillsUpdateGithub: (id: string) => call<{ status: 'current' | 'updated'; skills: ManagedSkill[]; warning?: string }>('skills:githubUpdate', { id }),
  skillsRemove: (id: string) => call<ManagedSkill[]>('skills:remove', { id }),
  skillLibrary: (scope: SkillsDraftScope) => call<SkillLibrary>('skills:library', scope),
  dropFiles: async (files: File[]): Promise<Reply<InputAttachment[]>> => {
    if (!files.length || files.length > 20) return { ok: false, error: 'Attach up to 20 files per message' };
    try {
      const sources = [];
      for (const file of files) {
        const path = webUtils.getPathForFile(file);
        if (!path && file.size > 12 * 1024 * 1024) return { ok: false, error: 'Pasted images must be 12 MB or smaller' };
        sources.push(path || { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
      return await call<InputAttachment[]>('sessions:dropFiles', { files: sources });
    } catch { return { ok: false, error: 'Could not read the attachment' }; }
  },
  attachText: (text: string) => call<InputAttachment>('sessions:attachText', { text }),
  getUsage: () => call<UsageOverview>('usage:get'),
  getState: () => call<AppState>('state:get'),
  saveSettings: (patch: SettingsPatch, base: SettingsPatch) => call<AppState>('settings:save', { patch, base }),
  addRoot: () => call<AppState>('roots:add'),
  /** A folder dropped on the window; only the preload can learn a dropped File's path. */
  addRootPath: (file: File) => call<AppState>('roots:addPath', { path: webUtils.getPathForFile(file) }),
  removeRoot: (name: string) => call<AppState>('roots:remove', { name }),
  renameRoot: (name: string, newName: string) => call<AppState>('roots:rename', { name, newName }),
  setApiKey: (value: string, profileId?: string) => call<AppState>('secret:set', { value, ...(profileId ? { profileId } : {}) }),
  addSetupProfile: (name: string) => call<AppState>('setup:profile', { action: 'add', name }),
  selectSetupProfile: (id: string) => call<AppState>('setup:profile', { action: 'select', id }),
  removeSetupProfile: (id: string) => call<AppState>('setup:profile', { action: 'remove', id }),
  // The goal loop's own credential. Same channel, named slot; the value only ever goes in.
  setGoalKey: (value: string) => call<AppState>('secret:set', { value, key: 'openRouterApiKey' }),
  // The same, for a custom provider endpoint. Optional: keyless local servers need nothing stored.
  setCustomProviderKey: (value: string) => call<AppState>('secret:set', { value, key: 'customProviderApiKey' }),
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
  // Applies the update this app has already downloaded and verified: the app quits, the
  // installer runs, and the app comes back as the new version. It takes no argument because
  // there is nothing here to choose - the main process knows what is staged.
  installUpdate: () => call<boolean>('update:install'),

  // Sessions, compaction and the browser bridge. Everything here is read-only or a
  // named action; there is still no channel that takes a path or a command.
  listSessions: (options?: { cursor?: SessionListCursor; limit?: number }) =>
    call<SessionList>('sessions:list', options ?? {}),
  listProjects: () => call<LocalProject[]>('projects:list'),
  addProject: () => call<LocalProject | null>('projects:add'),
  removeProject: (id: string) => call<LocalProject>('projects:remove', { id }),
  listProjectFiles: (projectId: string, directory = '') => call<ProjectDirectoryListing>('projectFiles:list', { projectId, directory }),
  watchProjectFiles: (projectId: string | null, directories: string[]) => call<boolean>('projectFiles:watch', { projectId, directories }),
  onProjectFilesChanged: (listener: (event: ProjectFilesChanged) => void): (() => void) => {
    const wrapped = (_event: unknown, change: ProjectFilesChanged): void => listener(change);
    ipcRenderer.on('projectFiles:changed', wrapped);
    return () => ipcRenderer.removeListener('projectFiles:changed', wrapped);
  },
  previewProjectFile: (projectId: string, path: string) => call<ProjectFilePreview>('projectFiles:preview', { projectId, path }),
  createProjectFileEntry: (projectId: string, directory: string, name: string, kind: 'file' | 'directory') =>
    call<ProjectFileMutationResult>('projectFiles:create', { projectId, directory, name, kind }),
  renameProjectFileEntry: (projectId: string, path: string, name: string) => call<ProjectFileMutationResult>('projectFiles:rename', { projectId, path, name }),
  saveProjectFile: (projectId: string, path: string, text: string, expectedModifiedAt: string, expectedBytes: number, expectedRevision: string) =>
    call<ProjectFileSaveResult>('projectFiles:save', { projectId, path, text, expectedModifiedAt, expectedBytes, expectedRevision }),
  deleteProjectFileEntry: (projectId: string, path: string) => call<boolean>('projectFiles:delete', { projectId, path }),
  revealProjectFileEntry: (projectId: string, path = '') => call<boolean>('projectFiles:reveal', { projectId, path }),
  attachProjectFile: (projectId: string, path: string) => call<InputAttachment>('projectFiles:attach', { projectId, path }),
  getProjectGitSnapshot: (projectId: string) => call<ProjectGitSnapshot>('projectGit:snapshot', { projectId }),
  getProjectGitDiff: (projectId: string, path: string) => call<ProjectGitDiff>('projectGit:diff', { projectId, path }),
  getToolEditReview: (sessionId: string, callId: string, changeIndex: number) =>
    call<ToolEditReview | null>('sessions:toolEditReview', { sessionId, callId, changeIndex }),
  onProjectGitChanged: (listener: (event: ProjectGitChanged) => void): (() => void) => {
    const wrapped = (_event: unknown, change: ProjectGitChanged): void => listener(change);
    ipcRenderer.on('projectGit:changed', wrapped);
    return () => ipcRenderer.removeListener('projectGit:changed', wrapped);
  },
  getSessionImage: (id: string, assetId: string) => call<string | null>('sessions:image', { id, assetId }),
  getImageStorage: () => call<ImageStorageInfo>('sessions:imageStorage'),
  clearImageStorage: (mode: ImageStorageClearMode) => call<ImageStorageClearResult>('sessions:clearImageStorage', { mode }),
    getSession: (id: string, options?: { from?: number; before?: number; after?: number; limit?: number }) =>
    call<SessionDetail>('sessions:events', { id, ...options }),
  stopSessionTurn: (id: string, expectedTurnId: string) => call<SessionControlsView>('sessions:stopTurn', { id, expectedTurnId }),
  releaseSessionFinish: (id: string, expectedTurnId: string) => call<SessionControlsView>('sessions:releaseFinish', { id, expectedTurnId }),
  generateFinishGoal: (id: string, expectedTurnId: string) => call<string>('sessions:generateFinishGoal', { id, expectedTurnId }),
  getChatModels: () => call<ChatModelCatalog>('chatModels:get'),
  browserPreferences: (patch: Partial<BrowserPreferences> = {}) => call<BrowserPreferences>('browser:preferences', patch),
  companionDiagnostics: () => call<CompanionDiagnostics | null>('bridge:diagnostics'),
  requestChatModels: () => call<ChatModelCatalog>('chatModels:request'),
  onToolApprovalNotice: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('setup:toolApprovalNotice', wrapped);
    return () => ipcRenderer.removeListener('setup:toolApprovalNotice', wrapped);
  },
  onChatModelsChanged: (listener: (catalog: ChatModelCatalog) => void): (() => void) => {
    const wrapped = (_event: unknown, catalog: ChatModelCatalog): void => listener(catalog);
    ipcRenderer.on('chatModels:changed', wrapped);
    return () => ipcRenderer.removeListener('chatModels:changed', wrapped);
  },
  getSessionControls: (id: string) => call<SessionControlsView>('sessions:controls', { id }),
  browserUse: (request: BrowserUseRequest) => call<BrowserUseState>('browserUse:panel', request),
  browserUseDesignContext: (tabId: number, selectionId: number) =>
    call<BrowserUseDesignContext>('browserUse:designContext', { tabId, selectionId }),
  browserUseLayout: (bounds: BrowserUseBounds): void => ipcRenderer.send('browserUse:layout', bounds),
  browserUseLayoutSync: (bounds: BrowserUseBounds): boolean => ipcRenderer.sendSync('browserUse:layoutSync', bounds) === true,
  onBrowserUseShowRequested: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('browserUse:showRequested', wrapped);
    return () => ipcRenderer.removeListener('browserUse:showRequested', wrapped);
  },
  onBrowserUseStateChanged: (listener: (state: BrowserUseState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: BrowserUseState): void => listener(state);
    ipcRenderer.on('browserUse:stateChanged', wrapped);
    return () => ipcRenderer.removeListener('browserUse:stateChanged', wrapped);
  },
  setSessionAutomation: (id: string, automation: SessionControlsView['automation'], afterTurn?: boolean) => call<SessionControlsView>('sessions:automation', { id, automation, afterTurn }),
  setSessionObjective: (id: string, text: string, mode: 'goal' | 'loop') => call<SessionControlsView>('sessions:objective', { id, text, mode }),
  compactSession: (id: string) => call<SessionControlsView>('sessions:compact', { id }),
  cancelSessionCompaction: (id: string) => call<SessionControlsView>('sessions:cancelCompaction', { id }),
  draftTaskPlan: (text: string, backend: 'api' | 'chatgpt', requestId?: string) => call<string[]>('sessions:plan', { text, backend, requestId }),
  sendInput: (input: InputArgs) => call<InputEntry>('sessions:send', input),
  retryInputBrowser: (id: string) => call<InputEntry | null>('sessions:retryBrowser', { id }),
  listInputs: () => call<InputEntry[]>('sessions:outbox'),
  listPausedHelpers: () => call<Array<{ id: string; sourceSessionId: string }>>('sessions:pausedHelpers'),
  retryHelper: (id: string, sourceSessionId: string) => call<boolean>('sessions:retryHelper', { id, sourceSessionId }),
  editQueuedInput: (id: string, text: string, afterTurn?: boolean) => call<boolean>('sessions:editInput', { id, text, afterTurn }),
  reorderQueuedInputs: (sessionId: string, ids: string[]) => call<boolean>('sessions:reorderInputs', { sessionId, ids }),
  cancelInput: (id: string) => call<boolean>('sessions:cancelInput', { id }),
  setInputAutomation: (id: string, mode: 'off' | 'goal' | 'loop', loopAfterTurn?: boolean) => call<boolean>('sessions:inputAutomation', { id, mode, loopAfterTurn }),
  setZoom: (factor: number) => call<number>('window:zoom', { factor }),
  getZoom: () => call<number>('window:getZoom'),
  toggleViewMenu: (request: ViewMenuToggleRequest) => call<ViewMenuToggleState>('viewMenu:toggle', request),
  onViewMenuOpenChanged: (listener: (open: boolean) => void): (() => void) => {
    const wrapped = (_event: unknown, open: boolean): void => listener(open === true);
    ipcRenderer.on('viewMenu:openChanged', wrapped);
    return () => ipcRenderer.removeListener('viewMenu:openChanged', wrapped);
  },
  onViewMenuCommand: (listener: (command: ViewMenuCommand) => void): (() => void) => {
    const wrapped = (_event: unknown, command: ViewMenuCommand): void => listener(command);
    ipcRenderer.on('viewMenu:command', wrapped);
    return () => ipcRenderer.removeListener('viewMenu:command', wrapped);
  },
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
  getSessionSwarm: (id: string) => call<SwarmState>('swarm:getForSession', { id }),
  resetSwarm: () => call<SwarmState>('swarm:reset'),
  // Clearing the prime ends the run; clearing a worker frees that slot. Which of the two
  // happened comes back in the result — the renderer does not decide it.
  clearAgent: (id: string, runId?: string) => call<ClearAgentResult>('swarm:clearAgent', { id, runId }),

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
  onWriteSession: (listener: (id: string) => void): (() => void) => {
    const wrapped = (_event: unknown, id: string): void => listener(id);
    ipcRenderer.on('session:write', wrapped);
    return () => ipcRenderer.removeListener('session:write', wrapped);
  },
  onTaskProgress: (listener: (progress: TaskProgress) => void): (() => void) => {
    const wrapped = (_event: unknown, progress: TaskProgress): void => listener(progress);
    ipcRenderer.on('task:progress', wrapped);
    return () => ipcRenderer.removeListener('task:progress', wrapped);
  },
  cancelTaskRequest: (requestId: string) => call<boolean>('tasks:cancel', { requestId }),
  draftGoalOpening: (text: string, mode: 'goal' | 'loop', requestId: string) =>
    call<{ reply: string; model: string }>('sessions:goalOpening', { text, mode, requestId }),
  onSwarmChanged: (listener: (state: SwarmState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: SwarmState): void => listener(state);
    ipcRenderer.on('swarm:changed', wrapped);
    return () => ipcRenderer.removeListener('swarm:changed', wrapped);
  }
};

export type AppApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
