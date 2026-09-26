# Arbitrary connector display names

## Problem

The newer ChatGPT Web shell exposes the user-selected connector display name on native MCP
items. The extension treated a short product-name list as ownership. A renamed connector could
therefore execute successfully in ChatGPT while its request never gained page correlation, its
final response remained absent from the CoS timeline, and its framed prompt could remain visible
in the provider page.

## Repair

- Connector names are now bounded presentation candidates only. No connector-name allowlist
  participates in filtering, attribution or authorization.
- Connector refresh uses exact App ID and schema evidence for every display name. The bounded
  257-declaration observation envelope no longer expands or contracts for a product-name string.
- Main records a bounded process-local set of request IDs that reached real top-level MCP
  dispatch. `/correlations` accepts page evidence only for one of those IDs.
- Page-first evidence returns `pending` without creating a session. The existing extension retry
  then converges after first local dispatch, avoiding a handler/browser deadlock.
- Content publishes tool evidence and diagnostics only after exact main-process confirmation.
  Native row replacement additionally requires the same request ID, tool and unique local
  recorder call.
- Fiber scanning accepts both the legacy wrapped mapping and the newer ChatGPT shell's direct
  conversation mapping. Ownership still comes from exact request IDs rather than connector
  presentation text.
- Prompt concealment recognizes the provider's literal backslash-newline serialization of the
  private context frame, while preserving the authored user text.
- Early stream evidence may contain only an admitted request ID. Main now accepts that exact
  page-first claim for correlation deduplication; event recording still requires a real native
  message ID and tool identity.
- The shell compatibility fixture covers a generated Unicode connector name, framed prompt
  concealment, exact tool evidence and the final assistant response in one turn.

## Validation

Mainstream source validation completed:

- `npm run typecheck`
- `npm test -- --run test/fiber.test.ts test/shell-compat.test.ts test/bridge.test.ts test/content-script.test.ts`
  — 1,503 passing
- `npm test -- --run test/correlation.test.ts test/attribution-repair.test.ts test/call-context.test.ts test/mcp-inflight.test.ts test/mcp.test.ts test/user-prompt.test.ts`
  — 200 passing, 6 skipped

The same focused suites and typecheck pass in the Internal Chromium tree. An Internal Chromium
x64 installer was built and installed on the Galaxy Book3 test host:

- final installer size: `173381179` bytes
- final installer SHA-256: `35BF9AF1C26B1C1007876A4F9C80CAF8B4F126AE36EF147521D22D5E424E8F22`
- installed `app.asar` and extension payload matched the fresh build

Live signed-in validation used a renamed connector on the newer ChatGPT shell. The request
was attributed to its conversation 603 ms after the local tool result, with no 20-second
unattributed fallback or later repair. The private `COS_CONTEXT` node remained `display:none`,
was absent from `document.body.innerText`, and the exact response
`LIVE-CORRELATION-V3 173381103` appeared in both ChatGPT and the owning CoS timeline.

After the live run, the full verify exposed a stale-source presentation regression. The exact
source is now authoritative over a recycled rendered bubble, while escaped line breaks are
recognized in that source itself. The four affected suites then passed in both repositories:
4 files and 1,369 tests per tree. The unrelated broad verify was not repeated after that focused
repair.

The arbitrary-name connector-refresh regression suite passed 11/11 in both repositories, and
both repositories passed typecheck after removing the remaining display-name comparisons.

That installed payload was then exercised again on the newer signed-in ChatGPT shell.
The request was attributed to its conversation in 3,457 ms without an unattributed warning or repair.
The provider page contained one concealed private prompt node (`display:none`), no `COS_CONTEXT`
in visible body text, and the exact response `LIVE-CORRELATION-V4 173381179`. The same response
and its `exec_command` activity appeared in the owning CoS timeline.

## Send receipts and follow-up lifecycle correction

The checks above proved attribution and concealment, not correct Send/turn lifecycle. Live
inspection after the user's report found the exact outbox input still in `browser`, without a
receipt, despite the provider having answered. The canonical user row and pending draft then
coexisted; no witnessed local turn meant no confirmed thinking feedback or reliable turn grouping.
The real provider source contained 158 serialized hard line breaks. Decoding those before
punctuation escapes reproduced the complete prepared input; the old comparator did not.

- Extend the existing bounded readback candidates, not the outbox or UI. Native message,
  route/epoch and complete framed input comparison still own acceptance. Original authored
  bytes, including literal backslashes, remain unchanged.
