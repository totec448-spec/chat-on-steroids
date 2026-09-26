# Desktop Pets overlay — rendering audit (2026-09-17)

Scope: the dirty `dev/port-fork-delta` worktree. This note does not describe the clean
top-level `main` checkout or an installed release.

## Evidence and decision

- The reported `pets-shot-zoomfix.png` was no longer present. A fresh isolated
  Electron capture of the compiled overlay measured a 160×160 CSS cell at zoom 1
  and a 74×113 physical-pixel Tur Tur alpha bounding box on a 1.2-DPR display.
  The art intentionally occupies only part of the atlas cell. The earlier
  9×14 observation was not reproduced; the later dev failure below establishes
  a missing-CSS cause for `Active` without visible art, not that exact pixel count.
- The old enhanced fork uses one CSS-background body on a transparent native
  window. BetterGravity's source uses an 8×11 percentage-scaled atlas. CoS must
  retain its distinct 8×12/96-frame package contract, so neither old atlas nor
  sprite runtime was copied into this worktree.
- The overlay's previous `cos-pet-overlay` partition was nonpersistent. That
  contradicted the renderer's per-pet `localStorage` position owner: a real drag
  could be lost on app restart. The partition is now `persist:cos-pet-overlay`.
- Each frame now uses an exact native-pixel offset into the 1280×1920 atlas.
  The 160×160 body is not resized to a sheet preview. The post-load zoom write
  and its unproven claim that zoom caused the tiny sprite were removed. Creation
  still specifies zoom factor 1 in the private session.
- A real Vite-dev run reproduced the reported `Active` with no visible pet:
  `.pet-body` measured 1587px wide, not 160px. The overlay's strict CSP blocked
  Vite's inline CSS injection from the TypeScript CSS import. The stylesheet is
  now linked from `pet-overlay.html`, preserving `style-src 'self'` and loading
  externally in both dev and the built renderer. This was the first wrong
  transition; changing zoom or library state would not repair it.
- A later interaction report exposed a separate missing action: short clicks
  only called `PetMachine.endPointer()`, while the overlay could take focus.
  The click now uses a narrow preload message to restore/focus the CoS owner
  through the existing owner helper, without changing the current screen.
  The same gesture still pokes the pet; drags and cancellations do not focus CoS.
- The task tray was reduced from a two-line 310px panel to a Codex-like 256px
  status strip. A single task now occupies about 69 CSS px total, with its title
  and summary on one 32px row. Up to eight projected tasks remain available in
  the same bounded 206px tray through scrolling rather than growing over the
  desktop.
- The library's copied AI brief now distinguishes the upstream `$hatch-pet`
  workflow from CoS package authority. It borrows canonical-reference,
  transparency, contact-sheet, motion-preview and repair discipline, but warns
  agents not to emit the incompatible Codex 8×9/192×208/WebP package. It fully
  documents the CoS 8×12/96-frame contract, import limits, starting timings,
  task-state reactions, both comedy sequences, DOM-owned labels/props, measured
  hand anchors and final QA/reporting. The brief invokes the installed skill by
  `$hatch-pet` and includes its official GitHub URL only for discovery/reference.
- The normal runtime now plays `spawn` when activity transitions to running, in
  addition to the existing waiting → `look`, failed → `angry`, and review →
  `celebrate` reactions. This makes the copied status contract truthful while
  retaining idle/walk behavior between transitions.
- The obsolete Tur Tur image launcher was removed from the chat composer. Pets
  now have one library entry point in the sidebar; the existing View command
  still toggles overlay visibility. The Chats refresh action now uses the
  existing retry/refresh glyph instead of the unrelated activity pulse.
- The incomplete hand-drawn sidebar paw exposed a broader split icon identity.
  Action glyphs now use one Phosphor regular family across the main shell,
  dynamic controls, the View menu and Pets overlay. The bespoke CoS mark,
  language flags and context visualization remain intentional exceptions. The
  legacy action sprite and Unicode close/overflow stand-ins were removed.
  `icons.css` publishes only the used glyph rules and WOFF2 sources, avoiding
  the package stylesheet's legacy WOFF/TTF/SVG fallbacks in the renderer bundle.

