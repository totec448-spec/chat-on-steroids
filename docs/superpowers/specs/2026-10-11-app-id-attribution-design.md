# Recognize this app's ChatGPT connectors by app ID, not by name

Status: design, approved in chat 2026-10-11; for review before implementation.
Roadmap: #482, "Attribute tool calls by app ID rather than connector name".

## Goal

A user may rename a Chat On Steroids connector in ChatGPT, for example "Chat On Steroids Core" to "My
tools". Today every name-based check then treats the renamed connector as a stranger's. Calls render
as foreign, tool counts drop, and Goal and Loop lose the evidence they wait for. Instructions sent to
the model also name a connector that no longer exists by that name. After this change, the app
recognizes its connectors by ChatGPT's stable app ID. A rename, or a new copy of a connector, keeps
working without any setting.

Success: on a connector renamed in ChatGPT, a call, its rendering, the turn's tool count, a full Goal
run and Compact & Resume behave exactly as with the default name. Nothing that belongs to another
connector, another computer or another app is ever counted as this app's.

## Measured facts (VM 141, Chrome 154, 2026-10-11)

- The MCP request ChatGPT sends carries no app or connector ID. `_meta` holds locale, user agent,
  location and masked subject, session and organization IDs; headers hold tracing IDs and
  `x-request-id`.
- ChatGPT's stored conversation does carry IDs:
  - The request row (`recipient: api_tool.call_tool`) has `content.text` with path
    `/<app name>/link_<linkId>/<tool>` and `metadata.request_id`.
  - The result row (`author.name: api_tool.call_tool`) has
    `metadata.invoked_resource = { resource_uri: "/asdk_app_<appId>/link_<linkId>/<tool>", app_name }`
    and the same `request_id`.
- After renaming the VM's Core connector in ChatGPT and making a call:
  - `asdk_app_6ac261da…` and `link_6ac26253…` were unchanged;
  - the path name and `app_name` carried the new name;
  - the name was restored afterwards.
- The request ID in the conversation equals the `x-request-id` our server received (without the
  `/<suffix>`).
- The request→conversation join already worked after the rename. The name dependency is in
  ownership checks only.

## Design

### 1. Learning, from proof only

**Served requests (main).** The MCP kernel already knows which surface (core, desktop, plugins)
served each request ID. A small in-memory registry records `requestId → surface` for calls that
reached a handler:
- bounded to the last 4096 entries;
- entries expire after 24 h;
- nothing is persisted, so history from before a restart is never trusted.

