# cos-types

Serde types for the files Chat On Steroids keeps under its user-data folder and for the JSON it
exchanges with the browser extension and local control API callers. Field names and JSON shapes
match the TypeScript app. Every later Rust unit reads and writes these formats through this crate.

## How the shapes are proven

`tests/fixtures` holds JSON that the TypeScript app wrote. None of it is written by hand.
`tests/round_trip.rs` deserializes every fixture into its Rust type, serializes it again, and
requires the same JSON value. For formats whose writer fixes the key order (a zod schema or one
object literal), the test also requires the same bytes. The current set is 432 fixtures, and
77 of them are byte-for-byte.

To regenerate the fixtures, run this command from the repository root (it needs `node_modules`):

```sh
node rust/crates/cos-types/fixture-gen/regenerate.mjs
```

The script runs 36 of the app's own vitest files (`HARVESTED_TESTS` in
`fixture-gen/vitest.config.ts`) and the generators in `fixture-gen/*.gen.ts`. During the run,
`fixture-gen/harvest-setup.ts` records each generation of a `state/*` ledger as the app hands it
to `durable.ts`, each other user-data file write, each HTTP JSON exchange, each control API event
stream, and each wake socket frame.
`fixture-gen/select-fixtures.mjs` then keeps one capture per distinct shape, preferring the
smallest. It also rewrites machine paths (the temp folder, the checkout, the home folder) to fixed
placeholders. Captures that a test wrote itself, such as legacy versions or deliberately damaged
values, are loader inputs rather than app output, so the script leaves them out. Pass `--select`
to reselect from the last harvest without running the tests again.

A rerun writes the same fixtures, from any checkout:

- `harvest-setup.ts` derives every `randomUUID`, `randomBytes`, `getRandomValues`,
  `Math.random` and `mkdtemp` suffix from the running test, the line that asked (its path
  relative to the checkout), and how many times that line asked in the test. It reads the
  running test from vitest's own `expect`, because the app's vitest config has no globals. A
  draw in one test then never shifts the ids drawn in a later one.
- `harvest-setup.ts` makes every `Date.now()` read later than the previous one. The app compares
  times it took in order, such as a broker offer and the call that acknowledges it
  (`offeredAt < callStartedAt`). When both reads fell in one millisecond, `test/agents.test.ts`
  recorded one event fewer in its shared prime session, and every later `seq` there moved.
- Ledgers are recorded when the app queues a generation, not when `durable.ts` writes it. A
  background write lands on a 300 ms timer that keeps only the newest generation, so the file
  writes a run sees depend on how fast its tests ran. Recording at the file once made
  `state/swarm.07.json` catch a worker's `revivable` flag before it flipped in one run and
  after it in the next.
- `select-fixtures.mjs` sets every clock value to 2026-01-01T00:00:00.000Z: epoch milliseconds and
  seconds, ISO times, the day in session and handoff ids, and the time in Goal tokens. It sorts
  maps from ids to times by key, collapses repeated keep-alive frames, and replaces `durationMs`,
  `pid`, OS-assigned ports and `token` values with fixed ones.
- Shapes are ordered by a hash of the shape, not of the content.
- The swarm ledger is recorded at each broker mutation (`onSwarmChange`), the snapshot
  `main/index.ts` queues on its debounced lane. The critical lane (`persistCriticalSwarmNow`)
  snapshots whatever the broker holds when the previous disk write returns, so the
  generations it writes depend on disk timing.

Three back-to-back regenerations on 2026-10-21 wrote byte-identical fixtures.

## Conventions

- A TypeScript `field?: T` becomes `Option<T>`, which is not written when it is `None`.
- A TypeScript `field: T | null` becomes `Option<T>`, which is always written, including `null`.
- A TypeScript `field?: T | null` becomes `Option<Option<T>>`, read with `json::nullable`. Absent,
  `null`, and a value stay three different states.
- Each persisted record ends in a flattened `extra` map. Keys that this build does not know survive a
  read and a write, so a Rust save never drops what a newer or older TypeScript build wrote. Wire
  replies that the app produces are closed shapes and have no `extra` map.
- Discriminated unions are serde-tagged enums on the TypeScript tag field (`kind`, `type`,
  `state`, or `action`).
- Numbers are integers where the producer writes integers (`Date.now()`, counters, sequence
  numbers). `json::JsNumber` is used where the producer can write a fraction, and it serializes
  the way `JSON.stringify` does.
