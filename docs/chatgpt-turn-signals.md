# ChatGPT turn signals — what the page tells us, and how to read it

Recorded 2026-08-30, against the 2.0.2 tree.

Every unattended feature in this app — the Goal loop firing, a revival being sent, a compaction
starting, a stale chat being reloaded — rests on one question: **what is this ChatGPT turn doing
right now, and how did the last one end?** This is the inventory of the evidence the page actually
gives, where it is read, and what each signal is worth. It exists so a later fix can be built on a
signal that already exists rather than on new machinery.

The rule this file is written to defend: **a turn is finished only when the page says so. Silence
is not completion.**

---

## 1. The four questions, and the signal that answers each

| Question | Authority | Where |
| --- | --- | --- |
| Did the model finish? | Fiber `end_turn === true && status === 'finished_successfully'` | `extension/fiber.js:525` |
| Did the *user* stop it? | a real click inside the Stop button | `extension/content.js:8311` |
| Did it fail? | a visible `role="alert"` banner, or transport-failure prose | `extension/chatgpt-dom.js:1064` |
| Did the conversation go away mid-turn? | the browser *released* the tab's claim | `extension/background.js` → bridge → `closeConversation()` |

Page-observed endings are folded into one decision in `endOutcome()`
(`extension/content.js:1317`). The recorder independently writes `unknown` when
`closeConversation()` releases a conversation with an open turn. Both paths are deliberately
conservative: an unexplained stop stays `unknown`, never "the model hit its limit".

### The outcome vocabulary

`TurnOutcome` (`src/shared/session.ts:19`) is the whole vocabulary, and each value is load-bearing:

| Outcome | Means | Safe to treat as "prime finished"? |
| --- | --- | --- |
| `completed` | Fiber's `end_turn` bit, or the degraded DOM rule below | **yes** — this is the only one |
| `failed` | a visible error belonging to *this* turn | no |
| `stopped` | the user clicked Stop | no — and never retry it |
| `interrupted` | ChatGPT marked the turn interrupted | no |
| `stalled` | no visible progress for `STALL_MS` (ten minutes) | no |
| `unknown` | the conversation was released mid-turn, or stopped for a reason it did not give | no — **this is the reload shape** |

---

## 2. Finished vs. partial — the distinction that matters most

`answerText()` returns the *first* assistant prose in a turn; `finalAnswerText()` returns the
*last*. They are not interchangeable, and the difference is exactly "partial vs. full":

> One logical turn routinely exposes several assistant-authored messages: interim commentary
> while it works, then the answer.

So **visible prose is not evidence of completion.** A turn that wrote "let me go through this"
and then died has prose. This is why `endOutcome()` refuses to close a quiet turn on prose alone
whenever Fiber is available:

```js
// content.js:1343 — degraded fallback ONLY, for browsers where Fiber never answered
if (!fiberPresent && answerText(turn).length > 0) return { outcome: 'completed' };
```

When Fiber *is* present, prose closes a turn only with corroboration — exact turn ownership, no
unanswered connector call, a fresh completed-message action row, and the Stop-gone settle window
all agreeing (`fiberQuietTerminal`, `content.js:1348`). That combination exists because of a real
2026-08-25 failure where a visibly final response lost its `end_turn` bit.

**Consequence for anything that must fire "after prime finishes": key on `outcome === 'completed'`,
never on "prose appeared" and never on "tool calls stopped".**

---

## 3. The detach / stale shape

Observed live on 2026-08-30, and the reason this file exists:

- the turn detached mid-generation **while tool calls were still active**
- the app recorded:
  `Turn ended for an unknown reason — the ChatGPT page detached while generating; outcome may be
  recovered when the chat reopens`
- a **new turn then started**
- Chrome showed **no assistant text** and the **blue Stop button still present**

That message is emitted by `closeConversation()` (`src/main/session/recorder.ts:1733`) when a turn
was still open:

```ts
kind: 'turn_end',
outcome: 'unknown',
detail: 'the ChatGPT page detached while generating; outcome may be recovered when the chat reopens'
```

**It is not driven by `pagehide`.** `content.js`'s `pagehide` handler deliberately flushes queued
observations and then does nothing else — a document unload also happens on an ordinary reload, and
closing there "corrupts live turn identity" and produced a flood of `session … reopened` churn.

