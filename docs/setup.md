# Setup and reference

[Back to the overview](../README.md)

## Before connecting

Read the [responsible-use notice and provider rules](../README.md#responsible-use-and-provider-rules). CoS is an independent beta, used at your own risk. Its companion observes and automates the ChatGPT browser UI and records conversation content locally; this is not a public ChatGPT automation API. MCP/tunnel access does not establish permission for every automated workflow. Your account's terms, usage limits, safety decisions and workspace rules still apply.

## Quick start

1. **Install and open CoS.** Choose the download for your operating system and CPU.
2. **Choose what ChatGPT may access.** In **Settings → Workspace**, approve a project folder and review the tool permissions.
3. **Connect the local tools.** Configure a tunnel in **Settings → Setup**, press **Connect**, then add the **Core** app in ChatGPT under **Plugins → Add → Create MCP App**.
4. **Load the companion extension.** Press **Open extension folder**. In `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select that folder. Pairing is automatic.
5. **Start a task.** Choose a project and model in CoS, write your request and send it.

Want screen and keyboard control? Enable **Desktop** permissions and connect its separate app. On macOS, also grant Screen Recording and Accessibility in System Settings.

**After an update:** reload the companion extension and refresh the CoS apps in ChatGPT when prompted. These are two separate steps.

## Tunnel setup

### OpenAI Secure MCP Tunnel

1. Create a tunnel in [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels), in the same workspace you use in ChatGPT.
2. Create a **Restricted** [API key](https://platform.openai.com/settings/organization/api-keys) with **Tunnels: Read** and **Tunnels: Use**.
3. Enter the tunnel ID and key in CoS and press **Connect**.
4. In ChatGPT, open [Plugins](https://chatgpt.com/plugins), click **Add** at the top right and choose **Create MCP App**. Pick **Tunnel** as the connection, select your tunnel and choose **No authentication**. Older ChatGPT versions instead need Developer mode turned on first (**Settings → Security and login**) and show a **+** button. Review and enable the app's actions.
5. Name each app exactly as CoS shows it (for example `Chat On Steroids Core`). CoS recognizes its tool calls by that name; a renamed app still works, but its calls are filed under Unattributed activity instead of your chat, which also keeps Goal and Loop from seeing them.

> **No Developer mode switch?** That's expected. Current ChatGPT accounts, including new Plus accounts, create the app from **Plugins → Add → Create MCP App** without it, and file edits and desktop control work as before ([#522](https://github.com/totec448-spec/chat-on-steroids/issues/522)).

Core, Desktop and Plugins are separate connectors. Configure each surface you enable. Release packages include the pinned, checksum-verified `tunnel-client`.

### Other tunnels

**Cloudflare quick tunnel:** connect in CoS and use the displayed public URL as the MCP server URL in ChatGPT. The random path is a secret and changes on restart.

**Your own HTTPS tunnel:** forward to the loopback URL shown by CoS and preserve its secret path. Treat the resulting URL like a password.

## Browser bridge port

In **Settings → Browser & history → Browser bridge port**, choose **Auto** (default) or
**8765**, **8766**, **8767**, **8768**, **8769**. Auto uses the first available port in that
order. A fixed choice uses exactly that port. The companion discovers the same supported range.

If the selected port is occupied, the save is rejected and the previous choice and working
bridge remain active. If a saved port is occupied when CoS starts, the app stays open with the
bridge stopped and an error in **Setup**. Choose a free port or Auto in Settings to recover.
The saved fixed choice never silently falls back to another port. Pairing survives a successful switch.

An effective `CLF_BRIDGE_PORTS` environment override takes precedence over the saved choice.
The dropdown is disabled and explains the override; unrelated Settings changes remain available.
Remove the override from the launch environment and restart CoS to use this selector. The existing
comma-separated override and port `0` remain available for isolated development/tests.

## Local control API

**Settings → Setup → Advanced → Local control API** (off by default) lets an agent running on
this computer check on CoS, and read its chats, from outside the app. It is meant for an agent's
MCP server that watches for a hung app. **Turning it on lets any process that can read your user
data folder read your chat history**, including messages, tool arguments and results, and queued
messages. Known credential shapes are masked and long text is cut, but nothing else is filtered.
When it is on, CoS writes two files to `control-api/` in its user data folder:

- `endpoint.json`: port, process id and version;
- `token`: a new random bearer token each time the app starts.

It then serves these routes on `127.0.0.1` only:

- `GET /v1/health`: process id, version, uptime, and the routes this build serves;
- `GET /v1/status`: connection, bridge, plugins, updater and in-flight tool calls;
- `GET /v1/sessions` (up to 50 per page, `cursor`) and `GET /v1/sessions/{id}` (`live=1` adds what the app is doing or waiting for in that chat: the running turn, the deadlines it is holding and the compaction it is in or has just finished): recorded chats;
- `GET /v1/sessions/{id}/events` (up to 100 per page, `kinds`, `before`/`after` by each event's `position`, or `from` by `seq` to follow a chat live): messages, tool calls and turns, with message text cut at 4,000 characters and tool text at 2,000;
- `GET /v1/inputs` (`state`, `limit`): the message outbox;
- `GET /v1/agents`: the multi-agent run;
- `GET /v1/log` (`limit`, `level`, `since`, inclusive): the in-memory Activity log.

With a second switch, **Allow actions: let local agents send and cancel messages** (off by default,
off whenever the API is off, and left off when you turn the API back on), it also serves:

- `POST /v1/inputs` with `{ "id": "<new lowercase UUID>", "sessionId": "...", "text": "..." }` (up to 64,000 characters) sends a message to an existing chat through the same outbox as the composer. Like the composer it connects CoS and opens the chat in your browser. It answers 202 once the message is stored; whether ChatGPT received it is read later from `GET /v1/inputs` (`delivery`: `sent`, `not_sent`, `unconfirmed` or `pending`). Repeating an id returns the same message and does not send it again, but the outbox keeps only the last 50 finished messages (fewer when they are very large), so use a new UUID for each message. After a timeout, read `GET /v1/inputs` before sending again. A chat takes one message at a time, and if ChatGPT is writing an answer that the send would stop, the request is refused unless it also says `"interrupt": true`. Worker and helper chats cannot be sent to;
- `POST /v1/inputs/{id}/cancel` withdraws a message that has not been handed to ChatGPT. It refuses a message that was delivered, one whose Send was already authorized (it may be in ChatGPT), the first message of a new chat, a message paired with another, and a message of a worker or helper chat.

**Anyone who can read your user data folder and has this switch on can write into your chats, and
a model that reads those messages can act under the permissions you have granted.**
With the switch off, these routes all answer 403 and nothing changes.

Requests need `Authorization: Bearer <token>`. Any request with a browser `Origin` is refused.
A read that waits on something the app cannot answer within 15 seconds gets `504 timeout`, and `/v1/health` keeps answering (within the same rate limit), so a caller can tell an app that is waiting from one that is not running. An app frozen outright answers nothing.
Turning the switch off, or quitting, stops the listener and removes both files. A crash can leave
them behind, so a caller should treat a refused connection as "not running".

## Permissions and connectors

| Connector | What it adds |
| --- | --- |
| **Core** | Local files, patches, terminals, generated-file downloads, session history, plans and workers. Available on all supported platforms. |
| **Desktop** | Screen inspection, mouse, keyboard and clipboard. Windows and macOS; macOS requires explicit enablement and OS permissions. |
| **Plugins** | External MCP tools such as Blender, Playwright and Memory, plus custom local or remote servers. [Plugin guide](plugins.md). |

You choose the approved folders and capabilities. File tools enforce those roots; shell commands run with your normal user privileges. Desktop access applies to the desktop, and external plugins have their own permissions. **Read-only mode** disables writes, command execution and desktop control.

History is stored locally, with recording on and 30-day retention by default. Credentials use the operating system's secure storage. Review permissions before connecting: fresh installs enable Core capabilities and two workers; Windows also starts with Desktop permissions enabled.

[Security policy](../SECURITY.md) · [Tool reference](tool-surface.md) · [Architecture](../AGENTS.md)

## Sessions, workers and Astra

**Session history** belongs to the local session, not a particular ChatGPT tab. The companion records messages and the actual local tool results so the app and the model can read earlier work.

**Compact & Resume** asks for a handoff, starts a fresh provider conversation and rebinds that same session. Task and worker history move with it. In Settings → Continuation prompts, **Handoff prompt** controls what the brief emphasizes; the continuation marker and recovery/provenance framing remain fixed. The shipped prompt prefers a dense roughly 2,000-6,000-token brief for substantial work instead of replaying completed chronology. Automatic compaction uses configured local estimates and eligible live work; Pro models never auto-compact.

**Workers** keep their conversation when they finish. Send a follow-up to reuse one. The default is two simultaneous workers per family, configurable up to eight. Idle owned tabs can be reused or closed after fresh checks; the durable worker history remains. Drafts, active work and pins are protected.

**Goal** can decide the task is complete and send nothing. **Loop** continues within the brief until disabled. Both support ChatGPT helpers or an optional API backend.

**Astra's finish boundary** can receive queued instructions, plan checkpoints and automatic follow-ups through tools within the same working turn when Session finish is enabled. You can end the turn from the composer. This does not remove provider usage or context limits.

These continuity features do not grant additional quota or access. Do not use new chats, workers, Goal/Loop or compaction to evade a provider restriction. Supervise automated work and stop a restricted workflow instead of asking another chat or tool to continue it.

## Troubleshooting

- **Missing or stale tools:** refresh the relevant CoS app in ChatGPT. Reloading the Chrome extension is a separate action.
- **Provider usage limit or policy warning:** stop the affected workflow and disable its Goal/Loop automation. Follow the provider's stated reset or support/appeal process. Do not switch accounts, chats, models, connectors or tunnels to evade the restriction. A local retry or reconnection is not evidence that a policy restriction has been lifted. Keep account notices and appeal details private; a GitHub issue cannot resolve an account enforcement decision.
- **Tunnel rejects the API key or tunnel ID:** check the saved tunnel ID, the selected setup profile, and that its key has Tunnels Read + Use for that tunnel. Extension pairing does not authenticate the tunnel. If Platform offers no matching ChatGPT workspace, retain the exact error for an access investigation; a different tunnel does not establish account eligibility.
- **ChatGPT blocks a tool for safety:** local permission alone does not prove that ChatGPT accepted or dispatched the call. Inspect the local tool history for the exact request. If no result exists, execution is unconfirmed; do not replay a potentially executed operation or route it through another connector. Keep the task's progress and report the provider's error, selected Chat/Work surface, and app/extension versions without credentials or private content. A plan label alone does not diagnose a provider refusal.
- **CoS returns `TOOL_DISABLED`:** check Read-only and the named local capability. `CALLER_IDENTITY_REQUIRED` or `WORKER_IDENTITY_LOST` instead concerns exact caller ownership; neither proves that command execution is globally disabled.
- **Extension version mismatch:** reload the unpacked companion after updating CoS, then reload the ChatGPT page.
- **Models missing:** use **Reload ChatGPT models**. The picker reflects availability in your signed-in account.
- **`UNIDENTIFIED_CALLER`:** use that conversation in the paired browser so the extension can prove its request identity. CoS does not guess from the active tab.
- **`COMPACTION_IN_PROGRESS`:** let the source chat finish its handoff. Work continues in the replacement conversation.
- **Linux credential storage unavailable:** unlock GNOME Keyring or KWallet, then restart CoS.
- **A chat will not stop:** **Block** revokes local tools for that exact conversation. It does not claim to cancel the provider's generation.

## Build from source and contribute

## Development

```sh
npm ci
npm run dev
npm run verify
```

Read [AGENTS.md](../AGENTS.md) before changing the app and [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a PR.

## Building

```sh
npm run dist:x64          # Windows x64
npm run dist:arm64        # Windows ARM64
npm run dist:mac:x64      # macOS Intel
npm run dist:mac:arm64    # macOS Apple silicon
npm run dist:linux:x64    # Linux x64
npm run dist:linux:arm64  # Linux ARM64
```

Build on the target OS. The release workflow uses native runners for all six targets, checks the packaged runtimes and assembles the complete artifact set with checksums and corresponding native library sources.

---

[MIT licensed](../LICENSE). Not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.
