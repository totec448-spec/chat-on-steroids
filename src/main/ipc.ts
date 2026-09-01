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
  GOAL_MODES,
  GOAL_REASONING_LEVELS,
  RELEASES_PAGE,
  type AppState,
  type Config
} from '../shared/types.js';
import { MAX_GOAL_SYSTEM_PROMPT_CHARS } from '../shared/goal.js';
import { applySettings, connect, disconnect, getStatus, onStatusChange } from './connection.js';
import { getConfig, updateConfig } from './config.js';
import { clearAllGoalSwitches, listGoalModels, MODEL_PAGE_SIZE, retireGoalDrafts } from './goal.js';
import { forgetExposedSurface } from './mcp/server.js';
import { runDiagnostics } from './diagnostics.js';
import { formatLogAsJson, formatLogForClipboard, getLog, logInfo, onLog } from './logger.js';
import { RESERVED_ROOT_NAMES, uniqueRootName, validateNewRoot, SandboxError } from './sandbox.js';
import { hasSecret, isEncryptionAvailable, secureStorageStatus, setSecret } from './secrets.js';
import { bundledVersion, locateBinary } from './tunnel/locate.js';
import { TUNNEL_ID_PATTERN } from './tunnel/index.js';
import {
  bridgeStatus,
  cancelWorkerCommands,
  chatUrl,
  onBridgeChange,
  startBridge,
  stopBridge,
  unpair
} from './bridge.js';
import { extensionDir } from './extension-path.js';
import { extensionDownloadUrl } from './version.js';
import {
  deleteSession,
  getSession,
  listSessionPage,
  readEvents,
  readRecentEvents,
  readHandoff
} from './session/store.js';
import { activeSessionId, forgetSession, onSessionChange } from './session/recorder.js';
import { blockedChatIds, setChatBlocked } from './session/blocked-chats.js';
import {
  clearAgent,
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
import { onUpdateChange, updateStatus } from './update.js';

/** The only URLs the renderer may ask the OS to open. */
const ALLOWED_LINKS = new Set([
  // ChatGPT renamed this page from Connectors to Apps and the button followed it; the
  // allowlist did not, so "Open Apps" had been refused here ever since.
  'https://chatgpt.com/#settings/Apps',
  'https://platform.openai.com/settings/organization/tunnels',
  'https://platform.openai.com/settings/organization/api-keys',
  'https://github.com/openai/tunnel-client/releases',
  'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels',
  'https://developers.openai.com/api/docs/guides/developer-mode',
  // Where the key for the goal loop comes from. The button beside the key field is useless
  // without this: `link:open` refuses anything not named here, so it threw where nobody
  // was looking and the button did nothing at all.
  'https://openrouter.ai/settings/keys',
  // Where an installation that cannot update itself gets the new version by hand.
  RELEASES_PAGE
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
    minimizeToTray: z.boolean(),
    autoConnect: z.boolean(),
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
    maxWorkers: z.number().int().min(1).max(8),
    allowUnattributedCalls: z.boolean(),
    recoverAgentTabs: z.boolean()
  }),
  goal: z.object({
    enabled: z.boolean(),
    // Which of the two standing modes the switch runs. One field, so the renderer has no way
    // to describe a state where Goal and Loop are both on.
    mode: z.enum(GOAL_MODES),
    // An OpenRouter model id, and validated only as a shape: the catalogue changes weekly,
    // and an allow-list here would mean this app deciding which models exist.
    // The leading `~` is OpenRouter's own marker for an alias that always resolves to the
    // newest model in a family — `~deepseek/deepseek-v4-flash-latest` and eleven others. The
    // picker lists them because the listing does, so refusing them here meant the one kind
    // of entry most worth choosing was the one kind that could not be saved.
    model: z
      .string()
      .min(1)
      .max(160)
      .regex(
        /^~?[a-z0-9._\-]+\/[a-z0-9._\-]+(:[a-z0-9._\-]+)?$/i,
        'Expected an OpenRouter model id like vendor/model'
      ),
    reasoning: z.enum(GOAL_REASONING_LEVELS),
    prompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    objectivePrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    loopPrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
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
    capabilities,
    readOnly: pick(current.readOnly, base.readOnly, wanted.readOnly),
    tunnel: {
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
      minimizeToTray: pick(current.ui.minimizeToTray, base.ui.minimizeToTray, wanted.ui.minimizeToTray),
      autoConnect: pick(current.ui.autoConnect, base.ui.autoConnect, wanted.ui.autoConnect),
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
      enabled: pick(current.goal.enabled, base.goal.enabled, wanted.goal.enabled),
      mode: pick(current.goal.mode, base.goal.mode, wanted.goal.mode),
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
    secureStorage: await secureStorageStatus(),
    hasApiKey: await hasSecret('openaiApiKey'),
    hasGoalKey: await hasSecret('openRouterApiKey'),
    resolvedBinary: resolvedBinary(config),
    bundledTunnelVersion: bundledVersion(),
    bridge: await bridgeStatus(),
    update: updateStatus()
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

export function registerIpc(getWindow: () => BrowserWindow | null): void {
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
    const wasMultiAgent = before.multiAgent.enabled;
    const next = await updateConfig((config) => ({ ...config, ...mergeSettings(config, request.base, request.patch) }));
    // Renderer palette changes are immediate, so keep OS/Electron-owned chrome in lock-step too.
    // Without this, selecting Dark on macOS left the title bar, menus and file picker in the
    // system theme until restart (and startup still defaulted to system before index.ts applies it).
    nativeTheme.themeSource = next.ui.theme;
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
      before.goal.reasoning !== next.goal.reasoning ||
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
    // Switching multi-agent mode off has to be able to remove the `agents` tool from the
    // schemas, and the exposed surface only ever widens by default. So the latch is
    // released here — the one place that knows the user made the decision
    // deliberately — and the settings screen tells them to reconnect the connector, which
    // is what makes ChatGPT read the clean schemas.
    if (wasMultiAgent && !next.multiAgent.enabled) forgetExposedSurface();
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
    logInfo('settings updated');
    // The config and runtime side effects above still complete so the app does not stay half-on,
    // but the UI must not be told the pause was safely accepted when its retained authority
    // snapshot failed to cross disk. Startup with the feature off restores and canonicalizes
    // that same history instead of deleting it.
    if (authorityPersistError) throw authorityPersistError;
    return buildState();
  });

  handle('roots:add', async () => {
    const window = getWindow();
    if (!window) throw new Error('No window');
    const result = await dialog.showOpenDialog(window, {
      title: 'Approve a folder for ChatGPT',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return buildState();

    let addedName = '';
    await updateConfig(async (config) => {
      const real = await validateNewRoot(result.filePaths[0]!, config.roots);
      const name = uniqueRootName(real, config.roots);
      addedName = name;
      return { ...config, roots: [...config.roots, { name, path: real }] };
    });
    logInfo(`approved folder /${addedName}`);
    return buildState();
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
   * Stores one of the two keys the app holds, by name.
   *
   * The name is an enum rather than a string, so the renderer can choose *which* credential
   * it is writing but cannot name a slot nobody defined — and the value still only ever
   * travels inwards. Nothing reads a key back out over IPC; the state carries a boolean.
   */
  handle('secret:set', async (payload) => {
    const { value, key } = z
      .object({ value: z.string().max(500), key: z.enum(['openaiApiKey', 'openRouterApiKey']).default('openaiApiKey') })
      .parse(payload);
    if (!(await isEncryptionAvailable())) {
      throw new Error('Secure OS credential storage is unavailable, so the key cannot be stored safely.');
    }
    await setSecret(key, value);
    if (key === 'openRouterApiKey') retireGoalDrafts();
    const what = key === 'openRouterApiKey' ? 'openrouter key' : 'api key';
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

  handle('log:get', async () => getLog());
  handle('log:text', async () => formatLogForClipboard());
  handle('log:json', async () => formatLogAsJson());
  handle('clipboard:write', async (payload) => {
    const { text } = z.object({ text: z.string().max(1_000_000) }).parse(payload);
    clipboard.writeText(text);
    return true;
  });

  handle('link:open', async (payload) => {
    const { url } = z.object({ url: z.string().max(500) }).parse(payload);
    if (!ALLOWED_LINKS.has(url)) throw new Error('That link is not allowed');
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
    const page = await listSessionPage({ cursor, limit: limit ?? 60 });
    const sessions = page.sessions;
    return {
      sessions,
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

  handle('sessions:events', async (payload) => {
    const { id, from, limit } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        from: z.number().int().min(0).max(10_000_000).optional(),
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
      const events = await readRecentEvents(id, cap);
      const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0);
      return { summary, events, total: summary.events, nextFrom };
    }
    const events = await readEvents(id, { from, limit: cap });
    const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), from);
    return { summary, events, total: summary.events, nextFrom };
  });

  handle('sessions:openChat', async (payload) => {
    const { id } = sessionIdArg.parse(payload);
    const summary = await getSession(id);
    const conversationId = summary?.conversationId;
    if (!conversationId || !/^[0-9a-z-]{8,64}$/i.test(conversationId)) {
      throw new Error('This session has no valid ChatGPT conversation');
    }
    const browser = await openInPreferredBrowser(chatUrl(conversationId));
    if (!browser) throw new Error('Chrome or Chromium was not found');
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
    const id = agentIdArg.parse(payload);
    const outcome = clearAgent(id);
    if (outcome.cleared !== 'none') {
      if (!(await persistAgentAuthorityNow())) {
        throw new Error('The agent clear could not be made durable. Retry the clear action.');
      }
      if (outcome.cleared === 'worker') cancelWorkerCommands(outcome.reason, id);
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
  onUpdateChange(pushState);
  onLog((entry) => push('log:entry', entry));
  onSessionChange(() => push('session:changed'));
  onSwarmChange(() => push('swarm:changed', swarmState()));
}
