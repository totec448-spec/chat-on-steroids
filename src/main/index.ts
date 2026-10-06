import { stopInputStartup } from './session/start-input.js';
import { browserExtensionRequired } from '../shared/types.js';
import { requestSessionFinishGoal, setFinishNotifier } from './session/finish.js';
/**
 * Main process entry: window, tray, and the security posture for the renderer.
 */

import path from 'node:path';
import { app, Notification, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, powerMonitor, screen, session } from 'electron';
import { getConfig, initConfigPath, loadConfig } from './config.js';
import { initConnectorProofPath, loadConnectorProof, notePluginInstalled } from './connector-proof.js';
import { initBrowserProofPath, loadBrowserProof } from './browser-proof.js';
import { enrolledPluginSurfaces } from './plugin-refresh.js';
import {
  connect,
  disconnect,
  getStatus,
  onStatusChange,
  resumeConnectionLossNotices,
  setConnectionLossNotifier,
  shutdownConnection,
  suspendConnectionLossNotices
} from './connection.js';
import { registerIpc } from './ipc.js';
import { getChatModels, restoreChatModels, startChatModelDiscovery } from './chat-models.js';
import { flushLogBeforeExit, initLogFile, logError, logInfo, logWarn, snapshotLogOnCrash } from './logger.js';
import { unifiedExecManager } from './codex/manager.js';
import { initSecretsPath } from './secrets.js';
import { mainText, mainTextTranslations, onMainTextsChange, restoreMainTextTranslations } from './main-texts.js';
import { isMainText } from '../shared/main-texts.js';
import { executableFingerprint, initKeychainNotice } from './keychain-notice.js';
import { pluginManager } from './plugins/manager.js';
import { setBrowserOpener, setBrowserWorkArea, shutdownBridge, startBridge } from './bridge.js';
import { setStuckNotifier } from './stuck-notice.js';
import { flushSessions, initSessionStore } from './session/store.js';
import { initSkillsPath } from './skills.js';
import { initUvRuntime } from './plugins/uv-runtime.js';
import { initPetLibrary } from './pet-library.js';
import { shutdownPetOverlay, startPetOverlay } from './pet-overlay.js';
import { usageOverview } from './session/usage.js';
import {
  flushRecorder,
  queueDeterministicAttributionRepair,
  setAgentBinder,
  setAgentConversationLookup
} from './session/recorder.js';
import {
  agentConversation,
  bindConversation,
  onRetiredWorkersPersist,
  onRetiredWorkersPersistNow,
  onSwarmPersist,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  primeFleetIn, repairPrimeConversationAfterRecovery,
  reconcileAgentRequestOwners,
  restoreRetiredWorkers,
  restoreSwarm,
  snapshotRetiredWorkers,
  snapshotSwarm,
  type RetiredWorkersSnapshot,
  type SwarmSnapshot
} from './agents.js';
import { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { initControlApiPath, shutdownControlApi, startControlApi } from './control-api.js';
import { restoreRequestCorrelations } from './session/correlation.js';
import { restoreBlockedChats } from './session/blocked-chats.js';
import { restoreTrustedChats } from './session/trusted-chats.js';
import { stopComputerHelper } from './computer/index.js';
import {
  GOAL_OBJECTIVES_STATE,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE,
  restoreGoalObjectives,
  restoreGoalReplies,
  restoreGoalSwitches,
  type GoalObjectivesSnapshot,
  type GoalRepliesSnapshot,
  type GoalSwitchesSnapshot
} from './goal.js';
import {
  CONTINUATIONS_STATE,
  restoreContinuations,
  setContinuationRecoveryHooks,
  type ContinuationSnapshot
} from './session/continuation.js';
import { runShutdownSequence } from './shutdown.js';
import { startAgentRuntimeGc, stopAgentRuntimeGc } from './runtime-gc.js';
import { applyStagedUpdate, startUpdateChecks } from './update.js';
import { UI_BASE_ZOOM, windowLayoutForDisplays, windowPlacementWasMaximized, titleBarOverlayForTheme, windowBackgroundForTheme } from './window-layout.js';
import { openInPreferredBrowser } from './browser.js';
import { loadedCosBrowser, onCosBrowserLoaded, syncCosBrowser } from './cos-browser/selection.js';
import {
  applyLoginStartup,
  isBackgroundLaunch,
  createWindowActivationGate,
  ownsAppRuntime,
  registerNativeWindowActivation,
  trackNormalWindowBounds,
  shouldBeginAppBootstrap,
  shouldQuitOnWindowAllClosed
} from './window-lifecycle.js';
import { trayGuidArgsForPlatform, trayImageSpec } from './tray-image.js';
import { browserWindowIconPath } from './window-icon.js';
import { editContextMenuTemplate } from './edit-context-menu.js';
import { showConnectionLossNotice } from './connection-loss-notice.js';

/** Durable state file holding the multi-agent run. Hashes only, never credentials. */
const SWARM_STATE = 'swarm';
const RETIRED_WORKERS_STATE = 'retired-workers';
const WINDOW_BOUNDS_STATE = 'window-bounds';
/** The tray and notice texts in the last interface language; a launch to the tray opens no window to send them. */
const MAIN_TEXTS_STATE = 'main-texts';

let window: BrowserWindow | null = null;
let savedWindowBounds: unknown = null;
let tray: Tray | null = null;
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;
const usageWarmup = new AbortController();

// One instance only: two copies would fight over the tunnel and the config file.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // `app.quit()` does not make the rest of this module stop executing. Mark this process as a
  // terminal secondary instance immediately, so neither native activation nor the async bootstrap
  // below can touch shared config/durable state while the primary instance is still running.
  quitting = true;
  app.quit();
}

