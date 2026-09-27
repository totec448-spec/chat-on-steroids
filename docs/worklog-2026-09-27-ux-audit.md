# UX audit and activity presentation — 2026-09-27

## Scope and owner

Reviewed the renderer timeline, worker drawer, model choices, composer, Appearance preview,
Settings copy and semantic appearance tokens. The recorded session and tool events remain the
only source for the new presentation. No outbox, worker broker, model-discovery or browser
authority changed. The requested language-mix critique concerns authored model text and was
left outside this UI change.

## Changes

- The existing activity disclosure now folds five or more adjacent successful agent-status
  checks or waits on the same process. It retains every original tool row and its open state;
  a failed call breaks the sequence. A directly preceding recorded progress row can name the
  activity group without inventing a task phase.
- Tool rows with shell calls or file changes get compact artifact styling, typed tags and
  recorded diff totals. Expanded arguments/results have a header and a Copy action through
  the existing bounded preload clipboard method. Approximate diff totals are marked as such.
  Rendered assistant code blocks gain an app-owned header and Copy action after HTML sanitization.
- The read-only worker drawer shows each worker's scoped id, current broker task when known,
  otherwise its original assignment, observed model, broker status and elapsed time. Its
  existing click action continues to open that worker's timeline
  in the split pane without changing the prime composer.
- The sidebar places its activity spinner before the title. The model selector and pet launcher
  have clearer containers; the existing estimated context ring shows a compact estimate.
- Recovery timing detail moved into an expandable Settings row. Unverified saved model choices
  have a separate badge. The Appearance sample now shows a chat message, command and status
  using the same live color and typography tokens as the app. Popovers use a distinct semantic
  surface above cards.
- New static/dynamic labels were added to all seven translation catalogs. Authored assistant
  prose remains in its original language.

## Independent review

A separate review agent inspected the implementation and found a grouped-title regression,
an inferred worker state, an unmarked approximate diff total, a stale worker task and two
labels that would stay in the old UI language. A final pass also found that a failed worker
could still be listed under Active while recent session activity remained. The grouping now
uses the broker state when available. The source has no typed commit-hash artifact event, so
it does not promote arbitrary
tool-output text into a commit card or claim a commit happened.

## Evidence

- Source review: session activity and worker metadata are projections of existing recorded
  data; no wire or durable schema changed.
- `npm run typecheck`: passed.
- Focused renderer tests: 91 passed across agent panel, model, context, appearance, HTML and
  layout suites. Timeline regression checks passed for the five-poll threshold, original-row
  retention, incremental repaint, and a failed-call boundary.
- Full `test/renderer-timeline.test.ts`: 188 passed on the first full run; a targeted run passed
  after the subsequent phase-label adjustment.
- `npm run build`: passed for main, preload and renderer. Existing Vite dynamic-import notices
  appeared; no build error.
- `npm run verify`: first pass found only seven missing static translation keys. The catalog
  correction passed all six locale suites (28 tests). The full pass exited 0: 214 test files /
  5,757 tests in the main run and 6 tests in the isolated final run, including typecheck,
  privacy and notice checks. The focused renderer run passed 238 tests. After the last
  review correction to worker grouping, typecheck, all 6 panel tests and production build
  passed on the final source.
- Isolated Electron scripts passed for dropdown layout at two zooms/two themes, Settings focus
  geometry and chat width at three zooms/three widths. `verify-appearance.cjs` stalled before
  writing a screenshot when launched with this host's Nix Electron; it was stopped after about
  90 seconds. The bundled Electron executable could not launch directly on NixOS because it
  needs the host's dynamic loader. Appearance color behavior remains covered by unit and build
  evidence, without a completed screenshot fixture in this run.

This is source/build evidence. No installed payload or signed-in ChatGPT run was exercised for
this renderer-only change.

## Upstream rebase

Rebased the UX commit from the fork's 2.1.14 `main` onto upstream 2.1.16 at `62fccc4`.
Upstream added European Portuguese after the original audit, so the same 13 new labels were
translated in `pt-PT.json`. The first rebased verification run reported only that missing
catalog coverage; after correction, the Portuguese suite passed all 5 tests. On the corrected
rebased source, `npm run verify` exited 0 with 220 test files / 6,024 tests in the main run and
6 tests in the isolated run; `npm run build` also passed. This validates the source and build,
not an installed payload or a signed-in browser session.

## Model selector spacing follow-up

The selected-model chip had a fixed 164px width, leaving broad empty space around short labels.
It now sizes to its contents with the existing 164px cap (120px in narrow layouts), and its
popover aligns to the chip's right edge. An isolated Electron layout check measured the
`5.6 · High` chip at about 100px with 9px of space on each side at 500, 760 and 900px viewports;
the popover stayed within each viewport.

Settings model pickers also had two presentation problems: account families with the same short
label were indistinguishable, and the native reasoning picker wrapped “Medium” in its narrow
field-width popup. Settings choices now append the observed lane (`Instant`, `Reasoning`, or
`Pro`) only when duplicate labels need disambiguation. The Settings picker keeps its field as a
minimum width, sizes to its longest option within a viewport bound, and keeps options on one line.
The focused model test passed 25 tests, the production build passed, and the isolated Electron
picker check showed 36px single-line options for both model and reasoning pickers at 500, 760 and
984px windows. The repository dropdown fixture also passed at both themes and zoom levels.
