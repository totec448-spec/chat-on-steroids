# Waiting for a chat's own sub-agents before its next automatic step, 2026-09-20

A Goal or Loop chat delegated half of its task to workers and then, while those workers were
still running, decided and sent its next automatic instruction. The prime's own reply debt was
already recorded, so the driver had no reason to wait: it drafted the next step from a context
that was about to change and then typed that instruction into a chat that was still being
worked on. The workers' reports arrive in that same chat, so the decision was taken against
half of the evidence and the instruction landed on top of the work it was meant to follow.

## The one rule, and where it lives

`waitingForSubAgents(conversationId)` in `src/main/agents.ts` is the whole predicate:

```ts
export function waitingForSubAgents(conversationId: string | null | undefined): boolean {
  return getConfig().multiAgent.waitForSubAgents === true && familyWorkersBusy(conversationId);
}
```

It is in `agents.ts` because worker state lives there and nowhere else. The obvious home was
`bridge.ts`, next to the questions it answers, but `bridge.ts` imports `session/finish.js` and
the finish decision needs the same answer — a predicate there would have closed an import cycle.
`agents.ts` imports neither module, so both consumers can depend on it and neither can disagree
with the other about what "busy" means.

`familyWorkersBusy` resolves the chat through `runForConversation` and then asks the private
`workingWorkers`, which is already what `freeWorkerSlots` uses. Two consequences fall out of
that choice rather than being special-cased:

* **It is per family.** `swarmState()` merges every prime family into one snapshot and must
  never be used here — a second prime's workers would hold a chat they have nothing to do with.
* **It fails open.** An unknown chat, an ambiguous one, or one with no run at all resolves to
  `null`, `workingWorkers(null)` is `[]`, and nothing waits. A wait can only ever be caused by
  work this exact chat started.
* **An `invited` worker already counts.** `occupiesSlot` covers `invited`, `active`, `detached`
  and `waking`, so the very first Goal step after a delegation waits too, not just later ones.

## The three consumers

Worker state was never the only thing that had to change. The pickup tree, the two wait
descriptions and the finish decision are all downstream of the same fact, and each needed it
stated once.

**`owedPickups` in `bridge.ts`** defers the debt instead of spending it:

```ts
for (const id of owed.keys()) if (waitingForSubAgents(id)) owed.delete(id);
```

Deleting the entry here rather than teaching the scheduler to skip it is what makes one rule
cover three callers. `inspectOwedPickups`, `takePendingRepairs` and the goal branch of
`silenceRepairCurrent` all read `owedPickups()`, so all three simply do not see the debt while
the chat's workers run. Nothing is spent: no attempt is recorded, no backoff window is opened,
and `watch.dueAt` is untouched. The pickup is collected on the first sweep after the last
worker stops, with its whole schedule still ahead of it. The alternative — a `continue` inside
the handout loop — would have left the pre-action re-check and the silence re-check reading a
different answer from the handout that followed them.

**`goalWaitFor` in `bridge.ts`** describes the wait to both surfaces:

```ts
if (waitingForSubAgents(conversationId)) return { reason: 'workers' };
```

`sessionControlsFor` and `/activity`'s `goalView()` already read this one function, so the
renderer status row and the extension panel both learn about the wait from the same place, and
a new reason needed no new plumbing. `GoalWait` in `src/shared/goal.ts` gained `'workers'`.
There is deliberately **no `until`**: the wait ends when the last worker stops, which is not a
moment this app can predict, and a guessed countdown ticking toward nothing would be a second,
false clock. The renderer therefore shows the label and no `[role="timer"]`, and the extension
shows the label with an empty detail.

**`prepareNotice` in `session/finish.ts`** is where the gate was actually necessary. The pickup
gate alone is not enough: `prepareNotice` drafts the automatic Goal decision — a real provider
call — and queues the row *before* any pickup exists, so the debt would be spent before the
pickup tree ever saw it. The gate sits after every earlier return, including the
`if (!userRequested && !automatic) return result;` notice-only path, so a plain notification is
never suppressed:

```ts
if (waitingForSubAgents(session.conversationId)) {
  try { await releaseSessionFinish(sessionId, turnId, 'end'); }
  catch { /* the turn moved on; that turn's own authority owns the release */ }
  return 'Waiting for this chat’s sub-agents to finish before deciding the next step.';
}
```

The hold is **released**, not left held. Leaving it held would make the user's own answer wait
behind workers they did not ask about; releasing the hold lets the finished answer complete
normally, and the durable reply obligation the pickup tree already tracks is what the next
automatic step will be decided from. The release is best-effort because a turn that moved on in
the meantime owns its own release, and a failure there must not turn a wait into an error.

## No deadlock, and no second mechanism

The gate cannot starve the reports it is waiting for. Worker reports reach the prime through
`offerMessagesForCaller` in the kernel, not through the browser outbox — `entrySchema`'s
`purpose` is only `'user' | 'decision'`, with no agent purpose at all. Nothing this change
touches sits on the path a worker's report takes.

`/goal/draft` needed no change either. The route already answers `409 chat_still_working`, and
the extension already retries that code; the new wait is expressed through the same
`goalWait` projection both other surfaces read.

No timer, watcher, state machine or mirrored authority was added. The wait is a read of state
that already existed, taken at the three places that were about to act on it.

## The switch

`multiAgent.waitForSubAgents` is a new optional boolean, `false` by default, so a chat with no
run and a run with no workers behave exactly as before. It is optional in the type on purpose:
around thirty test fixtures build a whole `multiAgent` literal, and a required field would have
made every one of them a change to this feature.

It is threaded through `DEFAULT_MULTI_AGENT` and the config zod schema, the `ipc.ts` settings
schema and `mergeSettings`, the multi-agent pane in `src/renderer/index.html` (after
"Restore agent tabs"), and `chat.ts`'s save payload, input list and `chatApply`. The zod-level
`.default({ ...DEFAULT_MULTI_AGENT, waitForSubAgents: DEFAULT_MULTI_AGENT.waitForSubAgents ?? false })`
needs that key spelled out: `.default()` makes it present in the parsed output type while a bare
spread of an optional property leaves the input optional, which is a real typecheck error rather
than a style preference.

Both user-facing strings are new source keys, so all six locale catalogs (`fr`, `es`, `ja`,
`tr`, `zh-CN`, `zh-TW`) received them; `en` is the source and has no file.

## Checks run

Executed with `LANG=en_US.UTF-8`:

* `npm run typecheck` — passed, no output.
* `npx vitest run` — 215 files passed, 14 skipped; 5,771 tests passed, 138 skipped.
* `npm run verify` — ripgrep staging, public-history privacy (206 commits, 12 tags), third-party
  notices (155 production packages, 7 catalog entries) and 730 pinned native source archives all
  validated.
* Regressions were written and run per layer: `test/agents.test.ts` (the predicate, 6 cases
  including the per-family and fail-open boundaries), `test/bridge.test.ts` (`goalWait` on both
  surfaces, the deferred-then-collected pickup, and the off-by-default parity case),
  `test/session-finish.test.ts` (no provider call while workers run, the ordinary decision once
  they report, and the notice-only hold untouched), `test/renderer-timeline.test.ts` and
  `test/content-script.test.ts` (the label, and no invented countdown).

Two ambient results are recorded rather than claimed as passes: the first full-suite run failed
`test/renderer-chat-models.test.ts` on `Intl.NumberFormat` rendering `400 000` with a space
under the shell's non-US locale, and a second failed `test/code-mode-runtime.test.ts` on a
message-kind assertion. Both passed in isolation and in the final full-suite run.
