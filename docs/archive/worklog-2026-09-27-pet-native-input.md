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

## Windows focus return

- The user reports no Pets entry in Alt+Tab. This is manual Windows evidence,
  not an automated switcher check or a guarantee for other Windows versions.
- The user confirmed that dragging interrupts typing. A native-input probe also
  observed the overlay remaining focused after pointer-up.
- A plain Electron `blur()` experiment did not reliably restore the original
  foreground HWND: a second, installed Pets overlay could receive focus instead.
- Recording `WM_ACTIVATE`'s previous window and reordering before blur worked for
  an in-process owner, but the native message supplied no previous HWND when an
  independent Windows Forms text field was the foreground target. That experiment
  was rejected; neither experiment was added to production.
- The user authorized a narrow native implementation. Windows foreground events
  (`EVENT_SYSTEM_FOREGROUND`) identify the external window before Pets takes focus.
  A completed/cancelled drag makes one `SetForegroundWindow` attempt only if Pets
  still owns foreground and the previous visible/enabled/non-minimized window has
  the same process/thread identity. A normal click retains the existing CoS action.
  No polling, retry timer, synthetic input or Desktop tool authority was added.
- Review rejected the later `WM_ACTIVATE` substitution and the call to restore
  focus during overlay teardown. Teardown revokes custody; it must not choose a
  foreground window. The host-test mock remains appropriate for isolation only.
- Electron did not deliver `WM_MOUSEACTIVATE` to the JavaScript hook, so that
  experiment was replaced rather than retained as a fallback. The first external
  keyboard fixture also used a hidden PowerShell startup flag which suppressed its
  form's first Show call. Win32 and an independent P/Invoke check both reported the
  fixture invisible before dragging. The test now explicitly shows its owned form
  and asserts visibility; production visibility validation was not weakened.
- Blur/hide revokes the one-use focus return. Closure, renderer loss and shutdown
  dispose the native observer. Async initialization cannot publish after shutdown.
  Cleanup retains the WebContents event emitter instead of accessing it through a
  destroyed BrowserWindow; a real recreation test exposed and covered that error.
  Registered callback lifetime and anonymous prototype permit overlay recreation.
- Koffi is pinned to 3.3.2 and loaded only for Windows Pets. Target packaging reuses
  the lockfile-integrity staging pipeline, excludes foreign/fallback binaries,
  retains the same-version MIT license, and probes the packaged binding. Windows
  x64 package/native smoke passed; Windows arm64/macOS/Linux were not run here.
- Final source validation: typecheck, whitespace checks and 44 focused tests passed.
  Native Windows input passed five drag/keyboard checks, including disable/re-enable,
  global hide/show and destruction/recreation. Context-menu Hide pet still accepted
  native clicks; hovering did not take focus. Idle atlas decodes remained zero.
  Unit tests additionally cover revoked/recycled targets, late events, cancellation,
  lost capture, foreign IPC senders and shutdown during native initialization.
- Existing committed Pets input/cache fixes remain intact. This work is restricted
  to the upstream-preview branch; neither original fork was changed. No installation,
  commit or push was performed for this focus-return change.
- Final rebuilt Windows x64 unpacked package passed the native runtime smoke;
  all 141 compiled output files matched their packaged bytes. No installer was made.
- Full local verification did not complete. Privacy, notices/native-source inventory
  and typecheck passed; the broad suite was stopped at the user's request to leave
  that validation to CI. Its workers and child processes were stopped, and no full
  suite success or remote CI result is claimed for these uncommitted changes.
- At the user's subsequent request, generated the Windows x64 NSIS installer with
  `npm run dist:x64`. Packaged native smoke passed (including `petFocus:true`), and
  all 141 compiled files matched the final ASAR. The Downloads copy is named
  `CoS-2.1.16-Pets-Focus-2026-09-27-x64.exe` (170024196 bytes), SHA-256
  `233cfd75b5a742361f75becbc2f50e5a97afe8cc81bc6300a3f2342dfe5e4162`.
  Copy integrity was checked. Installation/manual acceptance remains the user step;
  the full suite was not restarted, and no commit/push was performed.
- PR handoff authorized afterwards: retain the existing PR title and Pets-only scope,
  document Windows focus restoration and the new dependency/packaging checks, and
  leave the full cross-platform suite to CI. Final pre-commit typecheck and the 44
  focused tests passed again. Startup/correlation restoration remains a separate task.

## Rebase after #542 — 2026-09-28

- Rebased onto upstream main 9040557 after #542 merged. The remaining diff contains
  only Windows activation/focus restoration and its dependency, packaging and tests.
  Library projection and interaction rearming are already upstream, not proposed again.
- Compared the final Pets implementation and focus/host tests against pre-rebase
  3ad6b87: unchanged. Typecheck, all 44 focused tests and diff whitespace checks passed.
- Native Windows input and installer evidence above comes from the earlier build;
  neither was repeated for this history-only rebase. New-head cross-platform CI is
  pending. Acceptance of Koffi/user32 remains a maintainer product/maintenance decision.
