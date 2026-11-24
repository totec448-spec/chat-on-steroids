import { app, Menu, type BrowserWindow } from 'electron';
import { APP_DISPLAY_NAME } from '../shared/app-brand-name.js';
import { mainText } from './main-texts.js';

// The only development/production decision for display branding. Never change app.name:
// Electron uses that identity for the existing userData path and native integration.
// Packaged verification builds opt in explicitly; ordinary packages remain production-branded.
const development = !app.isPackaged || process.env.COS_DEV_BRAND === '1';
export const appBrand = {
  development,
  displayName: development ? `${APP_DISPLAY_NAME} (dev)` as const : APP_DISPLAY_NAME
} as const;

export function refreshNativeBrand(window: BrowserWindow | null): void {
  const applicationName = mainText(appBrand.displayName);
  app.setAboutPanelOptions({ applicationName, applicationVersion: app.getVersion() });
  if (window && !window.isDestroyed()) window.setTitle(applicationName);
  // Preserve native app-menu identity (Electron in checkout builds), roles and shortcuts.
  // macOS ignores a custom first-menu label: distinguish dev via the About item instead.
  // Changing app.name to force it would also change the profile identity.
  const menu = Menu.getApplicationMenu();
  const first = menu?.items[0];
  if (development && process.platform === 'darwin' && first?.submenu) {
    const submenu = Menu.buildFromTemplate(first.submenu.items.map(item => item.role === 'about'
      ? { role: 'about', label: mainText(`About ${APP_DISPLAY_NAME} (dev)`) } : item));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: first.label, submenu }, ...menu!.items.slice(1)
    ]));
  }
}
