# Completed requests: tool order and activity

## Problem

A native final answer could be followed by completed connector calls from the same
provider request. The recorder had already cleared its live turn, so those calls
lost their generation association and appeared below the final answer. The final
reader and activity listener independently treated the later call timestamps as
new work, renewing the sidebar activity indicator and silence recovery countdown.
The composer had another timestamp comparison that could disagree with completion.

## Changes

The session store derives `requestTurns` from exact MCP records that already name
a conversation and generation. It retains the earliest proof position and marks
contradictory associations as null. The recorder reuses this association after
completion, restart, and the arrival of a newer generation. This does not change
request-to-session routing or grant caller permissions.

Old sessions rebuild the missing index from their journal and canonical shards
when opened. All history readers use it to project orphaned tool rows into their
original turn. Original event timestamps, sequence numbers, turn IDs and journal
bytes remain unchanged; the projection supplies only presentation placement.

`readCompletedFinal` accepts trailing calls from an already-proven request when the
native final has a provider message UUID and the request proof precedes that final.
Different requests, conflicting generations, newer questions, and newer turns
still invalidate an old completion. A view-local completed end without native final
proof can still be reopened by the request's continued work.

The activity listener and composer consume the common completion result without
overriding it with another timestamp comparison. Old-request calls do not extend
a newer generation's activity. Running local tools retain their independent
delivery fence, and Astra's existing terminal requirement remains intact.

The optional recording mode in `verify-history-scroll.cjs` now accepts a store
snapshot containing both summary and events. It uses the recorded request index,
a separate fixture chat identity, and the renderer's input-receipt row keys.
A recording that loads completely need not produce another paging request;
the existing larger synthetic scenarios still exercise history paging.

## Verification

The new recorder/store regressions first reproduced four failures: missing turn
ownership before and after restart, legacy row placement, and an old request
borrowing a newer turn. A further composer regression reproduced the inconsistent
settlement check before that path was corrected.

Seven dedicated store tests and two bridge integration cases cover these failures,
legacy reconstruction without journal rewriting, contradictory proof, actual new
requests, false local ends, and unchanged newer-generation activity. The bridge
cases cover both Pro and ordinary models, including the full silence window.

`npm run verify` passed: 5,230 main-suite tests and six isolated shutdown tests,
with 45 skipped tests. Type checking, public-history privacy, and notice checks
also passed. `npm run build` passed.

An isolated copy of the reported recording contained 96 events and 86 tool calls.
Both orphaned trailing calls projected before the native final, and the common
completion reader recognized the final. Hash checks confirmed that the original
journal and the copied journal were unchanged. Private recording bytes and the
copy/export helper remain in ignored local scratch storage.

The real Electron renderer passed its dense-history scenarios and the recording
replay. All 92 expected canonical message/tool rows were present, with no missing
or duplicated rows, and idle refresh preserved their order. The captured renderer
image was inspected and showed the trailing tool group above the final answer.
The isolated fixture did not load the recording's image assets.

## Deployment

Source and build verification are complete. No installer was produced or run, no
running app or extension was replaced or restarted, and the user-closed target
browser tab was not reopened. Unrelated working-tree changes were preserved.
