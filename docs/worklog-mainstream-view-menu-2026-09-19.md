# Mainstream View menu port — 2026-09-19

## Intent

Port the polished View menu from Internal Chromium into mainstream without importing the
Internal Chromium browser control. Pets must be the first item.

## Ownership

- `main/view-menu.ts` owns the transient native `WebContentsView`, bounds, focus/blur closure and
  the fixed command allowlist.
- `preload/view-menu.ts` exposes only the menu's five commands and snapshot subscription.
- The shell renderer remains authoritative for Pets visibility, Sidebar state and zoom.
- The menu renderer only projects translated labels, checked states and Appearance tokens.

## Lab provenance audit

The first port was compared against the newly separated Internal Chromium tree rather than the
approved frozen lab ref `archive/port-fork-delta-2026-09-18`. That was not a safe source choice:
the separated tree had replayed the Internal-browser commits before the later cross-cutting
`bb5fae6` Pets/icon commit. When that common commit was moved to mainstream, its hunks for
Internal-only files were omitted and never restored by the subsequent merge.

The first focused comparison found four production differences in the menu and a missing
Internal renderer test. The required broader audit then found a second production loss outside
View: a mainstream-only Connection Advanced cleanup had also removed the Internal host adapter
after the repositories were merged. That adapter and its regression are restored in Internal.
The complete path/commit/test matrix is recorded in
`docs/worklog-lab-port-integrity-audit-2026-09-19.md`; this focused worklog must not be read as
proof that View was the only affected subsystem.

The Internal copy of the three View renderer files and recovered renderer-motion test now hash
exactly to the approved lab blobs. Mainstream carries the same Phosphor action/check markup with
only the Browser row and its state removed. Both projects assert the exact Phosphor contract.

## Validation

- `npm test -- --run test/view-menu.test.ts test/sidebar-resize.test.ts test/renderer-state.test.ts test/renderer-layout.test.ts test/ipc.test.ts` — 183/183 passed.
- `npm test -- --run test/view-menu-renderer.test.ts test/view-menu.test.ts` — 8/8 passed.
- After the provenance repair,
  `npm test -- --run test/view-menu-renderer.test.ts test/view-menu.test.ts test/sidebar-resize.test.ts`
  — 9/9 passed; `npm run typecheck` passed.
- Internal Chromium: `test/view-menu.test.ts`, `test/internal-browser.test.ts` and the restored
  `test/internal-browser-renderer.test.ts` — 18/18 passed; `npm run typecheck` passed.
- `npx electron scripts/verify-view-menu.cjs` — passed at the app's 1.17 base zoom; dark and
  light captures fit without overflow, expose five commands, start with Desktop pets, contain no
  browser item, load `CoS Phosphor`, and contain no inline action SVG.
- Impeccable layout detector on `view-menu.html` and `view-menu.css` — no findings.
- `npm run build` — passed and emitted the View-menu renderer and preload bundles (existing Vite
  dynamic/static import warnings only).
- The later full integrity audit reached privacy, notices and typecheck in both projects. The
  parallel Vitest phase produced load-sensitive failures, all of which passed in isolation; see
  the integrity worklog for exact totals and the remaining shared Settings-focus visual debt.
- `git diff --check` — passed.
- Mainstream dev restarted against the normal user profile; startup reached `window loaded` with
  the new main/preload bundles.

`scripts/verify-pr-workspace.cjs` was updated to stop looking for the deleted DOM menu and to
finish the finite panel transitions it deliberately starts before measuring layout. The focused
View probe remains the menu-specific visual acceptance; the broad fixture also covers its shell
trigger alongside Files, diagnostics, Skills, Projects/Chats and localized Settings.