- Identifiers that TypeScript validates are newtypes that validate on deserialization:
  `SessionId`, `ConversationId`, `TunnelId`, `ChatgptProjectId`, and `ConnectorAppId`.
- These types describe what the app writes. Repairing an older or hand-edited file is the job of
  the unit that owns that file. Examples are filling missing config sections, migrating
  `powershell`/`deleteFolder`, and skipping one bad ledger row.

## Coverage

### Ported

| TypeScript type (source) | Rust type | Fixtures |
|---|---|---|
| `Config` and every section: `Root`, `Capabilities`, `TunnelSettings`, `setupProfiles[]`, `UiPrefs`, `AppearanceSettings`, `SessionSettings`, `CompactionSettings`, `MultiAgentSettings`, `CommandAllowlistSettings`, `GoalSettings`, `GoalProviderSettings`, `McpSettings`, `ControlApiSettings` (`shared/types.ts`, `shared/appearance.ts`, `shared/command-allowlist.ts`) | `config::*` | `config.*` (byte-equal), `app-state.*` |
| `Capability`, `ChatBrowser`, `UiLanguage`, `BrowserBridgePort`, `BrowserPreferences`, `GoalMode`, `GoalBackend`, `GoalProviderKind`, `GoalReasoning`, `HandoffLength`, `TunnelKind` | `config::*` enums | `config.*` |
| `AppState`, `ConnectionStatus`, `ConnectionState`, `TunnelHealth`, `SurfaceId`, `SurfaceStatus`, `SurfaceConnectionState`, `PlatformInfo`, `SecureStorageInfo`, `BridgeStatus`, `UpdateStatus`, `MacOSDesktopAccessStatus` (`shared/types.ts`) | `app_state::*` | `app-state.*` (from the real `state:get` handler) |
| `LogEntry`, `Check`, `Diagnosis` (`shared/types.ts`) | `app_state::*` | none yet (IPC only) |
| `SessionEvent`, all 13 kinds, and `EventSource`, `StoredText`, `AssetRef`, `ActivitySummary`, `FileChange`, `ToolOutcome` (with legacy `error`/`rejected`), `CallAttribution`, `ToolCallRecord`, `MessageState`, `MessageReference`, `InputAttachment` (`shared/session.ts`, `shared/input.ts`) | `session::SessionEvent` and parts | `session/events/*`, `session/message/*`, `session/legacy-messages.*` |
| `SessionSummary` and `PersistedSummary` (`meta.json`, including `__historySeq`, `__canonicalProjection`, `__tokenEstimate`), `TimelineTurns`, `RequestTurns`, `SessionOrigin`, `WorkerAssignmentSummary` (`shared/session.ts`, `shared/chronology.ts`, `main/session/store.ts`) | `session::SessionMeta`, `SessionSummary` | `session/meta.*` |
| `Handoff`, `HandoffProvenance` | `session::Handoff` | `session/handoff.*` |
| `AgentPlan`, `AgentPlanUpdate` (`shared/agent-plan.ts`, strict) | `session::AgentPlan`, `AgentPlanUpdate` | `session/plan.*` (byte-equal), `state/request-plans.*` |
| `TurnTrace`, `TurnTraceItem` (`shared/turn-trace.ts`) | `session::TurnTrace` | `session/trace.*` (byte-equal) |
| `AgentInfo`, `AgentMessage`, `AgentRole`, `AgentState`, `ReasoningEffort` | `session::*` | `state/swarm.*` |
| `SwarmState` | `session::SwarmState` | none yet (IPC only) |
| `state/blocked-chats.json`, `state/trusted-chats.json` | `state::BlockedChats`, `TrustedChats` | byte-equal |
| `state/request-correlations.json` (versions 3 to 6) and `state/request-plans.json` | `state::RequestCorrelations`, `RequestPlans` | yes |
| `state/continuations.json` (`ContinuationSnapshot`, `ContinuationRecord`, checkpoints) | `state::Continuations` | yes |
| `state/goal-replies.json`, `goal-objectives.json`, `goal-switches.json` | `state::GoalReplies`, `GoalObjectives`, `GoalSwitches` | yes (the last two are byte-equal) |
| `state/session-input.json` (`InputEntry`, from `entrySchema`) | `state::SessionInput` | yes |
| `state/bridge-commands.json` (`DurableCommandSnapshot`, `CommandSpec`, `CommandReceipt`) | `state::BridgeCommands` | byte-equal |
| `state/swarm.json` (`SwarmSnapshot`, versions 4 to 7) and `state/retired-workers.json` | `state::SwarmSnapshot`, `RetiredWorkers` | yes |
| `state/chat-models.json` (`ChatModelOption`) | `state::ChatModels` | byte-equal |
| `state/plugin-refresh.json` (`rowSchema` plus the publication fields written beside it) | `state::PluginRefreshRows` | yes |
| `state/plugins.json` (`RecordEntry`, `PluginSource`, `PluginField`, `InstalledLaunch`) | `state::Plugins` | yes |
| `state/projects.json` (`LocalProject`, `ChatgptProjectLink`) | `state::Projects` | yes (not byte-equal: removing a project from its group appends `ungrouped` after `chatgpt`) |
| `state/usage-cache.json` (version 9) | `state::UsageCache` | byte-equal |
| `state/main-texts.json`, `window-bounds.json`, `connector-identity.json`, `pet-library.json` | `state::MainTexts`, `WindowPlacement`, `ConnectorIdentity`, `PetLibrary` | byte-equal |
| `ControlApiEndpoint` (`control-api/endpoint.json`) | `control_api::ControlApiEndpoint` | `control-api/endpoint.*` |
| `ControlApiHealth`, `ControlApiStatus`, `ControlApiSessionList`, `ControlApiSessionDetail` (with `ControlApiLive`, `ControlApiJob`, `ControlApiRecovery`), `ControlApiEvents`/`ControlApiEvent`, `ControlApiInputs`/`ControlApiInput`, `ControlApiAgents`, `ControlApiLog`, `ControlApiSendResult`, `ControlApiCancelResult`, the `sendBody` request, and the error envelope | `control_api::*` | `http/control-api/*` |
| Bridge `/hello`, `/pair` (request and reply), `/browser/presence`, `/commands/redeem` (request and `BridgeCommand` reply), `GET /settings`, the `{ ok: true }` reply, and the error envelope (`main/bridge.ts`) | `bridge::*` | `http/bridge/*` |
| `BrowserCommand`, `BrowserResult`, and `/browser-control` requests and replies (`shared/browser-control.ts`, `main/browser-control.ts`) | `mcp::*` | `http/bridge/POST_browser-control.*` |
| The `GET /v1/sessions/{id}/events/stream` frames: open, keep-alive, event, and end (`main/control-stream.ts`) | `control_api::EventStreamFrame` | `sse/control-api/*` (byte-equal) |
| Wake socket frames on `/wake`: `wake`, `browser-control`, `ping`, the token, and `pong`, plus `WakeHost` and the socket limits (`main/browser-wake.ts`) | `bridge::WakeSignal`, `ExtensionWakeFrame`, `WakeHost` | `ws/wake.*` (from `fixture-gen/wake.gen.ts`; the token frame is not recorded) |
| Bridge `POST /closed`, `/conversation-deleted`, `/core-plugin`, `/repairs/claim`, `/activity/detail`, `/commands/ack`, `/commands/step`, `/commands/revivals/pending`, `/input/claim`, `/input/bind`, `/input/ack`, `/project-create`, `GET` and `POST /cos-browser/sign-in` (with `SignInCookie`, `cookieSchema`), `/goal/ack`, `/goal/objective`, `/goal/open`, and `POST /settings`: requests and replies (`main/bridge.ts`, `main/projects.ts`, `main/cos-browser/sign-in-transfer.ts`) | `bridge::*` | `http/bridge/*` |
| Bridge `POST /input/answer`, `/input/fail`, `/input/progress`, and `/input/attachment`: requests and replies. The extension sends one body (`InputRequest`) to `/input/claim`, `/progress`, `/answer`, `/fail` and `/ack` | `bridge::*` | `http/bridge/POST_input_*` (`input-delivery-integration` and `fixture-gen/bridge-routes.gen.ts`) |
| Bridge `GET /activity` (`ActivityReply`: the stream rows, legacy entries, Goal view, `GoalDraftView`, `ResumeJobView`, placement, progress) | `bridge::*` | `http/bridge/GET_activity.*` |
| Bridge `GET` and `POST /status`: the report (`StatusReport`), the repair receipt in its query (`StatusQuery`), and the reply (`StatusReply`, with `TabPolicy`, `RepairHandout`, `PendingBrowserInput` and the other handouts) | `bridge::*` | `http/bridge/*_status.*` |
| Bridge `POST /compact` (`CompactRequest` and `CompactStep`, the order `bridge.ts` reads its flags in, and `CompactReply`) and `POST /goal/draft` | `bridge::*` | `http/bridge/POST_compact.*`, `POST_goal_draft.*` |
| Bridge `POST /events` (`EventsReport`, `PageObservation`, `PageCallEvidence`), `/correlations`, and `/diagnostics` (`CompanionDiagnostics::sanitise`, the port of `sanitiseCompanionDiagnostics`) | `bridge::*` | `http/bridge/POST_events.*`, `POST_correlations.*`, `POST_diagnostics.*` |
| Bridge `POST /models`, `/plugin-refresh`, `/browser/preferences`, `/extension/update`, `/image-export`, and `/usage`: requests and replies | `bridge::*` | `http/bridge/POST_*` (`input-delivery-integration` and `fixture-gen/bridge-routes.gen.ts`) |
| `BROWSER_TOOLS`, `WINDOWS_COMPUTER_METHODS`, surface server names, `BROWSER_BRIDGE_PORTS`, `BRIDGE_PROTOCOL`, `CONTROL_API_ROUTES` | constants and enums in `mcp`, `bridge`, and `control_api` | used by the types above |

