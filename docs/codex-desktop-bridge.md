# RFC: bounded Codex Desktop thread bridge

## Status

Design draft only. This document deliberately adds no production tool yet.

The missing piece is not the thread API. Codex app-server already has bounded methods for
listing, reading, creating and messaging threads. The missing piece is a supported way for a
separate local app to bind those methods to the **specific Codex Desktop instance the user is
looking at**, rather than to an unrelated CLI/default daemon.

Implementing before that ownership boundary is agreed would recreate the bug this proposal is
meant to remove: a successful backend acknowledgement that affected the wrong task.

## Problem

Chat On Steroids can inspect local recordings and can control the desktop, but neither is the
right default for supervising an existing Codex Desktop task:

- GUI automation steals focus and competes with the user's foreground work;
- writing into Codex's persisted databases bypasses its ordering and notification contracts;
- invoking `codex queue` or another CLI command may reach a different app-server daemon;
- a successful CLI response therefore does not prove the visible Desktop task received anything.

The desired workflow is background-first:

```text
ChatGPT
  -> Chat On Steroids Core
  -> the user's current Codex Desktop app-server
  -> one explicitly identified Desktop thread
  -> that thread may use its own control-chrome integration
```

The browser part stays inside Codex Desktop. The bridge does not proxy browser cookies, tabs or
profiles; it only sends a normal user message to a Desktop thread. That thread can then use the
same Chrome/Dia state it already owns.

## Proposed model-facing contract

Expose one flat Core tool, not five schemas:

```text
codex_desktop action=list
codex_desktop action=read   thread_id=...
codex_desktop action=send   thread_id=... message=...
codex_desktop action=wait   thread_id=... cursor=...
codex_desktop action=create cwd=... message=...
```

`create` must be used only when the user explicitly asks for a new Desktop task. Ordinary
supervision should locate and continue an existing thread.

The tool should return enough identity to prevent same-title mistakes:

- thread id;
- user-facing title;
- working directory;
- runtime status and active flags;
- updated time;
- a compact user/assistant transcript or update cursor.

It should not expose arbitrary app-server RPC, raw internal events, or an unbounded thread dump.

## App-server mapping

The current Codex app-server protocol already supplies the required primitives:

| Tool action | App-server methods |
| --- | --- |
| `list` | `thread/list` |
| `read` | `thread/read`, then bounded `thread/items/list` pages |
| `send` | `thread/queue/add` for an active task, or `turn/start` when idle |
| `wait` | event subscription when available, otherwise bounded `thread/read` / item polling |
| `create` | `thread/start`, followed by `turn/start` |

A successful `send` is not complete at the first RPC response. The bridge must:

1. generate a unique `clientUserMessageId`;
2. receive the queue/turn acknowledgement from the bound app-server;
3. read the same thread back;
4. confirm that exact client message is queued or present in the thread;
5. return the acknowledgement and observed thread identity together.

That final read is what turns "a server accepted bytes" into "this Desktop task received the
message".

## Binding requirement

The bridge must bind to the app-server instance owned by the current Codex Desktop application.
It must not silently fall back to another locally running Codex daemon.

A usable binding needs at least:

- an authenticated or OS-authorized transport supplied by Codex Desktop;
- a stable instance identity for the lifetime of the connection;
- an initialization response that can be checked before any thread mutation;
- disconnect/restart detection so a stale endpoint cannot be mistaken for the same app;
- explicit failure when the Desktop instance is unavailable.

### Current finding

Codex app-server supports official WebSocket transports when a server is launched with an
explicit `--listen` endpoint, and it also has an experimental remote-control protocol. Those are
real integration contracts.

The current packaged Codex Desktop instance, however, does not expose a documented local
app-server endpoint to unrelated processes. Its internal dynamic app-tools pipe is peer-authorized
and is not a third-party integration surface. An external Chat On Steroids process is rejected,
which is the correct boundary; this proposal must not weaken or bypass it.

Therefore the first implementation requires one of these supported seams:

1. Codex Desktop publishes a scoped local app-server endpoint or capability token;
2. Codex remote-control pairing exposes the current Desktop instance to an approved local client;
3. Codex Desktop supplies a small first-party app tool that forwards only the allowlisted thread
   operations.

Until one of those is available, connecting to a separately launched app-server can validate the
protocol client but cannot honestly be called control of the user's current Desktop task.

## Rejected approaches

### GUI typing as the normal path

Useful for testing the UI itself, but wrong for task coordination. It changes foreground state and
provides no durable thread acknowledgement.

### Bare Codex CLI commands

The CLI binary and Codex Desktop share lower-level runtime code, but they are not the same product
instance. A default daemon acknowledgement is not proof about the visible Desktop task.

### Direct database writes

They bypass app-server ordering, queues, notifications and renderer state. The database is
persistence, not a mutation API.

### Attaching to private pipes

The packaged app's private pipe is peer-authorized. Spoofing or disabling that check would turn a
narrow convenience feature into an unsupported privilege boundary.

### Generic RPC passthrough

The model should never receive a method name plus arbitrary JSON. The bridge owns a small method
allowlist and validates every request and response.

## Permission and privacy model

Keep one model-facing schema but separate the user grants:

- **Read Codex tasks**: list, read and wait;
- **Control Codex tasks**: send and create.

Global read-only mode disables the control grant but can leave bounded reads available.

Thread reads can contain private prompts and code context. Results should therefore be bounded,
redacted through the same secret handling used by session recording, and limited by default to:

- user messages;
- assistant messages;
- compact status/tool headlines;
- no raw command output or arbitrary MCP arguments unless a future explicit detail action earns it.

The bridge must never expose browser storage, cookies or authentication material. Asking a Desktop
thread to use `control-chrome` is a message to that thread, not browser credential transfer.

## Lifecycle and failure behavior

- No foreground activation of Codex Desktop.
- No automatic creation when an existing task was requested.
- No title-only addressing; mutations require the exact thread id.
- No retry against a different endpoint after disconnect.
- A Desktop restart invalidates the client and requires a fresh instance handshake.
- `wait` is bounded and returns an update cursor; it is not an unbounded background process.
- Ambiguous or stale identity fails closed.

## Staged implementation

### Phase 1: transport decision

Agree with the maintainer which supported Codex Desktop binding seam this project is willing to
depend on. Retain the explicit app-server WebSocket client as a protocol test fixture, not as a
claim of Desktop integration.

### Phase 2: bounded vertical slice

Implement `list`, `read` and `send` behind one `codex_desktop` schema, with separate read/control
permissions and deterministic fake-app-server tests. Verify exact `clientUserMessageId` delivery.

### Phase 3: live acceptance

From ChatGPT, without focusing Codex Desktop:

1. list Desktop tasks and identify one by id + title + cwd;
2. read its current tail;
3. send a harmless message;
4. observe the same message in that exact task;
5. wait for its next assistant update;
6. verify the task can use its existing `control-chrome` browser state.

Only this live proof closes the original problem.

## Questions for review

1. Is a Codex Desktop bridge within this project's scope, or should it remain an external plugin?
2. Which supported binding should Chat On Steroids target: a local capability endpoint,
   remote-control pairing, or a first-party forwarding app tool?
3. Does the one-schema/two-permission contract fit the current Core surface?
4. Should `create` ship in the first slice, or follow after existing-thread supervision is proven?
