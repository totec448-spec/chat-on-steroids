# Chat On Steroids — the agent map

Quality>> quantity. User wants less new code and delete more old code. Don't bloat the codebase, make it shorter and better and more maintainable Everytime you work on it. It should shrink not ballon.

**User hates a growing codebase. Quality >> quantity.** New findings should improve the underlying
decision and replace/delete obsolete logic, not stack another fallback, watcher, state machine, or
special case on top. Prefer less code, fewer branches, one deterministic source of truth, and reuse
of existing mechanisms. Every change should make the system smaller, simpler, and easier to reason
about where practical. Do not spam fixes into the codebase; fix the decision from the ground up.

**No build-up: rewrite the affected subsystem with the new feature/invariant in mind.** Do not keep
the old architecture and bolt a new path beside it merely because that is the smallest diff. When a
new implementation supersedes an old assumption, recode that specific area around the new source of
truth, delete the obsolete branches/state/fallbacks it replaces, and converge callers/tests on that
one design. This is not permission for broad rewrites: change only the affected subsystem, but leave
it architecturally cleaner and preferably smaller than before.

**Rule: no build up; rewrite with the new feature in mind.**

**This tree is usually dirty and shared with the user and other agents — never `reset`,
`checkout`, `clean`, reformat, or overwrite work you did not do.**

The single orientation document for this repository. Read it before changing anything.

**How to use it.** §1–§3 is the mental model; read those once, in order. §4 is "where is the
thing" plus the mechanism ledger: every durable fact, owner, lifetime and publication boundary
that matters across subsystems. §5–§17 is one section per subsystem, each with the same shape —
what it owns, its files, its flow, **what must hold**, how it fails, which tests cover it. §18 is
the fastest entry point when you have a symptom and no theory. §19–§22 is how to work here.

**One file, complete.** This replaces the old `AGENTS.md` + `agent.md` split, which
duplicated roughly 60% of its content and had already drifted between copies. It is sized
for completeness rather than for any tool's default project-document budget; if your
harness truncates long project docs, raise its limit rather than cutting this down.

---

## 1. The app in sixty seconds

A **Windows/macOS/Linux Electron app** that hands ChatGPT a deliberately small set of local
computer capabilities over MCP. It is a bridge and a permission layer — not a chat client,
not a model host. It also ships a Chrome extension that watches ChatGPT itself, so the app can
record conversations, prove which conversation issued which tool call, replace generic tool
rows with what actually happened, compact a long chat into a fresh one, and run worker chats.
Core is portable; the Desktop/computer-use surface is deliberately Windows-only and must be
absent from live macOS/Linux capability/discovery state.

Four runtime planes, only two of which are servers:

```text
              ── PUBLIC / CHATGPT SIDE ──────────────────────────────

 ChatGPT model                                    ChatGPT web page
   │  MCP over HTTPS                                │
   ▼                                                ├─ chatgpt-dom.js  selectors only
 ┌──────────────┐  ┌──────────────┐                 ├─ content.js      isolated-world
 │ Core         │  │ Desktop      │                 │                  recorder + UI
 │ files/term/  │  │ screen/input/│                 └─ fiber.js        MAIN-world React
 │ session/     │  │ clipboard    │                                    evidence
 │ agents       │  │              │                        │
 └──────┬───────┘  └──────┬───────┘                        ▼
        └────────┬────────┘                        background.js  MV3 worker, journal,
                 │ tunnel                                         tab↔conversation registry
                 ▼                                                │ HTTP 8765-8769
   127.0.0.1  MCP server                                          ▼
   secret tokenized path per surface                        bridge.ts
                 │                                                │
   server.ts → tools.ts → kernel.ts                               ├→ recorder / correlation
                 │                                                ├→ Compact & Resume
        ┌────────┴────────┐                                       └→ agent bootstrap
   Core tools        Desktop tools
        │                 │                        ── ELECTRON RENDERER ──
   sandbox +        computer/*                      renderer → preload (fixed API)
   codex/* ports                                             → ipc.ts → main services
        │
   files + processes
```

**The MCP server and the browser bridge are two different servers with two different
threat models.** MCP is the model's capability endpoint. The bridge exists only for the
Chrome extension and deliberately has no route that reads a file, runs a command, or
changes a permission. Never merge their lifecycles or their auth.

The extension never executes a tool. It observes ChatGPT and reports evidence. **The app is
the only authority on what a local tool actually did.** The renderer has no Node, no
filesystem, no command, no network authority; it crosses preload through named IPC.

## 2. Where the bugs actually are

Almost nothing hard here is a local algorithm bug. The hard ones live on six boundaries:

| Boundary | The two things people confuse |
| --- | --- |
| Discovery vs. enforcement | a schema ChatGPT cached vs. a permission that is live *now* |
| Path spelling | `/project/src/a.ts` vs. a native `C:\work\...` or `/home/...` path — same decision required |
| Request vs. conversation | HTTP `x-request-id` vs. the ChatGPT conversation that owns it |
| Process lifetime | content script (document) vs. service worker (suspends) vs. app (restarts) |
| Durable vs. frontend identity | local session id vs. the ChatGPT conversation attached to it |
| Async vs. selection | a load started for A vs. the B the user has since selected |

If a bug looks like four subsystems failing at once, it is one of these, once. Find the
**earliest wrong identity or state transition** — not the last UI that displayed it.

### Name the identity, then find where it is lost

Every boundary above is a place where one specific identity is supposed to survive. Before
reading any code, say which one this bug is about. If you cannot state it, you have not
found the real boundary yet.

| Plane | The identity that must survive |
| --- | --- |
| filesystem | approved root + canonical real path |
| MCP call | normalized request id |
| tool ownership | request id -> conversation id |
| browser observation | conversation id + navigation epoch + message/turn identity |
| agent | conversation id -> prime or worker slot |
| workspace | conversation/agent key -> cwd |
| terminal | proven owner -> exec session id |
| session | local session id + conversation lineage |
| compaction | continuation token + from/to conversation |
| renderer load | selected session id + load generation |
| connection | tunnel/endpoint generation |
| desktop coordinates | screenshot frame id |

Then classify which plane produced the **first** wrong fact — MCP transport/discovery,
permission/sandbox/tool runtime, browser observation/identity, bridge/session/agent
orchestration, renderer presentation, or tunnel/packaging. Do not start in the file where
the symptom is displayed.

Three policies apply everywhere and are not repeated per section:

- **Fail closed** when a guess could cause cross-root access, cross-chat attribution,
  cross-agent terminal control, wrong workspace mutation, wrong compaction target, unsafe
  rendered HTML, or invalid image content reaching the model. For presentation-only
  degradation, keep the UI usable and label the uncertainty instead.
- **Scope every async result to the epoch that requested it** — navigation epoch, load
  generation, connection generation, endpoint lifetime. Id equality alone is not enough:
  an A → B → A navigation defeats it.
- **Bound every representation of large output** — bytes, tokens, decoded pixels, base64,
  structured fields. Not just the visible text, and not just the compressed input.

## 3. What is authoritative

Sources disagree here because the architecture moved fast. Precedence:

1. current implementation **plus a reproducible test or live repro**;
2. current declarations: `mcp/surfaces.ts`, `mcp/tools-core.ts`, `mcp/tools-desktop.ts`,
   `shared/types.ts`, `package.json`, `main/version.ts`, `extension/manifest.json`;
3. `README.md`;
4. public design references such as `docs/tool-surface.md`. Internal working notes and
   security reproductions are maintainer-only; a public clone should treat §5–§18 of this
   file as the architecture and design record.

**Code comments in this project are unusually load-bearing.** Many name the exact live
failure that motivated a guard. Read the comment before deleting the guard or "simplifying"
the state machine. Code and current tests still win when a comment has drifted.

### Baseline

Release numbers are authoritative in `package.json`, `src/main/version.ts` and
`extension/manifest.json`; the bridge protocol is `version.ts::BRIDGE_PROTOCOL`. Tests assert
the app/extension versions stay in sync, so this architecture guide deliberately does not
copy a release number that can drift. Core is cross-platform; main process is TypeScript;
extension is plain MV3 JavaScript with no build step; Vitest; `node-pty` is the main native
terminal dependency. Desktop automation remains explicitly Windows-only.

Fresh-install defaults from `config.ts` — **all Core tool permissions on**, **read-only off**,
**recording on**, session advisory/limit **400k/533k** estimated tokens, **auto-compaction on
at 400k and level-based with live-work gating**, **multi-agent on** with `maxWorkers` 2 (hard max 8).
Fresh installs also start with **zero approved roots**: enabled permissions are not usable
filesystem/command authority until the user approves a root, and `connection.ts` refuses to
publish a root-requiring Core surface until one exists. The limit is
derived, never typed: the Chat panel offers one threshold and writes `limit = threshold × 4/3`,
so the defaults have to satisfy that relation or the first save in that panel moves the red
line. Existing
configs keep explicit user choices; conservative migration defaults do not widen omitted legacy
permissions merely because the fresh-install defaults are broader. Windows also enables the
Desktop capability group; macOS/Linux mask that group off at runtime while preserving stored
choices so a config moved back to Windows does not lose them.

### Stale-doc traps

Do not "restore" these from an older document:

- `view_image` is its own Core tool, not a mode of `read`.
- Core declares **8** tool names but at most **7** are live: `find` and the exec pair are
  mutually exclusive. Desktop adds at most 2. Live ceiling is 9, and reporting must derive
  from the surface projection, never a hardcoded count.
- `session` has exactly two actions, `search` and `read`. Search discovers recordings; read
  requires an explicit local session id and returns cursor-paged history **without silently
  truncating authored user/assistant rows**. Tool rows are intentionally compact headlines with
  exact args/results behind separately cursor-paged `T…` detail reads, and any pre-existing
  recorder overflow loss is surfaced explicitly. Compact & Resume is app/browser orchestration —
  there is no model-visible `save_handoff`.
- Extension pairing is silent loopback `/pair` bearer provisioning. The six-digit flow is gone.
- Canonical messages live in `messages/*.json`, one replaceable shard per logical id; legacy
  `messages.json` is read during lazy migration. They are not appended forever to `events.jsonl`.
- `computer` carries **13** action variants, not 11.
- Fresh-install multi-agent is **enabled** by `defaultConfig()` through
  `FIRST_LAUNCH_MULTI_AGENT`; the older prose comment in `shared/types.ts` that says the feature is
  disabled by default is simply stale against fresh-install behavior. `config.ts::DEFAULT_MULTI_AGENT`
  remains the conservative schema/migration baseline; `defaultConfig()` is the fresh-install authority.
- Reusable workers normally **sleep after `finish` and are meant to be messaged again**. If
  `mcp/instructions.ts` still contains legacy wording that a finished worker must always be
  replaced, treat that as instruction drift against `agents.ts`/`tools-core.ts` and their tests,
  not as the lifecycle authority.
- Goal currently continues **completed final answers only**. Older README/working-note wording that
  says an `interrupted` turn is automatically continued is stale against `content.js::GOAL_CONTINUABLE`.

## 4. Repository map

