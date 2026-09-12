import { applyLoginStartup, supportsLoginStartup } from './window-lifecycle.js';
import { prepareSessionPrompt } from './session/prompt.js';
import { noteChatOrigin } from './session/recorder.js';
import { REASONING_EFFORTS } from '../shared/session.js';
import { safeExternalLink } from '../shared/external-link.js';
import { wakeBrowserWork } from './browser-wake.js';
import { getChatModels, startChatModelDiscovery, configureChatModelDiscovery } from './chat-models.js';
import { releaseSessionFinish, requestSessionFinishGoal } from './session/finish.js';
import { GOAL_MARKER_INSTRUCTION } from '../shared/goal-templates.js';
import { validateInputImages } from './session/input-images.js';
import { stageInputAttachment, type AttachmentSource } from './session/input-attachments.js';
import { recordDeliveredInput, recordedInputImage } from './session/input-history.js';
import { UI_BASE_ZOOM, titleBarOverlayForTheme } from './window-layout.js';
import { usageOverview } from './session/usage.js';
import { inputArgs, listInputs, editQueuedInput, reorderQueuedInputs, setInputAutomation, configureInputDelivery, pausedBrowserHelpers, cancelFinishInputs } from './session/input.js';
import { draftOpeningMessage, onGoalChange, nativeGoalFailure } from './goal.js';
import { cancelTaskRequest, runTaskRequest } from './task-request.js';
import { randomUUID } from 'node:crypto';
import { retryGoalBrowserHelper } from './goal.js';
import { requestBrowserPreferences } from './browser-preferences.js';
import { sendDesktopInput, cancelDesktopInput, retryQueuedInputBrowser } from './session/start-input.js';
import { wakeBrowserUrl } from './browser-startup.js';
import { registerPluginIpc } from './plugins-ipc.js';
/**
 * IPC surface.
 *
 * A fixed list of named handlers, each validating its own input with zod. There is no
 * generic "call this method" or "read this file" channel, so a compromised renderer
 * gains only the operations listed below — it can never reach the filesystem or spawn
 * a process directly. Secrets travel one way: the renderer can set or clear the API
 * key but can never read it back.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { z } from 'zod';
import {
  CAPABILITIES,
  CHAT_BROWSERS,
  GOAL_MODES,
  GOAL_PROVIDERS,
  GOAL_REASONING_LEVELS,
  type AppState,
  type Config
} from '../shared/types.js';
import { MAX_GOAL_SYSTEM_PROMPT_CHARS } from '../shared/goal.js';
import { applySettings, connect, disconnect, getStatus, onStatusChange } from './connection.js';
import { effectiveCapabilities, getConfig, updateConfig, MAX_MCP_INSTRUCTIONS_CHARS } from './config.js';
import { clearAllGoalSwitches, draftTaskPlan, listGoalModels, MODEL_PAGE_SIZE, retireGoalDrafts, goalBackendFor, goalSwitchFor, setGoalSwitchNow, setGoalReplyActiveNow, setGoalObjectiveNow } from './goal.js';
import { forgetExposedSurface } from './mcp/server.js';
import { runDiagnostics } from './diagnostics.js';
import { formatLogAsJson, formatLogForClipboard, getLog, logInfo, onLog } from './logger.js';
import { RESERVED_ROOT_NAMES, uniqueRootName, validateNewRoot, SandboxError, resolvePath } from './sandbox.js';
import { addProject, listProjects, removeProject } from './projects.js';
import { hasSecret, isEncryptionAvailable, secureStorageStatus, setSecret } from './secrets.js';
import { bundledVersion, locateBinary } from './tunnel/locate.js';
import { TUNNEL_ID_PATTERN } from './tunnel/index.js';
import {
  bridgeStatus,
  sessionActivityExpiresAt,
  sessionInputActivity,
  sessionControlsFor, stopSessionTurn, setSessionAutomation, setSessionObjective, compactSession, cancelSessionCompaction,
  cancelWorkerCommands,
  chatUrl,
  onBridgeChange,
  startBridge,
  stopBridge,
  sweepStaleSwarm,
  unpair
} from './bridge.js';
import { extensionDir } from './extension-path.js';
import { extensionDownloadUrl } from './version.js';
import {
  deleteSession,
  getSession,
  listSessionPage,
  findSessionByConversation,
  readEvents,
  readRecentEvents,
  readHandoff
} from './session/store.js';
import { activeSessionId, forgetSession, onSessionChange } from './session/recorder.js';
import { blockedChatIds, setChatBlocked } from './session/blocked-chats.js';
import {
  clearAgent,
  primeForOwnedConversation,
  onSwarmChange,
  pauseSwarmForDisable,
  persistAgentAuthorityNow,
  resetSwarm,
  swarmState
} from './agents.js';
import { tokenPressure } from '../shared/session.js';
import { forgetWorkspaceRoot, renameWorkspaceRoot } from './workspace.js';
import { hostPlatformInfo } from './platform.js';
import { openInPreferredBrowser } from './browser.js';
import { markInstallOnQuit, onUpdateChange, updateStatus } from './update.js';
import {
  getMacOSDesktopAccess,
  onMacOSDesktopAccessChange,
  refreshMacOSDesktopAccess
} from './computer/index.js';

/** Fixed native Settings destinations; authored chat links use the shared web/mail policy. */
const ALLOWED_LINKS = new Set([
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
]);

const capabilityPatch = z.object(
  Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean()])) as Record<
    (typeof CAPABILITIES)[number],
    z.ZodBoolean
  >
);

