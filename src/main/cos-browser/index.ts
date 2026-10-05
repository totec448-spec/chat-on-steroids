/**
 * The app's one CoS browser, running while it is the selected ChatGPT browser. Load it through
 * selection.ts: this module installs app hooks as it loads, and the default path never loads it.
 */
import { app, ipcMain, Notification } from 'electron';
import path from 'node:path';
import { bridgeStatus, onBridgeChange } from '../bridge.js';
import { getConfig, updateConfig } from '../config.js';
import { logWarn } from '../logger.js';
import { mainText } from '../main-texts.js';
import { liveConversations, onSessionChange } from '../session/recorder.js';
import { CosBrowser } from './host.js';

// From the app root, not this file: loaded on demand, this module is a chunk in out/main/chunks,
// where `../preload` would name a folder that does not exist.
const out = path.join(app.getAppPath(), 'out');

export const cosBrowser = new CosBrowser({
  preloadDir: path.join(out, 'preload'),
  rendererDir: path.join(out, 'renderer'),
  rendererUrl: () => process.env.ELECTRON_RENDERER_URL ?? null,
  onUserHide: showTrayHint
});

/**
 * The first time the user closes or minimizes the CoS browser, says where it went: it hides to the
 * tray and its chats go on, which a closed window does not suggest. Once per install.
 */
function showTrayHint(): void {
  if (getConfig().ui.cosBrowserTrayHint === true) return;
  void updateConfig(config => ({ ...config, ui: { ...config.ui, cosBrowserTrayHint: true } }))
    .then(() => {
      if (!Notification.isSupported()) return;
      new Notification({
        title: mainText('The Chat On Steroids browser is still running'),
        body: mainText(process.platform === 'darwin'
          ? 'Your chats keep going. Choose Show browser in the menu bar icon’s menu to bring it back.'
          : 'Your chats keep going. Choose Show browser in the tray icon’s menu to bring it back.')
      }).show();
    })
    .catch(error => logWarn(`cos browser: tray notice: ${error instanceof Error ? error.message : String(error)}`));
}

/** The dot on the toolbar's companion button: does its extension reach the app right now. */
function paintCompanion(): void {
  void bridgeStatus().then(status => cosBrowser.setAppConnected(status.present === true)).catch(() => undefined);
}

/** The pulse on a tab whose chat is answering. */
function paintGenerating(): void {
  cosBrowser.setGeneratingConversations(new Set(liveConversations().filter(chat => chat.generating).map(chat => chat.conversationId)));
}

// Hooks for the running browser only; while it is stopped they do no work.
onBridgeChange(() => { if (cosBrowser.running()) paintCompanion(); });
onSessionChange(() => { if (cosBrowser.running()) paintGenerating(); });
ipcMain.on('cos-browser:toolbar', (event, action: unknown, tabId: unknown) => {
  if (cosBrowser.running() && typeof action === 'string') cosBrowser.toolbarAction(event.sender, action, tabId);
});
ipcMain.on('cos-browser:sign-in', (event, action: unknown, value: unknown) => {
  if (cosBrowser.running() && (action === 'choose' || action === 'reopen' || action === 'back' || action === 'cancel')) {
    cosBrowser.signInAction(event.sender, action, value);
  }
});

/** Starts the CoS browser when it is the selected browser and stops it when it no longer is. */
export function syncCosBrowser(): void {
  if (getConfig().ui.chatBrowser === 'cos') {
    // Started with what is already true, not with what changes next: ready the moment it shows.
    void cosBrowser.start().then(() => { paintCompanion(); paintGenerating(); })
      .catch(error => logWarn(`cos browser: could not start: ${error instanceof Error ? error.message : String(error)}`));
  } else if (cosBrowser.running()) cosBrowser.stop();
}
