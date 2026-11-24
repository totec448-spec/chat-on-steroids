# Development display names

Unpackaged runs and packages launched with `COS_DEV_BRAND=1` display `Chat On Steroids (dev)`. Ordinary packages retain `Chat On Steroids`.

Main owns the development decision and passes the display name through AppState. The title, headers, tray tooltip and About panel use the existing localization path. New keys are registered in Japanese and English; existing locale checks remain in place.

`src/shared/app-brand-name.ts` owns the display-only base name. It does not change productName, appId, app.name or userData. Icons remain unchanged. macOS retains the native application menu identity: Electron for checkout runs, the product name for packages.

Run `npm run typecheck`, `npm run build`, and the app-display-name, window-lifecycle, main-texts, renderer-i18n-source and renderer-i18n tests.
