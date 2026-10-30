/** Platform-specific Desktop contracts share the same native execution owners. */
import type { SurfaceRegistrar } from './kernel.js';
import { registerMacOSDesktopTools } from './tools-desktop-macos.js';
import { registerWindowsDesktopTools } from './tools-desktop-windows.js';
import { registerBrowserTools } from './tools-browser.js';
import { desktopAutomationSupported } from '../platform.js';
import { guardDesktopTools } from './desktop-caller.js';

export function registerDesktopTools(reg: SurfaceRegistrar): void {
  registerBrowserTools(reg);
  if (desktopAutomationSupported()) {
    // The browser tools keep their own identity rules; screen, mouse and keyboard need a known chat.
    const desktop = guardDesktopTools(reg);
    if (process.platform === 'win32') registerWindowsDesktopTools(desktop);
    else registerMacOSDesktopTools(desktop);
  }
}
