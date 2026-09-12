# Chat On Steroids — product logic and agent map

Read this file before changing the app. It explains the product, feature logic, owners and
working rules without requiring old worklogs. If the host injected only a prefix, read the
remaining file from disk. Then open the relevant implementation.

**QUALITY >> QUANTITY. Delete before adding.** Repair the earliest wrong identity, decision or
ownership boundary. Rewrite the affected area around its intended invariant and remove the
obsolete branches it replaces. Do not bolt on another fallback, watcher, timer, state machine
or mirrored authority. This permits a focused subsystem rewrite, not an unrelated redesign.

**The tree is shared and usually dirty.** Never reset, checkout, clean, broadly reformat or
overwrite somebody else's work. Read the current diff of every file you will edit. Re-read
changed lines before applying an older patch. Document the work and its actual validation.

**Reading order:** §§1–3 product/identities/evidence; §4 owners; §§5–18 feature contracts;
§19 debugging/tests; §§20–22 shipping, known gaps and completion.

**Meaning of the text.** “Intent” and “must” describe the behavior to preserve or achieve.
“Current” describes the checked implementation. A bug does not become product policy because
the code currently does it. Known implementation gaps are collected in §21 instead of being
mixed into the happy path as features.

Source alignment: **2026-09-10**, including current working-tree changes. App/extension **2.0.9**,
bridge protocol **13** in the checked declarations (`package.json`, `src/main/version.ts`,
`extension/manifest.json`). This does not prove release, installation or live Chrome behavior.

## 1. What the whole app is meant to do

Chat On Steroids is a Windows/macOS/Linux Electron workspace around ChatGPT. The user can work
from the desktop app while ChatGPT generates answers in its own browser conversation. The app
sends instructions, records the conversation, supplies local tools over MCP, and coordinates
long-running work. The companion extension connects that browser conversation to the local
session. ChatGPT still owns model execution and its native account/model availability.

The product should feel like one continuous workspace: choose a project, send a task, watch
real progress, correct it while it runs, inspect what actually happened, and continue without
losing the project, history, workers or queued instructions when a chat grows too long.

### The user's normal path

1. **Set up access.** Approve folders and capabilities, configure a tunnel, connect Core in
   ChatGPT, and load/pair the companion extension. Desktop and Plugins are optional connectors.
   Connection, browser pairing and account model availability have separate status.
2. **Choose where work belongs.** Add a local project folder or use an unfiled chat. A project
   gives the session its working folder and root `AGENTS.md`; permission still comes from the
   approved roots. Removing a project grouping keeps its chats and folder association.
3. **Write a message.** Select an account-observed model and reasoning level, optionally attach
   files, choose ordinary/Goal/Loop behavior, and Send. The app freezes an input in its durable
   outbox before delivery. “Queued”, “put into the composer” and “ChatGPT accepted it” are
   different facts and should be presented that way.
4. **Work and steer.** The timeline combines native user/assistant messages with exact local
   tool results. An immediate correction can join an eligible tool response. An after-turn
   message waits for a verified completion. Native file uploads always use the browser send
   path. The queue remains editable until its exact entry has been claimed.
5. **Plan or automate deliberately.** A generated workflow gives the executor the whole job
   immediately and queues later verification checkpoints. Goal continues unfinished requested
   work and may stop. Loop keeps asking for deeper work within the same brief until switched
   off. Astra uses its finish-tool boundary for automatic continuation.
6. **Continue across time.** Workers sleep for reuse. Compact & Resume moves the same local
   session from old ChatGPT chat A to new chat B. History remains readable; queued work and
   project identity remain attached to the session. Recovery helps only work the app can still
   prove it owes, not arbitrary old chats.

### Feature vocabulary — keep these distinctions

| Concept | Meaning and intended effect |
| --- | --- |
| Local session | Durable identity for the work, its history, project and current ChatGPT binding. |
| ChatGPT conversation | Replaceable provider frontend; its id is not the durable session id. |
| Turn | One authored user-message generation and its exact response/work. Interim prose is not a final boundary. |
| Approved root | Filesystem access the user granted; may be a parent containing several projects. |
| Local project | Explicit folder association and sidebar grouping; grants no new permission. |
| Native ChatGPT project | Provider `/g/.../c/...` context; separate from the app's local folder catalog. |
| Goal objective | The requested finish line for one chat. It persists independently of a provider attempt. |
| Goal / Loop | Mutually exclusive modes of one driver. Goal can decide no further message is needed; Loop continues within scope. |
| Generated workflow / checkpoints | User instructions owned by the outbox; delivered at real finish/completion boundaries. |
| `update_plan` | The agent's displayed progress plan. It does not execute or consume queue entries. |
| `session_finish` | Astra's explicit near-finish hold/notice boundary; does not mean the whole task is already verified. |
| Prime / worker | One owning conversation and its reusable subordinate chats. Several prime families may run independently. |
| Decision helper / planner | A role-specific chat that produces a continuation decision or workflow; it must not execute the reference task. |
| Code-mode `exec` | Bounded JavaScript composition of one MCP surface's tools. `exec_command` runs an OS process. |
| Stop / End turn / Block | Stop requests native generation cancellation; End turn releases a finish hold; Block revokes exact-chat local tool access. |

### Product-wide invariants

- One meaningful fact has one owner. Other modules may project it, never independently decide it.
- User corrections extend the original task. Plans and automation must not quietly narrow it to
  whatever the last assistant answer happened to describe.
- Visible progress is truthful: no invented completion, lost attachment disguised as a file
  reference, sent claim based on insertion, or success based on a button click alone.
- Browser use is economical. Reuse an eligible document; one operation owns one elected tab
  across navigation and MV3 suspension. Startup, a wake socket and a maintenance alarm are not
  independent permission to open a tab. Missing receipts and user-closed elected tabs do not
  create another opening attempt. Transfer opening authority when it is handed out.
- Waiting chats and sleeping workers retain their durable history and identity, not an
  indefinite browser tab. Settled app-owned pages become eligible for New Chat reuse after
  two minutes without work and automatic closure after five. Fresh document/draft/generation
  checks remain mandatory; selected Chrome tabs veto idle closure, and pins veto closure and
  New Chat reuse. Terminal, blocked, cancelled, superseded and duplicate cleanup retains its
  separate authority. Unknown/personal ownership, live work and pending delivery are not idle.
- Unknown identity fails closed where a wrong choice could mutate, attribute or message the
  wrong owner. Presentation can degrade visibly; execution must not guess.
- Every async result proves its original owner and epoch still apply. A → B → A navigation
  defeats a check of the selected id alone.
- Bound compressed bytes, decoded pixels, base64, text, structured results and queue growth at
  their respective owners. A small rendered preview is not a memory bound.

## 2. Runtime model and identities

There are four cooperating planes. Core, Desktop and Plugins are three logical MCP surfaces on
the local MCP listener; the browser bridge is a separate loopback service with separate auth.

```text
ChatGPT model                         ChatGPT browser page
  | MCP via public tunnel               | native UI and conversation state
  v                                     | MAIN: fiber.js + usage.js
Core / Desktop / Plugins                | isolated: chatgpt-dom.js + content.js
  | secret path per surface             v
server -> registrar -> kernel       background.js (suspending MV3 worker)
  | live permission + caller proof      | journal, tabs, claims, ACKs
  v                                     | paired HTTP + wake-only socket
local files / processes / desktop       v
or external plugin manager           bridge.ts
  |                                     |
  +--------- recorder / sessions / input / continuation / agents / Goal
                                        |
                                ipc.ts -> fixed preload API
                                        |
                                Electron renderer workspace
```

The extension observes ChatGPT and performs authorized browser orchestration. It never executes
the model's local tool. The main process is authoritative about what a local tool actually did.
The renderer has no direct filesystem, command, secret or generic main-process authority.

### Identify the boundary before debugging

| Boundary | Identity that must survive |
| --- | --- |
| Filesystem | Approved root plus canonical real path, regardless of native/virtual spelling. |
| MCP ingress | Normalized HTTP request id. |
| Tool attribution | Request id → exact conversation id → local session epoch. |
| Browser observation/action | Conversation + Chrome document id + navigation epoch + message/turn id. |
| Session continuation | Local session id + continuation token + A/B lineage + send checkpoints. |
| Input | Outbox UUID + local session + elected browser owner or exact tool recipient. |
| Agent routing | Exact prime family/run incarnation + worker conversation; `worker-1` alone is ambiguous. |
| Workspace | Proven session/project or caller/agent key + cwd. |
| Terminal | Durable local session principal → process session id. |
| Renderer | Selected session/draft key + load generation. |
| Connection | Endpoint/tunnel generation. |
| Desktop input | Capture frame/accessibility ref + target geometry + helper generation. |

When four features break together, follow one concrete identity through these boundaries. Find
the first wrong fact, not the last UI that displayed it. Discovery vs enforcement, page vs
service-worker lifetime, and local session vs frontend id are recurring sources of mistakes.

### Lifetimes are part of the design

| Storage/lifetime | What survives | What it cannot prove |
| --- | --- | --- |
| App `sessions/` and named `state/` files | App restart; committed history and control intent. | That an old page is currently running. |
| Extension `storage.local` | Browser restart; pairing/disconnect intent, deferred revival metadata, command ACK custody. | A surviving tab/document or current account entitlement. |
| Extension `storage.session` | MV3 worker suspension; journal, tab/document registry, elections and live policy ownership. | A whole browser restart. |
| Content/Fiber memory | One document and its navigation epochs. | Anything after reload unless re-observed or restored from its actual owner. |
| Process manager | Running app's live/unread process sessions. | Process survival across a full app restart. |
| UI/local preferences | Drafts, expansion, theme/language/width as implemented. | Send receipts, task completion or tool permission. |

`durable.ts` provides queued temp-file→rename publication, not a database-grade power-loss/fsync
guarantee. `writeDurableNow()` is the required barrier before an acknowledged control transition
or browser side effect. Per-file queues allow independent writes; cross-file semantic ordering
must be explicit in the caller. Missing/corrupt auxiliary state logs and reads as null so the app
can start; restore may only reconstruct facts from independent durable proof.

## 3. Intent, current source and evidence

For **what should happen**, use the current user request, these product contracts and the
load-bearing reasons in implementation comments. For **what happens now**, use current code with
a reproducible test or live observation. A test that encodes an obsolete invariant is evidence
of the old behavior, not permission to restore it.

Current declarations (`mcp/surfaces.ts`, `mcp/tools-*.ts`, `shared/*.ts`, package/version/manifest)
define the tool/config/wire contract. README and worklogs are secondary and can describe old code.

### Checked baseline

| Setting | Fresh installation | Migration / runtime rule |
| --- | --- | --- |
| Roots | None. | Root-requiring capabilities cannot be published usefully until a root is approved. |
| Tool capabilities | Current `defaultConfig()` starts all Core capability flags on, including `saveArtifact`; read-only off. | Omitted legacy flags use conservative `DEFAULT_CAPABILITIES`. Malformed existing config is conservative recovery, not fresh consent. |
| Recording | On, 30-day retention. | Explicit Off stays Off; retention still applies to old history. |
| Context / compaction | Advisory 400,000; limit rounded from advisory × 4/3; auto-compaction on at advisory. | Estimated local units. Automatic execution additionally requires live work, current ownership and eligible model/role. |
| Multi-agent | On, 2 simultaneous slot-holding workers **per family**, configured hard max 8. | Legacy absent enabled/allow-unattributed fields remain false. Existing choices stay exact. |
| Unattributed allowance | True on first launch. | Relaxes ambiguity fences only; known blocked/retired/superseded ownership stays enforced. |
| Recover ordinary/agent tabs | Off. | Goal/Loop can independently justify recovery; history alone cannot. |
| Goal / Loop | Off, preferred mode Goal. Both decision backends default to ChatGPT, helper `gpt-5.6-sol` High. | API uses the configured OpenRouter/custom endpoint and stored model. These defaults are not account-availability proof. |
| Desktop | Windows on; macOS off until enabled and OS consent granted; Linux unavailable. | Unsupported platforms mask live capabilities without erasing stored choices. |
| Shell/UI | Dark theme, minimize to tray, no automatic connector connection/login startup by default. | Optional browser/finish/plan choices are resolved by current config and their consumer, not invented from absent fields. |
| Plugin auto-refresh | Off. | Local status/discovery never claims ChatGPT refreshed its connector snapshot. |
| Background chats | On. | Omitted legacy settings use On; explicit saved On/Off remains exact. Cold Windows startup requests a minimized browser window. |

Keep evidence levels separate in all reports: **source → tests → build → package → installed
payload → live browser/device/provider behavior**. Passing one level does not prove the next.
For a shipped-version question inspect the immutable tag and installed bytes; a dirty tree with
the same package version is not equivalent.

## 4. Ownership map

Paths in this section are repository-relative. Most mechanisms have `main`, `shared` and
`renderer` halves; follow the authoritative main/shared owner before changing presentation.

