const DISMISSED_VERSION_KEY = 'cos.plugins.refreshReminder.dismissedVersion';
let dismissedVersion: string | null = null;
try { dismissedVersion = window.localStorage.getItem(DISMISSED_VERSION_KEY); }
catch { /* Dismissal still works for this window when storage is unavailable. */ }

/** Acknowledgement belongs to the running app version, never an available download.
 * No saved acknowledgement also covers the first upgrade that introduces this notice.
 * This is only a reminder; dismissing it does not assert that ChatGPT refreshed anything.
 */
export function paintPluginRefreshReminder(currentVersion: string): void {
  const notice = document.getElementById('pluginRefreshReminder')!;
  notice.hidden = dismissedVersion === currentVersion;
  document.getElementById('dismissPluginRefreshReminder')!.onclick = () => {
    dismissedVersion = currentVersion;
    try { window.localStorage.setItem(DISMISSED_VERSION_KEY, currentVersion); }
    catch { /* Keep the in-memory acknowledgement for this window. */ }
    notice.hidden = true;
  };
}
