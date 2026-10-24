# Rust Core architecture

This document fixes the shape of the Rust Core of Chat On Steroids: its crates, its core types
and signatures, who owns which state, how errors reach the wire, and how the Core starts and
stops. It exists so that units C1.1 to C1.10 (rewrite map, section 6, Track 1) can be built in
parallel. Each unit owns a disjoint set of files and implements an interface that is already
written and compiles. A unit replaces `todo!("C1.x: ...")` bodies in its own crate and adds
private modules there. It does not change another unit's files or a signature listed here
without the coordinator.

The skeleton is on branch `rust/core-skeleton`. `cos-headless` builds and starts. It parses
`--user-data-dir`, takes the profile lock, forwards a second launch, and on `--quit` or Ctrl-C
runs the bounded shutdown sequence and exits 0. Every owner that is not built yet panics inside
its own task with the name of its unit. The Core logs the panic and keeps running.

## Problem

The TypeScript app is one Electron main process. It starts with a long serial await chain:
every durable ledger is read before the window opens, and Core MCP readiness waits for the pet
overlay window (rewrite map, section 5). It keeps state in module-level variables that many
modules mutate, and its UI reads that state through about 131 IPC channels and an `AppState`
push. The Electron baseline measures cold control API health at 330 ms and Core `tools/list` at
381 ms after spawn (packaged 2.1.35 on Windows 11, `scripts/bench.mjs`, n=15 cold starts,
medians, ranges 315 to 367 ms and 376 to 387 ms). Most of that time is main-process JS work.

The Rust Core must fix three things together:

- Keep every external contract byte for byte. The golden corpus in `rust/golden` is the oracle.
- Start fast. Listeners bind and answer discovery without waiting for ledger restore, and work
  that needs restored state waits behind one fence (rewrite map, risk 11).
- Give ten workers interfaces that do not collide. Most of the TypeScript coupling comes from
  shared mutable modules, so the Rust shape must make that sharing unrepresentable.

The GPUI app links the Core in-process. GPUI code stays in UI crates (standing order 15), so
the UI-facing handle must work without GPUI and on GPUI's executor.

## Usage (caller's view)

The headless binary and the GPUI app start the Core the same way. The binary owns the process
boundary: argv, the profile lock and the exit code.

```rust
let argv: Vec<String> = std::env::args().collect();
let args = LaunchArgs::parse(&argv);
let paths = AppPaths::resolve(&args)?;
let Acquired::Primary(instance) = Instance::acquire(paths.user_data(), &argv)? else {
    return Ok(()); // the running instance received this command line
};
let mut core = Core::start(Launch { args, paths }, instance)?;
let launches = core.take_launches();   // later launches on this profile
core.block_on(wait_for_stop(launches)); // headless only; GPUI runs its own loop instead
let report = core.shutdown();          // bounded phases, then log flush, then the lock
```

A UI holds an `AppCore`. It watches snapshots and runs work on the Core runtime. Both work on
any executor.

```rust
let app = core.app();
let mut sessions = app.watches().sessions;      // watch::Receiver<Arc<SessionIndex>>
cx.spawn(async move {
    while sessions.changed().await.is_ok() {
        let index = sessions.borrow_and_update().clone();
        // update the sidebar entity from `index`
    }
});
let saved = app.spawn(|d| async move { d.settings.save(form_request).await }).await;
```

A tool crate implements `Tool` and nothing else.

```rust
impl Tool for ViewImage {
    type Args = ViewImageArgs;
    const SPEC: &'static ToolSpec = &ToolSpec {
        name: "view_image",
        listing: Listing::Capability(Capability::Read),
        requires: Requirement::Capability(Capability::Read),
    };
    async fn call(&self, cx: &CallContext, args: ViewImageArgs) -> Result<ToolOutput, ToolError> {
        let file = cos_fs::resolve(&cx.grants.roots, &args.path, Access::Read)?; // SandboxError -> ToolError
        // ...
    }
}
```

The transport hands calls to the kernel and never sees a tool.

```rust
let _request = kernel.begin_request(surface);                 // in-flight count, request clock
let reply = kernel.call(surface, &name, arguments, inbound).await; // Result<ToolResult, UnknownTool>
```

## Decisions

### 1. Crates and their dependency graph

There is one crate per unit, plus a shared listener, a composition root and the binary. The
graph has five layers, and an edge only ever points down:

```text
binary         cos-headless
composition    cos-core
owners         cos-connection   cos-control-api   cos-mcp   cos-sessions   cos-bridge
               cos-recorder   cos-input   cos-companion (Track 2 domains)
tools          cos-files   cos-patch   cos-exec   cos-codemode   cos-windows-desktop (Windows)
foundation     cos-tools   cos-http   cos-fs   cos-secrets   cos-store   cos-types
               cos-windows-uia   cos-windows-capture   cos-sidecar-runtime (Windows platform)
```

These are the exact workspace edges (normal dependencies, from `cargo metadata`). Inside a
layer, only `cos-connection`, `cos-control-api`, `cos-bridge` and the Track 2 domains may
depend on another owner: `cos-connection` on `cos-mcp`; `cos-control-api` on `cos-sessions` and
`cos-input`; `cos-recorder` and `cos-input` on `cos-sessions`; `cos-bridge` on the three Track 2
domains, whose route families it serves. In the foundation a crate depends only on a crate to
its right. A new edge needs the coordinator. `cargo` enforces the rest, because a crate cannot
import a crate it does not list.

| Crate | Depends on (workspace) | Third-party |
| --- | --- | --- |
| `cos-headless` | `cos-core`, `cos-store` | tokio |
| `cos-core` | `cos-bridge`, `cos-companion`, `cos-input`, `cos-recorder`, `cos-connection`, `cos-control-api`, `cos-mcp`, `cos-sessions`, `cos-files`, `cos-patch`, `cos-exec`, `cos-codemode`, `cos-tools`, `cos-fs`, `cos-secrets`, `cos-store`, `cos-types`; `cos-windows-desktop` on Windows | serde_json, tokio |
| `cos-connection` | `cos-http`, `cos-mcp`, `cos-tools`, `cos-secrets`, `cos-store`, `cos-types` | regex, serde_json, tokio |
| `cos-bridge` | `cos-companion`, `cos-input`, `cos-recorder`, `cos-http`, `cos-secrets`, `cos-store`, `cos-tools`, `cos-types` | base64, bytes, getrandom, http, http-body-util, hyper, hyper-util, serde, serde_json, sha1_smol, sha2, subtle, tokio |
| `cos-control-api` | `cos-http`, `cos-input`, `cos-sessions`, `cos-tools`, `cos-store`, `cos-types` | base64, bytes, getrandom, http, hyper, regex, serde, serde_json, tokio |
| `cos-mcp` | `cos-http`, `cos-tools`, `cos-store`, `cos-types` | base64, bytes, getrandom, http, http-body-util, hyper, serde_json, subtle, tokio |
| `cos-sessions` | `cos-tools`, `cos-store`, `cos-types` | base64, getrandom, regex, serde, serde_json, sha2, tokio |
| `cos-recorder` | `cos-sessions`, `cos-tools`, `cos-store`, `cos-types` | indexmap, serde, serde_json, tokio |
| `cos-input` | `cos-sessions`, `cos-tools`, `cos-store`, `cos-types` | base64, getrandom, serde, serde_json, tokio |
| `cos-companion` | `cos-secrets`, `cos-tools`, `cos-store`, `cos-types` | getrandom, serde, serde_json, tokio |
| `cos-files` | `cos-tools`, `cos-fs` | base64, grep-regex, grep-searcher, icu_collator, ignore, serde, serde_json, tokio |
| `cos-patch` | `cos-tools`, `cos-fs` | serde, serde_json, tokio |
| `cos-exec` | `cos-tools`, `cos-fs` | bytes, regex, serde, serde_json, tokio; windows on Windows |
| `cos-codemode` | `cos-tools`, `cos-fs` | base64, rquickjs, serde, serde_json, tokio; windows-sys on Windows, libc elsewhere |
| `cos-windows-desktop` | `cos-tools`, `cos-sidecar-runtime`; `cos-windows-uia` and `cos-windows-capture` on Windows | base64, serde, serde_json, tokio; windows on Windows |
| `cos-tools` | `cos-fs`, `cos-store`, `cos-types` | serde, serde_json, tokio |
| `cos-http` | none | bytes, http, http-body-util, hyper, hyper-util, tokio |
| `cos-fs` | `cos-types` | image, zune-core, zune-jpeg |
| `cos-secrets`, `cos-store` | `cos-types` | as on `rust/app` |

