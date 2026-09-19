# Finished native answer retained as generating

## Observed failure

The native page showed a completed answer while the desktop session retained its open
generation. The session recorded that answer as `final: true` / `state: final`, with a
provider message UUID, but without a local `turnId`. The last recorded local tool preceded
the final answer. No later tool call caused the active state in this incident.

A prior attribution-recovery reload occurred during the generation. The later silence
reload reassigned the same canonical final message to the original turn and recorded its
completed boundary. The recovery input prepared before that observation was then cancelled;
the cancellation card was not a native send receipt. Read-only native DOM and Fiber inspection
after recovery confirmed the same final UUID and no native Stop control.

The exact browser transient at the earlier reload was not captured. The persisted failure
is established; the two reproducible ownership gaps below explain ways to produce it and
are separately tested rather than presented as an observed historical stack trace.
Private diagnostic identifiers and session inspection stay in ignored
`outputs/finished-turn-20260919/`.

## Changes

`generationTurn()` previously kept an interim section as long as that node stayed mounted.
A separate terminal section could therefore be recorded as final without belonging to the
open local generation. It now follows a newly mounted section only while the latest native
question is the exact question already owned by that generation. Existing pre-Send nodes
cannot take ownership merely by moving or changing their contents.

Activity adoption previously ran only behind the initial identity gate. An empty or refused
first response could consume that opportunity before the durable turn appeared. The existing
activity feed can now adopt later, before the document has owned any generation, with exact
current-question proof. Manual Stop, another generation and bootstrap custody remain vetoes.
Replaying the same activity after completion cannot reopen the turn.

Both changes reuse native final capture and the existing recorder completion path. No new
idle timeout, completion heuristic, synthetic Send or separate lifecycle authority is added.
Unrelated working-tree changes, including worker-status presentation, are preserved.

The completion is a real lifecycle transition: the exact native terminal emits the original
turn's completed boundary, and the recorder clears that active turn. This also applies when
identity becomes available only after reload. An obsolete automatic Continue is refused
before Stop or Send; enabled Goal/Loop keeps its own normal completed-answer policy. Running
local tools retain their separate delivery fence without invalidating the native final.

## Validation

Three reproductions failed before the production change: separate final section, first
activity empty, and first activity refused. Each recorded the terminal with no `turnId`.
The expanded seven cases also exercise another question, missing/mismatched question proof,
manual Stop, duplicate activity and exactly one completion after adoption.

The four focused suites passed all 950 tests. The complete `npm run verify` process exited 0:
5,364 tests passed and 45 were skipped in the main run, followed by all six separately executed
shutdown tests. Total: 5,370 passed and 45 skipped. The completion of that original process was
read back rather than launching a replacement verification run.

A final targeted pass selected 25 reload/completion/Continue cases across
`content-script`, `completion-input-integration` and `input-delivery-integration`; all passed.
It includes late exact adoption, one completed boundary, old-question and manual-Stop vetoes,
and cancellation of recovered text/image Continue inputs under Off, Goal and Loop. The 890
other cases excluded by that pass's name filter are not additional skipped production checks.

`npm run build` exited 0 and generated main, preload and renderer outputs in `out/`. Vite
reported three mixed static/dynamic import warnings; they did not fail the build. The extension
ships unbundled, so its changed `content.js` remains a separately tested source payload.

The hashes of `extension/content.js` and `test/content-script.test.ts` matched the snapshot
taken before full verification and were checked again at completion. The original full run
describes its tested shared-tree snapshot; concurrent unrelated edits are not retroactively
covered by that result. The source snapshot, verification/build logs and final hashes remain
under ignored `outputs/finished-turn-20260919/`.

No running installation or extension payload was replaced. Live DOM/Fiber inspection establishes
the incident and its existing reload recovery, not deployed acceptance of this new source fix.