| Area | Files and responsibility |
| --- | --- |
| App shell | `src/main/index.ts`, `window-lifecycle.ts`, `window-layout.ts`, `window-icon.ts`, `tray-image.ts`, `shutdown.ts`: bootstrap, activation, geometry, tray and bounded exit. |
| Config/security | `src/main/config.ts`, `platform.ts`, `secrets.ts`, `sandbox.ts`, `redaction.ts`; `src/shared/types.ts`, `capabilities.ts`: permission and host projection, secrets, approved paths. |
| Publication | `src/main/connection.ts`, `mcp/server.ts`, `mcp/surfaces.ts`, `tunnel/{index,health,locate}.ts`, `diagnostics.ts`: endpoint/tunnel generation and truthful status. |
| Tool dispatch | `src/main/mcp/{tools,kernel,inbound,call-context,tool-declarations}.ts`, `tools-core.ts`, `tools-desktop.ts`, `tools-plugins.ts`: declarations, exact caller, live guards and evidence. |
| Code composition | `src/main/mcp/code-mode-{tool,runtime,worker}.ts`: surface-scoped `exec`, QuickJS admission, limits and explicit emissions. |
| Instructions/plan | `src/main/mcp/{instructions,coding-instructions,plan-tool}.ts`, `src/shared/agent-plan.ts`, `src/renderer/agent-plan.ts`: executor contract and displayed progress plan. |
| Local files/processes | `src/main/{rawfs,fsops,search,ripgrep,env,toolchain,exec,exec-hints,text-match,diffstat}.ts`, `src/main/codex/*`: bounded filesystem/shell implementation. |
| Terminal custody | `src/main/codex/{manager,ownership,unified-exec,unified-exec-constants,shell,command-batch,head-tail-buffer,truncate,exec-output}.ts`. |
| Patching/images | `src/main/codex/apply-patch/*`, `codex/{filesystem,read-backend,view-image}.ts`. |
| ChatGPT downloads | `src/main/mcp/artifact-{download,fetch,target}.ts`: validate native file reference, bounded fetch, exclusive destination publication. |
| Projects/cwd | `src/main/projects.ts`, `workspace.ts`, `src/shared/projects.ts`: explicit local folder catalog, session binding, inherited/learned workspaces. |
| Durable history | `src/main/session/{store,recorder,correlation,retention,summarize,progress}.ts`, `src/shared/{session,chronology}.ts`: canonical messages, tool truth, chronology and indexes. |
| Model history reads | `src/main/mcp/session-tool.ts`: explicit-session search/read and snapshot/update/detail cursors. |
| Input | `src/main/session/{input,start-input,input-history,input-attachments,input-images,prompt}.ts`, `src/shared/{input,user-prompt}.ts`: outbox, native files, prompt frame and receipts. |
| Finish/planning | `src/main/session/finish.ts`, `task-request.ts`, `goal.ts`, `src/shared/{finish,task-progress}.ts`: held turn, decision/plan invocation and cancellation. |
| Continuation | `src/main/session/{continuation,resume-gate,handoff,handoff-prompt}.ts`: A→B transaction, send ambiguity and exact brief. |
| Automation | `src/main/goal.ts`, `src/shared/{goal,goal-templates}.ts`: objectives, switches, obligations, provider/helper decisions. |
| Agents | `src/main/agents.ts`, `src/renderer/{agent-panel,agent-communication}.ts`: independent prime families, staged mutations and addressed messages. |
| Browser orchestration | `src/main/bridge.ts`, `browser.ts`, `browser-startup.ts`, `browser-wake.ts`, `browser-window-layout.ts`, `browser-preferences.ts`; `src/shared/browser-preferences.ts`. |
| Extension | `extension/{manifest.json,chatgpt-dom.js,content.js,fiber.js,background.js,usage.js,overlay.css,popup.html,popup.css,popup.js}`: injection worlds, native observations/actions, journal and UI. |
| Models/usage | `src/main/chat-models.ts`, `session/usage.ts`; `src/shared/{chat-models,usage}.ts`; `src/renderer/{chat-models,context-meter,usage}.ts`: account observations vs local estimates. |
| External plugins | `src/main/plugins/{catalog,installer,manager,exposure,oauth}.ts`, `plugins-ipc.ts`, `plugin-refresh.ts`, `src/shared/{plugins,plugin-refresh}.ts`, `src/renderer/plugins.ts`. |
| Renderer boundary | `src/main/ipc.ts`, `edit-context-menu.ts`, `src/preload/index.ts`; `src/renderer/{main,chat,dom,tool-result,timeline-scroll,sidebar-resize,browser-preferences,i18n}.ts`, `locales/zh-CN.json`, `index.html`, `styles.css`. |
| Native Desktop | `src/main/computer/{index,helper,browser-chords,windows-api,windows-capture,windows-apps,windows-keys}.ts`, `src/shared/windows-computer.ts`, `mcp/tools-desktop-{windows,macos}.ts`, `native/macos-desktop-helper/*`, `native/macos-desktop-addon/*`. |
| Delivery/build | `src/main/{update,extension-path,version,logger,durable}.ts`, `electron.vite.config.ts`, `electron-builder.yml`, `scripts/*`, `.github/workflows/*`, `vitest.config.ts`. |

### One durable fact, one authoritative owner

| Fact | Owner / storage | Publication rule |
| --- | --- | --- |
| Permissions and settings | `config.ts` / `config.json` | Validate every load/save; enforce effective current capabilities at use. |
| Credentials | `secrets.ts` / encrypted `secrets.bin`; plugin OAuth's encrypted installation store | Main process only; publish updated cache after the encrypted write. |
| Session/current chat/project | `store.ts` / `sessions/<id>/meta.json` | Rebind is the semantic A→B commit. |
| Exact request ownership | `correlation.ts` / `state/request-correlations.json` plus recorded proof | First exact proof wins; retain local session epoch; reconcile from history on startup. |
| Authored message | `store.ts` / canonical message shard | Replace by stable identity, preserving origin chronology. |
| Agent progress plan | `store.ts::updateSessionPlan` / `sessions/<id>/plan.json` | Exact caller/session and invocation ordering; atomically replace the whole plan. |
| Input and checkpoints | `input.ts` / `state/session-input.json` | Serialized acceptance, frozen payload, exclusive claim and receipt; stages belong here. |
| Native upload originals | `input-attachments.ts` / `input-attachments/` | Immutable bytes, opaque ids; outbox owns membership and retention. |
| Project catalog | `projects.ts` / `state/projects.json` | Serialized catalog mutation; session metadata owns association. |
| Browser commands/results | `bridge.ts` / `state/bridge-commands.json`; extension ACK outbox | Intent and exact lease before text; receipt durable before ACK custody is retired. |
| Workers and inboxes | `agents.ts` / swarm snapshot and retired-worker fences | Stage → critical durable snapshot → publish/open/report. |
| Compaction | `continuation.ts` / continuation WAL + session metadata | Disk ownership decides restart outcome; transport phase alone does not. |
| Goal control | `goal.ts` / `goal-objectives`, `goal-switches`, `goal-replies` | Objective, mode and reply debt are separate concepts; draft memory is disposable. See §21 for remaining atomicity gaps. |
| Stop/block/finish | Stop command; `blocked-chats.ts` durable set; finish facts in recorded progress/session projection | Each names exact chat/turn; no false terminal event. |
| Browser repair | `bridge.ts` process-memory episodes | Re-earn from live evidence; never restore an old reload token as action authority. |
| Catalog/usage | Saved successful `chat-models`; derived `usage-cache`; live usage snapshot | Catalog is observation, not a send receipt; estimates are not provider billing. |
| Connector refresh | `plugin-refresh.ts` / `state/plugin-refresh.json` | Exact installed app id + schema fingerprint, claimed before Refresh, verified after. |

## 5. Startup, configuration and shutdown

**Intent:** open a usable local workspace, restore accepted work consistently, and exit without
leaving an invisible process, tool, writer or installer competing with the next launch.

The single-instance lock must be won before touching shared userData. The losing process marks
itself quitting immediately; `app.quit()` alone does not stop module evaluation. Activation from
second-instance/tray/Dock is gated until restore, CSP, permissions and IPC are ready. Once quit
begins, no delayed startup callback may re-enable window creation.

Startup initializes config/secrets/session/durable paths, restores the saved model catalog and
plugin manager, loads Goal ledgers, exact correlations and blocked chats, then retired workers
and every active/dormant prime family. Persistence hooks exist even when multi-agent is Off.
Continuation restore follows swarm restore because it may repair prime ownership. IPC/input
hooks precede browser traffic. Then the secure window/tray, bridge for recording or agents,
independent retention maintenance, optional connector auto-connect and updater lifetime begin.
The current first-window model-discovery exception is noted in §21.

Settings use validated current config and `effectiveCapabilities()`. Fresh-install defaults,
legacy omitted fields and malformed-file recovery are three different cases. User choices must
not be widened because a newer version added a field. Read-only derives from the write-capability
set; adding a new mutating capability must make it read-only-blocked automatically.

Renderer settings save `{base, patch}`. Main performs a field-wise three-way merge so an unchanged
form field cannot undo a newer browser-side setting. Renderer saves also serialize snapshots
from the latest requested state, preserving fast successive edits. Disable side effects are
ordered: revoke/park worker execution and durably retain history, cancel its commands while the
bridge is available, then stop unnecessary bridge/publication resources.

The BrowserWindow keeps context isolation, sandbox and web security on; Node integration and
webviews off. CSP, permission denial, navigation/window restrictions and fixed preload methods
remain intact. OS consent for Desktop is independent from the app's settings.

`durable.ts` serializes per filename, atomically replaces JSON and retries failed generations;
lazy snapshots materialize at the write boundary. Independent files may flush concurrently.
Cross-file semantic transactions require the owner's explicit awaits, not a global disk queue.

Shutdown owns an ordered, bounded sequence: stop admission and drain accepted HTTP work; stop
process/native/plugin/tunnel resources; flush recorder work; flush sessions and named state;
flush operational logs; hand off an eligible verified update; finally `app.exit(0)`. Every
long-lived timer, process, socket, subscription and writer needs a shutdown owner. Per-task
timeouts do not replace a bound on the whole teardown. Ordinary reconnect/disconnect must not
drop an accepted mutation just to finish quickly; final shutdown has its explicit drain budget.

## 6. MCP surfaces, instructions and code mode

**Intent:** ChatGPT discovers capabilities in three comprehensible groups and every invocation
still checks live policy. Schema visibility is never the security boundary.

| Surface | Advertised operations under current eligibility |
| --- | --- |
| Core — `chat-on-steroids-core` | `read`, `view_image`, `find` when command execution is off, `apply_patch`, `exec_command`/`write_stdin`, `download_artifact`, recorded `session`, `update_plan`, `agents`, `session_finish`, code-mode `exec`. |
| Desktop — `chat-on-steroids-desktop` | Windows: 13 Window2 operations, separately permissioned `read_clipboard`/`write_clipboard`, and `exec` with `sky`. macOS: `observe`, `computer`, `exec`. Relevant live capabilities are required. |
| Plugins — `chat-on-steroids-plugins` | Enabled external tools with their upstream names and schemas, plus code-mode `exec` when that composition name is available. |

`read` needs read/browse/metadata as appropriate; images need read; patch checks each hunk's
create/edit/move/delete permission; command controls both terminal tools; downloads need
`saveArtifact`. Recording controls `session` and `update_plan`; multi-agent controls `agents`;
the finish setting controls `session_finish`. Windows publishes four observation methods under
screen access, nine input/launch methods under control, and clipboard methods under their own
permissions. Multiline `type_text` additionally requires clipboard write. macOS `computer`
registration can exist for control or clipboard access; each action rechecks its own permission.

ChatGPT may cache one surface's complete tool list. Core/Desktop exposure is monotonic for an
endpoint lifetime: a previously exposed schema can remain while a revoked handler returns
`TOOL_DISABLED`. The `find` vs terminal choice freezes at discovery. Reconnect establishes a
new clean shape; current config still governs every call. Each registrar refuses foreign names;
there is no merged hidden dispatch. Plugin exposure follows its separate dynamic manager.

`tool-declarations.ts` caches immutable declarations/JSON conversion. SDK servers and handler
closures remain request-local, and child calls obtain a fresh live context. Avoid caching the
permission decision alongside a cached schema.

### Instructions must actually reach the executor

MCP initialize advertises `instructions`; successful initialize does not prove the host showed
all of them to the model. Only the first normal message of a new chat and the first bootstrap
of a newly spawned worker use `session/prompt.ts` to freeze the complete current Core instructions
plus the explicitly linked project's root `AGENTS.md` inside the existing `COS_CONTEXT` frame.
The opening outbox input / new-worker command owns this eligibility; no history scan or extra
sent flag decides it. Existing-chat messages, Goal/Loop continuations, plan checkpoints, worker
revivals, compaction requests and resumed-chat bootstraps receive no appended setup block.
Decision/planner helpers keep their separate role-specific contract. Selecting Goal/Loop for
a normal new executor chat does not turn it into a helper. Direct user sends in Chrome are
not intercepted.

`mcp/coding-instructions.ts` contains adapted upstream collaboration prose with provenance;
`mcp/instructions.ts` adds currently available local-tool guidance and the user's bounded
standing additions. There is no extra instructions tool or per-chat “already sent prompt” flag.

The whole message has a **96,000 UTF-16-character ceiling**, plus the input transport's UTF-8
byte envelope. For eligible openings, authored work and complete Core instructions are mandatory;
only AGENTS content spends remaining room. Read it as a bounded UTF-8 prefix, validate the same project/root/read
permission after the await, and cut with an in-context instruction to read the remainder.
Only strict framing is hidden in the local/native display. Original bytes, receipt comparison,
recording and token accounting keep the complete delivered text. `userMessageSource()` supplies
native source text; rendered Markdown whitespace alone cannot prove a send. Local and native prompt
presentation, including worker messages without outbox receipts, ignores provider-added whitespace before the frame, then validates its exact
internal length and closing boundary; authored whitespace after the frame remains intact.

