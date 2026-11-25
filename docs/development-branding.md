# Development display names

Unpackaged runs and packages launched with `COS_DEV_BRAND=1` display `Chat On Steroids (dev)`. Ordinary packages retain `Chat On Steroids`.

Main owns the development decision and passes the display name through AppState. The title, headers, tray tooltip and About panel use the existing localization path. New labels are registered in all 12 translated catalogs; English uses the existing source-text path and the catalog checks remain unchanged.

`src/shared/app-brand-name.ts` owns the display-only base name. It does not change productName, appId, app.name or userData. macOS retains the native application menu identity: Electron for checkout runs, the product name for packages.

Run `npm run typecheck`, `npm run build`, and the app-display-name, window-lifecycle, main-texts, renderer-i18n-source and renderer-i18n tests.
