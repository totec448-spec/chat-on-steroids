# Golden corpus

This folder holds what the TypeScript app (2.1.35, Windows x64) answers on its model-facing and
local interfaces: MCP `initialize`, `tools/list` and tool calls on each surface, the HTTP guards
of the MCP endpoint, and every `/v1` control API route. Each Rust Core unit (C1.x in the
rewrite map) records the Rust build with `--binary` and diffs the folders it owns against this
corpus. `diff.mjs` accepts any two folders, so `rust/golden/base/http` compared with the same
folder of a Rust recording checks only the MCP listener.

`scripts/golden/record.mjs` writes the corpus and `scripts/golden/diff.mjs` compares two of them.

## Record and compare

Run these commands from the repository root. They need `npm ci`, `npm run build` and
`npm run rg` (run `npm run rg` from PowerShell or cmd, because Git Bash's `tar` cannot unpack
the archive).

```sh
node scripts/golden/record.mjs                                  # TS app from out/, writes rust/golden/
node scripts/golden/record.mjs --out .tmp/golden-out/run2       # a second recording elsewhere
node scripts/golden/record.mjs --variants base,desktop --out <dir>   # a subset of variants
node scripts/golden/record.mjs --binary <exe> --out .tmp/golden-out/rust
node scripts/golden/diff.mjs rust/golden .tmp/golden-out/rust   # exit 0 same, 1 different, 2 inconclusive
node scripts/golden/diff.mjs rust/golden <dir> --strict-order   # also report object key order
node scripts/golden/diff.mjs --self-test                        # seeded controls for the comparer
```

`diff.mjs` compares JSON values, not bytes. It reports each file that exists in only one
corpus, and for each shared file the JSON path of every difference with both values. Key order
is ignored unless you pass `--strict-order`. Use `--strict-order` for `tools-list.json`, because
ChatGPT caches the schemas it has seen. A missing or empty corpus gives exit code 2, which
means inconclusive, not a match.

A run with `--variants` does not write `manifest.json`. `manifest.json` names the kind of app
(`electron` or `binary`), so it always differs between a TS and a Rust recording.

## What the app under test must provide

`app.mjs` launches each variant on a new profile under `.tmp/golden-scratch/` and stops it by
killing its process tree. The Electron app needs nothing more. An executable passed with
`--binary` must do the following:

1. Accept `--user-data-dir=<dir>` and keep every file it writes under that folder. Ignore the
   Chromium flags `--lang=en-US` and `--remote-debugging-port=0`, which the recorder also
   passes.
2. Read `<dir>/config.json` in the form `seedConfig()` in `record.mjs` writes.
3. Bind no fixed browser bridge port when `CLF_BRIDGE_PORTS=0` is set.
4. Write `<dir>/control-api/endpoint.json` with its own `pid` and the `port`, write
   `<dir>/control-api/token`, and answer `GET /v1/health` with that bearer token.
5. Write `{ "core": url, "desktop": url, "plugins": url }` to the file named by
   `COS_MCP_URLS_FILE` (always `<dir>/mcp-urls.json`). Set a surface's value to `null` when that
   surface publishes no URL, and set every value to `null` after a disconnect. The Electron app shows these URLs only to its renderer, so for Electron the
   recorder reads them over the DevTools protocol (`--remote-debugging-port=0`) instead.
6. Send outbound HTTP through `HTTP_PROXY`/`HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` is set.
7. Accept `--quit` for a graceful stop. A second launch with the same `--user-data-dir` and
   `--quit` asks the running process to shut down. That process drains its listeners, flushes
   its files, releases the profile and exits 0. The `--quit` launch itself exits 0. If nothing
   runs on that profile, a `--quit` launch exits 0 and starts nothing. The recorder still
   stops the app by killing its process tree. `--quit` is for benchmarks and for tests of the
   drain on shutdown. It applies only to an executable passed with `--binary`.

Ready means that the control API answers from the launched pid and that Core answers
`tools/list` with at least one tool.

## Safety

- Every launch is offline. `HTTP_PROXY` and `HTTPS_PROXY` point to a dead port (`127.0.0.1:9`),
  as `scripts/bench.mjs` does on `bench/baseline`. An online build older than the latest
  release downloads that release, and a normal quit then runs its installer over the real
  installation. `/v1/status` in the corpus shows `update.stage: "failed"` with
  `"fetch failed"`, which confirms that the app was offline.
- The recorder never quits the app normally. It kills the process tree by pid with
  `taskkill /T /F`, then kills any process from the tree that it saw earlier and that is still
  running. It never kills a process by image name.
