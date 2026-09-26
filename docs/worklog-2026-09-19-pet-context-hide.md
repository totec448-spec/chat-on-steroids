# Pet context Hide — 2026-09-19

## Scope and ownership

- Added a per-pet **Hide pet** action to the desktop overlay context menu.
- The first implementation incorrectly routed Hide through `pets:enabled`.
  This made the last hidden pet inactive and View > Desktop pets opened the
  library instead of restoring it. The corrected action uses a narrow
  overlay-only IPC, validated against the overlay sender and an enabled pet id.
- `pet-library.ts` remains the only owner of persistent Active membership.
  `pet-overlay.ts` owns temporary dismissals in process memory and projects
  them to its renderer. It prunes disabled/deleted ids and clears dismissals
  when View turns Desktop pets on; it adds no timer or saved preference.
- Library Enable makes the overlay visible while preserving dismissals of
  other pets. The View toggle remains the explicit restore-all action.

## UX

- Hide sits after the animation and reset actions, separated from them, while
  **Open pet library** remains available beside it.
- Menu placement measures its rendered height so the additional row remains
  inside the desktop work area.
- The separator is decorative and hidden from assistive technology; the menu's
  existing focusable button behavior is unchanged.
- The favorite's task badge moves to another visible pet when its anchor is
  dismissed, then returns when View restores that favorite.

## Validation

- `npm run typecheck` and `npm run build`: passed.
- Seven focused Pet/library/activity/IPC files: 118/118 passed. They cover
  multi-pet dismissal/restoration, badge migration, library membership and
  last-pet View restoration.
- Built Electron smoke passed through main, preload and renderer. The menu
  stayed inside the work area; Hide kept Tur Tur Active, hid the empty overlay,
  and the View visibility command restored the pet at its persisted position.
- The Impeccable detector found only the overlay's pre-existing drag easing;
  no visual-design change was made to that unrelated motion.
- `npm run verify` passed privacy/notices/typecheck and reached 5,453 passed,
  44 skipped, 4 failed tests in unrelated code-mode, exec-hints and session
  timing cases under the broad Windows run. Those three complete files plus
  `mcp-shutdown` then passed 310/310 when rerun alone. The broad gate is not
  reported as green.
- No package, installer or installed-runtime claim is made.