## Validation actually performed

- `npm run typecheck` and `npm run build`: passed.
- After the click-focus change, typecheck, build, the renderer interaction test,
  and Electron smokes against both built assets and Vite dev passed. The smokes
  minimized CoS, clicked the pet through the preload/IPC path, and asserted
  that CoS was restored with its existing screen unchanged. The isolated dev
  Electron instance was restarted so its main/preload code was current.
- After the task-strip refinement, typecheck, build, the focused overlay/activity
  tests, and Electron smokes against both built assets and Vite dev passed. The
  smoke measures the single-task tray at no more than 256×72 CSS px and each task
  row at no more than 34px; it also verifies that eight tasks stay within 206px
  and remain scrollable. The isolated dev instance was reopened for review.
- After the creation-brief/status work, typecheck and five focused Pet files
  passed (25/25 tests), including the copied contract and all four task reaction
  clips.
- After removing the composer launcher and correcting the Chats refresh glyph,
  typecheck, build and the focused controller/library UI suites passed (4/4
  tests). The UI detector reported only pre-existing findings outside this
  narrow change.
- After the icon unification, typecheck and production build passed; focused
  Pets suites passed (5/5), the full renderer timeline passed (162/162), and
  renderer state passed (47/47). The built renderer contains only the regular
  and fill WOFF2 assets (about 279 KB total). Live Electron captures at 75% and
  100% showed the complete four-toe paw and consistent shell/View/composer
  glyphs. The Impeccable detector found no icon-specific regression; its output
  remains the existing shell-level contrast, overflow and card-depth findings.
- A follow-up exhaustive pass covered the dynamic surfaces the first pass had
  missed. Sub-agents now use the robot glyph in settings, the side-panel toggle,
  worker avatars and recorded communication; File Manager has distinct new-file,
  new-folder, refresh, attach, save, tree and open-folder glyphs; Terminal keeps
  the terminal-window identity through its empty action. PDF controls,
  diagnostics, plan completion/disclosure, connector disclosure, back navigation,
  selects, checkbox ticks and the send/stop state now share the same Phosphor
  source instead of Unicode or hand-drawn CSS/SVG substitutes. The only remaining
  symbol found by the source audit is the File Manager dirty dot, which is a
  genuine state indicator rather than an action icon. All 47 semantic icon-map
  entries have a bundled glyph rule. Typecheck, production build, five focused
  renderer suites (256/256 after the locale repair), the focused i18n rerun (7/7),
  and `git diff --check` passed. The detector was rerun once after the edits and
  reported only the pre-existing shell-level contrast/overflow/card findings.
  The isolated Vite/Electron dev profile was restarted on port 5173; a live
  Windows capture confirmed the shared glyph weight in the shell, project/chat
  groups, Pets entry, terminal toggle, composer controls and active overlay.
  A live review then caught the Send button rendering both its arrow and hidden
  Stop glyph because the later-loaded icon stylesheet won the display cascade.
  The button now owns one glyph and the renderer changes that glyph's class at
  the existing send/stop state boundary. A focused test proves Stop → Send →
  Stop transitions, typecheck and `git diff --check` pass, and a clean dev restart
  on port 5173 visually confirmed the single centered arrow.
- After the dev CSS fix, six focused Pet test files passed (14/14 tests), and
  `git diff --check` passed.
- Seven focused pet suites: 28/28 passed. The two focused IPC Enable/Disable
  tests: 2/2 passed. `git diff --check`: passed.
- `scripts/verify-pet-overlay-electron.cjs` ran the built main, preload and
  renderer in isolated userData. It asserted native-size frame mapping, visible
  non-clipped pixels, a native pointer drag to (333,444), task badge/card
  rendering through the preload channel, visibility after minimizing its CoS
  owner window, and position restoration after a second full Electron launch.
  Both launches passed. A Windows compositor screenshot showed the pet and
  task tray above the desktop while the isolated owner was minimized.
