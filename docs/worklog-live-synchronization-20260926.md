# Live activity, cancellation, and request synchronization

## Reproduced failures

The September 26 native shell exposed 42 React compiler memo rows. The current
conversation snapshot was in a 471-cell row, but the reader rejected any owner
with more than 32 rows before looking at it. Public activity and exact request
evidence disappeared despite the native conversation still running. The repair
counts rows and cells against the existing total scan budget and still refuses
partial or contradictory results.

The current public thought headline can be transient, and `activeReasoning` can
have no message id at all. These two cases need different representations:
matched native summaries update their existing recorded activity row; a public
headline with no native id updates a small, turn-scoped presentation field. It
does not create a message, advance the work clock, or authorize Goal, Send, or
tool attribution. Changed captions use the existing coalesced session-change
notification; duplicates do not request another renderer refresh. The activity
response reconciles that ephemeral field after a desktop restart.

Stream request origins were also lost at two boundaries: the observer did not
join the nested input-message request id to its response's conversation handoff,
and the app rejected request-only evidence without a mounted message id. The
observer now retains only a bounded, unambiguous response-local join. Shared
WebSocket traffic needs its exact turn-topic route; malformed, oversized, mixed,
contradictory, or uncertain stream frames cannot supply inherited identity.
`/correlations` accepts that request-only origin without fabricating a native
message id. Ordinary transcript evidence keeps its original requirements.

Stop had three separate projections: requesting a native click, releasing local
finish policy, and observing actual native cancellation. An accepted click no
longer erases the existing work state. Its bounded receipt keeps the current
exact turn in “Stop requested” until a real terminal observation or the original
dispatch deadline. A deadline is not a cancellation receipt. An old released
finish record cannot block a newer turn or a proven post-Stop message forever.

## Native composer and turn identity

The new shared primary-action slot is recognized separately from legacy Stop and
Send controls. Translated controls use the observed slot/icon structure, not an
English caption. Unknown or competing primary controls do not authorize input.
The classic composer can keep Send mounted beside its exact Stop button: Stop
still wins, and Send remains unavailable during that generation.

A verified current native idle slot can disprove stale shell `in_progress`
presentation. It does not fabricate a final answer. Only the newest shell
exchange is considered; old interrupted exchanges are not current busy evidence.

`fallback-turn-N` is a changing search/layout index. For those shells, the stable
UUID turn key must match the unique current typed user message before it is used
as exchange identity. DOM slot lookup still uses the actual layout key. Reload,
history mounting, and positional changes cannot silently rename a running turn.

The matched recorder/MAIN-reader protocol is now **22**, and the passive stream
observer is version **3**. Update the desktop and companion together, reload the
companion, then refresh existing ChatGPT documents after work and drafts are safe.
An old worker reinjecting old scripts into a partly updated test tab is not a
coherent installation and is not counted as end-to-end validation.

## Contributor provenance

This adapts Maximapple's public diagnoses and focused proposals:

- [#414](https://github.com/totec448-spec/chat-on-steroids/pull/414): split stream
  request/conversation origins and the rejected message-less correlation.
- [#405](https://github.com/totec448-spec/chat-on-steroids/pull/405),
  [#418](https://github.com/totec448-spec/chat-on-steroids/pull/418), and
  [#422](https://github.com/totec448-spec/chat-on-steroids/pull/422): translated
  native Stop/Send, shared composer controls, and stale running state.
- [#423](https://github.com/totec448-spec/chat-on-steroids/pull/423): stable shell
  turn keys rather than positional search indices.

The stream adaptation incorporates the contradiction/framing concerns discussed
in Haz4rdovisk's review. moderntanri's upstream reproduction is credited as such.
These are selective adaptations with independent negative tests, not a claim that
the entire PR branches were merged unchanged. Upstream latency measurements are
not measurements of this installation.

## Validation boundaries

Regression cases reproduce request-only rejection, oversized memo row counts,
missing public transient captions, shifted turn indices, Stop receipt/terminal
confusion, and old finish-state blocking. They exercise the production observer,
DOM/content reader, bridge, recorder, real temporary stores, and renderer.

The native account check used one disposable conversation and no local PC tools,
file changes, purchases, messages to people, or user-project changes. Public
search activity and growing assistant text were observed through the repaired
reader. A fixed instance of the production DOM adapter dispatched native Stop
once; the composer was positively idle 1,124 ms later. A following request was
accepted and its public reply was exactly `COS_R7_NEXT_OK`; the draft was empty.
These are live component checks, not an installed desktop round-trip claim.

The older installed worker reinjected old readers during initial mixed-version
testing. That test was not counted as successful R7 deployment. Other authorized
coding work remained active during deployment checks, so installation was
staged rather than forcing a process or browser restart. The installer verifies
both payload inventories and refuses a running application.

Private probes, stream captures, account/session IDs, screenshots, credentials,
local install helpers and generated archives are not published. The disposable
test tab and diagnostic page were closed after verifying the final reply; their
temporary extension files and local collector were retired.

## Final-review cancellation regressions

The resumed review reproduced two additional failures with the recovered R7 source:
a second explicit Stop after its acknowledged click queued another cancellation,
and expiry of an acknowledged cancellation had no notification when its original
command timer had already been removed. Both new regressions failed before repair.

An unexpired committed Stop receipt now suppresses duplicate dispatch. Outstanding
commands still join their original durable lease; a pending write cannot become
an acceptance just because another caller observes it. The existing earliest-
deadline scheduler also includes acknowledged Stop deadlines and notifies the
desktop on expiry. There is no additional per-chat polling loop, no second Stop,
and no fabricated terminal event. A deliberate retry still needs current native
work evidence. Both focused regression checks pass after repair.

## Final validation

The final software run, including both additional cancellation regressions,
passed **5,977 tests**, with **47 skips**, across **232 passing and 5 skipped
suites**. The separate shutdown suite passed **6/6**. Commands:

```powershell
npm.cmd test -- --exclude test/computer.test.ts --exclude test/mcp-shutdown.test.ts --maxWorkers=2 --reporter=dot
npm.cmd test -- test/mcp-shutdown.test.ts --maxWorkers=1 --reporter=dot
```

The original recovered run passed 5,975 tests before those last two regressions;
it is superseded by the final run, not added to it. The final focused checks
confirmed retry requires renewed native work rather than an expired liveness
claim. Earlier failed diagnostic runs and incomplete mixed-version experiments
are not counted as successful acceptance.

TypeScript, changed JavaScript syntax, the production build, patch checks,
public-history privacy, and dependency/native license checks passed. The frozen
app archive was checked against 132 compiled files while retaining 170 native/
unpacked files and 3,212 dependency files unchanged. Both companion inventories
and the installer's read-only validation passed. Local installation helpers and
archives remain outside public Git history.

The native Windows computer-use suite was not rerun against the user's active
desktop; its previously reported UI Automation limitations are not claimed fixed.
The installed app remained on R6 to preserve unrelated running work. Full
installed R7 Stop/follow-up, worker and automation acceptance still requires a
coherent app/companion upgrade and fresh idle ChatGPT documents. Source regression
coverage and the native component checks above do not substitute for that result.
