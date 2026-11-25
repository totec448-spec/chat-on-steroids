# Development display names

Unpackaged runs and packages launched with `COS_DEV_BRAND=1` display `Chat On Steroids (dev)`. Ordinary packages retain `Chat On Steroids`.

Main owns the development decision and passes the display name through AppState. The title, headers, tray tooltip and About panel use the existing localization path. New labels are registered in all 12 translated catalogs; English uses the existing source-text path and the catalog checks remain unchanged.

`src/shared/app-brand-name.ts` owns the display-only base name. It does not change productName, appId, app.name or userData. macOS retains the native application menu identity: Electron for checkout runs, the product name for packages.

Run `npm run typecheck`, `npm run build`, and the app-display-name, window-lifecycle, main-texts, renderer-i18n-source and renderer-i18n tests.

## Install dependencies in each worktree

For ordinary npm checkouts, run `npm ci` from each worktree before building it. Do not share or symlink `node_modules` between worktrees:
`npm ci` removes the existing installation before replacing it, so a shared dependency tree can disappear during another checkout's work.
Packaging also resolves transitive dependencies relative to its own checkout; a foreign dependency link can produce an incomplete package.
Check the resolved directory with `node -p "require('node:fs').realpathSync('node_modules')"`. It must belong to the current worktree.

The display-name UI check runs with `npm run verify:ui -- app-display-name` after the build.
It uses the built preload and renderer, synthetic state, an isolated profile and no external HTTP requests.
It checks the native title, renderer title and visible header, first without an AppState display name
and then with main's development display name. Results are written to `outputs/app-display-name/`.
The Node parent accepts the check only after a fresh capture produces `before.png`, `after.png`
and `result.json`, both PNGs are nonempty and different, and both states have matching labels and no renderer errors.
An early zero exit from Electron or artifacts left by an older run cannot produce PASS.