const BENIGN_RENDERER_ERRORS = new Set(['ResizeObserver loop completed with undelivered notifications.']);

function createWindow(): void {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const { layout, restored } = windowLayoutForDisplays(
    primaryWorkArea,
    screen.getAllDisplays().map(display => display.workArea),
    savedWindowBounds
  );
  const restoreMaximized = windowPlacementWasMaximized(savedWindowBounds);
  const icon = browserWindowIconPath(process.platform, app.isPackaged, process.resourcesPath);
  window = new BrowserWindow({
    ...layout,
    ...(icon ? { icon } : {}),
    // Preserve the native macOS green-button fullscreen action.
    fullscreenable: process.platform === 'darwin',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: titleBarOverlayForTheme(getConfig().ui.theme, getConfig().ui.appearance)
    } : {}),
    // macOS: the app's own top bar is the title bar, with the traffic lights inside it, instead
    // of a native title row above a second row that only held the sidebar and View buttons.
    // The overlay publishes the traffic-light area as env(titlebar-area-x) to the page.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: true } : {}),
    // Painted before the renderer loads, so a dark window never flashes white.
    backgroundColor: windowBackgroundForTheme(getConfig().ui.theme, getConfig().ui.appearance),
    title: 'Chat On Steroids',
    webPreferences: {
      zoomFactor: UI_BASE_ZOOM,
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // The renderer only ever loads our own local files.
      webSecurity: true
    }
  });

  if (process.platform === 'win32') window.removeMenu();
  const owner = window;

  // First use discovers the account once. A restored catalog is immediately usable;
  // showing the window again may observe an existing page, never open another browser attempt.
  window.on('show', () => {
    if (!quitting && getChatModels().state === 'unknown') void startChatModelDiscovery(false)
      .catch(error => logWarn(`model discovery on window open: ${error.message}`));
  });
  window.once('ready-to-show', () => {
    // A renderer can finish loading after Cmd+Q has already entered bounded teardown. Never let
    // that late native event make the app visible again while `will-quit` is draining.
    if (!quitting) {
      // Fresh installs retain the existing maximized first presentation. A saved normal window
      // stays normal; a window last used maximized restores that presentation over its saved
      // normal rectangle so un-maximizing returns to the same user-sized geometry.
      if ((!restored || restoreMaximized) && !window?.isFullScreen()) window?.maximize();
      showWindow();
      // Start observing only after initial native presentation has settled. BrowserWindow
      // construction/maximization can itself emit geometry events; those are not user choices.
      trackNormalWindowBounds(owner, (placement) => {
        savedWindowBounds = placement;
        writeDurableSoon(WINDOW_BOUNDS_STATE, placement);
      });
    }
  });

  // A renderer that fails to load leaves a blank window with no other clue, so
  // record it where the diagnostics panel can show it.
  window.webContents.on('did-finish-load', () => logInfo('window loaded'));
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F11' || input.isAutoRepeat) return;
    event.preventDefault();
    window?.setFullScreen(!window.isFullScreen());
  });
  window.webContents.on('context-menu', (_event, params) => {
    const owner = window;
    if (!owner || owner.isDestroyed()) return;
    const template = editContextMenuTemplate(params);
    if (template.length) Menu.buildFromTemplate(template).popup({ window: owner });
  });
  window.webContents.on('did-fail-load', (_event, code, description) =>
    logError(`window failed to load (${code}): ${description}`)
  );
  // Renderer errors are otherwise invisible from here. Only errors, and only the
  // message text — never anything the page was working with.
  window.webContents.on('console-message', (details) => {
    // Chromium's ResizeObserver notice is not a failure: the composer's height animation starts
    // inside its observer by design, and the deferred notification arrives on the next frame.
    // Logged as an error it appeared on every send and read like a renderer fault.
    if (details.level === 'error' && !BENIGN_RENDERER_ERRORS.has(details.message)) logError(`renderer: ${details.message}`);
  });

  // Nothing in this app should ever open a second window or navigate away.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  window.on('close', (event) => {
    if (!quitting && getConfig().ui.minimizeToTray) {
      event.preventDefault();
      window?.hide();
    }
  });

  // Electron keeps the object after the window is gone, and every member on it throws from
  // then on. Holding that reference made `getWindow()` answer "yes, there is a window" for
  // the rest of the process, so the renderer pushes and the tray's Open both aimed at a
  // corpse. Dropping it is what makes those paths take their existing null branch.
  window.on('closed', () => {
    window = null;
    if (!quitting && process.platform !== 'darwin' && !getConfig().ui.minimizeToTray) void shutdownPetOverlay();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function showWindow(): void {
  // Defense in depth for every current or future native activation source. The explicit gate
  // below additionally protects the long pre-window startup interval, while this invariant makes
  // a direct caller harmless once `before-quit` has started.
  if (quitting) return;
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

setFinishNotifier((title, body, sessionId, turnId) => {
  if (window?.isFocused() || !Notification.isSupported()) return false;
  const write = (): void => {
    showWindow();
    if (!window) return;
    const target = window.webContents;
    const open = (): void => { if (!target.isDestroyed()) target.send('session:write', sessionId); };
    if (target.isLoadingMainFrame()) target.once('did-finish-load', open); else open();
  };
  const shown = (text: string): string => isMainText(text) ? mainText(text) : text;
  const notice = new Notification({ title: shown(title), body: shown(body), actions: [
    { type: 'button', text: mainText('Send Automatic Goal') }, { type: 'button', text: mainText('Write Directly') }
  ] });
  notice.on('click', write);
  notice.on('action', (details) => {
    if (details.actionIndex === 0) void requestSessionFinishGoal(sessionId, turnId).catch(error => logWarn(`Finish goal: ${error.message}`));
    else if (details.actionIndex === 1) write();
  });
  notice.show();
  return true;
});
setStuckNotifier((title, body, sessionId) => {
  // A person looking at the app already has the timeline note this accompanies; interrupting
  // them with the same sentence is noise, exactly as the finish notice treats a focused window.
  if (window?.isFocused() || !Notification.isSupported()) return false;
  const notice = new Notification({ title, body });
  notice.on('click', () => {
    showWindow();
    if (!window) return;
    const target = window.webContents;
    const open = (): void => { if (!target.isDestroyed()) target.send('session:write', sessionId); };
    if (target.isLoadingMainFrame()) target.once('did-finish-load', open); else open();
  });
  notice.show();
  return true;
});
setConnectionLossNotifier(surface => showConnectionLossNotice(surface, {
  isQuitting: () => quitting,
  isFocused: () => window?.isFocused() ?? false,
  isSupported: () => Notification.isSupported(),
  text: mainText,
  create: options => new Notification(options),
  showWindow
}));

setBrowserWorkArea(() => screen.getPrimaryDisplay().workArea);

// Electron promises `second-instance` only after its own `ready`, not after our async startup.
// Until CSP/permission handlers and IPC are installed below, a re-launch is only a focus request
// for the initial window that startup is already going to show, so do not construct one early.
const windowActivation = createWindowActivationGate(showWindow);

/** Build the native tray image from encoded PNGs, never platform-dependent bitmap bytes. */
function trayIcon(running: boolean): Electron.NativeImage {
  const spec = trayImageSpec(process.platform, running);
  const [base, ...highDpi] = spec.representations;
  const image = nativeImage.createFromBuffer(base.png, { scaleFactor: base.scaleFactor });
  for (const representation of highDpi) {
    image.addRepresentation({
      scaleFactor: representation.scaleFactor,
      dataURL: `data:image/png;base64,${representation.png.toString('base64')}`
    });
  }
  if (spec.template) image.setTemplateImage(true);
  return image;
}

function refreshTray(): void {
  if (!tray) return;
  const state = getStatus().state;
  const connected = state === 'connected';
  const offline = state === 'offline';
  // Offline keeps the running icon: the bridge is up, the internet is not.
  const running = connected || offline;
  const label = mainText(connected ? 'Connected' : offline ? 'No internet' : 'Not connected');
  tray.setImage(trayIcon(running));
  // Not lowercased: that would break translated nouns ("Keine Internetverbindung").
  tray.setToolTip(`Chat On Steroids — ${label}`);
  const cosBrowser = loadedCosBrowser();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: mainText('Open'), click: windowActivation.request },
      // The CoS browser lives in the tray: its windows never sit in a taskbar or dock. Only once
      // it is selected and loaded; the default extension path shows exactly the menu it had.
      ...(cosBrowser && getConfig().ui.chatBrowser === 'cos' ? [{
        label: mainText(cosBrowser.visible() ? 'Hide browser' : 'Show browser'),
        click: () => {
          if (cosBrowser.visible()) cosBrowser.hide();
          else void cosBrowser.show().catch(error => logWarn(`cos browser: could not show: ${error instanceof Error ? error.message : String(error)}`));
        }
      }] : []),
      {
        label: mainText(running ? 'Disconnect' : 'Connect'),
        click: () => void (running ? disconnect() : connect())
      },
      { type: 'separator' },
      {
        label: mainText('Quit'),
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

app.on('second-instance', (_event, argv) => {
  if (!isBackgroundLaunch(argv)) windowActivation.request();
});

void app.whenReady().then(async () => {
  // This guard is intentionally before even app.getPath/init* calls. A secondary instance, or a
  // primary that was told to quit before ready, must never touch the primary's shared userData.
  if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;
  powerMonitor.on('suspend', suspendConnectionLossNotices);
  powerMonitor.on('resume', resumeConnectionLossNotices);
  const userData = app.getPath('userData');
  initLogFile(path.join(userData, 'app.log'));
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    snapshotLogOnCrash(`${origin}: ${error.stack ?? error.message}`);
  });
  initConfigPath(userData);
  initConnectorProofPath(userData);
  initBrowserProofPath(userData);
  initSecretsPath(userData);
  initKeychainNotice(userData, {
    platform: process.platform,
    contents: () => (window && !window.isDestroyed() ? window.webContents : null),
    fingerprint: () => executableFingerprint(app.getVersion())
  });
  initSessionStore(userData);
  try { await initSkillsPath(userData); }
  catch (error) { logWarn(`Skills library unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  initDurableStore(userData);
  savedWindowBounds = await readDurable<unknown>(WINDOW_BOUNDS_STATE);
  restoreMainTextTranslations(await readDurable<unknown>(MAIN_TEXTS_STATE));
  if (windowActivation.isDisabled()) return;
  initControlApiPath(userData);
  initUvRuntime(userData);
  // Bundled pet packages: the packaged app's resources, or the repository's pets/ folder in dev.
  try { await initPetLibrary(userData, app.isPackaged ? path.join(process.resourcesPath, 'pets') : path.join(app.getAppPath(), 'pets')); }
  catch (error) { logWarn(`Pet library unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  await restoreChatModels();
  if (windowActivation.isDisabled()) return;
  await loadConfig();
  await loadConnectorProof();
  await loadBrowserProof();
  // Plugins ChatGPT already showed the refresh feature are created: Setup need not wait for a call.
  for (const surface of await enrolledPluginSurfaces()) notePluginInstalled(surface);
  await pluginManager.initialize(userData);
  if (windowActivation.isDisabled()) return;
  try { applyLoginStartup(app, getConfig().ui.startAtLogin === true); }
  catch (error) { logWarn(`Windows login startup: ${error instanceof Error ? error.message : String(error)}`); }
  // The renderer has its own explicit light/dark palette, so native chrome must follow the same
  // user choice instead of Electron's default `system` theme. On macOS this controls the window
  // frame, application menus and OS dialogs; on Linux/Windows it covers Electron-native UI.
  nativeTheme.themeSource = getConfig().ui.theme;
  const savedGoalObjectives = await readDurable<GoalObjectivesSnapshot>(GOAL_OBJECTIVES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalObjectives(savedGoalObjectives);
  const savedGoalSwitches = await readDurable<GoalSwitchesSnapshot>(GOAL_SWITCHES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalSwitches(savedGoalSwitches);
  const savedGoalReplies = await readDurable<GoalRepliesSnapshot>(GOAL_REPLIES_STATE);
  if (windowActivation.isDisabled()) return;
  restoreGoalReplies(savedGoalReplies);
  // Request ownership must exist before either side of the bridge can race in. A request id
  // that was proved yesterday remains the same workflow today even if its ChatGPT tab closed.
  await restoreRequestCorrelations();
  if (windowActivation.isDisabled()) return;
  // And the user's blocks, for the same reason: a chat blocked yesterday is still the rogue
  // turn today, and a block that loads after the first call is a tool the turn already got.
  await restoreBlockedChats();
  if (windowActivation.isDisabled()) return;
  // Strict allowlisting is fail-closed: restore the exact trust set before model-facing
  // endpoints can accept work, just as blocked-chat policy is restored above.
  await restoreTrustedChats();
  if (windowActivation.isDisabled()) return;
  setAgentConversationLookup(agentConversation);
  // The prime's chat is the user's own, so no extension report can name it. It is bound
  // when the recorder manages to place the prime's first call. See recordToolCall.
  setAgentBinder(bindConversation);
  // Before anything can call an agent tool, and before a run is restored: the broker
  // decides whether a previous run has been abandoned partly from which ChatGPT tabs are
  // open, and without this it can only answer "I cannot see" — which it treats, on
  // purpose, as a reason to leave the existing run alone.
  // How a fresh chat opens when no browser can be asked to open it. The app asks the OS for
  // the ChatGPT URL, which launches the browser if it is closed and creates the tab if there
  // is none — the two cases the old "wait for a ChatGPT tab to poll us" delivery could never
  // handle. Wired before any restored command is delivered, so a resume queued yesterday opens
  // as soon as the bridge starts rather than waiting for the user to visit ChatGPT.
  //
  // It is deliberately not how a page-driven Compact & Resume opens chat B. The OS resolves a
  // URL to whichever browser instance last had focus, which is a different window — and can be
  // a browser without this extension in it — from the one holding chat A. That decision belongs
  // to the browser that owns the source chat; see bridge.ts::offerPlacement.
  setBrowserOpener(async (url) => {
    // Let the command owner report launch failure; another browser may belong to another account.
    await openInPreferredBrowser(url);
  });

  // Persistence is a process-lifetime dependency of the broker, not a feature-toggle
  // dependency. Multi-agent can be enabled from Settings without restarting the process;
  // keeping both sinks wired from startup guarantees the first spawn can cross its durable
  // acceptance barrier even when this launch began with multi-agent disabled.
  onSwarmPersist(() => writeDurableSoon(SWARM_STATE, snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot));

  // A multi-agent run outlives this process. Restoring it before the bridge starts
  // means a worker that never joined gets its chat re-requested through the same queue
  // as a fresh one, rather than being stranded with a key nobody has.
  onRetiredWorkersPersist(() => writeDurableSoon(RETIRED_WORKERS_STATE, snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow(RETIRED_WORKERS_STATE, snapshot));
  const retiredWorkers = await readDurable<RetiredWorkersSnapshot>(RETIRED_WORKERS_STATE);
  if (windowActivation.isDisabled()) return;
  restoreRetiredWorkers(retiredWorkers);
  const savedSwarm = await readDurable<SwarmSnapshot>(SWARM_STATE);
  if (windowActivation.isDisabled()) return;
  restoreSwarm(savedSwarm);
  if (!getConfig().multiAgent.enabled) {
    // A feature toggle is a pause, not Clear swarm. Canonicalize any active incarnation left by
    // a crash into stopped prime-owned history before the bridge exists, then make that safer
    // projection durable. Re-enabling later in this process or after another restart recovers the
    // same exact worker conversations without letting disabled workers consume execution slots.
    pauseSwarmForDisable('multi-agent mode is disabled');
    await writeDurableNow(SWARM_STATE, snapshotSwarm());
    if (windowActivation.isDisabled()) return;
  }
  // Continuation recovery is after swarm restore because an interrupted durable rebind may
  // have to finish publishing the prime transfer that was frozen in that snapshot.
  setContinuationRecoveryHooks({
    repairPrimeTransfer: repairPrimeConversationAfterRecovery,
    hasPrimeFleet: primeFleetIn
  });
  const savedContinuations = await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE);
  if (windowActivation.isDisabled()) return;
  await restoreContinuations(savedContinuations);
  if (windowActivation.isDisabled()) return;
  await reconcileAgentRequestOwners();
  if (windowActivation.isDisabled()) return;
  // Runtime GC consumes restored broker/session/exec ownership only. It owns no worker lifecycle
  // state and does not run until its first coarse interval after this point.
  startAgentRuntimeGc();

  // Strict CSP for our own page. There is no remote content and no inline script.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
        ]
      }
    });
  });

  // Deny every permission request; the UI needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // From here on a second launch may safely focus/recreate the window: renderer security policy
  // is installed and the renderer's fixed IPC methods already have handlers before it can load.
  // The same quit the tray's Quit performs. It has to go through `quitting` for the window's
  // close-to-tray handler to let go: without it, quitting to install would hide the window and
  // leave the app running, which is exactly the trap the Install button exists to end.
  registerIpc(
    () => window,
    () => {
      quitting = true;
      app.quit();
    }
  );
  windowActivation.enable();
  if (!isBackgroundLaunch(process.argv)) windowActivation.request();
  // The desktop pet overlay is independent of the main window once started; it stays hidden
  // until a pet is enabled.
  await startPetOverlay(() => window, () => windowActivation.request());
  // macOS `activate` can fire on first launch, so do not wire it at module load where it could
  // create a BrowserWindow before Electron is ready. Once the initial window path is established,
  // Dock activation/re-launch can safely recreate or focus it.
  registerNativeWindowActivation(app, windowActivation.request);

  tray = new Tray(trayIcon(false), ...trayGuidArgsForPlatform());
  tray.on('click', windowActivation.request);
  refreshTray();
  onStatusChange(refreshTray);
  // The built-in browser's own hooks live in its module, which loads only once it is selected.
  onCosBrowserLoaded(cosBrowser => { cosBrowser.onChange(refreshTray); refreshTray(); });
  onMainTextsChange(refreshTray);
  onMainTextsChange(() => writeDurableSoon(MAIN_TEXTS_STATE, mainTextTranslations()));

  logInfo('app started');

  // Historical Unattributed repair may legitimately scan and rewrite a large legacy bucket.
  // It is maintenance, not a prerequisite for showing the app or accepting new exact-id
  // traffic, so never make startup/reload wait behind years of old session history.
  queueDeterministicAttributionRepair();

  // Recording, workers and direct browser tools share one extension transport.
  // ipc.ts uses the same eligibility rule when settings change.
  // The CoS browser starts once the bridge listens: its extension looks for the app as soon as it
  // loads, and a miss would leave it waiting for its next retry.
  if (browserExtensionRequired(getConfig())) {
    void startBridge().finally(() => void syncCosBrowser());
  } else void syncCosBrowser();
  // Opt-in, and only once every fact it projects has been restored. ipc.ts starts and stops it
  // when the setting changes; a failed bind is logged and leaves the rest of the app untouched.
  if (getConfig().controlApi.enabled) {
    startControlApi().catch((error: Error) => logWarn(`control API did not start: ${error.message}`));
  }
  if (getConfig().ui.autoConnect) void connect();

  // Never awaited: an unreachable GitHub, a slow download or a broken release must not delay a
  // window that is already on screen. Everything it learns arrives through the ordinary state
  // push, every failure ends inside it, and its own timer keeps it running for a tray app that
  // is never restarted.
  startUpdateChecks();
  // Warm the existing derived cache once, after startup, without delaying the UI.
  // A visit to Usage joins this same calculation; unchanged recordings cost no reads.
  void usageOverview(usageWarmup.signal).catch((error: Error) => {
    if (!usageWarmup.signal.aborted) logWarn(`usage background refresh failed: ${error.message}`);
  });
});

