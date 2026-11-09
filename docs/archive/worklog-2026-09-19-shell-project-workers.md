# Cold shell startup and early worker identity, issue #311

Retests after #321 confirmed that account model discovery was repaired, while new local-project
chats could still open without sending and worker status/messages could lack caller identity.
@redzrush101 supplied another private NetLog; @ehkogh independently reported remaining new-tab
input failures and CALLER_IDENTITY_REQUIRED. Both retain their contributor credit. The shell
fixtures extend the adaptation of @ehkogh's #318, without importing its cache-history walker.

## Evidence and repair

The NetLog was parsed as inert JSON. It identifies three input claims followed about fifteen
seconds later by input failures, with no intervening native conversation submission for those
attempts. It was recorded with the default capture mode and does not contain the application
request/response bodies needed to establish the exact error text. No private payload, URL,
account/session material or original capture is included in this change.

The cold picker reproduction exposes the first wrong transition: the initial MAIN read can
precede account picker hydration. The isolated reader then waits for a native ownership stamp
that only another MAIN read can create. Its existing readiness observer now refreshes that
proof as the page changes. The bounded wait, same-document checks, exact model/effort selection,
draft protection, Send authorization and final receipt all retain their existing ownership.

A separate signed-in test conversation demonstrated complete native v1 delta messages whose
operation/path headers are omitted. The matching public client decoder confirms those fields
inherit from the previous delta. The previous observer skipped early request metadata in these
complete messages, leaving a later status event or cache observation to identify the request.

The passive observer now retains only bounded channel/path/operation format state within each
HTTP response. Socket format state is bounded per conversation/turn and linked stream item;
duplicate items are ignored, missing predecessors invalidate inherited headers, and completion,
expiry, malformed input or unknown encoding retires that state. Both conversation and request
ids must still occur in one complete root value. Partial values are never reconstructed, cached
answers are never imported, and no tool result or worker identity is invented. The broker,
permission rules, inbox transport and status lifecycle are unchanged.
Self-contained, explicitly marked root-add messages retain their previous support when a socket
handoff has no repeated encoding prologue. This does not authorize subsequent inherited headers;
an explicitly unsupported encoding still refuses them. A regression covers HTTP and socket delivery.

Recorder, MAIN helper and background restoration move together to version 17. The public app
and companion version remain 2.1.14; updating requires the matching extension and a fresh or
reloaded ChatGPT document so its document-start response observer is current.

## Verification

The cold-picker regression failed before the repair and passed afterwards, including cancellation
and preservation of an existing draft. The stream regressions failed before the repair and pass
with inherited-header messages, nested/partial rejection and linked socket turn isolation.

Final focused verification passed 1,403 tests across eight suites covering the actual recorder,
picker, stream observer, extension transport, input integration and request-scoped agent ownership.
Additional fixtures exercise a large project instruction frame with delayed picker hydration,
exact first-send project binding, cold worker bootstrap, and observer-to-recorder correlation
before any cached message exists.

An isolated Chromium 153 run passed native cold-picker hydration, actual Response cloning for
early identity, literal HTML editing, picker selection/restoration, and three successive sends
with exactly one receipt each and verified finals. All page/transport data in that run is synthetic.
The earlier signed-in Compatibility Check was restored to its original Pro selection with an
empty composer and closed. Final repository verification passed 5,518 tests plus six isolated
shutdown tests, with 45 skipped. TypeScript, privacy, dependency notices and native-source checks
passed. The explicit-root compatibility correction also passed 109 targeted tests. The Windows x64
production build and installer were repeated successfully for the final source. The PR's exact-head
CI and installed-runtime receipts remain separate gates. The affected-account/NixOS workflow
remains for the reporters to confirm.
