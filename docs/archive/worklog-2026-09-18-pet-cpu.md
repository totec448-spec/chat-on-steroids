# Sahur pet CPU reduction

## Reproduction and cause

Enabling the companion started a permanent requestAnimationFrame loop. On the
200 Hz display the original executed about 200 projections per second, including
unchanged idle frames and a paused context menu. Each projection repeated DOM
queries and assignments. Action props also reset target/hit visibility before
assigning its final value, invalidating styles even when nothing visible changed.

The 96-frame atlas already uses 160 px cells, nearest-neighbor export and a
32-color indexed palette (229,721 bytes). No artwork reduction was needed.

## Change

`PetMachine.nextUpdateIn` derives the next frame, phase or autonomous decision
from the existing animation state. Stationary sprites sleep until that deadline;
walking and hand/throw interpolation still update at display refresh rate. A
settled held pose and reduced-motion idle have no scheduled wake. The machine
counts an intentional long frame hold in full and bounds unexpected lateness to
100 ms beyond the requested wake, preserving the existing continuous-motion stall
bound.

The renderer keeps at most one timeout or animation frame. User interactions
advance the old state before replacing its wake. Opening the context menu,
hiding the document/pet and disposal cancel outstanding work; resuming does not
consume the time spent paused. DOM projection writes changed attributes/styles
only, caches the two action buttons, and assigns final prop visibility once.

All image files, 96 authored frames, per-frame durations, choreography, scale and
CSS are unchanged. No application/provider permissions or backend state changed.

## Measured evidence

`scripts/verify-pet-performance.cjs` builds the real pet modules and production CSS
into an isolated Electron window. These measurements used Electron 44.3.0,
Chromium 152.0.7977.78, hardware compositing, 16 logical processors, a 200 Hz
display, 1100×850 window and zoom 1.17. Math.random is fixed for repeatable
autonomous behavior. CPU is the sum of the fixture's process CPU-time deltas
divided by elapsed time and logical processors, not a system-wide reading.

| Phase | Before CPU | After CPU | Before animation calls/s | After calls/s |
| --- | ---: | ---: | ---: | ---: |
| Idle | 0.841% | 0.043% | 200.2 | 1.8 |
| Autonomous behavior | 0.778% | 0.107% | 200.0 | 21.5 |
| Paused context menu | 0.571% | 0.004% | 200.1 | 0 |
| OpenAI action | 0.877% | 0.292% | 200.0 | 41.2 |
| Anthropic action | 1.321% | 0.960% | 200.0 | 138.0 |

Idle renderer task time fell from 60.2 to 0.86 ms/s. Autonomous renderer task time
fell from 51.2 to 3.79 ms/s. Both hidden and reduced-motion samples had zero
animation callbacks. The new `--check` assertions passed.

Raw local evidence and exact source snapshots are in
`outputs/pet-performance/{before,after}/`. One initial hidden/startup sample
contained regressing process counters and is excluded from CPU comparisons.
The harness now explicitly reports such CPU samples as invalid rather than
counting negative deltas as savings. These are single controlled fixture runs;
they do not reproduce or guarantee the user's whole-app 7% peak.

## Validation

- The new idle/menu regressions failed on the original with respectively 80 and
  2,000 unnecessary calls in their measured windows.
- All 28 tests across `pet`, `pet-dom`, `pet-atlas` and `pet-choreography` passed.
  Coverage includes every authored non-looping action frame with deadline-based
  scheduling, full long holds, motion between sprite changes, interruptions,
  visibility, disposal and bounded unexpected stalls.
- Typecheck and production build passed.
- `npm run verify` passed: 5,238 tests in the main pass and six shutdown tests,
  with 45 explicitly skipped tests. Privacy/notices/typecheck gates passed too.
- `scripts/verify-pet-electron.cjs --fresh` completed against the new production
  main/preload/renderer and isolated userData. Its fresh result records both
  actions, click/anger, dragging, interruption, themes, four zoom/viewport
  combinations, reduced motion, reset and persisted position, with no console
  errors. The heavy-contact and throw screenshots were inspected directly.
- The follow-up `scripts/verify-pet-electron.cjs --fresh --restart` passed on
  September 18 after the user requested delivery. The fresh result confirms
  restored visibility and the saved position clamped to the new viewport, with
  no console errors. Old failure files predate these successful runs.

The user authorized committing, merging a PR and installing this fix, with
installation explicitly last to retain the active tool connection. Delivery
results are recorded separately from the source and fixture evidence above.
