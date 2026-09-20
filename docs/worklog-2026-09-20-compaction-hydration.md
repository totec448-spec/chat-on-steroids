# Compaction source hydration and runtime identity

## Confirmed failures

A compaction pickup could freeze a null source question while a recovered page was still
loading. Once the original question mounted, the same-source check treated hydration as a
new question and durably abandoned the unsent continuation. A regression using the shipped
content script reproduced zero sends before the fix.

Source admission now waits for the editable composer and, when known, the app's recorded
question before freezing the source identity. Identities already observed before the wait,
real user sends, route changes, and the existing exact dispatch fence remain authoritative.
Tests cover both editor/history mount orders and rejection of real question/send/navigation
changes. No live continuation ledger is rewritten.

Full verification also exposed two runtime identity defects:

- An invalid explicit tunnel executable selection fell through to the bundled/PATH copy.
  Explicit failures now return no executable; valid directory and sibling resolution remain.
- POSIX login profiles could overwrite the bundled ripgrep PATH prefix after child environment
  preparation. The executable command now reapplies only that directory after profile loading,
  retaining the profile's other PATH entries. Patch interception still sees the original command.
  A real zsh login-profile regression covers spaces/apostrophes in the bundled directory.

## Validation

Live diagnostics also established repeated credential rotation between two browser profiles.
Automatic extension pairing now requests reuse of the current credential generation. The
bridge serializes provisioning and Disconnect, and rejects a stale provisioning result after
revocation. Legacy pairing still rotates tokens; the existing superseded-token test remains
unchanged. Concurrent-profile, secure-store reload, explicit reconnect, and delayed-write versus
Disconnect regressions pass alongside all 733 bridge/extension tests.

The initial compaction regression failed before the repair. The focused content-script control
group passed 46 tests after repair. The affected content-script, continuation, resume, shell,
tunnel, and MCP suites passed 999 tests with 9 platform-specific skips. No test assertions were
weakened.

After integrating upstream `04c6a29`, `npm run verify` passed 5,576 tests with 129
conditional/platform skips, followed by all six isolated shutdown tests. macOS arm64 packaging,
bundle metadata/signature checks and native runtime smoke passed.

A separate checkout of unmodified upstream `04c6a29`, with only the new regression tests added,
reproduced eight failures in hydration/provisioning/explicit-path cases while eight controls passed.
Its existing MCP bundled-ripgrep test also failed under a login profile: the host rg replaced the
bundled copy. The same focused selection passes all 17 cases on the repaired branch. This
comparison establishes upstream defects independently of installation changes on the affected host.

The delayed Disconnect regression concerns a stale successful provisioning response. The
existing secure-store write queue still persists Disconnect after the delayed write; this is
not a claim that the baseline allows authenticated access after completed revocation.

React error 185 denotes excessive nested React updates. This change does not claim to identify
or repair an uncaptured provider React stack; that requires separate reproduction evidence.