| Crate | Unit | Holds |
| --- | --- | --- |
| `cos-http` | skeleton (coordinator) | Loopback listener, HTTP/1.1 with header deadline, graceful and forced drain, body limit, lingering close after `connection: close` (2 s, 1 MiB) so late request bodies never reset the answer on Windows |
| `cos-mcp` | C1.1 | MCP endpoint: secret paths, guards, PRM, JSON-RPC and SSE framing, protocol versions |
| `cos-tools` | C1.2 | Tool contract, grants, exposure, kernel pipeline, declarations, instructions, counters, admission |
| `cos-fs` | C1.3 | Approved roots, virtual paths, sandbox resolution, file operations |
| `cos-files` | C1.4 | `read`, `view_image`, `find`, `save_image` |
| `cos-patch` | C1.5 | `apply_patch` |
| `cos-exec` | C1.6 | `exec_command`, `write_stdin`, process custody, the `Launcher` seam |
| `cos-codemode` | C1.7 | Code mode `exec` |
| `cos-windows-desktop` | D3.1 | The Windows Desktop surface tools, in-process on one UI Automation thread |
| `cos-sessions` | C1.8 | Session store, read model, tool-call recording, `update_plan` |
| `cos-control-api` | C1.9 | `/v1` routes, SSE, token and endpoint files, limits |
| `cos-connection` | C1.10 | Lifecycle actor, endpoint generations, tunnels, health, `ConnectionStatus` |
| `cos-bridge` | E2.1 | The browser bridge listener, pairing, wake socket, extension folder, route table |
| `cos-recorder` | E2.2 | Page observations into sessions, the request-id ownership ledger, live chats for `/status` |
| `cos-input` | E2.3 | The message outbox (`state/session-input.json`), new chats' reserved sessions, durable browser commands |
| `cos-companion` | E2.4 | Model catalog, usage limits, preference and diagnostics handshakes, Projects and plugin-refresh handshakes, `/settings`, the `/status` pass and its browser custody |
| `cos-core` | skeleton (coordinator) | Composition root, `Core`, `AppCore`, Settings owner, startup, shutdown |
| `cos-headless` | skeleton (coordinator) | The binary and its golden-recorder contract |

Rules that follow from the graph:

- Tool crates depend on `cos-tools` and `cos-fs` only. They never see HTTP, sessions or other
  tools. Capability comes from `cos_tools::Capability`. `cos-windows-desktop` also depends on
  the Windows platform crates it drives (`cos-windows-uia`, `cos-windows-capture`) and on
  `cos-sidecar-runtime` for their result shapes.
- `cos-tools` defines the ports the browser plane and the session store fill (`Attribution`,
  `CallRecorder`). It depends on no implementation of them.
- Only `cos-http`, `cos-mcp`, `cos-control-api` and `cos-bridge` depend on `hyper`. Their
  public APIs carry no `hyper` type, except `cos-http`, which exists to own that mechanism.
- `cos-core` holds no domain logic. It builds each owner once and wires snapshots between them.

Alternatives considered:

- One `cos-core` crate with a module per unit. It is simpler to start. But a module can reach
  any other module's `pub(crate)` internals, every unit edits the same `lib.rs` and
  `Cargo.toml`, and every change recompiles everything. That loses the compile-time boundary
  that makes parallel work safe.
- Crates by layer (transport, domain, adapters). Each unit would then span three crates, which
  is temporal decomposition, and two units would always share files.

### 2. Async runtime and HTTP stack

The Core uses Tokio 1.54.0 (multi-thread runtime, 2 to 4 workers, blocking pool for file work)
and hyper 1.12.0 with hyper-util 0.1.21 (`server-graceful`), http-body-util 0.1.5, http 1.5.0
and bytes 1.12.1. Every version is pinned with `=`, like the existing crates. MCP and the control
API are HTTP/1.1 only, as the TypeScript `node:http` servers are.

`cargo deny check licenses bans sources` passes on the whole workspace with these additions
(`bans ok, licenses ok, sources ok`). The stack adds 17 entries to `Cargo.lock`, all MIT or
MIT OR Apache-2.0. The only new duplicate warning is `syn` 2 from `tokio-macros` beside the
`syn` 3 already in the graph.

The GPUI dependency graph does not otherwise contain Tokio on Windows (`cargo tree` of the
recommended GPUI crate set), so the Core brings its own runtime. GPUI's executor never polls
Tokio IO directly. `AppCore`
hands it `watch` receivers and `CoreTask` handles, and both complete on any executor. The test
`core_work_and_snapshots_complete_on_a_foreign_executor` proves that with a bare executor that
has no Tokio context.

Alternatives considered:

- `axum` on hyper. Its extractor rejections write `text/plain` bodies and its routing hides
  exact status, header and body control. The corpus requires JSON-only error bodies and exact
  refusals for paths such as a trailing slash after the token. The routes are few, so routing
  by hand costs less than overriding axum.
- `rmcp` for the MCP server. The corpus pins envelope key order (`result`, `jsonrpc`, `id`),
  one SSE frame per answer, no session id, and version negotiation that answers `2025-11-25`
  for unknown versions. An SDK that owns serialization cannot be held to those bytes
  (rewrite map, risk 5). `rmcp` stays a candidate for the plugin client (G4.3).
- Blocking threads with `tiny_http`. Exec yields, SSE streams, drains with deadlines and
  cancellation would each need their own thread choreography.

### 3. Who owns which state

