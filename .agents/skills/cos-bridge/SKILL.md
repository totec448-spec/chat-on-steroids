---
name: cos-bridge
description: Orchestrate Chat On Steroids broker workers directly from T3 Code or another local agent; delegate, message, collect reports and check progress.
---

Run Node 22+ with the CLI in the CoS checkout (three parents above this skill's real folder):

`node <checkout>/scripts/t3-code-bridge.mjs <command> [--request-file request.json] [--data-dir <CoS userData>]`

Use UTF-8 JSON requests. CoS needs Local control API, Allow actions, workers and its normal
ChatGPT connection enabled. Direct control requires the advertised v1 worker routes; an
older build returns `worker_broker_unavailable`. Output is JSON lines; failures exit nonzero.

| Command | Request fields (`?` optional) |
| --- | --- |
| `health`, `status` | None; capabilities or runtime state. |
| `delegate` | `ownerId, workers:[{label?,task}], context?, projectId?, runId?`. |
| `message` | `ownerId, messages:[{to,text,label?}], runId?`; reuse sleeping workers. |
| `agents`, `reports` | `ownerId, runId?`; compact worker state or unread reports. |
| `ack` | `ownerId, messageIds:[...], runId?`; acknowledge consumed report ids. |
| `sessions` | `limit?` (1–50; default 20), `cursor?`. |
| `session` | `sessionId`; live state. |
| `updates` | `sessionId, from?` (0), `durationMs?` (1–45000; default 30000), `limit?` (1–100; default 100). |
| `send` | `id, text, sessionId?, projectId?, interrupt?`; ordinary ChatGPT chats. |
| `inputs` | `id?`; prefer an exact ordinary message's delivery receipt. |

Persist one lowercase UUID `ownerId` per T3 task and retain returned run/worker ids; worker
names are scoped to their run. T3 is the orchestrator; workers report through CoS. Use saved
worker model/effort defaults. Tasks/context are ≤4000 characters, 1–8 workers per spawn,
1–16 messages per batch. Give workers the repo, scope and validation in context; select a
known `projectId` for CoS workspace/worktree policy. Check actual reports before completion.

Read `reports`, save results, then `ack` their exact ids. Reports repeat until acknowledged.
After an uncertain worker mutation, inspect `agents` and `reports` before retrying. Save
`updates.nextFrom` and use a small limit for new progress; upsert revisions by message id.
An end frame ends a read, not the task. For ordinary `send`, persist a new UUID first;
inspect `inputs` after failures and never resend unconfirmed delivery. `interrupt:true`
requires consent to stop the current answer. Details: `docs/t3-code-bridge.md` in the checkout.
