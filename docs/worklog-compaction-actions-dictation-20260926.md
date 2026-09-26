# Compaction receipts, recorded action detail and optional dictation

This follow-up builds on the earlier native rich-content/model/synchronization contribution.
It does not replace Goal/Loop, the continuation transaction, the tool recorder, or the browser
transport. Public test fixtures contain synthetic messages, paths, audio and credentials only.

## Compaction corrections

The destination command acknowledgement and the marked native user row can arrive in either
order. Previously, an ACK-first continuation was already committed when its exact marked
message arrived; the closed-state check refused that valid receipt indefinitely. Conversely,
the marker-first path did not reject a later ACK naming a different destination before moving
the session. The continuation owner now accepts a late marker only for its committed destination
and already-dispatched send, and rejects an ACK contradicting a bound native message.

These changes adapt the ACK-first repair in Haz4rdovisk's [#345](https://github.com/totec448-spec/chat-on-steroids/pull/345).
Independent tests cover both event orders, restore, contradictory destination/message identities,
failed receipt writes, abort and never-attempted sends. No second Send, token or destination is
created to recover missing acknowledgement.

Maximapple's [#395](https://github.com/totec448-spec/chat-on-steroids/pull/395), reviewed at
`0c47ca348ddd35a88cc8cb304fe89cde20e7af06`, identified the separate refusal-admission bug: a page
can lose its active turn while exactly attributed local tools keep working. The old refusal
guard equated that missing turn with stopped work, permanently blocking automatic compaction.
The store now accepts an optional current-work witness, defaulting to false. The existing bridge
owner rechecks its exact native/MCP activity before and after storage awaits. The refused known
turn remains fenced, passive polling cannot refile, and an open continuation still prevents a
second ticket. The regression failed before the change and passed afterward.

The existing global automatic-compaction switch and threshold remain the only configuration.
The context popup now explains the estimate, threshold and Pro/worker/helper exclusions and
links to the canonical settings controls. Opening settings clears a stale search filter; Escape
works from the popup's action and restores trigger focus. No defaults or per-chat automation
permissions are changed by viewing this UI.

### Related work not incorporated

- Bemirror99's [#391](https://github.com/totec448-spec/chat-on-steroids/pull/391) changes pre-Send
  ticket retention/pickup policy and related hydration. It remains a distinct integration:
  this follow-up does not introduce its indefinite retry policy or additional source nudge.
- lavalava45's [#388](https://github.com/totec448-spec/chat-on-steroids/pull/388) changes the
  editable handoff content policy and preferred length. Existing handoff framing, prompt budget
  and explicit oversized-handoff refusal are preserved here.