```text
── shell / config ─────────────────────────────────────────────────────────
src/main/index.ts             Electron startup, window/tray, shutdown, security shell
src/main/shutdown.ts          ordered teardown phases, each bounded, ending in the exit
src/main/config.ts            validated settings, migrations, defaults, read-only caps
src/main/platform.ts          host capability projection; Desktop is Windows-only by construction
src/main/connection.ts        MCP + tunnel lifecycle, per-surface publication & status
src/main/ipc.ts               every renderer→main operation and main→renderer push
src/preload/index.ts          the complete renderer-facing API allowlist
src/main/secrets.ts           Electron safeStorage-backed secret storage
src/main/logger.ts            redacted RAM-only operational log (not the session store)
src/main/durable.ts           small named JSON state files under userData/state
src/main/diagnostics.ts       the UI self-test chain, hop by hop
src/main/update.ts            one-pass GitHub release check/download; apply only on ordinary quit
src/main/browser.ts           Chrome/Chromium discovery for worker/resume orchestration URLs
src/main/window-lifecycle.ts  single-instance/bootstrap/activation lifetime gates
src/main/window-layout.ts     work-area-bounded BrowserWindow geometry
src/main/window-icon.ts       packaged Linux native window icon decision
src/main/tray-image.ts        platform-aware tray/menu-bar image + stable macOS tray identity
src/main/extension-path.ts    transactional stable materialization of the unpacked extension

── MCP ────────────────────────────────────────────────────────────────────
src/main/mcp/server.ts        HTTP transport, secret paths, body bounds, exposure cache
src/main/mcp/tools.ts         builds exactly one surface's server; refuses foreign names
src/main/mcp/surfaces.ts      Core/Desktop discovery boundaries + declared tool names
src/main/mcp/kernel.ts        dispatch, live guards, caller/workspace identity, agent inbox
src/main/mcp/tools-core.ts    Core registration + connector wrappers
src/main/mcp/tools-desktop.ts Desktop registration + wrappers
src/main/mcp/inbound.ts       x-request-id extraction and normalization
src/main/mcp/call-context.ts  AsyncLocalStorage per call + in-flight accounting
src/main/mcp/instructions.ts  model-facing server instructions

── filesystem / execution ─────────────────────────────────────────────────
src/main/sandbox.ts           approved-root authority; virtual↔native containment
src/main/workspace.ts         per-chat/agent learned project cwd (convenience, not auth)
src/main/rawfs.ts             raw Node fs, bypassing Electron's asar interception
src/main/fsops.ts             shared bounded file/image/text helpers
src/main/search.ts            connector search implementation
src/main/ripgrep.ts           bundled-first rg locator, then host PATH fallback
src/main/env.ts               one OS-correct environment model for every spawned child
src/main/toolchain.ts         conservative Windows JAVA_HOME/GOROOT discovery
src/main/exec-hints.ts        narrow shell rewrites + recovery hints; abstains on ambiguity
src/main/diffstat.ts          bounded exact/approximate line-delta accounting for activity rows
src/main/text-match.ts        shared newline/Unicode-aware unique text matching
src/main/codex/tool-specs.ts  model-visible Codex contract text
src/main/codex/unified-exec.ts        exec_command / write_stdin runtime
src/main/codex/unified-exec-constants.ts  yield deadlines, buffer and token policy
src/main/codex/exec-output.ts model-facing exec serialization
src/main/codex/shell.ts       host shell selection, quoting, launch
src/main/codex/ownership.ts   terminal-session caller ownership
src/main/codex/manager.ts     the one process-manager lifetime shared by exec/write_stdin
src/main/codex/command-batch.ts sequential same-shell `cmds` framing + per-command exit parsing
src/main/codex/head-tail-buffer.ts bounded output head+tail retention, omission accounting
src/main/codex/truncate.ts    Codex-compatible UTF-8 byte/token output truncation
src/main/codex/filesystem.ts  ported low-level Codex fs primitives (no policy)
src/main/codex/read-backend.ts  connector read semantics over those primitives
src/main/codex/view-image.ts  image load/validate + MCP content adaptation
src/main/codex/apply-patch/*  V4A parser / matcher / runtime / shell interception

── sessions ───────────────────────────────────────────────────────────────
src/main/session/store.ts     durable sessions, messages, assets, handoffs
src/main/session/recorder.ts  merges MCP truth with browser observations
src/main/session/correlation.ts  requestId → conversationId proof registry
src/main/session/continuation.ts transactional Compact & Resume rebind
src/main/session/resume-gate.ts tiny pre-commit gate preventing resume shadow sessions
src/main/session/handoff.ts   validates/prepares the brief; continuation publishes it
src/main/session/handoff-prompt.ts  the brief injected into the old chat
src/main/session/retention.ts startup + six-hour coarse pruning maintenance
src/main/session/summarize.ts human-readable activity summaries
src/main/mcp/session-tool.ts  model-facing search/read projection over recorded sessions
src/shared/chronology.ts      timeline ordering and folding
src/shared/session.ts         session/activity/swarm wire types
src/shared/goal.ts            Goal prompts (continuation + specific goal) and their bounds
src/shared/capabilities.ts    root-required vs rootless capability classification
src/shared/types.ts           config/app/IPC types and Capabilities

── browser ────────────────────────────────────────────────────────────────
src/main/bridge.ts            extension HTTP bridge + compaction/worker orchestration
src/main/goal.ts              the goal loop: OpenRouter request, context, one draft per turn
src/main/agents.ts            the one global star-topology multi-agent broker
extension/chatgpt-dom.js      EVERY ChatGPT selector and DOM-shape assumption
extension/content.js          page recorder, turn lifecycle, Overwrite, compact UI
extension/fiber.js            MAIN-world React/Fiber evidence reader (least trusted)
extension/background.js       service worker: token, journal, tab↔conversation registry
extension/overlay.css         every CLF-owned surface injected into the ChatGPT page
extension/popup.html/.css/.js extension status/reconnect UI only; no tool/session authority

── other ──────────────────────────────────────────────────────────────────
src/renderer/main.ts          setup/settings/connection/activity UI
src/renderer/chat.ts          session timeline, handoff, swarm UI
src/main/computer/index.ts    Desktop action policy, frame/ref lifetimes, batching and postconditions
src/main/computer/helper.ts   Windows PowerShell/Win32/UIA helper protocol; no model text in argv
src/main/tunnel/*             index.ts lifecycle · health.ts metrics · locate.ts binaries
test/*.test.ts                71 tracked Vitest suites, named for the subsystem/boundary they cover
scripts/*                     build-time icon / tunnel-client / ripgrep fetchers
electron-builder.yml          Windows/macOS/Linux package contents and target policy
```

`exec.ts` remains as the shared low-level process/environment primitive used by unified exec,
the Windows desktop helper and tunnels. The retired connector-native managed-process and patch
stacks were removed after production moved to `codex/unified-exec.ts` and `codex/apply-patch/*`;
do not recreate parallel runtimes beside those live owners.

### 4.1 Mechanism ledger — one fact, one owner, one lifetime

Use this table before inventing state. If the fact you need already has an owner here, extend that
owner or derive from it; do not mirror it in another module. “Durable” means it survives an app
restart. Browser `storage.session` survives MV3 service-worker suspension but **not** a browser
restart; `storage.local` survives the browser restart. A memory-only field is allowed only when a
durable or externally re-observable fact can reconstruct it.

| Fact / mechanism | Authoritative owner | Lifetime / durable form | Consumers / invariant |
| --- | --- | --- | --- |
| approved roots + permissions + feature toggles | `config.ts` | `userData/config.json`, atomic temp→rename; validated/migrated on every load | `effectiveCapabilities()` is the live permission projection; malformed existing config recovers conservatively, never as fresh-install consent |
| host capability availability | `platform.ts` + `shared/capabilities.ts` | derived, not stored | Desktop capabilities are impossible off Windows; every newly added capability is root-required until explicitly classified rootless |
| secrets | `secrets.ts` | OS `safeStorage`; never config/log/renderer | OpenAI, bridge and OpenRouter credentials never cross into untrusted renderer/page state |
| small cross-restart control state | `durable.ts` | named `userData/state/*.json`; temp→rename; debounced generations + explicit `writeDurableNow` barriers | swarm, continuations, correlations, bridge commands, Goal ledgers; a failed file must not poison later files or publish a rejected generation |
| MCP surface shape | `mcp/surfaces.ts` + `server.ts` exposure cache | endpoint lifetime | discovery is a cached schema promise; live permission enforcement is separate and current |
| one MCP request identity | `mcp/inbound.ts` | request lifetime in AsyncLocalStorage | normalize `x-request-id` before any higher-level routing |
| one in-flight call's mutable evidence | `mcp/call-context.ts` | request lifetime | tool outcome/changes/assets/caller travel with the call; wider “settling” lifetime includes attribution + recording after the handler returned |
| request→conversation proof | `session/correlation.ts` | durable named state | only exact request-id evidence is authoritative for modern attribution; every other placement is explicitly weaker/legacy and never a substitute for identity-sensitive routing |
| local session identity | `session/store.ts` | `sessions/<id>/meta.json` + `events.jsonl` + canonical shards/assets/handoffs | ChatGPT conversation id is a frontend binding; Compact & Resume moves it, never copies the local session |
| canonical authored message identity | `store.ts` + `shared/session.ts` | one replaceable `messages/*.json` shard per logical id | streaming revisions replace the same logical message; event chronology keeps the original anchor/seq |
| page/native mutable activity identity | `shared/session.ts::foldProgress` + store origins | append snapshots, folded on read | newest content stays at the earliest logical position; unknown identity is never guessed into a fold |
| session retention | `session/retention.ts` | process timer, current config read each sweep | startup prune + one coarse six-hour sweep; retention applies to existing history even with recording off |
| model-facing session cursor | `mcp/session-tool.ts` | opaque cursor carried by the caller | cursors pin snapshot/filter/range/open-message checkpoints; stale boundaries fail explicitly rather than silently skipping/repeating history |
| browser pairing / presence | `extension/background.js` + `bridge.ts` | token/intent in extension `storage.local` and app secret store; presence memory-only/re-observed | pairing token never reaches content/page; “browser absent” and “one chat absent” are different facts |
| browser observation custody | `extension/background.js` journal | `storage.session` until app `/events` accepts it | content-script success means “journal owns it”, not “app stored it”; an acknowledged observation must never vanish on worker suspension |
| real conversation lifetime in a tab | `extension/background.js` tab registry | `storage.session` | document reload/pagehide is not conversation close; tab removal/navigation away decides closure |
| browser document + navigation identity | `background.js` document/epoch registry + `content.js` epoch | browser-session state + per-document memory | stale documents/epochs may observe but may not mutate current conversation state |
| browser command intent | `bridge.ts` `CommandSpec` | durable `bridge-commands` snapshot | exactly three semantic intents: fresh worker, exact-chat revive, fresh resume; the spec owns identity, not a URL/tab/document |
| browser command lease | `bridge.ts` command record | durable queued/leased phase including `claimedAt` + exact `owner`; restore preserves a valid leased owner | `/commands/redeem` is the arbitration cut; worker/revive are exclusive to that page owner. Resume alone may transfer a pre-dispatch lease to another destination document while its durable send checkpoint still proves nothing was dispatched |
| irreversible browser command result | `background.js` command ACK outbox → `bridge.ts` command/receipt semantics | ACK outbox is mirrored to `storage.local` for browser-restart durability; app command/receipt state survives app restart | fresh worker/resume terminal ACK retires into a receipt. A revive `sent` ACK proves the user message crossed ChatGPT, but the command intentionally stays leased until exact worker liveness or the 30s revival deadline resolves broker state |
| deferred worker revival | `background.js::deferredRevivals` | `storage.local` marker only | survives browser restart; actual prime text stays app-side; bridge redeem remains the authority, so stale markers are harmless |
| worker lifecycle + ownership | `agents.ts` | swarm snapshot + retained/dormant prime-owned history | conversation binding is identity; `invited/active/detached/waking/sleeping/finished/failed` describe broker state, not page decoration |
| worker slot accounting | `agents.ts::occupiesSlot` | derived from broker state | sleeping workers free slots; waking reserves one before the browser acts; terminal rows never revive |
| agent message delivery | `agents.ts` | durable broker queue | at-least-once until authenticated acknowledgement; `offered` is not `delivered`; revival-delivered user messages are never re-offered in tool results |
| per-chat workspace | `workspace.ts` | memory derived/learned from proven identity + roots, moved with ownership | convenience state only; never authorization; missing trustworthy workspace fails instead of choosing the first root |
| terminal session custody | `codex/ownership.ts` + singleton manager | process lifetime | terminal id belongs to proven caller; another chat/worker cannot poll or write it |
| Compact & Resume transaction | `session/continuation.ts` | durable continuation WAL + session metadata commit | one local session, one open continuation per session, one claimant/commit; source keeps ownership until durable rebind lands |
| source/destination send ambiguity | continuation send checkpoints | durable `not-attempted` / `attempted-unresolved` / `dispatched-unresolved` / resolved message identity | pre-dispatch ambiguity is replayable; post-dispatch ambiguity is **not** permission to click again; ChatGPT's marked message resolves it |
| resume shadow suppression | `session/resume-gate.ts` | short memory claim bounded to 60s | recorder waits briefly for the already-authoritative continuation instead of inventing a second local session for the replacement chat |
| Goal objective | `goal.ts` objective ledger | durable per-conversation named state | chat-local finish line; moved by Compact & Resume; restore alone never starts work |
| Goal terminal reply obligation | `goal.ts` reply ledger | durable, one row per conversation, TTL + cap | the recorder freezes whether a stable final reply still requires one Goal decision before page races/reloads can lose it |
| Goal draft | `goal.ts` draft map | memory; tied to durable obligation | at most one draft per conversation/turn; browser client owns acknowledgement; only `ready` text may be typed and `no-reply` is a real terminal decision |
| renderer authority | `ipc.ts` + preload allowlist | process lifetime | renderer never receives generic Node/invoke authority; async reads paint only when their selection/generation still matches |
| connection/tunnel generation | `connection.ts` + `tunnel/*` | process lifetime, re-observed from process/metrics | stale callbacks from replaced tunnels are ignored; poll completion, not a local `/readyz`, proves external route health |
| child process environment | `env.ts` | rebuilt per child | Windows env names are case-insensitive; never write `PATH` by raw object indexing; preserve the inherited environment unless a narrow repair is proven |
| Windows build-tool discovery | `toolchain.ts` | process memoization | fill missing/unreachable JAVA_HOME/GOROOT only; never override an explicit or already-reachable toolchain |
| shell compatibility repair | `exec-hints.ts` | per command | rewrite only when intent is provable; unsupported/ambiguous shell syntax passes through untouched; hints are preferred to semantic guessing |
| command output budget | `head-tail-buffer.ts` + `truncate.ts` + `exec-output.ts` | per process/result | collection cap and model-visible truncation are different bounds; preserve head+tail and explicitly count omitted middle bytes/tokens |
| Desktop frame/ref identity | `computer/index.ts` | bounded process caches | physical coordinates are meaningful only against the captured frame/window geometry; semantic refs are meaningful only against their UIA snapshot |
| extension install path | `extension-path.ts` | stable `userData/extension` for packaged builds | stage/fingerprint/rename/rollback; Chrome never points at an AppImage's temporary mount or a half-copied update |
| app update | `update.ts` | one process pass; verified file under `userData/updates`, but **staged status is process memory only** | check/download never blocks startup; SHA-256 from release manifest is mandatory; install is handed off only during ordinary shutdown. A crash/restart does not rediscover the old staged file — next start checks/downloads again |
| app-window lifetime | `window-lifecycle.ts` | process lifetime | only the single-instance lock owner touches shared userData; activation is gated until bootstrap/security/IPC are ready and permanently disabled once quit begins |

If two rows appear to own the same semantic decision, treat that as an architecture bug until
proved otherwise. Mirrored **presentation** is fine; mirrored **authority** is not.

**What “durable” means here.** `durable.ts` is the app's process/crash/restart transaction layer,
not a claim of database-grade fsync/power-loss durability. Named state writes are serialized,
generation-fenced and published by temp-file→rename; `writeDurableNow()` is the barrier used when a
later side effect must not happen until the control intent is on disk. A failed background write
stays pending/retryable and cannot poison the serialization chain for other names. But
`readDurable()` deliberately turns a missing, unreadable or unparsable control file into `null`
after logging it: corrupt auxiliary state may cost pending orchestration work, **never the app's
ability to start**. If a mechanism needs stronger recovery than that, its independently durable
source (for example session metadata/history) must be able to reconstruct the projection.

---

## 5. Startup and shutdown — `index.ts`

```text
single-instance lock
  → only the lock owner may touch userData/bootstrap state
  → init config/secrets/session/durable paths → load + validate config
  → restore Goal objective/reply ledgers
  → restore request correlations BEFORE bridge traffic can race in
  → wire recorder↔agent identity callbacks + preferred-browser opener
  → wire swarm persistence sinks even if multi-agent currently off
  → restore retired-worker fences → restore active+dormant swarm history
  → if feature is off: pause live execution, preserve history, persist the safe projection
  → restore continuations AFTER swarm, because recovery may need to repair prime ownership
  → install renderer CSP + deny browser permissions
  → register fixed IPC → enable the native window activation gate → create/show window + tray
  → queue legacy attribution repair asynchronously
  → start bridge if recording OR multi-agent
  → start session-retention maintenance independently of recording admission
  → auto-connect MCP/tunnel if configured
  → fire one non-blocking update check/download pass
```

