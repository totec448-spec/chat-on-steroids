# Native send listener lifetime

## Scope and invariant

Adapt only the listener-lifetime slice of upstream PR #392 by @Gokuencinar.
One live content recorder owns native click, submit and Enter capture. Its predecessor
must stop reading or modifying the composer after retirement; stopping the predecessor
again must not remove the successor's listeners.

The existing stop path already revokes transport and drains stopCleanups, but these
three anonymous handlers bypassed that registry. rememberUserSend also lacked the alive
guard before its optional Goal/templates composer mutation.

## Changes

- Register those three handlers with the existing listen helper.
- Return immediately from rememberUserSend when the recorder is no longer alive.
- Add three parameterized production-script DOM regressions: healthy reinjection,
  retirement, successor capture exactly once, repeated predecessor stop, and draft preservation.
- Keep the shared source/test changes identical in Mainstream and Internal Chromium.

No selector, receipt, outbox, turn, Stop, compaction, host, partition, Browser Use,
timer or protocol change. No commit, push, package or installation in this task.

Credit for a future commit:

Co-authored-by: Gokuencinar <Gokuencinar@users.noreply.github.com>

## Validation

- Before the production fix: all three new cases failed because the retired recorder
  still read composer attachments on the dispatched native-send event.
- Mainstream: 116 selected content-script cases passed (native-send/user/input and
  recorder-takeover coverage); other cases were excluded by the name filter.
- Internal: the same 116 selected cases passed; the initial five-case lifetime/takeover
  check also passed.
- Typecheck and git diff --check passed in both repositories.
- Production content.js, the content-script tests and this worklog are byte-identical
  across the two repositories; the final diff contains only this slice and its credit.

These are source/DOM-fixture checks, not installed ChatGPT acceptance. The subsequent #399
validation ran the complete Mainstream verify on the combined tree: 6,206 passed / 46 skipped,
including native/shutdown suites. See `worklog-2026-09-25-unreadable-session-history.md`.
The full suite was not redundantly repeated in Internal.

## Manual acceptance and residual risks

After installing a future build, test an ordinary send, a screenshot attachment and
a follow-up after reload in both old and new ChatGPT shells where available. Look for
missing confirmation, duplicated input, unexpected draft changes or a dead Send/Enter.
For an extension replacement, the new recorder must capture the first send correctly.

The patch cannot retroactively unregister anonymous listeners from an already loaded
older content script. Reload the ChatGPT document or restart the app when testing.
It does not claim to explain or cure previous prompt leaks or every delivery failure.

Subsequent authorized installed acceptance is recorded in
`worklog-2026-09-25-unreadable-session-history.md`: plain/image sends, native-page reload,
graceful app restart, exact MCP recording, Compact & Resume and a desktop Enter send passed
in a fresh diagnostic conversation on the second Windows host. Source/package/runtime extension
hashes matched. This is acceptance of the observed account, not every provider UI rollout.
