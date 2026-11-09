# Proposal: refresh one chat's view from its existing browser page

Status: draft for behavior agreement before implementation; follows the request in
[#2096](https://github.com/totec448-spec/chat-on-steroids/issues/2096).

When CoS and ChatGPT show different text for the same reply, a person needs a way to
reread that conversation without restarting the app or replaying the task. A manual
**Refresh from browser** action in the chat's existing menu would address that case.

## First scope: reconcile recorded message text, not execution state

1. The person selects one existing, bound chat and chooses **Refresh from browser**.
2. Main identifies an already-connected page for that exact current conversation and
   document. No matching page, ambiguous ownership or changed binding means a clear refusal;
   the request does not open, navigate, reload or steal a browser tab.
3. An idle page supplies a bounded fresh snapshot of native message identities and text it
   can currently observe. Do not scroll the page or imply that virtualized, unloaded history
   has been read. Defer while the page generates, local tools are running, or Compact & Resume
   is changing the binding. Recheck these conditions at capture and application.
4. Reconcile only already-recorded native user/assistant message IDs from the same durable
   session and current ChatGPT conversation. Importing previously unknown messages or older
   frontend conversations is outside the first version.
5. Apply eligible content revisions through the recording owner, preserving original authored
   chronology and existing revision history. Then update only that chat's displayed transcript.
   Report the observed range and whether anything changed, or explain why nothing was applied.

The action must not send or resend a message, retry a tool, regenerate an answer, issue Stop,
close/reopen a turn, start recovery, claim an outbox entry or create a Goal/Loop decision.
It does not repair execution state; the existing controls retain that responsibility.
Pending work must not acquire new authority from a historical message replay.

## Reuse the existing owners, not the ordinary live lifecycle

- [`session/recorder.ts`](../../src/main/session/recorder.ts) and
  [`session/store.ts`](../../src/main/session/store.ts) own recorded identities, text revisions
  and authored chronology. A browser snapshot cannot replace a journal wholesale.
- [`extension/content.js`](../../extension/content.js) currently couples observation with
  generation tracking, recording and lifecycle handling. Calling its ordinary `observe()`
  path is not a sufficient implementation of a display-only refresh.
- [`bridge.ts`](../../src/main/bridge.ts) owns authenticated conversation/document routing;
  [`ipc.ts`](../../src/main/ipc.ts) and [`preload`](../../src/preload/index.ts) own the desktop
  boundary. The request needs its own exact request/session/binding identity, cancellation
  and bounded completion receipt. A timeout is a failed refresh, not an automatic retry.
- [`renderer/chat.ts`](../../src/renderer/chat.ts) owns selection generation and transcript
  rendering. Existing A-to-B-to-A protections, scroll position and composer drafts must survive.

The implementation needs a content-reconciliation boundary that does not dispatch live
turn-completion, recovery or automation effects. This is the main design question to agree
before changing these modules, rather than adding a second recorder or a new recovery loop.

## Preserve evidence when the two views disagree

- A reload may leave ChatGPT showing a shorter regenerated answer. Refresh cannot recover
  words the browser no longer has. Retain the recorded version and explain the discrepancy
  instead of silently replacing a longer answer with shorter text.
- When both views contain conflicting revisions without enough identity/version evidence
  to order them, retain the recording and report the conflict. Length alone cannot select
  the correct version. Empty or partial snapshots never delete recorded messages.
- Browser text never overwrites authored user input, local tool results, edits, attachments
  or other local-only events. The initial user-message scope is the existing browser-observed
  message representation; an `authoredText` override remains authoritative.
- Duplicate clicks coalesce for the same exact binding. Navigation, deletion, Stop/Block or
  Compact & Resume can invalidate the request; a late reply cannot mutate another session.
- Log the outcome and reason once using bounded diagnostics, not captured chat text.

## Acceptance evidence for the implementation

Use deterministic snapshot/recorder tests plus the actual paired app and browser, not mocks
alone. Required cases are:

- A known reply with missing text gains a content revision at its original position; repeated
  refresh does not duplicate it. Empty, shorter, conflicting and oversized snapshots retain data.
- Wrong/missing/ambiguous pages, changed document or account context, deleted sessions and
  Compact & Resume races cannot apply content to the wrong owner.
- Busy generation/tools/compaction defers without stopping them. No new page is opened or
  navigated, and no scrolling is performed to fabricate full-history coverage.
- The refresh path produces no Send, regeneration, tool retry, recovery, turn-end or Goal/Loop
  decision. Test content updates even while a historical final would normally activate those
  paths, including when already-pending automation exists.
- Native message IDs and authored chronology survive restart. A timeout or cancellation
  leaves the old recording usable, including its tool results and revision history.
- Selection A-to-B-to-A, closing the chat, preserved scroll/composer drafts, keyboard access,
  long translated labels, light/dark themes and supported Chrome/Firefox/built-in-browser paths.
  Show the eventual real-app behavior with synthetic data and English screenshots.

These are proposed requirements, not implemented/tested behavior in this documentation PR.

## Questions for scope agreement

1. Is a user-invoked text-only refresh of already-recorded native messages a useful first step
   for #2096, while execution-state repair remains separate?
2. Should conflicting/shorter snapshots be reported without applying them, as proposed here?
3. Is the existing chat menu the right entry point, with no new global setting or shortcut?

Keep this PR a draft while those boundaries are reviewed. This proposal adds no runtime
command, IPC schema, recorded field, provider automation or access permission.