The **window activation gate** is a real lifetime boundary, not UI polish. Electron may deliver
`second-instance` after its own `ready` event while this app is still restoring durable state and
before CSP/permission/IPC setup is complete. `window-lifecycle.ts` therefore drops/folds early
focus requests until bootstrap enables the gate. Once `before-quit` disables it, that disable is
terminal: an old async startup continuation must never re-enable window creation during teardown.

The losing single-instance process also sets `quitting` immediately. `app.quit()` does not stop
module evaluation, so **every** shared-userData bootstrap path must be guarded by
`shouldBeginAppBootstrap()` rather than assuming a secondary process disappeared synchronously.

**Must hold.** The window keeps context isolation on, Node integration off, renderer
sandbox on, navigation and window creation constrained, permission requests denied unless
explicitly supported. Never weaken that to solve a renderer convenience problem. Every new
long-lived process, timer, listener, queue or durable writer names its shutdown owner —
teardown covers tunnels, both listeners, process sessions, then flushes session and durable state.

`will-quit` calls `preventDefault()` and owns the decision to quit from then on, and it
destroys the tray before teardown starts. So teardown is not merely ordered, it is **bounded**:
`shutdown.ts` gives each phase its own budget and always ends the process. A task that never
settles would otherwise strand an invisible main process holding the single-instance lock, and
every later launch of the app would silently do nothing. Per-task bounds are not a substitute
for that — "each piece is bounded" is a different claim from "the sequence ends".

Ending it is `app.exit(0)`, never `app.quit()`, and that is not interchangeable. Electron drops
a quit raised from the promise continuation that finishes teardown: on Windows the call returns
without even emitting `before-quit`, while the same call one macrotask later quits normally.
`shutdown.ts` therefore owns the exit itself rather than trusting its caller to remember.

The shutdown phases are also semantic ordering, not just cleanup aesthetics:

1. **admission/drain** — stop MCP + bridge from accepting work and let already accepted requests
   reach their own bounded drains;
2. **process cleanup** — only after request handlers stop may PTYs and the Windows helper be killed;
3. **recorder flush** — recorder work may enqueue session and named durable writes;
4. **durable flush** — session store and named-state store are independent writers and both get a
   last attempt even if one fails;
5. **update handoff** — a verified staged update is the final effect, after every stateful owner has
   finished, because the next process start is meant to be the new version.

### App update is deliberately boring — `update.ts`

There is no `electron-updater`, polling loop, renderer-owned download state or forced restart. One
deduplicated `checkForUpdates()` pass runs after startup and nobody awaits it. It asks GitHub only
for the newest tag, decides whether this exact installation can self-apply an artifact, downloads
at most that one file, verifies it against the release's `SHA256SUMS.txt`, publishes it from
`.part` by rename, and waits for the user's ordinary quit.

- Windows x64/ARM64 stages the matching NSIS installer and launches it detached with `/S` during
  shutdown; installer is per-user and needs no elevation.
- Linux **AppImage** can stage the matching AppImage; shutdown copies to `<running>.new`, chmods and
  renames over the path so the mounted old inode can finish running safely.
- Linux **DEB** is package-manager-owned; macOS is unsigned/unnotarized by current release policy.
  Both may show a newer-version notice but do not silently self-replace.
- A failed check/download/apply leaves the running version fully usable. Next app start checks
  again; there is no retry state machine inside the same run.
- The verified artifact file may still exist under `userData/updates`, but **the fact that it is
  staged is process-memory state**. A crash/restart does not rediscover or trust that old file;
  the next startup performs a fresh release check and, for an applicable update, downloads/verifies
  again. Do not build restart semantics around `updates/` merely containing an executable.

The update module does **not** own extension-version truth. `bridgeStatus()` learns that from the
authenticated extension header; duplicating it in the updater would create two authorities.

## 6. MCP surfaces and discovery — `surfaces.ts`, `tools.ts`, `server.ts`

ChatGPT discovers **one server's entire tool list as a unit**: a no-query
`list_resources` returns every schema that server advertises. Splitting into separate
servers is therefore the only mechanism that actually bounds the worst case. Two surfaces
earn it today.

**Core** (`chat-on-steroids-core`, required):

| Tool | Live when | Implementation |
| --- | --- | --- |
| `read` | `read` \| `browse` \| `metadata` | `tools-core.ts` → `codex/read-backend.ts` |
| `view_image` | `read` | `tools-core.ts` → `codex/view-image.ts` |
| `find` | `search` **and not** `command` | `tools-core.ts` → `search.ts` |
| `apply_patch` | any of `create`/`edit`/`move`/`deleteFile` | `codex/apply-patch/*` |
| `exec_command`, `write_stdin` | `command` | `codex/unified-exec.ts` |
| `session` | recording enabled | session subsystem |
| `agents` | multi-agent enabled | `agents.ts` |

**Desktop** (`chat-on-steroids-desktop`, optional, **Windows-only**): `observe` needs `screen`;
`computer` registers on `control` **or** either clipboard permission, then re-checks each
of its 13 actions at runtime. The surface is offered at all only when one of those four
permissions exists on Windows — an empty or impossible connector is worse than no connector.

**Exposure is monotonic per endpoint lifetime.** ChatGPT caches schemas, and yanking one
from under a cached snapshot surfaces as a transport-level UNKNOWN failure. So
`server.ts` remembers what this endpoint has ever exposed. A permission revoked after
exposure leaves the schema registered and its handler returns `TOOL_DISABLED`. The
`find`-vs-exec choice is frozen the same way, at first discovery.

**Must hold.** Two separate concepts, never collapsed: *exposed* (a schema may exist
because it was visible earlier) and *live* (the operation is allowed now).
**Schema visibility is never the security boundary** — `config.ts::effectiveCapabilities()`
and the live guards are. A server registers only tools its surface declares and answers
anything else with a protocol-level unknown-tool error; there is no merged list and no
hidden acceptance. A deliberate reconnect is the clean boundary for changing the shape.

**Tests.** `mcp.test.ts`, `config.test.ts`, `mcp-shutdown.test.ts`.

## 7. One MCP call, end to end

```text
tunnel request
 → server.ts    loopback Host/Origin, secret tokenized path, bounded body,
                x-request-id read + normalized (split before '/')
 → tools.ts     build only the requested surface
 → kernel.ts    AsyncLocalStorage call context
                resolve exact caller from correlation evidence
                resolve agent identity if a swarm is active
                wait for identity when the operation genuinely needs it
                enforce the live capability / read-only guard
 → tool handler sandbox any model path, execute, attach structured evidence
                (changes, counts, exit code, session id, assets)
 → recorder.ts  exact args/result/outcome; attach ONLY on proven ownership
 → kernel       agent inbox offer/ack bookkeeping
 → response
```

`server.ts` manually reads and bounds chunked / no-`Content-Length` POST bodies before
handing parsed JSON to the MCP adapter. **Do not regress that to a `Content-Length`-only
guard.** `inbound.ts` captures the raw header because the MCP library's higher-level
context has not reliably exposed it.

`call-context.ts` deliberately exposes **three lifetimes**, because "not completely accounted
for" is not the same as "can still mutate the machine":

- `runningToolCalls()` — dispatch has not returned; this is the **Compact & Resume safety
  barrier**, because commands/edits may still be changing the machine.
- `settlingToolCalls()` / `inFlightToolCalls()` — handler result is already released, but an
  unattributed durable record may still be waiting for late request-id evidence. Useful for
  diagnostics/shutdown/orphan accounting, **not** a reason to stall compaction for the recorder's
  grace window.
- `inFlightMcpRequests()` — widest request lifetime, including identity wait and durable recording;
  orphan cleanup uses it so post-handler bookkeeping never looks like global idleness.

An unresolved call is conservatively visible to every conversation until ownership lands; a
proven worker call does not block an unrelated prime.

## 8. Filesystem containment — `sandbox.ts`

The authority for every model-supplied path. Approved folders get virtual roots such as
`/project`; native absolute paths are also accepted when they resolve inside an approved root.

**Must hold.**

- Every model filesystem path converges on `Sandbox.resolve()` or an already-validated
  wrapper. "It is only a read" is not an exemption — reads are confidentiality-sensitive.
- **Virtual and native spellings receive identical authorization.** Test both the virtual
  spelling and the host spelling (`C:\approved\project\src\a.ts` on Windows,
  `/home/me/project/src/a.ts` or `/Users/me/project/src/a.ts` on POSIX). Never "improve" native
  normalization by letting it collapse traversal the virtual spelling rejects.
- Containment covers root selection, host-invalid/path-trick rejection, canonical checks on
  existing targets, deepest-existing-ancestor validation for missing targets, reserved virtual
  root names, and symlink/reparse/junction handling as applicable to that OS.
- Authorization must remain valid at the point of filesystem use; avoid designs that rely
  only on an earlier pathname check when the underlying target can change.
- Native filesystem error text must not leak hidden physical root paths back to the model.

**Not contained: shell commands.** `exec_command` is arbitrary code execution as the
logged-in user. Its *starting cwd* is restricted to an approved folder; the command is not.
That is why `command` is the strongest permission and why read-only mode disables it
outright. Never claim approved roots contain arbitrary commands — they contain the app's
filesystem tools. Read-only derives from the complete write-capability list, so a new write
capability must become read-only-blocked automatically.

**Tests.** `sandbox.test.ts`, plus retained bughunt repros.

## 9. Workspaces — `workspace.ts`

Two ideas that are easy to confuse: **approved roots** are the security boundary the user
configured; a **workspace** is convenience state saying which project *this exact chat or
agent* is working in.

Keyed by exact chat/agent identity, learned from proven absolute paths and project markers,
inherited by spawned workers, moved by Compact & Resume.

**Must hold.** A relative path or omitted `workdir` with no trustworthy workspace **fails**
rather than mutating a guessed project. When caller identity is unresolved during a swarm,
never silently fall back to the first approved root — that turns an attribution failure
into a wrong-target mutation. Moving a workspace is state continuity, never a new
permission; the target still has to be legal.

**Tests.** `workspace.test.ts`, `swarm.test.ts`.

## 10. The Codex-derived tools — `src/main/codex/*`

Selected public Codex behavior ported into TypeScript. **It does not launch a Codex model
or require a Codex installation.**

**`exec_command` / `write_stdin`.** `unified-exec.ts` ports session ids, output draining,
head/tail buffering, yield deadlines, output token policy, interactive stdin, and sessions
that outlive the call that created them. Windows adaptations (quoting, interrupt) live
beside the port and stay explicit and tested against model-facing behavior. There is a
known Ctrl+C vs. natural-exit race worth keeping a regression for. The local MCP adaptation
also accepts `cmds` to run related commands sequentially in one labeled shell session, and an
empty `write_stdin` poll returns on first output instead of holding Codex's full collection
window. Start at `tools-core.ts`
→ `unified-exec.ts` → `shell.ts` → `ownership.ts` → `exec-output.ts`.

The local execution wrapper adds several mechanisms around that port. They are not generic
"helpfulness" and must stay fail-safe:

- **One process manager, app lifetime.** `codex/manager.ts` is the singleton that makes an exec
  session id meaningful across later `write_stdin` calls. Never create a second manager per tool
  registration or conversation; caller isolation is enforced by `ownership.ts`, not by separate
  process pools.
- **One OS-correct child environment.** Every spawned process converges on `env.ts`. Windows
  environment keys are case-insensitive even though JavaScript object keys are not, so raw
  `env.PATH = ...` beside an inherited `Path` can erase the user's real PATH when CreateProcess
  folds the two spellings together. Read/write through `envValue`/`setEnvValue`, normalize before
  spawn, and only append the minimal Windows system directories when the inherited path is truly
  unusable.
- **Toolchain repair fills; it never chooses for the user.** `toolchain.ts` looks for a Windows JDK
  or Go installation only when `JAVA_HOME`/`GOROOT` is absent **and** the corresponding executable
  is unreachable. Java proves `javac.exe`, not merely `java.exe`, so a JRE cannot become a fake
  build JDK. Discovery is process-memoized because it sits on every command path.
- **Shell compatibility is abstention-first.** `exec-hints.ts` may repair a narrowly proven
  PowerShell quoting/glob mismatch, classify a documented search exit-1 as "no matches", or add an
  actionable recovery hint. If tokenization/flag arity/control flow is ambiguous, the original
  command runs untouched. A guessed rewrite that succeeds at the wrong command is worse than a
  visible failure.
- **`cmds` is one shell, not N processes.** `command-batch.ts` composes sequential commands in the
  same shell so cwd/environment changes survive between them. It keeps running after ordinary
  non-zero exits, frames each section with a random marker that command output cannot spoof by
  accident, and returns the first non-zero exit after all sections ran.
- **Collection and model output are different budgets.** `head-tail-buffer.ts` bounds what a
  process can accumulate while keeping a stable head, rolling tail and exact omitted-byte count.
  `truncate.ts`/`exec-output.ts` separately bound what is serialized to the model in UTF-8 byte /
  approximate-token space. Do not collapse the collection ceiling into the default response
  budget: an explicit larger `max_output_tokens` is supposed to work up to the collection cap.

**`apply_patch`.** Model syntax is Codex V4A. MCP cannot expose a true freeform tool, so
the raw patch rides inside the `patch` string while the grammar lives in the description.
Engine under `apply-patch/`; the wrapper adds capability checks (per hunk kind — add needs
`create`, delete needs `deleteFile`, content change needs `edit`, rename needs `move`),
sandbox resolution, workspace behavior, recorder evidence. **Shell interception** also
exists so a model emitting `apply_patch` as a shell command still reaches the port — if the
failure involves `cd`, quoting, `&&` or other control flow, the bug is above the parser.