### `exec({code})` composes tools; it is not a shell

Code mode offers top-level await, `tools.<name>(args)`, `Promise.all`, `text(...)` and `image(...)`
within one surface. Evaluation requires exact request/conversation/durable-session proof or
the user's `allowUnattributedCalls` setting. Composition itself owns no chat state; children
retain their individual identity requirements and current capability checks.
QuickJS runs in a disposable Node Worker with no ambient Node, filesystem or network API.
Children reuse the same registrar, validation, handler and dispatcher, inherit exact caller proof
and recheck live permissions/roots. Each child records fresh evidence; only the outer response
owns input, agent inbox and automatic terminal-result delivery. Finish signals remain direct.

Only explicitly emitted text/images enter the result, except Windows Desktop's `sky.get_window_state`
adapter automatically forwards its native MCP image blocks. Its returned value contains only
screenshot metadata, so `text(state)` cannot duplicate pixels into the text budget. `sky` calls the same registered tools,
unwraps `structuredContent.value` and throws tool failures; `nodeRepl.write` aliases `text`.
It adds no persistent Node runtime or independent execution authority. Image emissions are decoded/validated by
the same authority as `view_image`. Plugin output keeps manager redaction. Runtime limits are
centralized in `CODE_MODE_LIMITS` (code, CPU, wall time, memory, calls, concurrency and all result
representations). There is no yield/resume pragma or persistent JavaScript session. Termination
stops new admission, but cannot undo accepted external actions; those keep their normal
execution/recording lifetime. Never add another executor or delivery queue to compensate.
Failure responses report the number of dispatched child calls so a later script/refresh error
does not invite replaying successful input. Unemitted values and arbitrary exception text stay
private. Timers such as `setTimeout` are unavailable, including through the Windows `sky` adapter.

## 7. One tool call: identity, execution and delivery

**Intent:** run exactly the requested operation under current policy, record its true outcome,
and deliver pending information only to the conversation that owns it.

```text
HTTP request -> bounded body / host-origin / secret-path checks
 -> normalize x-request-id in inbound.ts
 -> surface registrar and AsyncLocalStorage call context
 -> exact correlation -> current local session / family / workspace
 -> blocked, superseded, compaction, worker and live capability guards
 -> validated tool handler -> structured outcome/evidence
 -> outer input/inbox/background-result delivery and recording
 -> local response completion -> later exact-owner receipt where required
```

The MCP payload has no trustworthy conversation id. Accepted ownership joins the normalized
HTTP `x-request-id` to native page `metadata.request_id`. `fiber.js` emits bounded allowlisted
evidence; `content.js` confirms the current route and descriptor; `background.js` validates the
Chrome sender document/epoch; bridge `/correlations` files exact pairs through recorder and
reads them back before returning `confirmed[]`. `/events` may publish the same exact evidence.
Ownership acknowledgement is separate from slow transcript/image writes.

`usage.js` can also project an exact conversation/request pair from a complete live POST
conversation SSE event before Fiber exposes it. Reads are bounded to 4 MiB / 90 seconds and
16 request ids; only server metadata is accepted. Content requires the matching route and
document epoch, using the existing observer for brief fresh-route convergence. Missing stream
metadata retains the Fiber path. Fetch reattachment at DOM readiness captures each downstream
wrapper separately and deduplicates responses to avoid recursion through page instrumentation.

For a newly created chat, an exact locally owned provisional Fiber turn can acquire the durable
native conversation id as the route/server identity materializes. A `WEB:` local id, unmatched
historical Fiber object, conflicting durable ids, active tab, timing, tool name, arrival order
or “only generating chat” is never a replacement proof.

`correlation.ts` keeps the first exact request owner and its **local session epoch**. Conflicting
claims do not overwrite it. Proof has no time TTL but the index is bounded to 50,000 recently
observed request ids; recorded exact calls reconcile the index on startup even when a snapshot
already exists. Late proof can repair Unattributed history only to the proved historical owner.

Unresolved requests with an id get the recorder's 20-second production evidence grace. A
headerless call has no exact proof to await and lands Unattributed immediately. Evidence waits
open at admission; calls sharing a request serialize in admission order and each resolved
session serializes its writes. Different chats must not wait behind one global grace timer.
Already-proven calls await their own recording; unresolved recordings may settle after response.

`allowUnattributedCalls` permits ordinary tools and code mode without chat attribution,
including computer use, approved file edits, shell commands and external plugin tools.
Windows observations use a separate shared unattributed context so follow-up input works.
Plan updates, agent operations, finish signals, chat-specific workspace selection and owned
terminal access still require their actual owner; the setting cannot invent that identity.
Anonymous terminals retain their existing anonymous custody. Live capabilities, approved roots
and native window/frame/ref validation still apply.
A positively known blocked, retired, ended or superseded caller is refused regardless of that
preference. Refused historical calls must not revive workers, acknowledge inboxes or grant
activity to a successor chat.

### Three lifetimes and four outcomes

`runningToolCalls()` covers a handler that can still mutate; it is the compaction safety barrier.
`settlingToolCalls()`/`inFlightToolCalls()` additionally cover attribution/recording debt.
`inFlightMcpRequests()` is the wider request lifetime used by shutdown/orphan accounting.
Unresolved running ownership is conservatively visible; a proven worker call cannot make an
unrelated prime busy. Do not treat recorder grace as machine mutation still running.

| Tool outcome | Interpretation |
| --- | --- |
| `ok` | Operation completed normally. |
| `process_exit_nonzero` | The program failed; command transport worked. A failing build is not a connector failure. |
| `tool_rejected` | Intentional validation, permission, identity or lifecycle refusal. |
| `tool_internal_error` | The tool/runtime failed its own contract; counts as a reliability defect. |

The call context retains the strongest applicable outcome. Model-visible results and recorded
evidence must agree. Local HTTP success is not proof of remote model comprehension. Offers of
inbox/input/output data retain custody until their defined receipt; invocation start ordering
prevents an already-running concurrent call from acknowledging information it could not see.

MCP timing logs separate ingress, admission/identity, handler, delivery, recording and local
response completion; unresolved recording settles separately. `scripts/benchmark-mcp-latency.mjs`
compares explicit local/tunnel discovery routes without invoking tools. It does not measure
remote model receipt.

## 8. Filesystem permissions and path resolution

**Intent:** a model can read or edit only paths approved for the relevant filesystem tool.
Native and virtual spellings must reach the same decision.

`sandbox.ts` owns root selection, virtual/native normalization, reserved names, traversal and
invalid host-path rejection, symlink/junction/reparse checks, canonical existing targets and
the deepest existing ancestor for a missing target. Every model-supplied filesystem path reaches
that authority or an already-validated wrapper. Revalidate at actual use when the target can
change during an await. Error text must not leak hidden physical root paths.

An approved `/workspace` may contain `projects/app`; it does not promise `/workspace/src`.
Read the root for one-level discovery, preserve every real intermediate folder, and never
repair a wrong path by guessing a missing project segment. Relative paths need a trustworthy
workspace; an unresolved swarm caller must not fall back to the first approved root.

**Shell permission is broader.** `exec_command` runs arbitrary code as the logged-in user.
Its initial cwd is approved, but the shell program is not confined to those roots. Read-only
therefore disables command execution. External plugin servers likewise retain their own OS or
service authority; the local file sandbox does not contain them. User-selected native upload
staging is a separate explicit-input boundary, not general model filesystem permission.

Negative cases matter: accepted virtual/native in-root paths, rejected traversal and symlink
escapes, live revocation during an await, and preserving an unrelated user's newer file edit.

## 9. Projects, workspaces and project instructions

**Intent:** a chat consistently works in its selected local folder, and workers/resumed chats
retain that choice. Sidebar organization must not destroy work or grant access.

`projects.ts` owns a bounded catalog of canonical absolute local folders with stable UUIDs.
Adding uses the native folder selection/approved-root flow, resolves the real directory and
deduplicates it. Session metadata owns `projectId`. Before send/use, `projectWorkspace()` and
`getSessionProject()` re-resolve it under current roots and reject moved/unavailable folders.
Null means no project; a broken explicit binding is an error, not a reason to infer a new cwd.

Removing a project marks the catalog row `ungrouped`. Existing and unloaded sessions, pending
inputs and workers keep their durable project association; their chats return to the ordinary
sidebar list. Adding that same folder again restores grouping. It does not delete files,
sessions or the approved root. A local project is distinct from a ChatGPT project route.

`workspace.ts` is convenient learned/inherited cwd, keyed to proven chat/family/agent identity.
Explicit session project binding takes precedence at kernel entry. Workers inherit only their
exact prime's project/workspace. Different primes may each own `worker-1` in different folders.
Compaction keeps local session/project identity and moves frontend workspace projection. A
relative path without trusted ownership fails; a workspace never grants permission by itself.

Project instruction injection reads **only the selected folder's `AGENTS.md`**, not a recursive
scan, guessed cwd, parent tree or cached copy. Existing-session scope comes from its durable
binding; an opening input may name its explicit project; workers inherit through the exact
prime. Resume retains the same project binding without reinjecting its instructions. Unfiled
chats receive no project file. Missing AGENTS is fine; an unsafe/unreadable/binary file fails
preparation visibly. Full prompt budgeting and
hidden framing are described in §6.

## 10. Files, terminal, patches, images and downloads

**Intent:** provide a predictable coding loop without requiring a Codex installation or launching
a Codex model. The TypeScript ports reuse selected upstream behavior; the app adds permissions,
identity, evidence and host-specific integration around them.

### Reading, searching and patching

`read` batches paths, lists directories, handles globs and returns numbered bounded text.
`tools-core.ts` owns its contract; `codex/read-backend.ts` owns listing/decoding semantics;
`codex/filesystem.ts` is primitives; `sandbox.ts` is authorization. Do not push policy into
low-level primitives and assume every public caller became safe. Search uses bundled-first
ripgrep when commands are allowed, or `find` with `search.ts` when they are not.

`apply_patch` accepts Codex V4A in the MCP `patch` string. Its parser, grammar, hunk matching,
text/line-ending representation and replacement application live in `codex/apply-patch/*`.
The wrapper separately checks each hunk's create/edit/move/delete permission, paths and workspace,
then records changes. Ordered exact/whitespace/limited-Unicode content matching never relaxes
path authority. Shell-style `apply_patch` interception lives above the parser; quoting, `cd`
and shell control flow are invocation problems, not grammar fixes.

Partial multi-file failure uses bounded rollback snapshots. Restore only a path still matching
what **this patch produced**; a concurrent external edit must never be overwritten. Preserve
the port's explicit line-ending mode and readable parse/match failures.

### Terminal execution and custody

One app-lifetime `codex/manager.ts` owns `UnifiedExecProcessManager`. `exec_command` runs a shell,
returns output or a process `session_id`; `write_stdin` continues that same process, sends input
or drains output. Caller isolation is in `ownership.ts`, not separate managers per request.

The owner is the **durable local session principal** established by correlation. A→B compaction
keeps that principal, so B can continue A's live terminal without an adoption/move fallback.
Another session/worker cannot poll or write it. Anonymous process custody is non-adoptable.

`env.ts` is the shared child-environment authority: Windows key names are case-insensitive,
so use its accessors rather than creating both `Path` and `PATH`. Preserve inherited values.
`toolchain.ts` fills missing/unreachable Windows JDK/Go configuration conservatively; never
override an explicit reachable toolchain. `exec-hints.ts` repairs only provable narrow shell
mismatches and otherwise abstains. Ambiguous globs/control flow keep original command semantics.
Search exit 1 can mean no matches; git/build/mutation failure must not be relabeled success.

`cmds` runs sequential sections in **one shell**, preserving cwd/environment. Continue after
ordinary nonzero exits and report section exits plus the first nonzero aggregate status. Random
framing markers stay internal, including across chunk/poll boundaries. A later failure must not
invite repeating earlier successful mutations. PowerShell/Bash behavior is explicit and tested.

Collection and response budgets differ. Head/tail buffering retains a bounded stable head and
rolling tail with omission counts; UTF-8/token serialization separately bounds returned output.
The connector accepts legacy `max_output_tokens` but enforces its fixed response ceiling.
Never solve a display overflow by silently discarding durable/owed data.

Completed background output is still owned data. The manager does not evict exited unread
sessions to free capacity. Four unread completed results block another spawn for that owner
with `EXEC_RESULTS_UNREAD` before a process starts. Running servers/tails do not consume that
completed-result limit and are not auto-killed or polled.

Completed results can follow automatically in later exact-owner **outer** tool responses,
one bounded UTF-8-safe page within remaining response space. An offer does not drain bytes.
Successful local publication followed by a later exact-owner invocation acknowledges the page,
even if both calls share a generation request id; older concurrent calls cannot. Failed
publication reoffers it. Explicit `write_stdin` can drain the remaining unacknowledged suffix.
After 120 seconds without attendance, a running process can contribute one owner-scoped
reminder; reading diagnostic state does not consume it. Blocked/compacting/superseded sources
and nested code-mode calls do not receive or acknowledge these automatic pages.

### Images and ChatGPT artifacts

`view_image` accepts PNG/JPEG/GIF/WebP under an 8 MiB raw bound and explicit decoded-pixel/memory
limits. Structural checks plus actual Sharp/libvips pixel decoding precede an MCP image block.
Metadata parsing alone is insufficient. Return one native image copy, not duplicate base64 in
structured output. Its validator also owns code-mode emitted-image admission.
JPEG end markers terminate the codestream, not necessarily the containing file; trailing bytes
must not reject an otherwise decodable image. Full bounded pixel decoding still owns validity.

