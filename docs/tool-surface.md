# Model-facing tool surface

This is the current public reference for the tool surface. The implementation and tests are
authoritative; `src/main/mcp/surfaces.ts`, `src/main/mcp/tools-core.ts`,
`src/main/mcp/tools-desktop.ts` and `test/mcp.test.ts` should agree with this file.

## Connectors

Chat On Steroids publishes Core on Windows, macOS and Linux. Windows and macOS additionally publish
the optional Desktop connector. They are separate discovery and permission boundaries and use
separate secret tokenized local paths.

| Connector | Purpose | Possible tools |
| --- | --- | --- |
| **Chat On Steroids Core** | Approved files, patches, terminal, recorded-session lookup, workers | `read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `session`, `agents` |
| **Chat On Steroids Desktop** | **Windows/macOS:** screen, windows, mouse/keyboard and clipboard | `observe`, `computer` |

The Desktop connector is optional on Windows/macOS. Core is the main connector everywhere.

On a fresh current config, all Core tool permissions, session recording and multi-agent mode are
enabled, while read-only mode is off. Windows also enables Desktop permissions; macOS starts them off and the user switches them on. Linux masks
Desktop permissions off at runtime while preserving stored choices for a config later reopened on
Windows or macOS. Existing configs keep explicit choices during upgrades; missing legacy permissions are
not silently widened.

With the fresh all-on capability snapshot, Core advertises seven schemas:
`read`, `view_image`, `apply_patch`, `exec_command`, `write_stdin`, `session`, and `agents`.
`find` is the search fallback for a snapshot where search is enabled and command execution is
unavailable. Tool exposure is monotonic within a running connector instance, so a permission
changed mid-conversation can leave a previously exposed name listed; its handler still enforces
the current permission.

## Core tools

### `read`

Reads approved paths. It accepts one or more paths, lists a directory one level deep, expands
bounded globs, supports line ranges, and can return supported image content. Path resolution
and result-size limits are enforced by the app: the per-file default payload is 256 KB, which
covers an ordinary source file whole, and the aggregate payload for one call stays bounded at
512 KB. The defaults are set so that batching paths into one call and reading a file whole are
the cheap path, because the round trip costs far more than the bytes.

### `view_image`

The dedicated Codex-compatible image tool. It is a real Core tool, separate from `read`, and
is gated by the read capability. Image transport and decode checks remain bounded.

### `find`

Search fallback used when search is enabled and command execution was unavailable when the
surface snapshot was built. It covers filename/glob and text search without granting a shell.

### `apply_patch`

The text mutation primitive. It uses the V4A patch envelope and preflights a multi-file patch
before writing. Create, edit, move and delete-file permissions are checked independently.
Directory deletion and arbitrary binary writes are deliberately not hidden patch operations.

### `exec_command`

Runs a command in the host's real shell: PowerShell/cmd on Windows and the user's normal POSIX
shell on macOS/Linux. This permission is **not** confined to approved folders. Long-running
commands return an opaque `session_id` that `write_stdin` can continue.

It takes exactly one of `cmd` (a single command) or `cmds` (up to 20 commands run sequentially
in one shell session). A batch shares one process, so variables, environment changes and the
working directory carry across its items; each item gets a labeled output section and its own
exit code, an ordinary non-zero result does not stop the rest, and the call's exit code is the
first non-zero one. Batching exists to spend one connector round trip instead of several on
related checks. The `apply_patch` interception and the benign-non-zero-exit classification
apply to single-command calls only.

### `write_stdin`

Writes to or polls a live command session by `session_id`, with optional yield time and output
budget. A blank `chars` value is a poll rather than a separate process-status tool. An empty
poll returns as soon as the process produces output rather than holding the full yield window;
anything that arrives afterwards stays buffered for the next poll. A non-empty write keeps
Codex's collection-window behaviour so one interactive response is gathered whole.

### `session`

Available while session recording is enabled. It has exactly two actions:

- `search` lists the 30 newest recordings when `query` is omitted, or searches titles, exact
  authored messages, errors, agent messages and recorded tool arguments/results across sessions.
  Its ordinary response is bounded to roughly 3,000 estimated tokens and continues by cursor.
- `read` requires an explicit `session_id`. It returns exact user/assistant text, compact tool
  headlines with short session-local `T…` references, and selected errors/agent messages. Read
  pages and expanded tool calls are bounded to roughly 5,000 estimated tokens and continue
  losslessly by cursor; authored messages are never summarized or ellipsized.

`read` also returns an `update_cursor`. Passing that cursor later returns only activity recorded
after the reader's checkpoint. An unfinished assistant message that only grew returns its exact
new suffix; a real rewrite is labeled as a replacement. Session lookup never guesses the calling
chat and never waits for browser identity evidence. Calls to `session` itself remain durably
auditable but are omitted from this projection so reading or polling a recording cannot recursively
copy its previous transcript result into the next one.

Compact & Resume is app/browser orchestration. There is no model-visible `save_handoff` or
`resume_session` tool.

### `agents`

Available while multi-agent mode is enabled. It has exactly four actions:

- `spawn` creates worker chats from one shared context plus per-worker tasks. Used once per run:
  a run that needs a worker again reuses one it already has. Each worker takes an optional
  `model` slug: the worker's chat opens with `?model=<slug>` in its fresh-chat URL, so a prime
  on a limited model can spawn workers on a cheaper one. Omitted means the account default;
  a slug ChatGPT does not recognise opens with the default too. The model is fixed for the
  life of that conversation, including across sleep/wake reuse. Each worker also takes an
  optional `reasoning_effort`: none, minimal, low, medium, high, xhigh, max or ultra, forwarded
  on the open URL independently of `model` — a level never selects or changes the model, and
  omitting both inherits the normal worker defaults.
- `message` sends one message or an all-or-nothing batch. Messaging a sleeping worker is what
  wakes it, in the chat it already has.
- `status` reports the run and workers, including who is asleep and how many worker slots are free.
- `finish` is a worker's handoff to the prime. It reports a result and puts that worker to sleep.

Workers sleep rather than end. A worker that has reported keeps its ChatGPT conversation and
stays reusable; its worker slot is free while it sleeps, so the limit counts only workers that
are actually working. Waking one needs a free slot, reopens or refocuses that worker's own chat,
and types the prime's message into it as an ordinary user message. A worker becomes permanently
finished only when its chat reaches the context ceiling (400,000 tokens by the app's own session
accounting); crossing it never interrupts work in flight, it only makes the next stop the last one.
Workers never run Compact & Resume, automatically or manually: their conversation is their durable
agent identity, so the 400,000-token boundary changes only later revive eligibility and never opens
a replacement worker chat.

There is no model-supplied agent credential or `agent_key`. Worker/prime identity is bound to
the ChatGPT conversation using extension evidence; control calls fail closed when that identity
cannot be proven.

## Desktop tools

This section exists on Windows and macOS. Linux does not advertise or execute these schemas.

### `observe`

Reads desktop state without moving focus: screenshots, windows and snapshot-scoped UI-control
information. Window capture tries a direct background path first and labels a visible-screen
fallback when the pixels may be occluded. Screen access is independent from mouse/keyboard
control.

### `computer`

Executes a bounded batch of desktop actions. The current action set is:
`click_ref`, `set_value`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`,
`focus`, `wait`, `read_clipboard`, and `write_clipboard`.

