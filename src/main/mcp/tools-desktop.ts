/** Platform-specific Desktop contracts share the same native execution owners. */
import type { SurfaceRegistrar } from './kernel.js';
import { registerMacOSDesktopTools } from './tools-desktop-macos.js';
import { registerWindowsDesktopTools } from './tools-desktop-windows.js';
import { registerBrowserTools } from './tools-browser.js';
import { desktopAutomationSupported } from '../platform.js';

export function registerDesktopTools(reg: SurfaceRegistrar): void {
  registerBrowserTools(reg);
  if (desktopAutomationSupported()) {
    if (process.platform === 'win32') registerWindowsDesktopTools(reg);
    else registerMacOSDesktopTools(reg);
  }
}