- The same Electron smoke now passes against `http://localhost:5173`: the CSS
  cell is 160×160, visible art is 74×113 physical pixels at 1.2 DPR, and drag,
  Tasks, and owner minimize still pass. It also asserts a hit-tested native
  drag region on the main titlebar. A live Windows mouse drag from the center
  of that bar restored the maximized CoS window and moved its native bounds
  from `(-8,-8,1928,1040)` to `(72,67,2013,1109)` while Pets were active.
  A live screen capture showed both active pets over the main window after the
  CSS fix. A second capture after minimizing the main window showed both pets
  still visible above a different desktop app; the main window was restored.
  The test used an isolated temporary profile, not production userData.
- `npm run verify` reached the full Vitest suite after privacy, notices and
  typecheck passed. It exposed failures outside Pets (including an IPC test
  still expecting Chrome rather than the current internal browser, plus layout,
  startup/input, project and plugin-refresh tests). The broad run was stopped
  after these failures; it is not a passing gate.

Still unproven: click-through over another desktop app, task updates from a
real session/swarm, packaging and installed
payload behavior. The isolated smoke proves the renderer and native window
path, not those later evidence levels.

## 2026-09-18 — Pets library UI refinement

- Pets now follows the Plugins page's help-row, dialog, two-column card and
  responsive patterns. The import specification moved out of the inline
  accordion into the existing dialog style. The short help copy leaves room
  before its action, cards in a row share a height, and each Active/Inactive
  status stays at the card's lower-right corner.
- The delete confirmation now identifies the selected pet with its preview,
  separates the consequence from the controls, focuses Cancel first, and
  closes after Delete only when the library mutation succeeds. Card action
  menus in Pets and Plugins share one outside-click/Escape dismissal owner.
- Validation: focused Pets and Plugins UI suites passed (15/15), the earlier
  Pets/i18n focused run passed (8/8), `npm run typecheck` and `git diff --check`
  passed. The scoped layout detector found no issues in the changed menu/dialog
  code. A clean Vite/Electron dev launch reached port 5173; the grid was
  visually checked, but the redesigned delete dialog was not captured in a
  reliable live screenshot. No package or installed-payload claim is made.

## 2026-09-18 — mainstream port and scheduler integration

- Ported the overlay/library onto the current mainstream baseline without the
  Internal Chromium dock or its renderer/menu APIs. External browser and companion
  setup remain the mainstream authority.
- Replaced the overlay's permanent RAF with one earliest-deadline scheduler shared
  by all enabled pets. Timers own authored frames and autonomous decisions; RAF is
  reserved for continuous movement and prop interpolation. Visibility, reduced
  motion, pointer mutations, library changes, and disposal reschedule or cancel the
  same wake owner.
- Corrected imported-pet deadlines to use that pet's own `animations.json` for both
  frame and animation-duration calculations.
- Focused typecheck and six Pets suites passed (34/34). The isolated Electron
  performance check passed: idle measured 2.25 RAF/s, reduced motion and hidden
  measured 0 RAF/s, and no renderer console errors were reported. This is source
  and isolated-renderer evidence, not package or installed-payload evidence.
- The broader focused boundary run passed 176/176 tests; renderer translations
  passed 15/15; production build and notices passed. The full non-shutdown suite
  passed 5,307 tests with 44 skipped except for one Windows PowerShell pipeline
  test that exceeded its 30-second timeout under full parallel load. Its exact
  isolated rerun passed in 1.44 seconds; the separately gated shutdown suite
  passed 6/6. No Pets, icon, connection, or renderer test failed in the final run.
- The built overlay smoke passed twice with isolated userData. It measured the
  CSS body at exactly 160×160, the visible sprite at 74×113 physical pixels,
  dragged to and persisted `(333,444)`, retained that position after a full
  Electron restart, kept the overlay visible while its owner was minimized, and
  restored the owner on a short click without changing its Settings screen.