Each piece of mutable state has exactly one owner. Other code reads a snapshot or asks the
owner. When the writes are independent facts, they are kept separate rather than serialized.
A lock exists only where one shared writer is a real invariant.

| State | Owner | Writes | Reads | Mechanism |
| --- | --- | --- | --- | --- |
| `config.json` | `Settings` (cos-core) | `Settings::save`, through `ConfigStore`'s own queue | `watch::Receiver<Arc<Config>>` | One writer. `ConfigStore` is private to `Settings`. |
| Live permissions | none (derived) | none | `Grants::derive(&config, &env)` once per call | A pure function. Nothing is stored, so it cannot disagree with the config. |
| Exposure per surface | `Kernel` | `Exposure::observe` on each list and call | the same call | Atomic OR, a commutative join, so arrival order cannot matter. `find` is decided once by compare-and-swap. |
| Request and tool-call clocks, call counters | `Kernel` | atomics | `Kernel::counts`, `last_request_at`, `last_tool_call_at` | Independent facts, one atomic each |
| Connection state, endpoint generations, tunnels | `Connection` actor (C1.10) | `Command` over an mpsc queue | `watch::Receiver<Arc<ConnectionStatus>>` | A single-writer actor, because the lifecycle is a state machine with generations |
| Sessions | `SessionStore` (C1.8) | per-session serialization inside the store | `SessionIndex` watch, `Appended` broadcast, async reads | Partitioned by session id. There is no global queue. |
| Live processes | `ExecManager` (C1.6) | its own methods | its own methods | Owner-internal |
| `secrets.bin` | `SecretStore` behind one `Mutex` | C1.10 only in Track 1 | the same | `SecretStore` takes `&mut self` by design |
| Control API token and endpoint files | `ControlApi` (C1.9) | its run task | external callers | One owner that follows `controlApi.enabled` |
| Startup fence | cos-core | `AdmissionGate::advance`, forward only | `Admission` | `watch` |
| Activity log | `Logger` (cos-store) | `Logger` | `Logger::entries` plus a broadcast in `Watches` | Existing |
| Profile lock | the launch-forwarder thread | none | none | OS file lock, released last |

The UI never holds a lock and never sees a half-written state. It sees the previous snapshot or
the next one.

Alternatives considered:

- A central store and reducer: one `CoreState`, one actor, one `Command` enum, and one published
  snapshot, like the `AppState` push. Every unit would edit the same `Command` enum and reducer,
  which is the collision this design exists to avoid. A session append would also queue behind
  a connection transition, and every tool call would wait for the actor to read permissions.
- Shared state behind `Arc<RwLock<CoreState>>`. It is the TypeScript module state with locks
  added. Lock order would become a convention every unit must remember, and that is not
  concurrency control.

### 4. Tool kernel

The data shape:

- `ToolSpec { name, listing: Listing, requires: Requirement }` is static per tool.
  - `Listing` says when a tool appears: a capability, any of several, a feature,
    `FindInsteadOfCommand`, or `WithOtherTools` for code mode.
  - `Requirement` says what must be live for a call to run. The kernel checks it before the
    handler and words the `TOOL_DISABLED` or `FEATURE_DISABLED` text in one place
    (`Grants::require`). Read-only is named as the owner when it turned a capability off.
- `Grants` holds the live effective capabilities, `read_only`, features, `allow_unattributed`,
  roots and platform.
- `Exposed` holds what a surface has listed in this generation. It only widens.
- `Tool` has typed `Args`. The object-safe `DynTool` is implemented for every `Tool`, so the
  kernel stores `Arc<dyn DynTool>`. A tool returns `Result<ToolOutput, ToolError>` and never
  builds an `isError` result by hand. `ToolOutput` carries the result plus `CallNotes`
  (outcome override, file changes, detail) for the recorder.
- `SurfaceTools` is the set of tool objects per surface, assembled in
  `cos-core/src/surfaces.rs`. Listing order and listing rules belong to the kernel. The kernel
  lists in the TypeScript registration order, which the corpus records. On Core that order is
  `read, view_image, save_image, find, apply_patch, exec_command, write_stdin, update_plan,
  session_finish, agents, exec`. No variant lists both `session_finish` and `agents`, so their
  relative order is inferred from `tools-core.ts`.

The pipeline of `Kernel::call` is the contract for C1.2. It is listed here in order:

1. Derive `Grants` from the current config snapshot. If a feature went off since the last
   config the kernel saw, forget exposure first (`forgetExposedSurface`). Observe exposure.
2. If the tool is not listed on this surface, return `UnknownTool`. This is JSON-RPC `-32602`,
   `Tool <name> not found`.
3. Validate the arguments against the tool's declared schema. A failure becomes an `isError`
   result `Input validation error: Invalid arguments for tool <name>: ...` in zod's wording.
   It gets no identity notice.
4. Wait on `Admission` (restore fence).
5. Resolve the caller through `Attribution`. Track 1 uses `Unattributed`, and E2.2 replaces it.
6. Check `Requirement`, then run the handler with a `CallContext`.
7. Map `ToolError` to an `isError` result and an outcome. Log `tool <name> ok in N ms`,
   `rejected` or `failed`, and update the clocks and counters.
8. Append the identity notice when the caller is unattributed. The corpus has it on every call
   that reached a handler, refusals included.
9. Await `CallRecorder::record`, then answer.

Schema serving: the kernel serves each tool's whole `tools/list` element from a JSON template
recorded from the corpus, in its exact key order. Placeholders mark the values that change with
the config, such as the root list in `read.paths.description`, byte limits, platform and the
skills folder. C1.2 writes the extractor as a script (`scripts/golden/extract-declarations.mjs`)
and a test that renders every variant's config and compares the result with
`rust/golden/<variant>/mcp/<surface>/tools-list.json` byte for byte. `serde_json` is built with
`preserve_order` across the workspace, so `Value` keeps insertion order.

Alternatives for schema serving:

- Generating schemas from Rust types with `schemars`. zod's output has its own key order (for
  example `"type"` before `"$schema"`, and `"description"` before or after `"type"` per
  property) that no generator reproduces. ChatGPT caches the schemas it has seen, so a
  different byte sequence is a different tool to it.
- Hand-written JSON literals in each tool crate. They drift from the corpus silently. The
  template-plus-test design fails the build when they differ.

Alternatives for the tool shape:

- A closed `CoreTool` enum with one `match`. Every unit would edit the same enum and `match`,
  and the Desktop and Plugins surfaces are open sets.
- `rmcp`-style attribute macros. They generate schemas (rejected above) and hide listing order
  in registration order.

Request attribution: `RequestId::from_header` normalizes `x-request-id` once at ingress by
dropping the per-attempt suffix (`wfr_<id>/<suffix>` becomes `wfr_<id>`). The transport puts it
in `Inbound` together with the generation's frozen Setup profile id. Nothing downstream parses
the header again.

### 5. Errors

Each crate defines its own error enum. No crate uses `anyhow` or one global error type. A global
enum would make every unit edit one file, and it would erase the exact mapping each wire needs.
Errors cross a boundary only as a typed value the next layer maps.

