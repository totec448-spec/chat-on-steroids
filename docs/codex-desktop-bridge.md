# RFC: bounded Codex Desktop thread bridge

## Status

Design draft only. This document deliberately adds no production tool yet.

The transport picture changed after this RFC was opened. Codex CLI 0.152.1 ships an official
`codex queue --thread <UUID> --message ...` command against the shared local app-server. On a Mac
running Codex Desktop, queuing to the UUID of a task already visible in Desktop delivered the next
user turn to that exact task and the task continued there, without foreground activation or GUI
automation.

That materially shrinks the original blocker: background **send to a known existing Desktop thread**
is now proven through a supported Codex surface. The remaining integration question is narrower:
which supported list/read/wait primitives provide bounded identity and transcript/status evidence
for those same Desktop threads, and what host-instance guarantees should Chat On Steroids require
before it exposes them to the model.

## Problem

Chat On Steroids can inspect local recordings and can control the desktop, but neither is the right
default for supervising an existing Codex Desktop task:

- GUI automation steals focus and competes with the user's foreground work;
- writing into Codex's persisted databases bypasses its ordering and notification contracts;
- title-only or default-daemon addressing is ambiguous;
- a transport acknowledgement alone is not enough unless the bridge can name and read back the
  exact thread that received the message.

The desired workflow is background-first:

```text
ChatGPT
  -> Chat On Steroids Core
  -> supported Codex local thread surface
  -> one explicitly identified Codex Desktop thread
  -> that thread may use its own control-chrome integration
```

The browser part stays inside Codex Desktop. The bridge does not proxy browser cookies, tabs or
profiles; it only supervises Codex threads. A Desktop thread can then use the Chrome/Dia state it
already owns.

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

## Codex mapping

The existing app-server protocol has thread list/read/start/turn primitives, while the shipped CLI
now provides a first-party existing-thread queue operation. The first vertical slice should prefer
these supported surfaces rather than invent a private transport.

A successful `send` is not complete merely because a process exits zero. The bridge should:

1. require an exact thread id;
2. generate or retain an operation identity when the supported surface allows it;
3. receive the Codex acknowledgement;
4. read that same thread back through a supported read surface;
5. confirm the expected user message/turn is queued or present;
6. return acknowledgement and observed thread identity together.

The live `codex queue --thread <UUID>` test proves steps 1–3 can reach the exact Desktop-visible
thread. Steps 4–6 are still the important product boundary for a model-facing CoS integration.

## Binding and identity requirement

The bridge must never silently mutate a task selected only by title, cwd, or whichever daemon
happens to answer first. Mutations require the exact Codex thread id.

For the initial existing-thread slice, a usable integration needs at least:

- supported enumeration that yields exact thread ids plus enough metadata to choose safely;
- bounded read-back for the exact id;
- the official queue/send path for that id;
- restart/stale-thread behavior that is detectable rather than silently redirected;
- explicit failure when Codex cannot establish the requested thread identity.

### Current finding

The earlier version of this RFC treated Desktop binding itself as the unsolved transport problem.
That is now too strong.

On Codex CLI 0.152.1, this was verified end to end against a task already visible in Codex Desktop:

```text
codex queue --thread <exact-visible-thread-uuid> --message <harmless message>
```

The message became the next user turn in that exact Desktop task and execution continued there.
There was no GUI focus/click/type path and no separately created replacement thread.

Therefore we should not build or bypass a private Desktop pipe merely to obtain background send.
The remaining work is to verify the supported enumeration/read/wait surface and its identity/staleness
semantics, then wrap only the subset CoS actually needs.

A separately launched generic app-server remains useful as a protocol test fixture, but production
code should not silently fall back to it when the user asked to supervise an existing Desktop task.

## Rejected approaches

### GUI typing as the normal path

Useful for testing the UI itself, but wrong for task coordination. It changes foreground state and
provides no durable thread acknowledgement.

### Unscoped/default CLI addressing

The fact that `codex queue --thread <exact UUID>` is now useful does not make title-only or implicit
default-task mutation acceptable. The bridge must always carry exact thread identity and should
read the target back after mutation.

### Direct database writes

They bypass app-server ordering, queues, notifications and renderer state. The database is
persistence, not a mutation API.

### Attaching to private pipes

Codex Desktop's internal pipes are not a third-party integration contract. There is no reason to
weaken or spoof that boundary when a first-party queue path already exists for the key send use case.

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
- No silent retry against a different thread or daemon after failure.
- Stale/unknown thread identity fails closed.
- `wait` is bounded and returns an update cursor; it is not an unbounded background process.
- Successful send should include read-back evidence when the supported Codex read surface permits it.

## Staged implementation

### Phase 1: verify the remaining supported identity surface

Keep the already-proven exact-thread `codex queue` send path. Verify how current Codex exposes:

- bounded thread enumeration;
- bounded thread read/tail;
- active/idle status;
- update/wait semantics;
- behavior across Codex Desktop restart and stale thread ids.

Do not use private pipes or database mutation to fill a missing capability.

### Phase 2: bounded vertical slice

Implement existing-thread `list`, `read` and `send` behind one `codex_desktop` schema, with separate
read/control permissions and deterministic fake/runtime tests. Use the supported queue path for send
unless a lower-level first-party contract is demonstrably required.

Leave `create` out of the first slice unless it naturally falls out of the same supported surface.

### Phase 3: live acceptance

From ChatGPT, without focusing Codex Desktop:

1. list Desktop tasks and identify one by id + title + cwd;
2. read its current tail;
3. send a harmless message to the exact id;
4. read back the same thread and observe that message;
5. wait for its next assistant update;
6. verify the task can use its existing `control-chrome` browser state.

The direct `codex queue` experiment has already proven step 3 outside CoS. The full slice closes the
loop only when the read/list identity path is equally explicit.

## Questions for review

1. Is a Codex Desktop bridge within this project's scope, or should it remain an external plugin?
2. Is wrapping the shipped exact-thread CLI/app-server surface acceptable, or does the maintainer
   prefer CoS to target a lower-level first-party contract once its read/list guarantees are clear?
3. Does the one-schema/two-permission contract fit the current Core surface?
4. Should the first slice stop at existing-thread `list/read/send`, leaving `wait`/`create` for
   follow-ups if their supported contracts are less mature?
