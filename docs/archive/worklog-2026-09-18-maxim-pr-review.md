# Maxim PR review against the current dirty tree

Reviewed the seven PRs selected by the user on 2026-09-18. The requested delivery permits
adapted integration into the existing working tree with explicit credit. This review does
not merge the seven branches unchanged or publish the unrelated local work.

Original contribution credit: **Maxim / @Maximapple**. Public co-author identity for a future
integration commit: `Maxim <5410641+Maximapple@users.noreply.github.com>`.
The maintained attribution record is in `CONTRIBUTORS.md`.

## Reviewed source and decisions

| PR | Reviewed head | Result |
| --- | --- | --- |
| #280 | `c99a757ecd9fed292dbef98b42d03bc12060794e` | Adapted repair handout, confirmed-action and failed-action logging. Excluded the additional blind-reload detector, new repair reason and request-based attempt counters. |
| #284 | `ad4922216f0ecca5b8fa24756c5a27f9c13ea973` | Integrated helper health through the existing page/worker/bridge activity path. Initial health remains unknown, an empty scan is informational, and a definitive failed repair is distinguished from a missing observation. |
| #286 | `e44f9f16ca6266a312ee1a5e10c909d709fccbbd` | Adapted draft protection into the existing pre/post-claim checks, including compaction. Added a post-claim recheck for frozen/discarded shells. |
| #288 | `be3fbbc013183e82949b347d622a0c887398280f` | Adopted the Windows accessibility probe's 150-second process deadline and 180-second outer test bound, retaining process-tree cleanup. |
| #289 | `b012cfd0b20ef27e96f54ab499c5579e9c5f6afe` | Integrated once-per-minute refusal logging by conversation and reason. Added clock-rollback handling and test reset; recovery eligibility is unchanged. |
| #291 | `07d58430e1b86b0019859f21aa2a8da82ae44dac` | Integrated escaped continuation readback in the content script, bridge, store, handoff matching and renderer. Narrowed the escape grammar and preserved literal brief text. |
| #292 | `8e9db4f3e7a9460d7f9746b4fdddf9047d0b0cf6` | Reproduced the unread-output receipt boundary in the test and waited for actual publication before a single new invocation. Did not adopt the repeated-command retry loop. |

## Why the original patches needed adaptation

**#280:** Two calls separated by three minutes do not establish three minutes of continuous
activity. The proposed counter also advances before a queued reload is accepted or performed.
Its additional repair reason would introduce a parallel path beside the current source-turn,
manual-departure and action-claim rules. The useful diagnostic distinction is retained at the
existing handout and exact-token receipt boundaries, without introducing another reload policy.

**#284:** A newly initialized recorder has not yet tested the page helper. Treating that state
as a failed injection creates misleading warnings. An empty successful scan may also be a
loading page. The revised diagnostics distinguish these states without granting recovery
authority. A late failed scan from a different navigation epoch cannot overwrite current health.
Repeated states are suppressed by a bounded map, with recovery transitions reported separately.

**#286:** The dirty tree already checks ordinary repair drafts and fresh native progress.
Compaction requires a narrower check because its exact continuation ticket can legitimately
recover a busy source. It now checks text, attachments and the current user question before
and after the claim. The maintenance projection was also dropping `reason`; preserving that
field makes the intended compaction policy reach the action function. Frozen shells are
revalidated after the asynchronous claim. An unresponsive page retains the existing independent
main-process authorization requirements; missing telemetry is not a claim that no draft exists.

**#291:** The original escaped-marker expression admitted backslashes before letters/digits,
while the browser reader only understood Markdown punctuation escapes. The two readers now
agree, including escaped brackets, hyphens, colons and underscores. Marker-only escaping is
handled without rewriting literal backslashes in the brief. Bootstrap readback receives the
original text, not a whitespace-stripped value that destroys the marker boundary. General user
input authorization remains on its existing exact receipt path. An integration-time change
to the renderer test's container was corrected back to the actual timeline row container;
that failure was not a defect in Maxim's original container selection.

**#292:** Receipt admission requires a later invocation than completed HTTP publication. The
test observes `offerCompletedOutput` publication, waits for a strictly later timestamp and then
requires one invocation to succeed. Failed publication still fails the test; no production
receipt rule or unread-result bound was relaxed.

## Validation

The first focused run passed seven cases and exposed the integration-time renderer-container error.
The expanded regressions then exposed the missing repair-reason projection and the stripped
bootstrap text. Both production boundaries were corrected. The subsequent focused run passed
**28 tests in five files**, covering escaped readback, marker grammar parity, literal brief
backslashes, compaction draft/claim races and suspension changes during the claim.

Final verification on 2026-09-18:

| Check | Observed result |
| --- | --- |
| `npm run typecheck` | Exit 0. |
| `VITEST_MAX_WORKERS=2` with `npm run verify` | Exit 0. Privacy, notices, native-source metadata, TypeScript and Electron loading checks passed. Main suite: 210 files passed, four files skipped; 5,203 tests passed, 45 skipped. Separate MCP shutdown suite: one file and six tests passed. Total: **5,209 tests passed**, 45 skipped. |
| Windows accessibility probe | Passed in the full suite, approximately 2.8 seconds; the new deadline did not need to be exhausted. |
| Relevant complete suites | Bridge: 470 tests; service worker: 234; content script: 656; renderer timeline: 164. All passed. |
| `npm run build` | Exit 0. Main, preload and renderer bundles built. Vite reported non-fatal mixed static/dynamic import notices for existing module arrangements. |
| `git diff --check` | Exit 0. Only Git line-ending conversion notices were emitted. |
| Index / HEAD | Index remains empty; HEAD remains `5eb72519`. The integration is uncommitted in the existing working tree. |

Full outputs are retained in `.tmp/maxim-review-20260918-23856/verify.log`, `build.log`
and `focused-corrected.log`. The configured skipped cases were not enabled or changed to
make the suite pass. No live provider/installed-app acceptance is inferred from these results.

## Integration boundaries

The canonical working tree is `chatgpt-local-files`, initially at `5eb72519` on
`codex/work-2.0.8`. Original file bytes, exact PR diffs, heads and hashes were captured before
integration in the ignored `.tmp/maxim-review-20260918-23856/` audit directory. Existing dirt
and concurrent changes, including the native activity-fold work, are preserved. The review
does not attribute those unrelated changes to Maxim or claim they originated in these PRs.

No reset, checkout, stash, installation, release, GitHub merge or push is part of this local
integration. Source/harness verification does not assert that the already installed app has
loaded these changes.
