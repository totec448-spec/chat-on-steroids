# Automatic handoff result receipts, September 19, 2026

## Recorded run

The final Loop test produced four generated follow-up instructions, three committed
continuations across four provider conversations, and five assignments of the same worker.
The session retained its identity and each continuation's source/destination send receipts.
No internal tool error or provider chat error was recorded. One attempted worker spawn was
refused by the existing compaction fence before execution.

Two captured briefs incorrectly said their current iteration had not started although the
local journal contained successful seven-file reads immediately before compaction. The
successors repeated those reads. This establishes the discrepancy; the original network
delivery timing was not captured. Raw transcripts and identifiers remain in ignored evidence.

## Cause and change

A successful local call is recorded before its response returns to the provider. Recording
can trigger the automatic compaction ticket. The old browser pickup clicked Stop before
checking local tool drain, so it could interrupt the response before native result receipt.

The automatic pre-Stop barrier now requires local drain and a fresh source-scoped native
receipt scan. Unanswered calls retain message/tool/request consistency across later scans;
missing rows, duplicate identities, failed scans and conflicting identities cannot release
them. Exact original section nodes remain available when the same response adds a sibling.
Pre-row requests remain pending even beside an already answered call. The existing bounded
wait preserves the unsent automatic ticket for recovery. Manual compaction retains its
existing behavior, and the post-Stop drain remains in place.

Inspection of the real signed-in Chrome page also identified native Code Mode batching:
child requests form a parent chain, followed by a chain of child results and one enclosing
`functions.exec` result. Individual direct-parent matches did not describe receipt of the
composite return. The Fiber reader now resolves the exact enclosing call and waits for its
completed result, with matching request, working-turn and exchange identities. It reads no
code or result payload. An earlier completed enclosing call grants no receipt to later work.
Fiber protocol 13 carries those enclosing native identities separately from local MCP
evidence, preserving a pending batch even before its first child row materializes.

## Verification

The original early-Stop regression failed before the change. The split-section regression
also failed before retaining the original source nodes. Both mixed pre-row cases reproduced
early Stop before their correction. Six native Code Mode receipt cases failed against the
old reader, covering incomplete, complete and contradictory return chains.

The complete Fiber and content-script suites passed 786 tests after the changes. These tests
exercise the shipped scripts in jsdom. Live Chrome established the provider structure; no
installed extension replacement or live automatic-compaction replay is claimed.

The earlier release-tree full gate passed 5,391 tests plus six separately executed shutdown
tests, with 45 skipped. That result predates the final mixed-call and Code Mode corrections.
The subsequent candidate full gate passed 5,399 tests plus all six shutdown tests, with
45 skipped, and its production build passed. The final protocol-13 refinement is also
checked by the pull request's cross-platform CI before the release tag is published.

The release remains version 2.1.14. Its title is taken verbatim from the requested release
notes. Publication uses a fresh commit based on public main, without the private local history.

## Release source availability

PR #312 passed all three CI platforms and was merged. The first publishing run stopped
at the native-source archive because GNOME's GVDB GitLab endpoint returned HTTP 406.
The run was cancelled before publication while the requested release title was corrected.

GNOME's GitHub mirror supplies the same pinned commit and byte-identical 24,716-byte
archive, SHA-256 `069a00aa1fc893f18423602f4e095583be5a220429f6e8a58d70511490b4b019`.
All 14 archived files were independently checked against the commit's Git blob identities.
Only the download URL changes; the source revision, archive size, hash and license notices
remain unchanged. The complete source pack is rebuilt before another publishing attempt.
