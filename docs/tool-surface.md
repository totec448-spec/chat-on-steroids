# Model-facing tool surface

This is the current public reference for the tool surface. The implementation and tests are
authoritative; `src/main/mcp/surfaces.ts`, `src/main/mcp/tools-core.ts`,
`src/main/mcp/tools-desktop.ts` and `test/mcp.test.ts` should agree with this file.

## Connectors

Chat On Steroids publishes three connectors. They are separate discovery and permission boundaries
and use separate secret tokenized local paths. Each one also offers `exec`, a JavaScript runtime that
composes that connector's own tools.

| Connector | Purpose | Possible tools |
| --- | --- | --- |
| **Chat On Steroids Core** | Approved files, patches, terminal, generated images, task plans, workers | `read`, `view_image`, `find`, `apply_patch`, `save_image`, `exec_command`, `write_stdin`, `update_plan`, `agents`, `session_finish`, `exec` |
| **Chat On Steroids Desktop** | Browser tabs through the companion (all platforms); screen, windows, mouse/keyboard and clipboard (Windows/macOS) | `browser_tabs`, `browser_snapshot`, `browser_screenshot`, `browser_navigate`, `browser_action`, `browser_evaluate`, `browser_console`, `browser_network`; Windows: `list_windows`, `get_window`, `list_apps`, `get_window_state`, `launch_app`, `click`, `press_key`, `type_text`, `scroll`, `set_value`, `drag`, `perform_secondary_action`, `activate_window`, `read_clipboard`, `write_clipboard`; macOS: `observe`, `computer`; `exec` |
| **Chat On Steroids Plugins** | External MCP tools the user enabled in Settings | Each enabled tool under its own schema, plus `exec` |

Core is the main connector everywhere; Desktop and Plugins are optional.

On a fresh current config, Core permissions are enabled, along with
session recording and multi-agent mode; read-only mode is off. Windows also enables Desktop permissions; macOS starts them off and the user switches them on. Linux masks
Desktop permissions off at runtime while preserving stored choices for a config later reopened on
Windows or macOS. Existing configs keep explicit choices during upgrades; missing legacy permissions are
not silently widened.

With fresh defaults, Core advertises `read`, `view_image`, `apply_patch`, `save_image`,
`exec_command`, `write_stdin`, `update_plan`, `agents` and `exec`. `session_finish` appears while
Session finish is on.
`find` is the search fallback for a snapshot where search is enabled and command execution is
unavailable; `find` and the `exec_command`/`write_stdin` pair are never exposed together. Tool exposure is monotonic within a running connector instance, so a permission
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

### `save_image`

Saves the original file of an image ChatGPT generated in the calling chat into a new file in an
approved folder. It never replaces an existing file, and the chat must be open in the browser with
the image on its page. `nth` counts back from the newest generated image.

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

Settings can optionally enforce one application-wide command policy. It is disabled by default;
while disabled, command behavior is unchanged and the saved mode and rules remain available.
Allowlist mode permits only `cmd` items matching an exact argv rule such as `git status`, or a
rule ending in a standalone `*`, such as `git diff *`, which also permits `git diff` with no extra
arguments. Denylist mode rejects matching items and permits non-matches. An enabled empty
Allowlist rejects every launch; an enabled empty Denylist permits ordinary supported invocations.
In both modes, compound commands, substitutions, redirections, globs and other ambiguous shell
syntax are rejected with `COMMAND_NOT_ALLOWED` before patch interception or process launch.
Rules are case-sensitive and do not collapse executable paths to basenames.

This is a launch policy, not an OS sandbox. A permitted program remains trusted after it starts,
including its child processes, project/build code, shell environment and interactive input.
`write_stdin` behavior and process ownership checks are unchanged. The human-operated workspace
terminal is outside this policy.

### `write_stdin`

Writes to or polls a live command session by `session_id`, with optional yield time and output
budget. A blank `chars` value is a poll rather than a separate process-status tool. An empty
poll returns as soon as the process produces output rather than holding the full yield window;
anything that arrives afterwards stays buffered for the next poll. A non-empty write keeps
Codex's collection-window behaviour so one interactive response is gathered whole.

### `update_plan`

Always available (recording is always on). Replaces the exact caller’s displayed progress plan; it does
not execute queued work. Local history continues recording messages and real tool results for the
app transcript and continuation. There is no model-facing recording search/read tool.

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
  optional `reasoning_effort`: pro, none, minimal, low, medium, high, xhigh, max or ultra,
  forwarded on the open URL independently of `model` — a level never selects or changes the
  model, and omitting either inherits the default set in app settings, or the account default
  when no setting is chosen. The vocabulary is the one in `shared/session.ts`; `pro` is the
  ChatGPT browser Power tier and is listed here because a worker is a real browser chat.
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
If that in-flight turn merely goes silent after bounded recovery, silence is not promoted into a
terminal verdict. The worker may park with its slot free while retaining unresolved-turn state and,
when the recorder knows it, the exact response identity; that state forbids new `message` wake/new
work and is not eligible for tab reuse/closure. Only proven activity from a retained exact response
may resume it. An explicit finish proven to belong to that response, a current canonical final, or
a user terminal action still ends the ceiling worker normally.
Workers never run Compact & Resume, automatically or manually: their conversation is their durable
agent identity, so the 400,000-token boundary changes only later revive eligibility and never opens
a replacement worker chat.

There is no model-supplied agent credential or `agent_key`. Worker/prime identity is bound to
the ChatGPT conversation using extension evidence; control calls fail closed when that identity
cannot be proven.

### `exec`

Runs a short JavaScript program that calls this connector's own tools by name, in parallel where
they cannot conflict, and emits only what it passes to `text(...)` or `image(...)`. It has no Node,
filesystem, network or imports, keeps no state between calls and is bounded (64k source characters,
32 calls, 40k emitted text bytes, 4 images). `session_finish` and `agents action=finish` must be
called directly. Each connector has its own `exec`, limited to its own tools.

## Desktop tools

### Browser tools (all platforms)

`browser_tabs` lists and opens tabs in the user's existing Chrome, Edge or Brave through the
companion extension and attaches or releases them. `browser_snapshot` reads a tab's DOM without
attaching, including protected ChatGPT tabs. An attached tab also accepts `browser_screenshot`,
`browser_navigate`, `browser_action` (click, hover, fill, type, select, key, scroll, drag and
dialogs), `browser_evaluate`, `browser_console` and `browser_network`. Input works in the
background without moving the OS cursor or bringing the browser to the front.

### Native desktop tools (Windows and macOS)

Linux does not advertise or execute these schemas. Windows publishes one tool per operation:
`list_windows`, `get_window`, `list_apps` and `get_window_state` read, and `launch_app`, `click`,
`press_key`, `type_text`, `scroll`, `set_value`, `drag`, `perform_secondary_action` and
`activate_window` act; `read_clipboard` and `write_clipboard` follow the clipboard permissions.
macOS publishes `observe` and `computer`, described below.

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
- Core, Desktop and Plugins do not forward or alias each other's tools; each `exec` reaches only its own connector's tools.
- A connector token for one surface does not authorize the other surface.
- Read-only mode removes effective file-write, command, control and clipboard-write permissions
  without pretending the underlying configuration was changed.
- Approved filesystem roots do not sandbox command execution or desktop control.
- CoS's own windows are never listed, inspected, focused or targeted by window id, on Windows or
  macOS. This is not a sandbox: desktop-level coordinates still reach whatever is on screen.
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
