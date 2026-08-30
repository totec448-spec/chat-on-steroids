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
unknown error occurred
there was an error generating (a|the) response
error in message stream
network error
something went wrong
```

This list is narrow on purpose — it runs against assistant prose, so a loose pattern would
classify a model *discussing* an error as an error.

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

This is **slow but still live**, not the stale/reload shape. Placeholder disappearance is not proof
that generation stopped; the delay notice plus live Stop control says the server still owns an
active request. Recovery must not reload this chat merely because no assistant message or tool call
has appeared for twenty seconds. It becomes eligible only after the live-generation evidence also
ends without a terminal answer, or exact unattributed activity supplies the separate correlation
signal described by the recovery policy.

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