- The pending-save/move disagreement with [#392](https://github.com/totec448-spec/chat-on-steroids/pull/392)
  and picker transport-label disagreement with [#443](https://github.com/totec448-spec/chat-on-steroids/pull/443)
  remain documented in the parent PR. Neither implementation is stacked onto this branch.

## Recorded actions

`action-details.ts` is a renderer-only, inert projection used inside the existing lazy tool
disclosure. Complete bounded recorded arguments supply patch hunks, commands, paths, ranges,
queries and browser-action metadata. Process completion revisions supersede launch snapshots.
Requested values and observed values are labelled separately. Failed/unknown patch outcomes
cannot become applied edits; delete directives do not invent deleted contents.

Previews share a 24,000-character / 240-line budget, with bounded JSON, fields, list lengths
and Unicode-safe clipping. Original arguments, result, image handling and truncation notices
remain available. There is no current-Git read, filesystem request, URL navigation, replay
button, new permission, persistent preview cache or extra polling loop. #345's Git Changes
workspace and historical snapshot links are separate work, not duplicated or claimed here.

## Dictation ownership and privacy

`dictation-ipc.ts` owns one explicit recording for the current main-window document, followed
by at most one transcription request. Both Electron permission handlers deny everything except
audio for that exact foreground owner during recording. Camera, mixed audio/video, subframe,
foreign-page and idle microphone requests remain denied. The first permission dialogue names
the external service, separate API billing, memory-only audio and draft-only result.

The API key occupies its own encrypted `dictationApiKey` secret slot. No tunnel/Goal credential
is borrowed or returned to the renderer. The provider endpoint is fixed, redirects are refused,
audio/response/text are bounded, and network failures are not automatically retried. Provider
error bodies and credentials are not logged. macOS packaging now deliberately retains the
microphone usage description while still removing unused camera/system-audio declarations.

The renderer records WebM/Opus in memory, displays an actual microphone-level waveform, supports
pause/resume and cancels tracks on close, hide, navigation, draft replacement or failure. After
Finish, streamed transcription is a replaceable preview; only an explicit complete result can
be inserted. Insertion verifies both the original draft generation and its unchanged text,
replaces only the originally selected range, and never submits the composer. A changed draft
offers Copy instead of overwriting newer work. Closing clears the temporary transcript/key field.

Independent review reproduced two async bugs before their fixes: an old Blob read clearing a
new recording's chunks, and a queued native dialog-close handler stealing composer focus after
insertion. Current code detaches its own chunks before yielding and performs close cleanup/focus
in the initiating operation, not a stale close event. Regression tests preserve the next WebM
header and verify focus after asynchronous close.

This is record-then-transcribe dictation, like a recorded message workflow; words stream into
the preview **after Finish**, not continuously to a remote service while the microphone runs.
The separate transcription API incurs its normal billing. It is not ChatGPT voice mode, an
offline speech engine, or a way to spend ChatGPT subscription quota on API calls.

## Validation boundary

Focused transport, IPC, draft, cancellation, size, privacy and permission regressions pass.
The synthetic Chromium verifier uses the production preload, main permission/IPC handler,
MediaRecorder and renderer with a fake audio device and a mocked transcription response.
It verifies audio-only capture, camera denial, one upload, ended tracks, cancellation, draft-only
insertion and centered layouts at 1200/900/520 pixels. It never accesses a personal microphone,
uses an account key, or incurs a paid API request. This does not certify real speech accuracy,
provider availability, or physical-device/macOS/Linux permission behavior.

The action verifier exercises actual Chromium layout at the same three widths with literal
addition/removal prefixes, distinct colors, readable metadata and no executable controls.
Existing composer/context/model-selector geometry verifiers were also rerun. Public fixtures
are source-only; generated recordings, bundles, screenshots, local scripts and app state are
excluded from the contribution. Final broad-suite/build/deployment receipts are recorded in
the PR update and handoff report, distinct from component tests and installed native acceptance.

## Resumed review and final source validation

The interrupted changes and independent reviews were recovered before resuming. The original
broad run exposed a non-bubbling Escape regression in the context control and missing static
translations. Escape now works during capture for both the trigger and popup descendants,
without consuming a closed panel's Escape. Each of the six existing locale catalogs gained
158 translated keys; all original key/value pairs were preserved. Source labels and Unicode
ellipses were checked after correcting an intermediate encoding error. Native main-process
microphone consent still uses its explicit English disclosure; catalog presence is not a claim
that this OS-level dialog is localized.

Additional regressions verify lazy integration of submitted patch details into the actual
timeline, unchanged raw evidence and open disclosures after later events, punctuation around
dictated insertion ranges, and language changes without replacing the speech-language control
or authored transcript. The last language-label case failed before its binding was moved from
the whole label/select container to the caption alone. Light/dark primary text now uses the
existing accent/on-accent tokens rather than an undefined foreground token.

Final frozen-source gates:

- Software regression run: **6,061 passed, 47 skipped**, in **236 passing and 5 skipped suites**.
  Command: `npm.cmd test -- --exclude test/computer.test.ts --exclude test/mcp-shutdown.test.ts --maxWorkers=2 --reporter=dot`.
- Separate shutdown suite: **6/6 passed**. TypeScript and the production build passed.
- Real Chromium dictation fixture: one synthetic upload, zero paid requests, denied camera,
  ended capture tracks, cancellation without a second upload, and draft-only insertion.
  All seven interface languages passed at 1200/900/520 pixels (**21 layouts**). Primary-button
  contrast measured 4.73:1 in light and 10.66:1 in dark before custom theme projection.
- Recorded-action, composer/context and retained model-selector Chromium layout checks passed.
- Public-history privacy, dependency/native-source notices and patch checks passed before
  publication; generated fixtures and local deployment helpers remain ignored.

Earlier test totals are superseded, not added to these totals. The native computer-use suite
was not rerun against the user's active desktop; prior Windows UI Automation limitations are
not claimed repaired. No physical microphone or real transcription provider was exercised.
Unrelated coding work was still making new calls, so the matching archive was staged for an
explicit later installation rather than forcing a running app to quit. Full installed-R8
Compact & Resume and physical-device dictation remain separate acceptance gates.