Recent screenshot frames are retained independently; a coordinate action names its frame and
the helper revalidates target-window geometry immediately before physical input. Semantic refs
address cached UI Automation or AXUIElement objects from one bounded snapshot and fail stale rather
than rescanning by a reusable native identity. Batches report completed-step and route evidence, including
the exact failing index on partial failure. An optional compact `verify` postcondition can wait
for a foreground window, window open/close, or UI control appearance/disappearance and capture
the resulting state in the same tool call.

Each step is checked against the current screen/control/clipboard permissions. Read-only mode
can keep observation available while disabling state-changing desktop actions.

## Permission and discovery invariants

- A tool call is checked against current permissions even if its schema was exposed earlier.
- Core and Desktop do not forward or alias each other's tools.
- A connector token for one surface does not authorize the other surface.
- Read-only mode removes effective file-write, command, control and clipboard-write permissions
  without pretending the underlying configuration was changed.
- Approved filesystem roots do not sandbox command execution or desktop control.
- Tool results and validation errors are bounded; large structured or binary payloads must not
  grow without an explicit cap.

## Compatibility notes

Older conversations can retain a cached MCP schema after an upgrade. Refresh/review the app in
ChatGPT, or recreate it if your workspace requires that, then start a new conversation when the
connector's exposed tool shape changes. The current extension pairs automatically with the local
bridge; there is no pairing code to enter.

## Tests that protect the surface

`test/mcp.test.ts` checks exact surface membership, cross-surface rejection, discovery-size
budgets, permission gating, retired names and schema shape. Native image parity has additional
coverage in `test/codex-view-image-parity.test.ts`.

When changing the public tool surface, update the implementation, the surface declarations,
the tests and this document together. Do not add a permanently exposed tool for a workflow
that can be expressed safely through the existing primitives.