### Kept as `serde_json::Value`

TypeScript types these values loosely, so this crate does not invent structure for them:

- `PluginToolSchema.inputSchema`, `outputSchema`, and `annotations`. These are JSON Schema documents
  and MCP annotations (`shared/plugin-refresh.ts`, and `catalog` in `state/plugins.json`).
- `InstalledLaunch.manifest`. This is an MCP bundle's own `manifest.json`, `unknown` in TypeScript.
- `BrowserCommand.args`. This is `Record<string, unknown>`, one browser tool's arguments.
- `BrowserResult.value`. This is `unknown`, one browser tool's result.
- `PageTraceItem::Unreadable`, one `turn_trace` outline item a page sent that `turnTrace` cannot
  read (an unknown kind, or a call with no id). The recorder drops it, so no field of it is used;
  keeping it as JSON lets the rest of the batch parse.
- The `/diagnostics` body. Its contract is any JSON, with each field read only when it is well
  typed, so `CompanionDiagnostics::sanitise` takes a `serde_json::Value`.
- The flattened `extra` maps on persisted records. These are present by design, as described above.

### Request bodies the bridge rebuilds

`bridge.ts` rebuilds most request bodies field by field: it caps text, checks ids against
patterns and replaces impossible clocks with now (`parseObservations`, `parseCallEvidence`,
`turnTrace`). The request types here are the shapes the extension sends, with every
TypeScript-validated id as its newtype (`ConversationId`). Those caps and clock rules are policy
of the route's owner (units E2.2 to E2.4), not shape, and stay with that owner. The exception is
`/diagnostics`, ported whole as `CompanionDiagnostics::sanitise`.