Conversation lifetime is owned by the service worker's tab tracking instead:

- `chrome.tabs.onRemoved` — a real tab close (reload keeps the same tab id, so it does not fire)
- a concrete navigation to a URL outside ChatGPT — the tab survives but its document does not, so
  `onRemoved` never fires. `/c/A -> /` stays deliberately ambiguous and is resolved by the content
  script when another concrete conversation id appears.

Either path calls `releaseTab`, which reaches the app over the bridge, and only then does
`closeConversation()` write the event. So the durable signal means *the browser reported the
conversation actually released*, not *a document unloaded*.

Why `unknown` and not `interrupted`: even a genuine release cannot tell whether the work died with
the page — ChatGPT may keep a server-side generation alive while the page is absent. Calling it
"interrupted" made an ordinary reload look like a failed turn.

**This is already a first-class, durable, queryable signal.** A recovery rule does not need new
detection — it needs to read `turn_end` events whose `outcome` is `unknown` and whose session has
not since produced a later `completed` one. `recordChatObservations` reconciles the pair when the
chat reopens, so a stale `unknown` that was really fine repairs itself.

### Distinguishing the shapes that look alike

| What you see | Outcome recorded | Reload? |
| --- | --- | --- |
| User clicked Stop | `stopped` | **never** |
| Conversation released mid-generation | `unknown` + the detail above | yes |
| Ten minutes of no progress | `stalled` | yes |
| Visible error banner | `failed` | depends on the banner |
| Turn closed normally | `completed` | no |

The Stop button being *present* is not by itself evidence of anything: it is present during every
live generation. It is only meaningful together with a turn that is no longer producing events.

---

## 4. Error messages, and how to fetch them

Two different things get called "an error", and only one is a chat failure.

### 4a. Visible banners

`CLF_DOM.errors()` (`extension/chatgpt-dom.js:1064`) collects `[role="alert"]` nodes, but every
filter on it is load-bearing:

- **`displayed(node)`** — ChatGPT announces ordinary UI state through screen-reader-only
  `role="alert"` live regions. Without this check one run recorded 60 fake errors
  ("Reasoning details opened", "Actions refreshed.", "Dictation is active and in use") against
  5 real transport failures.
- **`node.closest(OWN_SURFACES)`** — this extension's own UI was recording
  "Chat On Steroids Desktop is now connected" as a ChatGPT failure.
- **length between 2 and 500 characters.**
- **identity is the node + turn, never the text** — the same banner failing twice is two failures.
  Keyed on text alone, "Message delivery timed out" on turn nine was indistinguishable from turn
  three, so the second was dropped and its failed turn was written down as completed.

### 4b. Transport-failure prose

Some failures arrive as ordinary assistant markdown rather than a banner. `transportFailure()`
(`chatgpt-dom.js:257`) recognises a deliberately narrow set:

```
message delivery timed out
connection interrupted. waiting for the complete answer
unknown error occurred
there was an error generating (a|the) response
error in message stream
network error
something went wrong
```

This list is narrow on purpose — it runs against assistant prose, so a loose pattern would
classify a model *discussing* an error as an error.

The connection-interrupted line was added from the live 2026-08-30 renderer evidence in section 8.

`error in message stream` describes ChatGPT's own answer stream and can make that chat turn fail.
It is unrelated to the OpenRouter request made by the Goal model; bounded Goal-provider retries
are classified separately in `src/main/goal.ts`.

### 4c. Fetching the current error live

To capture what is on screen right now, run this in the ChatGPT tab's console. It reuses the
same filters the extension does, so what it prints is what the app would record:

```js
// Visible alert banners, minus this extension's own surfaces.
[...document.querySelectorAll('[role="alert"]')]
  .filter((n) => !n.closest('[data-clf-composer],[data-clf-menu],[data-clf-field]'))
  .filter((n) => n.getClientRects().length > 0)
  .map((n) => (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim())
  .filter((t) => t.length > 2 && t.length < 500);
```

```js
// Transport-failure prose rendered as an assistant message.
[...document.querySelectorAll('.markdown')]
  .map((n) => (n.innerText || '').replace(/\s+/g, ' ').trim())
  .filter((t) =>
    /(?:message delivery timed out|unknown error occurred|there was an error generating (?:a|the) response|error in message stream|network error|something went wrong)/i.test(t)
  );
```

