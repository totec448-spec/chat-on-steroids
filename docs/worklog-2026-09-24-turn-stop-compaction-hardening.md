# Turn, Stop and compaction hardening

## Scope and evidence

Read-only inspection of the affected installed alternate-shell session showed a local turn
ending within milliseconds while native work continued. A production-function reproduction
and then a failing content-script regression demonstrated that revising an older assistant
section in place could bypass the newer question boundary. The exact transient repaint in
the live incident was not captured. The live native Stop control used `aria-label="Stop"`;
the existing selector did not recognize that alternate-shell control.

The recorded first manual compaction attempt aborted before source Send after a reload;
the subsequent attempt committed the same local session to its destination successfully.
This does not prove every possible readiness failure has the same cause.

## Changes

- Apply the exact question boundary before every generation-section ownership path,
  including held nodes and historical in-place revisions. Do not fabricate UI activity.
- Permit Stop before the first assistant section using the accepted question and the
  exact redeemed command. Recheck navigation/question changes; retain click/finish separation.
- Recognize alternate-shell Stop only in the native composer form, preserving classic controls.
- Prefer a claimed in-place compaction recovery over reloading a responsive source.
  Preserve source/destination WAL and at-most-once Send boundaries.
- Reuse bounded reader repair for Continue hydration gaps, followed by exact fresh proof.

Two older fixtures appended a new question after an existing answer and then expected that
earlier answer to acquire the new turn. They now place the genuinely reused section below
the question; separate negative cases retain historical nodes above it.

## Upstream review

Adapted only the relevant reader-repair and in-place source-recovery slices from
[@Bemirror99's #389](https://github.com/totec448-spec/chat-on-steroids/pull/389) and
[#391](https://github.com/totec448-spec/chat-on-steroids/pull/391), with tests and credit.
Do not describe this as merging either PR in full. Preserve this trailer when committing:
`Co-authored-by: Santa <59559008+Bemirror99@users.noreply.github.com>`.

Reviewed #390 (worker context ceiling), #392 (broad runtime/connector changes) and #384
(native connector attachment); these are not incorporated into this focused repair.
The retry-cadence and destination model changes of #391 are also outside this patch.

## Validation

- Before the fix: historical in-place revision and pre-prose Stop regressions failed.
- Focused turn/Stop tests passed after the owner correction; new-shell production-reader
  regression exposed the missing native Stop selector and passed after its correction.
- New-shell handoff tests cover both idle and visible native Stop, one source Send and one brief.
- Initial full verification passed 6,076 tests (46 skipped), plus 26 native/shutdown tests.
  The subsequent compaction/picker follow-up and its final validation are recorded in
  [the follow-up worklog](worklog-2026-09-25-compaction-picker.md).
- No renderer activity workaround, Internal Chromium hosting/partition/liveness change,
  Browser Use change, ledger edit, commit or push.
- The packaged baseline was installed and live-tested. Stop/turn behavior improved, but a
  further intermittent pre-Send compaction failure required the follow-up linked above.
