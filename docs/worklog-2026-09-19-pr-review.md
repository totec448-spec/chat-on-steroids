# New PR review, September 19, 2026

## Scope and source evidence

Reviewed all eight PRs numbered 298 and higher against local HEAD `2d87e689`
on `codex/work-2.0.8`, the actual dirty working tree, callers, delivery contracts,
and the September 18 review records. Existing work through #295 and the integrated
#300 change were checked before choosing new work. No entire contributor branch
was merged. This review changes local source, tests and documentation only.

The shared tree contained unrelated changes when review began and continued to
change during testing. The initial tracked diff and original files were captured
under ignored `.tmp/pr-review-20260919-94788/`; existing changes were preserved.
PR metadata, commits, comments, reviews and complete diffs are retained there too.

| PR | Last reviewed head | Decision |
| --- | --- | --- |
| [#298](https://github.com/totec448-spec/chat-on-steroids/pull/298) | `955ddb7b547d85ae5d1543d5ea0de409a4ae45b9` | Adapt only retirement of an obsolete automatic Continue wait after proven session departure. |
| [#299](https://github.com/totec448-spec/chat-on-steroids/pull/299) | `38a18dd66017c53d9adf8af45c9459928c17aba9` | Repair the wait caption at its consumer; preserve historical failure counts. |
| [#300](https://github.com/totec448-spec/chat-on-steroids/pull/300) | `d22ed91adbeabde840666df40701eee7531c5ea0` | Already integrated in the current local HEAD; no duplicate integration. |
| [#302](https://github.com/totec448-spec/chat-on-steroids/pull/302) | `f2a83df8668b42c59250b4704bcfd1f171c3b7e0` | Leave out the closed divergent fork comparison. |
| [#303](https://github.com/totec448-spec/chat-on-steroids/pull/303) | `f2a83df8668b42c59250b4704bcfd1f171c3b7e0` | Same divergent fork; the author explicitly said not to merge this upstream comparison. |
| [#305](https://github.com/totec448-spec/chat-on-steroids/pull/305) | `84f212e1f9cacf8d109a82b1f3329d823a70eb2f` | Adapt claim-based expiry diagnostics on both paths and one absolute three-minute wake attempt. |
| [#308](https://github.com/totec448-spec/chat-on-steroids/pull/308) | `ed7bb2525de980f7033298a0e8b6e14cb29df791` | Adapt the Windows target-thread focus preparation, extending exception cleanup. |
| [#309](https://github.com/totec448-spec/chat-on-steroids/pull/309) | `2493f100a83cd0693fe7df37b8f861836c7bf76d` | Hold the broader macOS input-proof changes for a separate revision and native validation. |

## Incorporated changes

### #298: stop an old generated wait from blocking its successor

An authorized automatic Continue in `browser` state survives a committed A-to-B
session rebind. Every later browser/tool/recovery admission sees the same durable
session's pending row and remains blocked. The regression reproduced this with
normal and Pro models, with and without an outbox restart.

`session/input.ts::expireQueued` now cancels that generated wait only when its
source matches its recovery boundary and the current session positively retains
that source in `chatIds` while being attached elsewhere. The original browser
owner, source conversation, authorization, payload and late-receipt evidence remain
intact. The existing outbox load path covers both live use and restart.

The PR's blanket cancellation would discard authored unclaimed queue entries,
which are meant to follow the durable session. Its later fifteen-minute receipt
exception treats age as permission to stop respecting an uncertain send. Neither
change was incorporated. No new bridge callback, startup scan, clock or retry
authority was introduced. Authored uncertain sends remain held for their receipt.

Tests cover successor recovery admission, rejection of the wrong late-ACK owner
or conversation, acceptance of the original exact late ACK, no rebind back to A,
authored queue precedence and delivery in B, and retained authored, foreign,
unnamed, missing-session and companion claims. Time alone leaves a same-chat
authorized Continue unchanged.

### #299: historical failure is not a current wait

`extension/content.js::stageView` now produces a worker wait caption only while
workers are active. Active-worker summaries still include the historical failure
count; agent status, history and `session/progress.ts` retain the complete count.
With no active worker, ongoing native generation uses its normal wait caption.

The PR's fifteen-minute filter would change the meaning of the shared failure
count just to hide a presentation symptom. The adapted fix removes the obsolete
failure-only wait branch and adds no age threshold or second status owner.

### #305: consistent expiry evidence and bounded wake patience

The current command claim distinguishes an unopened delivery from a claimed
command lacking its completion receipt. `commandExpiryReason` supplies that
diagnostic to both deadline and maintenance expiry, retaining a more specific
stored error. No inferred success, typing or receipt is asserted.

The author reported successful wakes near the former ninety-second limit. One
wake now has an absolute three-minute delivery attempt. Redeeming does not renew
it; only proven delivery enables the existing additional worker-silence budget.
Expiry retains the worker's inbox and does not authorize a replay or another tab.
Tests exercise survival beyond the ordinary command deadline, a single command
and opening, final expiry, and claimed/unclaimed diagnostics through both the
timer and the maintenance HTTP path.

The PR advanced from `03c5e814` to `84f212e1` during review. That added the
maintenance-path diagnosis. Both new sweep cases were reproduced before the
shared diagnostic was implemented.

### #308: include the target thread in Windows focus preparation

The focus routine temporarily joins distinct helper, foreground and target
thread pairs, then detaches successful joins in reverse order. Attachments are
inside the existing `try/finally`, so an exception during a later attachment also
cleans up earlier successful ones. Existing actual-foreground checks still decide
whether physical input can proceed.

The Windows regression compiles the actual C# focus method with substituted
native boundaries and covers failed/partial attachment, duplicate thread pairs,
attachment/activation exceptions, already-focused targets and delayed actual
foreground confirmation. It does not activate the user's desktop windows. The
real-device success in issue #306 is contributor evidence, not a local live test.

## Excluded work and boundaries

#302/#303 contain a broad custom fork, including unrelated execution features,
rather than a small applicable Travel Parent patch for this engine. Their closed
status and the author's explicit upstream warning agree with leaving them out.

#309 combines off-Space discovery, frontmost-application resolution and separate
pointer/keyboard proof. Its new AX fallback paths can use geometry after an exact
AX window ID disagrees with the available WindowServer identity; that positive
contradiction needs an explicit rejection rule. Existing later checks may still
refuse input, so this is not a claim of demonstrated wrong-window injection.
The submitted tests mostly inspect source strings. A smaller revision needs
executable identity/overlay cases and native macOS validation; this Windows review
does not establish those outcomes. No macOS source was changed.

## Validation

- Initial behavior tests: six expected failures and one passing negative case
  before the outbox, wait-caption and expiry-diagnostic fixes.
- Windows focus regression: failed against the previous method, passed after
  adapting the target-thread attachment and cleanup.
- Six affected suites: **1,589 tests passed** before the final #305 sweep addition.
- Sweep-path reproduction: both sweep cases failed with the previous generic
  text while both timer cases passed.
- The first full `npm run verify` passed privacy/notices checks, then stopped at
  two compilation mistakes in a concurrently added browser-correlation test.
  Renamed its shadowing loop variable and used its already imported store module
  for `rebindSession`, preserving that test's intended behavior.
- Final full verification and build: in progress; results will be recorded here.

All test bridge listeners use isolated ports (`CLF_BRIDGE_PORTS=0`); test workers
are bounded with `VITEST_MAX_WORKERS=2`. No installed payload or live provider
behavior is claimed by these source-level results.

## Attribution

Adapted code/design: Maxim, `5410641+Maximapple@users.noreply.github.com`
(#298, #299, #305), and Masatoshi Shisaka,
`313313203+okayamajwcc-coder@users.noreply.github.com` (#308).
`CONTRIBUTORS.md` records the incorporated portions. Future integration commits
should retain those public co-author identities. No commit, push, PR closure,
merge, package installation or release was performed by this review.