`CLF_DOM.errors()` gives the same answer directly, but **it is not reachable from an ordinary
ChatGPT DevTools console**: `chatgpt-dom.js` and `content.js` run in the extension's *isolated*
world (only `fiber.js` is `world: "MAIN"`, per `extension/manifest.json`). To call it, switch the
console's execution context from the page to the Chat On Steroids content script first; otherwise
use the standalone snippets above, which depend on nothing but the DOM.

### 4d. After the fact, from the app

Errors and turn endings are durable, so a failure that has already scrolled away is still
readable without the browser. Session events are JSONL under
`<userData>/sessions/<sessionId>/`, and `readEvents(sessionId, { kinds: ['turn_end'] })`
(`src/main/session/store.ts`) is the supported reader. This is the right source for any
recovery rule: it survives the page being gone, which is precisely the case being recovered.

---

## 5. What this means for the unattended loop

Derived from the above, with no new detection required:

1. **"Prime finished"** is `turn_end` with `outcome: 'completed'`. Nothing else qualifies —
   not prose, not tool calls stopping.
2. **"Needs a reload"** is a `turn_end` with `outcome: 'unknown'` (especially with the detach
   detail) or `'stalled'`, with no later `completed` for that session.
3. **"Leave it alone"** is `outcome: 'stopped'`. The user made that decision by hand.
4. **Reconciliation already exists**: if the chat reopens and produces a real final message, the
   recorder resolves the earlier `unknown` into a later completed turn, so acting on `unknown`
   must be idempotent and must re-check before it types anything.

---

## 6. Controlled live probes — 2026-08-30

These observations came from signed-in Chrome, not from a fixture or source inference.

### Normal completion and Goal follow-up

In one signed-in conversation (call it A), the prompt `LIVE_FINAL_TEST_1` produced an assistant
message with a stable id and the requested final text. The Stop control disappeared, the message gained the normal
completed response actions, and the Goal loop then submitted `CYCLE_8` in a new user message.
That reply completed too, followed later by `CYCLE_9`.

This is the positive shape: a stable assistant message id plus terminal page state precedes the
next Goal submission. Goal did not need silence or a timeout to infer completion.

### Manual stop before answer text

Two controlled prompts were stopped through ChatGPT's real `Stop answering` button while the page
was still showing its request placeholder/thinking state. In both cases the placeholder disappeared,
no canonical assistant message was created, and no Goal follow-up appeared during the five-second
post-stop observation window.

This proves one important negative boundary: a user message followed by an absent assistant body is
not enough to retry or advance Goal. The explicit Stop click is the authority, even when there is no
partial prose to preserve.

### `Stopped thinking` followed by a delayed live request

In a second conversation (B), the blue `try again` item in the screenshot
was a normal **user message**, not a ChatGPT retry button. Its prior turn ended visibly as
`Stopped thinking`. Clicking that bubble had no retry semantics, so the same text was deliberately
submitted again through the composer.

The resent request first exposed a `request-placeholder-*` assistant node. That placeholder then
disappeared from the canonical message list, but the page rendered:

> Our systems are thinking a bit more about this request before responding.

Crucially, the real `Stop answering` control remained present for more than sixty seconds. There was
still no canonical assistant message, final response action row, visible transport-failure phrase,
or Goal follow-up at the end of that observation window.

This is **slow but still live** inside the bounded silence window. Placeholder disappearance is not
proof that generation stopped; the delay notice plus live Stop control says the server still owns
an active request, so a twenty- or sixty-second gap is not reload authority. The current recovery
boundary is two full minutes without a new durable assistant/native/error observation or attributed
MCP call. At that point an open ordinary, Prime or Worker chat receives one receipt-tracked reload;
a formal `turn_end` cancels it, and a reload that produces no new durable evidence is abandoned
rather than repeated. Exact Unattributed activity remains a separate one-minute correlation signal.

### Auto-compaction across that delayed turn

The same conversation displayed `384k/400k · autocompact on` while the safety-deliberation notice
and Stop control were present. Auto-compaction correctly did nothing during that live request.
Once ChatGPT ended it, the extension submitted the dedicated handoff-only prompt as a canonical user message.
ChatGPT returned a canonical 30,426-character assistant message with normal completed
response actions.

