# Message delivery and queued editor corrections

## Report and diagnosis

An active-chat message with seven image attachments lost the Inject now choice and
appeared as a queued task. Its editor could reject Save as no longer queued, omit
the Remove action, reject whitespace-only text, and survive selecting New Chat.
Further sends could report that a message was already waiting without presenting
that pending delivery consistently.

The original outbox record confirmed a native upload with `mode=after-turn` and
`requestedMode=auto`, subsequently cancelled by the user. Main treated this as an
immediate message waiting for native upload. The renderer's separate, broader
`queuedFollowup` predicate instead offered a task editor that main could not edit.
The existing editor retained its DOM on a negative Save receipt. New Chat cleared
`inputQueue`, but left the independent `finishQueue` editor mounted.

The missing injection choice for seven images was the existing four-image limit.
The user explicitly requested increasing that limit to ten after this was identified.

## Changes

`shared/input.ts` now owns the existing immediate/queued intent classification for
both main and renderer. Native uploads that retain immediate intent appear as
pending deliveries with Cancel instead of an invalid queued-task editor. The
existing serialized outbox and transport election remain the delivery authorities.

Queued editors retain Remove below Save. Whitespace-only Save invokes the existing
cancellation operation. A successful cancellation removes the editor immediately,
even when the subsequent outbox refresh is delayed. A negative edit receipt retires
the editor and refreshes the actual delivery state; a transport error preserves the
unsaved draft. Selection changes retire queued editors synchronously, and generation
checks prevent a delayed old response from changing a newly selected editor.

`MAX_INPUT_IMAGES=10` is shared by image eligibility, admission, normalization, tool
response batching and retained history previews. The existing source-file, pixel,
normalized-image and aggregate image-queue byte limits are unchanged. Ten very large
images can still exceed the byte budget and produce an explicit size error. Native
file upload retains its existing separate limits.

## Verification

The new focused regressions were run before the production changes and exposed ten
failures matching the reported editor, selection and four-image behaviors. After
the changes, fourteen focused checks passed, followed by the complete project gate.

The final `npm run verify`, with `CLF_BRIDGE_PORTS=0` and `CLF_EVIDENCE_MS=1500`,
completed with exit code zero: 5,285 tests passed, 45 skipped, then all six separately
run shutdown tests passed. The gate also passed privacy, notices and TypeScript
checks. Relevant suites included all 174 renderer timeline tests, 185 session-input
tests, both image/MCP integration cases and all 20 desktop-helper tests.

The first complete run exposed two fixture assumptions, corrected before the final
run: the old four-image companion boundary and a fixed request ID reused across
parameterized MCP cases. A desktop foreground-focus assertion also failed in that
first run and passed in the final run without a concurrent Electron fixture.

`scripts/verify-input-queue.cjs` passed all nine checks using the production renderer
and CSS in isolated Electron/Chromium with a fixture API. Captured screenshots were
visually reviewed at 1100- and 640-pixel window widths. Save and Remove fit correctly,
with Remove below Save. The checks cover empty Save, Remove during editing, New Chat,
an unavailable queued row, visible pending native upload and seven-/ten-image menus.

The isolated HTTP MCP integration verifies seven staged image attachments arriving
together in an exact-session tool result, alongside later corrections, with receipt
on the next invocation. Additional tests cover the ten-image batch boundary,
eleven-image rejection, aggregate byte-budget enforcement and all ten retained
previews transitioning into canonical history.

`npm run build` completed with exit code zero. `git diff --check` passed for the
touched implementation and test files. Existing build chunking warnings remain.

Local verification outputs are under `.tmp/message-send-20260918/`:
`verify-final.log`, `build.log`, and `ui/result.json` with two editor screenshots.

## Delivery boundary

Changes are local source and built output in the existing working tree. Unrelated
changes were preserved. No live outbox records were edited, and no provider messages
were sent for acceptance. The active orchestration browser tab refused attachment;
that boundary was respected. No installed-app replacement, restart, package release,
commit or push was performed by this task.