const settingsPatch = z.object({
  capabilities: capabilityPatch,
  readOnly: z.boolean(),
  tunnel: z.object({
    pluginsTunnelId: z.string().max(128).refine(v => v === '' || TUNNEL_ID_PATTERN.test(v), 'Expected tunnel_ followed by 32 hex characters').optional(),
    kind: z.enum(['openai', 'cloudflared', 'manual']),
    tunnelId: z
      .string()
      .max(128)
      .refine((v) => v === '' || TUNNEL_ID_PATTERN.test(v), 'Expected tunnel_ followed by 32 hex characters'),
    // The Desktop connector's own tunnel. Empty is normal and means "not published":
    // Desktop is optional, and most users will never create a second Secure Tunnel.
    desktopTunnelId: z
      .string()
      .max(128)
      .refine((v) => v === '' || TUNNEL_ID_PATTERN.test(v), 'Expected tunnel_ followed by 32 hex characters'),
    binaryPath: z.string().max(4096)
  }),
  ui: z.object({
    chatBrowser: z.enum(CHAT_BROWSERS).optional(),
    developerMode: z.boolean().optional(),
    finishTool: z.boolean().optional(),
    planBackend: z.enum(['chatgpt', 'api']).optional(),
    finishAction: z.enum(['notify', 'goal']).optional(),
    finishLeadMinutes: z.number().int().min(3).max(5).optional(),
    backgroundChats: z.boolean().optional(),
    browserOnly: z.boolean().optional(),
    autoRefreshPlugins: z.boolean().optional(),
    tabsToKeepOpen: z.number().int().min(1).max(50).optional(),
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
    startAtLogin: z.boolean().optional(),
    privacyScreenshots: z.boolean(),
    theme: z.enum(['light', 'dark'])
  }),
  sessions: z.object({
    record: z.boolean(),
    retainDays: z.number().int().min(0).max(3650),
    advisoryTokens: z.number().int().min(10_000).max(4_000_000),
    limitTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  compaction: z.object({
    auto: z.boolean(),
    // Floored well above what a fresh chat holds, so a threshold cannot be set somewhere
    // every conversation is already past the moment it opens.
    autoTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  multiAgent: z.object({
    enabled: z.boolean(),
    defaultModel: z.string().max(80).optional(),
    defaultReasoning: z.enum(['', ...REASONING_EFFORTS]).optional(),
    maxWorkers: z.number().int().min(1).max(8),
    allowUnattributedCalls: z.boolean(),
    recoverAgentTabs: z.boolean()
  }),
  mcp: z.object({ instructions: z.string().trim().max(MAX_MCP_INSTRUCTIONS_CHARS) }).strict().optional(),
  goal: z.object({
    impulseMinutes: z.number().int().min(0).max(60).optional(),
    includeToolCalls: z.boolean().optional(),
      backend: z.enum(['api', 'chatgpt', 'templates']).optional(),
      loopBackend: z.enum(['api', 'chatgpt']).optional(),
      helperModel: z.string().trim().min(1).max(80).optional(),
      helperReasoning: z.enum(REASONING_EFFORTS).optional(),
    enabled: z.boolean(),
    // Which of the two standing modes the switch runs. One field, so the renderer has no way
    // to describe a state where Goal and Loop are both on.
    mode: z.enum(GOAL_MODES),
    // Which LLM endpoint Goal/Loop drafts run on, plus the custom endpoint's base URL.
    // The URL is stored verbatim and validated at draft time (see resolveGoalBaseUrl):
    // a shape check here would either duplicate that logic or silently rewrite the address.
    provider: z.object({
      kind: z.enum(GOAL_PROVIDERS),
      baseUrl: z.string().max(2048)
    }),
    // An OpenRouter model id while the provider is openrouter, validated only as a shape:
    // the catalogue changes weekly, and an allow-list here would mean this app deciding
    // which models exist.
    // The leading `~` is OpenRouter's own marker for an alias that always resolves to the
    // newest model in a family — `~deepseek/deepseek-v4-flash-latest` and eleven others. The
    // picker lists them because the listing does, so refusing them here meant the one kind
    // of entry most worth choosing was the one kind that could not be saved.
    // A custom endpoint names its own models (`llama3.1`, a deployment id), so while custom
    // it is any non-empty id instead.
    model: z.string().min(1).max(160),
    reasoning: z.enum(GOAL_REASONING_LEVELS),
    prompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    objectivePrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    loopPrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
  }).superRefine((goal, ctx) => {
    if (goal.provider.kind !== 'custom' && !/^~?[a-z0-9._-]+\/[a-z0-9._-]+(:[a-z0-9._-]+)?$/i.test(goal.model)) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'Expected an OpenRouter model id like vendor/model'
      });
    }
  })
});

const settingsSave = z.object({ base: settingsPatch, patch: settingsPatch }).strict();
type SettingsSnapshot = z.infer<typeof settingsPatch>;

/**
 * Three-way merge for the renderer's settings form.
 *
 * The Chrome extension is a second writer for Goal/Auto Compact. The renderer previously sent
 * a blind full snapshot for every checkbox/theme edit, so a snapshot captured just before an
 * extension write could land just after it and silently undo that newer value. A field which is
 * unchanged between `base` and `wanted` was not edited by this renderer save and therefore keeps
 * the current main-process value. A field that differs was deliberately edited here and wins.
 */
function mergeSettings(current: Config, base: SettingsSnapshot, wanted: SettingsSnapshot): SettingsSnapshot {
  const pick = <T>(live: T, before: T, next: T): T => (Object.is(before, next) ? live : next);
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      pick(current.capabilities[capability], base.capabilities[capability], wanted.capabilities[capability])
    ])
  ) as Config['capabilities'];
  return {
    mcp: wanted.mcp ? { instructions: pick(current.mcp.instructions, base.mcp?.instructions ?? '', wanted.mcp.instructions) } : current.mcp,
    capabilities,
    readOnly: pick(current.readOnly, base.readOnly, wanted.readOnly),
    tunnel: {
        pluginsTunnelId: wanted.tunnel.pluginsTunnelId === undefined ? current.tunnel.pluginsTunnelId ?? ''
          : pick(current.tunnel.pluginsTunnelId ?? '', base.tunnel.pluginsTunnelId ?? '', wanted.tunnel.pluginsTunnelId),
      kind: pick(current.tunnel.kind, base.tunnel.kind, wanted.tunnel.kind),
      tunnelId: pick(current.tunnel.tunnelId, base.tunnel.tunnelId, wanted.tunnel.tunnelId),
      desktopTunnelId: pick(
        current.tunnel.desktopTunnelId,
        base.tunnel.desktopTunnelId,
        wanted.tunnel.desktopTunnelId
      ),
      binaryPath: pick(current.tunnel.binaryPath, base.tunnel.binaryPath, wanted.tunnel.binaryPath)
    },
    ui: {
      chatBrowser: pick(current.ui.chatBrowser, base.ui.chatBrowser, wanted.ui.chatBrowser),
      developerMode: pick(current.ui.developerMode, base.ui.developerMode, wanted.ui.developerMode),
      finishTool: pick(current.ui.finishTool, base.ui.finishTool, wanted.ui.finishTool),
      planBackend: pick(current.ui.planBackend, base.ui.planBackend, wanted.ui.planBackend),
      finishAction: pick(current.ui.finishAction, base.ui.finishAction, wanted.ui.finishAction),
      finishLeadMinutes: pick(current.ui.finishLeadMinutes, base.ui.finishLeadMinutes, wanted.ui.finishLeadMinutes),
      backgroundChats: pick(current.ui.backgroundChats, base.ui.backgroundChats, wanted.ui.backgroundChats),
      browserOnly: pick(current.ui.browserOnly, base.ui.browserOnly, wanted.ui.browserOnly),
      autoRefreshPlugins: pick(current.ui.autoRefreshPlugins, base.ui.autoRefreshPlugins, wanted.ui.autoRefreshPlugins),
      tabsToKeepOpen: pick(current.ui.tabsToKeepOpen, base.ui.tabsToKeepOpen, wanted.ui.tabsToKeepOpen),
      minimizeToTray: pick(current.ui.minimizeToTray, base.ui.minimizeToTray, wanted.ui.minimizeToTray),
      autoConnect: pick(current.ui.autoConnect, base.ui.autoConnect, wanted.ui.autoConnect),
      startAtLogin: pick(current.ui.startAtLogin, base.ui.startAtLogin, wanted.ui.startAtLogin),
      privacyScreenshots: pick(
        current.ui.privacyScreenshots,
        base.ui.privacyScreenshots,
        wanted.ui.privacyScreenshots
      ),
      theme: pick(current.ui.theme, base.ui.theme, wanted.ui.theme)
    },
    sessions: {
      record: pick(current.sessions.record, base.sessions.record, wanted.sessions.record),
      retainDays: pick(current.sessions.retainDays, base.sessions.retainDays, wanted.sessions.retainDays),
      advisoryTokens: pick(
        current.sessions.advisoryTokens,
        base.sessions.advisoryTokens,
        wanted.sessions.advisoryTokens
      ),
      limitTokens: pick(current.sessions.limitTokens, base.sessions.limitTokens, wanted.sessions.limitTokens)
    },
    compaction: {
      auto: pick(current.compaction.auto, base.compaction.auto, wanted.compaction.auto),
      autoTokens: pick(current.compaction.autoTokens, base.compaction.autoTokens, wanted.compaction.autoTokens)
    },
    multiAgent: {
      defaultModel: pick(current.multiAgent.defaultModel, base.multiAgent.defaultModel, wanted.multiAgent.defaultModel),
      defaultReasoning: pick(current.multiAgent.defaultReasoning, base.multiAgent.defaultReasoning, wanted.multiAgent.defaultReasoning),
      enabled: pick(current.multiAgent.enabled, base.multiAgent.enabled, wanted.multiAgent.enabled),
      maxWorkers: pick(current.multiAgent.maxWorkers, base.multiAgent.maxWorkers, wanted.multiAgent.maxWorkers),
      allowUnattributedCalls: pick(
        current.multiAgent.allowUnattributedCalls,
        base.multiAgent.allowUnattributedCalls,
        wanted.multiAgent.allowUnattributedCalls
      ),
      recoverAgentTabs: pick(
        current.multiAgent.recoverAgentTabs,
        base.multiAgent.recoverAgentTabs,
        wanted.multiAgent.recoverAgentTabs
      )
    },
    goal: {
      impulseMinutes: pick(current.goal.impulseMinutes, base.goal.impulseMinutes, wanted.goal.impulseMinutes),
      includeToolCalls: pick(current.goal.includeToolCalls, base.goal.includeToolCalls, wanted.goal.includeToolCalls),
      backend: pick(current.goal.backend, base.goal.backend, wanted.goal.backend),
      loopBackend: pick(current.goal.loopBackend, base.goal.loopBackend, wanted.goal.loopBackend),
      helperModel: pick(current.goal.helperModel, base.goal.helperModel, wanted.goal.helperModel),
      helperReasoning: pick(current.goal.helperReasoning, base.goal.helperReasoning, wanted.goal.helperReasoning),
      enabled: pick(current.goal.enabled, base.goal.enabled, wanted.goal.enabled),
      mode: pick(current.goal.mode, base.goal.mode, wanted.goal.mode),
      provider: {
        kind: pick(current.goal.provider.kind, base.goal.provider.kind, wanted.goal.provider.kind),
        baseUrl: pick(current.goal.provider.baseUrl, base.goal.provider.baseUrl, wanted.goal.provider.baseUrl)
      },
      model: pick(current.goal.model, base.goal.model, wanted.goal.model),
      reasoning: pick(current.goal.reasoning, base.goal.reasoning, wanted.goal.reasoning),
      prompt: pick(current.goal.prompt, base.goal.prompt, wanted.goal.prompt),
      objectivePrompt: pick(
        current.goal.objectivePrompt,
        base.goal.objectivePrompt,
        wanted.goal.objectivePrompt
      ),
      loopPrompt: pick(current.goal.loopPrompt, base.goal.loopPrompt, wanted.goal.loopPrompt)
    }
  };
}