After the deliberate brief-stability window, the app durably recorded the handoff,
committed its continuation token, and rebound the same session from B to a
replacement conversation C. The durable browser receipt was committed, not merely
leased. Opening that exact replacement showed the carried brief folded under
`The handoff brief this app carried over — not something you typed`, and ChatGPT had begun the
continuation turn with its real Stop control present.

This observed chain establishes that the safety notice neither became a fake final answer nor
destroyed compaction. The trigger waited for the live turn to end; the handoff answer was captured
by exact generation; the continuation kept one session lineage across two concrete conversation
ids; and the replacement received the brief before beginning work.

### Refresh/close break run and the durable checkpoint rewrite

Two signed-in runs on 2026-08-30 tested the document-lifetime boundary directly. In the first,
the page was refreshed while ChatGPT generated the handoff, then the tab was closed before the
replacement opened. ChatGPT completed the full brief while the tab was absent, but the old
document-local capture disappeared and no replacement was opened. In a second clean chat
(`Hello. Reply with exactly: hello back`), the source brief completed and the UI reached
`Opening…`, but the replacement failed with `the replacement chat already belongs to another local
session`: ordinary destination journaling had won the race against continuation commit.

The implementation now makes the continuation WAL and ChatGPT-authored message ids the only
recovery authority. Each side is fenced twice: the app moves it to `attempted-unresolved` before
the composer is submitted at all, and then to `dispatched-unresolved` immediately before the
click. Only the caller that takes the second transition may press Send. Source and destination prompts
carry `[[CLF-HANDOFF:<token>]]` / `[[CLF-RESUME:<token>]]`. A new document scans the canonical Fiber
message model, binds the stable marked user-message id, and advances the checkpoint. The source
brief is accepted only from that turn's stable terminal assistant message with every connector call
answered and no local call pending. The destination binds its concrete conversation and message id
and commits the session rebind before ordinary page journaling can create a shadow session.

There is no `sessionStorage` capture, document-local generation ownership or second-send recovery.
The two pre-click states are replayable, because both are written before anything is submitted;
`dispatched-unresolved` is not, because a document that died there may or may not have sent, and
no local evidence can decide which. Automatic compaction enters the same `startCompact`/checkpoint
path as a manual press.

## 7. Turn markup as the live site serves it — 2026-08-30

Read off a signed-in conversation while it was generating, to check the selectors this repo
relies on against what ChatGPT actually renders today.

- **A turn is a `<section>`, and there are no `<article>` elements on the page at all.** Each
  turn is `<section data-testid="conversation-turn-N" data-turn="user|assistant" data-turn-id=…
  data-turn-id-container=…>`. Older ChatGPT builds used `<article>`, and code that still looked
  for one would see an empty transcript rather than a wrong one. `chatgpt-dom.js` carries no
  `article` selector, so nothing here needed changing — this is the check, recorded so the next
  reader does not have to repeat it.
- **`data-turn-id` is not `data-message-id`.** On a *user* turn the two are equal; on an
  *assistant* turn they differ. Anything that treats them as interchangeable is correct on user
  turns and silently wrong on assistant ones, which is the half that matters for generation
  identity.
- **A permanent empty live region exists on every page**: `div#aria-notify-live-region-assertive`
  with `role="alert"` and `aria-live="assertive"`, class `sr-only`, present from load and usually
  empty. A naive "any `role=alert`" error scan reports a phantom error on every observation. The
  `displayed()` filter in `errors()` already excludes it, for exactly this reason.
- **Generating state, confirmed together in one reading**: `[data-testid="stop-button"]` present,
  `[data-testid="send-button"]` absent, and `#prompt-textarea` still `contenteditable="true"` —
  so composer editability is not a generation signal, and the button pair is.

## 8. Failure-card markup from two existing live tabs — 2026-08-30

Captured read-only from two already-open signed-in Chrome tabs: no navigation, reload, Retry click,
or composer input. Private conversation, turn, and message ids are omitted. Both failures were
ordinary assistant turns, not top-level alert banners:

