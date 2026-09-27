# Pets native input and host cost — 2026-09-27

Scope: Pets host and renderer on upstream `30cb612`, Electron 44.3.0, Windows.
No startup, provider, chat, bridge, or Internal Chromium changes. The separate
startup experiment was rejected after user testing and removed before this PR.

## Reproduction and ownership

- In the installed upstream app, disabling the enabled pets and enabling others
  left animations running but native left-button drag did not work. The user also
  reported a context menu which opened but did not accept left-click actions.
- A fresh-profile Electron fixture reproduced the important difference: injected
  renderer input passed, native Windows input failed after disabling the last pet
  and enabling another. Only `pointerup` reached the renderer, not `pointerdown`.
- Windows Chromium's non-activatable-window mouse-activation path consumes the
  press (`MA_NOACTIVATEANDEAT`). Windows Pets now permits explicit click activation,
  while retaining `showInactive`, bounded hit regions and `skipTaskbar`. Merely
  showing or hovering over a pet must not take foreground focus. Other platforms
  retain their existing focus policy. A deliberate click/drag can focus Pets.
- A second native test exposed global hide/show with an unchanged pointer/region:
  main forced click-through but renderer deduplication still remembered interactive.
  Renderer interaction now incorporates snapshot visibility, so the hidden/visible
  transition publishes false/true rather than suppressing the re-arm message.
- Separately, every 50 ms pointer sample reread the entire library, including image
  validation/thumbnail decoding. The host now uses a read-only projection of the
  existing library owner's initial state and change publication. No new watcher,
  poller, timer or independent library authority was introduced.

## Validation

- Native regression failed before the input fixes and passed after both fixes:
  initial drag; disable all/re-enable a different pet; context-menu Hide pet via
  native left click; re-enable/drag; global hide/show beneath the pointer; drag again.
- Native hover preserves foreground focus; global show preserves owner focus.
- The ordinary Electron regression checks drag and restoring click-through.
- Idle fixture image decodes: baseline 22 in approximately 1.1 s; corrected 0.
  Short single-core main CPU samples moved from approximately 43% to 0–1.5%.
  These are isolated probe samples, not a whole-desktop performance guarantee.
- Build and typecheck passed. Four focused Vitest files / 15 tests passed; the
  renderer regression includes hide/show beneath an unchanged pointer.
- After removing the startup experiment, rebuilt and reran the isolated Electron
  fixture: four drag checks, membership changes, global hide/show, click-through,
  and zero idle atlas decodes passed on the exact Pets-only source.
- Full verification has not been confirmed green. Packaging/installation evidence
  is separate from source/runtime checks; no startup experiment is included here.

Run `electron scripts/verify-pet-toggle.cjs` after building. On Windows add
`--native-pointer` to drive actual OS input (keep hands off the mouse during the
short run). The fixture uses fresh temporary userData, disables automatic work,
blocks web traffic, and does not send requests to a provider or use user sessions.

Temporary focus-reset/show-method experiments were removed from the fixture;
they did not fix the native input path. There are no corresponding production
fallbacks. Startup latency remains a separate, deferred issue.

## Packaging evidence

A Windows x64 package built with the Pets fixes passed the packaged native/runtime
smoke, with all 141 compiled output files matching their packaged ASAR bytes.
This is packaging evidence, not a guarantee about installed-app startup speed.
