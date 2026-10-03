/**
 * Sign-in pages of the CoS browser present Firefox (see signInAgent), and Firefox has no
 * `navigator.userAgentData`. Chromium keeps reporting its brands there even under another agent,
 * which is what gets an embedded browser refused, so those pages see it absent, as in Firefox,
 * before any of their own scripts run. Every other page is left exactly as it is.
 */
import { contextBridge } from 'electron';
import { isSignInHost } from '../main/cos-browser/sign-in.js';

if (isSignInHost(location.hostname)) {
  contextBridge.executeInMainWorld({
    func: () => {
      try { Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true }); }
      catch { /* A page that already sealed it keeps its own. */ }
    }
  });
}