```html
<section data-testid="conversation-turn-N" data-turn="assistant" data-turn-id="…">
  <div data-message-author-role="assistant" data-message-id="…">
    <div class="… failure-card …">
      <div class="markdown"><p>…exact notice…</p></div>
      <!-- Delivery timeout only: native Retry button here -->
    </div>
  </div>
</section>
```

The permanent screen-reader live regions were still present, but empty and hidden. There was no
displayed `[role="alert"]` for either failure.

### Delivery timeout — terminal retry surface

Exact normalized assistant markdown:

```text
Message delivery timed out. Please try again.
```

Corroborating structure:

- the nearest card used ChatGPT's error tokens (`text-token-text-error`,
  `border-token-surface-error/15`, `bg-token-surface-error/5`)
- the same card contained
  `button[data-testid="regenerate-thread-error-button"]` with visible text `Retry`
- `[data-testid="stop-button"]` was absent

The current `transportFailure()` expression matches this exact prose, so `CLF_DOM.errors()`
returned this occurrence through the assistant-markdown path even without a `role="alert"`.
The Retry `data-testid` is strong corroboration of the terminal native error surface; the generated
utility-class list is descriptive evidence, not a selector contract.

### Connection interruption — waiting card that later went quiet

Exact normalized assistant markdown, notably with no final period in this rendering:

```text
Connection interrupted. Waiting for the complete answer
```

Corroborating structure:

- the nearest card used normal text/border tokens plus `mask-shimmer-muted`
- there was no native Retry button and no `[data-interrupted="true"]` descendant
- the screenshot caught ChatGPT's Stop control while the notice was waiting; the later read-only
  DOM capture found Stop absent while the same shimmer card remained mounted

The repaired detector recognises this exact assistant-authored line through `transportFailure()`.
It does not treat a displayed top-level alert, a user-authored row, or arbitrary assistant prose as
reload authority. Those occurrences remain recorded as session errors with `recoverable: false`.

### Recovery contract

Keep ownership in `extension/chatgpt-dom.js`; do not add another direct page scan in
`content.js`. The durable rule should be based on:

1. the latest exact assistant turn:
   `section[data-turn="assistant"][data-testid^="conversation-turn-"]`
2. assistant-authored markdown under `[data-message-author-role="assistant"]`
3. the exact whitespace-normalized notice, classified by a deliberately narrow allowlist
4. the native Retry `data-testid` and shimmer class only as corroborating evidence
5. a visible `role="alert"` live region carrying that same notice

Point 5 is not a lesser case of point 1. A send that fails before the model answers has no
assistant turn to render into, so ChatGPT announces it above the whole thread — "Message delivery
timed out" is only ever seen there. Such a banner names no turn of its own: the adapter reports
`turnId: null`, and `content.js` stamps the generation that was live when the banner came into
view, which is the same attribution `endOutcome` uses to close the turn as `failed`. Classifying
that shape as unrecoverable is what left chats parked on a visible error with the app having
recorded the failure, marked the turn failed, and then done nothing about it. An announcement the
allowlist does not recognise is still recorded as session evidence and still authorizes nothing.

Do not key an occurrence by text alone: the same wording can fail in two different turns. Preserve
the existing node-plus-turn identity. Do not depend on full Tailwind class strings; use
`mask-shimmer-muted` only as supporting evidence until ChatGPT exposes a semantic attribute for the
waiting card.

The DOM adapter only classifies and reports. It never reloads the page. The app accepts a
recoverable transport error only when the observation names the exact conversation and the page's
live local generation. The same app-owned recovery queue also handles a missing agent tab and a
chat whose open turn produced no page or tool activity for two minutes.

The extension then scans Chrome's actual `chatgpt.com` tabs immediately before acting:

- exactly one tab for the conversation: reload that tab
- no tab: open that exact `/c/<conversation-id>` URL
- more than one tab: reload the copy the worker's own tab registry binds to that conversation,
  falling back to the lowest tab id so two passes cannot pick differently. Bailing out here left
  the chat broken *and* left the duplicate sitting there. Never open another tab in this case.

