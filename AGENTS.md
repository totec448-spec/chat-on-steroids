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

Source alignment: **2026-09-16**, including the local stability candidate. App/extension **2.1.13**,
bridge protocol **14** in the checked declarations (`package.json`, `src/main/version.ts`,
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
  checks remain mandatory; selected or recently accessed Chrome tabs veto idle closure, and pins veto closure and
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
| Tool capabilities | Current `defaultConfig()` starts all Core capability flags on; read-only off. | Omitted legacy flags use conservative `DEFAULT_CAPABILITIES`. Malformed existing config is conservative recovery, not fresh consent. |
| Recording | On, 30-day retention. | Explicit Off stays Off; retention still applies to old history. |
| Context / compaction | Advisory 400,000; limit rounded from advisory × 4/3; auto-compaction on at advisory. | Estimated local units. Automatic execution additionally requires live work, current ownership and eligible model/role. |
| Multi-agent | On, 2 simultaneous slot-holding workers **per family**, configured hard max 8. | Legacy absent enabled/allow-unattributed fields remain false. Existing choices stay exact. |
| Unattributed allowance | True on first launch. | Relaxes ambiguity fences only; known blocked/retired/superseded ownership stays enforced. |
| Recover ordinary/agent tabs | Off. | Goal/Loop can independently justify recovery; history alone cannot. |
| Automatic Continue | On. | Unfinished-response recovery also serves enabled Goal/Loop. This switch controls ordinary chats; explicit Off survives and malformed config disables it. See §14. |
| Goal / Loop | Off, preferred mode Goal. Both decision backends default to ChatGPT, helper `gpt-5.6-sol` High. | API uses the configured OpenRouter/custom endpoint and stored model. These defaults are not account-availability proof. |
| Desktop | Windows on; macOS retains its off default and separate native OS consent; Linux supports extension browser control. | Existing screen/control grants also govern browser tools; unsupported native clipboard remains masked. No new per-tab permission dialog. |
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
| Projects/cwd | `src/main/projects.ts`, `workspace.ts`, `src/shared/projects.ts`: explicit local folder catalog, session binding, inherited/learned workspaces. |
| Project Files UI | `src/main/project-files.ts`, `project-file-watcher.ts`, `src/shared/project-files.ts`, `src/renderer/{file-panel,file-code-editor,file-pdf-viewer,work-panel-resize}.ts`: bounded project views, revision-checked saves and renderer-owned drafts. |
| Durable history | `src/main/session/{store,recorder,correlation,retention,summarize,progress}.ts`, `src/shared/{session,chronology}.ts`: canonical messages, tool truth, chronology and indexes. |
| Input | `src/main/session/{input,start-input,input-history,input-attachments,input-images,prompt}.ts`, `src/shared/{input,user-prompt}.ts`: outbox, native files, prompt frame and receipts. |
| Finish/planning | `src/main/session/finish.ts`, `task-request.ts`, `goal.ts`, `src/shared/{finish,task-progress}.ts`: held turn, decision/plan invocation and cancellation. |
| Continuation | `src/main/session/{continuation,resume-gate,handoff,handoff-prompt}.ts`: A→B transaction, send ambiguity and exact brief. |
| Automation | `src/main/goal.ts`, `src/shared/{goal,goal-templates}.ts`: objectives, switches, obligations, provider/helper decisions. |
| Agents | `src/main/agents.ts`, `src/renderer/{agent-panel,agent-communication}.ts`: independent prime families, staged mutations and addressed messages. |
| Browser orchestration | `src/main/bridge.ts`, `browser.ts`, `browser-startup.ts`, `browser-wake.ts`, `browser-window-layout.ts`, `browser-preferences.ts`; `src/shared/browser-preferences.ts`. |
| Extension | `extension/{manifest.json,chatgpt-dom.js,content.js,fiber.js,background.js,usage.js,overlay.css,popup.html,popup.css,popup.js}`: injection worlds, native observations/actions, journal and UI. |
| Models/usage | `src/main/chat-models.ts`, `session/usage.ts`; `src/shared/{chat-models,usage}.ts`; `src/renderer/{chat-models,context-meter,usage}.ts`: account observations vs local estimates. |
| External plugins | `src/main/plugins/{catalog,installer,manager,exposure,oauth}.ts`, `plugins-ipc.ts`, `plugin-refresh.ts`, `src/shared/{plugins,plugin-refresh}.ts`, `src/renderer/plugins.ts`. |
| Renderer boundary | `src/main/ipc.ts`, `edit-context-menu.ts`, `src/preload/index.ts`; `src/renderer/{main,chat,dom,tool-result,timeline-scroll,sidebar-resize,browser-preferences,connection-popover,i18n}.ts`, `locales/{es,zh-CN}.json`, `index.html`, `styles.css`. |
| Appearance | `src/shared/appearance.ts`, `src/main/appearance-schema.ts`, `src/renderer/appearance.ts`: bounded saved colors/typography, field-wise Settings merge, immediate semantic CSS projection. `window-layout.ts` shares native caption/backing colors. |
| Native Desktop | `src/main/computer/{index,helper,browser-chords,windows-api,windows-capture,windows-apps,windows-keys}.ts`, `src/shared/windows-computer.ts`, `mcp/tools-desktop-{windows,macos}.ts`, `native/macos-desktop-helper/*`, `native/macos-desktop-addon/*`. |
| Direct browser control | `src/main/browser-control.ts`, `mcp/tools-browser.ts`, `src/shared/browser-control.ts`, `extension/browser-control{,-page}.js`: short-lived RPCs, session-owned debugger tabs, bounded DOM/diagnostics and background input. |
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
| Direct browser tool calls | `browser-control.ts` process epoch/pending claims; extension `storage.session.cosBrowserControl` | One claim per command; browser incarnation plus local-session tab lease. MV3 retains custody/receipt, never replays input. App restart invalidates outstanding claims. |
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

Setup profiles switch only Core/Desktop/Plugins tunnel IDs and the tunnel API-key identity.
The active IDs remain in `config.tunnel`; `config.setupProfiles` contains inactive snapshots
only. `setup-profiles.ts` switches both in one queued config commit, incrementing `profileEpoch`.
Keys remain in `secrets.bin`: the original profile keeps `openaiApiKey`, others use `setup:<id>`.
Settings writes fence changed tunnel IDs by profile identity/epoch; key writes name their exact
profile. Connection lifecycle reuses the selected key and reconnects when the OpenAI profile
epoch changes, even if its tunnel ID matches. Roots, chats, models and other settings stay shared.
Removing a profile removes its inactive snapshot and encrypted key; removing the active profile
selects a survivor in the same config commit. The last profile cannot be removed.

Renderer settings save `{base, patch}`. Main performs a field-wise three-way merge so an unchanged
form field cannot undo a newer browser-side setting. Renderer saves also serialize snapshots
from the latest requested state, preserving fast successive edits. Disable side effects are
ordered: revoke/park worker execution and durably retain history, cancel its commands while the
bridge is available, then stop unnecessary bridge/publication resources.

The BrowserWindow keeps context isolation, sandbox and web security on; Node integration and
webviews off. CSP, permission denial, navigation/window restrictions and fixed preload methods
remain intact. OS consent for Desktop is independent from the app's settings.
The macOS window permits native fullscreen through its green titlebar control; Windows/Linux
retain their existing maximize behavior.

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
| Core — `chat-on-steroids-core` | `read`, `view_image`, `find` when command execution is off, `apply_patch`, `exec_command`/`write_stdin`, `update_plan`, `agents`, `session_finish`, code-mode `exec`. |
| Desktop — `chat-on-steroids-desktop` | All Chromium extension hosts: `browser_tabs`, `browser_snapshot`, `browser_screenshot`, `browser_console`, `browser_network`, `browser_navigate`, `browser_action`, `browser_evaluate`. Windows additionally exposes 13 Window2 operations, clipboard and `exec` with `sky`; macOS adds `observe`/`computer`. Surface `exec` composes browser tools too. |
| Plugins — `chat-on-steroids-plugins` | Enabled external tools with their upstream names and schemas, plus code-mode `exec` when that composition name is available. |

`read` needs read/browse/metadata as appropriate; images need read; patch checks each hunk's
create/edit/move/delete permission; command controls both terminal tools.
Recording controls `update_plan`; multi-agent controls `agents`;
the finish setting controls `session_finish`. Windows publishes four observation methods under
screen access, nine input/launch methods under control, and clipboard methods under their own
permissions. Multiline `type_text` additionally requires clipboard write. macOS `computer`
registration can exist for control or clipboard access; each action rechecks its own permission.

ChatGPT may cache one surface's complete tool list. Core/Desktop exposure is monotonic for an
endpoint lifetime: a previously exposed schema can remain while a revoked handler returns
`TOOL_DISABLED`. The `find` vs terminal choice freezes at discovery. Reconnect establishes a
new clean shape; current config still governs every call. Each registrar refuses foreign names;
there is no merged hidden dispatch. Plugin exposure follows its separate dynamic manager.
Disabled-tool guidance names Read-only when it masks a write, otherwise the actual permission
label. A permission change takes effect at the live guard without requiring a new chat.
Core instructions distinguish operation-specific identity, process-id and output-limit failures
from Read-only mode. A terminal ownership refusal names that process scope; it does not imply
a global write restriction or authorize replaying an already completed job.

`tool-declarations.ts` caches immutable declarations/JSON conversion. SDK servers and handler
closures remain request-local, and child calls obtain a fresh live context. Avoid caching the
permission decision alongside a cached schema.

### Instructions must actually reach the executor

MCP initialize advertises `instructions`; successful initialize does not prove the host showed
all of them to the model. Only the first normal message of a new chat and the first bootstrap
of a newly spawned worker use `session/prompt.ts` to freeze the complete current Core instructions
plus the explicitly linked project directory and its root `AGENTS.md` inside the existing
`COS_CONTEXT` frame. The directory and default-workdir guidance remain present when AGENTS.md
is absent, empty or reading is disabled; no file content is read when read permission is off.
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
byte envelope. For eligible openings, authored work, complete Core instructions and selected
project identity are mandatory;
only AGENTS content spends remaining room. Read it as a bounded UTF-8 prefix, validate the same project/root/read
permission after the await, and cut with an in-context instruction to read the remainder.
Only strict framing is hidden in the local/native display. Original bytes, receipt comparison,
recording and token accounting keep the complete delivered text. `userMessageSource()` supplies
native source text; rendered Markdown whitespace alone cannot prove a send. Local and native prompt
presentation, including worker messages without outbox receipts, ignores provider-added whitespace before the frame, then validates its exact
internal length and closing boundary; authored whitespace after the frame remains intact.

### Text Skills

`main/skills.ts` owns the empty-by-default `<userData>/skills/<id>/SKILL.md` library,
bounded UTF-8 import/read and metadata catalog. `skill-access.ts` exposes only that canonical
directory as `/skills` to Core, including nested code-mode calls. Current capability/Read-only
guards still apply. This root is not saved in config, does not satisfy connection folder setup,
and never becomes the default or learned project cwd, including native paths through an
overlapping approved root. Desktop and external plugins receive no managed root.

Skills open through leading `/` completion in the composer; the attachment popup's Skills button
inserts that leading slash and focuses the input while preserving existing draft text. Commands and Skills are
separate compact sections; there is no sidebar entry, modal library or native import/remove UI.
A small plus icon to the right of that Skills button inserts `Please add the following skills to my COS skills:`
into the authored draft without sending it. ChatGPT can create Markdown instructions through
the existing permission-checked `/skills` filesystem root. Leading `/id` or `/prompt id` completion projects selected
commands as removable chips. The existing authored draft retains those command bytes; chips and
the visible task textarea are projections, never a separate selection ledger. Multiple commands
preserve order and deduplicate; prose/code later in a message is literal. Empty/loading/no-match
states do not intercept Enter. Draft replacement, navigation, render generations and IME composition retire stale choices.

`skill-library.ts` discovers repository `.agents/skills`, project `.codex/skills`, standard user,
Codex, system and admin directories only within current approved roots. No new root authority or
implicit cwd is granted. Depth, directory entries, catalog rows and errors are bounded; package
references are not recursively treated as another catalog. External command IDs derive from
canonical paths and remain stable when similarly named packages appear. `skill-metadata.ts` owns
bounded YAML/TOML parsing and layered configuration. Invalid policy never enables implicit use.
`skill-package.ts` stages resource copies and publishes SKILL.md last; the existing serialized
managed-library owner controls imports and removals. Scripts/assets remain inert resources.

Input `authoredSource` identifies which existing field contains the human request: `text`
by default, `objective` for generated Goal/workflow openings, and `none` for generated
checkpoints. Editing a queued message makes its text human-authored again. At the existing
delivery claim, Core/catalog → selected Skills → project header/optional AGENTS →
complete task are framed under the existing character/byte limits. Keep Skills complete where
possible: first reduce AGENTS to 5,000 characters (or its complete shorter text), then shorten
Skill bodies using a shared prefix cap so every selected file retains its identity and a
read-remainder notice. Core and task remain complete. If those mandatory parts plus the
AGENTS minimum and skill references cannot fit, reject explicitly rather than corrupting them.
Explicit follow-ups add only selected Skills. `deliveryText` freezes exact bytes for retries;
subsequent library changes cannot alter an already prepared send. No new MCP tool, executable
hook, watcher, or provider reconnect is introduced. The catalog refreshes on list/import and
before opening preparation; provider-cached initialize instructions remain a snapshot.

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
private. Source parse/initialization failures have a distinct diagnostic. Oversized explicit text
emissions preserve a UTF-8-safe preview, clearly report truncation and stop further admission;
the 40,000-byte text ceiling counts decoded emitted text, independently of JSON wire limits.
Child schema refusals preserve bounded field-specific correction guidance. Timers such as
`setTimeout` are unavailable, including through the Windows `sky` adapter.

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
For a reserved New Chat opening, the shared `/input/bind` route commits its exact claim first;
only that claim retires, and its promoted conversation/document epoch precedes correlation or event publication.
Ownership acknowledgement is separate from slow transcript/image writes.

`usage.js` can also project an exact conversation/request pair from a complete live POST
conversation SSE event before Fiber exposes it. Reads are bounded to 4 MiB / 15 minutes,
two simultaneous clones and 16 request ids per stream; only server metadata is accepted.
The native WebSocket `conversation-turn-stream` handoff uses the same complete-event parser,
requiring its outer conversation to match the inner event. It observes existing messages on
ChatGPT secure sockets without sending, subscribing or polling; envelopes and frames are bounded.
A 64-pair document cache deduplicates both transports and replays IDs at content readiness.
Content requires the matching route and document epoch, retaining one-shot stream proof through
temporary ACK failures for at most 15 minutes using the existing observer/backoff. Missing stream
metadata retains the Fiber path. Fetch reattachment at DOM readiness captures each downstream
wrapper separately and deduplicates responses to avoid recursion through page instrumentation.
Popup request diagnostics derive from the newest exact native/Fiber turn; older scanned turns
cannot leave a stale current-ID success. Worker queue custody, app receipt, owner confirmation
and actual recorded tool activity remain distinct facts.

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

After a local identity refusal, `kernel.ts` appends one **Identity recovered** notice to an
eligible outer tool result once exact request/conversation/session proof is available. Refusal
sites mark their result explicitly (`failIdentity` or `IdentityLostError`); arbitrary error
text cannot trigger it. An earlier request qualifies only after its own proof names the same
conversation and local session epoch. Successful unattributed work alone creates no notice.
The bounded process-local record retains up to 2,000 request ids and eight tool names each;
restart/server reset drops this advisory history. The existing response publication suppresses
parallel/repeated offers and permits re-offer after local transport failure. A full text budget
defers the appendix. Nested calls record refusals but only the outer result delivers notices,
including Core's structured supplemental context. Current blocked, compacting, superseded and
inactive-worker restrictions veto delivery; the notice never grants permission or repeats work.

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

### Three lifetimes and five outcomes

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
| `tool_execution_error` | An upstream plugin reported an execution error; inspect its result to distinguish script, target and transport failures. |
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

## 10. Files, terminal, patches and images

**Intent:** provide a predictable coding loop without requiring a Codex installation or launching
a Codex model. The TypeScript ports reuse selected upstream behavior; the app adds permissions,
identity, evidence and host-specific integration around them.

### Reading, searching and patching

`read` batches paths, lists directories, handles globs and returns numbered bounded text.
Its 512 KiB text budget is separate from its four-image/12 MiB base64 budget. Images use
`view_image`'s full per-file validation; a rejected image does not discard other valid sections.
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

Content-match failures explain when the expected text lies behind the forward search cursor;
callers must order edits within each Update File block. Diagnostics bound expected text and
source excerpts to eight lines and 240 characters per line. A source excerpt requires Read
permission and a matched context marker or reliable literal anchor; it describes the verification
snapshot, never a relaxed match or another write attempt. The timeline labels these preflight
failures “Patch didn’t match” / “not applied”; permission and identity refusals remain distinct.

Partial multi-file failure uses bounded rollback snapshots. Restore only a path still matching
what **this patch produced**; a concurrent external edit must never be overwritten. Preserve
the port's explicit line-ending mode and readable parse/match failures.

### Terminal execution and custody

One app-lifetime `codex/manager.ts` owns `UnifiedExecProcessManager`. `exec_command` runs a shell,
returns output and a process id; `write_stdin` continues that same process, sends input
or drains output. Caller isolation is in `ownership.ts`, not separate managers per request.

Every successful launch also returns a session id when it finishes immediately. Empty
`write_stdin` calls can reread completed output after direct polling or automatic delivery;
structured results keep `session_id` for running work and use `completed_session_id` for
finished work, so existing polling loops still stop. Either id is the `write_stdin` input.
On every OS, structured `output_replayed` marks a retained reread and `benign_exit` marks a
proven expected non-zero result; raw exit codes remain intact.
nonempty input to a completed process is refused and never restarts work. The same manager
retains the latest 64 completed results for this app lifetime, with 256 KiB of raw head/tail
output each (and delimiter-free batch presentation). Completed rereads have no unread debt,
live-process capacity charge or automatic reoffer. Eviction/shutdown drops their existing
custody entries; retained ids cannot be reallocated. Unread results keep their separate bounds.

The owner is the **durable local session principal** established by correlation. A→B compaction
keeps that principal, so B can continue A's live terminal without an adoption/move fallback.
Another session/worker cannot poll or write it. Anonymous process custody is non-adoptable.
Refusals distinguish unavailable ids, anonymous launch custody, missing caller proof and a
different owning session. Only missing caller proof invites retry after identity recovery and
participates in the existing recovered-identity notice. No refusal proves a command should be
replayed or implies Read-only mode; unavailable ids require checking original launch/output.

A yielded command records a launch acknowledgement, not a permanent claim that the child is
running. For an exactly attributed launch, the process instance's exit promise revises that
same canonical call UUID with exit time/code; numeric terminal-id reuse cannot retarget it.
This revision neither drains output nor creates model work, a new tool call or a turn boundary.
Legacy launches without exit evidence display `started`; never invent a retrospective success.

`env.ts` is the shared child-environment authority: Windows key names are case-insensitive,
so use its accessors rather than creating both `Path` and `PATH`. Preserve inherited values.
`toolchain.ts` fills missing/unreachable Windows JDK/Go configuration conservatively; never
override an explicit reachable toolchain. `exec-hints.ts` repairs only provable narrow shell
mismatches and otherwise abstains. Ambiguous globs/control flow keep original command semantics.
The narrow PowerShell rg-regex quote repair uses `\x22`, avoiding embedded-quote/whitespace
argument splitting in Windows PowerShell 5.1; fixed-string and PCRE literal regions are excluded.
POSIX shell refusals (including zsh unmatched globs before launch) never count as search no-match.
Search exit 1 can mean no matches; git/build/mutation failure must not be relabeled success.
Search exit 2 remains a failure even with partial matches: missing or unreadable paths leave
the requested search incomplete. Preserve returned matches and repair the failed path.
The launch's classification also governs later polls, completion revisions and summaries;
a proven benign non-zero exit stays non-error while preserving the raw exit code. Incomplete
or omitted classification evidence fails closed. Batch summaries name `cmds`; polling retains
the “Waited on session” title with its numeric id and measured exit status.
The shell's virtual-path diagnostic excludes an exact approved native POSIX spelling, even
when `/Users` collides with a `users` alias. This classification never rewrites command text
or grants filesystem permission; genuine virtual paths retain their native-path guidance.

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

### Human workspace terminal

`workspace-terminal.ts` and `workspace-terminal-ipc.ts` own human-operated node-pty shells;
`renderer/workspace-terminal.ts` renders them with xterm and FitAddon. These shells are separate
from MCP process custody and never consume agent output. The header button or Ctrl+backtick opens
a resizable bottom panel. Each new tab captures the selected approved project's canonical cwd;
changing chats does not retarget existing shells. No project means no guessed cwd. The live
Command permission gates spawn/input, and input rechecks the original project path.

Up to eight tabs retain interactive shell state. Hiding the panel preserves processes; closing
a tab, renderer reload/destruction or app shutdown retires them. UUIDs and pending-create tickets
prevent a late spawn after close. IPC accepts only the current main-frame sender and bounded
named requests. Output pauses at 256 KiB until xterm parser acknowledgements drain it; scrollback
is limited to 5,000 lines and queued input to 256 KiB. Ctrl+C interrupts unless copying a selection;
Ctrl+Shift+C copies. Native terminal escape handling stays in xterm, not HTML rendering.
Appearance application refreshes all existing xterm palettes, including hidden tabs, from the
current page/ink tokens without recreating shells; cursor colors follow the same palette.
`scripts/verify-workspace-terminal.cjs` tests real Electron/PTY input, cwd/environment persistence,
hide/reopen, tabs, Ctrl+C, exit codes, resize and closing against isolated state.

### Images

`view_image` accepts PNG/JPEG/GIF/WebP under an 8 MiB raw bound and explicit decoded-pixel/memory
limits. Structural checks plus actual Sharp/libvips pixel decoding precede an MCP image block.
Metadata parsing alone is insufficient. Return one native image copy, not duplicate base64 in
structured output. Its validator also owns code-mode emitted-image admission.
JPEG end markers terminate the codestream, not necessarily the containing file; trailing bytes
must not reject an otherwise decodable image. Full bounded pixel decoding still owns validity.

There is no built-in tool for downloading ChatGPT-generated files. Legacy file-saving
configuration is discarded by normal config validation; historical recordings remain intact.

## 11. Composer, input queue, generated plans and Astra finish

**Intent:** the user can send, correct, schedule and inspect work without losing authored text
or duplicating a message after an ambiguous browser outcome. One outbox owns all delivery.

### Input from composition to receipt

New Chat selects a window-local draft; it does not reset it. Returning from another chat
or clicking New Chat again preserves text, staged attachments, prepared workflows and the
first-message Goal/Loop objective, mode and delivery choice. Each project and unfiled New Chat
has its own draft key. Manual deletion remains deleted; accepted openings retire the original
draft as the outbox/session takes ownership. Navigation still fences stale async imports.

The chat composer and queued-message editor have no HTML character cap. Send and queue edits
share the existing 96,000-character message admission ceiling; prepared delivery additionally
enforces framing and UTF-8 byte budgets with an explicit error.
The desktop composer uses native CSS content sizing, bounded at 220px. Layout owns its
height across draft changes, hidden panels and width changes; do not persist a measured
`scrollHeight` as an inline height. Empty and fitting input must not overflow; longer text
remains scrollable at the cap. `scripts/verify-composer-layout.cjs` checks real Electron layout.

`session/start-input.ts` returns durable local admission before waiting for connector readiness
or browser delivery. Each New Chat opening reserves its own local session in the outbox, then
materializes that exact desktop session. Another New Chat may be admitted immediately; pending
delivery remains Queued. The existing browser election and exact claim still own native Send.
Cancellation revokes both the outbox row and its transient startup controller; shutdown aborts
startup and explicit retries before they can wake a browser later. Startup failure leaves the
same queued input and an explicit retry action.
Explicit withdrawal of an opening also removes its empty, unbound local reservation when Send
was provably never authorized. The cancelled outbox tombstone survives restart. Timeouts,
startup failures, ambiguous sends, provider bindings and recorded history never grant deletion.
Dismiss delivery notice is an explicit withdrawal too, including after a failed first send;
it uses the same serialized cancellation and empty-reservation checks. Dismissing a failed
follow-up or uncertain authorized send preserves its existing chat and delivery evidence.

The immutable outbox `opening` role owns first-message setup and initial null-to-provider binding;
non-null sessionId no longer means the opening was delivered. The exact native document binds
the reserved session before recorder evidence, using the existing input bind route. Only an exact
receipt populates deliveredSessionId. Wrong owner, another bound conversation or an existing
foreign session fails closed. The renderer selects the real local session on admission only while
the original draft generation still owns focus; a newer New Chat/draft cannot be stolen.
Restart repairs partially materialized openings from their accepted identities, isolating one
failed project/write from unrelated openings. An explicit retry can retain an unbound session
only after proven pre-send cancellation/failure; an ambiguous authorized Send cannot be replayed.

An input contains stable UUID, session/project, authored text, automation/objective, requested
model/effort, due time, optional stages and attachments. `input.ts` serializes mutation and
publishes a new ledger only after its write. Reusing an id with different content is rejected.
The frozen `deliveryText` includes executor setup only for a new-chat opening at claim time; displayed authored
text remains separate. A failed write cannot later become a successful hidden enqueue.

| Delivery choice | Eligibility and behavior |
| --- | --- |
| Immediate / `auto` | In an exact active non-Pro turn before its first MCP call, **Send directly** claims that original turn, stops its native generation, then uses normal browser Send. **Inject now** is a separate choice, including before the first call: authored `delivery: tool` captures the exact turn, waits visibly in the existing outbox, and only enters that turn's eligible outer MCP result. It never falls back to browser Send and fails visibly if its turn ends before delivery. After the first MCP call, injection remains available; Pro (including Astra) keeps injection throughout. A new turn resets eligibility; old tool history does not count. For a proven idle chat/New Chat, elect the normal browser send. Unknown model/turn identity grants no interruption. |
| After turn | Existing-session FIFO spends one distinct completion or confirmed failure/silence-refresh ticket per browser claim. Replays/restart cannot drain the next entry. Does not block an otherwise eligible immediate tool injection. |
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
current assistant turn, excluding quoted Markdown, old turns and app UI. It immediately records
failed `turn_end` with structured `thinking_failed` reason and releases ordinary manual browser
input. This is a failed view, not a successful final and not automatic queue-delivery authority.
Fresh exact MCP/native-tool/interim work can immediately reopen the same durable generation.
Only changed assistant text counts as fresh interim work. HTML, timestamp, identity-strengthening
and duplicate revisions still update canonical history, but cannot reopen the turn or reset its
work clock. Replay, old-turn activity and manual Stop cannot. An exact native final supersedes
the failed view, but never overrides a still-live exact MCP work window.

**User decision, 2026-09-13:** only the exact Thinking-failed error releases a pending immediate
user correction without waiting. A missing Stop button, Stop-to-Send repaint, or generic
finished/stalled observation does not grant that exception. While genuine requests keep arriving,
the correction remains eligible for injection into its exact turn. A running MCP call vetoes
browser Send; a later exact work observation revokes pre-send authority and restores injection.
**Final-response correction, 2026-09-13:** the full canonical final response for the exact
current turn consumes its silence deadline immediately. The ten-minute Pro / two-minute normal
window is silence recovery only, never a delay after a final. Interim messages, even prose saying
the work is complete, and Stop/Send controls or a bare `turn_end` do not prove a full final.
Running local tools remain a separate send guard. A newer question, reopened turn or genuinely
new tool work invalidates the old final; late recording of pre-final calls cannot renew silence.
Explicit native files remain browser-only, including an Immediate request temporarily represented
as after-turn input for upload. Queued checkpoints and generated Loop instructions are different
from this immediate correction and retain their automatic boundary policy.

The bridge's existing silence grant separately requests a refresh immediately when the view fails.
There is no initial grace period and no ignored-activity window. The recovery grant does not
count as active input. For authored queued/checkpoint input, the confirmed refresh files its existing outbox ticket
with **five minutes** of durable listening; native busy extends that same authored ticket by
five minutes as often as necessary. Generated Continue and Goal/Loop use §14 instead. New work revokes the ticket and restores the normal
silence clock. An already reloading page retains its existing hydration/cooldown protection.
If that refresh later reveals Thinking failed, its error-observation timestamp is not fresh
work and must retain the exact authored-input ticket and original listening deadline.
Failure/silence-based queued-checkpoint delivery requires a recorded, exactly attributed local MCP call
in that source turn. Native ChatGPT tools, request-id sightings without a call, and earlier-turn
MCP history do not qualify. Refresh and manual sends need no MCP proof. Recheck recorded proof
for restored tickets and before claims; a genuine full final uses ordinary completion policy.
A running local tool still vetoes Send.

Queued after-turn work and pending immediate corrections use **two-minute**
silence/refresh authority for normal and unknown models; only proven Pro uses **ten minutes**.
Normal and unknown models then listen for **one minute
from the acknowledged refresh** before queued-checkpoint delivery. The existing
activity grant and outbox listening deadline own this wait. Thinking failed for queued checkpoints uses
immediate refresh plus **five minutes** for automatic continuation. The final user decision
retains that original five-minute window; the earlier proposed reduction to two is withdrawn. An ACK
for that exact refresh files `silenceBoundary` on the next existing outbox row before publication.
It records source conversation/turn and work sequence; no parallel ticket ledger or scheduler.
Native Stop prevents claiming/sending and durably extends listening by five minutes, rechecking
again if it remains busy. Only a full canonical final can consume the silence window; native
control changes cannot bypass it or an existing native-busy delivery deferral.
New work withdraws an unspent ticket/pre-send claim and rearms the model's silence clock. Authorized
sends retain exclusive custody until their exact receipt or proven pre-send failure. Source work,
document epoch, question, draft and native Send are rechecked across preparation awaits. An
unclassified `stalled` end alone does not release a message; the refresh receipt is required.

At ordinary silence recovery, a never-offered immediate correction takes priority over generated
Goal/Loop work and is sent as a normal native user message. Include at most the next eligible
visible queue checkpoint in that same message, never the whole queue or an additional Loop
instruction. Preserve both authored outbox identities and one exclusive native send/receipt;
claim, cancel, timeout, restart, late ACK and history publication apply to the same pair.
The transport's text/file limits still apply; an oversized companion stays queued instead of
discarding the correction. No companion is pulled early into the immediate Thinking-failed send.
User delivery spends that source's automatic obligation; a new turn must earn new continuation.

The **extra five minutes when the native page is still busy at a send attempt remain unchanged**,
for authored normal-silence user delivery and queued-checkpoint Thinking-failed recovery alike.
This is separate from the generated Continue/Goal/Loop busy wait in §14. This is a deferral of the
same existing ticket, repeatable if still busy, not a new ticket or an initial five-minute wait.
Its reason and deadline belong to the existing outbox/Goal obligation; do not add another timer.

The displayed follow-up order also governs browser and finish-tool delivery: an ineligible
head cannot be skipped by a later checkpoint. Immediate injection keeps its explicit semantics.
A native-only head releases an existing finish hold so the answer can finish before browser
delivery. Every model's automatic Goal pickup, draft and final Send authorization defer to queued
or claimed user input. Send authorization spends that exact source's Goal obligation durably;
pre-authorization withdrawal preserves it. A later source can independently earn its next step.

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
An exact accepted fresh-chat receipt remains valid when native submit promotes its null
conversation to the delivered conversation. The same receipt, message, epoch and send lifetime
must still agree; a second navigation or replaced receipt cannot inherit that acceptance.
While an exact send receipt still has a bounded evidence reader, the existing observation also
requests canonical MAIN-world text even after native generation stops. Rendered Markdown can
remove submitted bytes; recognizing the generation must not be a prerequisite for reading the
source needed to recognize its Send. Route, epoch and stable message identity still decide acceptance.

Page-reply waits are bounded: reuse/close observations get three seconds; New Chat preparation
gets fifteen seconds. Missing preparation replies retain the elected tab and grant no fallback.
Only fresh same-document/epoch idle proof allows preparing that elected tab again. Final input
offers do not block maintenance; the content busy slot and durable app claim/authorization own
delivery. A due repair defers that same conversation's input to the next status pass.
When an elected input tab finishes loading, its existing election wakes that same status pass
immediately. Registration can precede page readiness; a missed early offer must not wait solely
for the 30-second maintenance alarm. The wake rereads current outbox eligibility and retains
the original tab election, native readiness checks and exact send receipt.

A claimed/authorized ambiguous browser send is never automatically resent. Pre-send preparation
failure and post-click uncertainty have different error text and retry authority. Late exact
receipts may settle a cancelled wait; that does not authorize a second message. Receipt custody
and history publication are independent: a recorder failure retries canonical history, not
transport. Queued unclaimed input follows its durable session to the successor; already handed
claims keep their original exact document until their outcome resolves.

Desktop delivery captures the native user-message identity inside the same Send acceptance
operation that proves its text and route. It must not discard that receipt and rediscover the
row after an await: React may already have replaced it. Navigation still revokes the operation;
composer clear or a Stop button alone cannot supply a desktop delivery receipt.

Confirmed terminal input receipts stop owning history retries after their exact local session
directory is positively absent under an available history root. The outbox durably retires them
before startup origin repair, wrapped-text migration or checkpoint materialization. Corrupt
metadata, inaccessible storage, unbound/ambiguous sends and active receipts remain retained;
combined deliveries retire together. A stale delivered receipt cannot recreate deleted history.

Tool input is offered in queue order within one bounded response. Emit one user-instruction
heading, each authored message followed by its normalized images, then one batch reminder.
UUIDs remain internal receipts, not decorative text for the model. A later exact-owner
invocation that started after publication acknowledges it. Immediate inputs may batch.
The exact recorded request's later canonical final can also acknowledge its last tool handout
once local calls drain. Interim prose, old/foreign finals and bare turn-end events cannot.
Tool handouts retain their original turn identity in outbox/history; confirming receipt must
not turn an injected correction into a new question or leave the composer blocked indefinitely.
After-turn and finish entries each retain their own boundary policy. Tool intent has no
arbitrary claim-age expiry. Only positively settled, never-offered eligible input may change
transport; receipt loss cannot justify switching to browser Send.

### Attachments have one staging owner

`input-attachments.ts` stages immutable originals selected by file picker, drop or clipboard.
Renderer/browser receive opaque ids, names, sizes, MIME and bounded previews, never source paths.
Up to 20 files and 512 MiB total per message are locally admitted; provider limits can still
reject an upload. Staging has a 2 GiB quota, serialized pruning/admission, and preserves outbox-
retained bytes. Thumbnails do not modify originals or prove provider upload success.
Image clipboard data and file drops anywhere in the window target the currently visible chat
draft; the Folders card keeps its explicit folder-drop owner, and ordinary text paste/drop keeps
its native editor behavior. Async import results carry both the draft key and its replacement
generation. Navigation, Send, accepted planning and retry replacement retire that owner so a
late file cannot attach to a later draft, while ordinary edits and parallel imports remain valid.

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

Delivered-input history commits the canonical message before optional image storage.
The existing outbox records `historyAnchored` independently of `historyRecorded`, so an
asset failure retains retryable bytes without reviving a delivered message in the bottom
queue. Exact input/session membership supplies retained previews at the canonical row,
including when queue and history snapshots arrive in either order. Off-tail anchors stay
off-tail. Retries enrich the same origin and never resend; confirmed tool inputs retain
their original handout time. Image validation memoizes bounded content digests only,
so a full asset quota does not repeatedly decode identical pixels on every queue read.

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
Once a successful result owns the captured task, clear its unchanged source composer draft,
including a background draft after navigation. Do this before awaiting queue admission, so a
new correction typed during that wait survives. Failed/cancelled/stale generation keeps the
draft. Enter submits a prepared plan even when the composer is empty; Shift+Enter and IME
composition retain their ordinary editing behavior.

- **New chat:** the completed plan stays editable across navigation until explicit Send/cancel.
  Clearing the composer keeps its captured objective. Send freezes the original objective and
  **every** stage in the first durable payload. Later checkpoints are materialized once after
  the first receipt creates the concrete local session. Until then, the dock projects them
  from that same input. Retry must retain objective + all stages, never restore only stage one.
- **Existing session:** completion atomically admits all finish checkpoints into the durable
  outbox immediately. New composer text/attachments are not sent by that admission, and clearing
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
An unproven `session_finish` request waits for its exact request-id evidence at MCP admission,
before blocked/superseded checks. That wait and the finish hold share the existing 25-second
ingress deadline; late identity cannot add a second full wait or borrow another session.
The turn's recorded finish authority owns held/released/notified/decision state. Pending user
instructions and checkpoints take priority. A successful finish response can deliver one
checkpoint; empty holds can wait without inventing new work. “End turn” durably releases the
hold so ChatGPT may finish; it does not pretend native generation has stopped.

For Astra, **both Goal and Loop use the Loop decision path at the finish boundary** and inject
the resulting instruction through tools. A completed final answer sends another browser message
only when Pro Loop explicitly enables after-turn delivery (§17). `automaticFinishEnabled()` is shared by generation and queued-input
validity: only the effective per-chat Goal/Loop switch authorizes an automatic decision.
Implicit or explicit Off remains notification-only; the legacy global finish action grants no
authority. A durable switch change invalidates a pending decision before it can enqueue work.

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

Recoverable `chat_error` notices coalesce against committed history for the same canonical
authored question, including unscoped/reminted document reports after reload. Old question
revisions cannot replace the newest question's ownership. Other errors retain their bounded
30-second/turn rules and exact Thinking-failed policy. A new question or different error stays
visible. Legacy duplicate rows fold in presentation without rewriting forensic history.

Every recorded chat-error card includes a short next-step explanation. Preserve the browser's
blocking/recoverable classification for presentation; unknown legacy errors give manual guidance
without promising automatic retry. Show the existing matching repair receipt in the card and
update it with the timeline, bounded by turn/question ownership. A reload proves only the page
action, not recovered generation or message delivery. App silence reports lack of confirmed
completion, never claims ChatGPT is still generating. No presentation rule grants recovery authority.
The existing completion-versus-later-work projection also owns the card's recovered title and
color. A newer reopen restores unresolved presentation; original error history stays intact.
Native Thinking failed notices require an exact local turn owner; unowned historical headers
discovered after reload cannot become current errors. The recorded reason plus that turn identity
deduplicates reload/restart reports beyond the generic 30-second burst window. Fresh exact tool
work or an app-owned reopen updates the explanation to say work continued, without bypassing
the existing recovery/listening and automatic delivery gates.

```text
userData/sessions/<local-id>/
  events.jsonl          append-oriented tool/turn/error/progress evidence
  messages/*.json       one atomic shard per native message or tracked background tool call
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
Saved user-image previews reserve one 96px slot per asset before IPC. Loading, unavailable and
retained-outbox fallback states use that same footprint; fallback pixels remain explicitly marked
as not saved to history. Asset hydration must not move the opened tail or a deliberate reader.

ChatGPT-generated images use their own canonical `native_image` row, keyed by provider message
UUID plus sediment asset id. They are neither assistant prose nor local tool calls and cannot
establish turn completion, Goal eligibility or activity. Typed public tool/assistant image
outputs supply metadata first; final provider status and a complete, exactly owned native IMG
permit optional preview capture. Main/thumbnail/mask clones of the same asset share that identity.
The extension captures already-loaded pixels without fetching signed URLs; route, document epoch,
owner, node and source revision must survive each await. At most two captures run concurrently.
Previews are WebP, at most 384,000 encoded bytes, 1,600 pixels per edge and 2.56 million decoded
pixels; source images above 30 million pixels retain metadata without a preview. Main fully
decodes previews before asset admission. The existing 2 GiB global asset budget remains exact;
quota failures retain the canonical row and explicitly report storage full. There is no automatic
eviction. The adjacent Free image storage action offers explicit oldest-1-GiB or all-recorded-image
cleanup with confirmation; chat text, original files and pending attachments remain. Store owns
serialized image inventory, durable reference retirement and physical removal. A removed native
provider tuple cannot silently refill the cache when the page is observed again.
Opening the cleanup dialog reuses the store's maintained quota total; a cold read counts file
metadata without opening image contents. Confirmed cleanup retains full image verification and
shows an immediate busy message until success or failure; its final recount is metadata-only.
Cleanup choices and Close are available before usage loads. Closing the dialog leaves its one
requested operation running; reopening rejoins that same promise and retains its result. No
poller or automatic cleanup loop is involved; completion also reports the actual freed bytes.
The renderer groups adjacent same-response images into two columns, bounds loaded previews,
and uses compact failure cards. Exact selection generations prevent old pages from filling a
newly selected chat. Loading assets retain their bounded geometry through pixel hydration.

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

### App history

Native message reactions are metadata on the exact user-message UUID observed by
`chatgpt-dom.js`, carried through content/bridge/recorder into its canonical shard.
Missing reaction metadata preserves the prior observation; explicit null clears it.
Do not infer a target from the nearest rendered row or a reused turn id. The renderer
removes only the leading provider reaction envelope from assistant presentation;
canonical source bytes and literal examples remain intact. A reserved user-bubble
footer and in-place badge updates keep streaming reactions from shifting messages
or reloading attachment previews. Old history gains badges when natively reobserved.

Continuous recording serves the local transcript, exact identity and continuation infrastructure.
There is no model-facing session lookup tool. `update_plan` remains recording-backed; historical
lookup tool calls remain displayable in existing transcripts.

Desktop session lists use stable `(updatedAt,id)` pagination. Each session selection loads a
recent tail and opens at the bottom after its current load renders, including A -> B -> A;
the previous chat's viewport does not decide the new chat's position. Timeline
pages older/newer on deliberate scrolling in 80-record stages, targets 160 resident records,
and navigates/evicts by immutable canonical `origin` (or original `seq`). Revision `seq`
belongs only to live delta delivery; a later revision cannot relocate an answer, skip a page,
or resurrect an off-page row in the live tail. Older/newer IPC navigation uses `before`/`after`
origins; `from` remains the separate publication cursor.
The renderer retains the measured viewport plus one screen of surrounding content up to a hard
320-record staging bound. Dense collapsed activity must not make an 80-record eviction
discard the reader's visible prose. The existing 2 MiB text/HTML paint budget still applies.
Overlapping activity groups keep their disclosure identity across page boundaries. The
viewport owner preserves a surviving visible row and any underfilled tail space; new
content consumes that space, while an unchanged refresh cannot collapse it. Session selection
clears that reserve. There is no Back to latest banner; navigation uses ordinary scrolling.
Empty or failed older-page reads preserve the current live cursor and viewport instead of
switching to historical mode. `scripts/verify-history-scroll.cjs` checks native
Chromium wheel input over a long task, dense activity, reversals and live refreshes.
Historical browsing does not silently evict the user's
place on live updates; controls remain live. Selection generation fences every async page.
Expanded tool arguments/results and Compact & Resume content use the chat pane's vertical
scrolling, without nested vertical text scrollers. Streaming compaction revisions retain the
disclosure and unchanged sections; the timeline owner preserves the visible row or follows
the bottom only when the reader was already there. Collapsed bodies leave layout entirely.
The chat scroll container reserves its scrollbar gutter even without overflow. At a fixed
window/sidebar width and zoom, tool disclosures, history controls and tail reserves must not
change prose width or line wrapping. `scripts/verify-chat-width.cjs` checks these transitions
in real Electron at narrow/wide widths and multiple zoom levels.

### Context pressure and Usage are different measurements

Session `contextTokens` estimates current frontend pressure and resets at durable A→B rebind.
Lifetime `estimatedTokens` retains historical work. These are app estimates, not ChatGPT's
private context meter; the composer ring must say so. Exact Pro has a static pressure display
and is excluded from automatic compaction; manual compaction remains a separate action.

Each MCP return contributes at most **10,000 estimated tokens**, using its original recorded
text length before applying that cap. Arguments and the activity title retain their separate
estimates; authored messages are not capped by this rule. This is local estimation policy,
not independently verified provider truncation. `shared/session.ts::eventTokens()` owns the
rule for context and Usage. Existing metadata and Usage caches invalidate their old estimates;
reconstruction preserves rebind resets, applying old-frontend return reductions only to lifetime
totals. Recorded results, overflow assets and actual MCP responses retain their existing bounds.
Code-mode children are recorded with dispatcher-proven `nested: true`: they remain audit/tool
activity but contribute neither context tokens nor Usage billing calls. Only the outer exchange
counts. Legacy rows lack this proof and keep their old estimate; request ids and timing are not
safe nesting identities. Usage cache version 8 enforces the distinction on recorded new calls.

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

The popup has no extension-reload action. The temporary debug button, handler and opener
script are retired; manual extension reload uses the browser's normal extension management.

Content↔MAIN messages need the expected source, type, nonce and navigation epoch. MAIN evidence
is untrusted data, not instructions or filesystem permission. Prefer bounded observations of
the current document over repeated full Fiber/DOM scans. Shared selectors belong in the DOM
adapter; do not make each feature guess a different composer or terminal message.

`active-tabs.js` projects the bridge's existing `nonDiscardableConversations` policy into
lightweight debugger focus-emulation leases, plus exact still-pending input openings and the
elected model-catalog operation. At most 64 ChatGPT tabs receive rendering protection. No
Runtime/Network capture, synthetic input, global Chrome flags or selected-tab/OS focus change
is involved. Idle/personal tabs and pins alone earn no lease. Navigation, policy retirement,
failed status, unpair or wake-socket loss release it through existing lifecycle events;
ordinary idle/reuse/close policy remains unchanged. Session storage retains attachment cleanup
custody and cancellation, never activity authority. Chrome/user debugger cancellation is not
retried until that activity scope ends. Browser tools cannot borrow these attachments.
`test/active-tabs.test.ts` covers custody/races; `scripts/verify-active-tabs.mjs` verifies native
background animation pause/resume and release in isolated Chromium without observing the target
through a debugger. This fixture is not signed-in ChatGPT or installed-runtime acceptance.

### Direct background browser control

Chrome 125+ grants the companion required `debugger`, `tabs` and HTTP(S) host access. The app
adds no per-tab approval UI: existing screen/control settings govern observation/input and
Read-only still masks mutation. Only an explicit `browser_tabs new` creates a tab; listing or
attaching never activates one. A soft blue edge glow, without a hard border or text badge,
identifies an attached tab; release removes the
indicator and debugger without closing the page. Chrome's own permission/debugger UI remains.
The root debugger session enables Chromium focus emulation while attached, so hidden pages
continue rendering and accepting input without changing the selected tab or OS foreground.
Detach removes that emulation. Observation `visibility`/`focused` describe the emulated page;
they are not evidence that Chrome is selected. Native Desktop actions retain their separate
foreground behavior and are not a browser-tool fallback.

`mcp/tools-browser.ts` registers eight Desktop tools through the normal kernel, including code
mode and recording. Screen permits list/attach/release, snapshots, screenshots and diagnostics;
control permits new/close/navigation/input and page JavaScript. Execution retains exact durable
session ownership, or the configured shared unattributed principal. Live policy and caller
attachment are checked at handout and before page input. Active executor/orchestration pages
are protected from competing browser actions.

`/browser-control` uses the existing authenticated bridge and a wake-only socket topic. The
backend is statically imported by the module service worker: MV3 rejects dynamic `import()`.
Controller construction remains lazy and debugger-API-gated. Verify the production entry graph
with `scripts/verify-browser-control-entry.mjs`; a replacement fixture worker cannot prove startup.
Its 25-second RPCs are independent of the durable chat outbox: a dispatched action without a result
is unconfirmed, never reissued. Browser-incarnation tab handles avoid guessing between browser
profiles; multiple browsers require explicit selection. The MV3 custodian persists leases and
one pending result receipt in session storage. After worker reconstruction it renews debugger
subscriptions; it does not auto-attach a debugger Chrome has cancelled. Detach/unpair/restart
revoke custody. In-flight work cannot borrow a replacement lease.

DOM refs belong to a page/frame observation. Real and SPA navigation invalidate old page ids,
refs and screenshot coordinates. Isolated-world traversal covers open shadow roots and explicit
iframe selection; MAIN-world evaluation supports async expressions. Cross-origin iframe input
uses that frame's debugger widget after checking parent geometry/obstruction. Viewport screenshot
coordinates require the exact image id and unchanged viewport; full-page images are inspection
only. Native mouse position and clipboard are untouched. Results report dispatch acceptance,
not proof the website completed an action.
Snapshots retain independently actionable descendants of named cards/headings/editors and
report readiness, visibility and pointer-lock state. Ref clicks choose a hit-tested point in
the target's actual client rectangles; a fully covered target still refuses input and names
the blocker. `pageId` is the observation's top-level UUID, separate from frame and element refs.
Named keys accept case-insensitive spellings; an optional key ref must acquire that exact
target before input. `holdMs` holds a key for at most two seconds and releases it in the same
call, retaining lease checks. Tab-closed, attachment-lost, foreign-owner and stale-page errors
stay distinct. Diagnostic pagination marks remaining matching rows as truncated. Background
screenshots have a 20-second CDP bound inside the existing 25-second RPC; other CDP operations
retain eight seconds. A timeout names the command and never replays it or opens a replacement.

Traversal, result text, decoded image pixels/bytes, frame/session counts and console/network
buffers are bounded. Console and network capture starts at attach; retained history is not a
complete trace. Request bodies are fetched only on request with explicit truncation. Images use
native MCP image blocks without duplicate base64 in text/structured output. Page data never
becomes local-tool authority. Tests: `browser-control.test.ts`, `tools-browser.test.ts`, bridge
HTTP tests and `scripts/verify-browser-control.mjs` (isolated real Chromium, no signed-in tabs).

The service worker journals observations before acknowledgement, batches/replays them after
suspension, and preserves event identity so retransmission does not create duplicate turns or
messages. Two transport slots, one batch per conversation and fair batch election prevent one
hot/stalled chat blocking another. Command ACK custody precedes later observations from that
route. Reconnection restores eligible documents before creating new work; browser restart is
a different lifetime from MV3 suspension (§2).

An idle composer or missing Stop button alone does not prove a completed answer. Turn state
combines native message/terminal evidence with exact user/assistant identities and live tools.
Recording and presentation group only consecutive native sections with the same role/page id.
A user question separates responses even when ChatGPT recycles that page id. Fiber's exact
section stamp owns the local-generation join; a page-id hint is usable only when unique in
both the rendered turns and the returned descriptors. An exact final closes that generation
through the existing completion path, retaining Goal/Loop eligibility and marked-handoff custody.
Recorder observers and periodic callbacks check the extension runtime synchronously before
acting. An invalidated runtime retires through the existing stop/cleanup owner; it cannot wait
for a failed transport call to stop reinserting composer controls removed by its successor.
Existing maintenance also checks at most 64 live ChatGPT pages once per minute in one background
flight. It reuses recorder restoration, including the idempotent MAIN helper, without delaying
repair/input delivery or opening/reloading tabs. Loading, discarded, frozen, navigated and
disconnected pages are skipped; the existing page-reply deadline bounds recorder pings.
Adopted generation recovery excludes historical assistant nodes above its user question, even
when hydration remounts them. When a proven new question closes the adopted turn, its answer
lookup ends before that exact new message, preserving legitimate completion of the prior answer.
Interim prose, tool progress, refusal/error presentation, interrupted generation and final
completion remain distinct. Navigation first retires the old epoch; no late callback may record
or send for it. A settings overlay must not count as a usable hidden composer.
The activity feed's `recordedTurnId` preserves an open recorder turn for boot adoption even
after its runtime activity deadline expires. `activeTurnId` and `generating` retain their live
projection. Restart/reinstallation cannot mint a new turn for that same answer and thereby
detach its recorded MCP proof; adopting the recorded identity emits no new `turn_start`.
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

Model names and recovery policy checked against native picker metadata on **2026-09-17**:

| Display family / compatible short name | Execution identity / selected effort | Silence refresh |
| --- | --- | --- |
| GPT-5.6 Sol / 5.6 Sol / Sol | `gpt-5-6`, `gpt-5-6-thinking`; Instant/Medium/High/Extra High | 2 minutes, then 1 minute listening after confirmed refresh |
| GPT-5.5 / 5.5 | `gpt-5-5-instant`, `gpt-5-5-thinking`; non-Pro efforts | 2 minutes, then 1 minute listening |
| GPT-5.6 Pro / 5.6 Pro; GPT-5.5 Pro / 5.5 Pro | `gpt-5-6-pro`, `gpt-5-5-pro`, or an explicitly selected `pro` effort | 10 minutes |
| GPT-6 Pro / 6 Pro / Astra | `gpt-6-pro`, `gpt-6-astra`; exact Astra identities retain their finish policy | 10 minutes |
| Unobserved / unknown model | No invented model identity | 2 minutes, then 1 minute listening |

The native trigger can omit `GPT-`; the checked account still exposed full `GPT-5.6 Sol`
and `GPT-5.5` family labels. Names/aliases describe compatibility, not account entitlement.
Pro classification uses exact identities or the selected Pro effort, never `High`, a label
substring, or the fact that the account offers Pro. The picker publishes selection changes;
it need not repeat an unchanged selection in every turn-start batch. Recovery uses the recorded
selection for the exact conversation, pins known turn identity, and resolves previously unknown
selection without advancing its last-work timestamp. Unknown timing does not invent normal-model
proof for other features. All continuation paths still require their exact source/MCP/queue proof.

Direct Chrome selection is observed even with the picker closed. The existing MAIN scan reads
the current native picker state, including September's retained `dropdownContent.props`, then
stamps exact model/effort and document/route for the isolated reader. The older closed-trigger
model/effort join remains supported. Ambiguous triggers and unrecognized state remain unknown.
The closed snapshot describes only the selected native version's buckets; it is selection
evidence, never a complete catalog. Discovery elects an idle composer, reads the account-evaluated
choices once per enabled native version, and restores the original model/effort before publication.
Busy or drafting pages defer discovery without publishing a partial catalog or opening a replacement
tab. Passive selection observation continues during generation and preserves drafts. OS wake is dispatch, not
discovery completion: the IPC request returns pending and the bounded observation deadline owns
the result, so a stalled launch cannot hold Refresh/Send indefinitely.

Successful catalogs retain their observation time and persist across restart. Discovery is a
bounded nonce-scoped operation (120 seconds, at most 20 accepted models); failed refresh leaves
the last successful catalog visibly distinguishable from a fresh observation. Cached metadata
is useful selection UI, not fresh send authorization. Model and reasoning selection must both
be confirmed after relevant native changes; navigation invalidates that confirmation.
Selection and discovery also await the native picker and its owned dialog closing within the
existing three-second observer bound. Escape targets that picker focus trap; dispatch alone
is not closure. A stuck picker refuses success before strict composer focus/insertion checks.
During that operation only, the native picker menu/dialog has its animation suppressed:
hidden Chrome windows can suspend the exit animation and retain an already-closed focus scope.
Native unmount still proves closure; the temporary style is removed on completion/cancellation.
A retained `closed` menu is reopened through its native trigger before reading selection.
Picker access first waits for native hydration and prepares the owned Chat surface through
the shared DOM adapter, including direct worker startup. A remembered Work surface must not
be mistaken for unavailable Chat models and fail before prompt insertion. Startup failure
reports tell the prime to resolve the cause before requesting a replacement worker.

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

Canonical app activity owns companion tool rows. Native authored-message identity proves their
response and intervening prose boundaries; missing provider tool captions do not veto an otherwise
proven local call. Only exact answered local-connector blocks covered by the replacement are hidden.
Foreign tools, native live prose, media and action controls remain native. When an exact completed
closed Worked fold has one exact final outside it and no mounted interim prose, the companion stream
projects recorded public interim text and local calls in canonical order before that final.
Expanding restores native public prose and repartitions only the local calls, without duplicating
interim or final text. Exact React-typed thought-notification rows in that same owned response may
be hidden only while canonical local calls render; caption text is not identity, and proof loss,
Overwrite Off or navigation restores them. Native web/image/download/code/result UI and response
actions remain protected. Empty lifecycle groups leave no root or margin. The existing DOM coalescer
refreshes presentation anchors without waiting for the idle activity poll or granting turn/recovery authority.

Opening a local tool disclosure reads one recorded call through paired `/activity/detail` using
conversation, call id and canonical revision. Ordinary polling stays metadata-only. The store
reads only already-hydrated activity under its session queue, rechecking current binding; it never
opens another history, scans disk or resolves overflow assets. The bridge returns bounded stored
redacted argument/result previews with binary payloads omitted and truthful process outcomes.
Document, route and navigation epoch are checked around transport; a late response can only
populate the currently connected disclosure for that same call/revision. A bounded document cache
preserves open details across repaint and invalidates revised calls. Recording Off retains access
to previously recorded previews without creating new content.

## 14. Bridge, durable browser commands and recovery

### Shared Continue, Goal and Loop recovery (2026-09-17)

One decision boundary chooses the next automatic work: an unfinished response uses frozen
Continue text without a decision helper; a canonical final uses enabled Goal/Loop. Stop/Send
controls and bare `turn_end` are not completion evidence. An exact native assistant terminal
identity is completion evidence even when its text is empty (for example, image-only output).
Images alone, intermediate media and empty nonterminal messages are not finals.

`ui.autoContinue` defaults On (explicit Off survives; malformed-config recovery is Off).
Its switch controls ordinary chats; enabled Goal/Loop also uses the shared recovery. Helpers
and workers retain their separate lifecycle. Actual-work silence earns one initial reload:
two minutes normally/unknown, ten for proven Pro. After confirmed reload, idle permits
Continue immediately if the same question still lacks a final. Native busy gets one additional
minute (Pro: five), bounded at three/fifteen minutes from the last activity for ordinary silence.
Thinking failed earns its immediate refresh, then the same conditional one/five-minute busy
wait. Reload latency never restarts an existing wait. A final found after reload cancels
Continue and makes the normal Goal/Loop decision eligible instead.

A final whose native composer remains busy uses the same one/five-minute wait, stored in its
existing Goal reply ledger. The exact final is checked before its one durable Stop claim and
again in the native page. Unfinished Continue keeps its Stop claim in the existing outbox.
Both use the same native Stop/idle helper, then send on that document. There is **no immediate
reload after Stop**. Undelivered Continue, queued input and Goal/Loop decisions share one
pickup projection and the 2/5/10/15-minute reload schedule (fifteen repeats), with a twelve-hour
source lifetime. Native-busy polls do not postpone that schedule. A silence episode retiring
cannot delete a new pickup repair belonging to its durable ticket.

Continue text, source question/work, busy deadline and exclusive send custody live in the
outbox. One combination of ten Continue phrases, ten notices and eleven playful asides is
frozen once; notices ask to inspect existing work before repeating it, and asides explicitly
say to ignore them. Unsent eligible tickets survive restart. A never-authorized lost or failed
browser preparation releases the same ticket, without replaying a possibly consumed Stop.
Authorized ambiguous sends retain their exact receipt custody and are never automatically
resent. Native user Stop stays distinct from automation Stop. New work, final, question/input,
changed binding, running tools, block or compaction revokes obsolete recovery. Turning ordinary
Continue off revokes it only if neither Goal nor Loop independently enables recovery. Drafts,
attachments and exact document/epoch are checked before Stop and Send. Countdown presentation
projects the existing waiting/pickup deadline; it owns no timer or delivery authority.

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
The existing extension discard-custody record retains a created worker/resume tab's command id
through its first conversation promotion. App `/status` publishes live command ids from the
command ledger; retirement, foreign navigation or the 30-minute protection ceiling releases that
temporary protection. Normal conversation policy can take over. The record survives MV3 suspension
and protects foreground as well as background placement; it grants no new opening or Send.

Revival first queries/elects exact existing tabs. Query failure is unknown state, not an empty
tab list. An existing but not yet usable exact tab blocks replacement. Resume destination
election additionally obeys the continuation WAL (§15). `browserTabPolicy()` derives idle
eligibility from existing app ownership, settled turns or sleeping workers, work timestamps
and pending input/automation/continuation protection. Page presence never resets that clock.
After two quiet minutes an eligible ordinary/prime/sleeping-worker page can be used by the
existing New Chat input election; personal and dedicated decision chats are not candidates.
After five quiet minutes an unused app-owned page can close. Its durable history, worker
report and revival identity survive. The extension keeps selected pages and pages accessed
within the same five-minute close window, using Chrome's tab-local `lastAccessed` without
changing model-work or reuse clocks. Idle cleanup rechecks pins/selection/recent access/navigation
before and after the page proof and refuses unread journals,
drafts, attachments or generation. Explicit terminal cleanup retains its two-minute grace;
superseded sources and duplicate documents keep their existing retirement rules.

An abandoned managed tab must **close**, not remain parked on an empty `chatgpt.com` page.
If New Chat reuse fails before Send and opens its one allowed replacement, that same operation
retires the now-empty source using its original document, exact navigation epoch and fresh
no-draft/no-work proof. Preserve pins, personal home pages and intervening navigation or input.
Worker completion never authorizes deleting its durable history or revival identity. The three
empty tabs reported on 2026-09-13 were already user-closed; the proven reuse leak and its
regressions do not establish those tabs' original cause or live validation of the fix.

### Recovery policy

`tabRecoveryWanted()` means **active Goal/Loop OR the user's recoverAgentTabs switch**. It gates
silence/no-tab recovery for workers, primes and ordinary chats. Reload repair for exact errors,
Unattributed incidents and compaction has its own evidence. “Recover agents” is not blanket
permission to reopen the session list. A plain historical chat with no current work is unprotected.
Chrome can still suspend an app-used background tab two ways: Memory Saver *discards* the document
(the shell keeps its URL and answers tab queries) and Energy Saver *freezes* its timers.
`autoDiscardable` protects only against discarding; no extension API exempts a tab from freezing.
The extension reports discarded/frozen shells in `stalledConversations`, and the bridge answers
each report with the missing-tab decision minus the close side effects — same recovery policy, one
bounded reload of the exact tab under the shared cooldown, retired by its first real activity. A
deferred worker revival likewise reloads a discarded exact tab rather than reading its dead page
as proof the tab is still there. An idle chat with nothing owed is deliberately left asleep.
Provider access-limit notices preserve only an active Goal/Loop's existing exact session/turn
recovery grant. They neither renew its deadline nor discard a pending/spent repair or postpone
Goal pickup. Genuine new work in the same batch keeps its ordinary rearming authority, and an
accepted terminal boundary still retires its pending repair, including after handout. Ordinary
chats retain their no-reload behavior for these blocking notices; no new grant comes from a dialog.

| Trigger | Required meaning |
| --- | --- |
| Missing tab | Current non-retired binding plus still-owed/live work and recovery policy; ordinary chats need recorded tool work, workers use broker attachment state. |
| Stalled tab | Extension-reported discarded/frozen shell; the missing-tab decision minus close side effects, under the shared reload cooldown. |
| Page silence | Known live activity with model-specific deadline; a live local process and browser liveness are different facts. |
| Assistant error | Exact turn/error, per-turn retry budget and cooldown; repair the broken page without fabricating a new task. |
| Unattributed | A separate unresolved incident after attribution has landed; re-observe suspects, never assign ownership by proximity. |
| Queue / Goal watch | One qualified waiting episode for the visible next input or eligible Goal source; Pro uses a ten-minute floor. |
| Compaction pickup | A durable continuation ticket whose current transport phase allows that pickup. |

Unattributed recovery keeps a bounded incident per exact unresolved request id, with one
shared timer. At the first filed unattributed call it freezes the chats then shown Active,
using the same shared activity predicate as the renderer. One candidate is eligible after 15 seconds;
multiple candidates get a fixed one-minute window. The second and final attempt is due five
minutes after that incident began, only if new unattributed work on that same request started
after the first browser attempt and the request remains unresolved. Another request cannot
renew this budget. Headerless activity cannot prove the same request and gets no second attempt.
Exactly attributed current-owner MCP calls remove their chat from the original cohort; exact
correlation resolves the matching request. The cohort survives activity-label expiry, but never
Stop, block, a completed/replaced turn, session rebind or supersession. Later active chats do not
join it. These deadlines follow the recorder's separate 20-second request-id grace.
Attribution repair handouts retain their token after an absent acknowledgement. The extension
claims the server-held attempt after its tab scan and immediately before its browser action;
late attribution or lost owner authority denies that claim. A reload receipt proves the action,
not that attribution recovered. Other repair reasons retain their own delivery policy.
Assistant-error repairs retain their three-minute cooldown. Attribution, silence, Goal,
compaction and no-tab follow their own eligibility and schedules.
The canonical authored question owns one error reload, not document-local generation ids or
ended-turn counts. Without a recorded question, the latest durable start is the legacy owner.
A queued error repair retires when a new question or a newly recovered final supersedes it.
Its exact token is claimed after the extension's tab scan; unclaimed offers retain that token,
and a claimed attempt is never reissued on missing acknowledgement. Progress stays anchored to
the original source turn. A recoverable transport banner does not end a natively generating
turn; exact Thinking failed keeps its immediate failure rule. Exact native final evidence
supersedes a stale transport banner and retains ordinary Goal/Loop eligibility.

Automatic response recovery follows the shared decision and conditional busy wait above.
Authored queue delivery retains its own input eligibility under §11 and takes precedence over
a generated Continue or Goal/Loop message. A synthetic unfinished Goal decision is no longer
filed automatically: recovery uses Continue until a canonical final appears.
Continue, queue and Goal/Loop share pickup gaps of 2/5/10/15 minutes, then retain fifteen until
expiry, including Pro after its initial ten-minute silence and conditional five-minute wait.
Reordering, replacing the head on the same
source and Goal Off cannot reset the backoff. Missing pickup ACK retains its original action
custody; status polling does not issue a fresh token. Startup restores eligible durable debt
with the normal first grace period. A twelve-hour source age retires automatic pickup authority
without deleting queued text. Newer questions veto older Goal debt. Fresh
source/session/stop/block/continuation and listening checks apply again at repair handout.
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
second continuation owner. Unknown-chat recording honors its existing 60-second claim window
instead of creating a shadow session after five seconds. Commit/abort releases the wait early;
one claim window bounds each admission wait even when overlapping claims appear. Known sessions
remain immediately readable. The ledger phases are:

```text
awaiting-summary -> awaiting-chat -> claimed -> committing -> committed
       \------------------- pre-commit cancellation ------------> aborted
```

1. **Reserve A.** Persist an exact continuation token and source/session identity. Automatic
   compaction is level-based: current estimated context exceeds the threshold **and** the
   chat has live work. Idle old history does not start it. Workers and exact Pro are excluded
   from automatic compaction; workers do not self-compact, and Pro may compact manually.
   A transport error may also trigger it for the exact latest failed turn above the threshold.
   The failure must remain the latest work boundary, without a final, new question or reopened
   turn. Binding, policy and source proof are rechecked after reads; old/unscoped banners and
   manual Stop cannot grant the exception.
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
A manual ticket whose frozen source selection is Pro instead gets a one-hour deadline while the
brief is being written: Pro reasoning is not visible transcript, so it produces no text growth
to renew the ordinary clock, and a healthy long Pro generation used to be swept as "took too
long". Captured/claimed phases and an unobserved selection keep the ordinary ten minutes.

An unnamed destination never reports a successful resume ACK, even after a transport banner.
Keep its armed dispatch and journal gate for exact marker reconciliation; a missing id plus
generic timeout text is not proof of non-delivery and cannot authorize another Send.

The continuation WAL freezes the source's confirmed model and reasoning selection when its
session and selection both name A. Placement and bootstrap project that one intent; B's native
picker still verifies and records its own selection before Send. Legacy or unobserved selection
stays null and is never reconstructed from a later change in A.

An expired automatic browser command durably releases only its own unattempted destination
claim before command retirement. Redeem, destination checkpoints and retirement serialize
through command custody; checkpoints also prove the exact document owner and WAL claimant.
Attempted/ambiguous sends retain their fence. A committing transaction or failed durable
retirement grants no immediate delivery retry. A loading destination can checkpoint only on
its owned URL; a foreign pending route remains ineligible.

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
An exact caller without its own family receives a successful empty `agents status`, regardless
of other active primes. This neither creates a family nor grants a role; unknown identity still
fails closed. Sleeping-worker measurement remains scoped to the caller's actual history.

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

Revival reserves the new assignment with its current inbox task preview, a neutral worker-id
label and no completion result. The previous spawn label/result must not describe new work.
Rejected acceptance restores that prior metadata; accepted work keeps its new metadata even
if browser wake fails. Historical reports remain in the prime inbox and recorded history.
A worker proving it never stopped clears its obsolete result while retaining the same task.

After a worker reaches its own 400k estimated-context ceiling, its next stop becomes terminal
and it is no longer reusable. Do not interrupt its current useful work merely for that ceiling.
Status/message remeasure sleepers before revival. A terminal worker can be replaced deliberately;
raising the user's worker cap is not a substitute for lifecycle correctness.

Detached means browser attachment is missing, not necessarily that tool execution died. An
exact call can prove the worker server-side alive; a new page can reattach it. During waking,
an already-alive proof may cancel an unclaimed reopen, but after handout the existing operation
owns delivery. A new accepted call/turn proves post-delivery activation. A replayed old final
must not put the revived worker back to sleep.
The native turn can reach the recorder before the send ACK. Both ACK and observation handling
reconcile the exact delivered command with recorded starts since its document claim, then use
the same durable final/report boundary. A tool-free answer must settle in either arrival order;
old turns, another run and a replaced command cannot supply that proof.

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

Deliberate On files/rearms an obligation **only when the chat is idle**: a proven eligible final
or an exhausted model-specific silence/failure window with no current work. Generating chats,
running MCP calls and an unexpired ten-/two-minute window do not file a ticket merely because
the switch toggled. The switch stays enabled for the next eligible boundary. A stopped/failed
answer with no final can be rearmed deliberately after that gate using its exact recorded end;
do not fabricate final prose or a refresh receipt. Check current switch identity and work again
after asynchronous reads so rapid Off/On and a new turn cannot publish stale debt.
If the switch stayed Off through a proven silence recovery, the same Goal ledger retains only
a handled source record. This creates no pending ticket or draft. Later explicit On can rearm
that exact exhausted source, including an unreconciled open recorder turn, only while no newer
question/work exists and the current model's continuation setting permits it.

Ordinary non-Pro Goal/Loop considers verified **completed final answers**, not interrupted
turns or generic composer idleness. Pro Loop defaults to **Only finish**. Its per-chat switch
can opt into **After this turn + finish**; the preference survives toggles, restart and resume.
The desktop shows this choice as soon as its account-observed composer selection is Pro and
Loop is selected, including before the first message. A new-chat opening freezes `loopAfterTurn`
in its existing outbox entry; pending edits and the exact send receipt transfer it to the chat
switch through the same serialized automation path. Retry retains that explicit preference.
Astra Goal remains finish-only. At `session_finish`, both modes use the Loop decision policy
and inject through the eligible tool response (§11).

Opted-in Pro Loop uses the existing Goal reply ledger for real finals. Unfinished responses
use shared Continue recovery (§14), including without a local MCP call. No automatic Goal/Loop
decision is generated from silence or a failed response.
**User decision, 2026-09-13:** every automatic Loop continuation requires at least one recorded,
exactly attributed local MCP call in the source turn, including ordinary completed finals and
finish follow-ups. Native page tools, another turn's calls and unattributed work do not qualify.
The proof is existence in the exact source turn, not a requirement that its call be the latest
stored row. Late attribution backfill without a turn must not erase earlier exact proof.
Explicit user activation may proceed without that proof after the existing idle gate. Only the
activation setter records that exemption in the existing reply ledger; browser parameters or
reply-ID prefixes cannot grant it. Recheck restored automatic debt, provider start and delivery.
This condition does not change ordinary Goal mode or user-message delivery.
Automatic tickets retain exact source ownership. Native busy uses the shared one/five-minute
wait and one Stop claim; uncollected tickets use the shared 2/5/10/15 pickup schedule (§14).
Fresh work and queue priority are checked again before Send. A Thinking-failed notice learned
from an already-confirmed refresh reuses that receipt rather than earning another immediate
reload. Genuine new work retires the receipt.
Historical interim backfill after a refresh must retain an already-filed ticket: a new storage
sequence is not new work. Authored chronology and the recorder's accepted activity grant decide
revocation; genuinely new MCP/interim/user work still revokes the old automatic source.
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
If a delayed retry yields to temporary native work or compaction after its wait elapsed,
release its page pickup claim. The existing activity feed may collect the same still-pending
server obligation once safe; do not acknowledge it as handled or require a reload to recover.

### Three backends, two different helper roles

| Backend/role | Behavior |
| --- | --- |
| ChatGPT decision helper | Default driver backend. Each Goal/Loop decision uses a Temporary Chat with bounded reference history; outputs a decision, never executes that history. |
| API driver | OpenRouter-compatible default or explicit compatible endpoint/model/key. Supports bounded streamed progress and validated final decision. |
| Goal templates | Offline explicit terminal-marker policy; only Goal supports this backend. Missing/ambiguous expected markers pause rather than infer completion from prose. |
| Temporary planner | Captures a new workflow for the user in Temporary Chat. Shares temporary transport with decision helpers while retaining its staged-workflow role. |

Goal gate, objective and Loop prompts are separately configurable. Default helper selection is
Sol/high in the checked config, but live account metadata governs whether it can be used.
The default prompts use a shared, concise bullet contract: write instructions to the executor,
retain the whole original brief plus later user corrections, and assign substantial coherent
work with implementation, integration and relevant validation together. Worker setup and small
fixes are steps within that work, not separate rounds. Explicitly narrow user requests remain
narrow. Goal stops at the requested outcome; Loop raises the quality of the same outcome without
recursively shrinking to the latest detail or repeating settled reports. Verbatim old defaults
live in `shared/goal-prompt-history.ts` only for exact-match migration; custom wording is preserved.
API model discovery is bounded and cached by endpoint/key; a list entry does not prove an
execution succeeded. The API reasoning picker uses OpenRouter's per-model `reasoning` metadata,
including supported efforts, mandatory reasoning and the default effort. Absent effort metadata
does not imply support; an explicit null list accepts the gateway's efforts. The selected model's
metadata accompanies every catalogue page, even when its row is on a later page. Saved unsupported
values stay visible until the user changes them or selects another model. Custom endpoints retain
manual effort selection. Exact effort values, including Max and Extra high, pass through the API
request; the browser-helper reasoning setting remains separate. Secrets remain in the main process's encrypted store. Custom endpoints
receive the explicitly assembled reference context; local recording is not a promise that
Goal API requests stay on the device.

The driver context includes canonical authored user messages, stable assistant interim/progress
and final text. **Interim messages remain included when Thinking failed leaves no final answer**:
both the ChatGPT helper and API Loop receive the original task, subsequent user corrections and
canonical interim text once, in chronology. Missing hidden thinking is not permission to drop
public interim prose; app status/error notices are not model-authored work. Goal/Loop and finish
decisions never include recorded tool arguments/results, even on older installs with the tool
preference enabled. `includeToolCalls` now controls handoff briefs only (default Off). The saved
Loop task is supplied in full as a separate instruction on every decision, outside history
selection; newer answers and history limits cannot replace it. Read user-reference history separately so assistant
traffic cannot evict middle corrections before selection. Preserve original task/steering and
committed handoff provenance under the message budget; user references have a larger per-message
allowance and explicit clipping. Exact same-session outbox `finishOwner` identities label known
automatic messages; unknown native user-role rows do not prove human authorship. Both API and
browser receive reference data rather than the helper's own prior assistant turns. Temporary
planners retain their staged-workflow role. Browser budgeting includes prompts and JSON escaping
inside the complete 96,000-character envelope. Each browser decision receives its complete bounded
reference; there is no reusable-helper delta context. The existing `temporary-planner` transport
owns all three helper modes. Verify native Temporary Chat before sending. Accepted helper output
immediately retires its exact tab after fresh document/epoch, idle, pin and draft checks; cleanup
does not wait for a replacement tab. Historical helper role fences remain valid. Clear temporary
answer content before durable state publication; it is not a normal recorded executor task.

The app's existing Goal/Loop composer row shows answer settling and real waiting reasons before
a draft exists, then the generated continuation text and delivery state. Both app controls and
the extension project the same pending reply and activity/listening deadlines. Display countdowns
grant no execution authority. A full canonical final consumes silence immediately, including an
exact final first backfilled after a completed turn; interim prose and Stop/Send changes never do.
A completed MCP-backed response without final text is a recovery indication, not a terminal error:
normal chats use two minutes before reload and one minute of listening after confirmed reload.
Expired recovery debt goes directly to decision preparation without another Answer Settling wait.
Fresh work invalidates that debt and any captured draft, including across async activity reads.
Pro retains its existing ten-minute silence and five-minute listening/deferral policy.
If the source reports work before a prepared continuation reaches native Send, abandon that
exact draft without acknowledging its obligation as handled. The existing pending reply owns
a fresh minimum two-minute wait (Pro: five minutes); retries prepare a new decision. Repeated
reports for the retired token cannot extend the deadline or revoke a replacement. The browser's
bounded receipt journal distinguishes pre-send busy cancellation from successful delivery so a
lost deferral response cannot resurrect the old text. App/web name this wait explicitly.

Goal/Loop/planner failures retain machine codes for retry/ownership but publish a separate readable
explanation in app and browser. Missing MCP evidence explains that the previous response made no
local tool call, so lost tool connectivity cannot be established; Loop remains enabled. Do not
claim login is missing or the tunnel is off without evidence. Distinguish input size, helper output
size, provider failures and uncertain delivery. Browser error text wraps instead of truncating.

Provider progress updates one existing timeline row and is never sendable text. Validate the
final bounded decision schema before publication. Goal may return stop/no reply. Loop requires
a continuation and has a bounded three-retry invalid-stop policy. API SSE is used when publishing
progress; legacy plain streaming is compatibility handling, not another driver authority.
Cancellation/timeout must release only that exact attempt and leave an honest error/retry state.
Cancelled automatic finish drafts are historical outbox records, displayed at their creation time
with a timestamp. They must not remain beneath every newer message as though still awaiting Send.
Keep manual failed-send notices and genuinely pending instructions in their existing controls.

Reply obligations are durable and bounded (12 hours / 200 rows) with handled tombstones so old
browser observations do not rearm discharged work. A provisional exact `turn:<id>` observation
with `eventSeq=0` survives restart and can later gain durable event-sequence evidence without
rearming an already handled decision. Settings/key replacement cancels and removes stale attempts
while preserving pending source debt; master Off explicitly retires that debt. Helper failure
never counts as a source decision. Settled transport/settings failures retain their retry fence
and do not trigger source reloads while awaiting intervention. Normal and restored committed
resumes share one projection: move objective/switch, retire A's debt, and let B earn its own.
Current persistence/publication exceptions are in §21.

## 18. Desktop workspace, plugins, connection and native control

Dark is the default theme. Theme selection belongs in Appearance settings; the main header
has no light/dark shortcut. Files and worker-panel controls attach to the header independently
of appearance controls.

### Renderer and IPC

`renderer/main.ts` owns the shell/setup/settings; `chat.ts` owns sessions, composer and timeline.
Projects, workers, plans, model choice, usage and plugins have focused modules (§4). The renderer
calls a fixed `preload/index.ts` allowlist into validated `ipc.ts`/`plugins-ipc.ts` handlers.
No arbitrary IPC invocation, Node access, filesystem path opening or renderer-side secret store.
Changing the selected session synchronously retires prior data/control ownership and handoff.
Keep the last painted transcript and images inert while the destination detail loads, then
replace them directly; queue/status repaints must not flash the New Chat welcome screen.
A failed destination read clears retained rows. The welcome belongs only to explicit New Chat.
Unbound local sessions do not request provider-only controls. The timeline and pending-message
projection reconcile exact input/native message identities in the same paint: keep an accepted
bubble until its history arrives, then remove its pending copy. Unchanged pending rows stay mounted.
The outbox's `historySeq` is the store-confirmed canonical origin. Once the loaded publication
cursor covers it, the pending projection cannot resurrect that input when its history page is
evicted. Historical browsing leaves committed inputs with history. Never infer membership from
the minimum event timestamp: old observations and tool start times can occur on newer pages.
Pushes and async loads are scoped to selection/draft generation; a late load must not overwrite
focused edits or a newer A → B → A view.

First-run Setup keeps the six-step flow, with reviewed screenshots in `renderer/setup-images/`
and translated numbered highlights in `renderer/setup-guide.ts`. Sensitive identifiers must
be removed from asset pixels before inclusion; an HTML overlay is never a privacy boundary.
The guide names the bottom ChatGPT workspaces field, restricted Tunnels Read + Use, a running
tunnel before plugin creation, Settings → Security and login → Developer mode, Plugins → +,
and Authentication → No Auth. Desktop tunnel entry and its connector card start collapsed with
an explicit optional label; status pushes preserve disclosure state and do not enable it.
One tunnel image and one Security and login image avoid duplicate paths. Both plugin images
remain visible together, side by side when space permits and stacked at narrow widths, with
translated written callouts anchored to the highlighted controls and native enlargement. Required Core tunnel/API-key fields
have a subtle blue empty state; a stored key satisfies it without exposing the secret. Optional
Desktop fields are not marked required. Setup assets contain no embedded image metadata.
The final Setup card uses the supplied `tool-approval.jpg` screenshot at compact width and
explains ChatGPT's Always allow separately from Plugins' Allow all actions. The existing
authorized model-discovery browser handoff emits `setup:toolApprovalNotice` only after its
dispatch succeeds. `renderer/tool-approval.ts` shows the same reminder once until dismissed;
only dismissal persists the local acknowledgement. The permanent card remains available.
This presentation event proves neither a newly opened tab nor provider approval, and grants
no browser-opening or tool authority. A passive discovery or failed handoff emits no reminder.
`scripts/verify-setup-guide.cjs` checks production renderer modules/styles in an isolated UI-only
Electron fixture, including simultaneous images, zoom, translated labels and native enlargement.

The sidebar groups local projects/sessions, exposes worker state and retains deliberate width
and expansion preferences. Project chat titles align with the project name. Groups initially
start collapsed; a summary pointer/keyboard click commits its disclosure intent before a repaint.
Activity repaints preserve the focused project summary without taking composer focus, and repeated
activation of the already visible chat panel does not start another sidebar refresh.
Selecting a project chat or project-scoped New Chat deliberately expands that group. An open
group initially shows five parent chats; Show more adds eight, preserving expanded worker children
and the selected task. `renderer/sidebar-order.ts` owns a bounded localStorage presentation order:
dragging or Alt+Up/Down moves a parent and its worker children within its current project or
unfiled group. A drag beyond the group clamps to its first/last visible slot; it cannot change
project ownership. Pointer custody defers row replacement during live refresh and revalidates
membership before saving. Off-page order survives partial list refreshes.
The chat keeps the current input queue/plan visible alongside a
paged transcript. Main owns durable mutation acknowledgements; renderer optimism is not a
receipt. Native edit context menus respect the focused editable control and selection.
Setup's Show/Hide guide button stays available even while setup is incomplete. Manual collapse
survives status pushes. Profile management stays out of first-run Setup: a compact row below
Language in Appearance has a dropdown, a plus button with a name dialog and a delete button
on each profile entry. New chat uses the existing
pencil icon, with white foreground in dark mode. `scripts/verify-sidebar-setup.cjs` exercises
real Electron pointer/keyboard input and layout against isolated production renderer modules.
The base zoom is 1.17 (10% below the former 1.3); the existing zoom controls remain relative to it.
The plan heading is a native disclosure with a visible open/closed chevron. A newly opened
chat starts with its plan collapsed. Collapsing it returns height to the conversation;
status updates preserve the user's current disclosure state.

The recovery row above Goal/Loop shows read-only countdowns from `bridge.ts::sessionControlsFor`:
confirmed Thinking-failed listening, an outbox/Goal native-busy deferral, and each unresolved
attribution incident's exact candidate deadline. `renderer/recovery.ts` updates only the seconds
using the existing visible-chat clock; zero says checking/pending, never sent/reloaded. Fresh
work or attribution removes the relevant countdown, and native busy projects the same owner's
extended deadline. Pro silence becomes visible after five minutes without work and counts
down to the existing ten-minute deadline; fresh work hides it for the next five minutes.
The normal two-minute silence clock usually stays hidden; its confirmed reload reveals the
one-minute listening countdown. A completed page boundary without a canonical final immediately
reveals the existing normal/Pro silence deadline in app and browser. New MCP activity removes this
special early visibility and restores the usual two/five-minute delay; it does not create a second
countdown authority. `visibleAt` lets the existing renderer clock reveal a Pro row without a
new backend scheduler. Selection generations fence delayed controls and clear old-chat timers.
Listening rows name the next existing step: queued input takes priority, otherwise the active
Goal or Loop obligation. This is a projection of delivery ownership, never another trigger.
After attribution's first attempt, every still-unproven member of its original cohort keeps
the countdown to the incident's existing five-minute end, even without another unknown call.
That row says awaiting attribution/check, since the existing retry conditions still govern
whether another reload is allowed. Exact MCP proof removes only its chat; later chats stay out.

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

English, Spanish and Simplified Chinese are explicit UI translations (`i18n.ts`, `locales/{es,zh-CN}.json`),
with the selected locale in `cos.ui.language`. Changing language repaints owned labels while
retaining drafts/selections; never translate authored messages, provider text or file paths.
Bindings live only in a WeakMap keyed by their DOM node. Language changes walk the current
document, including hidden panels and bound text nodes. Never retain or periodically dereference
an index of every past label: WeakRef sweeps keep detached trees alive during allocation-heavy
repaints. `scripts/verify-renderer-label-memory.cjs` checks real Chromium collection under repeated
row replacement; ordinary language tests preserve controls, drafts and authored values.
Authored prose uses automatic text direction; shell/code remain LTR with logical layout edges.
Theme and layout preferences do not change backend authority.
Settings places ChatGPT model defaults second and Workers & recovery third, after Continuation
sources. Appearance has its own Settings navigation page, including the language selector and
existing setup profiles. The connector-instructions editor
is removed. Settings saves preserve existing stored MCP instructions for compatibility.
Dropdowns use native customizable selects (`appearance: base-select`) with theme-matched
top-layer pickers, wrapping option labels and native keyboard/focus semantics. Pro Loop delivery
stacks its label and full-width control within the composer menu. `scripts/verify-dropdown-layout.cjs`
checks the real Electron layout and opened pickers at normal and enlarged zoom.
Appearance and other Settings selects use paint containment so native dropdown repaints
do not change neighboring rasterized edges at fractional zoom. Top-layer options remain
outside that clip. `scripts/verify-settings-focus.cjs` checks unchanged geometry, pixel-exact
restoration after closing/blurring, and hit testing options beyond the card edge.

Appearance uses `ui.appearance` in the existing config, with separate Light/Dark background,
sidebar and accent RGB colors plus contrast. Native color pickers and HEX fields allow every
six-digit RGB color. A shared font choice, 12–18px base text size and translucent-sidebar switch
apply immediately; Reset appearance restores both palettes and typography without changing the
theme, language or setup profile. Text size scales the existing typography hierarchy, including
code, independently of window zoom. System font retains the locale-specific fallback stack.
Readable foregrounds, secondary text, borders, status colors and accent labels derive from the
chosen surfaces; sidebar text derives from its own color. Translucency is an in-window tinted
gradient/blur, not transparency through the native window to other applications.
The connection status popover shares the sidebar's palette, accent and foreground tokens,
background gradient and blur. The same translucency preference controls both surfaces.
Goal/Loop selection, Save task, selected dropdown options and Usage activity levels use the
same readable accent token. Usage retains four increasing tint levels and neutral empty days.
The main config and IPC schemas share bounded validation. Invalid disk appearance alone falls
back to defaults without resetting permissions. Settings IPC merges each appearance field
against its captured base, preserving concurrent edits. Renderer input previews remain local
until change; pending saves and dirty HEX input survive status pushes. Native caption symbols
and reload backing follow the persisted palette. `scripts/verify-appearance.cjs` exercises the
production renderer in isolated Electron with color, queue/push, theme, reset, reload and narrow
layout checks. It does not operate the installed app or a provider conversation.

`renderer/plugin-refresh-reminder.ts` owns the chat-header reminder to refresh plugins
in ChatGPT. Its X stores only the acknowledged running `state.update.current` version in
`cos.plugins.refreshReminder.dismissedVersion`; downloading a newer version does not rearm
it. No acknowledgement shows the reminder, including the first version with this feature.
It survives restart until dismissed, returns for a different running version and is hidden
in Settings. It stacks with update/extension notices and never marks an actual connector
refresh complete or starts a browser action.

### Project Files workspace

The Files panel projects the current session's LocalProject through fixed IPC using a project
UUID and relative paths. It does not change the main composer or grant additional filesystem
access. Main re-resolves current approved roots and rejects traversal, symbolic links/junctions
and project-root mutation. Files and the read-only sub-agent panel share one resizable work slot.
Directories load one level at a time (500 entries); at most 128 expanded directory watches are
retained. Collapse, panel hiding, renderer reload/destruction and root removal retire watchers.
Files uses one action toolbar with Refresh; the outer Files toggle closes the panel. Its shared
work slot can grow to host width minus 360 px for chat, without a fixed maximum pixel width.
Unchanged session/directory updates preserve preview DOM and pending code loads. File reads keep
the previous accepted preview until replacement content is ready; hidden previews stay hidden.
The horizontal preview separator paints a one-pixel hover line with a three-pixel drag area.
The tree keeps keyboard focus across refreshes and supports arrow/Home/End navigation with
Enter to activate. Preview and tree share layout space rather than overlapping; the preview's
Files toggle temporarily hides the tree for reading. Closing the preview restores it.
Creating an entry uses the same unsaved-edit guard as changing the selected file.

Text previews/editor input are bounded to 256 KiB; full editable previews retain exact UTF-8,
BOM and line endings plus a content/file-identity revision. Save stages complete replacement bytes
beside the original, flushes them, revalidates project access and the original revision, then
renames. A failed staging write or rename never truncates the original. Duplicate saves are
refused and newer edits typed during a pending save remain dirty. Atomic replacement is not an
OS-wide lock against an unrelated writer after the final revision check.

Images accept at most 5 MiB input and 16 megapixels, then decode to a bounded 1600-pixel thumbnail.
PDF input is bounded to 20 MiB; bundled PDF.js renders one page with at most 16 megapixels and
8192 pixels per backing-store dimension. Retiring a preview immediately cancels its loader/render.
Markdown drops active content and remote images. Unsupported or oversized files remain available
through Reveal or Attach without a fabricated preview. Delete uses the OS Trash after confirmation.

The renderer retains at most eight unsaved project drafts during project navigation. Async dialog,
preview, watcher and save results recheck their original view generation. File attachment staging
captures the existing ComposerDraftOwner before the await, so a later chat cannot receive it.

### Plugins: installation, execution and connector refresh

The optional Plugins connector proxies installed enabled MCP servers. `catalog.ts` describes
reviewed entries; `installer.ts` owns installation/package materialization; `manager.ts` owns
stdio/remote clients; `exposure.ts` owns accepted live tools; `oauth.ts` owns authorization.
Local npm/Python/MCPB packages and remote endpoints have different setup needs. Editor plugins
such as Blender also need the editor-side addon and a successful readiness probe.
Each local installation keeps its stable plugin UUID and an exclusively created short
generation directory. Replacement preserves the old working generation until publication;
short generation names leave room for nested Python package data on Windows. Existing stored
installation directories remain valid; no operating-system long-path setting is changed.

Enabled installations restore/connect in the background and remain available while idle; there
is no idle-eviction/restart loop. Disable/uninstall revokes exposure synchronously before slow
shutdown. Accept bounded validated schemas (up to 256 upstream tools and 250,000 schema bytes), preserve
upstream names, and fail closed on collisions, including retained disabled-name claims. A
cached unauthorized schema is not live exposure. External servers retain their own OS/account
permissions; the app's approved-path wrapper is not an OS sandbox around a third-party process.
Refused calls classify the current admission fact: a name absent from every retained catalog is
unknown/stale/wrong-connector; an exact exposure conflict or schema-limit issue is not exposed;
only a uniquely known disabled integration/tool is disabled. Sign-in, authentication in progress,
server error, residual unavailability and shutdown keep their separate diagnoses. Connector refresh
cannot repair those states. Retained declarations and exposure issues explain refusal only; they
never route a call, select a conflicting owner, start sign-in or reconnect. Every pre-dispatch
refusal records `tool_rejected` and says the requested tool call was not dispatched. An admitted
upstream error remains `tool_execution_error`; its arbitrary text cannot redefine admission.
Refresh observations allow the registrar's one additional code-mode tool. Legacy 64-tool
snapshots (plus optional code mode) can enroll only as an exact declaration subset of the
current Plugins publication; refresh completion still requires the complete current catalog.

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

Disconnect immediately publishes `disconnecting` and coalesces repeated clicks into one
transition. MCP drain protects only complete requests admitted to the adapter: idle TCP,
partial headers and incomplete bodies are closed without waiting for HTTP timeouts. Accepted
responses flush before tunnel retirement; no ordinary force timer truncates committed work.
Final shutdown can bound an already-running drain directly, rather than queueing its deadline
behind that drain. Activity logs record Disconnect admission and the accepted-response count.

The sidebar footer owns global connection controls in a compact popover outside the translucent
sidebar stacking context. Its sidebar-themed surface is 160 CSS pixels wide, with
single-line labels and status dots. Status text remains accessible to screen readers and in
tooltips; Advanced chat/request labels retain their copy action, with full values in tooltips
and Runtime diagnostics. Verification/last-seen ages remain in tooltips. A small plus opens Advanced, including
the extension version and session capture. The request pipeline lives inside Runtime diagnostics.
Every opening collapses Advanced and its nested Runtime diagnostics.
Extension-only Overwrite/Timestamps and the redundant settings link are absent. A red header
Connect action remains visible while disconnected and disappears only on confirmed connection,
briefly highlighting the footer status (respecting reduced motion). Setup stays reachable from
Settings and from Connect when configuration is incomplete. The View menu has its own foreground
stacking layer; Appearance rows align controls at a shared minimum height and Setup uses a stable
responsive title/language grid across locales.
The companion sends a bounded snapshot on the authenticated `/diagnostics` route, outside the
authority-bearing `/status` response. One pending diagnostic page read is shared; current
connection/document epochs fence delayed results. The bridge cache is presentation only and
clears on disconnect/stop/reset. Request discovery, receipt, exact ownership and recorded tool
activity remain distinct evidence. Optional embedded-host presentation does not enable or
implement an embedded browser.

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
| Files/patch/output/code-mode | concrete tool owner → kernel serialization | `codex-*`, `exec-*`, `code-mode-*`, `mcp-tool-declarations` |
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

When integrating external PRs, preserve original authorship. Adapted or snapshot-integrated
work must name the original PR/author and carry appropriate GitHub-linked `Co-authored-by`
trailers; update `CONTRIBUTORS.md` and distinguish incorporated code from reports/proposals.
Closing a PR or rewriting its implementation does not remove the contributor's credit.

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
The macOS afterPack hook removes Electron's unused camera, microphone and audio-capture
privacy descriptions before sealing, retaining Screen Recording. Strict plist readback and
bundle smoke checks reject failed cleanup. This does not establish publisher signing,
notarization or permission continuity across updates.

Dependency updates retain upstream compatibility contracts: Node typings follow Electron's
embedded Node major, and Vite stays within electron-vite's declared peer range. Electron 44
clipboard reads/writes are asynchronous; await publication before reporting success or
injecting Paste. A catalog update must refresh its exact package/license evidence. Bundled
cloudflared belongs to the verified tunnel-client distribution; do not substitute unrelated
upstream binaries while retaining that distribution's checksum or notices.

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

- **Repair handout vs action:** attribution and assistant-error repairs claim their exact attempt after the
  extension's tab scan. Other repair reasons still mark handout before the tab query/action
  without that final claim. Intent requires browser actions to retain current authority
  through that boundary.
- **Goal publication:** explicit switch writes serialize, but mutate shared memory before
  the awaited durable write; synchronous clear/move paths and objective/reply mutations do not
  all share the same semantic transaction. Intent is durable commit before visible state, with
  rollback unable to overwrite a newer accepted change.
- **Goal cross-ledger controls:** master/config/secret changes still cross separate ledgers.
  Recording Off lacks a uniform runtime gate for retained per-chat overrides. Attempt
  invalidation now preserves debt, but these remaining controls still need one durable
  semantic transaction and effective current-setting enforcement.

Do not restore obsolete claims while investigating: two MCP surfaces, one global prime run,
three browser command kinds, fixed 60s Unattributed repair, tab-query
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