const sessionIdArg = z.object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i) });
const agentIdArg = z.string().min(1).max(64).regex(/^[0-9a-z-]+$/i);

const renameRoot = z.object({
  name: z.string().min(1).max(32),
  newName: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Lowercase letters, digits, dot, dash and underscore only')
});

function resolvedBinary(config: Config): string | null {
  if (config.tunnel.kind === 'cloudflared') return locateBinary('cloudflared', config.tunnel.binaryPath);
  if (config.tunnel.kind === 'openai') return locateBinary('tunnel-client', config.tunnel.binaryPath);
  return null;
}

async function buildState(): Promise<AppState> {
  const config = getConfig();
  return {
    config,
    status: getStatus(),
    platform: hostPlatformInfo(),
    loginStartupAvailable: supportsLoginStartup(process.platform, app.isPackaged),
    secureStorage: await secureStorageStatus(),
    hasApiKey: await hasSecret('openaiApiKey'),
    hasGoalKey: await hasSecret('openRouterApiKey'),
    hasCustomProviderKey: await hasSecret('customProviderApiKey'),
    resolvedBinary: resolvedBinary(config),
    bundledTunnelVersion: bundledVersion(),
    bridge: await bridgeStatus(),
    update: updateStatus(),
    desktopAccess: getMacOSDesktopAccess()
  };
}

/** Wraps a handler so a thrown error becomes a message the UI can show. */
function handle<T>(channel: string, fn: (payload: unknown) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    try {
      return { ok: true as const, data: await fn(payload) };
    } catch (err) {
      const message =
        err instanceof SandboxError || err instanceof z.ZodError
          ? err instanceof z.ZodError
            ? (err.issues[0]?.message ?? 'Invalid input')
            : err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false as const, error: message };
    }
  });
}

