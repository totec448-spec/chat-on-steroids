# cos-recorder

The browser recorder (unit E2.2). It files what a ChatGPT page reports into sessions, and keeps
the request-id proof ledger that places each MCP tool call in the chat that made it. It ports
the observation half of `src/main/session/recorder.ts`, `src/main/session/correlation.ts`, and
the `/events`, `/correlations` and `/closed` handlers of `bridge.ts`. `/conversation-deleted` ends
waiting messages, so it belongs to the outbox (`cos-input`).

The bridge family `cos_bridge::families::recorder::Observations` is the wire layer. It reads the
body and calls `Recorder`. `cos-core` builds one `Recorder` and uses it three times: as that
family, as the kernel's `Attribution` port, and for the `conversations` of `/status`
(`Recorder::live_conversations`, read only, ordered by conversation id).

## What it keeps

| Path | Written by | Notes |
| --- | --- | --- |
| `state/request-correlations.json` | `Correlations` | Version 6 with `complete: true`. A new owner is written before `/correlations` or `/events` answers (`commitRequestCorrelations`). A fresher sighting of a known owner is written after a short delay. Versions 3 to 5 are read, and a ledger that is not a complete version 6 is rebuilt from the request-id calls of the newest 100 sessions. |
| `sessions/<id>/...` | `cos-sessions` | One session per ChatGPT conversation. Messages, with their reaction, image attachments and cited sources, and ChatGPT-generated images are canonical shards under `messages/`; a generated image's WebP preview is an asset, kept once the provider reports the image finished and the preview decodes at the size the page reported. Turn starts, turn ends, page tool rows, chat errors and close notes are journal lines. Turn outlines are `traces/<turnId>.json`. |

## Rules it keeps

- The first page that proves a request id owns it for good. A later claim from another chat is
  refused, and no clock ages an owner out.
- Evidence waits belong to the request. Every caller measures its allowance from the request's
  first wait (`Correlations::wait_for`).
- Observations of one conversation are written in arrival order. First sight of a conversation
  creates at most one session, and a closed chat that reports again reopens its own session.
- A conversation that Compact & Resume replaced gets no session of its own. Its messages go to
  the session that holds it in its lineage.
- Late proof. The kernel resolves the caller once, before the call runs, and waits for page
  evidence only while a chat is blocked or strict chat allowlisting is on
  (`Attribution::resolve_proven`, up to 20 s per request id), because those rules refuse by
  chat. A call whose request id is not proven yet is filed as Unattributed. When the
  ledger stores a new owner, the calls already filed under that id move to the owner's session
  (`SessionStore::repair_attribution`, `repairDeterministicAttribution`): a burst of new
  owners becomes one pass 250 ms after the first, passes never overlap, and restore starts one
  pass over every bucket without awaiting it. A moved call keeps its `callId`, so a pass that
  stopped halfway appends nothing twice. An old bucket left empty is deleted; this process's own
  bucket stays. Shutdown phase 3 runs the passes already asked for (`Recorder::settle`).
- A plan held under a request id (`update_plan` before the chat was known) becomes the chat's
  plan when a page proves the id, and at restore for ids proven before (`attachRequestPlan`).

## How it is proven

- `tests/correlation.rs` runs the cases of `test/correlation.test.ts` against the ledger, with
  paused time for the evidence waits.
- `tests/recorder.rs` drives the routes and the attribution port. It checks that a proven
  request files its tool call in its chat, and that an unproven one stays Unattributed.
- `tests/late_proof.rs` runs the cases of `test/attribution-repair.test.ts` and the request-plan
  cases of `test/agent-plan.test.ts` through the recorder: a call proven late moves, what stays,
  what a restart deletes or reuses, and the plan held for a request.
- `differential/run.mjs` sends the recorded `/events`, `/correlations` and `/closed`
  fixtures of `cos-types`, `differential/scenario.json` and `differential/late-proof.json`, to the
  TypeScript bridge (`startBridge` on port 0, vitest, no Electron window) and to this recorder.
  It then compares the answers, every file under `sessions/`, the correlation ledger and
  `state/request-plans.json`. `late-proof.json` also makes MCP calls with an unproven request id
  and holds a plan under one, then proves both. It needs
  `node_modules` at the repository root.

```sh
node rust/crates/cos-recorder/differential/run.mjs   # exit 0 equal, 1 different, 2 a side failed
```

- `differential/e2e-headless.mjs` runs the release `cos-headless` on a fresh profile with
  `CLF_BRIDGE_PORTS=0`. It pairs and reports a chat over the bridge with the extension's headers,
  proves a request id, then makes a Core MCP `read` call with that `x-request-id`. It checks
  through `/v1` that the call is filed in the chat's session with `request_id` attribution.
  The unchanged extension cannot take part: its content scripts run only on `chatgpt.com`.

```sh
node rust/crates/cos-recorder/differential/e2e-headless.mjs rust/target/release/cos-headless.exe
```

## Not ported yet

- The 20 s evidence wait TypeScript holds while it records a call. Here the call is filed at once
  and moved when its proof arrives, so it shows in Unattributed activity for that moment.
- The recovered turn end after a reload (`readCompletedFinal`), and the call evidence that
  reopens a falsely ended turn (`reopenFalselyEndedTurn`).
- What `/events` feeds other owners in TypeScript: agents, Goal replies, browser recovery and
  connector identity from app sightings.
- `/activity`, `/activity/detail` and `/core-plugin`.