app.on('before-quit', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  quitting = true;
  // From this point `will-quit` owns a bounded teardown. A Dock click/relaunch arriving while
  // that sequence drains must not recreate or reveal a window after the tray has disappeared.
  windowActivation.disable();
  usageWarmup.abort();
  void stopAgentRuntimeGc();
});

app.on('window-all-closed', () => {
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  // macOS convention: closing the last window is not quitting the application. The Dock/menu
  // bar stay alive and `activate` recreates it. Windows/Linux retain the explicit close-to-tray
  // preference; Cmd+Q / app.quit bypasses this event and still enters the shutdown sequence.
  if (shouldQuitOnWindowAllClosed(process.platform, getConfig().ui.minimizeToTray)) app.quit();
});

app.on('will-quit', (event) => {
  // A secondary instance called app.quit() only to get out of the primary's way. It must be
  // allowed to exit normally: preventing that quit and flushing/stopping the primary's shared
  // stores from a process that never initialized or owns them is both a hang and data race.
  if (!ownsAppRuntime(hasSingleInstanceLock)) return;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopInputStartup();
  tray?.destroy();
  tray = null;

  void runShutdownSequence(
    [
      // Phase 1: stop the listeners from admitting work and let accepted requests drain.
      // The budget has to clear the drains it contains, or it would silently defeat them:
      // the bridge force-closes wedged localhost sockets at 15s and the MCP endpoint forces
      // its own drain at 30s. This is the outer bound on both, not a competing one. The control
      // API is read-only and drains within 2s; stopping it also removes its token file.
      {
        name: 'admission/drain',
        budgetMs: 40_000,
        run: () => [shutdownConnection(), shutdownBridge(), shutdownControlApi(), stopAgentRuntimeGc()]
      },
      // Phase 2: only after request handlers are done may their owned child processes go.
      {
        name: 'process cleanup',
        budgetMs: 15_000,
        run: () => [unifiedExecManager.terminateAllProcesses(), stopComputerHelper(), shutdownPetOverlay(), pluginManager.close(),
          Promise.resolve().then(() => loadedCosBrowser()?.stop())]
      },
      // Phase 3: recorder work can enqueue both session projections and named durable state.
      { name: 'recorder flush', budgetMs: 10_000, run: () => [flushRecorder()] },
      // These are independent writers. One rejection must never skip the other flush.
      { name: 'durable flush', budgetMs: 10_000, run: () => [flushSessions(), flushDurable()] },
      // Last, because it is the one phase whose effect is meant to outlive this process: a
      // staged update is handed to the platform's installer here, so the next start of the app
      // is the new version. Nothing is staged unless it downloaded whole and matched the
      // release's published SHA-256, and applying it cannot fail loudly - see update.ts.
      { name: 'update handoff', budgetMs: 5_000, run: () => [applyStagedUpdate()] }
    ],
    {
      info: logInfo,
      warn: logWarn,
      error: logError,
      // Not `app.quit()`. See the note on ShutdownHooks.exit: a quit raised from the
      // continuation that ends this sequence is dropped by Electron, and the app is left
      // running with nothing to click and the single-instance lock still held.
      exit: () => {
        // The sequence has just logged its completion; a phase inside it would flush too early.
        void flushLogBeforeExit().finally(() => {
          shutdownComplete = true;
          app.exit(0);
        });
      }
    }
  );
});

// Belt and braces: no web contents anywhere in this app may open a window or
// navigate. External links go through the vetted allowlist in ipc.ts instead.
// The CoS browser's pages are the one exception: a browser has to navigate, and signing in to
// ChatGPT is nothing but navigations and redirects. Its host sets their window rules itself.
app.on('web-contents-created', (_event, contents) => {
  if (loadedCosBrowser()?.browses(contents)) return;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
});