export function registerIpc(getWindow: () => BrowserWindow | null, quitToInstall: () => void): void {
  registerPluginIpc(handle, getWindow);
  handle('usage:get', () => usageOverview());
  handle('state:get', async () => {
    const state = await buildState();
    // Native package smoke uses this as the end-to-end renderer readiness barrier. Unlike
    // `did-finish-load`, it can only happen after the renderer's first IPC request has completed
    // secure-storage availability/decryption probes and the rest of the initial state snapshot.
    logInfo('renderer state ready');
    return state;
  });

  handle('settings:save', async (payload) => {
    const request = settingsSave.parse(payload);
    const before = getConfig();
    const next = await updateConfig(async config => {
      const proposed = { ...config, ...mergeSettings(config, request.base, request.patch) };
      // If an earlier Off retirement failed, On must retry it before admission.
      if (!config.ui.finishTool && proposed.ui.finishTool) await cancelFinishInputs(false);
      else if (!config.goal.impulseMinutes && (proposed.goal.impulseMinutes ?? 0) > 0) await cancelFinishInputs(true);
      return proposed;
    }, async (published, previous) => {
      if (previous.ui.finishTool && !published.ui.finishTool) await cancelFinishInputs(false);
      else if ((previous.goal.impulseMinutes ?? 0) > 0 && !published.goal.impulseMinutes) await cancelFinishInputs(true);
    });
    // Renderer palette changes are immediate, so keep OS/Electron-owned chrome in lock-step too.
    // Without this, selecting Dark on macOS left the title bar, menus and file picker in the
    // system theme until restart (and startup still defaulted to system before index.ts applies it).
    nativeTheme.themeSource = next.ui.theme;
    if (process.platform === 'win32') getWindow()?.setTitleBarOverlay(titleBarOverlayForTheme(next.ui.theme));
    // BrowserWindow's native backing color is fixed at construction unless updated explicitly.
    // Keep it in lock-step too: the default macOS application menu exposes Reload, and after a
    // live theme switch an old opposite background otherwise flashes behind the renderer while it
    // paints again. This is also the color Electron shows during any later renderer reload/failure.
    getWindow()?.setBackgroundColor(next.ui.theme === 'dark' ? '#0e0e11' : '#ffffff');
    if (
      before.goal.enabled !== next.goal.enabled ||
      // The mode is authority too: a draft started as a gate must not be typed after the user
      // asked for a loop, and a loop draft must not be typed after they asked for a gate.
      before.goal.mode !== next.goal.mode ||
      before.goal.model !== next.goal.model ||
      before.goal.backend !== next.goal.backend ||
      before.goal.loopBackend !== next.goal.loopBackend ||
      before.goal.helperModel !== next.goal.helperModel || before.goal.helperReasoning !== next.goal.helperReasoning ||
      before.goal.provider.kind !== next.goal.provider.kind ||
      before.goal.provider.baseUrl !== next.goal.provider.baseUrl ||
      before.goal.reasoning !== next.goal.reasoning ||
      before.goal.includeToolCalls !== next.goal.includeToolCalls ||
      before.goal.prompt !== next.goal.prompt ||
      before.goal.objectivePrompt !== next.goal.objectivePrompt ||
      before.goal.loopPrompt !== next.goal.loopPrompt
    ) {
      retireGoalDrafts();
    }
    // The app-wide switch going off is the master stop, and has to actually stop things. Chats
    // carry their own Goal/Loop answer now, so without this the one control that looks like it
    // governs everything would govern only the chats that never disagreed with it — and a loop
    // somebody wanted stopped would go on running with nowhere obvious to switch it off.
    // Turning it *on* deliberately does not reach into a chat that has said no.
    if (before.goal.enabled && !next.goal.enabled) clearAllGoalSwitches();
    // Explicit settings changes replace discovery's monotonic snapshot. Otherwise
    // disabled permissions/finish/session tools remain published and no schema change
    // reaches automatic plugin refresh. Cosmetic saves must not invalidate discovery.
    if (before.multiAgent.enabled !== next.multiAgent.enabled || before.sessions.record !== next.sessions.record ||
        before.ui.finishTool !== next.ui.finishTool ||
        JSON.stringify(effectiveCapabilities(before)) !== JSON.stringify(effectiveCapabilities(next))) forgetExposedSurface();
    // Order matters, and it used to be wrong. Pausing the run and withdrawing worker browser
    // commands has to happen while the bridge can still cancel those transports; stopping the
    // bridge first left queued worker/revival commands behind for a later restart to deliver.
    let authorityPersistError: Error | null = null;
    if (!next.multiAgent.enabled) {
      // Off pauses execution; it is not the destructive Clear swarm action. Preserve every
      // prime-owned worker history so re-enable/restart can still show and revive exact chats.
      pauseSwarmForDisable();
      cancelWorkerCommands('multi-agent mode was turned off');
      try {
        if (!(await persistAgentAuthorityNow())) {
          throw new Error('Multi-agent teardown has no immediate durable persistence sink.');
        }
      } catch (error) {
        authorityPersistError = error instanceof Error ? error : new Error(String(error));
      }
    }
    // The extension bridge serves both features: recording needs it to observe the
    // chat, and multi-agent mode needs it to open worker tabs. Either one being on is
    // enough, and this must match the startup rule in index.ts exactly — a bridge that
    // runs at startup but not after a settings save is the worst of both.
    if (next.sessions.record || next.multiAgent.enabled) await startBridge();
    else await stopBridge();
    // Permissions and the second tunnel id both decide whether the optional Desktop
    // connector should be published. Without this, enabling desktop access or pasting its
    // tunnel id left the connector unpublished until the user happened to reconnect, with
    // the card still saying "not published" and nothing explaining why.
    await applySettings();
    if (before.ui.autoRefreshPlugins !== next.ui.autoRefreshPlugins) wakeBrowserWork();
    logInfo('settings updated');
    // The config and runtime side effects above still complete so the app does not stay half-on,
    // but the UI must not be told the pause was safely accepted when its retained authority
    // snapshot failed to cross disk. Startup with the feature off restores and canonicalizes
    // that same history instead of deleting it.
    // Login registration is an independent OS preference. Cosmetic saves do not rewrite
    // it, and its failure cannot interrupt permission publication or Goal/worker teardown.
    let loginStartupError: unknown;
    if ((before.ui.startAtLogin === true) !== (next.ui.startAtLogin === true)) {
      try { applyLoginStartup(app, next.ui.startAtLogin === true); }
      catch (error) { loginStartupError = error; }
    }
    if (authorityPersistError) throw authorityPersistError;
    if (loginStartupError) throw loginStartupError;
    return buildState();
  });

  /** Approves one folder by path. The picker dialog and the drop zone both end here. */
  const approveRoot = async (folderPath: string): Promise<AppState> => {
    let addedName = '';
    await updateConfig(async (config) => {
      const real = await validateNewRoot(folderPath, config.roots);
      const name = uniqueRootName(real, config.roots);
      addedName = name;
      return { ...config, roots: [...config.roots, { name, path: real }] };
    });
    logInfo(`approved folder /${addedName}`);
    return buildState();
  };

  handle('roots:add', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Approve a folder for ChatGPT',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return buildState();
    return approveRoot(result.filePaths[0]);
  });

  handle('projects:list', () => listProjects());
  handle('projects:remove', async (payload) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(payload);
    const project = await removeProject(id);
    push('session:changed');
    return project;
  });
  handle('projects:add', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, { title: 'Choose a project folder for ChatGPT', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const folder = result.filePaths[0];
    try { await resolvePath(getConfig().roots, folder); }
    catch (error) {
      if (!(error instanceof SandboxError)) throw error;
      const state = await approveRoot(folder);
      push('state:changed', state);
    }
    const project = await addProject(folder);
    push('session:changed');
    return project;
  });

  // A folder dropped onto the Folders card. The renderer never sees a system path itself:
  // the preload turns the dropped File into one, and the same validation the dialog goes
  // through decides whether it is a folder this app may approve at all.
  handle('roots:addPath', async (payload) => {
    const { path: folderPath } = z.object({ path: z.string().min(1).max(4096) }).parse(payload);
    return approveRoot(folderPath);
  });

  handle('roots:remove', async (payload) => {
    const { name } = z.object({ name: z.string().min(1).max(32) }).parse(payload);
    await updateConfig((config) => {
      if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
      return {
        ...config,
        roots: config.roots.filter((r) => r.name !== name)
      };
    });
    forgetWorkspaceRoot(name);
    logInfo(`removed folder /${name}`);
    return buildState();
  });

  handle('roots:rename', async (payload) => {
    const { name, newName } = renameRoot.parse(payload);
    if (RESERVED_ROOT_NAMES.has(newName)) {
      throw new SandboxError(`/${newName} is reserved by Chat On Steroids and cannot be used as a folder name`);
    }
    await updateConfig((config) => {
      if (!config.roots.some((root) => root.name === name)) throw new Error(`/${name} is not an approved folder`);
      if (config.roots.some((r) => r.name !== name && r.name === newName)) {
        throw new Error(`/${newName} is already used`);
      }
      return {
        ...config,
        roots: config.roots.map((r) => (r.name === name ? { ...r, name: newName } : r))
      };
    });
    renameWorkspaceRoot(name, newName);
    return buildState();
  });

  /**
   * Stores one of the defined provider keys by name.
   *
   * The name is an enum rather than a string, so the renderer can choose *which* credential
   * it is writing but cannot name a slot nobody defined — and the value still only ever
   * travels inwards. Nothing reads a key back out over IPC; the state carries a boolean.
   */
  handle('secret:set', async (payload) => {
    const { value, key } = z
      .object({
        value: z.string().max(500),
        key: z.enum(['openaiApiKey', 'openRouterApiKey', 'customProviderApiKey']).default('openaiApiKey')
      })
      .parse(payload);
    if (!(await isEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable, so the key cannot be stored safely.');
    }
    await setSecret(key, value);
    const activeGoalKey = getConfig().goal.provider.kind === 'custom' ? 'customProviderApiKey' : 'openRouterApiKey';
    if (key === activeGoalKey) retireGoalDrafts();
    const what = key === 'openRouterApiKey' ? 'openrouter key' : key === 'customProviderApiKey' ? 'custom provider key' : 'api key';
    logInfo(value.trim() === '' ? `${what} cleared` : `${what} stored`);
    return buildState();
  });

  /**
   * The OpenRouter catalogue, newest first, one page at a time.
   *
   * Fetched here rather than in the renderer for the same reason every other network call
   * is: the key that authorises it never crosses this boundary. The page size is the
   * module's own, so the renderer cannot ask for the whole catalogue in one call.
   */
  handle('goal:models', async (payload) => {
    const { offset } = z.object({ offset: z.number().int().min(0).max(2000).default(0) }).parse(payload ?? {});
    return listGoalModels(offset, MODEL_PAGE_SIZE);
  });

  handle('binary:pick', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Select the tunnel executable',
      properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'Programs', extensions: ['exe'] }] } : {})
    });
    if (result.canceled || !result.filePaths[0]) return buildState();
    await updateConfig((config) => ({
      ...config,
      tunnel: { ...config.tunnel, binaryPath: result.filePaths[0]! }
    }));
    // This is a Core transport setting just like changing the method/tunnel id in the form.
    // Apply it immediately when connected rather than saving a path the running child never
    // uses until some unrelated future reconnect.
    await applySettings();
    return buildState();
  });

  handle('connection:connect', async () => {
    await connect();
    return buildState();
  });

  handle('connection:disconnect', async () => {
    await disconnect();
    return buildState();
  });

  handle('diagnostics:run', async () => runDiagnostics());
  handle('desktop:requestAccessibility', async () => {
    await refreshMacOSDesktopAccess({ promptAccessibility: true });
    return buildState();
  });

  handle('log:get', async () => getLog());
  handle('log:text', async () => formatLogForClipboard());
  handle('log:json', async () => formatLogAsJson());
  handle('clipboard:write', async (payload) => {
    const { text } = z.object({ text: z.string().max(1_000_000) }).parse(payload);
    clipboard.writeText(text);
    return true;
  });

  // The Install button. The renderer decides nothing about what is installed - it cannot
  // name a file, a version or a path - it only says "now", and only a staged, digest-checked
  // artifact makes that mean anything. The quit is what applies it, at the end of the same
  // shutdown sequence every other quit runs; refusing here is how a press with nothing staged
  // avoids closing the app for no reason.
  handle('update:install', async () => {
    if (!markInstallOnQuit()) throw new Error('There is no downloaded update to install yet');
    logInfo('update: install requested; quitting to hand the update over');
    quitToInstall();
    return true;
  });

  handle('link:open', async (payload) => {
    const { url } = z.object({ url: z.string().max(8192) }).parse(payload);
    if (!ALLOWED_LINKS.has(url) && !safeExternalLink(url)) throw new Error('That link is not allowed');
    await shell.openExternal(url);
    return true;
  });

  // ------------------------------------------------------------- sessions

  handle('sessions:list', async (payload) => {
    const { cursor, limit } = z
      .object({
        cursor: z
          .object({
            updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)
          })
          .optional(),
        // Keep one renderer payload small even when the store can index much more history.
        limit: z.number().int().min(1).max(60).optional()
      })
      .parse(payload ?? {});
    const config = getConfig();
    await listInputs(); // Restore exact helper origins before the first sidebar page.
    const page = await listSessionPage({ cursor, limit: limit ?? 60 });
    // Older recordings omitted worker origins' parent IDs. The broker's exact
    // retained owner can repair that presentation without reviving a worker or
    // guessing from reusable names such as worker-1.
    const parents = new Map<string, ReturnType<typeof findSessionByConversation>>();
    const sessions = await Promise.all(page.sessions.map(async (summary) => {
      if (summary.origin?.kind !== 'worker' || summary.origin.fromSessionId || !summary.conversationId) return summary;
      const prime = primeForOwnedConversation(summary.conversationId);
      if (!prime || prime === summary.conversationId) return summary;
      if (!parents.has(prime)) parents.set(prime, findSessionByConversation(prime, { requireUnique: true }));
      const parent = await parents.get(prime);
      return parent && parent.id !== summary.id ? { ...summary, origin: { ...summary.origin, fromSessionId: parent.id } } : summary;
    }));
    return {
      sessions: sessions.map(summary => {
        const activityExpiresAt = sessionActivityExpiresAt(summary);
        return activityExpiresAt === undefined ? summary : { ...summary, activityExpiresAt };
      }),
      total: page.total,
      nextCursor: page.nextCursor,
      activeId: activeSessionId(),
      // Live policy, not session history: a block is keyed by ChatGPT conversation and does
      // not belong in any session's meta.json. It rides the list for the same reason
      // `activeId` and `pressure` do — one paint, one round trip.
      blocked: blockedChatIds(),
      pressure: sessions.map((summary) => ({
        id: summary.id,
        // Pressure belongs to the currently attached ChatGPT context. `estimatedTokens` is
        // deliberately lifetime history and therefore never resets across Compact & Resume;
        // using it here made a fresh B look fuller than the A it had just replaced.
        ...tokenPressure(summary.contextTokens, config.sessions.advisoryTokens, config.sessions.limitTokens)
      }))
    };
  });

  handle('sessions:image', async (payload) => {
    const { id, assetId } = z.object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i), assetId: z.string().max(100).regex(/^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/) }).parse(payload);
    return recordedInputImage(id, assetId);
  });
  handle('sessions:events', async (payload) => {
    const { id, from, before, limit } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        from: z.number().int().min(0).max(10_000_000).optional(),
        before: z.number().int().min(1).max(10_000_000).optional(),
        limit: z.number().int().min(1).max(1000).optional()
      })
      .parse(payload);
    const summary = await getSession(id);
    if (!summary) throw new Error('Session not found');
    // The renderer draws a timeline, not the whole log: the tail is what matters and
    // the rest stays one click away rather than being pushed over IPC every refresh.
    // The renderer never paints more than 160 rows. Sending nearly twice that on every first
    // load was pure cloning/IPC work; later refreshes use the sequence cursor below.
    const cap = limit ?? 160;
    if (from === undefined) {
      const events = await readRecentEvents(id, cap, { before });
      const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0);
      return { summary, events, total: summary.events, nextFrom };
    }
    const events = await readEvents(id, { from, limit: cap });
    const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), from);
    return { summary, events, total: summary.events, nextFrom };
  });

  const stageFiles = async (sources: AttachmentSource[]) => {
    const retained = new Set((await listInputs()).filter(row => !['sent', 'failed', 'cancelled'].includes(row.state)).flatMap(row => row.attachments?.map(file => file.id) ?? []));
    const result = [];
    for (const source of sources) result.push(await stageInputAttachment(source, retained));
    return result;
  };
  handle('sessions:files', async () => {
    const chosen = await dialog.showOpenDialog({ title: 'Attach files', properties: ['openFile', 'multiSelections'] });
    if (chosen.canceled) return [];
    if (chosen.filePaths.length > 20) throw new Error('Attach up to 20 files per message');
    return stageFiles(chosen.filePaths);
  });
  handle('sessions:dropFiles', async payload => {
    const { files } = z.object({ files: z.array(z.union([
      z.string().min(1).max(32768),
      z.object({ name: z.string().min(1).max(255), bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= 12 * 1024 * 1024) }).strict()
    ])).min(1).max(20) }).strict().parse(payload);
    return stageFiles(files);
  });
  handle('sessions:attachText', async payload => {
    const { text } = z.object({ text: z.string().min(1).max(4 * 1024 * 1024) }).parse(payload);
    return (await stageFiles([{ text }]))[0]!;
  });
  handle('sessions:stopTurn', async payload => {
    const { id, expectedTurnId } = sessionIdArg.extend({ expectedTurnId: z.string().min(1).max(256) }).parse(payload);
    return stopSessionTurn(id, expectedTurnId);
  });
  handle('sessions:releaseFinish', async (payload) => {
    const { id, expectedTurnId } = sessionIdArg.extend({ expectedTurnId: z.string().min(1).max(256) }).parse(payload);
    await sessionControlsFor(id);
    await releaseSessionFinish(id, expectedTurnId);
    return sessionControlsFor(id);
  });
  handle('sessions:generateFinishGoal', async payload => {
    const { id, expectedTurnId } = sessionIdArg.extend({ expectedTurnId: z.string().min(1).max(256) }).parse(payload);
    return requestSessionFinishGoal(id, expectedTurnId);
  });
  handle('chatModels:get', async () => getChatModels());
  handle('browser:preferences', async (payload) => requestBrowserPreferences(payload));
  handle('chatModels:request', async () => startChatModelDiscovery());
  handle('sessions:controls', async (payload) => sessionControlsFor(sessionIdArg.parse(payload).id));
  handle('sessions:automation', async (payload) => {
    const { id, automation, afterTurn } = sessionIdArg.extend({ automation: z.enum(['off', 'goal', 'loop']), afterTurn: z.boolean().optional() }).parse(payload);
    return setSessionAutomation(id, automation, afterTurn);
  });
  handle('sessions:objective', async (payload) => {
    const { id, text, mode } = sessionIdArg.extend({ text: z.string().max(16000), mode: z.enum(['goal', 'loop']) }).parse(payload);
    return setSessionObjective(id, text, mode);
  });
  handle('sessions:compact', async (payload) => compactSession(sessionIdArg.parse(payload).id));
  handle('sessions:cancelCompaction', async (payload) => cancelSessionCompaction(sessionIdArg.parse(payload).id));
  handle('sessions:plan', async (payload) => {
    const { text, backend, requestId } = z.object({ text: z.string().trim().min(1).max(16000), backend: z.enum(['api', 'chatgpt']), requestId: z.string().uuid().optional() }).parse(payload);
    const publish = (progress: import('../shared/task-progress.js').TaskProgressUpdate) => {
      const target = getWindow();
      if (requestId && target && !target.isDestroyed()) target.webContents.send('task:progress', { requestId, ...progress });
    };
    return runTaskRequest(requestId ?? randomUUID(), JSON.stringify(['plan', text, backend]), signal => draftTaskPlan(text, backend, publish, signal), publish);
  });
  handle('sessions:send', async (payload) => {
    const input = inputArgs.parse(payload);
    await validateInputImages(input.images ?? []);
    return sendDesktopInput(input);
  });
  handle('sessions:outbox', async () => (await listInputs()).filter((row) => row.purpose !== 'decision'));
  handle('sessions:reorderInputs', async (payload) => {
    const { sessionId, ids } = z.object({ sessionId: z.string().min(8).max(64), ids: z.array(z.string().uuid()).min(1).max(10000) }).parse(payload);
    return reorderQueuedInputs(sessionId, ids);
  });
  handle('sessions:retryBrowser', async (payload) => retryQueuedInputBrowser(z.object({ id: z.string().uuid() }).parse(payload).id));
  handle('sessions:pausedHelpers', async () => pausedBrowserHelpers());
  handle('sessions:retryHelper', async (payload) => {
    const { id, sourceSessionId } = z.object({ id: z.string().uuid(), sourceSessionId: z.string().min(8).max(64) }).parse(payload);
    return retryGoalBrowserHelper(sourceSessionId, id);
  });
  handle('sessions:editInput', async (payload) => { const { id, text, afterTurn } = z.object({ id: z.string().uuid(), text: inputArgs.shape.text, afterTurn: z.boolean().optional() }).parse(payload); return editQueuedInput(id, text, afterTurn); });
  handle('sessions:cancelInput', async (payload) => cancelDesktopInput(z.object({ id: z.string().uuid() }).parse(payload).id));
  handle('sessions:inputAutomation', async payload => {
    const { id, mode } = z.object({ id: z.string().uuid(), mode: z.enum(['off', 'goal', 'loop']) }).parse(payload);
    return setInputAutomation(id, mode);
  });
  handle('window:getZoom', async () => (getWindow()?.webContents.getZoomFactor() ?? UI_BASE_ZOOM) / UI_BASE_ZOOM);
  handle('window:zoom', async (payload) => {
    const { factor } = z.object({ factor: z.number().min(0.75).max(1.5) }).parse(payload);
    getWindow()?.webContents.setZoomFactor(factor * UI_BASE_ZOOM);
    return factor;
  });

  handle('sessions:openChat', async (payload) => {
    const { id } = sessionIdArg.parse(payload);
    const summary = await getSession(id);
    const conversationId = summary?.conversationId;
    if (!conversationId || !/^[0-9a-z-]{8,64}$/i.test(conversationId)) {
      throw new Error('This session has no valid ChatGPT conversation');
    }
    await openInPreferredBrowser(chatUrl(conversationId));
    return true;
  });

  /**
   * Blocks or releases the ChatGPT conversation this session is attached to.
   *
   * The renderer names a session, never a conversation, for the same reason `sessions:openChat`
   * does: the stored conversation id is re-read and validated here, so a renderer-supplied id
   * can neither invent a conversation nor block one it is not looking at. A session with no
   * conversation has no rogue turn to stop and is refused rather than silently ignored.
   */
  handle('sessions:block', async (payload) => {
    const { id, blocked } = z
      .object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i), blocked: z.boolean() })
      .parse(payload);
    const summary = await getSession(id);
    const conversationId = summary?.conversationId;
    if (!conversationId || !/^[0-9a-z-]{8,64}$/i.test(conversationId)) {
      throw new Error('This session has no valid ChatGPT conversation');
    }
    setChatBlocked(conversationId, blocked);
    logInfo(
      blocked
        ? `conversation ${conversationId} blocked; its tool calls are refused until it is released`
        : `conversation ${conversationId} released; its tool calls run again`
    );
    // A blocked worker chat frees its swarm slot now, not on the next 30-second pass: the
    // user pressing Block on a worker is usually about to start something in its place.
    if (blocked) await sweepStaleSwarm().catch(() => undefined);
    return blockedChatIds();
  });

  handle('sessions:delete', async (payload) => {
    const { id } = sessionIdArg.parse(payload);
    // Detach first. The recorder maps live ChatGPT conversations to session ids, so
    // deleting the folder underneath a live one left it appending to a session that no
    // longer existed — the events went to a resurrected half-session with no summary.
    // Forgetting the mapping makes the next observation open a fresh session instead.
    const detached = forgetSession(id);
    // Release first. The block button lives on this row, so a block left behind by the row's
    // deletion would refuse that conversation's tools with nothing left in the app that could
    // ever release it.
    const summary = await getSession(id);
    if (summary?.conversationId) setChatBlocked(summary.conversationId, false);
    await deleteSession(id);
    logInfo(
      detached.length > 0
        ? `session ${id} deleted; ${detached.length} live conversation(s) will start a new session`
        : `session ${id} deleted`
    );
    return true;
  });

  handle('handoff:get', async (payload) => {
    const { id, handoffId } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        handoffId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i).optional()
      })
      .parse(payload);
    if (handoffId) return readHandoff(id, handoffId);
    const summary = await getSession(id);
    return summary?.lastHandoffId ? readHandoff(id, summary.lastHandoffId) : null;
  });

  // ---------------------------------------------------------------- bridge

  handle('bridge:unpair', async () => {
    await unpair();
    return buildState();
  });

  handle('bridge:downloadExtension', async () => {
    // This is a recovery path for the extension bundled with *this installed app*. Never use
    // releases/latest here: an old app must not fetch a newer extension with a newer protocol.
    await shell.openExternal(extensionDownloadUrl(app.getVersion()));
    return true;
  });

  /**
   * Opens the folder Chrome should load the extension from.
   *
   * The renderer never learns the path unless it asks for it here, and all it can do
   * with the answer is show it; the open itself happens in the main process against a
   * path the renderer did not choose.
   */
  handle('bridge:openExtensionFolder', async () => {
    const dir = extensionDir();
    if (!dir) {
      throw new Error(
        'The extension folder is missing from this installation. Reinstall the app, or use the extension/ folder from the source checkout.'
      );
    }
    const error = await shell.openPath(dir);
    if (error) throw new Error(`Could not open the extension folder: ${error}`);
    return dir;
  });

  handle('bridge:extensionPath', async () => extensionDir());

  // ----------------------------------------------------------------- swarm

  handle('swarm:get', async () => swarmState());
  handle('swarm:reset', async () => {
    resetSwarm();
    if (!(await persistAgentAuthorityNow())) {
      throw new Error('The cleared run could not be made durable. Retry clearing the swarm.');
    }
    return swarmState();
  });
  /**
   * Clearing one row in the app: the prime ends the run, a worker frees its own slot.
   *
   * The queued bootstrap is withdrawn here rather than from inside the broker. The broker
   * deliberately knows nothing about HTTP or tabs, and `drop()` reaches `failAgent` from
   * inside a delivery — cancelling from there would re-enter it. An IPC call never is.
   * `tidyCommands()` would retire the command on its own at the next poll; doing it now is
   * what stops a tab opening for a slot the user has just cleared.
   */
  handle('swarm:clearAgent', async (payload) => {
    const { id, runId } = z.object({ id: agentIdArg, runId: z.string().min(1).max(200).optional() }).parse(typeof payload === 'string' ? { id: payload } : payload);
    const outcome = clearAgent(id, runId);
    if (outcome.cleared !== 'none') {
      if (!(await persistAgentAuthorityNow())) {
        throw new Error('The agent clear could not be made durable. Retry the clear action.');
      }
      if (outcome.cleared === 'worker') cancelWorkerCommands(outcome.reason, id, runId);
    }
    // The prime's report stays in the main process: the renderer needs the outcome, not
    // the message queued for the prime agent.
    return { cleared: outcome.cleared, reason: outcome.reason, swarm: swarmState() };
  });


  // Push updates so the UI reflects tunnel progress without polling. buildState() crosses
  // async secret/bridge reads, so an older snapshot can otherwise resolve after a newer one and
  // repaint stale config/status. Latest-request-wins makes the push stream monotonic.
  /**
   * Sends to the renderer, if there still is one.
   *
   * A null window was always handled; a *destroyed* one was not. Electron keeps the object
   * alive after the window is gone, so `getWindow()` stays truthy and merely reading
   * `.webContents` off it throws. That is not just a missed repaint: `onLog` runs inside
   * `log()`, synchronously, on the caller's own stack — so once the window was destroyed,
   * every log line written during teardown threw into whatever was writing it. The MCP drain's
   * force-close timer died on its own `logWarn` before it could force anything, and the app
   * sat draining a half-closed tunnel socket forever, with no window, no tray, and the
   * single-instance lock still held.
   */
  const push = (channel: string, ...args: unknown[]): void => {
    const target = getWindow();
    if (!target || target.isDestroyed()) return;
    target.webContents.send(channel, ...args);
  };
  configureInputDelivery({
    activity: sessionInputActivity,
    wakeDecision: async (entry, signal) => {
      signal.throwIfAborted();
      if (!await startBridge()) throw new Error('The browser bridge could not start');
      signal.throwIfAborted();
      const marker = `cos-input=${encodeURIComponent(entry.id)}`;
      await wakeBrowserUrl(entry.conversationId ? `https://chatgpt.com/c/${encodeURIComponent(entry.conversationId)}`
        : `https://chatgpt.com/?${entry.lifetime === 'temporary-planner' ? 'temporary-chat=true&' : ''}${marker}#${marker}`);
    },
    bindHelper: async (conversationId, fromSessionId) => {
      const source = fromSessionId ? await getSession(fromSessionId) : null;
      if (source?.conversationId === conversationId || source?.chatIds.includes(conversationId)) return;
      await noteChatOrigin(conversationId, { kind: 'helper', fromSessionId, agentId: null, task: '' });
    },
    changed: () => push('session:changed'),
    recordDelivered: (entry) => getConfig().sessions.record ? recordDeliveredInput(entry) : Promise.resolve(true),
    prepareText: async (entry, limits) => {
      const control = entry.conversationId ? goalSwitchFor(entry.conversationId) : getConfig().goal;
      const mode = entry.automation ?? (control.enabled ? control.mode : 'off');
      const text = mode === 'goal' && goalBackendFor('goal') === 'templates' && !entry.text.includes(GOAL_MARKER_INSTRUCTION)
        ? entry.text + GOAL_MARKER_INSTRUCTION : entry.text;
      // Only the opening user input owns executor setup. Existing chats, queued
      // checkpoints and automatic continuations already have their instructions.
      return !entry.sessionId && !entry.conversationId && !entry.finishOwner && entry.mode !== 'finish'
        ? prepareSessionPrompt(text, entry, limits) : text;
    },
    applyAutomation: async (conversationId, automation, phase, objective) => {
      // This message supersedes the old final; never pick that old final up merely
      // because the composer enabled Goal for the next turn.
      const mode = automation === 'off' ? goalSwitchFor(conversationId).mode : automation;
      // Reserve switch ordering immediately, before awaiting another ledger write.
      // A user Off arriving during persistence must remain later than this attempt.
      const switchWrite = setGoalSwitchNow(conversationId, mode, automation !== 'off');
      const [held] = await Promise.all([switchWrite, setGoalReplyActiveNow(conversationId, false)]);
      // A fresh chat can finish before its send ACK arrives. Its newest final is
      // this message's own response, so it may be picked up after binding.
      // Objective ownership transfers with delivery even if the user switched Off
      // before the fresh chat acquired its identity. The saved Off row remains the
      // execution authority; retaining authored text must never imply reactivation.
      if (objective !== undefined) await setGoalObjectiveNow(conversationId, objective);
      const live = goalSwitchFor(conversationId);
      if (phase === 'after-send' && held.enabled && live.enabled && live.mode === held.mode) await setGoalReplyActiveNow(conversationId, true);
    }
  });

  let statePushGeneration = 0;
  const pushState = (): void => {
    const generation = ++statePushGeneration;
    void buildState().then((state) => {
      if (generation !== statePushGeneration) return;
      push('state:changed', state);
    });
  };
  onStatusChange(pushState);
  onBridgeChange(pushState);
  // Draft stages belong to session controls; state:changed only refreshes settings.
  onGoalChange(() => push('session:changed'));
  handle('tasks:cancel', async payload => cancelTaskRequest(z.object({ requestId: z.string().uuid() }).parse(payload).requestId));
  handle('sessions:goalOpening', async payload => {
    const { text, mode, requestId } = z.object({ text: z.string().trim().min(1).max(16000),
      mode: z.enum(['goal', 'loop']), requestId: z.string().uuid() }).parse(payload);
    const backend = goalBackendFor(mode);
    const publish = (progress: import('../shared/task-progress.js').TaskProgressUpdate) => push('task:progress', { requestId, ...progress });
    return runTaskRequest(requestId, JSON.stringify(['goal', text, mode]), async signal => {
      if (goalBackendFor(mode) !== backend) throw new Error('task_settings_changed');
      const drafted = await draftOpeningMessage(text, mode, publish, signal);
      if ('error' in drafted) throw nativeGoalFailure(drafted.error, backend, drafted.retryAfterMs);
      signal.throwIfAborted(); publish({ phase: 'ready', text: drafted.reply.slice(-8000) });
      return drafted;
    }, publish);
  });
  configureChatModelDiscovery({ changed: () => push('chatModels:changed', getChatModels()), wake: async (nonce, allowOpen) => {
    if (!await startBridge()) throw new Error('The browser bridge could not start');
    if (allowOpen) await wakeBrowserUrl(`https://chatgpt.com/?cos-model-catalog=${nonce}`, true, true);
  } });
  onUpdateChange(pushState);
  onMacOSDesktopAccessChange(pushState);
  onLog((entry) => push('log:entry', entry));
  onSessionChange(() => push('session:changed'));
  onSwarmChange(() => push('swarm:changed', swarmState()));
}