`download_artifact` saves a native ChatGPT/user-supplied file reference into an approved
destination. `artifact-fetch.ts` validates the allowed HTTPS source and every redirect;
`artifact-download.ts` bounds streaming, timeout and cleanup; `artifact-target.ts` owns the
exclusive partial file, file identity and no-overwrite publication. Recheck bytes/target at
publication. Do not put signed URLs/file objects/base64 into shell text or regenerate a user's
file as a substitute. The default file cap comes from `config.ts::DEFAULT_ARTIFACTS` (20 MiB).

## 11. Composer, input queue, generated plans and Astra finish

**Intent:** the user can send, correct, schedule and inspect work without losing authored text
or duplicating a message after an ambiguous browser outcome. One outbox owns all delivery.

### Input from composition to receipt

The chat composer and queued-message editor have no HTML character cap. Send and queue edits
share the existing 96,000-character message admission ceiling; prepared delivery additionally
enforces framing and UTF-8 byte budgets with an explicit error.
The desktop composer uses native CSS content sizing, bounded at 220px. Layout owns its
height across draft changes, hidden panels and width changes; do not persist a measured
`scrollHeight` as an inline height. Empty and fitting input must not overflow; longer text
remains scrollable at the cap. `scripts/verify-composer-layout.cjs` checks real Electron layout.

`session/start-input.ts` brings up the existing connection/bridge owners for an explicit send,
waits for actual connector readiness, then calls `input.ts`. Pre-publication cancellation owns
an AbortController; after enqueue, durable outbox state owns it. Browser startup failure leaves
a clearly queued input and an explicit retry action, not a fake unsent/sent result.

An input contains stable UUID, session/project, authored text, automation/objective, requested
model/effort, due time, optional stages and attachments. `input.ts` serializes mutation and
publishes a new ledger only after its write. Reusing an id with different content is rejected.
The frozen `deliveryText` includes executor setup only for a new-chat opening at claim time; displayed authored
text remains separate. A failed write cannot later become a successful hidden enqueue.

| Delivery choice | Eligibility and behavior |
| --- | --- |
| Immediate / `auto` | In an exact active non-Pro turn before its first MCP call, show **Send directly**: claim that original turn, stop its native generation, then use normal browser Send. After the first MCP call, show **Inject now** and deliver in an eligible outer MCP result. Pro (including Astra) keeps injection throughout. A new turn resets eligibility; old tool history does not count. For a proven idle chat/New Chat, elect the normal browser send. Unknown model/turn identity grants no interruption. |
| After turn | Existing-session FIFO spends one distinct completion, settled native Thinking failed, or confirmed silence-refresh ticket per browser claim. Replays/restart cannot drain the next entry. Does not block an otherwise eligible immediate tool injection. |
| Finish checkpoint | Waits for a successful finish-tool boundary; ordinary eligible chats can deliver after verified completion. Astra's separate after-turn opt-in remains explicit. Checkpoints inherit the current chat model. |
| Native attachment | Browser upload/send only. A file-bearing active-chat input waits for the browser-safe boundary; it never becomes a tool-result file reference. |
| Image injection | When **Inject now** is available, an image-only selection of up to four PNG/JPEG/WebP/GIF files enters the exact chat's outer tool result as image blocks. New Chat, after-turn, mixed files and larger selections use native upload. |
| Decision/planner | Role-specific request through the same claim/receipt infrastructure, with its own result consumer and cancellation. |

Browser delivery elects one exact tab/document/epoch and checks the right existing conversation
or fresh-chat ownership. New-chat reuse requires a visible composer before election and after
native preparation; unavailable surfaces are skipped so the first send can open one clean chat.
A failed native preparation can grant the existing pre-send fallback, before marking readiness.
Before claiming an input it waits for a visible composer; a mounted
editor hidden behind a dialog leaves the input queued in its elected tab. It confirms
model/effort, inserts the full text, uploads native files,
rechecks composer and attachment nodes, crosses app authorization, then **rechecks again after
every await before Send**. Native stable user-message and conversation identity establish
acceptance. Composer insertion, button disappearance and a local “sent” variable do not.

Direct active-turn corrections freeze `directTurn` in the same outbox entry. The existing
turn-start and last-tool evidence plus in-flight MCP custody decide eligibility; no separate
tool-seen flag owns it. Recheck the exact claim before native interruption and before Send.
Navigation, a newer question, an occupied draft or a first MCP call during preparation can
revoke delivery. A claimed browser correction never also enters a tool result. After-turn
entries retain their source-boundary policy and never acquire interruption authority.

Native **Thinking failed** is recognized only by its exact visible disclosure button inside the
current assistant turn, excluding quoted Markdown, old turns and app UI. Detection begins a fixed
30-second ignore period for delayed activity, followed by five minutes listening for MCP/interim
work. New work during listening abandons the failure verdict and returns to the ordinary silence
clock; an exact native final wins immediately. Only the settled failure carries the structured
`thinking_failed` reason into recording and after-turn delivery. Generic failure prose does not.
Failure/silence-based delivery requires a recorded, exactly attributed local MCP call in that
source turn. Native ChatGPT tools, request-id sightings without a call, and earlier turns' MCP
history do not qualify. Check the recorded evidence again for restored tickets and before claim;
refresh itself and normal delivery after a genuine final do not require this MCP proof.
For Pro, a settled failure files the same outbox ticket used by silence recovery: a still-running
native page adds five minutes before pickup, including after restart. It cannot bypass an existing
busy deadline, and another queued message cannot overtake its deferred ticket. Non-Pro failure
delivery retains its existing policy.

Queued after-turn work uses the bridge's existing ten-minute silence/refresh authority. An ACK
for that exact refresh files `silenceBoundary` on the next existing outbox row before publication.
It records source conversation/turn and work sequence; no parallel ticket ledger or scheduler.
Native Stop prevents claiming/sending and durably extends listening by five minutes, rechecking
again if it remains busy. A genuine final can release the message normally during that window.
New work withdraws an unspent ticket/pre-send claim and rearms the ten-minute clock. Authorized
sends retain exclusive custody until their exact receipt or proven pre-send failure. Source work,
document epoch, question, draft and native Send are rechecked across preparation awaits. An
unclassified `stalled` end alone does not release a message; the refresh receipt is required.

Prepared text enters the native editor in one native `execCommand('insertHTML')` operation,
with inline text nodes and BR line breaks, without an extra outer paragraph. Select the replacement/append range and
recheck editor, focus and selection ownership before insertion. Synthetic clipboard events can
be consumed without inserting into a cold editor; per-line `insertText` freezes large project
frames and plain-text paste can turn them into file attachments. Verify the same editor's
normalized text after insertion; do not add a second bootstrap insertion attempt.
Provider paragraph normalization alone does not revoke the draft lease; trusted edits, changed
editor/route identity and attachment changes still do.

The witnessed Send receipt captures the pre-send assistant baseline. If app identity or native
message source arrives after a fast reply has rendered, that question still owns its reply and
exact final marker. A later observation must not classify its own answer as old history.
While an exact send receipt still has a bounded evidence reader, the existing observation also
requests canonical MAIN-world text even after native generation stops. Rendered Markdown can
remove submitted bytes; recognizing the generation must not be a prerequisite for reading the
source needed to recognize its Send. Route, epoch and stable message identity still decide acceptance.

Page-reply waits are bounded: reuse/close observations get three seconds; New Chat preparation
gets fifteen seconds. Missing preparation replies retain the elected tab and grant no fallback.
Only fresh same-document/epoch idle proof allows preparing that elected tab again. Final input
offers do not block maintenance; the content busy slot and durable app claim/authorization own
delivery. A due repair defers that same conversation's input to the next status pass.

A claimed/authorized ambiguous browser send is never automatically resent. Pre-send preparation
failure and post-click uncertainty have different error text and retry authority. Late exact
receipts may settle a cancelled wait; that does not authorize a second message. Receipt custody
and history publication are independent: a recorder failure retries canonical history, not
transport. Queued unclaimed input follows its durable session to the successor; already handed
claims keep their original exact document until their outcome resolves.

Tool input is offered in queue order within one bounded response. Emit one user-instruction
heading, each authored message followed by its normalized images, then one batch reminder.
UUIDs remain internal receipts, not decorative text for the model. A later exact-owner
invocation that started after publication acknowledges it. Immediate inputs may batch;
after-turn and finish entries each retain their own boundary policy. Tool intent has no
arbitrary claim-age expiry. Only positively settled, never-offered eligible input may change
transport; receipt loss cannot justify switching to browser Send.

### Attachments have one staging owner

`input-attachments.ts` stages immutable originals selected by file picker, drop or clipboard.
Renderer/browser receive opaque ids, names, sizes, MIME and bounded previews, never source paths.
Up to 20 files and 512 MiB total per message are locally admitted; provider limits can still
reject an upload. Staging has a 2 GiB quota, serialized pruning/admission, and preserves outbox-
retained bytes. Thumbnails do not modify originals or prove provider upload success.

Bridge chunks are bounded to 512 KiB and require the exact pre-send claimed input and attachment
membership. Native upload completion and final provider submission are separate checks.
Explicit image injection freezes `attachmentDelivery: tool` plus normalized `toolImages` in
the same outbox row, preserving authored attachment IDs for idempotent retries. Staging owns
the bounded original reads; `input-images.ts` fully decodes at most 12 MiB/30 million pixels
per source and normalizes to WebP within 1600x1600 and the existing encoded-image limit.
The exact active owner is rechecked after preparation. A tool-only input never falls back to
a native browser message; existing outer-result offers and receipts own delivery. History
records the normalized assets once, without duplicating thumbnail cards. Legacy `images`
remain supported under the same combined four-image and queue limits. Never send a path or
reference while implying its bytes reached ChatGPT.

### Generated workflow vs the agent's displayed plan

“Create plan” uses `goal.ts::draftTaskPlan()` via `task-request.ts` and the selected ChatGPT/API
backend. It returns 2–12 substantial stages under the aggregate bound. Stage one must state the
complete objective, requirements, constraints and implementation approach; later stages are
verification/improvement checkpoints, not withheld parts of the specification. Planner helpers
receive reference task content and a JSON output contract, not executor instructions or finish
reminders. Invalid stages never enter the queue.

Planning belongs to the originating draft key. Navigation does not cancel it or redirect its
result. Editing a pending task cancels that exact request; object identity rejects late results.
Progress/error/retry belongs to the same invocation. `runTaskRequest()` coalesces a repeated id
with the same fingerprint and retries only classified pre-delivery failures within its bounds.

- **New chat:** the completed plan stays editable until explicit Send/cancel/New chat reset.
  Clearing the composer keeps its captured objective. Send freezes the original objective and
  **every** stage in the first durable payload. Later checkpoints are materialized once after
  the first receipt creates the concrete local session. Until then, the dock projects them
  from that same input. Retry must retain objective + all stages, never restore only stage one.
- **Existing session:** completion atomically admits all finish checkpoints into the durable
  outbox immediately. Composer text/attachments are not sent by that admission, and clearing
  the composer cannot delete the checkpoints. Edit/delete/reorder uses the ordinary queue.
  Failed admission keeps the editable result for retry in its originating session.
- **Displayed `update_plan`:** `plan-tool.ts` writes one whole `plan.json` under the exact
  caller's local session. Short headlines, bounded details and statuses appear above the queue;
  at most one step is in progress. Older calls/retired frontends cannot overwrite newer state.
  Completion animates then dismisses the card; completed reloads stay hidden while the document
  and history remain. Prepared handoffs include an exact-session notice to inspect the saved
  plan. This card neither delivers instructions nor completes/deletes queued checkpoints.

Finish checkpoints use `shared/input.ts::browserInputModel()` to inherit current selection,
including legacy rows containing an old model. A receipt for an inherited checkpoint must not
republish an old enqueue-time model as a fresh observed switch.

### Astra's finish boundary

`shared/chat-models.ts` recognizes exact Astra/Pro identities; substring guesses are forbidden.
`session_finish` is exposed by the finish setting and requested in executor prompts only under
the applicable Astra policy. Workers still use `agents action=finish`.

`shared/finish.ts::finishInstruction()` is the single prompt for browser and tool delivery:
complete implementation first, call when roughly the configured 3/5 minutes of final checking
remain, and complete newly delivered work. It is not a progress tool or a way to collect all
checkpoints in a loop. Hidden reminder framing never removes original recorded bytes.

`session/finish.ts` validates exact active session/conversation/turn and invocation start.
The turn's recorded finish authority owns held/released/notified/decision state. Pending user
instructions and checkpoints take priority. A successful finish response can deliver one
checkpoint; empty holds can wait without inventing new work. “End turn” durably releases the
hold so ChatGPT may finish; it does not pretend native generation has stopped.

For Astra, **both Goal and Loop use the Loop decision path at the finish boundary** and inject
the resulting instruction through tools. A completed final answer sends another browser message
only when Pro Loop explicitly enables after-turn delivery (§17). `automaticFinishEnabled()` is shared by generation and queued-input
validity: armed Goal/Loop suppresses Notify even if the global finish action is Notify.

