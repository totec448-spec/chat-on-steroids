# Tools and connectors

Chat On Steroids exposes three MCP connectors. Each has its own tool list and secret endpoint. The tools ChatGPT sees depend on the current platform and enabled permissions. Refresh a connector in ChatGPT after changing its tool set.

| Connector | Use | Tools |
| --- | --- | --- |
| Core | Files, commands, task plans and workers | `read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `update_plan`, `agents`, `session_finish`, `exec` |
| Desktop | Browser tabs and, where supported, native desktop input | Browser tools on all extension hosts; Windows Window2 tools; macOS `observe` and `computer`; `exec` |
| Plugins | Enabled external MCP servers | Their upstream tools and, when available, `exec` |

Core is the main connector. Desktop and Plugins are optional. On Linux, Desktop can control supported browser tabs through the extension; native desktop actions are available on Windows and macOS.

## Core

- `read` and `view_image` read approved paths with size limits.
- `find` searches files when command execution is unavailable at discovery time.
- `apply_patch` edits approved files; create, edit, move and delete permissions are checked for each change.
- `exec_command` runs a real OS process with the user's account privileges. Approved folder roots do not confine shell commands. `write_stdin` continues or polls a running process.
- `update_plan` displays the caller's progress plan. It does not execute queued work.
- `agents` manages worker conversations when multi-agent mode is enabled.
- `session_finish` holds an eligible Astra turn near its finish boundary when that feature is enabled.
- `exec` composes calls to tools on the same connector with bounded JavaScript. It does not grant tools from another connector.

## Desktop

The browser tool family is `browser_tabs`, `browser_snapshot`, `browser_screenshot`, `browser_console`, `browser_network`, `browser_navigate`, `browser_action` and `browser_evaluate`. The extension handles browser observation and input; Desktop permissions are still checked when each call runs.

Windows exposes the Window2 observation and input methods plus clipboard operations under their separate permissions. macOS exposes `observe` and `computer`. Screen access, control and clipboard access are checked separately. Linux has the browser tool family but no native desktop actions.

## Plugins

Plugins publishes the exact enabled upstream tool names and schemas within catalog limits. An installed plugin can be unavailable because it is disabled, disconnected, unauthenticated or not ready in its host application. Local status does not refresh ChatGPT's cached connector list.

## Permissions and discovery

A schema can remain visible in an existing ChatGPT conversation after permission is revoked. Every invocation checks current permissions, so a revoked call returns an error. Read-only mode masks write and control capabilities without changing their saved settings. Core, Desktop and Plugins cannot dispatch one another's tool names. Missing caller identity is refused when it could attribute a call to the wrong conversation.

The current declarations live in `src/main/mcp/surfaces.ts` and the `tools-*.ts` registrars. `test/mcp.test.ts` checks surface membership, schema shape and permission gates. For setup steps, see [Setup](setup.md).