Multi-file patch failure has a concurrency fence: the wrapper snapshots bounded pre-edit state,
and rollback restores only paths that still match the state **this patch itself produced**. If an
external editor changed a path after the partial patch, rollback refuses to clobber that newer
work. The rollback budget is intentionally bounded; this is a recovery guarantee, not permission
to snapshot arbitrarily large repositories into memory.

Inside `codex/apply-patch/`, keep the layers distinct:

| File | Mechanism it owns |
| --- | --- |
| `parser.ts` | whole-input boundaries and the intentionally lenient heredoc wrapper; normalizes Rust `lines()` CRLF/trailing-newline behavior before handing text to the grammar engine |
| `streaming-parser.ts` | the actual V4A grammar state machine: begin/end markers, optional environment id, add/delete/update/move hunks, change-context/chunk construction, line-numbered parse failures |
| `hunk.ts` | immutable semantic hunk/chunk shapes and marker constants; path spelling is preserved for summaries while source resolution is a separate operation |
| `seek-sequence.ts` | ordered context search: exact → trailing-whitespace-insensitive → trim-insensitive → limited Unicode punctuation/space normalization; EOF hunks prefer the actual file end |
| `file-update.ts` | turns ordered chunks into non-overlapping replacements, including repeated updates to one file; replacements apply from the end so earlier edits cannot shift later indices |
| `text-file.ts` | line-ending-preserving source representation: untouched lines keep their exact CR/LF/CRLF, inserted lines use the file's first/preferred ending |
| `mode.ts` | explicit reconstruction policy (`normalize_to_lf` vs `preserve_line_endings`); upstream-compatible default is still normalization unless the caller opts into preservation |
| `errors.ts` | typed parse/I/O/replacement/path/implicit-invocation failures whose model-visible strings intentionally match upstream Codex behavior |

The fuzzy seek ladder is **matching policy, not authorization**. Paths are still sandboxed before
mutation, and a successful fuzzy content match never relaxes filesystem ownership or capability
checks.

**`read`.** Deliberately four layers: `tools-core.ts` owns the model contract and
multi-path behavior; `read-backend.ts` owns decoding/listing semantics; `filesystem.ts` is
primitives only; `sandbox.ts` is policy. **Do not push authorization down into
`filesystem.ts` and assume the public tool became safe.**

**`view_image`.** 8 MiB transport ceiling. PNG gets a real decode check; JPEG/GIF/WebP
validation has documented limits and does not yet match upstream's full-decoder guarantee.
Synchronous validation of an adversarial compressed payload is a main-process resource
risk. An invalid `image` content block can break an entire model turn — **prefer rejection
over optimistic decoding.**

**Tests.** `codex-runtime-parity`, `codex-apply-patch-parity`,
`codex-apply-patch-invocation-parity`, `codex-view-image-parity`, `mcp`.

## 11. Identity — the spine of the whole project

An MCP payload contains **no trustworthy ChatGPT conversation id**. There is exactly one
accepted proof chain:

```text
HTTP x-request-id                       (inbound.ts, normalized before '/')
  ≡ page message.metadata.request_id
  → fiber.js      emits allowlisted request evidence from the MAIN world
  → content.js    reports requestId + conversationId
  → background.js journals it durably
  → bridge.ts     accepts it for that conversation
  → correlation.ts  proves requestId → conversationId
  → consumed by: kernel · recorder · agents · workspace · terminal ownership
```

**Never substitute** active tab, timing, tool name, most-recent chat, only-generating chat,
worker payload, or arrival order. If proof is missing the safe state is **Unattributed**,
no workspace, or refusal for identity-sensitive work. Guessing is worse than losing
attribution: it routes commands, files, messages and history into the *wrong* chat.

This one chain explains symptoms that look unrelated — worker `WORKER_IDENTITY_LOST`, calls
piling into Unattributed, false worker stalls, wrong or absent project cwd, terminal
polling crossing chats, agent messages stopping, Overwrite having no local activity to
render. When several appear together, **debug the chain, not the symptoms**, in this order:

```text
server.ts/inbound.ts  did x-request-id arrive and normalize?
fiber.js              did the page model expose a matching metadata.request_id?
content.js            did refreshFiber receive it and emit tool_evidence?
background.js         was it journalled and delivered?
bridge.ts             was it accepted for the intended conversation?
correlation.ts        was requestId→conversationId stored, and restored after restart?
kernel.ts/recorder.ts did the call wait for, find and use the exact proof?
```

Agent routing is *downstream* of this. Do not start there.

`correlation.ts` is stricter than a cache and more bounded than a permanent database:

- the first exact proof for a request id wins; a later conversation claiming that id is refused
  without modifying or waking the original owner;
- the stored `sessionId` is the **local session epoch at first proof**, not merely the current
  conversation. A stale old page cannot drag an in-flight request into a newer local session epoch
  after Compact & Resume;
- proven owners have **no time TTL** and are reconciled from already-recorded request-id tool calls
  on startup, but the in-memory/durable registry is bounded to the **50,000 most recently observed
  request ids**. Do not describe it as literally unbounded/permanent storage;
- the durable snapshot is a fast index, not stronger than session history. Because its writes are
  debounced independently from attributed JSONL, startup reconciles recorded proof even when a
  non-empty snapshot already exists.

**Tests.** `correlation.test.ts`, `mcp-inbound.test.ts`, `fiber.test.ts`,
`content-script.test.ts`, `swarm.test.ts`.

## 12. Session recording — `recorder.ts`, `store.ts`

Two independent producers, one durable timeline, neither replaceable by the other:

1. **MCP/app truth** — exact tool, arguments, result, outcome, file changes, duration, assets.
2. **Browser observation** — authored messages, turn lifecycle, native progress, visible
   errors, conversation identity, page request evidence.

The app knows *what the tool did*. The browser knows *which conversation and turn showed it*.

```text
userData/sessions/<id>/
  events.jsonl        append-oriented tool/turn/error/activity events
  messages/*.json     canonical user/assistant messages, one shard per logical id
  messages.json       legacy canonical map, read during lazy migration
  meta.json           atomically rewritten projection
  assets/<id>         screenshots and large/binary material
  handoffs/<id>.json  saved compaction briefs
```

**Must hold.** Streaming website messages are mutable snapshots of one logical message, so
Canonical message shards **replace by stable identity** — never turn that back into blind appends.
Structured activity stays append-oriented. Large values bound inline and spill to assets;
never fix a display-size problem by discarding the durable source. Durable state is the
authority across restart, and `meta.json` must never claim events that `events.jsonl` does
not contain. Unattributed is a **first-class state**, not a bug to paper over.

Distinct from `logger.ts`, which is small, redacted, RAM-only and operational.

### The store has three write models, because the data has three different semantics

`store.ts` is not “JSON files on disk” in the abstract. It deliberately uses a different commit
mechanism for evidence, mutable website messages and derived metadata:

1. **Structured evidence — serialized append.** Each open session has one operation queue.
   Sequence assignment, complete JSONL append and in-memory projection update happen in that
   order on the queue; memory does not advance before the line exists. A crash-torn final line is
   detected/sealed before a later append so two JSON objects can never be concatenated into one
   apparently valid record. `events.jsonl` is therefore the history authority for structured
   activity, not `meta.json`.
2. **Canonical ChatGPT messages — atomic replacement by stable website identity.** Streaming and
   final revisions use one shard under `messages/`; the shard is temp→rename and a terminal final
   revision cannot later regress to streaming. Legacy append-only message snapshots remain readable
   but are suppressed when a canonical shard for that identity exists. Lazy migration overlays new
   shards on the old `messages.json` map rather than rewriting all history up front.
3. **`meta.json` — rebuildable projection.** Ordinary event ticks mark metadata dirty and coalesce
   rewrites; ownership/transaction boundaries that need a durable decision write it immediately.
   A validated `meta.backup.json` protects the last good checkpoint. On load, if metadata lags or is
   unusable, the store rebuilds history-derived counts/tokens/turn state from the journal + canonical
   messages while preserving metadata-only facts it can still trust. It refuses to turn an
   unrecoverable session into an invented empty one.

That distinction also explains why **per-session serialization** is enough for many reads/writes:
`flushSession(id)` joins only that session's queue rather than flushing every open session. A poll
of one chat must not force metadata rewrites for dozens of unrelated generating chats.

Large data has bounds at every representation. Inline tool args/results are 8k chars; ordinary
assistant-message inline text is 12k, user messages may be much larger, and overflow text can spill
to a content-addressed asset up to the explicit overflow ceiling. Individual session assets are
limited to 8 MiB, with 192 MiB per-session and 2 GiB global asset quotas. Recent/tail readers have
their own row/byte ceilings. **A bound is part of the mechanism that owns that representation** —
raising a UI budget is not permission to remove the durable-store or transport bound underneath it.

### Attribution has one wait, then a first-class Unattributed landing

For a tool call whose request-id owner is not yet in the registry, `recorder.ts` waits the current
**20-second `REQUEST_ID_GRACE_MS`** for the browser's exact evidence. It does not delay every later
write behind one global timer: calls start their attribution waits independently, but each call
synchronously reserves its eventual position on `recordChain`, so invocation order is preserved
when the waits resolve at different times. Already-proven calls skip the wait but not the ordered
write/quit-flush discipline.

If the exact proof still has not arrived, the call lands in the Unattributed session. That is a
durable truthful state, not a final guess. A later exact proof queues deterministic repair:

```text
scan bounded Unattributed source snapshot
 → group only calls whose own requestId now has exact proof
 → copy referenced assets first
 → append the same callId/evidence into the proved destination session epoch
 → rewrite only the scanned source prefix, preserving concurrent later appends
```

Mixed buckets are split call-by-call; timing, tool name, current tab and "only chat generating"
never participate. When correlation names an older `sessionId`, recorder searches that exact
conversation lineage historically and **refuses to downgrade into a newer owner** just because it
is easier to find.

Browser observations serialize **per conversation**, not globally. Closing a browser conversation
also does not invent a turn ending: if durable metadata says a turn is still open, closure drops
the live page mapping and leaves turn recovery to the mechanism that can actually prove its
outcome. Reload recovery may synthesize a missing `turn_end` only against that durable open-turn
ledger, never merely because a content document disappeared.

**Tests.** `session.test.ts`, `chronology.test.ts`, `resume.test.ts`.

### The model-facing `session` tool is a projection, not the store

`mcp/session-tool.ts` intentionally accepts an explicit `session_id`; it does **not** infer the
caller's current chat. Cross-chat recovery and observing a concurrently running worker are core
uses. The cursor is part of the data model:

- an initial read pins the maximum sequence observed as a snapshot;
- `older` and timeline continuation cursors keep that snapshot fixed, so later appends cannot
  reshuffle pages the model is already consuming;
- an `update_cursor` advances from `after` and carries up to four unfinished assistant
  `{id, chars, hash}` checkpoints. If the same message only grows, the next page returns the
  suffix; if its prefix changed, it says **ASSISTANT REPLACED** so the caller knows to discard
  the unfinished version it already read;
- `T…` tool-detail cursors pin sequence, offset and hash, so a changed detail fails as stale
  instead of splicing two different versions together;
- calls to `session` are still recorded for audit, but the session tool hides those self-reads
  from its own projection/search. Otherwise polling an update cursor would create an endless
  transcript of previous polls.

Result budgets reserve footer/cursor room **before** exact recorded text is appended. The final
bound check throws rather than cutting a cursor or silently shortening a user/assistant message.

**Retention is independent of recording admission.** `session/retention.ts` runs one prune at
startup and then a coarse six-hour sweep using the current `retainDays`. Turning recording off
does not exempt history already on disk from its retention policy.

## 13. The Chrome extension — `extension/*`

Three execution contexts with **three different lifetimes**:

| File | World / lifetime | Owns |
| --- | --- | --- |
| `chatgpt-dom.js` | isolated, document | every selector and DOM-shape assumption |
| `content.js` | isolated, document | observation, turn lifecycle, Overwrite, compact UI |
| `fiber.js` | **MAIN**, document | React/Fiber evidence the DOM does not reveal |
| `background.js` | MV3 worker, **suspends freely** | bridge token, journal, tab↔conversation registry |

Plus `chrome.storage.session` — survives worker sleep, dies with the browser session — and
tab↔conversation binding, which follows tab lifetime and explicit navigation.

The service worker has several intentionally different durability classes; do not collapse them
into one "extension storage" bucket:

- **`storage.local`:** pairing port/token + explicit disconnect intent, `deferredRevivals`, and
  restart-surviving command-ACK recovery material. These are facts that may still matter after the
  whole browser restarts.
- **`storage.session`:** observation journal, close outbox, live tab/conversation/document state,
  and the command-ACK outbox used for MV3 worker suspension. These belong to the current browser
  session but must outlive a sleeping service worker.
- **content-script memory:** one document only — epoch, observers, seen identities, paint state,
  command attempt state. Reload destroys it by design.

`background.js::load()` is itself serialized by one `loading` promise. Cold-start races are normal
for MV3: two tabs must never independently restore an old storage snapshot and let the later load
overwrite an event the first caller already acknowledged.

The observation journal is **bounded but loss-accounting**, not infinitely durable. Current caps are
4,000 rows and roughly 4 MiB inside the extension's `storage.session` budget. Under pressure the
service worker first discards replaceable/nonessential progress, and if it must drop stronger
evidence it inserts an explicit same-route gap record. If Chrome refuses the journal write even
after compaction, the caller gets `durable:false` and a durability-gap `chat_error` is retained as
far as storage allows. Likewise, a batch leaves the journal only after the app returns success; an
irreducible malformed/oversize client batch becomes explicit gap evidence instead of a silent
splice in history. "Accepted by the extension" therefore means **either the observation or an
honest record of the gap remains under extension custody** — not that storage has infinite room.

Irreversible command ACKs outrank ordinary transcript draining for the same conversation. While a
send ACK is waiting in `commandAckOutbox`, `nextJournalBatch` will not let later observations from
that route overtake it. Otherwise the app could record the post-send assistant turn before it knew
the worker/resume user message had actually crossed its semantic boundary.

**`chatgpt-dom.js`** groups logical turns, extracts authored text, finds buttons/errors/tool
rows, and strips CLF-owned surfaces before reading so rendered replacements do not feed back
into recording. When ChatGPT changes markup, fix it here. **Never scatter emergency
selectors into `content.js`.**