Finish decision generation deduplicates by actual recorded work/input revision, not a new
request timestamp or repeated hold call. User input, changed settings, turn release, block or
replacement invalidates the old attempt. Progress uses the existing mutable timeline row;
notifications are scoped to that exact turn and may be suppressed when the app is open.
No periodic generated-input daemon is part of this design; old periodic rows are retired.

## 12. Recording, history, context and usage

**Intent:** preserve what the user and model actually said and what local tools actually did,
then show it in stable chronological order at a bounded rendering cost.

Two producers are necessary: MCP/app evidence supplies exact tool args/results/outcome/files,
while browser observations supply native messages, progress, terminal state and page identity.
Neither can substitute for the other. Recording is local; explicit Goal/API/plugin/model tool
use can transmit the data described by those features. Do not call all product traffic local.

The recorder coalesces identical `chat_error` notices within 30 seconds against a bounded
committed error tail, including concurrent tab reports and replay after restart. Page-wide
access limits ignore document-local turn ids; other errors retain their turn scope. Different
text, another session or a later occurrence remains visible. This controls transcript noise,
not the bridge's independent recovery/blocking evidence.

```text
userData/sessions/<local-id>/
  events.jsonl          append-oriented tool/turn/error/progress evidence
  messages/*.json       one atomically replaceable shard per logical native message
  messages.json         legacy map, read during lazy migration
  meta.json             recoverable projection plus durable ownership/project facts
  meta.backup.json      last validated metadata checkpoint
  plan.json             current agent-maintained plan
  assets/               bounded binary and overflow material
  handoffs/             exact captured briefs and provenance
```

The store has three write semantics. Structured events serialize sequence assignment → complete
append → memory projection, sealing torn final JSONL lines before later append. Canonical messages
replace stable identities by temp→rename, never regress final to streaming, and retain original
chronological anchors across revisions. Metadata coalesces ordinary updates but writes immediately
at ownership boundaries; it can rebuild history-derived fields without inventing an empty session
when recovery lacks proof. Legacy files overlay lazily rather than triggering a whole-history rewrite.

Native image-only user messages keep their exact message identity, empty authored text and
bounded attachment metadata. They participate in the same turn/receipt chronology as text and
render an attachment placeholder immediately. Native metadata grants no local file custody;
later browser observations must preserve an app outbox's staged attachment ids and previews.

Reads join only the relevant session's committed queue. `readActivityEvents()` does not flush
every dirty metadata row. A reopened session hydrates a bounded journal tail; append tail and
canonical map serve revisions/cursors. `tailFrom` states proven coverage and cannot be lowered
by an older canonical message across a missing journal range.

`shared/chronology.ts` orders by canonical origin before revision sequence. `foldProgress`
updates one namespaced progress/message identity in its original place. A HTML refresh of an
old worker final must not put a revived worker to sleep. Unknown identity is never folded by
similar text, time or display position. Recovery messages use this same projection mechanism.

Unattributed is a first-class recorded state. Late exact proof repairs only matching call ids
to the proved session epoch, copying assets first and rewriting only the scanned source prefix
while retaining concurrent appends. Restore/repair uses the uncapped catalog and a bounded
derived bucket cache. A superseded-source refusal remains terminally isolated from live B.

Native tab closure does not synthesize a completed turn. Reload recovery can close a durable
open turn only from an exact final for that turn, using the canonical message's stored owner
even when the reloaded page loses or replaces its turn id. The store-owned `finalContentSeq`
advances only for final text/state changes; HTML, timestamps and other metadata cannot turn an
old final into a new completion. Legacy rows retain their first anchor until fresh final content.
That content revision must follow the latest recorded work boundary, with no running local tool
or newer user/turn overriding it, independently of observation order within a browser batch.
Replay lifecycle boundaries in publication sequence; display chronology must not erase an
app-authored reopen after an earlier completed end. Restore the current generation by that
same replay: a new start replaces the active turn, and its exact end clears it. An older
turn with a missing end remains history and cannot become active again after a later turn
finishes, including when the user repeatedly closes and revisits the chat.
A same-request call that **starts after** a
reported completed end can prove the page ended it falsely; recorder reopens that turn and
retires the corresponding Goal attempt. A call started before the end, a new request or a
manual Stop cannot be used as that proof. This reopen evidence is process-local.

Large text has distinct inline/overflow/asset/read/render limits. Do not silently shorten
authored history to fix the UI. Asset quotas and explicit overflow ceilings remain enforced;
if earlier recording already lost content, expose that loss. Retention runs once on startup
and every six hours using current settings, even when new recording is Off.
Image asset admission failures preserve the original MCP response and tool outcome. The recorder
adds a bounded, path-free warning to the existing activity summary, including quota exhaustion;
older successful `view_image` rows without assets explicitly show that no preview was retained.
Neither a saved preview nor a local HTTP completion proves remote model comprehension.

### Two history consumers

The model's `session` tool has exactly `search` and `read`, with explicit local `session_id`.
Cross-chat and concurrent-worker reads are supported. Snapshot cursors pin sequence boundaries;
update cursors carry unfinished assistant-prefix checkpoints and report replacement when the
prefix changed; `T…` detail cursors page exact tool args/results with a pinned hash. Budget
cursor/footer space first and never truncate a cursor or silently skip authored text. Self-reads
are recorded for audit but omitted from this tool's own history/search projection.

Desktop session lists use stable `(updatedAt,id)` pagination. Timeline first loads a recent
tail, pages older/newer on deliberate scrolling, keeps a bounded 160-row window and viewport
anchor, and offers Back to latest. Historical browsing does not silently evict the user's
place on live updates; controls remain live. Selection generation fences every async page.
Expanded tool arguments/results and Compact & Resume content use the chat pane's vertical
scrolling, without nested vertical text scrollers. Streaming compaction revisions retain the
disclosure and unchanged sections; the timeline owner preserves the visible row or follows
the bottom only when the reader was already there. Collapsed bodies leave layout entirely.

### Context pressure and Usage are different measurements

Session `contextTokens` estimates current frontend pressure and resets at durable A→B rebind.
Lifetime `estimatedTokens` retains historical work. These are app estimates, not ChatGPT's
private context meter; the composer ring must say so. Exact Pro has a static pressure display
and is excluded from automatic compaction; manual compaction remains a separate action.

`extension/usage.js` observes bounded allowed account-usage responses in MAIN world, including
already available state; it does not retain raw account payloads. App `session/usage.ts` accepts
one fresh validated snapshot, replaces rather than merges accounts/tabs, and distinguishes
model, shared and feature pools. Missing/expired values mean unreported, never zero/full.

Daily work/cost charts use a **local estimate**: cap final frontend context, then / 2 per unique
recorded tool call, with editable divisor, multiplier and per-model comparison rates. If the
observed account catalog offers any Pro model or Pro reasoning option, the cap is 400,000 for
all models; otherwise it is 256,000. Historical usage alone does not establish availability.
This billing policy neither changes recorded context/compaction nor claims a provider input
limit. Cap each frontend before aggregation, never the daily/model totals. The selected cap
belongs to the Usage snapshot and cache revision; availability changes invalidate old totals.
Model changes affect attribution; compaction starts another frontend segment. Duplicate call
ids do not count twice. Historical rows without model proof carry an explicitly assumed legacy
model. Canonical revision/timezone-keyed `usage-cache` avoids rereading unchanged transcripts;
formula changes only project cached totals. Startup warms this same cache once without awaiting
it; a Usage visit joins the in-flight calculation. Only changed sessions are read, sequentially
with an event-loop yield between reads, and quitting cancels the warmup before cache publication.
The loading message explains a potentially slow post-update rebuild and that the app remains usable.
These charts are not a provider invoice, exact
token consumption or proof of current prices/entitlements.

## 13. Extension, account models and browser preferences

**Intent:** make native ChatGPT observable and controllable for an exact authorized operation,
while leaving ChatGPT's messages, model execution and account permissions with the provider.

| Component | Responsibility |
| --- | --- |
| `chatgpt-dom.js` | All provider selectors and DOM-shape assumptions, composer/upload/model/turn primitives. |
| `fiber.js` | Bounded MAIN-world React evidence: messages, request ids, generation/model state and installed connector declarations. |
| `usage.js` | Bounded account-usage and exact live stream request-origin observation. |
| `content.js` | Isolated-world recording, exact turn/navigation ownership, input/command execution, native-page companion UI. |
| `background.js` | MV3 journal and HTTP transport, tab/document registry, command elections and durable ACK custody. |
| `popup.*`, `overlay.css` | Pair/reconnect status and extension-owned presentation; no local tool authority. |

Content↔MAIN messages need the expected source, type, nonce and navigation epoch. MAIN evidence
is untrusted data, not instructions or filesystem permission. Prefer bounded observations of
the current document over repeated full Fiber/DOM scans. Shared selectors belong in the DOM
adapter; do not make each feature guess a different composer or terminal message.

The service worker journals observations before acknowledgement, batches/replays them after
suspension, and preserves event identity so retransmission does not create duplicate turns or
messages. Two transport slots, one batch per conversation and fair batch election prevent one
hot/stalled chat blocking another. Command ACK custody precedes later observations from that
route. Reconnection restores eligible documents before creating new work; browser restart is
a different lifetime from MV3 suspension (§2).

An idle composer or missing Stop button alone does not prove a completed answer. Turn state
combines native message/terminal evidence with exact user/assistant identities and live tools.
Interim prose, tool progress, refusal/error presentation, interrupted generation and final
completion remain distinct. Navigation first retires the old epoch; no late callback may record
or send for it. A settings overlay must not count as a usable hidden composer.
An exact terminal Fiber descriptor on the latest assistant turn also vetoes recovery of an
unrecorded generation from a persistent Stop control. An older terminal before a newer user
question grants no such veto; a presentation artifact must not mint another active turn.

Native Send/Stop controls belong to the current composer's form and must be rendered outside
transcript/extension surfaces. Hidden, inert or quoted controls grant no action; multiple Send
buttons are ambiguous. The existing transcript observer also follows composer-side relabel/hide
mutations so hidden tabs notice Stop transitions without waiting for a throttled timer.
Submission observes native Send readiness and acceptance within one 30-second deadline, freezes
the editor/text/document, and clicks once. It never substitutes synthetic Enter. Goal-token and
desktop-input authorization run when Send becomes ready, followed by a fresh local owner check.
Goal preparation/rollback reuses the existing exact composer draft lease; identical text in a
replacement editor or a user's intervening edit never grants cleanup authority.

### Account-evaluated model selection

`chat-models.ts` owns the app catalog and selection validation. The existing MAIN bridge reads
bounded account-evaluated metadata, then the native picker confirms the actual model/effort for
Send. A visible option, an English label, a remembered release name or “Upgrade required” is not
entitlement. Do not enumerate every model × effort or create helper tabs to compensate for an
uncertain catalog. Exact family rules live in `shared/chat-models.ts`.

Direct Chrome selection is observed even with the picker closed. The existing MAIN scan reads
the current native picker state, including September's retained `dropdownContent.props`, then
stamps exact model/effort and document/route for the isolated reader. The older closed-trigger
model/effort join remains supported. Ambiguous triggers and unrecognized state remain unknown.
Passive discovery copies only account-evaluated available choices from that snapshot and works
while a Pro turn runs or a draft exists; it never opens the menu, changes selection or clears text.
Older interfaces may use the existing idle-only picker inspection. OS wake is dispatch, not
discovery completion: the IPC request returns pending and the bounded observation deadline owns
the result, so a stalled launch cannot hold Refresh/Send indefinitely.

Successful catalogs retain their observation time and persist across restart. Discovery is a
bounded nonce-scoped operation (120 seconds, at most 20 accepted models); failed refresh leaves
the last successful catalog visibly distinguishable from a fresh observation. Cached metadata
is useful selection UI, not fresh send authorization. Model and reasoning selection must both
be confirmed after relevant native changes; navigation invalidates that confirmation.

Discovery elects an existing visible composer. An explicitly authorized helper may transfer
its still-empty document and opening authority to the first user input, rather than opening a
second tab. Startup's remaining unknown-catalog opening exception is a current gap in §21,
not permission to add more startup openers.

### Browser choice and opening discipline

`browser.ts`, `browser-preferences.ts` and `browser-startup.ts` keep the selected supported
Chromium browser/profile separate from ChatGPT account state. Use the selected browser's
process evidence; a disconnected bridge or sleeping MV3 socket does not prove it is closed.
OS wake launches require positive process absence and coalesce within one absence episode.
The socket is a heartbeat/wake path; HTTP remains command/evidence authority.

External navigation may hide its destination URL under ChatGPT-only host permissions.
A completed tab absent from a successful ChatGPT URL query can release the departed
conversation only while its original document, epoch and terminal lease still agree.
Loading alone and failed queries are not departure proof; replacement registration wins.
Each real active-chat departure remains independently eligible for existing recovery.

Browser-only preferences suppress automatic opening as defined by their owner. Background
operations reuse a suitable existing window unchanged. If a new background window is actually
authorized, its shared layout policy bounds it to 45% of the work area and 800×600, then
minimizes it. User-selected foreground actions retain their own intent. Window geometry,
process absence, tab election and provider hydration are different decisions.

### Overwrite and recovery presentation

Overwrite preserves native ChatGPT answer DOM, Markdown, code, citations and action controls.
The app inserts companion activity beside it. Hide a native tool/progress row only with complete
exact proof that the replacement covers it. Missing attribution must leave usable native UI.
Recovery status is one mutable chronological row even with Overwrite disabled, not a second
toast/history stream. Reused React nodes need strong message identity; request id, text and
position alone can span revisions. Update scoped sections instead of repainting the transcript
or scanning every historical message on each tool delta.