- Desktop calls go only to a window that the recorder opens itself (a WinForms form titled
  `cos-golden-target` that never takes focus). The recorder finds that window by the owner pid
  of top-level windows and reads no other window's title. No call lists windows or apps, reads
  or writes the clipboard, launches an app, or sends input. The input tools are called only
  where the caller-identity guard refuses before any input runs, or with arguments that fail
  schema validation. `list_windows` and `list_apps` accept unknown keys, so even a "bad
  arguments" call would list the user's windows. Those two tools are therefore not called.
- Browser tools refuse with `BROWSER_IDENTITY_REQUIRED` before they reach a browser, because
  every variant keeps "Allow unattributed calls" off except `unattributed`, which has no
  Desktop permissions.

## Layout

```text
manifest.json                       app version, platform, variant list
<variant>/config.json               the seeded config.json
<variant>/mcp/<surface>/initialize.json
<variant>/mcp/<surface>/tools-list.json
<variant>/mcp/<surface>/unavailable.json      surface published no URL
<variant>/mcp/<surface>/calls/NN-<case>.json  tools/call, in execution order
<variant>/mcp/core/protocol/<case>.json       JSON-RPC and Streamable HTTP behavior
<variant>/http/mcp-guards/<case>.json         listener guards: path token, Host, Origin, size, RFC 9728
<variant>/api/<case>.json                     /v1 routes and refusals
<variant>/api/endpoint-files.json             control-api/endpoint.json and token as written
<variant>/api/sse/<case>.json                 event stream frames
<variant>/api/actions/<case>.json             action routes with actions allowed
```

Each case file has `request` and `response`. MCP responses have the HTTP `status`, the
`framing` (`sse`, `json` or `empty`), and the JSON-RPC `messages`. HTTP responses keep these
headers: `content-type`, `cache-control`, `allow`, `retry-after`, `connection`,
`mcp-session-id`, `www-authenticate` and `x-accel-buffering`. An event stream is stored as
frames, each with `comments`, `id`, `event` and parsed `data`. A call that changes files also
has `disk`, which holds the fixture files read back from disk after the call. Key order is the
order the server sent.

The fixture project is the same for every variant: `README.md`, `src/greeting.txt`,
`src/notes.md`, `src/data.bin` (bytes 0 to 255), `src/pixel.png` (1x1), `src/large.txt`
(12,000 lines, 609 KB) and an empty `git init`. The `two-roots` variant adds `/second` with
`other.txt`. Cases in a variant run in order, so a later case sees the files and sessions that
earlier cases left.

## Normalization

`scripts/golden/normalize.mjs` replaces every value that changes between launches or machines
before a file is written. Placeholders are in angle brackets.

| Value | Placeholder | Rule |
| --- | --- | --- |
| Fixture project, second root, profile, run folder, repository, temp folder, home folder | `<PROJECT>`, `<SECOND>`, `<PROFILE>`, `<RUN>`, `<REPO>`, `<TMP>`, `<HOME>` | Native, forward-slash and JSON-escaped spellings, case-insensitive, longest first |
| MCP path tokens, control API token | `<MCP_TOKEN:core>` (per surface), `<CONTROL_TOKEN>` | Exact value |
| MCP and control API ports | `<MCP_PORT>`, `<API_PORT>` | After `127.0.0.1:` or `localhost:`, after a JSON key that ends in `port` inside text, and under any key that ends in `port` |
| Other ports (browser bridge) | `<PORT>` | Any other number under a key that ends in `port` |
| App pid, recorder window handle and pid | `<PID>`, `<HWND>`, `<TARGET_PID>` | Under any key, and in text after a JSON key or after `pid`, `id` or `hwnd` |
| Other pids | `<PID>` | Numbers under `pid`, `processId`, `process_id` |
| ISO-8601 times, HTTP dates | `<ISO_TIME>`, `<HTTP_DATE>` | Anywhere in text |
| Epoch milliseconds | `<EPOCH_MS>` | Numbers from 1e12 to 1e13 under keys that end in `At`, `_at`, `Time`, `time` or `timestamp`, or are named `at`, `since`, `ts`, `mtime`, `ctime`, `modified` or `created` |
| Durations | `<DURATION>`, `<N>ms` | Keys `wall_time_seconds`, `uptimeSeconds`, `durationMs`, `elapsedMs`, `ms` and similar; text `Wall time: N`, `elapsed_ms: N` and `Nms`; any duration in a timeline `metric` (`✓ 395ms`, `✓ 1.4s`), whose unit changes with its size |
| Exec chunk ids | `<CHUNK_ID>` | Key `chunk_id`; text `Chunk ID: x` |
| Exec session ids | `<EXEC_SESSION:n>` | Keys `session_id` and `completed_session_id`; text `session N`, `session ID N` and the same keys inside JSON text. Numbered by first appearance across the variant |
| Recorder session ids (`2026-10-20-1a2b3c4d`) | `<SESSION:n>` | Numbered by first appearance across the variant |
| UUIDs | `<UUID:n>` | Numbered by first appearance within the file |
| Counts of recorded text that embeds the ids above | `<CHARS>`, `<ESTIMATEDTOKENS>`, `<CONTEXTTOKENS>` | Keys `chars`, `estimatedTokens`, `contextTokens` |
| Pseudo-terminal window title | `<CONSOLE_TITLE>` | The OSC 0 sequence a PTY shell writes, which names the shell and whether it is elevated |
| Base64 image data | `<BASE64 sha256:...>` | A `data` string longer than 256 base64 characters. A window screenshot becomes `<IMAGE_DATA>`, because pixels vary with rendering |
| Activity log ring length | `<RING_SIZE>` | Key `ringSize`, a number in each `/v1/log` body |
| Activity log entries | `bodyShape` | `/v1/log` stores the type of each field, not the values, because the log ring holds runtime noise |

