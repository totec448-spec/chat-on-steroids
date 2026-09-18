# Continuous history, pending interjections and manual handoff

## Findings and changes

The history reader treated a 30-record storage page as one wheel action. With dense collapsed
activity, successive wheel movements could load only more members of the same visible headline.
Opening and deliberate navigation now fill the visible region through bounded stages, with a
rendering yield between reads. Direction and selection generation own the demand; concurrent
live refreshes wait instead of invalidating it. The resident target remains 160 records, with
the existing measured-reader protection for visible collapsed groups and lazy output DOM.

The viewport reserve previously padded only the recorded timeline. Pending user messages were
its following sibling, so this padding created a large gap before an undelivered interjection.
A real Electron regression reproduced a 616-pixel gap. The reserve now follows the whole
transcript, including pending messages. Pending and canonical bubbles also share equivalent
spacing: the final test measures 11 pixels before the waiting bubble and zero displacement
on delivery. Exact input identities anchor the pending-to-recorded transition. Disclosure changes
discard obsolete reserved geometry.

Manual desktop compaction previously called the cold browser startup owner, which did nothing
when Chrome was already running without the source tab. It now uses the existing exact-tab
recovery path immediately. A manual request can replace an unclaimed ordinary repair without
competing with an already-claimed browser action. Compaction reloads require the original live
continuation token and phase at handout and action claim. Cancelled/replaced/advanced tickets
cannot authorize stale pickup or a false acknowledgement.

Handoff insertion previously combined distinct editor failures into “ChatGPT would not accept
the handoff”. Preparation now waits for a visible editable composer and preserves the concrete
bounded error. Manual failures close only their exact unsent token, preserving user drafts and
newer attempts. Source dispatch now occurs through the existing native Send-ready callback;
a disabled Send timing out is not classified as possibly sent. Lost dispatch receipts still
retain the at-most-once fence. Recovery wording distinguishes an unsent request from a pending
handoff response, neither of which claims a completed brief exists.

## Verification

The production Electron renderer was exercised with 200 grouped tool calls, one expanded result,
native wheel input, both paging directions, pending input, delivery and live refreshes. Collapsed
group height was 26 pixels, expanded height about 5,668 pixels; the hidden result contributed zero
height after collapse. The actual affected recording (207 stored events) passed bidirectional
replay with a maximum measured reader displacement of 0.25 pixels. Private recordings and
screenshots remain in ignored local evidence, outside this worklog.

Tool-output wheel routing and chat-width checks passed in real Electron, including three widths
and three zoom levels. A signed-in ChatGPT page accepted a 19,866-character diagnostic draft
through the native insertion mechanism, preserved its exact text, enabled Send and allowed its
exact removal. This probe did not submit a message.

The final focused content-script run passed 68 compaction/handoff cases, including native Send
readiness, editor hydration, hidden editors, exact failures and ambiguous dispatch preservation.
All five complete history/viewport, renderer, continuation, extension and bridge suites then
passed with 932 tests. The shutdown suite was run independently after the full verify command
stopped at Vitest and passed all six tests. Together these final runs passed 1,006 tests.
The production main/preload/renderer build passed; the emitted CSS was inspected to confirm the
final pending-message spacing and reserve placement. `git diff --check` passed.

Full `npm run verify` passed its ripgrep checksum, privacy, notices/native-source and TypeScript
gates. Its combined Vitest run reported 205 passing files, four failing files and four skipped
files: 5,155 tests passed, seven failed and 45 were skipped. The remaining failures concern
concurrent changes outside this repair: native status-caption suppression (one), MCP schema and
instruction sizes plus exact error text with new identity notices (four), plugin supplemental
redaction shape (one), and request-owned agent staging publication (one). These are recorded as
failures, not waived as successful verification. The later focused runs above were green.

## Evidence limits

The installed app and browser extension were not replaced by this source task. The signed-in
probe verifies native editor insertion, not a full updated-provider A-to-B handoff. Durable
handoff, claims, cancellation, transport and resume behavior are covered by the production-module
test suites. No live session ledger was edited. Unrelated concurrent working-tree changes remain.