## 14. Bridge, durable browser commands and recovery

**Intent:** deliver one authorized operation to one exact document, survive transport loss,
and revive only work that remains owed. The bridge never grants arbitrary local tools.

`bridge.ts` owns the paired loopback HTTP boundary on 8765–8769; tests use isolated ports.
Silent `/pair` provisioning replaces the retired six-digit flow. Validate allowed extension
origin, bearer, payload bounds and operation identity. The wake socket only prompts maintenance.
Status, event upload, activity, claims, receipts and bounded attachment chunks have distinct
contracts; a successful status read is not proof that a browser action happened.

### Commands and receipts

The four command kinds are **worker, resume, revive and stop**. A command progresses from
durable intent to an exact tab/document lease, page execution, durable receipt and retirement.
`DurableCommandRecord` restores valid owner + `claimedAt`; it is not merely an unowned queue.
Command token, document id, navigation epoch, lease and underlying operation must all agree.

Opening authority is spent at handout, before asynchronous tab creation/hydration. An elected
tab that is loading, temporarily unreachable or user-closed does not authorize another opening.
Extension elections/opening checkpoints survive suspension; deferred command ACK custody also
survives browser restart. Persist receipt intent before removing the queue entry, and clear it
only after the app acknowledges it. A lost receipt must not repeat a potentially sent message.

Revival first queries/elects exact existing tabs. Query failure is unknown state, not an empty
tab list. An existing but not yet usable exact tab blocks replacement. Resume destination
election additionally obeys the continuation WAL (§15). `browserTabPolicy()` derives idle
eligibility from existing app ownership, settled turns or sleeping workers, work timestamps
and pending input/automation/continuation protection. Page presence never resets that clock.
After two quiet minutes an eligible ordinary/prime/sleeping-worker page can be used by the
existing New Chat input election; personal and dedicated decision chats are not candidates.
After five quiet minutes an unused app-owned page can close. Its durable history, worker
report and revival identity survive. The extension keeps the selected page during idle
cleanup, rechecks pins/selection/navigation after the page proof and refuses unread journals,
drafts, attachments or generation. Explicit terminal cleanup retains its two-minute grace;
superseded sources and duplicate documents keep their existing retirement rules.

### Recovery policy

`tabRecoveryWanted()` means **active Goal/Loop OR the user's recoverAgentTabs switch**. It gates
silence/no-tab recovery for workers, primes and ordinary chats. Reload repair for exact errors,
Unattributed incidents and compaction has its own evidence. “Recover agents” is not blanket
permission to reopen the session list. A plain historical chat with no current work is unprotected.

| Trigger | Required meaning |
| --- | --- |
| Missing tab | Current non-retired binding plus still-owed/live work and recovery policy; ordinary chats need recorded tool work, workers use broker attachment state. |
| Page silence | Known live activity with model-specific deadline; a live local process and browser liveness are different facts. |
| Assistant error | Exact turn/error, per-turn retry budget and cooldown; repair the broken page without fabricating a new task. |
| Unattributed | A separate unresolved incident after attribution has landed; re-observe suspects, never assign ownership by proximity. |
| Goal watch | One qualified waiting episode for an eligible exact source turn and still-active obligation; opted-in Pro Loop uses a ten-minute floor. |
| Compaction pickup | A durable continuation ticket whose current transport phase allows that pickup. |

Unattributed recovery uses staged 0/30/60-second incident deadlines according to live suspects;
these are separate from the recorder's 20-second request-id grace. Proven correlation dismisses
the matching incident. No request id means there is no attribution proof to wait for first.
Current repair cooldown is three minutes for Unattributed/assistant-error; silence, Goal,
compaction and no-tab are independently gated rather than sharing that cooldown.

Silence handling gives ordinary positively known non-Pro work a two-minute policy and Pro a
longer ten-minute evidence budget; unknown-model work remains conservative. A synthesized
continuation additionally needs exact durable source-turn proof. Reloading Pro can file the next
queued after-turn input under §11, or an opted-in Pro Loop ticket under §17. User inputs take
precedence. Goal's shorter watch is not a generic one-minute keepalive.
Publishing a repair wakes the extension over the existing authenticated socket; due repairs run
before window layout, input preparation and idle-tab pruning. The MV3 30-second maintenance
alarm remains a recovery cadence, not the normal pickup path.

The app keeps queued/handed/done repair evidence; `/status` returns all due eligible repairs.
Handout rechecks current binding, supersession, block and pending Stop. Extension maintenance
is single-flight with coalesced reruns, so wake/alarm/tab-close paths do not independently elect
the same work. The remaining handout-to-browser-action cancellation gap is called out in §21.
Trying → failed → later confirmed updates the same progress identity in the transcript.

### Stop and Block must retire the relevant authority

Stop turns automation off for that chat, cancels compaction/recovery intent, releases finish
holds and queues a bounded exact-turn native Stop command. Native confirmation is required;
the app does not manufacture a final answer. End turn only releases an Astra finish hold.
Stop elects an existing exact tab, including a loading document, or opens the missing chat
once under the same durable command. Its absolute two-minute deadline covers browser loading
without renewing on retries. Browser election is saved before opening; lost receipts, navigation
and user closure do not grant another opening for that command. A reopened page adopts the
pending Stop only after matching its original native question, and rechecks that identity before
clicking Stop. Newer questions never inherit the old Stop's authority.
Block persists the exact conversation's local-tool refusal across all MCP surfaces; only a
user release/deletion removes it. It does not remotely terminate ChatGPT or erase history.
Neither action may spill into another local session merely because labels or timing match.

## 15. Compact & Resume: same session, new frontend

**Intent:** preserve one local session S, its project, history, input queue, prime/worker family
and terminal custody while changing the provider binding **S: A → B**. Compaction is not a new
task and must not turn source A into an independently recoverable chat.

`session/continuation.ts` owns the transaction; `handoff.ts` validates the brief; `bridge.ts`
and the extension transport it. `resume-gate.ts` is a short pre-commit admission gate, not a
second continuation owner. The ledger phases are:

```text
awaiting-summary -> awaiting-chat -> claimed -> committing -> committed
       \------------------- pre-commit cancellation ------------> aborted
```

1. **Reserve A.** Persist an exact continuation token and source/session identity. Automatic
   compaction is level-based: current estimated context exceeds the threshold **and** the
   chat has live work. Idle old history does not start it. Workers and exact Pro are excluded
   from automatic compaction; workers do not self-compact, and Pro may compact manually.
2. **Ask for a brief safely.** Wait for running local tools, not the recorder's attribution
   tail. The source-tool fence prevents work continuing on A after handoff. Mark send attempt
   before clicking; attempted/dispatched/sent checkpoints are not interchangeable. Retry a
   known pre-dispatch failure, but never click again merely because the receipt is missing.
3. **Capture exact provenance.** Match the authored handoff request and assistant brief by
   token/message/turn identity. Enforce minimum and bounded brief content; do not capture the
   latest convenient assistant text. Preparing a brief does not yet publish a rebind.
4. **Elect B and commit.** Destination creation/claim has one opening owner. B must present
   the exact continuation context; early B observations are gated to prevent a shadow local
   session. Persist the committing decision, rebind S's metadata, then publish projections.
   **Durable metadata rebind is the point of no return.** Before it, failure leaves A current;
   after it, repair B's projections idempotently, never roll S back to A.
5. **Publish the same work.** Preserve project/cwd, broker role/family, history and queued
   input. Terminal custody already uses S, so no process-owner migration or adoption is
   needed. Move the objective and chat switch, retire A's execution authority, then retire
   its browser document only with fresh safe-close proof. B's first answer belongs to the
   exact resumed input, not to an old final from A.

Restart restoration must converge on that same committed projection. A persisted send attempt
can outlive a transport command; expiration releases transport, not permission for another
blind Send. Automatic tickets can wait indefinitely before the request was sent and retain a
six-hour sent-request window; manual transport is shorter (ten minutes). Pickup budgets depend
on phase: unsent 2m×5, writing 5m×3, opening 15m×3. These are bounded recovery of one obligation,
not fresh compaction attempts. Re-observe the exact page before advancing its state.

Before a pickup can Stop the original answer, refresh the ticket's source-send checkpoint.
An already dispatched or sent summary request can only be observed, never stopped by another
pickup. Keep the original user-message/turn identity across that await; repeated presses
must not revoke the operation already in flight.

The timeline keeps one Compact & Resume card for the marked token across late or refused
source calls. Later activity is not evidence that summary writing, saving or destination
opening failed. The exact summary turn's stopped/failed outcome interrupts its writing status;
recorded abandonment reports transaction failure. A saved handoff or matching resume supersedes
the earlier summary interruption. Commentary with another turn identity stays outside the summary.
The browser says writing only with current generation proof for the marked summary question;
a sent checkpoint alone means waiting. Bootstrap folds require the app's exact recorded opening
message id plus current route/epoch. Retired folds unwrap all native children and controls.

Native ChatGPT Project destinations enter through the source chat's exact native Project link.
The header alone is not readiness: `chatgpt-dom.js::enterProject` waits for the source editor
to be mounted, empty, idle and attachment-free before its one click. Source readiness and
replacement-editor navigation each have a bounded 12-second phase using the same observer/timer.
Destination proof requires the exact Project home, a different connected editor and no source
turns. User interaction, cancellation or a foreign route revokes the attempt; no extra tab or
second click compensates for a missing result.

The brief includes the original task, accepted steering, current result, remaining checks and
relevant durable ids. Linked project instructions and current executor settings still apply.
Goal context can use a committed handoff as a provenance anchor; aborted/stale/legacy text is
not one. A source reply obligation must be superseded when its work has moved, rather than
mistaken for B's completed turn (§21 records the remaining ledger gap).

Legacy shadow repair requires exact old continuation proof. It may repair missing projections;
it must not guess a new rebind, delete history or become the path for new continuations.

## 16. Multiple prime families and reusable workers

**Intent:** each prime can delegate bounded work to its own reusable workers while several
independent user tasks run at once. Inside a family the topology is a star: workers report to
their prime and cannot create worker descendants.

`agents.ts` is the one broker. Its run map and v6 `activeRuns` snapshot hold independent families;
`maxWorkers` applies **per family**, not to one global active run. Display names such as
`worker-1` are scoped by run incarnation/prime. Resolve a proven caller first, then its family;
never select the newest run globally. Workspace, inbox, activity and finish routing follow
that identity. Old single-active-run documentation is obsolete.

Worker model and reasoning belong to the user's saved app settings by default. Model-visible
instructions and the agents schema require omitting each override unless the user explicitly
requests it; do not ask for those settings merely to spawn. `agents.ts` resolves omitted fields
from current config at admission, so the executor need not know or repeat their concrete values.

Spawn validates capacity, objective/context, account-observed model/effort, workspace and role,
then durably reserves the worker before handing out browser work. Model checks precede every
batch mutation; unknown ids fail with observed choices. With no retained catalog, native
selection still must confirm the exact request. Shared context carries common project/instructions;
each worker gets its bounded assignment. Invitations, active workers,
detached workers and waking workers retain their reservation; sleeping workers do not occupy
an active slot. User/prime cancellation retires the exact incarnation, not a reused slot name.

`finish` normally stores a report and **sleeps** the worker for follow-up. Reuse a suitable
sleeping worker with `agents action=message` before spawning a replacement. Messaging, inbox
delivery and report receipts are at-least-once transports with durable message identities;
acknowledgement belongs to the exact recipient/run, not a UI read. Pending reports remain
available when the last worker sleeps and the family parks.

After a worker reaches its own 400k estimated-context ceiling, its next stop becomes terminal
and it is no longer reusable. Do not interrupt its current useful work merely for that ceiling.
Status/message remeasure sleepers before revival. A terminal worker can be replaced deliberately;
raising the user's worker cap is not a substitute for lifecycle correctness.

Detached means browser attachment is missing, not necessarily that tool execution died. An
exact call can prove the worker server-side alive; a new page can reattach it. During waking,
an already-alive proof may cancel an unclaimed reopen, but after handout the existing operation
owns delivery. A new accepted call/turn proves post-delivery activation. A replayed old final
must not put the revived worker back to sleep.

Broker mutations stage and durably publish the exact run object; async rollback must not
restore another family's state. Disable parks families; Clear deliberately discards the
broker's retained history/fences. Dormant families are bounded (16 / seven days). Retirement
and browser close are separate: a sleeping worker becomes eligible for page reuse after two
quiet minutes and page closure after five (§14), while remaining available for revival by its
exact conversation id. Compact & Resume rebinds a prime within its
family; it does not merge families or move a terminal process to another principal.

The app's configurable worker capacity is distinct from the coding agent's delegation policy
in §19. Do not infer permission to launch development subagents from a product feature toggle.

## 17. Goal and Loop: durable intent, replaceable decisions

**Intent:** preserve the original user task and accepted corrections, notice a legitimate
completion boundary, and decide whether another useful instruction is owed. Goal can stop
when its finish line is met. Loop continues improving/checking within that task until Off;
it must not invent an unrelated project just to keep generating.

`goal.ts` owns objectives, chat switches, reply obligations, helper roles and decision attempts.
`shared/goal.ts` owns bounded prompt/contracts; `goal.ts` projects applicability and the outbox
owns actual delivery. An objective, an enabled mode, an unfinished reply obligation,
a provider attempt and a browser send are five different facts.

