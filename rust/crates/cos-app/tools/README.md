# cos-app tools

## ui-driver

`ui-driver` drives a running cos-app from outside, through UI Automation. It replaces
`cos-verify ui` for the native app and is the verification tool for the UI units.

It reads the window the way the Desktop surface reads any window. `cos-windows-uia` lists the
elements and runs their patterns, and `cos-windows-capture` takes the screenshot through
Windows.Graphics.Capture. GPUI publishes its accessibility tree through AccessKit, so an element
has the role, the name (`aria_label`) and the AutomationId (`accessibility_id`) that the view
gives it. An element with a click handler exposes Invoke.

Build it, then run it against the pid of a cos-app:

```sh
cargo build --release -p cos-app --example ui-driver     # from rust/
rust/target/release/examples/ui-driver.exe --pid <pid> tree
```

| Command | What it does |
| --- | --- |
| `windows` | Lists the pid's top-level windows (handle, class, title, visible, rectangle) and whether one of them is in front. |
| `tree [--query <q>] [--role <r>]` | Lists the UIA elements of each visible window of the pid, with depth, role, name, AutomationId, bounds and actions. Each window lists at most 100 elements, and `truncated` says when more exist. Narrow the list with `--query` (a name or AutomationId substring) or `--role`. |
| `act <action> <id>` | Runs `invoke`, `toggle`, `select`, `expand`, `collapse`, `focus` or `scroll_into_view` on the element whose AutomationId is `<id>`, or else whose name is `<id>`. |
| `set-value <id> <text>` | Sets the text of that element through ValuePattern. |
| `wait <id> [--name <text>] [--timeout <ms>]` | Waits until that element exists, and until its name contains `<text>` when `--name` is given. The default timeout is 5000 ms. |
| `shot <file.png> [--window <hwnd>]` | Captures the main window (`Zed::Window`), or `<hwnd>`, to a PNG. |
| `key f11\|tab\|enter\|escape` | Presses one key. |

Each command prints one JSON object. It exits 0 on success. On a refusal or a failure it prints
`{"ok":false,"error":{"code","message"}}` and exits 1.

The driver touches only windows that the given pid owns (standing order 16):

- Every window that it reads, acts on or captures must belong to `--pid`. The check runs again
  just before each UIA action, and again after each capture.
- It never sends a click. An element without Invoke, Toggle or SelectionItem is refused with
  `PHYSICAL_INPUT_REFUSED`.
- `key` presses a key only after it finds the pid's window in front. Otherwise it refuses with
  `NOT_FOREGROUND` and sends nothing.

## binding-proof.mjs

This script proves that the GPUI models follow the Core live, through the driver only. It runs
cos-app on a fresh profile under `.tmp/cos-app-binding`, with `CLF_BRIDGE_PORTS=0` and a dead
proxy. It records chats over the bridge with the extension's headers, picks a chat, appends to
it, and disconnects. After each step it checks the window against the control API, then saves a
tree dump and a screenshot.

```sh
node rust/crates/cos-app/tools/binding-proof.mjs [--exe <cos-app.exe>] [--driver <ui-driver.exe>]
```
