# Tur Tur Sahur pet — implementation and acceptance

Implemented 2026-09-17 in the existing Electron/TypeScript/DOM app. No additional
runtime dependencies, provider calls, React, game engine or live AI generation.
The installed release has not been replaced; validation launches the actual built
main/preload/renderer with isolated local userData.

## Behavior

- Composer pet button, floating local sprite, left-pointer dragging and landing,
  click reaction, repeated-click anger, keyboard support and right-click menu.
- Hide/reset, validated local visibility/position persistence, viewport clamping,
  light/dark appearance and reduced-motion support. Hidden pets stop their RAF.
- One state owner cancels actions and removes props on hide, drag or resize.
- Idle/look/walk scheduling with alternating specials after a 45-second cooldown.
  Both specials can also be started directly from the context menu.
- Three bat strikes and a heavier hit turn plain `OpenAI` into `ClosedAI`;
  `Anthropic` attaches to the hands, is carried and thrown into a reacting bin.
- Text has a white outline/shadow, no rectangular background, and lower stacking
  than the character. Measured hand anchors and a continuous release trajectory
  prevent face overlap and discontinuous throw attachment.
- Corrected idle registration and removed action-start teleportation after live
  feedback. Click/poke reaction slowed from 570 to 870 ms at the user's request;
  special-action attack timing remains unchanged.

## Files

Runtime: `src/renderer/pet.ts`, `pet-machine.ts`, `pet-choreography.ts`, `pet.css`,
and `pet-assets/*`. Shell integration adds the import and initialization in
`src/renderer/main.ts`; seven strings are added to the existing es/zh-CN/zh-TW
locale catalogs. `AGENTS.md` describes the feature owner.

Tests: `test/pet.test.ts`, `pet-dom.test.ts`, `pet-atlas.test.ts`, and
`pet-choreography.test.ts`. Existing renderer state/timeline fixtures isolate the
new component with the same mock pattern as the terminal, while the dedicated
DOM and real Electron tests exercise the actual component.

Production: `scripts/pet-plan.mjs`, `ingest-pet-batch.mjs`, `build-pet-atlas.mjs`,
`build-pet-props.mjs`, `build-pet-live-previews.mjs`, `verify-pet-electron.cjs`.
See `PRODUCTION.md` for exact export/regeneration commands and animation allocation.

## Assets

`src/renderer/pet-assets/atlas.png` contains exactly 96 unique transparent frames
in 160-pixel cells. `animations.json` gives durations, loops and hand anchors.
The atlas is about 225 KiB. Launcher, separate early-frame bat and bin variants
are local original PNGs. No OpenAI or Anthropic logos or brand styling were used.
ImageGen produced the artwork in sequential six-pose 3×2 batches. No native
Codex hatch tool was available in this session, and none is claimed as used.

`contact-sheet.png`, `atlas-validation.json`, approved base, original batches,
individual crops and repaired idle source remain here. `previews/` contains all
animation clips plus `openai-live.gif` and `anthropic-live.gif` from real app
recordings. The live GIFs are capture-rate previews; runtime is RAF-driven.

## Verification

- `npm run verify`: **passed**, 5,007 tests plus the six isolated shutdown tests;
  44 intentionally skipped. Includes typecheck, privacy and notices checks.
  Two timing-sensitive non-pet failures in an earlier run passed their targeted
  rerun (306 tests); the final full run then passed cleanly.
- `npm test -- --run test/pet.test.ts test/pet-dom.test.ts test/pet-atlas.test.ts test/pet-choreography.test.ts`:
  **20 passed**, repeated after the final poke-duration change.
- `npm run typecheck` and `npm run build`: passed after final runtime changes.
- `node scripts/build-pet-atlas.mjs`: 96/96 unique nonempty frames. Tests inspect
  decoded atlas bounds, transparent cell margins, timing allocation and idle
  bounds differing by at most one pixel.
- `node_modules/.bin/electron scripts/verify-pet-electron.cjs --fresh`:
  full production main/preload/renderer, real Chromium mouse input, both specials,
  click/anger/drag/landing, hide-during-action cleanup, reset, light/dark, zoom
  80/100/125/150%, resize and reduced-motion emulation. No renderer console errors.
- `--restart`: saved visibility and position restored exactly when within bounds,
  otherwise clamped to the current viewport. The app restores its own UI zoom,
  which can differ from the smoke test's temporary Chromium zoom. No errors.
- Native Windows inspection independently confirmed the launcher/menu, dragging,
  landing and corrected Anthropic carry/text layering. Captured real-app frames
  were visually inspected for both action contacts and theme presentation.
  The complete interaction matrix is automated Electron evidence, not a claim
  that every case was separately repeated by hand.

Logs/screenshots/recordings are under ignored `outputs/tur-tur-pet/`, including
`verify-completion.log`, `build.log`, `electron/result.json`,
`electron/restart-result.json`, and final-check captures.

## Shared-tree preservation

Before edits, 57 existing modified/untracked files were copied and hashed under
`outputs/tur-tur-pet/baseline*`. Final comparison found 50 byte-identical files and
all original lines retained in all 57. Six changed files contain pet additions;
`test/input-delivery-integration.test.ts` gained a separate concurrent test block
which this task did not edit. No reset, clean, checkout, commit or broad reformat
was performed. `outputs/tur-tur-pet/preservation.json` records the comparison.
