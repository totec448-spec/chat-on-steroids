# cos-sessions

The session store under `<userData>/sessions/`, the read model that the control API serves,
tool-call recording, and the `update_plan` tool. It ports `src/main/session/store.ts`,
`read-model.ts`, `request-plans.ts`, the tool-call half of `recorder.ts`, `summarize.ts`, and
`src/main/mcp/plan-tool.ts`.

## What it keeps on disk

| Path | Written by | Notes |
| --- | --- | --- |
| `sessions/<id>/events.jsonl` | every append | One event per line, 512 KiB at most. A longer event is refused and spends no sequence number. |
| `sessions/<id>/meta.json` | 1.5 s after a change, and on `flush` | The summary plus `__historySeq`, `__canonicalProjection` and `__tokenEstimate`. The previous valid file becomes `meta.backup.json`. |
| `sessions/<id>/messages.json` | session creation | `{}`. Read with `messages/<sha256>.json` shards as the canonical overlay. |
| `sessions/<id>/assets/<hash>.<ext>` | the recorder | Text past 8,000 UTF-16 units, and tool images. Content addressed, inside the 192 MiB per-session and 2 GiB global quotas. |
| `sessions/<id>/plan.json` | `update_plan` from a proven chat | Replaced atomically. An older call never replaces a newer plan. |
| `state/request-plans.json` | `update_plan` with only a request id | Through `cos_store::Durable`. |
| `state/blocked-chats.json` | `BlockedChatsLedger::set` | At most 200 chats; a full list refuses a new block. Written soon, flushed at shutdown. |
| `state/trusted-chats.json` | `TrustedChatsLedger::set` | At most 200 chats. On disk before the change takes effect. |

A new chat's session is reserved under its first message's id before ChatGPT names the chat
(`create_reserved`, with a desktop origin and no events), and bound to that chat by its first
receipt (`bind_conversation`, written to `meta.json` before memory says so).

`ChatAccess` is the kernel's `ChatPolicy` (`conversation-access.ts`). A call proven to come from
a blocked chat gets `BLOCKED_CHAT_REFUSAL`. With `multiAgent.strictChatAllowlist` on, only a
trusted chat runs tools, or the current chat of a session whose committed Compact & Resume
lineage reaches a trusted chat with no blocked chat on the way; a session created as a worker
and any call with no proven chat get `STRICT_CHAT_REFUSAL`. The broker-owned worker rule and the
one-per-episode refusal notice in the chat's timeline wait for the agents and progress owners.

Writes serialize per session. A call with no browser proof goes to this process's
Unattributed activity session, which is created on the first such call. Once its request id is
proven, `repair_attribution` moves it to its chat and rewrites the bucket without it
(`attribution.rs`). A plan held under a request id moves to its chat with `attach_request_plan`.

## How it is proven

- `tests/golden_read_model.rs` rebuilds the `base` corpus session from its recorded event
  stream, with no `meta.json`, and compares the list, the detail, every event page and every
  stream page with `rust/golden/base/api`.
- `tests/store.rs` drives the recorder and `update_plan` and reads the session folder back.
- `tests/chats.rs` runs the cases of `test/blocked-chats.test.ts` and `test/trusted-chats.test.ts`.
- `tests/access.rs` runs the blocked-chat and strict-mode cases of `test/mcp.test.ts` through the
  real kernel.
- `tests/plan_attach.rs` attaches held request plans to their chat, including one accepted
  before its chat was replaced by Compact & Resume.
- `tests/request_plans.rs` sends the `update_plan` cases of `base` and `unattributed` through
  the kernel with their recorded `x-request-id`, compares each answer with the corpus, and
  reads the plan held for the request from `state/request-plans.json`.
- `src/summarize.rs` summarizes every recorded corpus call and compares the result with the
  summary that the TypeScript app wrote.
- `differential/run.mjs` feeds `differential/ops.json` to the TypeScript recorder (vitest, no
  Electron window) and to this store, then compares the two `sessions/` trees. It needs
  `node_modules` at the repository root.

```sh
node rust/crates/cos-sessions/differential/run.mjs   # exit 0 equal, 1 different, 2 a side failed
```