## Variants

| Variant | Config | Phases |
| --- | --- | --- |
| `base` | Files and commands on, Desktop off, read-write, multi-agent off, one root, actions off | All three surfaces, protocol, Core call matrix, MCP guards, every `/v1` route, SSE, rate limit |
| `no-command` | `command` off | Core list, `find` |
| `no-files` | Every file capability off | Core list, file tools absent, commands |
| `no-capabilities` | Every capability off | All surfaces, Core call refusals |
| `read-only` | `readOnly: true` | Core list, mutating tools absent |
| `multi-agent` | `multiAgent.enabled: true` | Core list with `agents`, `agents` refusals |
| `two-roots` | Roots `/project` and `/second` | Core list (descriptions name both roots), cross-root reads and patches |
| `unattributed` | `allowUnattributedCalls: true`, `x-request-id` on each call | `update_plan` and code mode (`exec`) success paths |
| `finish-tool` | `ui.finishTool: true` | Core list with `session_finish`, its calls |
| `desktop` | `screen`, `control`, both clipboard permissions | All surfaces, Desktop calls against the recorder window |
| `desktop-screen` | `screen` only | Desktop read tools only |
| `actions` | `controlApi.allowActions: true` | Action route refusals, action rate limit |

## Coverage

Each tool in section 2.1 and each route in section 2.2 of the rewrite map, and what the corpus
holds for it.

| Contract | Captured | Not captured, and why |
| --- | --- | --- |
| `read` | Files, folders, roots, globs, ranges, byte caps, binary metadata, images, native paths, every refusal and schema error | |
| `view_image` | Success, non-image, missing, outside, schema error | |
| `find` | Content and name search, no match, refusals (`no-command`) | |
| `apply_patch` | Add, update, move, delete, multi-file, a 20,000-line add, context mismatch, add over an existing file, missing targets, outside and traversal paths, malformed patches, heredoc wrapper, with the files read back from disk | |
| `save_image` | Refusal for a call with no chat, schema error | Success needs a ChatGPT chat open in the browser with a generated image |
| `exec_command` | Exit codes, stderr, `cmds`, `cmd.exe`, PTY, working folder rules, large output truncation, short yield, schema errors | |
| `write_stdin` | Write to a PTY session, replay of a completed session, write to a completed session, unknown session, closed pipe stdin | |
| `update_plan` | Set and clear (`unattributed`), identity refusal (`base`), schema errors | |
| `agents` | Schema, `status`, `spawn`, `message` and `finish` refusals, schema errors | A spawn that succeeds opens ChatGPT workers in a browser |
| `session_finish` | Schema and calls (`finish-tool`) | A held finish needs a chat with browser proof |
| `exec` (code mode) | Text, no output, nested tool calls, parallel calls, unknown tool, throw, syntax error, image emission, oversized emission, sandbox globals (`unattributed`); identity refusal on Core and Desktop | |
| `browser_*` (8 tools) | Schemas, identity refusals, schema errors | Success needs the browser extension paired with the bridge, which `CLF_BRIDGE_PORTS=0` prevents |
| `get_window`, `get_window_state` | Success on the recorder window (text, query, screenshot), window not found, schema errors | |
| `click`, `scroll`, `set_value`, `drag`, `perform_secondary_action` | Schemas, caller-identity refusal (no input ran) | Success sends real input |
| `press_key`, `type_text`, `activate_window`, `launch_app` | Schemas, schema errors | These run without caller identity, so any valid call would send input, take focus or launch an app |
| `list_windows`, `list_apps` | Schemas | Any call returns the user's windows or installed apps |
| `read_clipboard`, `write_clipboard` | Schemas, schema errors | Success reads or replaces the user's clipboard |
| `observe`, `computer` | | macOS only |
| Plugins surface | `initialize`, empty `tools/list` | Its tools come from installed plugins; none is installed |
| Exposure rule (`TOOL_DISABLED` after a permission is revoked) | | Needs a live permission change without a restart. The Electron app does that through its renderer, which a `--binary` app does not have |
| MCP transport guards | Path token, wrong surface token, trailing slash, query string, Host, Origin (foreign, loopback, `null`), 8 MiB body by length and chunked, RFC 9728 metadata (Core, Desktop, bare, wrong token, bad Host, foreign Origin), `invalid_json` | `headersTimeout` (30 s) and the drain on shutdown |
| MCP protocol | `initialize` for seven protocol versions, `ping`, unknown methods, `resources/list`, `prompts/list`, `tools/call` errors, GET and DELETE (405), missing Accept (406), wrong Content-Type (415), empty body, batch, notification only (202), bad `mcp-protocol-version`, `tools/list` without `initialize` | |
| `GET /v1/health`, `/v1/status` | Yes | |
| `GET /v1/sessions`, `/v1/sessions/{id}` | List, `limit`, `cursor`, `live=1`, not found, bad id, unknown and repeated parameters | A second page needs more than 50 sessions |
| `GET /v1/sessions/{id}/events` | `from`, `before`, `after`, `limit`, `kinds`, conflicting cursors, not found | |
| `GET /v1/sessions/{id}/events/stream` | Frames from the start, `Last-Event-ID`, `from`, `kinds`, bad `Last-Event-ID`, not found | Heartbeats (every 15 s) and the 30-minute end |
| `GET /v1/inputs`, `/v1/agents`, `/v1/log` | Empty lists, filters, bad parameters; `/v1/log` as a shape | Non-empty inputs and agents need a browser |
| `POST /v1/inputs`, `POST /v1/inputs/{id}/cancel` | `actions_disabled` with actions off; with actions on: `session_not_found`, `no_chat`, `project_not_found`, `invalid_body`, `invalid_json`, `unsupported_media_type`, `invalid_query`, `body_too_large`, `invalid_framing`, `input_not_found` | A successful send queues a message for a browser to deliver |
| Control API auth and guards | No token, wrong token, Basic auth, any Origin, bad Host, localhost Host, `invalid_target`, `method_not_allowed` with `allow`, `body_not_allowed`, 600 requests a minute, 30 actions a minute | The read deadline (504 after 15 s) and `busy` (503) need a stalled app |
| `endpoint.json` and `token` | Contents and format | |