**`content.js`** owns per-document memory: conversation epoch, seen-message identities, live
turn state, Fiber cache, rendered replacement state, pre-service-worker queue.

**A turn opens from authored-user evidence, not from the Stop button.** A newly observed stable
ChatGPT **user** message opens one local generation and emits `turn_start`. On reload the content
script may adopt the durable `activeTurnId` the app already knows, but must not emit a second
start. Stop-button presence is downstream liveness evidence only: hydration/flicker/phase changes
must never manufacture a user turn.

Turn closing is deliberately asymmetric:

- manual Stop is `stopped` and is never upgraded into success;
- a visible error/interruption/stall keeps its exact non-success outcome;
- when Fiber is healthy, the current response's model-backed terminal/end-turn evidence is the
  strongest completion authority;
- Stop disappearing merely opens a settle window. If Stop returns, text/native activity changes,
  unanswered connector work remains, or the terminal message does not belong to this exact turn,
  completion is withdrawn;
- a genuinely newer authored user message is a hard boundary for the previous turn, while page
  unload/`closeConversation` alone never invents its outcome.

This is the conceptual reason **partial vs final** bugs are identity bugs. Commentary/progress,
native tool rails and final assistant answer are different semantic objects even when the DOM
renders them close together. Stable message/turn identity comes from ChatGPT's model/Fiber evidence
where available; DOM shape is presentation/action fallback, not permission to merge those roles.

**`fiber.js` is intentionally least trusted.** It emits a strict **allowlist** (not copied
props minus a denylist), never tool argument values, validates the exact CLF connector
names, and fails closed on unfamiliar React shapes. Its `postMessage` output is
page-controlled evidence useful for joining page to local truth — **never a credential**.
Its protocol version and the content-side expectations move together.

The service worker's document model is also **current implementation, not an aspirational one**.
Today `background.js` still carries separate `tabDocuments`, `tabEpochs`, bounded
`retiredDocuments` and speculative `terminalDocuments`; `authorizeDocument()` can adopt a new
non-retired document and terminal prediction can later be proven wrong by Chrome tab state. Do not
document or implement against a hypothetical collapsed owner record until the code/tests actually
move together. Irreversible browser actions always re-check the current `sender.documentId`/epoch;
body-supplied document identity is never authority.

**Must hold.** ChatGPT is an SPA: every async result proves it still belongs to its
navigation epoch before mutating state. `pagehide` is **not** proof a conversation ended —
reload and bfcache fire it too; real closure is decided at the service-worker layer from tab
removal and navigation away. **Reload is not conversation close.** Content-script acceptance
means *handed to the journal*, not *stored by the app*, and the journal must never silently
lose something it already acknowledged as durable. Recovery must validate **every** context
whose health it needs — proving the isolated recorder is alive says nothing about a dead
MAIN-world Fiber helper. Recorder takeover is total ownership transfer: the predecessor must
disconnect MutationObservers and DOM/window handlers **and** unregister extension-level
`chrome.runtime.onMessage` / `chrome.storage.onChanged` listeners. An `alive=false` predecessor
must never answer a health check, compete for a worker-revival command, or repaint Overwrite
after the successor owns the document.

**Tests.** `content-script.test.ts`, `fiber.test.ts`, `extension.test.ts`.

## 14. The browser bridge — `bridge.ts`

A second loopback HTTP service on the first free port of **8765–8769**. The extension finds
it with `/hello`, silently provisions a bearer token with `/pair`, then uses authenticated
routes: `/status`, `/events`, `/closed`, `/activity`, `/compact`,
`/goal/draft`, `/goal/ack`, `/goal/objective`, `/goal/open`, `/settings` (GET and POST),
`/commands/redeem`, `/commands/ack`. `/settings` is the one deliberately tiny config-write
surface available to the page: its POST allowlists only `compaction.auto` and `goal.enabled`,
neither of which grants filesystem/process/Desktop reach; its GET exists for the one composer
with no conversation to read `/activity` for: a New Chat.

**Must hold.** The token never enters the ChatGPT page — the service worker holds it in
extension-owned state and the app keeps its counterpart out of config and log surfaces. The
bridge exposes **no** filesystem, command, permission-widening or arbitrary-config route. Do not
turn `/settings` into a generic config escape hatch merely because two non-capability toggles are
already there. Protocol mismatch
against `BRIDGE_PROTOCOL` warns once rather than spamming. Concurrent startup must not race
on listener ownership.

Because this is where browser-observed lifecycle meets recorder, agents, continuation and
workspace state, a `bridge.ts` bug presents as a session, extension, or agent bug depending
on which end you inspect.

An open turn also grants its **conversation** a two-minute silence deadline. Durable assistant
text/native activity/errors and attributed MCP calls move it; `turn_end` removes it. Expiry queues
one receipt-tracked browser reload for an ordinary chat, Prime or Worker alike. If the reload
produces no new durable evidence, the grant is forgotten rather than reloaded again; a Worker also
releases its slot. Separately, one minute of Unattributed calls still reloads every otherwise-active
chat whose exact request-id join did not prove itself. Agent role is never an eligibility gate.

**Tests.** `bridge.test.ts`, `extension.test.ts`.

### Browser commands: intent → durable lease → page → durable receipt

Do not describe worker/resume delivery as "open a URL and type"; the URL is only how a page gets
near the command. The authority path is:

```text
broker / continuation accepts semantic intent
  → bridge.ts persists CommandSpec in bridge-commands
  → fresh worker/resume: app opens preferred Chrome/Chromium (browser.ts), URL carries only marker
    exact-chat revive: extension service worker elects/reuses/opens the bound worker chat instead
  → submit-ready content document asks service worker to redeem marker
  → POST /commands/redeem atomically establishes queued→leased owner
  → bridge returns exact text + target fence for that still-live command
  → content verifies fresh-vs-exact-chat precondition, types and waits for ChatGPT acceptance
  → page ACK is first accepted into background.js commandAckOutbox
  → service worker retries POST /commands/ack until app accepts it
  → worker/resume terminal ACK: bridge records receipt + retires command
    revive `sent`: command stays leased until exact worker liveness or revival deadline settles it
```

There are exactly three semantic `CommandSpec` variants: `worker` (fresh chat), `resume` (fresh
chat tied to one continuation token/session), and `revive` (the already-bound exact worker
conversation + run incarnation + unique wake identity). The deadlines differ because the semantic
risks differ:

- **Fresh worker before any page owns it:** discovery may make one safe re-delivery after **60s**;
  nothing irreversible happened. But the worker invitation has an absolute **120s bootstrap
  lifetime from creation**, so a late handout cannot keep a slot forever.
- **Fresh worker after redeem:** the page-owned attempt is one-shot. Its lease is bounded by the
  smaller of **90s from claim** and the remaining absolute worker-bootstrap lifetime. A page-reported
  bootstrap failure is terminal rather than a prompt to open another worker chat.
- **Resume:** the same claimant may redeem idempotently, and another document may take over only
  while the durable destination send checkpoint still proves **pre-dispatch**. Once dispatch is
  ambiguous/possible, no second click is authorized. Its outer authority is the continuation's
  existing **10-minute TTL**, not an invitation clock.
- **Revive:** browser send/ACK is one wake attempt and the broker's `waking` reservation is capped at
  **30s**. A `sent` ACK does not renew that deadline; exact worker liveness must still arrive.
- **Restored stale transport rows:** the broad command TTL bounds forgotten control records, but it
  never extends a semantic worker/continuation/revival lifetime.

`/commands/redeem` is the arbitration cut. The page owner/lease means duplicate tab, reload or
reopen cannot make a second document type the same payload, except for the explicitly replay-safe
resume takeover while the continuation still proves no dispatch. After an irreversible browser result,
the service-worker ACK outbox is custody: the page may disappear and the app still eventually
learns the outcome. App receipts make a repeated ACK idempotent across app restart.

Revive redeem has one deliberate **ordered cross-file** exception to the generic “lease is atomic”
shorthand above: broker wake custody is persisted first (`claimWorkerRevival` + critical swarm
snapshot), then the exact bridge command page-owner lease is persisted, and only after **both**
succeed may the text escape. A crash between those writes therefore leaves a durable `waking`
broker claim but no delivered payload; the same page can retry the lease safely. Never reverse that
order — a page-owned text lease with no durable worker-slot/wake claim would make browser side
effects outrun broker authority.

`browser.ts` prefers installed Chrome channels/Chromium because orchestration markers are useful
only in a browser that can host the extension. It tries the next compatible executable if launch
of an earlier candidate fails; `index.ts` uses the system default only as a last-resort warning
path, not as proof the command can be redeemed.

## 15. Compact & Resume — `session/continuation.ts`

**The local session id is the durable identity.** ChatGPT conversations A and B are
frontends attached to that one session in sequence.

```text
chat A owns session S
  → open continuation token for S
  → claim source prompt (nothing typed) → arm the click → A sends [[CLF-HANDOFF:token]]
  → bind ChatGPT's stable user id → exact terminal assistant id supplies the brief
  → store brief verbatim; open one marked fresh chat
  → claim bootstrap (nothing typed) → arm the click → B sends [[CLF-RESUME:token]]
  → bind B + ChatGPT's stable user id before ordinary page journaling
  → preflight   freeze prime/swarm transfers that must move atomically
  → DURABLE OWNERSHIP COMMIT   rebind S from A to B on disk   ← semantic point of no return
  → publish/complete     recorder mapping, workspace/Goal/swarm projections + WAL completion
  → B continues session S
```

**Must hold.** If preflight or the durable session rebind fails, **A keeps the session**. Once
session metadata durably says B owns S, the semantic move has happened even if the process crashes
before projection publication or the final continuation-WAL completion write. Recovery then repairs
the recorder/workspace/Goal/swarm projections and marks the transaction committed; it does **not**
roll session ownership back to A or reinterpret post-rebind cleanup failure as a failed move. Never implement
compaction by creating a second session or copying history — the whole feature is continuity
of one durable id. Automatic compaction is a live level plus page-turn decision: an idle old
chat never fires merely because it sits above the threshold, a transient pre-send barrier
failure may retry on a later turn, and the continuation transaction is the sole durable
authority once either prompt crosses its semantic send boundary. Browser documents,
`sessionStorage`, local generation ids and command leases are never semantic ownership.

The continuation itself has a six-state durable state machine:

| State | Durable meaning | Safe next decisions |
| --- | --- | --- |
| `awaiting-summary` | source chat owns S; handoff turn is in progress / its exact terminal answer has not yet become a stored brief | source send may still be claimed according to its send checkpoint; no destination may commit |
| `awaiting-chat` | brief file + continuation state say this exact handoff is published/claimable; S still belongs to A | open/claim one replacement chat; source remains authoritative |
| `claimed` | one replacement claimant durably owns the brief/opening attempt | same claimant may retry idempotently; a second claimant is refused |
| `committing` | preflight succeeded and durable session rebind may be in flight | **do not sweep/abort on a timer**; reconcile from session metadata because either side of the write may have landed |
| `committed` | session metadata says B owns S and projections have been/will be repaired | idempotent recovery/publication only |
| `aborted` | transaction will not move S | A keeps ownership; no browser/document state may resurrect it |

`transitionNow()` embodies the WAL rule: the proposed semantic state is written immediately
**before** it becomes the live published state. If that write fails, continuation code queues the
old authoritative snapshot again so `durable.ts` cannot later retry the rejected generation and
make an operation the caller saw fail reappear after restart.

Each prompt has **two** durable writes around its click, because a document can die on either
side of it and the two sides have opposite answers. `attempted-unresolved` is written before the
composer is submitted at all, so it *proves* nothing reached ChatGPT: a reload, tab close,
browser restart or app restart replays it, and it is equally the state a second live document
may claim. `dispatched-unresolved` is written immediately before the click, so it proves
nothing — `CLF_DOM.send()` clicks first and watches for acceptance seconds later, and neither
the page nor the app can tell a click that never happened from one whose request outlived its
document. That state is never replayed by anything: it ends at ChatGPT's own marked message, or
at an explicit cancel, or at the transaction's TTL. A surfaced ambiguity is the correct outcome
there; a second Send is not. Exactly one caller can move `attempted-unresolved ->
dispatched-unresolved`, which is what makes the click at-most-once without any clock, tab
identity or claim token. Manual and automatic compaction call this exact same path.

Handoff capture has another publication boundary. `handoff.ts::prepareHandoff()` writes the brief
file first; that file alone is **not** a published continuation. The continuation WAL transition is
the semantic acceptance, and only after it lands is the session `handoff` event published. If the
process dies in the tiny opposite window, restart repairs the presentation event. This avoids
`lastHandoffId` advertising a brief belonging to a rejected transaction.

The safety floor is deliberately much lower than the prompt's quality target: any brief under 200
characters is refused, and a session of at least 20k estimated tokens requires at least 1,000
characters. Those are "cannot possibly be a usable whole handoff" guards; the 10k–30k-token prompt
target is guidance to ChatGPT, not a validator. `resumeBootstrapMatches()` canonicalizes only the
known NBSP/mojibake + line-ending presentation artifacts before provenance comparison — arbitrary
Unicode/whitespace normalization would turn provenance into fuzzy matching.

**Restore decides from durable ownership, never from the remembered phase.** For a restored
`committing` continuation, if session metadata already points to B, the durable move landed and
recovery repairs provenance/recorder/workspace/Goal/swarm projection. If it still points to A,
recovery may perform/retry the authorized move. If a third conversation owns the session, recovery
aborts rather than stealing it. Open/claimed continuations retain their original ten-minute
lifetime across restart; restart does not grant a fresh TTL.

`resume-gate.ts` is deliberately tiny and temporary. It is armed **before** opening B and again
when a claimed continuation is restored, for at most 60 seconds, so recorder events already sitting
in the extension journal cannot win the race by inventing a brand-new local session for B. The
gate is suppression of a known race, never ownership: the continuation/session metadata remain the
authority, and expiry favors visible recoverable shadow state over blocking unrelated recording
forever.

**Tests.** `continuation.test.ts`, `resume.test.ts`.