- Cover raw, punctuation-escaped and hard-break serialization through the actual Send ACK,
  one turn start, exact tool/assistant ownership and completed end. A changed link destination
  remains rejected in both old and new serialization.
- A second live turn exposed a separate ownership error: remounted pre-question history could
  borrow the previous final and end the new generation immediately. Reject that DOM novelty
  above the witnessed question. Preserve the classic shell's existing in-place signature proof
  rather than replacing it with a blanket DOM-order restriction.
- Extend the existing adopted-turn regression to witnessed Sends, including static history,
  remounted final and remounted interim. No new timer, watcher, UI sorting or deduplication layer.

The first focused live run confirmed one canonical user row, visible persistent receipt and
three thinking dots after confirmation. Its tool request was rejected upstream before local
dispatch; that run alone was not treated as tool-order acceptance. A subsequent two-turn run
executed real read-only local commands, including a multiline follow-up. Both sends confirmed,
their own finals ended their own turns, and late-recorded tools settled before their respective
finals in the timeline. Late request evidence still uses the existing exact attribution path;
there is no claim that provider evidence always arrives before its final text.

At this stage the repair touched only the companion content reader, its tests and these
contracts. Browser Use, Internal Chromium hosting and persisted session ledgers were unchanged.
No old ambiguous input was resent or rewritten as a repair shortcut.

## Intermediate history publication and native Markdown boundaries

The installed-package recheck exposed an intermittent private-prefix flash that a settled-row
assertion missed. Canonical Fiber history could emit escaped raw source (especially when it had
an authored timestamp) before the mounted DOM pass corrected that same row. Six strengthened
regressions failed before the repair: escaped history, incomplete frames, and exact accepted
Send text, across the provider serializations. They now inspect every emitted user row.

Both readers reuse the existing accepted-input source resolution and frame recovery. Canonical
history quarantines an incomplete reserved frame before publication, just like the mounted
reader. No renderer filtering, second receipt owner, retry timer or persisted ledger was added.

A separate new-shell fixture reproduced a native Markdown bubble losing concealment while its
new MAIN scan stamp was waiting for the matching reply: DOM textContent omits BR boundaries.
The reserved-header hint accepts that collapsed display only for concealment while exact source
is absent. Exact source remains authoritative, including when React recycles the bubble for an
ordinary question. This display hint never authorizes Send or publishes reconstructed text.

The next installed-package probe localized a remaining flash to titles, not the message: the
new shell temporarily publishes the prepared prompt as document.title. The companion now omits
that provisional title from conversation-name observations. Internal's dock state applies the
same concealment hint only to its displayed title; its native title, tab-query API, navigation,
send, identity and lifecycle remain unchanged. A host test asserts that separation explicitly.

## Final focused validation and installed-package acceptance

- Both trees: 932 content/DOM/shell compatibility tests passed; 34 chronology/input-history/
  prompt tests and 12 selected timeline tests (receipt, thinking, Stop, interim/tool order) passed.
- The subsequent provisional-title change passed all five prompt tests in both trees, all
  eleven Internal host tests, both typechecks, JavaScript syntax checks and diff whitespace checks.
- Shared repair source/tests match byte-for-byte between repositories. Internal's only extra
  repair is the dock-title projection and its host test; no hosting/control behavior changed.
- The full verify was not rerun for this iteration. Focused green results are not a claim of a
  completed broad verify. No test/build process was intentionally left running.

The final x64 installer built successfully and was installed on the authorized Galaxy Book3.
Its installed app.asar and both modified extension files matched the package hashes. Final
installer: 173381419 bytes, SHA-256

``07CF6ED220E90FBA3F6D170BA6B88D5167CF0D78EAE1A69E1ED2C043CE0EBC2D``

Two fresh read-only tool turns on the newer signed-in shell then passed: first input and one
follow-up each settled to one user row with a persistent confirmed receipt; three-dot feedback
appeared after confirmation; the local command and final belonged to their own durable turn;
Stop remained during the active response and returned to Send at completion. Both results were
the installer size above. The two request IDs were attributed to the exact same conversation
without an Unattributed fallback. No private frame appeared in sampled visible CoS text (including
titles) or provider body text. The follow-up also exercised overlapping MAIN scan stamps.

This is live acceptance of these concrete cases, not proof of every future provider rollout.
No commit, push, PR update or retroactive rewriting of old sessions was performed.