**Sightings (extension → main).** When the page reads a turn, it reports one sighting per result row
of *any* connector: `{ requestId, appId, linkId, appName }`.
- The fields are parsed only from `invoked_resource.resource_uri` and `app_name`.
- The sightings ride on the existing page-evidence message that already carries request IDs (the
  recorder's correlation intake). No new channel is added.
- A sighting is local data about the user's own page; it never leaves the computer.

**Proof rule (main).** A sighting teaches an identity only if its `requestId` is in the served
registry. The registry's surface then says which connector the app ID belongs to:
- `appId` is stored as that surface's ID;
- `linkId` is stored as that surface's link;
- `appName` is stored as that surface's current name, with the time.

A request this app did not serve teaches nothing. That covers another computer's connector, another
person's app, and anything before a restart.

**Storage.** The learned identity lives in the durable store (not `config.json`):

    connectorIdentity: { core|desktop|plugins: { apps: [{ appId, linkId, name, seenAt }] } }

- Each surface keeps at most 4 apps, most recent first. An older app ID is dropped when a fifth
  appears.
- A user who deletes and recreates a connector gets the new app, learned on its first call. The old
  one ages out.

**Publication.** `/status` already sends `connectorNames` to the extension. It now also sends
`connectorApps: { core: [{ appId, linkId, name }], desktop: [...], plugins: [...] }`. The extension
caches them like `connectorNames`: `chrome.storage.local`, restored on worker start.

### 2. Recognition

One ownership function per layer replaces the name comparisons. In order:

1. **App ID.** `resource_uri`'s `asdk_app_<id>` is in `connectorApps`, which means ours. An app ID
   that is *not* learned falls through to the next checks, so bootstrap and old chats still work.
2. **Link ID.** A request row's path segment `link_<id>` is a learned link, which means ours. This is
   needed while a call runs, before its result row exists.
3. **Name.** The exact configured names (`connectorNames`), the learned current names, and the
   legacy names. This is the bootstrap until the first proven call, and it covers shapes that carry
   only a name (`mcp-tool-call` steps' `invocation.server`; spaces may appear as `_`, as today).

Call sites to switch, all through these helpers:
- `fiber.js`: `ourApp`, `ourPath`, `serverName` and the `mcp-tool-call` step checks (around lines
  1351–1724, 1859, 2033, 2107). `resultOf` and `requestOf` additionally return `appId` and `linkId`.
- `content.js`: `ourConnectorApp`, `ourConnectorSeen` (around line 6271) and the Core-missing check
  (around lines 965–979), which compares by app ID when known.
- `chatgpt-dom.js`: the plugin-refresh view and the @-mention picker. They find the row by app ID
  when known (the plugin page route and mention links both contain `asdk_app_<id>`), otherwise by
  name as today.

Exactness stays as today: IDs and names are compared whole, never by prefix.

### 3. Renames end to end

- **Model-facing text.** Every place the app names a connector to the model (`connectorName(...)` in
  `agents.ts`, `tools-core.ts`, `surfaces.ts`, protocol and instruction text) uses the learned current
  name for that surface when one exists, otherwise the configured name. The model then looks for the
  app under the name ChatGPT shows it.
- **Plugin refresh and mentions** use the learned app ID first (above).
- **Settings UI.** The connector card shows the learned name when it differs from the configured one:
  "In ChatGPT: <name>". It's informational only.

### 4. Cases

| Case | Behavior |
| --- | --- |
| Default names, never renamed | Same as today. The app ID is learned on the first call and changes nothing visible. |
| Renamed before the update, no call yet | Name checks miss until the first call. That call still reaches the app (routing never depended on names), is proven by its request ID, and from then on everything matches by ID. |
| Renamed after the app ID was learned | Matched by ID at once. The new name is learned from that call's result row and used in model-facing text. |
| A second, extra copy of one connector (same tunnel) | Its rows are foreign until its first call, which reaches this app and is proven like any other; that turn re-reads as ours once the ID is learned. |
| Older chats after a rename | A chat keeps the app name it began with (measured). The learned name only changes to a name seen in a chat created no earlier, by ChatGPT's conversation id (its first 8 hex digits are the creation second), so an old chat never reverts it. |
| First call in a brand-new chat | In ChatGPT's shell layout the result row can sit outside the turn's message ids; sightings also match the turn's own request ids anywhere in the native mapping (bounded). |
| Connector deleted and recreated | New app ID, learned on its first call. The old one ages out after 4 newer apps. |
| Two computers, one ChatGPT account | Each computer learns only from requests it served. The other computer's connectors are never learned, so its calls are never claimed. |
| Another person's or app's connector named like ours | Its request IDs never reach this app, so its ID is never learned. A name collision can still match by name before the first proven call, as today. Once this surface has a learned ID, a name match for an app ID that differs from every learned one is *not* ours. |
| Old chats from before the update | Rows with an unlearned app ID fall back to name matching, as today. |
| Code mode (`functions.exec`, `dynamic-tool-call`) | Unchanged; it isn't name-based. |
| App restarts | The served registry starts empty. Learned identities persist; new proofs need new calls. |
| Extension older than the app | It ignores `connectorApps` and keeps matching by name. |
| Malformed or missing `resource_uri` | No sighting. Recognition falls back to name. |

The "differs from every learned one" rule closes a hole the name fallback would otherwise leave: a
same-named foreign app is no longer ours once we know our real ID.

### 5. Tests

**Unit (vitest, fail-first on main):**
- fiber: request, result and step parsing return `appId`/`linkId`; ownership matches a renamed
  connector by ID and by link; rejects a same-named row whose app ID differs from the learned one;
  falls back to names when nothing is learned.
- content: `ourConnectorSeen` with renamed rows; the Core-missing check by ID.
- main:
  - a sighting with a served request ID stores the identity for the right surface;
  - an unserved one stores nothing;
  - the cap and ordering per surface;
  - expiry of served entries;
  - `/status` publishes `connectorApps`;
  - model-facing text uses the learned name.
- extension: `connectorApps` caching and restore on worker start; picker and plugin-refresh lookup
  by app ID.

**Live (VM 141, dev build, then the canary):**
- rename the VM's Core connector, then make a call (rendered as ours, attributed, counted), run a
  Goal end to end, and run Compact & Resume;
- rename Desktop, then make one call;
- restore both names exactly;
- default-name regression: a call and a Goal on the Mac canary;
- a test chat that calls the stale "CoS Win Core" app must stay foreign.

## Out of scope

- Learning before the first call (for example from the settings page by tunnel ID). The user chose
  the proof-only path as the most reliable one.
- Changing which connector ChatGPT routes to (unchanged; the tunnel ID decides).