| Where it starts | Type | Mapped by | What the client sees |
| --- | --- | --- | --- |
| A tool refuses (permission, sandbox, lifecycle) | `ToolError::Refused` | the tool, through `From` impls such as `From<SandboxError>` | `isError` result with that text. Outcome `tool_rejected`, logged at info. |
| A tool refuses and reports why as data | `ToolError::RefusedWithDetail` | the tool | The same as a refusal, with the detail as `structuredContent.error` (Desktop's native failures: code, recovery, completion evidence) |
| Chat identity is missing | `ToolError::Identity` | the tool | The same as a refusal, and it arms the identity-recovered notice |
| A tool breaks its own contract | `ToolError::Internal` | the tool, or `DynTool` when typed args fail to parse | `isError` result. Outcome `tool_internal_error`, logged as a warning. |
| An OS error | `ToolError::from_io` | the tool | `Not found`, `Access denied by the operating system` and the rest of `friendlyError`. Never a host path. |
| Schema violation | kernel internal | C1.2 | `isError` result `Input validation error: ...` |
| Tool not listed | `UnknownTool` | C1.1 | JSON-RPC error `-32602` |
| JSON-RPC and Streamable HTTP protocol | cos-mcp internal | C1.1 | The `protocol/*` cases: 405, 406, 415, 202, `-32601` and the others as recorded |
| Listener refusal | `cos_mcp::Refusal` | C1.1 | `{"error": "not_found"}` 404, `payload_too_large` 413, `invalid_json` 400, `server_stopping` 503 |
| Host or Origin | cos-mcp internal | C1.1 | 403 with `{"jsonrpc": "2.0", "error": {"code": -32000, "message": "Invalid Host: ..."}, "id": null}` |
| Control API refusal | a C1.9 enum of the recorded codes | C1.9 | `ControlApiError` body (`origin_forbidden`, `invalid_target`, `actions_disabled`, ...) |
| An owner fails to start | that owner's error | the owner | Logged, and visible in the owner's status. The Core keeps running. |
| The Core cannot start | `StartupError` | cos-core | `cos-headless` exits 1 |
| No profile or no lock | `io::Error` | cos-headless | exit 1 |

An owner that panics is contained the same way: each owner's long-running work is its own Tokio
task, and restore and every shutdown task are spawned separately. This relies on
`panic = "unwind"`, which is the default. No release profile may set `panic = "abort"`.

### 6. Startup and shutdown

Startup (`Core::start`). The only IO awaited on the path is reading `config.json`.

| Step | What | Blocks |
| --- | --- | --- |
| 0 | `LaunchArgs::parse`, `AppPaths::resolve` (binary) | the process; exit 1 on failure |
| 1 | `Instance::acquire`. A forwarded launch exits 0 before anything else touches the profile. | the process |
| 2 | `Logger` and the `app.log` mirror. Tokio runtime with 2 to 4 workers. | the next step |
| 3 | `Settings::load`: `config.json`, one small synchronous read, published as a snapshot | the next step |
| 4 | Admission starts in `Restoring`. Owners are constructed with no IO: sessions, exec, kernel. Exec pre-starts one PowerShell on a blocking thread when commands are enabled; nothing waits for it. | nothing |
| 5 | `Connection::spawn`. With `ui.autoConnect` the actor binds the MCP endpoint at once, before reading secrets or starting a tunnel, then writes status with the local URLs. | nothing |
| 6 | `ControlApi::spawn`. If enabled it binds and writes the token, then `endpoint.json`. | nothing |
| 7 | Restore task: every ledger owner restores concurrently in its own task, within a 10 s budget, then admission moves to `Serving` | tool calls and session reads only |
| 8 | Log broadcast and the launch-forwarder thread, which owns the lock from here on | nothing |

`initialize`, `tools/list` and `/v1/health` answer from step 5 and step 6. A tool call that
arrives during restore waits on the fence, so it never sees a half-restored ledger. The GPUI app
calls `Core::start` before `application().run()` and shows its window right after. Nothing in
the Core waits for a window, and nothing in the window waits for ledgers. That removes both
startup limiters the baseline found: the serial await chain and Core readiness waiting for the
pet overlay.

Timing targets. These are guesses until measured with `scripts/bench.mjs` against the release
binary. The skeleton logs `core started in 1 ms` (n=1, every owner stubbed, debug build).

| Metric | Electron baseline (cold, n=15, median) | Rust target |
| --- | --- | --- |
| Spawn to `/v1/health` 200 | 330 ms | 30 ms or less |
| Spawn to Core `tools/list` answered | 381 ms | 40 ms or less |
| `Core::start` return | n/a | 5 ms or less |
| Graceful shutdown with no work in flight | not measured | 100 ms or less |

Shutdown (`Core::shutdown`). The phases follow `src/main/shutdown.ts`. They run in order, a
phase's tasks are created only when it starts, tasks inside a phase run concurrently and settle
independently, and an overrun phase is abandoned so the sequence always ends.

| Phase | Budget | Tasks in Track 1 |
| --- | --- | --- |
| `Drain` | 40 s | Admission to `Draining`. `Connection::shutdown(30 s)` drains the endpoint with force after 30 s and stops tunnels. `ControlApi::shutdown` removes `endpoint.json`, then the token, then drains. |
| `Processes` | 15 s | `ExecManager::terminate_all` |
| `Recorder` | 10 s | `SessionStore::flush_recorder` |
| `Durable` | 10 s | `SessionStore::flush`. Later ledger owners add their flush here. |
| `UpdateHandoff` | 5 s | none until G4.4 |

After the last phase come the log flush (2 s), the runtime stop (1 s for blocking tasks) and
then the profile lock. The lock is released last, so a later launch never opens the profile
while this process still writes to it. The worst case is 83 s. `Core` is not `Clone`, so only
its one owner can shut it down. Ordinary disconnects use `Drain::Graceful`, so an accepted
mutation is never cut off just to finish quickly.

`cos-headless` adds a `--quit` switch. A second launch with `--quit` asks the running instance
to shut down gracefully. A `--quit` launch on a profile with nothing running starts nothing.
It lets the recorder and benchmarks stop the binary without killing it, and makes the drain on
shutdown observable, which the corpus could not capture for Electron.

### 7. How each unit proves itself

Every unit has two kinds of evidence.

- Unit tests in its own crate, through the crate's public interface. They test behavior, not
  internals.
- Golden diffs. Record the binary with
  `node scripts/golden/record.mjs --binary rust/target/release/cos-headless.exe --out .tmp/golden-out/<unit>`,
  then run `node scripts/golden/diff.mjs rust/golden/<variant>/<folder> .tmp/golden-out/<unit>/<variant>/<folder>`.
  Add `--strict-order` for every `tools-list.json`. Exit 0 is equal, 1 is different and 2 is
  inconclusive. A unit is done when every case it owns (the table below) is equal and no case
  that was equal before has changed.

The recorder's readiness check needs three things before it records anything: the control API
answering `/v1/health` from the launched pid, `mcp-urls.json`, and a Core `tools/list` with at
least one tool. That needs a working part of C1.1, C1.2, C1.9 and C1.10, called milestone R0
below. Until R0, a unit replays corpus cases in its own crate tests. It reads `request` from the
case file, calls its tool through `CallContext::standalone` or its service directly, and
compares with `response` after substituting the corpus placeholders (`<PROJECT>` and the rest
in `rust/golden/README.md`).

## Per-unit ownership

Paths are under `rust/` unless they start with `scripts/`. A unit owns every file under its
paths, including new ones. No two units own the same file.

| Unit | Owns | Implements (already declared) | Consumed by | Golden cases it must match |
| --- | --- | --- | --- | --- |
| C1.1 MCP transport | `crates/cos-mcp/**` | `McpEndpoint::start`, `port`, `urls`, `probe_headers`, `stop`; `Refusal`; `MAX_BODY_BYTES` | C1.10 | `*/http/mcp-guards/*`; `*/mcp/core/protocol/*`; envelope and framing of every `*/mcp/*` file |
| C1.2 kernel and surfaces | `crates/cos-tools/**` except `src/admission.rs`; `scripts/golden/extract-declarations.mjs` (new) | `Grants::derive`, `Grants::require`, `Exposure::observe`, `Exposure::reset`, `Kernel::{begin_generation, server_info, list, call, call_nested}`, `RequestId::from_header`, `ToolError::from_io` | every unit | `*/mcp/*/initialize.json`; `*/mcp/*/tools-list.json` (strict order); unknown-tool and schema-error cases (`call-unknown-tool`, `call-missing-name`, `*-wrong-type`, `*-extra-field`, `*-no-args`, `*-bad-type`); the identity notice on every call |
| C1.3 sandbox and paths | `crates/cos-fs/**` | `resolve`, `to_virtual`, `SandboxError` texts, file operations as new public items | C1.4, C1.5, C1.6 | Path refusals inside the C1.4 to C1.6 cases (traversal, outside, unknown root, relative, native, missing workdir), proven with C1.3 tests and then the owners' cases |
| C1.4 file tools | `crates/cos-files/**` | `Read`, `ViewImage`, `Find`, `SaveImage` bodies | cos-core | `base/mcp/core/calls/01` to `33`, `no-command` `find` cases, `two-roots` read cases, `read-only` reads |
| C1.5 apply_patch | `crates/cos-patch/**` | `ApplyPatch` body | cos-core | `base/mcp/core/calls/34` to `51` (with `disk`), `two-roots` patch cases |
| C1.6 unified exec | `crates/cos-exec/**` | `FreshProcess::launch`, `ExecManager::terminate_all`, `ExecCommand`, `WriteStdin` | cos-core | `base/mcp/core/calls/52` to `78`, `no-files` command cases |
| C1.7 code mode | `crates/cos-codemode/**` | `CodeMode` body | cos-core | `base/mcp/core/calls/84` to `94`, `unattributed` code-mode cases |
| C1.8 session store | `crates/cos-sessions/**` | `SessionStore::{restore, list, detail, events, flush_recorder, flush}`, `Cursor::parse`, the recorder, `UpdatePlan` | C1.9, cos-core, UI | `base/mcp/core/calls/79` to `83`, `unattributed` plan cases; session content in `*/api/session*.json` and `*/api/sse/*` |
| C1.9 control API | `crates/cos-control-api/**` | `run` and everything below it | cos-core | `*/api/*` except session content; `*/api/endpoint-files.json`; `actions/*` |
| E2.1 bridge transport | `crates/cos-bridge/**` except `src/families/<unit>.rs` of later units | `Bridge`, `Routes`, `Family`, `Wake`, `ExtensionFolder` (Track 2 section) | E2.2 to E2.8, cos-core, C1.9 | the `bridge` object of `*/api/status.json`; the unchanged extension pairs and wakes against `cos-headless` |
| C1.10 connection | `crates/cos-connection/**` | `run`, `initial_status` | C1.9, cos-headless, UI | the `connection` object of `*/api/status.json`; tunnel-client argv and env through a fake binary on `PATH` |
| E2.2 recorder | `crates/cos-recorder/**`; `crates/cos-bridge/src/families/recorder.rs` | `Recorder` (`events`, `correlate`, `closed`, `live_conversations`), the kernel's `Attribution` | cos-core, cos-bridge | the input and recorder differentials (`crates/cos-{recorder,input}/differential/`) |
| E2.3 input | `crates/cos-input/**`; `crates/cos-bridge/src/families/input.rs` | `Outbox`, `Commands` | cos-core, cos-bridge, C1.9 | `actions/api/actions/*` through `/v1`; the input differential |
| E2.4 companion | `crates/cos-companion/**`; `crates/cos-bridge/src/families/models.rs` | the companion owners, `status::answer`, `custody::Custody` | cos-core, cos-bridge | the companion differential |
| D3.1 Windows desktop | `crates/cos-windows-desktop/**` | `tools` (the Desktop surface tools for cos-core) | cos-core | `desktop/mcp/desktop/*` and `desktop-screen/mcp/desktop/*` |
| Skeleton (coordinator) | `crates/cos-core/**`, `crates/cos-headless/**`, `crates/cos-http/**`, `crates/cos-tools/src/admission.rs`, `docs/core-architecture.md` | Wiring only | everyone | `cos-headless` lifecycle tests |

Files that every unit touches and how to share them:

- Each skeleton crate already lists the stack dependencies its unit is expected to need
  (`tokio`, `hyper`, `serde_json`), so most units add no dependency and the lockfile stays
  stable while they work in parallel.
- `rust/Cargo.lock`: never merge it by hand. Every registry dependency is pinned with `=`, so
  after a conflict, take the integration branch's lockfile and run `cargo build`. Cargo then
  adds only the missing packages. Add a dependency with `cargo add -p <crate> <name>@=<version>`
  and run `cargo deny check licenses bans sources` in the same change.
- `rust/Cargo.toml`: members are `crates/*`, so no unit edits it.
- `rust/deny.toml`: coordinator only.
- A unit that needs a new wiring line in `cos-core` asks the coordinator. The known later
  additions are already marked in `cos-core/src/surfaces.rs`: `session_finish` (E2.5),
  `agents` (E2.6), Desktop tools (D3.1, E2.8) and Plugins tools (G4.3).

## Synthesis decision

One designer compared three whole shapes, because standing order 10 rules out a runner panel.

- **A. Owners publish snapshots** (chosen). One crate per unit, each owner is the only writer
  of its state, reads go through `watch` snapshots, writes go through the owner, and the kernel
  is a library run inside each call.
- **B. Central store and reducer.** One `CoreState`, one actor, one command enum and one
  `AppState`-like snapshot. This would be the easiest port of the UI binding. It loses on
  collisions (one enum and reducer for ten units) and on latency (every tool call reads
  permissions through the actor).
- **C. Shared state behind locks.** It is the closest to the TypeScript code. It loses on lock
  order by convention and on readers that hold locks the writers need.

Red-flag screen of A:

- Shallow module: none. `AppCore` is three operations (`watches`, `spawn`, and `Core::shutdown`
  on the owner) in front of every owner. `Kernel::call` hides the nine-step pipeline behind
  one call.
- Information leakage: none. Wire types stay inside `cos-mcp`, `cos-control-api` and
  `cos-http`. Tools see `Value` arguments only through their typed `Args`.
- Split ownership: none. `ConfigStore` is reachable only through `Settings`. Every published
  snapshot has one sender.
- Two ways to do one task: grants are derived only by `Grants::derive`. C1.10 must call it for
  Desktop availability and must not read capabilities by hand.
- Hand-synced lists: two exist and each gets a test. The kernel's order table must name exactly
  the tools `surfaces.rs` registers (C1.2 test). Every registered tool must have exactly one
  declaration template (C1.2 test).

## Tradeoffs accepted

- We accept 13 small crates and their manifests in exchange for compile-checked boundaries and
  disjoint files.
- We accept that a missing owner panics inside its own task and the Core continues, in exchange
  for a Core that starts and stops cleanly at every stage of the build. The panic names the
  unit. When Track 1 is complete, no `todo!` is left on a startup path.
- We accept per-call `Grants::derive` (a few bit operations and a roots clone) in exchange for
  never storing a second copy of the config.
- We accept that exposure updates from an old generation's late request can widen the new
  generation's exposure. Live grants still refuse such a call, and the lock-free join is worth
  more than exact resets.
- We accept that `cos-http` is implemented now, ahead of its first user, because C1.1, C1.9 and
  E2.1 need the same drain semantics and would otherwise write three copies.
- We accept that `CallRecord` borrows the arguments and the result, so recording copies nothing
  large, and that the kernel therefore awaits the recorder before answering.

## Implementation reconciliation

Record accepted deviations here, with the coordinator's acceptance, before the next unit begins.

- Answers to the open questions below: R0 goes first (manual-mode C1.10 slice); `/v1/status`
  fields owned by later units, and `session_finish`/`agents` in their variants, are known
  differences with no stubs; `--quit` joins the binary contract; the shipping version is decided
  at packaging.
- C1.3 `cos-fs` refuses two escapes the TypeScript sandbox allows (both reproduced against
  `sandbox.ts`): a create through a dangling link (`Path contains a link that could not be
  resolved`), and a junction to a sibling folder whose name differs only by Unicode case folding
  (canonical paths are compared exactly). Accepted: these are security fixes.
- C1.3 does not port `text-match.ts` or the unused `fsops.ts` write/list helpers: no tool calls
  them. Managed-root rules (read-only user Skill folders, linked-skill aliases) belong to the
  unit that ports `kernel.ts` `resolveIn` and `skill-access.ts`, not to `cos-fs`.
- C1.2 exposure follows the shipped TypeScript code, not this doc's earlier rule: exposure is
  forgotten on any change to effective capabilities, `multiAgent.enabled`, `sessions.record` or
  `ui.finishTool` (`src/main/ipc.ts:695-698`), so a revoked tool leaves the list and a stale
  call gets `-32602`; `TOOL_DISABLED` only appears in a race. The rule lives in
  `Kernel::observe`. Accepted additions to `cos-tools`: `Tool::refine`/`DynTool::refine_json`,
  `ArgIssue`, `CallRecord::nested` (C1.8 reads it), `SurfaceTools::undeclared()` (cos-core will
  assert it is empty), and the invented `SERVER_STOPPING` refusal text for calls during shutdown.
- C1.1 `cos-mcp`: `EndpointDeps` gains the config receiver (connector suffix for RFC 9728
  metadata); `call-missing-name` is produced by the transport and owned by C1.1; a missing
  `arguments` reaches `Kernel::call` as `{}`; `Kernel::call` futures must be `Send`. Accepted
  deviations: batch frames are written in request order, non-ASCII Host/Origin are refused,
  rare JSON parse edges become `invalid_json`, log lines omit per-call timing. Accepted follow-up:
  split `Kernel::begin_request` into `note_contact(surface)` and `track_request()` so self-test
  and tunnel probes stay counted in flight without advancing the clock. Deferred: a
  `force_after(d)` stopping handle in `cos-http`, only if C1.10 needs to shorten a running drain.
- `cos-mcp` serves the 2026-07-28 era per the SDK 2.1.0 oracle (241/241 cases) and logs each
  new client's negotiated protocol and `clientInfo`. Deviation: `subscriptions/listen` streams
  end at stop with the SDK close result instead of holding the graceful drain forever. The app
  hands `onerror` to the Node adapter, not to `createMcpHandler`, so only the adapter's errors
  are logged (a Host with credentials); the oracle records them per case as `reported`, and
  the endpoint logs an `MCP handler error` line exactly there.
- Integration item for C1.2 (assigned to C1.4): map `SandboxError::Os(e)` to `ToolError::from_io(&e.to_io_error())`
  so the model sees the `friendlyError` text, and keep `Refused(to_string())` for the rest.
- Core follow-ups (`rust/core-followups`):
  - Connector names live on `CallContext::connectors` (`cos_tools::Connectors`: `name(surface)`
    with the connector suffix, `sharing_tunnel(surface)`), derived from the same config snapshot
    as `grants`, not on `Grants`. A new `Grants` field would break the `Grants { .. }` literal in
    `cos-sessions/tests/store.rs`. `save_image` and the code-mode unknown-tool note use it.
    `cos-connection` still has its own copy of both rules (`surfaces.rs`, `shared_tunnel_ids`)
    and should switch to `Connectors::from_config`.
  - `CallContext::invoke_nested` is replaced by `nested_tools()` (the live listing minus `exec`,
    which is code mode's `ALL_TOOLS`) and `nested_invoker()`, whose futures borrow nothing. Code
    mode moves children still running at the end of a script onto their own Tokio tasks and
    answers before they finish, as TypeScript does; such a child keeps its script's place among the 4 runs until it settles.
    `cos_codemode::run` must be called inside a Tokio runtime.
  - `validateImageBytes` moved from `cos-files` to `cos-fs` (`validate_image_bytes`,
    `MAX_VIEW_IMAGE_BYTES`) with the `image` and `zune-jpeg` dependencies, because a tool crate
    may depend only on `cos-tools` and `cos-fs`. This adds the `cos-codemode` to `cos-fs` edge.
  - `cos-tools` re-exports `FileChange` and `ToolOutcome`, the types `CallNotes` carries;
    `cos-patch` keeps `cos-types` only as a dev-dependency. `read` and `find` fill
    `CallNotes::count`.
  - `rust/about.hbs` ends with the vendored Codex `NOTICE`, so `THIRD-PARTY-NOTICES.txt` ships
    it; `cos-patch/tests/notice.rs` checks the two stay equal.
  - Open item for C1.1: the endpoint answers a 403 (Host/Origin guard) or 404 (unknown path)
    without reading the request body. A body that arrives after the answer resets the
    connection, and on Windows the client loses the answer (20 of 20 tries with the body sent
    20 ms after the head). Proposal: call `discard(body, deadline)` on those paths, as the 413
    path already does. The endpoint tests now send head and body in one write.

- `exec-spare-pool` (accepted by the coordinator): startup step 4 now starts one pre-started
  PowerShell in the background while commands are enabled, and a Core task follows the
  `command` capability (on prestarts one, off ends them all). The pool grows to three on the
  first `exec_command` and shrinks back to one after 2 min without a call. `wall_time_seconds`
  includes the 150 ms early-exit grace, so it reads up to 150 ms higher than the TypeScript app
  for the same command.

- `e2-5` (accepted by the coordinator): a caller that asks to commit a Compact & Resume
  transaction after another caller finished it gets `already-committed` (TypeScript: `committed`
  only for joiners of an in-flight commit); both count as landed. Two captures that start in the
  same instant, the first failing, can make the second retry where TypeScript returns null for
  both; the outcome converges.

## Track 2: the browser bridge (`cos-bridge`)

E2.1 adds one crate, `cos-bridge` (MIT), that every Track 2 unit builds on. It owns the second
loopback server that the unchanged extension (protocol 14) talks to: port selection, `/hello`,
`/pair`, bearer auth, Origin and CORS, body caps, the rate limit, the `/wake` WebSocket and the
extension folder. It holds no recorder, input, command or goal logic. Those arrive as route
families, one file per unit.

### Layout and edges

```text
crates/cos-bridge/src/
  lib.rs            Bridge (the owner), BridgeDeps, Wake, BridgeStatus publication
  ports.rs          PortSelection::from(choice, CLF_BRIDGE_PORTS): pure
  lifecycle.rs      the run task: bind the first free candidate, follow ui.browserBridgePort, drain
  server.rs         the cos_http::Service: the gate pipeline below, then the router
  gate.rs           Origin, extension headers (Peer), protocol
  pairing.rs        bridgeToken over the shared SecretStore, the disconnect latch, constant-time compare
  presence.rs       lastSeenAt, extensionVersion, the once-per-build announcements
  limits.rs         MAX_BODY_BYTES, the 900-per-minute window, body reading that drains past the cap
  router.rs         Route, Family, Routes, Exchange, Reply
  wake/             the hub (authorized sockets, signal, heartbeat, revoke) and the RFC 6455 framing
  extension.rs      the userData/extension mirror, build stamps, the update offer
  families/mod.rs   one `pub mod` per Track 2 unit, already declared
  families/<unit>.rs  that unit's routes; E2.1 owns `extension.rs` (`/extension/update`)
```

New edges: `cos-core` → `cos-bridge`; `cos-bridge` → `cos-http`, `cos-secrets`, `cos-store`,
`cos-tools` (for `Admission` and `EpochMs`), `cos-types`. `cos-bridge` sits in the owners layer and
depends on no other owner. `cos-control-api` reads the bridge only through
`watch::Receiver<Arc<cos_types::app_state::BridgeStatus>>`, so it gains no crate edge. Like the
other servers, `cos-bridge` uses `hyper` inside and exposes no `hyper` type.

`cos-http` gains two additive things that the bridge needs and C1.1 and C1.9 do not use:
`Listener::bind_loopback_on(port, ..)` (a fixed port; `bind_loopback` is now `bind_loopback_on(0, ..)`),
and HTTP/1.1 upgrades on every connection, so a `101` response hands the socket to its server.
Upgrades need the listener's own graceful drain, because hyper-util's `GracefulShutdown` cannot
watch an upgradeable HTTP/1.1 connection. An upgraded socket leaves the drain the moment it is
handed over, and its owner (the wake hub) closes it.

`Core::start` reads `CLF_BRIDGE_PORTS` once and gives the same `BridgePortOverride` to Settings
and the bridge. `Core::start_with_bridge_ports` takes it as an argument instead, and every
in-process test passes `0`: with the bridge on by default, a test Core would otherwise listen on
8765, where the person's own extension looks. The subprocess tests already set the variable.

### The request pipeline

`server.rs` runs the TypeScript order from `handle()` in `bridge.ts`, so every refusal is the same
status and body:

1. A request with `Upgrade` goes to the wake hub (below), never to a route.
2. `OPTIONS`: no Origin is `403 forbidden_origin`; otherwise `204` with the CORS headers,
   `access-control-allow-private-network: true` and `access-control-max-age: 600`.
3. An Origin that is present and not `chrome-extension://...` is `403 forbidden_origin` with no
   CORS headers. Every other answer echoes the Origin when there is one.
4. Presence notes the extension version and build (logged once per build per 30 minutes; one
   protocol warning per process).
5. `/hello` (any method) answers `BridgeHello`.
6. `POST /pair`: protocol `426`, rate `429`, body `413` or `400 bad_request`, the latch `409
   browser_disconnected`, secure storage `503 secure_storage_unavailable`, then the token.
7. The disconnect latch is `401 browser_disconnected`, a wrong or missing bearer is `401
   unauthorised`, a wrong protocol is `426`, the window is `429`.
8. The request counts as a sighting (`lastSeenAt`).
9. While admission is not `Serving`, every routed request is `503 bridge_recovering` with
   `retryable: true`, which is what the TypeScript bridge answers while it restores commands or
   after its listener was replaced.
10. The router finds the family for `(method, path)` and awaits it on its own task. A family that
    panics is answered `500 internal`, as an exception in `handle()` is.

Steps 1 to 8 are the transport. A family never re-checks them, and sees only the parsed `Peer`.

### Route registration

```rust
pub enum Methods { Get, Post, Any }
pub struct Route { pub methods: Methods, pub path: &'static str }

pub trait Family: Send + Sync + 'static {
    /// The exact routes this family answers. No two families may share one.
    fn routes(&self) -> &'static [Route];
    fn serve(self: Arc<Self>, exchange: Exchange) -> BoxFuture<Reply>;
}

let routes = Routes::new(extension)          // registers E2.1's own family
    .family(Arc::new(Recorder::new(..)));    // E2.2's one line in cos-core
let bridge = Bridge::spawn(BridgeDeps { routes, .. });
```

`Routes` is a lookup table keyed by path, so a new family adds entries, not a branch. `family()`
panics on a route another family already claimed, which the Core's own startup test catches.
`Exchange` carries the method, path, query pairs, `Peer` and the unread body. It reads JSON with
the 2 MiB cap or a family's own cap (`/browser/presence` 1 KiB, `/cos-browser/sign-in` 96 KiB),
drains an over-long body before answering, and treats an empty body as `{}` as `readBody` does.
`Reply` is a status and a serialized body. The server adds `content-type`, `content-length`,
`cache-control: no-store` and CORS. No family touches headers.

How a later unit plugs in, without editing a file another unit owns:

- It writes its routes in `families/<unit>.rs`, which `families/mod.rs` already declares. Its
  domain logic, when it is more than a route adapter, lives in its own crate that the family
  calls, so the family stays a thin wire layer and the domain stays testable without HTTP.
- Its state lives in its own owner. The family holds handles to that owner, which `cos-core`
  passes when it builds the family. That registration line in `cos-core` is the coordinator's.
- It publishes work with `Wake::signal(WakeSignal::Wake)` or `WakeSignal::BrowserControl`. The
  `Wake` handle comes from `Bridge::wake()` and can be cloned into any owner.
- It may read `Bridge::status()` and `ExtensionFolder` (the update offer for `/status`).
- `Cargo.toml` of `cos-bridge` is shared. A unit adds its dependency lines and nothing else there.

### Unclaimed routes

Until a unit claims a route, it gets the TypeScript fall-through, `404 {"error":"not_found"}`,
after the same gates. E2.2, E2.3, E2.4 and E2.5 have claimed theirs; the table lists every route
with its owner.

| Route | Owner | Answer | Why |
| --- | --- | --- | --- |
| `/hello`, `/pair`, `OPTIONS`, `/wake` | E2.1 | served | transport |
| `POST /extension/update` | E2.1 | served | the extension folder is E2.1's |
| `POST /events`, `/correlations`, `/closed`, `/browser/presence` | E2.2 | served | |
| `POST /input/{claim,bind,ack,fail,answer,progress,attachment}`, `/conversation-deleted`, `/image-export`, `/commands/{revivals/pending,redeem,step,ack}` | E2.3 | served | `/input/claim` also carries Send authorization (`authorize: true`) |
| `/status` (any), `POST /models`, `/usage`, `/plugin-refresh`, `/project-create`, `/browser/preferences`, `/diagnostics`; `GET`/`POST /settings` | E2.4 | served | |
| `POST /compact`, `/repairs/claim` | E2.5 | served | `/repairs/claim` answers `{"allowed":false}` until browser recovery hands repairs out |
| `POST /goal/{draft,ack,objective,open}`; `/activity` (any), `POST /activity/detail` | E2.7 | 404 | no goal exists; activity reads have nothing to lose |
| `POST /browser-control`; `/cos-browser/sign-in` (any) | E2.8 | 404 | no browser command or sign-in transfer exists |
| `POST /core-plugin` | G4.3 | 404 | an advisory report; the next page load repeats it |

A 404 on `/status` costs nothing the extension needs to connect: pairing opens the wake socket
directly (`ensurePaired`), and every later failed `/status` only skips that maintenance pass.

### State and secrets

| State | Writer | Readers | Mechanism |
| --- | --- | --- | --- |
| Listener, port, bind error | the bridge run task | `BridgeStatus` | one writer; a port change binds the new port before it drops the old one |
| `bridgeToken` in `secrets.bin` | `pairing.rs` | auth, `/hello`, wake auth | the one `Arc<Mutex<SecretStore>>` that `cos-core` also gives C1.10, plus an async queue for pair and unpair (`withBrowserCredentials`) and an epoch that Disconnect bumps |
| `lastSeenAt`, version, CoS-host sighting | `presence.rs` | `BridgeStatus` | independent facts, one small lock |
| Wake sockets | the hub | `connected()`, `signal()` | the hub's lock; each socket task owns its own IO |
| Rate window | `limits.rs` | the same | one counter, a real single shared budget |
| `BridgeStatus` | composed from the facts above on every change, through one `watch::Sender` | `/v1/status`, UI | `send_if_modified`, so concurrent publishers converge on the same value |

Shared secrets (risk 7): `SecretStore` keeps a decrypted snapshot, so two stores on one profile
would each write back a stale map and lose the other's key. The Core therefore builds exactly
one store and hands the same `Arc<Mutex<SecretStore>>` to the connection owner and the bridge.
After the first load a read is a map lookup, so the mutex is held for microseconds. Every call
runs on the blocking pool, because the first load and every write do DPAPI and file IO.

### Extension folder

`ExtensionFolder::locate()` looks beside the executable and up to five folders above it, as
`locate_ripgrep` does. `resources/extension` with a `manifest.json` is a packaged build. It is
mirrored to `<userData>/extension` with the staged copy, backup, in-place sync and crash recovery
of `extension-path.ts`, so Chrome's remembered path and the folder's identity stay the same. The
mirror runs once per launch on the blocking pool and again for `/extension/update`. A checkout's
`extension/` is used where it is, as the TypeScript development build does. The fingerprint
covers the same entries but orders names by bytes, not by `localeCompare`, so the first Rust
launch after a TypeScript one copies the folder once more.

### Accepted deviations

- An upgrade request the hub refuses (wrong path, web Origin, 8 sockets open, bad handshake) gets
  a status and a closed connection. The `ws` server destroys the socket without answering. A
  WebSocket client sees a failed handshake either way.
- A bind error names the failing ports as TypeScript does, with Node's error code spelled from the
  Rust error kind (`listen EADDRINUSE: address already in use 127.0.0.1:8767`).
- A `ui.browserBridgePort` change whose port is taken is refused, as in TypeScript: inside the
  config save, Settings binds and releases the new selection (`PortSelection::probe`) before it
  persists, and the save fails with the bridge's error text. TypeScript hands the listener it
  bound to the bridge; Rust lets the bridge bind again, so a port taken in the moment between
  the probe and that bind still leaves the bridge on its old port with `error` set.
- `BridgeStatus.externalExtension` stays `null` until the unit that ports `browser-proof.ts` and
  `/browser/presence` lands. `/v1/status` does not carry it.

## Open questions and risks

1. Should the coordinator schedule milestone R0 first: a minimal manual-mode C1.10 (connect,
   start the endpoint, publish local URLs), C1.9's `/v1/health` and endpoint files, C1.1, and
   C1.2's `initialize` and `tools/list`? The recorder cannot run against the binary before
   then. The rewrite map puts C1.10 last.
2. Should C1.9 match `/v1/status` fields that only later units can produce (`bridge` until
   E2.1, `update` until G4.4, `plugins` until G4.3), or record them as known differences? The
   recommendation is known differences, with no stub values.
3. Should C1.2 serve the `session_finish` and `agents` declarations before E2.5 and E2.6 exist?
   The `finish-tool` and `multi-agent` variants then list them with no handler. The
   recommendation is no: record those two lists as known differences until their units land.
4. Is the headless-only `--quit` switch acceptable as part of the binary contract in
   `rust/golden/README.md`?
5. The Rust build reports the `package.json` version (2.1.35) so the corpus matches. Which
   version does the first shipping Rust build report?
6. Risk: `ConfigStore::load` repairs or recovers a damaged config synchronously on the startup
   path. A very large or slow `config.json` would delay every listener. The file is small in
   practice. This is unmeasured.
7. Risk: two owners will need the same secrets (C1.10 now, later E2.1 for `bridgeToken` and
   E2.7 for provider keys). The single `Mutex<SecretStore>` serializes DPAPI calls. If that
   shows up in timing, a secrets owner task replaces the mutex.

## Next implementation step

Build milestone R0. First C1.1 and C1.2 (`initialize` and `tools/list` from templates), then the
manual-mode connect in C1.10 and `/v1/health` in C1.9, then record `base` with `--binary` to
diff the first folders.