### Deliberately not ported

- Pure logic in `src/shared`, which belongs to the unit that owns it. Examples are command
  allowlist parsing and evaluation, appearance palette math, chronology and timeline folding,
  `messageReferences`, `turnTrace`, title and prompt builders, goal templates and prompt history,
  recommended skills, skill routing, markdown export, usage arithmetic, and pet activity.
- IPC-only shapes, because the GPUI app calls the core directly and the IPC boundary goes away
  (rewrite map, unit J). Examples are `ClearAgentResult`, `WorkerWorktreeCleanupOffer`/`Result`,
  `SessionChange`, `SessionSearch*`, `ImageStorage*`, `TokenPressure`, `CompanionDiagnostics`,
  `ChatModelCatalog`, `RunningToolActivity`, `ToolEditReview`, the `PluginView`/`PluginSnapshot`
  catalog views, `SkillLibrary` and the other skill views, and `ProjectFile*`/`ProjectGit*`. Each
  view's unit ports the view it renders.
- `secrets.bin`. Its contents are an Electron `safeStorage` ciphertext, which the `cos-secrets`
  crate reads and writes.
- `connector-proof.json`, `browser-proof.json`, and `keychain-build.json`. No harvested test writes
  them. They belong to units C1 and A1.
- Raw binary or text stores: `sessions/<id>/assets/*`, `input-attachments/*`, `app.log`, and
  `control-api/token`.
- Chromium-owned `Local Storage` keys. A Rust app cannot read them without a LevelDB reader
  (rewrite map, section 2.5).
