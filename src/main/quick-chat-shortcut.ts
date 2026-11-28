import { configuredQuickChatShortcut, type QuickChatShortcutPreference, type QuickChatShortcutStatus } from '../shared/quick-chat-shortcut.js';
import { logWarn } from './logger.js';

interface ShortcutRegistration {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Own only our accelerator. The configured preference remains valid even when the OS refuses it. */
export function createQuickChatShortcut(registry: ShortcutRegistration, toggle: () => void, warn: (message: string) => void = logWarn) {
  let requested: string | null | undefined;
  let registered: string | null = null;
  let status: QuickChatShortcutStatus = 'pending';
  const release = () => {
    if (registered !== null) registry.unregister(registered);
    registered = null;
  };
  const apply = (prefs: QuickChatShortcutPreference) => {
    const accelerator = prefs.quickChatShortcutEnabled === false ? null : configuredQuickChatShortcut(prefs);
    if (requested === accelerator) return;
    requested = accelerator;
    release();
    if (accelerator === null) { status = 'disabled'; return; }
    try {
      if (registry.register(accelerator, toggle)) {
        registered = accelerator;
        status = 'registered';
        return;
      }
    } catch { /* The platform may reject a syntactically valid accelerator. */ }
    status = 'unavailable';
    warn('quick chat: global shortcut unavailable; use the tray menu or change the shortcut');
  };
  const dispose = () => { release(); requested = undefined; status = 'pending'; };
  return { apply, dispose, status: () => status };
}

let controller: ReturnType<typeof createQuickChatShortcut> | undefined;

export function initializeQuickChatShortcut(registry: ShortcutRegistration, toggle: () => void, prefs: QuickChatShortcutPreference): void {
  controller?.dispose();
  controller = createQuickChatShortcut(registry, toggle);
  controller.apply(prefs);
}

export function applyQuickChatShortcut(prefs: QuickChatShortcutPreference): void { controller?.apply(prefs); }
export function getQuickChatShortcutStatus(): QuickChatShortcutStatus { return controller?.status() ?? 'pending'; }
export function disposeQuickChatShortcut(): void { controller?.dispose(); controller = undefined; }