### Modes, controls and boundaries

Per-chat explicit Off defeats an existing objective. Without an explicit override, effective
policy derives from the configured master/default and objective. Deliberate On rearms the
latest eligible stable reply with a new acceptance identity; Off retires that obligation and
its pending attempt. Objective text survives Off/completion for later reuse. Repeated On → Off
→ On → Off must operate on current durable authority, not an old callback's enabled snapshot.
Master Off clears ordinary chat overrides while keeping internal helper-role records.

Ordinary non-Pro Goal/Loop considers verified **completed final answers**, not interrupted
turns or generic composer idleness. Pro Loop defaults to **Only finish**. Its per-chat switch
can opt into **After this turn + finish**; the preference survives toggles, restart and resume.
Astra Goal remains finish-only. At `session_finish`, both modes use the Loop decision policy
and inject through the eligible tool response (§11).

Opted-in Pro Loop uses the existing Goal reply ledger for real finals, settled Thinking failed
(§11), and ten minutes of silence followed by an acknowledged refresh. Synthetic tickets require
the same current-turn MCP proof as after-turn input; no MCP means no synthetic reply debt.
They retain the exact source turn, work sequence and Pro policy. Native busy durably defers the same ticket
by five minutes, repeatedly if necessary. MCP/interim work revokes the ticket and pending draft
and rearms ten minutes; fresh work/queue priority and exact document/draft authority are checked
again before Send. The existing uncollected-ticket refresh schedule has a ten-minute floor for
this mode and respects its listening deadline. No second scheduler or outbox is introduced.
The default Loop instruction asks for substantial integrated work on large tasks and reconciles
recorded progress after a failed view; only exact shipped defaults migrate, preserving custom text.
Decision helpers/planners and workers cannot recursively start their own Goal/Loop driver.

Stop, block, replacement, a newer turn, mode/settings changes and input revision invalidate
stale decision attempts. User messages/checkpoints take precedence over generated continuation.
Validate the exact source turn, acceptance and current policy again at publication/delivery.
The completion of an HTTP/helper request alone never grants send authority.
Browser draft refusals retain their pickup claim. Read machine errors from the HTTP `data`
envelope or the transport's top-level failure, then use the existing delayed retry/backoff.
`chat_still_working` stays on Answer settling; rate limits and transport failures cannot
release the claim for every activity update to collect again. Off or a new pickup invalidates
the old delayed retry, and a settled refusal waits for a new authorized episode.

### Three backends, two different helper roles

| Backend/role | Behavior |
| --- | --- |
| ChatGPT decision helper | Default driver backend. One reusable helper per source session/role; receives reference history and outputs a decision, never executes that history. |
| API driver | OpenRouter-compatible default or explicit compatible endpoint/model/key. Supports bounded streamed progress and validated final decision. |
| Goal templates | Offline explicit terminal-marker policy; only Goal supports this backend. Missing/ambiguous expected markers pause rather than infer completion from prose. |
| Temporary planner | Captures a new workflow for the user, then retires with exact idle/draft proof; distinct from the persistent decision helper. |

Goal gate, objective and Loop prompts are separately configurable. Default helper selection is
Sol/high in the checked config, but live account metadata governs whether it can be used.
API model discovery is bounded and cached by endpoint/key; a list entry does not prove an
execution succeeded. Secrets remain in the main process's encrypted store. Custom endpoints
receive the explicitly assembled reference context; local recording is not a promise that
Goal API requests stay on the device.

The driver context includes canonical authored user messages, stable assistant interim/progress
and final text. Tool rows are opt-in (`includeToolCalls`, default Off); finish-control calls do
not recursively dominate the reference. Preserve original task/steering and committed handoff
provenance under the message budget. Helper prefix digests prove whether a bounded delta is
valid; changed history/instructions replace context in the same helper instead of spawning
another helper automatically. Clear temporary-planner answer content before durable state
publication; it is not a normal recorded executor task.

Provider progress updates one existing timeline row and is never sendable text. Validate the
final bounded decision schema before publication. Goal may return stop/no reply. Loop requires
a continuation and has a bounded three-retry invalid-stop policy. API SSE is used when publishing
progress; legacy plain streaming is compatibility handling, not another driver authority.
Cancellation/timeout must release only that exact attempt and leave an honest error/retry state.

Reply obligations are durable and bounded (12 hours / 200 rows) with handled tombstones so old
browser observations do not rearm discharged work. A provisional exact `turn:<id>` observation
can later gain durable event-sequence evidence. “Invalidating an attempt” must not silently mean
“the user's continuation is handled.” Current persistence/publication exceptions are in §21.

## 18. Desktop workspace, plugins, connection and native control

### Renderer and IPC

`renderer/main.ts` owns the shell/setup/settings; `chat.ts` owns sessions, composer and timeline.
Projects, workers, plans, model choice, usage and plugins have focused modules (§4). The renderer
calls a fixed `preload/index.ts` allowlist into validated `ipc.ts`/`plugins-ipc.ts` handlers.
No arbitrary IPC invocation, Node access, filesystem path opening or renderer-side secret store.
Pushes and async loads are scoped to selection/draft generation; a late load must not overwrite
focused edits or a newer A → B → A view.

The sidebar groups local projects/sessions, exposes worker state and retains deliberate width
and expansion preferences. The chat keeps the current input queue/plan visible alongside a
paged transcript. Main owns durable mutation acknowledgements; renderer optimism is not a
receipt. Native edit context menus respect the focused editable control and selection.

Session metadata owns `titleSource` (authored fallback, provider, manual). The preview uses only
the first authored user message, at one 80-character bound; injected instructions/AGENTS frames
never become preview text. `session/title.ts` supplies presentation and legacy recognition;
store serialization protects manual/origin names and current-conversation title observations.
Apply provider titles after the batch's messages, so a late receipt or title-first batch cannot
strand a preview. Cold reads repair legacy context previews from canonical authored history.

Captured ChatGPT HTML passes a strict allowlist; authored plain text stays text. Provider
citation ranges use Unicode code points and map to UTF-16 before slicing. Exact uploaded-file
names render as plain chips; unresolved file citations do not gain invented local links.
Tool result rendering preserves structured text/image/resource distinctions within bounds.
App-owned external/local links cross their validated main-process route.

English and Simplified Chinese are explicit UI translations (`i18n.ts`, `locales/zh-CN.json`),
with the selected locale in `cos.ui.language`. Changing language repaints owned labels while
retaining drafts/selections; never translate authored messages, provider text or file paths.
Authored prose uses automatic text direction; shell/code remain LTR with logical layout edges.
Theme and layout preferences do not change backend authority.

`renderer/plugin-refresh-reminder.ts` owns the chat-header reminder to refresh plugins
in ChatGPT. Its X stores only the acknowledged running `state.update.current` version in
`cos.plugins.refreshReminder.dismissedVersion`; downloading a newer version does not rearm
it. No acknowledgement shows the reminder, including the first version with this feature.
It survives restart until dismissed, returns for a different running version and is hidden
in Settings. It stacks with update/extension notices and never marks an actual connector
refresh complete or starts a browser action.

### Plugins: installation, execution and connector refresh

The optional Plugins connector proxies installed enabled MCP servers. `catalog.ts` describes
reviewed entries; `installer.ts` owns installation/package materialization; `manager.ts` owns
stdio/remote clients; `exposure.ts` owns accepted live tools; `oauth.ts` owns authorization.
Local npm/Python/MCPB packages and remote endpoints have different setup needs. Editor plugins
such as Blender also need the editor-side addon and a successful readiness probe.

Enabled installations restore/connect in the background and remain available while idle; there
is no idle-eviction/restart loop. Disable/uninstall revokes exposure synchronously before slow
shutdown. Accept bounded validated schemas (up to 64 tools, bounded schema bytes), preserve
upstream names, and fail closed on collisions, including retained disabled-name claims. A
cached unauthorized schema is not live exposure. External servers retain their own OS/account
permissions; the app's approved-path wrapper is not an OS sandbox around a third-party process.

Remote OAuth uses endpoint-scoped encrypted credentials and SDK registration/PKCE/refresh.
Only explicit sign-in opens the browser/loopback authorization flow; ordinary reconnect does
not auto-register or open login pages. Local status/probe, installed, enabled, authenticated,
editor-ready and published are distinct states. Do not repeat an ambiguous mutating tool call
just because a remote connection dropped. Sanitize returned/logged credentials at the boundary
without silently changing authored tool arguments or corrupting opaque image bytes.
Official npm Playwright defaults to upstream `PLAYWRIGHT_MCP_CODEGEN=none`; explicit launch
configuration takes precedence. Redaction covers recognizable credentials in results, recorded
arguments and overflow assets; manager and dispatcher must not repeatedly sanitize the same body.

The Plugins UI keeps an unconfigured setup card prominent and projects a compact setup row
once saved tunnel identity or a live endpoint exists, including offline restarts. It persistently
explains that ChatGPT must refresh its connector after installation/tool changes. Checking local
status cannot refresh ChatGPT's cached declarations.

`plugin-refresh.ts` applies to Core, Desktop and Plugins. Its fingerprint includes names,
descriptions and input schemas, not app-version/instruction churn. Changes debounce for 20s.
Refresh targets the exact account-observed installed app id, durably claims before clicking,
and completes only after observed declarations fully match. Automatic refresh is opt-in;
unsupported/manual-required stays visible instead of opening more helper tabs.

### Connections, tunnels and diagnostics

`connection.ts` serializes endpoint/tunnel generations and publishes only live eligible surfaces.
Approved-root requirements are surface/capability decisions, not whether the extension paired.
Separate local listener health, public tunnel reachability, ChatGPT connector configuration and
browser attachment in both status and diagnosis. Stale connect/disconnect results cannot replace
a newer endpoint. Secret paths/tokens are not public diagnostics.

`tunnel/*` owns pinned-client discovery, child lifetime, health metrics and confirmed outages;
`diagnostics.ts` tests the chain hop by hop. Transient health evidence must not produce repeated
replacement tunnels or claim a broken provider was repaired. Update checks (§20), browser wake
and MCP connection have separate lifecycles.

### Native Desktop

Desktop is available only on Windows and supported macOS. Linux removes it from live discovery
and enforcement while preserving stored preferences. Windows uses the bounded PowerShell/Win32/
UIA helper; macOS uses Swift ScreenCaptureKit/AX/CGEvent through an architecture-matched N-API
addon on an Electron worker. The packaged Electron app is the macOS permission subject; a
standalone CLI probe does not prove Screen Recording/Accessibility permission for the app.

`computer/index.ts` owns native actions, capture frames/accessibility refs, batching and
postconditions. Registrars own live capability checks. Windows `windows-api.ts` implements the
13 Window2 methods: `list_windows`, `get_window`, `list_apps`, `launch_app`, `get_window_state`,
`click`, `press_key`, `type_text`, `scroll`, `set_value`, `drag`, `perform_secondary_action`,
`activate_window`. The old `observe`/`computer` wrapper is macOS-only. Windows observation state
is bounded per exact caller or a separate shared unattributed context when explicitly allowed,
contains no pixels/text, and input consumes its indexes/geometry. Identified and unattributed
calls never borrow each other's observations. Opted-out anonymous calls discard that context
and refuse indexed/coordinate input.
Explicit activation consumes observation state too; ordinary input already activates its target.
Late observations and replaced principals cannot lend another call their state.
Observe → act uses exact frame/ref, target geometry and
helper generation. Recheck those after asynchronous image work and before every local action
in a batch. A replaced helper/window/display invalidates old coordinates and refs. Bound
decoded images, report actual visible crops, and never label a visible screen crop as a hidden
window capture. Coordinate clamping and physical input respect the current display/button map.

Windows uses source-owned Windows.Graphics.Capture for exact HWND compositor pixels, including
covered GPU windows, without activation or a visible-screen fallback. Minimized/unavailable
capture fails explicitly. DWM image bounds and outer window geometry have distinct roles.
Before starting a window capture, the optional `IGraphicsCaptureSession3` interface disables
the capture border so individual screenshots do not flash a yellow outline. Older Windows
without that interface retains its system indicator; permissions and capture failures remain
Windows-owned. `scripts/verify-windows-capture-border.mjs` compares visible control/production
borders and the missing-interface case using an owned fixture on an unlocked Windows 11 desktop.
Screenshot observations default to optional UIA off; `include_text` adds indexed accessibility,
advertised semantic actions, bounded document/selection text and focused control. Up to three provably owned popup
windows have separate images/frames; same process alone is insufficient ownership evidence.
Public state retains observed window focus, accessibility truncation and provider failures;
frame ids/dimensions precede long accessibility text. Pixels appear once in native MCP image
blocks, never duplicated as data URLs in `structuredContent.value`. A text-provider failure
preserves a usable screenshot and its explicit diagnostic. Offscreen/disabled controls are marked.

For Chromium browser windows, `BrowserRootView` owns the current accessibility tree, including
the address bar and displayed document. Legacy renderer HWNDs can expose old tabs with plausible
bounds and `IsOffscreen=false`; they are not alternative observation roots. Missing/ambiguous
browser roots fail text observation explicitly. Before semantic input, the cached element must
still descend from the same current UI root; liveness of an old tab's provider alone is insufficient.
Document text selects one provider within the existing bounded traversal, preferring a Document
over native editors. Browser toolbar editors never supply page text; an unobserved page leaves
document text absent. Native apps retain editor text when no Document provider is observed.
Read document/selection text once under their shared 8,000-character budget.