## 16. Multi-agent — `agents.ts`

Experimental, enabled on fresh installs while existing configs preserve their stored choice,
**one global active execution run at a time**, star topology:
`worker ← prime → worker`. Workers never message each other.

**Identity.** The prime is the conversation that successfully called `agents action=spawn`
with proven caller identity. Worker slots are opened by the app through browser bootstrap;
once the page has a real conversation id the extension reports it and the broker binds that
exact conversation before normal worker work proceeds. **Conversation identity is the
routing credential** — established from the same evidence as recorder attribution — so no
secret token rides in model arguments and **sender identity never comes from a model
argument**. There is no credential and no recovery action: a worker whose binding was lost
is rebound by the extension reporting its chat, never by something a model can present.

**Messaging is at-least-once until acknowledged**: queued durably → offered on a tool result
→ acknowledged by the next authenticated tool call. Offering on a result is **not** proof
the model received it. Never delete a message merely because it was offered.

**The broker state machine is semantic, not cosmetic.** `AgentState` currently has seven values:

| State | Meaning | Slot? | How it leaves |
| --- | --- | --- | --- |
| `invited` | worker row accepted/durable; fresh worker bootstrap has not yet bound a real ChatGPT conversation | yes | extension binds exact conversation → `active`; bootstrap failure → `failed` |
| `active` | worker conversation is bound and may be running/receiving MCP work | yes | browser view disappears → `detached`; natural/explicit stop → `sleeping` or ceiling-driven `finished`; hard failure → `failed` |
| `detached` | browser view is gone but the server-side ChatGPT turn may still be alive | yes | exact call/page evidence → `active`; durable quiescence after detach → `sleeping`/`finished` |
| `waking` | prime message to a sleeper crossed broker durability and reserved a slot; browser revival is in flight | yes | exact worker liveness → `active`; 30s revival failure/timeout → `sleeping` |
| `sleeping` | worker stopped normally, exact conversation/history retained, revivable below ceiling | **no** | prime message reserves a slot → `waking`; late exact new-turn evidence may reactivate |
| `finished` | terminal context-ceiling retirement | no | never |
| `failed` | terminal failure/fence | no | never as ordinary reuse; recovery code may canonicalize only from positive authority |

`occupiesSlot()` is the single slot rule: `invited|active|detached|waking`. Do not equate "tab is
open" with active, or "tab is closed" with sleeping. A ChatGPT turn executes remotely and can keep
issuing correlated MCP calls after its page disappeared.

**Broker durability precedes browser side effects.** Spawn, message-to-sleeper and finish use
staged unpublished state and an immediate critical swarm snapshot before the browser is asked to
open/type or before a report is published. If that durable write fails, the semantic mutation is
rolled back and a newer safe snapshot supersedes the rejected generation; `durable.ts` must never
later resurrect an operation the caller was told failed.

**Normal successful worker stops sleep instead of ending the worker.** `finish` normally reports a
result and puts a below-ceiling worker to *sleep*: it keeps its conversation, history and reusable
identity. Sleeping frees its worker slot, so `maxWorkers` counts **slot-occupying** workers
(`invited|active|detached|waking`), not every historical worker and not merely those visibly
"working" — a prime can create a new worker
while an older one sleeps and still wake that older worker afterwards. The same sleep happens without the tool call, from
durable evidence that the worker stopped, but never on the first quiet sample: the bridge's
attached/observable quiescence path waits `STALE_SWARM_MS` (**2 minutes**) before sleeping it.
A detached worker has its own longer `DETACHED_SILENCE_MS` (**4 minutes**) measured from the newest
of detach time, exact last-seen evidence and the process's liveness floor. App restart resets that
floor to "now", so an old persisted timestamp cannot instantly retire a worker before this process
has had a chance to re-observe it. Hard bootstrap/transport/broker failure may instead make the row
terminally `failed`; sleep is the normal-success path, not a guarantee for every ending.

**Ownership outlives the active run.** When no worker occupies a slot, the active incarnation is
parked immediately and the one global execution claim is released. Its complete agent map becomes
a durable history keyed by the prime conversation: sleeping workers, terminal/non-revivable rows,
their exact ChatGPT conversation bindings, queued prime reports and monotonically allocated
`worker-N` history all remain. Another prime may now start its own active incarnation, including
its own same-named `worker-1`, without seeing or mutating the first prime's history. Caller-scoped
`status` always returns the history owned by that prime, even while somebody else owns the active
execution slot. A dormant prime may spawn a fresh worker without reviving a sleeper; waking an old
worker reactivates that owner's history only when the global execution slot is free. Explicit
swarm clear is different from parking: it retires the worker conversation fences and discards the
retained histories. Turning Multi-agent **off is not Clear**: it stops/withdraws live execution,
parks the owner history, and keeps that history durable through disabled app restarts so re-enable
can still show and revive the exact old worker conversations.

**Waking is messaging.** `agents action=message` to a sleeping worker reserves a free slot
inside the same durable barrier that queues the message, and only after that commit does the
browser get asked for anything. The bridge then creates a durable `revive` command naming the
worker's exact `conversationId`, but **the app does not elect or open the worker tab itself**.
That decision belongs to the extension service worker, because only its tab/conversation registry
can prove whether the exact worker chat is already open.

The wake path is:

```text
prime message → broker sleeping→waking + queued inbox row → immediate durable swarm barrier
  → bridge creates durable revive command
  → `/activity` exposes only the revival marker; actual prime text remains app-side
  → background.js persists/replays `deferredRevivals` and queries Chrome's current ChatGPT tabs
  → reuse the exact bound conversation if one safe tab exists
       OR create one `/c/<id>?clf=<command>#clf=<command>` fallback when no exact tab exists
       OR refuse ambiguity rather than type into a guessed duplicate
  → content waits for a submit-ready current document and recorder-flush fence
  → content redeems the bridge command, receives the exact text, types a genuine user message
  → irreversible send ACK enters service-worker custody
  → broker keeps the worker `waking` until exact authenticated worker liveness/new-turn evidence