## Contracts that are easy to miss

These facts come from the recorded files. A Rust server must match them.

- The server returns the requested protocol version when it supports it: `2025-11-25`,
  `2025-06-18`, `2025-03-26`, `2024-11-05` and `2024-10-07`. For `2026-07-28` and for an
  unknown version, it returns `2025-11-25`. ChatGPT's own choice is still not recorded here.
- Every MCP answer, `initialize` included, is an SSE stream with one `event: message` frame.
  No `mcp-session-id` header is sent. The server keeps no MCP session, so `tools/list` works
  without `initialize`.
- The listener's own refusals have `{"error": "..."}` bodies (`not_found`,
  `payload_too_large`, `invalid_json`). Host and Origin refusals come from the MCP SDK as
  JSON-RPC errors with status 403 and `id: null`. An `Origin: null` header is refused. A
  trailing slash after the path token is `not_found`, and a query string is accepted.
- An unknown tool and a tool that is not listed are JSON-RPC errors (`-32602`). A schema
  violation is a tool result with `isError: true` and text that starts with
  `Input validation error:`.
- Tool lists follow the capabilities at launch. Read-only removes `apply_patch`,
  `exec_command`, `write_stdin` and `save_image`, and adds `find`. With every capability off,
  Core still lists `update_plan` and `exec`. Desktop publishes a URL with an empty tool list
  when its permissions are off.
- Descriptions and instructions change with the config: root names, byte limits, the host
  platform and the profile's skills folder (`<PROFILE>\skills`) appear in them.
- With "Allow unattributed calls" off, `update_plan`, code mode, browser tools, coordinate
  input and `agents` refuse a call that has no chat identity, and `read`, `apply_patch` and
  `exec_command` run and file the call as Unattributed.
- `exec_command` without `tty` closes stdin. `write_stdin` then fails with
  `stdin is closed for this session`.

## Determinism

Two recordings of the same build must give an empty diff. On 2026-10-20, four more recordings
of 2.1.35 on Windows 11 each gave `no differences` against this corpus with `--strict-order`.
Check it again after you change the recorder or the normalizer:

```sh
node scripts/golden/record.mjs --out .tmp/golden-out/a
node scripts/golden/record.mjs --out .tmp/golden-out/b
node scripts/golden/diff.mjs .tmp/golden-out/a .tmp/golden-out/b
```