Windows physical input requires a returned Window `{app,id,title?}` and activates/checks it before
each action. App identity, pixel frames and refs must match that target; popup input rechecks its
original native owner. Public coordinates are pixels within the selected returned screenshot;
its declared dimensions match its PNG. The existing native frame owner converts through the
capture origin/scale without a second facade DPI conversion. Named punctuation follows the target
thread's keyboard layout, clicks support counts 1–3, and drags interpolate over a bounded duration.
Multiline text uses the existing Electron clipboard owner and targeted paste, with clipboard-write
permission checked before the batch. Native Unicode typing refuses multiline text before input.
Paste verifies target activation before replacing the clipboard and checks focus again at
physical injection. Activation uses bounded actual foreground observation after one attempt;
an immediate Windows return value alone cannot establish the result.
UIA actions resolve exact snapshot refs without a physical fallback for unsupported patterns.
App enumeration joins installed and running apps only by exact native AUMID or executable path,
including their windows and observed running status. Launch accepts a Shell app ID or explicit
`.exe` path/PATH application name without arguments. Launch acknowledgement requires later
observation to prove a window opened. Wheel input preserves raw deltas (120 per detent).

The Windows helper owns a unique temporary UTF-8 script file for its process lifetime, starts
with a process-scoped execution policy, and removes it on retirement. Native source stays out
of inherited environment blocks; streamed UTF-8 replies preserve split multibyte characters.

Focus/clipboard/input are real native effects. Validate target and action permission, retain
partial-batch outcomes, and report postcondition failure rather than invent success. The
browser-chord policy prevents tab/window management through forbidden input chords; address-bar
focus chords support authorized navigation, like clicking or setting that same native control;
it is not a general browser automation fallback. Capture/privacy settings and platform permission
failures remain explicit, with no Linux/helper fallback that bypasses the capability model.

## 19. Debugging, tests and working here

Before editing, inspect `git status --short` and `git diff -- <intended files>`. Reproduce one
concrete identity through the relevant owners. State the intended behavior and the first wrong
transition, then repair that owner. For a race, pause A before publication, complete B, resume A
and prove it cannot overwrite/resurrect B. Prefer exact epochs/receipts and serialized semantic
mutations over sleeps. Add a meaningful regression for production behavior, including the
neighboring negative case; documentation-only changes need documentation checks instead.

Browser-facing fixes require hands-on work in the real signed-in ChatGPT page. Inspect the
current native DOM, editor and turn evidence before designing a fix; do not infer provider
behavior from mocks or old selectors. Reproduce briefly, repair the earliest wrong boundary,
then reload the changed extension/install the changed app and repeat the real user flow.
During broad acceptance, rotate through compaction, workers, Desktop input, native images and
transcript/turn start-and-finish behavior. Pass concrete failures to bounded fix workers while
continuing other checks. Reduce a repeated failure to a short reproduction instead of spending
the whole run replaying one long workflow; avoid optimizing speculative edge cases.

| Symptom / boundary | Open first | Nearest `test/*.test.ts` families |
| --- | --- | --- |
| Wrong chat, Unattributed, false tool failure | kernel → correlation → recorder | `mcp`, `correlation`, `attribution-repair`, `call-context`, `mcp-inflight` |
| Wrong path/project or cross-worker terminal | sandbox/workspace/projects → kernel/ownership | `sandbox`, `projects`, `kernel-project-workspace`, `workspace`, `swarm`, `codex-runtime-parity` |
| Missing/duplicate input, attachments or checkpoints | input → bridge → DOM/receipts | `session-input*`, `input-delivery-integration`, `finish-input-integration`, `task-request`, `chatgpt-dom-input` |
| Worker family/slot/inbox/revival | agents → bridge → background | `agents`, `kernel-run-inbox`, `agent-communication`, `swarm`, `extension` |
| Unexpected tab/reload/model/refresh | operation owner → browser election → native observation | `bridge*`, `browser*`, `extension`, `content-script`, `model-*`, `plugin-refresh*` |
| Lost compaction or Goal debt | continuation/goal → store → bridge | `continuation`, `resume`, `goal*`, `session-finish` |
| Transcript order, UI clobber, usage | store/chronology → IPC → renderer | `session`, `chronology`, `renderer-*`, `timeline-scroll`, `session-usage`, `usage-observer` |
| Files/patch/output/code-mode | concrete tool owner → kernel serialization | `codex-*`, `exec-*`, `code-mode-*`, `mcp-tool-declarations`, `artifact-download` |
| Plugins/auth/native Desktop | manager/exposure/OAuth or computer frame owner | `plugins-*`, `computer*`, `tools-desktop-*`, `macos-*` |
| Startup/connection/shipping | lifecycle/config/connection or packaging script | `config`, `window-*`, `shutdown`, `tunnel*`, `packaging`, `update`, `third-party-notices` |

Discover current suites with `rg --files test`; do not maintain a stale suite count. Validate
both ends of every changed protocol: app↔extension, content↔MAIN, main↔preload↔renderer,
schema↔handler↔recorder and durable write↔restore. Run the nearest suites, adjacent boundary
tests and `npm run verify` for production edits. Build/package when that layer can differ.

```sh
npm run dev
npm run typecheck
npm test -- --run test/<target>.test.ts
npm run verify:privacy
npm run verify:notices
npm run verify
npm run build
npm run dist                       # current OS, x64 + arm64
npm run dist:dir:mac:x64            # example unpacked target on a matching host
```

Use `npm ci` for an intentionally needed reproducible dependency install, not as routine
cleanup of this shared tree. `verify:ci` fetches rg, checks privacy/notices/native-source metadata,
typechecks, verifies Electron resolves, runs Vitest excluding `mcp-shutdown`, then runs that
socket-drain suite alone. `vitest.config.ts` forces Node, bounded hooks/tests, `CLF_BRIDGE_PORTS=0`
and test-only `CLF_EVIDENCE_MS=1500`; never let tests contact the installed production bridge.
Opt-in live plugin/macOS probes are separate evidence, not implied by the ordinary suite.

When delegation is authorized, reuse a suitable worker. Give each assignment the project,
concrete task, evidence, allowed files, ownership boundaries, checks and expected handoff.
Use at most two direct development subagents concurrently and explicitly prohibit nested
delegation. Audit-only means no source/test/config/AppData writes beyond the named report.
The prime independently verifies important claims; parallel reports are hypotheses, not votes.

Record changes and actual checks in a focused worklog. Keep security reproductions/private
session material out of public docs and fixtures; follow `SECURITY.md`. Do not package, install,
commit or publish merely because a source/documentation task was requested.

Runtime data is under Electron userData: `%APPDATA%/chat-on-steroids` on Windows,
`~/Library/Application Support/chat-on-steroids` on macOS and the XDG config location on Linux.
Inspect exact session/state files (§4), never edit live ledgers as a repair shortcut. `logger.ts`
keeps a redacted 500-entry ring and bounded async `app.log` batches with rotation, explicit
overload omissions, a two-second final flush and separate `.crash` snapshot. Logs are human
diagnostics, not restart authority; secrets must never be printed to investigate a connection.

## 20. Build, installation, updater and release

Source, bundle, package, installed bytes and live behavior are separate gates (§3). The app id
is `com.chatonsteroids.app`. Native release targets are Windows x64/arm64 NSIS, macOS x64/arm64
DMG+ZIP and Linux x64/arm64 AppImage+DEB. Windows is per-user-capable and `asInvoker`; replacing
the package preserves userData. Synchronize package/main/extension versions deliberately.

`electron-vite` builds main/preload/renderer into `out/`; extension files ship directly without
a bundler. `electron-builder.yml` puts executable tunnel/rg, extension and required native
payloads outside asar. `extension-path.ts` transactionally mirrors the packaged extension to
stable `userData/extension`, never an ephemeral AppImage mount.

| Build owner | Contract |
| --- | --- |
| `scripts/package.mjs` | Icons → bundle → explicit target resources/native staging → builder with publishing disabled. |
| `packaging-targets.mjs`, `packaging-versions.mjs` | Supported OS/arch vocabulary and pinned target checksums; fetchers share these authorities. |
| `prepare-packaging-native.mjs` | Exact target node-pty/Sharp/tree-sitter from verified package material; host leftovers cannot win. |
| `prepare-macos-desktop-helper.mjs` | Thin target Swift dylib + matching N-API addon; packaged in-process permission identity. |
| `smoke-packaged-runtime.mjs`, `smoke-macos-{bundle,gui}.mjs` | In-place resource/native-stack checks, Mac bundle/seal and real GUI startup evidence. |
| `generate-third-party-notices.mjs`, `package-native-sources.mjs` | Production notices and corresponding native source inventory/archive; exact lockfile/catalog provenance. |
| `verify-public-history.mjs`, `check-release-absent.mjs` | Public-history/privacy gate and positive proof that publishing will not overwrite a release. |

Generated resources are outputs; change their pin/source/script and regenerate instead of
hand-editing staged binaries. Native and editor dependencies need actual runtime proof. For
“install newest”, rebuild the current authorized tree, compare installed payload hashes to the
package, and verify that runtime's relevant flow. An installer exit code or version label is
insufficient. A dirty-tree snapshot request does not authorize exposing all local Git history.

`update.ts` checks immediately and every six hours with one in-flight pass. Download to a
partial file, verify SHA-256 before staging/adoption, and rehash at ordinary quit before handing
off. Windows NSIS/Linux AppImage can apply automatically; macOS/DEB present the supported manual
path, development does not stage. Explicit install may relaunch; ordinary quit does not force
relaunch. Failed checks never replace a verified staged candidate with unverified bytes.

CI verifies supported OS families; native `release.yml` builds/smokes all six targets, then
assembles installers, extension ZIP, native-sources archive and `SHA256SUMS.txt`. `publish.yml`
is dispatched **at the reviewed version tag**, calls that reusable build in the same run,
requires `docs/release-notes/vX.Y.Z.md`, rechecks versions/privacy/hashes and refuses an existing
release. A tag alone does not build/publish. An unpublished candidate can be built separately,
but do not mix artifacts from another ref/run into a release.

`verify:notices` checks installed production dependencies against the lockfile and rejects
missing license material or mismatched reviewed catalog hashes. Custom package updates cannot
inherit an older license review. Notice completeness and native source/replacement obligations
are separate checks; inspect the actual assembled artifacts. Hooks installed with
`npm run hooks:install` help keep personal identities/session provenance out of public history.
Release completion requires every target, assembly/hash check, Publish and public artifact
inspection to pass, preserving the user's exact requested title/changelog.

## 21. Known implementation gaps — not intended behavior

These are source-level discrepancies checked for this map, not new live reproductions or
permission for an unsolicited rewrite. Recheck current code/tests before acting; another
shared-tree change may already have addressed them.

- **Startup opening:** `index.ts` still calls `startChatModelDiscovery(true)` on window show
  when the catalog is unknown. Desired policy requires a concrete operation to own any new
  browser document; app opening alone must not become a fallback opener.
- **Repair handout vs action:** `/status` marks eligible repairs handed before extension tab
  query/action. The extension now has single-flight maintenance and the app checks current
  binding/block/Stop at handout, but no final atomic action claim closes cancellation after
  handout. Intent requires the browser action to retain current authority through that boundary.
- **Goal publication:** explicit switch writes serialize, but mutate shared memory before
  the awaited durable write; synchronous clear/move paths and objective/reply mutations do not
  all share the same semantic transaction. Intent is durable commit before visible state, with
  rollback unable to overwrite a newer accepted change.
- **Goal retirement scope:** master/config/secret changes cross separate ledgers, and
  `retireGoalDrafts()` marks reply debt handled while cancelling attempts. Recording Off also
  lacks a uniform runtime gate for retained per-chat overrides. Invalidating a provider attempt
  must preserve any still-owed eligible continuation and respect effective current settings.
- **Provisional Goal restart:** live exact `turn:<id>` debt can begin with `eventSeq=0`, while
  reply restore rejects sequences below 1. The accepted identity should survive until durable
  turn evidence strengthens it, without losing or duplicating the obligation on restart.
- **Resume projections and Goal debt:** normal commit and restored committed-B projection
  still duplicate parts of the repair path. Objective/switch move, but source reply-ledger
  disposition is absent. Current watchdog checks already fence superseded A; do not claim the
  old historical-A reopening bug is unconditionally present. Intent is one idempotent committed
  projection and explicit supersession of A's debt, never treating it as B's completed turn.

Do not restore obsolete claims while investigating: two MCP surfaces, one global prime run,
fresh `saveArtifact=false`, three browser command kinds, fixed 60s Unattributed repair, tab-query
failure as “no tabs”, missing all-repair handout, or no maintenance single-flight. The checked
tree has changed those contracts. Comments/worklogs can lag even when nearby code is current.

## 22. Completion and maintaining this map

A production change is complete when its root failure and neighboring negative case are
covered, all protocol participants agree, relevant checks pass, and the claimed evidence level
is actually demonstrated. Preserve unrelated dirty work. Update model-visible contracts,
user-facing behavior and this map together; do not call source success a live hotfix.

Keep this file self-contained: explain purpose → user behavior → owner/flow → invariants →
failure/test entry points. Integrate changed logic into its owning section instead of appending
an unrelated rule at the end. Remove obsolete descriptions and resolved gap entries. Prefer
owners and bounded contracts over volatile counts, copied worklogs and duplicated implementation
detail. A new durable fact must have one named owner, lifetime and publication boundary.