```

No free slot means the send-to-sleeper is refused outright — no inbox row is accepted and nothing
is typed. A failed browser send or the **30-second** revival deadline puts the worker back to
`sleeping`, returns the slot and leaves the prime's row queued for a later explicit wake. A
successful browser `sent` ACK is stronger than an ordinary offer because ChatGPT accepted the user
message, but it is **not** proof the worker reacted: the revive command remains leased and the
broker remains `waking` until exact worker activity resolves that second boundary.

Once `/commands/redeem` gives the browser custody of a wake, a late call from the worker is no
longer allowed to reinterpret that exact wake as unnecessary. Conversely, before redeem, exact
worker liveness may prove the old turn never stopped and cancel the inferred sleep. **Positive
identity/liveness outranks inferred lifecycle.** A mere open sleeping page is not enough; an exact
authenticated call or a genuinely newer turn is.

**The context ceiling is what makes an otherwise normal stop permanently `finished`.** A worker becomes terminally `finished` when its chat
reaches `WORKER_CONTEXT_CEILING_TOKENS` (400k), measured from the app's own durable session
summary — never from a model-carried counter. Crossing it does **not** interrupt work in
flight; it makes the *next* stop permanent. Workers **never Compact & Resume themselves**,
automatically or manually: the worker conversation is the agent identity, so no threshold may
open a replacement worker chat. Because workers outlive their tabs and their
prime's tab, closing the prime chat pauses the run instead of ending it: the user comes back,
the prime resumes, and the same workers are still there.

This does not make `finished` the only terminal state: `failed` is the separate hard-failure fence
for a bootstrap/transport/broker failure that cannot safely remain revivable. Both are terminal to
ordinary model routing; only their reason differs.

**Finish and cleanup.** `finish` is idempotent; final worker output routes to the exact prime
conversation even if parking happens on that same finish. Once no worker holds a slot, the active
incarnation releases immediately; pending reports remain in the dormant prime's inbox and retain
the same at-least-once offer/ack semantics. Dormant worker conversations remain authority fences,
including terminal rows, so stale tabs cannot fall through as ordinary unidentified chats while a
different prime is active. Orphan cleanup uses durable quiescence plus the wider in-flight
MCP/observation counters — not a heartbeat guess. Compact & Resume moves active **or dormant**
prime ownership together with session/workspace state; normal commit and recovery repair transfer
the same complete worker history to the child conversation or move nothing.

**Tests.** `agents.test.ts`, `swarm.test.ts`; the revival's browser half is in
`bridge.test.ts`, `extension.test.ts` and `content-script.test.ts`.

## 17. Renderer, IPC, connection and desktop

**Goal.** `goal.ts` sends only authored user messages and final assistant answers to
OpenRouter. **Two** persisted prompts are editable under Chat → Settings, both bounded by the
same shared limit at config and IPC: `goal.prompt` is the gate used by a chat with no goal of
its own, and `goal.objectivePrompt` is the driver used instead once a chat carries one. The
driver was a source constant until it became editable; nothing else about which one applies
changed. Both are written as meta-prompter instructions rather than as review policies — the
model is told it sits in the user's seat, given the two moves it has (next user message, or
exactly `NO_REPLY`), and taught by five worked examples each, at least one of which ends in
silence. The failure they are written against is a small model that reviews the conversation
or invents work nobody requested, because either one lands in a real composer.
An untouched persisted copy of **any** previously shipped default migrates to the current
prompt — `SUPERSEDED_GOAL_SYSTEM_PROMPTS` is walked, so an install that skipped a release is
not stranded — while customized prompts are preserved exactly. A change to either prompt
retires existing drafts so one draft never mixes old and new instructions. Terminal Goal cards persist for
visibility but their × dismissal is keyed to the finished turn, so activity repaints cannot
resurrect the card and the next Goal run still appears normally. They are presentation scoped
to the exact conversation route: New Chat, a concrete chat switch, or the user's next authored
message removes the old card immediately while async activity remains navigation-epoch guarded.
The provider boundary is non-streaming strict JSON Schema with `require_parameters`, excluded
reasoning and OpenRouter Response Healing. A fixed app-owned output protocol sits after the
editable policy prompt, and an app-owned **trailer** sits after the transcript — a long chat
pushes the instruction out of effective attention, so the closing reminder restates the two
moves where the model read last. Placement is app-owned; the policy it restates is not. Local validation is still authoritative: mixed/wrapped `NO_REPLY` stops,
tokenizer wrappers are normalized away, and malformed schema, reasoning tags, or an empty cleaned
reply fail closed before `humanReply()` or the browser can see a sendable payload.

**A chat's own goal.** The same engine, pointed the other way. The composer control is now
present in a New Chat as well (`injectControl`), because a goal written there is what writes
that chat's first message; compaction stays unavailable there and says why. `/goal/objective` stores one goal
per conversation in durable Goal state, separate from global config. Reopening the same chat
restores that text but does not itself manufacture a new Goal draft from an old finished turn. A
stored goal arms the loop for that chat even while the
standing switch is off (`goalActiveFor` in `bridge.ts`), because writing down a finish line is
the stronger statement; the worker rule still overrides both, and `/goal/objective` refuses a
worker chat outright rather than storing a goal nothing may act on. With a goal the standing
continuation policy is replaced, not augmented — the explicit finish line is the sole driver —
and the empty-conversation refusal inverts: `no_conversation`
becomes an opening message, since the goal *is* the request. A model decision that the goal is
reached stops that run but deliberately keeps the objective until the user clears/replaces it.
Compact & Resume projects the objective A→B in the same continuation transaction, including the
recovery repair path, so overnight resumptions keep the same finish line. `/goal/open` is the one goal
message not keyed by conversation: a New Chat has no id until the message is sent, so that route
holds nothing, streams nothing and is awaited by the page, which then binds the goal to the real
id once ChatGPT issues one.

**Turn outcomes the loop answers.** The current page contract is deliberately narrower:
`GOAL_CONTINUABLE = {'completed'}`. `stopped` is the user's own decision; `interrupted`, `failed`,
`stalled` and `unknown` are recovery/turn-integrity states with no trusted final answer to feed the
meta-prompter. Do not widen this set because partial prose looks useful — a Goal message typed into
or after an unfinished response becomes a real user correction. If product policy later chooses to
continue an interrupted answer, that requires a new explicit terminal-answer proof and regression
on both `content.js` and the recorder/Goal durable obligation, not just adding a string to the set.

The page then applies an **eight-second four-signal settle** before it asks the app: final answer
text stable, native/tool activity stable, ChatGPT generating control absent, and app-reported
`runningToolCalls()` zero. The five-minute watch ceiling gives up visibly rather than converting
ambiguity into a send. Retryable OpenRouter failures wait 15 seconds **outside** the Goal busy lock;
holding the lock while sleeping would make a different turn that ends during the wait miss its
only trigger edge.

Goal has two durable ledgers and one memory draft:

- `goal-objectives`: per-chat objective text. Restore shows it; restore never starts a draft.
- `goal-replies`: one stable assistant reply obligation per conversation, `{replyId, turnId,
  eventSeq, acceptedAt, pending|handled}`. The recorder persists this decision before HTTP success,
  so page reload/app restart cannot lose a terminal answer that was owed one Goal decision.
- `drafts`: current OpenRouter work, one per conversation, stage
  `sending|answering|ready|no-reply|failed`. Draft failure is not a semantic answer; retryability is
  derived from the failure, while `ready` or `no-reply` are the two actual decisions.

**Renderer/IPC.** `renderer/main.ts` is setup/permissions/connection/activity;
`renderer/chat.ts` is session timeline, handoff, swarm. To add a capability: narrow
main-process action → validate in `ipc.ts` → expose exactly that method in
`preload/index.ts` → call it. **Never add a generic `invoke(method, args)` escape hatch.**
Async loads use generation counters so a slow load for session A cannot paint over the B the
user selected, and unsolicited state pushes must not clobber a focused unsaved form field.
Captured ChatGPT HTML is untrusted: `chat.ts::renderedMessage()` allowlists semantic tags,
strips attributes, drops executable/form/embed content and non-safe link schemes.
Tests: `ipc.test.ts`, `renderer-html.test.ts`, `renderer-layout.test.ts`, `renderer-state.test.ts`.

Settings are a **multi-writer transaction**, not a blind renderer snapshot. The renderer sends
`{base, patch}` and `ipc.ts::mergeSettings()` performs a field-wise three-way merge against the
latest main-process config: a value unchanged from `base` was not edited by this form and keeps the
newer live value; only a field the renderer actually changed wins. This exists because the browser
extension can change Goal/Auto Compact while the app's settings sheet is open. A full-snapshot save
without the base would silently undo that newer browser-side choice.

The renderer separately protects **draft UI state** that is not config yet. A focused dirty input,
root-rename draft/caret, selected session and async load generation survive unsolicited whole-state
pushes/repaints. "Main process is authoritative" does not mean "throw away text the user has not
submitted." Every push path must distinguish persisted state from local draft state.

Renderer saves are serialized too. `renderer/main.ts` captures each full requested settings
snapshot from the latest **requested** state before queuing its IPC call; a slow response from save
N therefore cannot become the baseline that erases edits already captured for N+1. The renderer
queue and main-process three-way merge solve different races and both are required.

The desktop session UI has its **own** bounded read protocol; do not reuse the model-facing
`session` cursor design by assumption. `ipc.ts` session lists page by stable `(updatedAt,id)`
cursor, first detail load reads a recent tail, and incremental detail reads advance by monotonic
sequence. `renderer/chat.ts` then caps one paint to 160 rows, about 2 MiB of text and 256 KiB of
captured rendered HTML. Those are presentation/read budgets only — the durable session store may
contain much more, and the model-facing session tool independently uses snapshot/update/detail
cursors for a different consumer.

Feature-toggle side effects have an order. Turning multi-agent off first parks/preserves broker
history, cancels worker browser commands while the bridge can still reach them, and crosses an
immediate durable authority barrier; only then may the bridge be stopped if recording is off too.
The settings write still applies connection/Desktop publication changes through the serialized
connection owner. A UI save must never report "off" while the durable worker authority it was
supposed to preserve failed to land.

**Connection and tunnel.** `connection.ts` owns local MCP server → Core publication →
optional Desktop publication → UI status, across the `openai`, `cloudflared` and `manual`
transports. On OpenAI tunnels **Core and Desktop need separate tunnel ids**, because the
connector UI addresses one tunnel id as one endpoint; on whole-origin transports both
tokenized paths share the origin. Lifecycle operations are serialized and generation ids
invalidate callbacks from replaced tunnels — reuse that for any new async status producer.
`tunnel/index.ts` supervises the child; `tunnel/health.ts` parses its `/metrics` and
`/api/status`. **The poll metric, not a log line, is the proof of a live route**: `/readyz`
is local and stays green through an internet outage, and a single failed long poll is a
retry, not an outage — an outage is complaints that outlive a poll cycle with no completed
poll. `diagnostics.ts` builds the UI self-test and must agree with that same grace period.
Tests: `tunnel.test.ts`.

Connection startup derives prerequisites from the **live capability projection**, not from the
mere existence of a connector. A root is required only when some enabled capability actually
crosses the filesystem boundary; screen/clipboard-only Desktop access must not accidentally waive
a Core root requirement or demand one it never uses. The Core endpoint starts first and its
handler closure re-reads current config for every call, so a permission save affects enforcement
without rebuilding the HTTP listener.

The optional Desktop publication is failure-contained. A missing/mistyped second OpenAI tunnel id
may put the Desktop card in `off/error`, but it does **not** tear down a healthy Core connector.
`applySettings()` reconnects Core only when the transport-defining tuple really changed; a
Desktop-only permission/tunnel change rebuilds/publishes that surface in place. This is why
renderer settings must call the connection owner rather than mutating status cards directly.

Disconnect and final shutdown deliberately differ. An ordinary disconnect/settings reconnect has
no outer force deadline because the app keeps running and must not drop an accepted response that
ChatGPT could retry. Final `shutdownConnection()` invalidates the generation synchronously and then
allows the MCP endpoint a bounded **30-second** drain inside the app-wide shutdown budget. Stale
tunnel callbacks after that generation change are ignored even if the child process emits them
while being stopped.

**Desktop automation (Windows only).** `tools-desktop.ts` + `computer/*` for screenshots, UI
Automation and SendInput/clipboard. Registration-time permission is not enough: each action re-checks. The
helper is prewarmed only when native Desktop capabilities are published; window observation is
background-first and never focuses. Recent immutable frames bind coordinates to screenshot and
window geometry; semantic refs bind cached elements to bounded UIA snapshots. Physical input
revalidates the target, batches report partial completion and route evidence, and compact local
postconditions avoid model-driven wait/observe loops. Tests: `computer*.test.ts`.

**Secrets are one encrypted blob with serialized mutation, not three loose files.** `secrets.ts`
stores `openaiApiKey`, the extension `bridgeToken`, and `openRouterApiKey` in `secrets.bin` through
Electron's async `safeStorage`. The renderer gets only booleans/status; plaintext never crosses IPC,
config or logs. Cache miss is single-flight and every mutation is a queued read-modify-write,
because concurrent async decrypt + save can otherwise republish stale plaintext or erase another
key. The encrypted file is temp→rename and the cache updates only after durable publication.

On Linux, "Electron says encryption is available" is not enough: Chromium can fall back to its
legacy `v10` hard-coded-key provider. `secureStorageStatus()` encrypts a non-secret probe and checks
the ciphertext bytes; that insecure fallback is treated as **unavailable**, not as encrypted
credential storage. A decrypt of an unknown/malformed future blob may degrade reads to no secret,
but a mutation must not compose from an invented empty map and overwrite ciphertext it did not
understand. Unknown string fields are preserved for forward compatibility.

**Diagnostics report unknown as unknown.** `diagnostics.ts` tests the connector chain hop-by-hop:
secure storage/config → local MCP initialize/tools-list → tunnel local readiness/metrics/client
status → external-route evidence → whether ChatGPT has contacted the connector / actually called a
tool. A check can be `pass`, `fail`, `skipped` or `not-run`; do not turn missing evidence into a
green boolean. Developer Mode inference specifically compares "ChatGPT reached the connector" with
"a tool ever followed" — transport health and model tool permission are separate diagnoses.

`logger.ts` is deliberately not durable telemetry. It keeps only 500 redacted entries in RAM,
inherits current agent attribution from call AsyncLocalStorage, and exports the already-redacted
projection. If a fact is needed for restart recovery, it does not belong in this log; give it a
real durable owner instead.

**On-disk state to inspect.** Electron `userData` — `%APPDATA%\chat-on-steroids\` on Windows,
`~/Library/Application Support/chat-on-steroids/` on macOS, `${XDG_CONFIG_HOME:-~/.config}/chat-on-steroids/`
on Linux — contains `config.json` (non-secret validated settings), `sessions/` (durable history),
`state/` (small durable indexes, e.g. `request-correlations`, swarm), and the stable packaged
extension mirror used by Chrome. Credentials live through `secrets.ts`/OS safeStorage. Extension
state is separate: `chrome.storage.local` for preferences/pairing, `chrome.storage.session`
for the journal and live tab/document state. Two command-control facts intentionally join the
browser-restart lifetime in `storage.local`: `deferredRevivals` (marker only, never the prime's
text) and `commandAckOutbox` (irreversible ChatGPT send outcomes; also mirrored into session state
for the live-worker/migration path). When a restart bug appears, **first name which process
restarted** — app, service worker, content script, Fiber helper, document, tab, or browser.
Each has a different persistence boundary.

---

## 18. Symptom → open these → tests

| Symptom | Open, in order | Tests |
| --- | --- | --- |
| tool missing/extra in ChatGPT | `surfaces.ts`, `tools-core.ts`, `tools-desktop.ts`, `server.ts` | `mcp` |
| tool still visible after permission off | `server.ts` exposure cache, `kernel.ts` guard | `mcp`, `config` |
| permission / read-only mismatch | `config.ts`, `kernel.ts`, the tool wrapper | `config`, `mcp` |
| native vs virtual path disagreement | `sandbox.ts`, `kernel.ts`, `tools-core.ts` | `sandbox`, `mcp` |
| symlink/junction escape or race | `sandbox.ts`, then the real I/O call site, `rawfs.ts` | `sandbox`, bughunt repros |
| `read` wrong content/list/glob/budget | `tools-core.ts`, `read-backend.ts`, `filesystem.ts`, `fsops.ts` | `mcp`, `fsops` |
| `view_image` validation/transport | `view-image.ts`, `tools-core.ts`, `fsops.ts` | `codex-view-image-parity` |
| patch parse/match/write | `apply-patch/*`, `tools-core.ts` | both `codex-apply-patch-*` |
| shell-intercepted patch behavior | `tools-core.ts`, `apply-patch/invocation.ts` | invocation parity, `mcp` |
| exec / PTY / stdin / output / session | `unified-exec.ts`, `shell.ts`, `ownership.ts`, `exec-output.ts` | `codex-runtime-parity`, `mcp` |
| one chat touches another's terminal | `ownership.ts`, `kernel.ts`, then §11 chain | `mcp`, `workspace` |
| **calls land in Unattributed** | **§11 chain in order** — `inbound`→`fiber`→`content`→`background`→`bridge`→`correlation`→`recorder` | `correlation`, `mcp-inbound`, `fiber`, `content-script` |
| worker identity / inbox / liveness | §11 chain **first**, then `agents.ts`, stale sweep in `bridge.ts` | `agents`, `swarm` |
| wrong worker/project cwd | `workspace.ts`, `kernel.ts`, §11 chain | `workspace`, `swarm` |
| transcript duplicates / reorders / jumps | `chatgpt-dom.js`, `fiber.js`, `content.js`, `background.js`, `recorder.ts`, `chronology.ts` | `content-script`, `extension`, `session` |
| turn ends early / false stall | `content.js` lifecycle + Fiber terminal evidence | `content-script`, `fiber` |
| Overwrite vanishes / sticks / stale rows | `content.js` paint streams, `fiber.js`, `/activity` in `bridge.ts` | `content-script`, `bridge` |
| extension dies after reload/update | `background.js::restoreOpenChatgptTabs`, content↔Fiber handshake | `extension`, `fiber` |
| navigation resurrects wrong chat | `background.js` tab registry, `content.js` epoch | `extension`, `content-script` |
| bridge pairing / connect / stop | `bridge.ts`, `background.js`, `popup.*` | `bridge`, `extension` |
| Compact & Resume split or lost | `continuation.ts`, `bridge.ts`, `store.ts`, `workspace.ts`, `agents.ts` | `continuation`, `resume` |
| auto-compaction repeats or never fires | `store.ts` live level, `content.js::maybeAutoCompact`, `continuation.ts` | `content-script`, `continuation`, `resume` |
| agents spawn/message/finish | `agents.ts`, `tools-core.ts`, `bridge.ts` | `agents`, `swarm`, `bridge` |
| session UI or main process freezes | `store.ts`, `chronology.ts`, `ipc.ts` read path, `chat.ts` | `session`, retained stress probe |
| stale render / typed input clobbered | `renderer/main.ts`, `chat.ts` generation guards, `ipc.ts` push order | `ipc`, `renderer-state` |
| screenshot / input / clipboard / stale coords | `tools-desktop.ts`, `computer/*` frame-id checks | `computer` |
| connector offline / tunnel / self-test | `connection.ts`, `tunnel/*`, `diagnostics.ts`, `server.ts` | `tunnel`, `mcp` |
| renderer has too much authority | `preload/index.ts`, `ipc.ts`, `index.ts` window config | `ipc` |
| installed build missing extension/tunnel/rg/node-pty | `electron-builder.yml`, `extension-path.ts`, `scripts/*` | package smoke check |

## 19. Working in this repository

### The tree is dirty and shared

Several agents and the user may be editing at once. Before touching anything:

```powershell
git status --short
git diff -- <files you plan to touch>
```

Assume unrelated changes belong to someone else. **Never** `reset`, `checkout`, `clean`,
broad-format, or overwrite unrelated work to simplify your patch. If the exact lines you
planned to edit changed underneath you, reread and integrate — do not replay an old patch.

### The fix loop

1. Reproduce the real bug, or add a regression that **fails under the old input/ordering**.
2. Fix the earliest root cause — not the last place the wrongness became visible.
3. Run the nearest test file.
4. Run adjacent boundary tests when a protocol crosses modules.
5. `npm run verify` before calling production code done.
6. `npm run build` / package checks when bundling, native modules, resources, extension
   shipping or installer behavior could differ.

A good fix here has three parts: the root-cause change, a targeted regression, and a comment
naming the non-obvious invariant when a future "simplification" could reopen it.

**Green unit tests do not prove** a browser race, a Windows reparse race, an Electron
ordering race, a live ChatGPT Fiber shape, a process race, or resource-scale behavior. Model
the missing adversarial ordering, and use a live repro when feasible. For races prefer
epochs, generation ids, serialized mutation queues, idempotency keys, exact identity or
ownership locks — **not sleeps**, unless time really is the protocol. The reusable pattern:

```text
start A → pause A before its durable/publish step → run B to completion
        → resume A → assert B was not overwritten, resurrected or misattributed
```

Every security or identity fix needs its **negative case**: in-root native path works /
escaping native path fails; exact correlation routes / conflicting correlation does not
guess; owner polls the terminal / another worker cannot; current epoch accepts the Fiber
answer / stale epoch discards it.

**Both sides of a protocol.** A compiling one-sided edit is still broken. The multi-hop
protocols are: app↔extension bridge, content↔Fiber `postMessage`, main↔preload↔renderer
IPC, MCP schema↔handler↔recorder summary, durable store↔restart restoration.

### Commands

```sh
npm ci                                   # clean/reproducible install from package-lock.json
npm run dev                              # electron-vite dev
npm run typecheck
npm test -- --run test/<target>.test.ts
npm run verify:privacy                   # public Git identity/session/path gate
npm run verify                           # the exact CI gate: rg fetch, privacy, typecheck, full Vitest
npm run build                            # electron-vite bundles
npm run dist                             # this host OS, x64 + arm64 artifacts → release/
npm run dist:mac / dist:linux            # explicit platform families on matching hosts
npm run dist:dir:<platform>:<arch>        # one unpacked package for smoke/debug
```

Use `npm install` instead of `npm ci` only when dependency metadata is intentionally being changed.
`npm run verify` is not shorthand for one `vitest run`: `verify:ci` first ensures bundled ripgrep,
runs the public-history privacy gate, typechecks, runs the ordinary Vitest set **excluding**
`mcp-shutdown`, then runs `mcp-shutdown` separately so its real socket/process-drain timing is not
distorted by the rest of the suite.

Vitest uses real filesystem, real processes and real HTTP in many suites; default
test/hook timeout is 30 seconds.

### Where a regression belongs

71 tracked `*.test.ts` suites in the current tree, named for the subsystem or boundary they cover.
Vitest uses real filesystem, real processes and real HTTP in many of them. **Do not maintain this
count by memory**: derive it from `git ls-files 'test/*.test.ts'` when updating this section.

| Suite | Covers |
| --- | --- |
| `agents` | broker rules, prime/worker identity, at-least-once messaging |
| `bridge` | extension<->app HTTP bridge, routes, auth, orchestration |
| `browser` | Chrome/Chromium candidate ordering and launch fallback for orchestration URLs |
| `call-context` | running vs settling vs widest MCP-request lifetime accounting |
| `chronology` | the order a recorded turn is read in |
| `codex-apply-patch-parity` | V4A parser / matcher / runtime parity |
| `codex-apply-patch-invocation-parity` | shell-intercepted `apply_patch` invocation |
| `codex-apply-patch-move-rollback` | move/rename rollback under partial patch failure |
| `codex-runtime-parity` | `exec_command` / `write_stdin` runtime parity |
| `codex-view-image-parity` | image validation, limits, transport adaptation |
| `computer*` | desktop automation: helper protocol/retirement, local actions, stale refs, frame bounds, partial batches and permission/runtime fences |
| `config` | validation, migrations, read-only capability collapse |
| `connection` | serialized connector/tunnel lifecycle and stale-generation suppression |
| `content-script` | isolated-world recorder, turn lifecycle, Overwrite render |
| `continuation` | Compact & Resume transaction and its failure paths |
| `correlation` | requestId->conversationId persistence, restore, conflicts |
| `durable` | named-state generation ordering, retry and shutdown flush semantics |
| `env` | the child environment handed to spawned processes |
| `exec-hints` | narrow Windows shell repair/abstention and recovery hints |
| `exec-output-budget*` | collection vs model-visible output budgets and MCP adaptation |
| `exec` | `runCommand` and process-tree termination primitives |
| `extension-path` | stable packaged extension materialization/rollback |
| `extension` | service worker, journal, tab registry, reload recovery |
| `feature-parity` | public capability/tool surface stays synchronized across declarations |
| `fiber` | MAIN-world React extraction and its allowlist |
| `fsops` | bounded text/image/file helpers |
| `goal-resume-handoff` | Goal objective/reply continuity across Compact & Resume |
| `goal` | the goal loop's prompt, privacy boundary, one-draft rule, OpenRouter failures |
| `ipc` | main<->renderer boundary and payload validation |
| `mcp` | surfaces, handlers, integration — the widest suite |
| `mcp-inbound` | `x-request-id` extraction and normalization |
| `mcp-inflight` | request/tool lifetime counters and post-handler settling |
| `mcp-shutdown` | draining an accepted mutation before closing its socket |
| `packaging` | package target/resource/native-runtime composition contracts |
| `platform` | Windows-only Desktop capability projection |
| `public-history-privacy` | public Git history/session/path privacy gate |
| `read-backend` | connector read/list/decode semantics below the public wrapper |
| `renderer-html` | sanitization of captured ChatGPT HTML |
| `renderer-layout` | session card / timeline layout contracts |
| `renderer-state` | unsolicited pushes must not clobber a focused dirty field |
| `resume` | resume and handoff paths |
| `runtime-enable-and-extension` | feature toggles start/stop bridge/extension dependencies correctly |
| `sandbox` | path, root and containment policy — the security suite |
| `shutdown` | bounded teardown phases that always reach the exit; terminal sessions really dying |
| `search` | glob translation and `find` behavior |
| `secrets` | safeStorage-backed secret store |
| `session-list-refresh` | session-list projections refresh without stale async selection |
| `session-retention` | startup/coarse history pruning independent of recording admission |
| `session` | recorder merge and durable store behavior |
| `swarm` | multi-agent integration across identity and workspace |
| `text-match` | edit matching across line endings |
| `tools-desktop-*` | Desktop registration and per-action live capability enforcement |
| `tray-image`, `window-*` | platform-native shell geometry/icon/tray/lifecycle invariants |
| `tunnel`, `tunnel-lifecycle`, `tunnel-locate` | error classification, process lifecycle, binary discovery, poll metrics, outage confirmation and route self-test |
| `unified-exec-mutex` | process-manager serialization / terminal concurrency invariants |
| `update` | one-pass update eligibility, checksum staging and quit-time handoff |
| `workspace` | per-chat/agent workspace learning and keying |

### Delegating to workers

The prompt is part of the engineering work — a worker receives its task, not this
conversation. Each assignment states: project path, concrete objective, relevant subsystem
and likely files, evidence or reproduced symptoms it should inherit, constraints and
ownership boundaries, what it may edit, validation to run, and the expected handoff.

Start with the actual task. **Do not** open with canned text like "you have zero prior
context" — prefer `Fix the renderer state-clobber bug in C:\…; the confirmed symptom is …`.
Workers are already bound to their slot when launched, so nothing is asked of them about
identity. Put what every worker in the batch needs — project path, conventions file,
ownership boundaries, validation to run — in `spawn`'s `context` once; each `task` then
carries only that worker's own objective and files.

For audit-only roles make the write boundary explicit: source, tests, AppData and config
stay read-only, and each worker may create only its named report. The prime then reads the
source itself, reproduces release-blocking claims, records what it accepted or rejected, and
owns every production edit. **Parallel reports are independent hypotheses — not votes, not
proof.**

When a recurring symptom is not yet a clean issue, use the available local transcripts and
durable session metadata to follow **one** concrete request id, conversation id, worker slot
or event sequence end to end. Keep any security-sensitive reproduction material private.

## 20. Packaging and release — `electron-builder.yml`

App id `com.chatonsteroids.app`, product `Chat On Steroids`. Releases build six native
platform/architecture jobs: Windows x64/ARM64 NSIS, macOS x64/ARM64 DMG+ZIP, and Linux
x64/ARM64 AppImage+DEB. Windows stays per-user-capable, `asInvoker`, no forced elevation.

- Only `out/**` + `package.json` go into app files.
- Target-specific tunnel and ripgrep resources ship outside asar — they must execute as real files.
- `extension/` ships outside asar — Chrome's "Load unpacked" needs a real folder.
- In packaged runtime `extension-path.ts` mirrors that bundled extension to stable `userData/extension`;
  do not point Chrome directly at an AppImage's temporary mount.
- `node-pty`, Sharp/libvips and tree-sitter native payloads are staged for the exact target
  platform/arch; host-native build/prebuild leftovers must never override them.
- Uninstall/package replacement deliberately preserves per-user app data.

Before cutting a version, synchronize `package.json`, `src/main/version.ts` and
`extension/manifest.json`, and run the full suite. After installing a local build, verify
the **packaged** app really contains the target extension/tunnel/ripgrep/native runtime and can
execute its PTY/parser/image stack — a successful installer/archive build does not prove it.

The build layers are distinct and a green earlier layer does not imply a later one:

```text
TypeScript source + plain MV3 extension
  → electron-vite: main / preload / renderer bundles in out/
  → packaging prepare: target-specific tunnel + rg + native node modules
  → electron-builder: platform artifact, extension/resources outside asar as required
  → packaged-runtime smoke: start the built app and exercise resources/native stacks in place
  → release assemble: collect all six target jobs + extension ZIP + SHA256SUMS.txt
  → publish: only from a reviewed version tag, without rebuilding from another ref/run
```

The extension has **no separate bundling step**: `manifest.json`, `background.js`,
`chatgpt-dom.js`, `content.js`, `fiber.js`, popup assets and CSS ship as source files. Any change to
extension JavaScript is therefore both runtime code and package input; tests that import/evaluate
those scripts do not prove electron-builder actually included the intended bytes.

### Packaging/release script ownership

The `scripts/` directory is build/release code, not an unstructured bag of helpers:

| Script | Owns |
| --- | --- |
| `package.mjs` | one packaging invocation: regenerate icons → electron-vite build → for each target arch fetch tunnel + rg → stage native modules → run electron-builder with publishing disabled |
| `packaging-targets.mjs` | the only supported package OS/arch vocabulary (`win32|darwin|linux` × `x64|arm64`), aliases and target-specific builder/archive/native-path naming |
| `packaging-versions.mjs` | pinned tunnel-client/ripgrep version + target SHA-256 manifest; fetchers and smoke tests consume this rather than carrying their own versions |
| `fetch-tunnel-client.mjs` | download/checksum/extract the pinned OpenAI tunnel bundle for one explicit target; host-target runs also refresh the development mirror |
| `fetch-ripgrep.mjs` | same pattern for pinned rg; Linux deliberately uses portable musl upstream builds |
| `prepare-packaging-native.mjs` | materialize target Sharp packages from **package-lock URL+integrity**, then stage verified target node-pty/tree-sitter/Sharp trees without allowing host leftovers to win |
| `smoke-packaged-runtime.mjs` | prove an unpacked artifact contains the exact extension, licenses, tunnel, rg and target native modules and that the packaged executable/runtime can actually load/use them |
| `smoke-macos-bundle.mjs` + `macos-audit-utils.mjs` | native macOS bundle audit: Info.plist contract, thin Mach-O arch, deployment floors, executable bits and current unsigned/no-trust-bearing-signature policy; helper safely handles parenthesized Electron helper names with classic `otool` |
| `smoke-macos-gui.mjs` | launch the packaged macOS GUI, require app/window/renderer-ready evidence plus a minimum survival window, then terminate it cleanly; package existence alone is not a GUI startup proof |
| `make-icon.mjs` | reproducibly derive app/runtime/extension icon sizes from the one controlled artwork PNG without introducing an image-build dependency |
| `verify-public-history.mjs` | release-line privacy/provenance gate over reachable HEAD history/tags plus staged/current identity; PR synthetic merge identity is excluded because it can never enter public history |
| `check-release-absent.mjs` | fail closed unless GitHub positively says the tag has no existing release; unexpected API failures never mean “safe to overwrite” |
| `install-git-hooks.mjs` | opt the checkout into versioned `.githooks/` through `core.hooksPath` |
| `kill-stray-vitest.mjs` | explicit recovery command for test worker trees orphaned by an interrupted run; matches Vitest command lines rather than killing arbitrary Node processes |

Generated/staged build resources are **outputs of these mechanisms**, not second source trees to
hand-edit. Change the pin/source/script and regenerate; otherwise the next verified package run is
entitled to replace the manual edit.

Native payload selection is target-owned, never host-leftover-owned. Packaging deliberately
excludes host `node-pty`/Sharp/tree-sitter build/prebuild directories from the generic file set and
adds the prepared target tree back for exactly the requested OS/arch. Cross-arch packages that
accidentally prefer a host `build/Release` directory can build successfully and then fail only on
the user's machine; that is why package smoke is a release gate, not optional polish.

`release.yml` is reusable and its matrix builds/smokes every target on a native runner, then one
`assemble` job downloads all package artifacts, creates the standalone extension ZIP and
`SHA256SUMS.txt`, and uploads one release candidate. Publishing runs through
`.github/workflows/publish.yml`, dispatched at the tag itself
(`gh workflow run publish.yml --ref vX.Y.Z`). It calls `release.yml` as a reusable workflow,
so the installers a release carries are built from the tag being published inside the run
that publishes them, and never travel between runs. A tag alone no longer builds anything.
`publish.yml` refuses a non-tag ref, refuses a tag with no reviewed
`docs/release-notes/vX.Y.Z.md`, re-checks the packaging runner's SHA-256 sums before
attaching the files, runs the public-history privacy gate again, and refuses to overwrite an
existing release. Maintainers and agents install the versioned Git hooks with
`npm run hooks:install`; those hooks reject personal maintainer identities and Claude session
provenance before it can be committed or pushed. `release.yml` on
`workflow_dispatch` still produces an unpublished candidate from any ref.

CI and release answer different questions. `.github/workflows/ci.yml` runs verification on the
supported OS families so TypeScript/tests do not silently become Windows-only; `release.yml` is the
native packaging matrix that proves each concrete artifact. `publish.yml` then re-checks version
agreement, release-note presence, privacy/history and hashes at the **tag being published**. Never
replace that chain with "CI passed on main, so upload local installers" — it breaks provenance
between reviewed source and shipped bytes.

## 21. Security-sensitive areas

Some subsystems sit directly on trust boundaries and need extra review: browser/session identity,
MCP request lifecycle, approved-path enforcement, process execution, desktop control, secrets,
and resource limits. Keep public documentation focused on contracts and invariants rather than
publishing exploit recipes or detailed reproductions for unresolved weaknesses.

Before changing one of these areas, reproduce the behavior against the current tree, preserve
fail-closed behavior, add a deterministic regression where practical, and verify neighboring
negative/security cases. Suspected security issues and reproduction details belong through the
private process in `SECURITY.md`, not in public issues, comments, or fixtures.

**Do not scatter fixes across symptoms before proving the shared root.**

## 22. Definition of done

- The reproduced failure is gone **for the root reason** — not hidden in the UI, not retried
  until lucky.
- The neighboring negative / security case still holds.
- A targeted regression captures the old failure ordering or input.
- Every producer and consumer of any changed protocol agrees.
- Model-visible schema and user-visible surface still match the implementation.
- Unrelated dirty work is untouched.
- Targeted tests pass and `npm run verify` passes.
- Build/packaging checked when the changed layer can differ after bundling.
- Comments and this file updated only where behavior genuinely changed.

> **The rule.** Name the identity crossing the failing boundary, follow one concrete item
> end to end, and fix the earliest place where reality diverges from that identity or
> invariant.
