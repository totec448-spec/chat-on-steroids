# cos-goal

Goal and Loop (unit E2.7): a second model, standing in for the user, that keeps a chat moving.
It ports `src/main/goal.ts`, `src/shared/goal.ts`, `goal-errors.ts` and `goal-templates.ts`,
and the `/goal/{draft,ack,objective,open}` handlers and the chat-scoped switches of
`POST /settings` in `bridge.ts`.

The page owns "the turn is really over". This crate owns everything after that: the per-chat
ledgers, the provider credential, the request to the helper model, and the one draft per
finished turn the page may type. `cos_bridge::families::goal::GoalRoutes` is the wire layer.

## State

| File | Holds | Written |
| --- | --- | --- |
| `state/goal-objectives.json` | One chat's specific goal, trimmed | Before the save is answered |
| `state/goal-switches.json` | One chat's own Goal/Loop switch, or a helper chat's identity (`role: decision`) | Before the switch is published; at most 400 rows, helper identities never lapse |
| `state/goal-replies.json` | The stable reply each chat still owes one decision (`pending`), or its tombstone (`handled`) | Before an accept or an ACK is answered, otherwise 300 ms later; at most 200 rows, a pickup expires after 12 h |

Drafts live in memory only, one per conversation, keyed by the turn they answer. A repeated
request for the same turn returns the draft that exists. A payload is kept 10 minutes; the
token stays as a spent tombstone until a newer turn replaces it.

The three ledgers are three files with one writer each: a save stages a copy, writes it, and
only then publishes it. The in-memory maps share one mutex so a read that spans two of them
(`armed_for` reads the switch and the objective) sees one moment; it is never held across an
await. The owed-reply ledger is changed in memory first and rolled back when its write fails,
as TypeScript does; a deferred write snapshots memory when it runs, so it never writes a stale
copy over a newer one.

## Providers

| Backend | Request |
| --- | --- |
| `api`, OpenRouter | `POST https://openrouter.ai/api/v1/chat/completions` with the key from `secrets.bin` (`openRouterApiKey`), attribution headers, `provider.require_parameters`, `reasoning.exclude`, and a strict `response_format` |
| `api`, custom | `POST <baseUrl>/chat/completions`, plain OpenAI-compatible, bearer only when `customProviderApiKey` is set. The URL must be https, or http on localhost |
| `templates` | No request: the offline `[[COS_GOAL:…]]` markers |
| `chatgpt` | The `Helper` port. No browser helper is ported yet: `NoHelper` refuses as `goal_browser_send_failed`, a settled failure |

HTTP goes through `hyper-util`'s client with `hyper-rustls` (ring, native roots), the stack
already in the lockfile. There is no retry inside a request; `retryable` tells the page whether
asking again can help. Every answer passes the same decision guard before it can be typed:
strict `{action, reply}` JSON, tokenizer markers stripped, any standalone `NO_REPLY` read as
stop, and `humanReply` (no em dash, one to three seeded slips outside code, paths and URLs).

## Ports

| Port | Owner | With no owner |
| --- | --- | --- |
| `Chats` | Recorder (live page sessions), blocked chats, agent workers, outbox, the kernel's running calls | `NoChats`: no live page, nothing blocked or working, no automatic sends. `cos-core` wires the recorder, the blocked-chats ledger, the outbox and the kernel; no chat is a worker until E2.6 |
| `Helper` | The ChatGPT helper tab (browser decisions) and the companion's model catalog | `NoHelper` |

## Goal at a held finish

`FinishGoal` is what the finish owner (E2.5) calls when a turn holds at `session_finish`:
`automatic(conversation)` (`automaticFinishEnabled`), `driving(conversation)` (mode and
objective for its revision hash) and `followup(session, context, mode)` (`draftFastFollowup`):
`Ok(Some(text))` is the next instruction, `Ok(None)` means nothing is left (or Loop has no MCP
work to continue from), and `FollowupFailure::retryable` says whether its retry loop may ask
again. [`Goal`] implements it; `cos-core` passes the owner to the finish crate behind its own port.
The finish owner keeps the hold, the progress rows, the retries and the delivery.

## How it is proven

- `tests/oracle.rs` replays `differential/corpus.json` through the Rust port and compares with
  `differential/oracle.json`, which `differential/oracle.mjs` writes by running the same corpus
  through the TypeScript modules (vitest, no Electron): `humanReply`, the error explanations and
  catalog keys, base URL rules, and every offline template.
- `tests/drafts.rs` runs the draft cases of `test/goal.test.ts` against a loopback stub provider
  that answers recorded replies and keeps the requests it was sent: one request per turn, tab
  ownership, goal met, continuations, legacy SSE, split and unterminated streams, `[DONE]`,
  streamed errors, unusable answers, refusals and their retry classes, keys and request bodies
  for both providers, the Loop retry, the opening message, the payload TTL and master Off.
- `tests/ledgers.rs` runs the switch, objective and owed-reply cases, each read back after a
  restart from `state/`, including damaged rows on restore and the pickup budget.
- `cos-companion/differential/run.mjs` compares `POST /settings` with a chat-scoped switch
  (`POST_settings.01`, `.04`) against the TypeScript bridge.

## Not ported yet

- `/activity` and `/activity/detail`. Both answer `404 not_found`. The feed is a projection of
  the recorder's hydrated activity tail, continuation jobs, workers and browser recovery; the
  Goal view inside it is `Goal::view_for`, `pending_reply_for`, `switch_for` and
  `objective_for`.
- The ChatGPT helper tab (`requestBrowserDecision`, temporary planners) and `draftTaskPlan`
  (the task planner). `draftFastFollowup` without a prepared context does not add the last five
  delivered outbox inputs, and the OpenRouter model
  catalogue (`listGoalModels`).
- Silence tickets (`g-silence-*`): with no silence owner a synthetic turn is never confirmed.
  The Pro busy window, `activeUntil` grants and the outbox's input priority over Goal.
- `readCompletedFinal` is approximated: the newest final answer of the turn with no newer
  question and no other turn open. Native image finals and request-turn ownership are not read.
- The handoff anchor of `conversationMessages` (the Compact & Resume bootstrap), and the
  first-user recovery when the recent window is saturated.
- `Retry-After` as an HTTP date; only seconds are read.