**What retires a queued repair is scoped to the evidence it was filed on.** A `silence` or
`no-tab` repair is about a chat, so ordinary activity ends its episode. An `unattributed` or
`assistant-error` repair is about one broken *turn*, and only two facts retire it: the browser
carrying it out, or the chat finishing a turn since it was filed. Do not let an attributed
connector call delete an `assistant-error` repair — attribution proves the request-id join, not
the answer stream the page lost. The 2026-08-31 trace is why: a worker printed "Connection
interrupted. Waiting for the complete answer" and the model went on running server-side, so
fifteen attributed calls arrived over the next four minutes and each one deleted the reload that
notice had just asked for. A chat sick enough to need reloading is usually a chat still calling
tools, so a repair that can be erased by activity is a repair that is never handed out at all.

One action receipt spends that failure/inactivity episode. A second action for the same
conversation cannot happen for at least three minutes, even for a different trigger. New meaningful
page/tool activity is required to create a new silence episode. At four minutes of uninterrupted
open-turn silence, a joined worker uses the existing stop decision: below 400k context tokens it
becomes sleeping/revivable; at or above 400k it becomes finished. The setting **Recover inactive
agent tabs** disables error, silence, and missing-tab browser recovery without changing the worker's
underlying lifecycle state.

### Post-reload final answers and attributed activity

A page reload can end the only local generation as `unknown` while the server-side model keeps
working. Exact request-id attribution still proves every later connector call belongs to that
conversation. Those calls therefore renew one activity grant even though there is no open local
turn; two minutes after the last one, the normal one-shot browser recovery runs. A call that merely
settles late after `completed` or `stopped` does not receive that authority. The renderer uses the
same exact tool-call timestamps, not generic session `updatedAt`, to show any agent chat as
`active` — for three minutes, deliberately one minute longer than the recovery window.

**The two windows are separate constants and must stay ordered.** `CHAT_SILENCE_MS` (two minutes)
is when a silent open turn earns its one reload; `CHAT_ACTIVE_MS` (three minutes) is how long the
badge keeps calling that chat active. Sharing one constant made the label expire on the same
instant the ledger did, while the reload still had this app's maintenance tick and the extension's
thirty-second alarm floor in front of it — a chat measured silent at 2:00 was observed reopening at
2:40, after its badge had already gone dark. The app half of that lag is gone: the ledger is
inspected on the deadline itself, not at the next thirty-second tick. Chrome's alarm floor still
owns the rest, which is what the extra minute of badge covers.

A stable final assistant message is stronger than the lost local generation for two decisions:

- it ends the browser-recovery grant immediately, so a complete answer is never reloaded later;
- after a newer `unknown`/`failed`/`interrupted`/`stalled` turn boundary, it creates the Goal
  obligation even when the page can no longer supply that turn id.

The prior uncertain boundary and its turn-start timestamp fence this recovery: opening an old idle
chat, or seeing a final authored before that uncertain turn began, creates no Goal work. The
canonical stable assistant message id is the exactly-once identity. The recorder preserves its `goalEligible` fact
monotonically, the app writes the pending/handled Goal ledger before acknowledging `/events`, and
replays after a 503, page reload or app restart converge on that same reply. A synthetic
`reply:<stable-message-id>` draft key is used only when the document-local generation is gone; it
does not fabricate a `turn_end` event.

## 9. Overwrite ambiguity from one reused ChatGPT request id — 2026-08-30

A read-only live inspection of an existing long-running chat found 24 native tool rows, but only
one row carried app-owned call identity. The durable session held 130 correctly request-attributed
tool calls. ChatGPT had reused the same request id for every call while the recorder held them
across three local turn groups: 64 calls in one turn id, 16 in another, and 50 with no local turn
id.

That is not missing tool history. It is an ambiguous presentation join: request id alone selects
all 130 calls, while local turn id selects only fragments of what the reloaded page renders as one
response. Overwrite therefore fails closed and leaves ChatGPT's native rows visible instead of
attaching the wrong local activity to the wrong assistant response. Do not repair this by choosing
the first matching group or by treating a repeated request id as a turn id.

The local session remains authoritative for tool execution: all 130 calls and their outcomes were
present and request-attributed. The authored transcript has a different evidence boundary. The
interrupted long turn contained only the 163-character streaming assistant fragment the browser
actually observed before it stalled; a later turn contained its separate settled assistant answer.
The app must not invent missing final prose or merge those messages merely to make Overwrite look
complete.
