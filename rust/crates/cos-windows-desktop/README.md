# cos-windows-desktop

The Windows Desktop surface tools, in-process (unit D3.1). It ports
`src/main/computer/{index,windows-api,browser-chords}.ts` (the Windows half) and
`src/main/mcp/tools-desktop-windows.ts`. `cos-core` registers [`tools`] on the Desktop surface.

## What it serves

- The Window2 methods: `list_windows`, `get_window`, `list_apps` and `get_window_state` under
  "See the screen"; `launch_app`, `click`, `press_key`, `type_text`, `scroll`, `set_value`,
  `drag`, `perform_secondary_action` and `activate_window` under "Control mouse and keyboard".
- `read_clipboard` and `write_clipboard` under their own permissions.

Schemas and listing order come from the kernel's recorded declarations. A result is the value
as JSON text, then any PNG image blocks, with `structuredContent.value`. A known native failure
(`WINDOW_NOT_FOUND`, `STALE_FRAME`, `FOCUS_FAILED` and the others in `tools.rs`) is an
`isError` result with a recovery step and `structuredContent.error`, which holds the completed
count, failed index and routes.

## How it runs

- `thread.rs`: one thread per `Desktop` owns the COM apartment, the UIA snapshots and every
  Win32 call. Requests queue to it in order, so a blocking native call never holds an async
  worker and native effects keep their order. The thread starts on the first call.
- `native/`: the former sidecar's operations (`snapshot`, `capture`, `act`, `apps`, ...) and the
  clipboard, answering `{"ok": ...}` replies in the shape of the `cos-sidecar-runtime` envelope.
- `computer.rs`: typed observations, screen mapping, and one action with its partial-batch
  evidence. `api.rs`: each caller's latest observation, which authorizes its indexed and
  coordinate input. `tools.rs`: caller contexts, the browser tab chord refusal and result shapes.

`Desktop::new()` hides this process's own windows and has native effects.
`Desktop::observing_own_windows()` is for tests. It sees this process's windows and never sends
synthetic input, changes the foreground, launches an app or touches the clipboard, enforced
on the desktop thread before each such call.

## Tests

- `cargo test -p cos-windows-desktop` runs the unit tests and replays the 15 recorded
  `desktop` cases that refuse before reaching a window (`tests/golden.rs`).
- `cargo test -p cos-windows-desktop --test golden -- --ignored` opens the recorder's own
  target window and replays the four cases that observe it. `04-state-text` is a known
  difference. Native UIA names the WinForms Edit and TitleBar differently from the managed
  UIA client the TypeScript helper used, and gives no document text.
- `cargo test -p cos-windows-desktop --test live -- --ignored` drives a window the test creates:
  screenshot pixels, the UIA tree, UIA Invoke and Value, a refused coordinate click, and an
  unchanged foreground.
- `tests/bench.rs` times `list_windows` and a screenshot in-process, and against the old
  sidecar binary when `COS_OLD_SIDECAR` names one.
