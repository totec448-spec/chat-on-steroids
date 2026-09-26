# Assistant response streaming — 2026-09-19

## Scope

Smoothed the visible delivery of canonical assistant-message revisions and added a response
copy action. This is renderer presentation only: the recorder, session store and extension
remain the owners of message content and publication timing.

## Implementation

- Live append-only revisions now reveal their newly recorded characters over a bounded series
  of animation frames instead of appearing as roughly 400 ms blocks.
- The reveal cadence now paints near 50 fps and spans at most 460 ms for an interim revision,
  slightly slower than before so adjacent recorder bursts visually overlap instead of reading
  as separate pulses. Final catch-up remains independently bounded at 220 ms.
- The reveal catches up within 360 ms, accelerates final text, preserves surrogate pairs and
  bypasses animation for corrections, large revisions, hidden windows and reduced motion.
- Historical messages render immediately. Each live assistant row keeps its canonical DOM
  identity while revisions arrive.
- Sending elects the live tail before the asynchronous outbox refresh, so the pending user
  message is visible above the composer immediately. Live assistant revisions keep following
  that tail until an explicit upward reader gesture; returning to the bottom resumes following.
- The final assistant message of a turn ends with a quiet Phosphor copy action; partial messages
  keep it hidden so controls never interrupt the response/tool sequence. It uses the existing
  fixed preload clipboard bridge and copies the complete canonical Markdown.
- Immediate sends arm a small three-dot thinking indicator beneath the authored message, but
  it becomes visible only when that message's existing confirmation check is rendered. It is
  renderer-only, disappears on the first visible model activity or reported chat error, and
  self-retires after two minutes without adding polling or execution authority.
- The thinking row now reserves its final layout space while delivery is pending. Confirmation
  reveals that same node without changing message, indicator or viewport geometry; message and
  indicator entrances use opacity only, so crossing a fast receipt cannot produce opposing
  vertical jumps. The pending clock and cancel action share a 22 px slot and 15 px glyph size.
- Queue refreshes retain the reader's real live-tail policy when they repaint retired automatic
  input projections. They no longer force a non-following viewport for the roughly 400 ms before
  the coalesced canonical history reload, which was visibly moving the transcript down and back.

## Validation

- Mainstream and Internal Chromium: 272 timeline/layout/model/composer tests passed in each
  repository. Coverage includes the authored message, live-reply follow, explicit upward-scroll
  release and return-to-bottom contract.
- Focused streaming tests prove an intermediate partial reveal, exact final text, reduced-motion
  bypass, stable row identity, complete clipboard content, thinking dismissal on response/error,
  the check-before-thinking sequence, and the bounded fallback timeout.
- Typecheck and `git diff --check` passed in both repositories.
- The real Electron input-queue harness passed 16 checks in both repositories, including
  sub-pixel-stable message/thinking positions, unchanged scroll position and matching pending
  status/cancel dimensions across the delivery transition.
- The harness now uses the recorded 1028×546 viewport, an overflowing prior answer and a retained
  scroll reserve, then stages queued → sent → canonical history separately. It requires the prior
  answer, user bubble, thinking row and scroll position to remain stable within one CSS pixel.
- Frame analysis of the reported 30 fps recording measured the defect as an instantaneous 28 px
  viewport shift lasting 13 frames (about 0.43 s), matching the session reload debounce.
- Impeccable detector reported only the pre-existing `side-tab` warning outside this change.
- Internal Chromium Windows x64 packaging and packaged-runtime smoke passed. The unsigned NSIS
  installer was produced as `release/Chat-On-Steroids-Setup-x64.exe`.

## Presentation pacing follow-up — 2026-09-20

- Replaced the per-revision deadline, which made large recorder batches race and small batches
  pause, with one renderer-only backlog consumer. Appended canonical revisions now extend the
  existing visual stream without restarting it.
- Presentation runs at a 32 ms paint cadence with a stable base rate, bounded adaptive catch-up
  and small punctuation weights. Final publication no longer dumps its remaining text inside a
  separate 220 ms sprint.
- The copy action remains hidden until the final canonical text is also fully visible. Reduced
  motion, corrected revisions, hidden windows and oversized deltas still settle immediately.
- No recorder, store, IPC, preload or main-process timing changed. Mainstream and Internal
  Chromium contain the same reveal implementation and tests; their shared assistant-rendering
  section is byte-identical.
- Both repositories passed typecheck and the three focused streaming/reduced-motion scenarios.
  The full 198-case renderer timeline suite reached 196 passes, and its only two old 200 ms
  paint-deadline assertions passed after being updated to await the new visual completion
  contract. `git diff --check` passed in both trees.
- Confirmation feedback now crosses one actual paint before the first response glyph. When a
  confirmed user receipt and assistant snapshot arrive in the same coalesced read, the check and
  three-dot indicator remain visible until presentation begins instead of being retired by data
  the user cannot see yet. Tool activity and errors still retire waiting immediately.
- A completed provider turn remains visually working while its final assistant projection has a
  reveal backlog. “Worked for…” and its green check are published by the final reveal callback,
  after the complete response is visible.
- Mainstream and Internal Chromium passed typecheck, six focused presentation contracts and the
  complete 199-case renderer timeline suite after this follow-up.

## Writing blocks, Settings scroll and visual duration — 2026-09-20

- Agents & automation no longer inherits the conversation scroller's bottom position. Entering
  that Settings destination starts at its heading; returning to chat restores the prior timeline
  position instead of moving the reader.
- Background timeline reconciliation, history paging and reveal frames no longer mutate the
  shared scroller while Agents & automation owns it. Wheel and pointer input on that page also
  stay page input instead of being interpreted as conversation-history navigation.
- Assistant `:::writing{...}` directives now render as bounded titled document surfaces. Their
  body keeps the existing Markdown renderer and sanitizer, malformed headers remain ordinary
  text, attributes are bounded, and an unclosed body can render while the canonical answer is
  still streaming.
- Turn duration now follows the renderer's existing presentation state: seconds continue while
  the fake stream has a visible backlog, then settle to the recorded `turn_end` duration at the
  same moment as “Worked for” and its completion check.
- Mainstream and Internal Chromium share the same parser, presentation-state repair and focused
  tests. No recorder, session, IPC or browser-delivery contract changed.

## Composer completion handoff — 2026-09-20

- The composer keeps its filled Stop shape until the last canonical response glyph is visible.
  While a real turn or queued delivery still exists, the established backend Stop/Cancel paths
  remain authoritative. After the backend has completed, the short remaining presentation-only
  state is explicitly local: clicking it reveals the already recorded remainder and never calls
  `stopSessionTurn`.
- Tool-heavy turns with no assistant text continue to follow backend controls alone; a text
  projection is not treated as proof that work exists or has ended.
- Reveal pacing increased by roughly six percent at base, catch-up and final speeds. Cadence,
  punctuation weighting, bounds, reduced motion and canonical message ownership are unchanged.
