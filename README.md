<div align="center">
  <img src="extension/icons/icon128.png" width="88" alt="Chat On Steroids icon" />
  <h1>Chat On Steroids</h1>
  <p><strong>ChatGPT, with hands on your computer.</strong></p>
  <p>A local MCP server that gives ChatGPT the same tool shapes Codex uses: read, search, patch, run commands, drive a terminal. Plus worker chats, a session history that survives the context window, and a loop that keeps typing "keep going" so you don't have to.</p>
  <p>
    <a href="../../releases/latest"><strong>Download the latest release</strong></a>
    · <a href="#quick-start">Quick start</a>
    · <a href="#what-chatgpt-gets">Tools</a>
    · <a href="#security-in-one-page">Security</a>
    · <a href="CHANGELOG.md">Changelog</a>
  </p>
</div>

<p align="center">
  <img src="docs/images/app-home.jpg" width="68%" alt="Chat On Steroids home screen with permissions, folders and setup steps" />
  <img src="docs/images/extension-popup.jpg" width="23%" alt="The companion Chrome extension popup" />
</p>
<p align="center">
  <img src="docs/images/app-chat.jpg" width="92%" alt="A recorded session timeline with real tool calls" />
</p>

## Why this exists

ChatGPT is a good engineer trapped in a text box. Developer mode lets it call MCP servers, but most servers give it one narrow API. This one gives it a workbench.

- **Codex-grade tools.** `apply_patch`, `exec_command` and `write_stdin` are ports of the tool contracts OpenAI's Codex CLI uses, so the model already knows how to hold them. Multi-file patches are preflighted before anything is written. Commands run as real processes with interactive stdin, output budgets and background results it can collect later.
- **Sub agents inside ChatGPT.** One prime chat can spawn worker chats, hand them tasks, read their reports and wake them again later. Workers are ordinary ChatGPT conversations in your own browser, brokered by the app, so you can watch every one of them.
- **Sessions that outlive the context window.** Every tool call is recorded locally with its real result. When a chat gets heavy, Compact & Resume asks it for a handoff brief, opens a fresh chat and moves the same local session across. The new chat can query everything the old one did.
- **Goal and Loop.** A second model reads each finished answer and writes the next user message, either until a stated goal is met or until you switch it off. Long unattended runs stop needing a human to type "continue".
- **You stay the permission boundary.** Only the folders you approve are visible. Each capability is a switch. Read-only mode is a single kill switch. Nothing runs on this machine that you did not turn on.

It runs in the tray, hosts no model of its own, and works with the ChatGPT you already use in the browser.

## Download

| Platform | x64 | ARM64 |
| --- | --- | --- |
| **Windows** | [Installer](../../releases/latest/download/Chat-On-Steroids-Setup-x64.exe) | [Installer](../../releases/latest/download/Chat-On-Steroids-Setup-arm64.exe) |
| **macOS** | [DMG](../../releases/latest/download/Chat-On-Steroids-macOS-x64.dmg) · [ZIP](../../releases/latest/download/Chat-On-Steroids-macOS-x64.zip) | [DMG](../../releases/latest/download/Chat-On-Steroids-macOS-arm64.dmg) · [ZIP](../../releases/latest/download/Chat-On-Steroids-macOS-arm64.zip) |
| **Linux** | [AppImage](../../releases/latest/download/Chat-On-Steroids-Linux-x64.AppImage) · [DEB](../../releases/latest/download/Chat-On-Steroids-Linux-x64.deb) | [AppImage](../../releases/latest/download/Chat-On-Steroids-Linux-arm64.AppImage) · [DEB](../../releases/latest/download/Chat-On-Steroids-Linux-arm64.deb) |

Every package ships with matching native dependencies, a pinned `tunnel-client`, ripgrep and the Chrome extension for that CPU. A standalone [extension zip](../../releases/latest/download/Chat-On-Steroids-Extension.zip) is attached for manual installs, and [`SHA256SUMS.txt`](../../releases/latest/download/SHA256SUMS.txt) lists every hash.

Windows and AppImage installs check GitHub for a newer release on start and every six hours, download it, verify its checksum and apply it when you quit. macOS and DEB installs are told and linked to the release page instead.

**Debian and Ubuntu: prefer the DEB.** The AppImage uses electron-builder's static launcher. On a host that disables unprivileged user namespaces, that launcher can fall back to starting Chromium with `--no-sandbox` so the app still opens. If you do not want that fallback, use the DEB.

**The builds are not publisher-signed yet**, and macOS builds are not notarized. SmartScreen, Gatekeeper or your browser will warn. Verify the hash first, then use the normal "run anyway" path, or [build from source](#building).

```powershell
Get-FileHash .\Chat-On-Steroids-Setup-x64.exe -Algorithm SHA256   # Windows
```
```sh
shasum -a 256 Chat-On-Steroids-macOS-arm64.dmg    # macOS
sha256sum Chat-On-Steroids-Linux-x64.AppImage     # Linux
```

> **This is a beta with real permissions.** A fresh install starts with the full Core capability set on, read-only mode off, multi-agent mode on with two workers, and, on Windows, the Desktop permissions on. On macOS the Desktop permissions start off; switch them on in the Home panel if you want them, then grant Screen Recording and Accessibility in System Settings. Review the Home panel before you connect ChatGPT. `exec_command` runs programs as your logged-in user. Approve a project folder, not your home directory, and work on code that is committed somewhere.

## Requirements

- **Windows 10/11**, **macOS 13 Ventura or newer**, or a current desktop **Linux**, on x64 or ARM64 matching the build you downloaded.
- **Chrome 116 or newer** for the companion extension. Without it you still get the MCP tools, but not session attribution, Compact & Resume, worker chats or the Goal loop.
- **Linux:** a Secret Service keyring such as GNOME Keyring or KWallet. The app refuses Electron's unencrypted `basic_text` fallback for stored keys.
- A ChatGPT workspace with **Developer mode** and custom MCP apps. OpenAI currently documents full MCP support, including write actions, as a beta for Business, Enterprise and Edu, with Pro limited to read and fetch. Business needs an admin to enable it. Check OpenAI's [Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) page if your workspace looks different.
- An **OpenRouter API key** only if you want Goal or Loop. Everything else works without one.

Use a normal ChatGPT conversation with the custom app enabled. OpenAI's built-in Agent mode does not use custom apps.

## Quick start

1. Install the build for your CPU and open Chat On Steroids. It lives in the tray or menu bar.
2. On **Home**, review the permissions and approve a project folder. Press **Add**, or drop the folder onto the Folders card.
3. Create an OpenAI Secure MCP Tunnel and a restricted API key, then press **Connect**. Details below.
4. In ChatGPT on the web, enable Developer mode and create the **Core** app from the tunnel. On Windows, create the **Desktop** app too if you left screen and input control on; on macOS, if you switched them on.
5. Press **Open extension folder**, open `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select that folder. Pairing is automatic.

The Setup tab marks each hop done only once the app has actually seen traffic on it.

### OpenAI Secure MCP Tunnel (recommended)

1. In [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels), create a tunnel in the same workspace you use in ChatGPT and copy its id (`tunnel_…`).
2. In [Platform → API keys](https://platform.openai.com/settings/organization/api-keys), create a **Restricted** key with only **Tunnels: Read** and **Tunnels: Use**.
3. Paste both into the Setup tab and press **Connect**.
4. In ChatGPT, enable Developer mode under **Settings → Apps → Advanced settings** and create a custom app of type **Tunnel**. Review the discovered actions and enable it.

Core and the optional Desktop surface (Windows and macOS) use separate tunnel ids, because ChatGPT treats each custom app as one endpoint. Release builds bundle a checksum-verified `tunnel-client`; a path you set explicitly wins over it, and `PATH` is only a fallback.

### Other tunnels

**Cloudflare quick tunnel:** press **Connect**, copy the URL and use it as the MCP server URL in ChatGPT. The random path in that URL is the secret. It changes on every restart.

**Your own HTTPS tunnel:** point it at the loopback URL the app shows and give ChatGPT the public equivalent, secret path included.

After changing permissions, refresh or recreate the custom app in ChatGPT and start a new conversation. ChatGPT caches the action list it reviewed, and the app does not pretend to hot-patch a cached schema.

## What ChatGPT gets

| Connector | Tools | What they do |
| --- | --- | --- |
| **Core** (all platforms) | `read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `session`, `agents` | Bounded reads and search inside approved folders, preflighted multi-file patches, shell commands and interactive terminals, lookups into the recorded session, and worker chat control |
| **Desktop** (Windows, and macOS when switched on) | `observe`, `computer` | Screenshots, window and control inspection, mouse, keyboard and clipboard |

Core exposes at most seven tools at once: `find` is the no-shell search fallback and steps aside when commands are enabled. Revoking a permission takes effect immediately, even while ChatGPT still shows the old schema. The full contract lives in [`docs/tool-surface.md`](docs/tool-surface.md).

Every call is answered with a structured outcome the model can act on. A refused call says why and what to do next, whether that is a missing permission, a folder outside the approved roots, unread background results it has to collect first, or a chat that lost its identity.

## Sessions and the extension

Recording is on by default and can be switched off. The app keeps a durable local history of every conversation the extension can see: the messages, each tool call, and the real result the app returned. That history feeds the Chat timeline in the app and the `session` tool, so ChatGPT can search what it did last week instead of guessing. Retention defaults to 30 days. Data lives under the app's per-user directory: `%APPDATA%\chat-on-steroids\sessions\` on Windows, `~/Library/Application Support/chat-on-steroids/sessions/` on macOS, `${XDG_CONFIG_HOME:-~/.config}/chat-on-steroids/sessions/` on Linux.

The extension runs only on `chatgpt.com` and `chat.openai.com` plus the app's loopback bridge. It proves which conversation made each MCP call, captures the visible transcript, draws richer tool rows in the chat, and coordinates worker tabs. App and extension are versioned together: after updating the app, press **Reload** on the unpacked extension.

### The sheet beside the composer

<p align="center">
  <img src="docs/images/composer-sheet.png" width="62%" alt="The sheet next to the ChatGPT composer: an Auto-compaction toggle, an Off / Goal / Loop slider, an add task line and a Compact and resume now button" />
</p>

One gear next to the ChatGPT composer holds the per-chat controls: automatic compaction, the Off / Goal / Loop slider, a task for this chat, and a manual Compact & resume. In a worker chat these are locked, because a worker's prime already drives it.

### Compact & Resume

The app estimates context pressure locally. Fresh installs warn at about 400k estimated tokens, mark 533k as the ceiling, and compact automatically at 400k. These are local estimates, not ChatGPT's own counter.

Compact & Resume asks the current chat for a handoff brief, stores it, opens a fresh conversation and rebinds the same local session to it. While the brief is being written the old chat is refused every tool, so a turn that will not stop cannot keep changing the machine the brief describes. Both sends carry durable checkpoints tied to marked ChatGPT messages, so a refresh, a closed tab or an app restart cannot submit either prompt twice or lose the session between the two chats. If the handoff cannot complete, the original session stays where it was. Goal, task and worker history all move with it.

### Goal and Loop

Long jobs are mostly you typing "carry on" for an hour. **Goal** hands that to a second model: after every finished answer it reads the conversation and either writes your next message or decides the job is done. The shipped prompt is deliberately eager. It keeps going while anything you asked for is missing, promised rather than done, or answered with a question, and it refuses to invent work you never asked for.

**Loop** is the same machinery with the exit removed. Every finished turn gets a reply, and the only thing that ends it is the slider going back to Off. Its prompt spends most of its length on what a model that must always speak gets wrong: it restates the whole job instead of circling one detail, and when everything looks done it asks for another pass that verifies, hardens and tests. The app enforces the no-stop rule too. The model is sent a response schema without a stop action, an answer that tries anyway is asked again, and a third refusal fails the turn rather than typing something the model never wrote.

**Add a task** gives one chat a specific goal in your own words. The loop drives toward that text, quotes it back when ChatGPT quietly narrows the job, and stops when it is reached. In a new chat the task also writes the first message. Tasks are per chat and durable: they survive reopening, and Compact & Resume carries them to the replacement chat.

The loop only fires when a turn has really ended, judged from ChatGPT's own end-of-turn evidence with a conservative fallback when that is missing. A turn you stopped by hand is left alone. Only your messages and ChatGPT's final answers leave the machine; tool calls, their results and the commentary in between never do.

It needs an OpenRouter key, stored encrypted and used only by the app. Model, reasoning level and the three editable prompts live under **Chat → Settings**, each with a one-click restore. This spends credit on every finished turn and sends messages without asking each time. Switch it off when you are not watching.

### Multi-agent mode

One prime chat can open up to eight worker chats (two by default; three at once reliably trips ChatGPT's rate limit) and exchange brokered messages with them through the `agents` tool. Workers cannot talk to each other.

Workers are reusable conversations. When one reports its result it goes to sleep, frees its slot and keeps its full chat. Messaging it again wakes the same conversation: the extension focuses the tab if it is still open, or the app reopens the stored `/c/…` URL and types the new instruction there. A worker that keeps calling tools after the app thought it asleep is simply revived, because a chat that is visibly working is not asleep. At about 400k recorded tokens a worker becomes non-revivable after its next stop. Workers never compact themselves. Stopped worker tabs beyond the few most recently used are closed to keep Chrome's memory in check.

Each prime owns its worker history. If the last worker sleeps, the run is parked and another chat can start its own workers; the original prime still sees its full history in `agents action=status`, can spawn fresh workers, and can wake old ones when the execution slot is free. Turning multi-agent off pauses execution and keeps that history. **Clear swarm** is what discards it.

Identity is fail-closed. Spawning, messaging and every other identity-sensitive action needs the extension to prove which conversation made the call. A chat used from somewhere the extension cannot see, such as the phone app, still gets the ordinary Core tools but not agent control.

### Blocking a chat

A wedged ChatGPT page can leave a turn running with no working Stop button while the model keeps calling tools. The app cannot end that turn, but it can take its tools away. **Block** in the Chat tab refuses every call from that conversation with a message telling the model to abandon the task and answer, and the turn ends itself. It is not a cancel, and it applies only to calls whose owner is proven.

## Security in one page

- **File tools stay inside approved folders.** Paths are validated and canonicalised first. This is application-level containment, not an OS sandbox; same-user filesystem races remain possible.
- **Commands are not folder-sandboxed.** They start in an approved folder and then run with your normal user privileges.
- **Desktop control is not folder-scoped.** When enabled, it applies to the whole Windows or macOS desktop. On macOS it is off until you switch it on, and macOS additionally enforces its own Screen Recording and Accessibility grants.
- **The MCP server is loopback-only** behind a random secret path. ChatGPT reaches it through the tunnel you configure. Treat any public tunnel URL as a password.
- **The browser bridge is loopback-only and separate.** It exists for the extension and exposes no file, command or settings routes.
- **Secrets use Electron `safeStorage`:** DPAPI on Windows, Keychain on macOS, libsecret or KWallet on Linux.
- **Read-only mode** disables file writes, command execution, desktop control and clipboard writes in one switch.

Report vulnerabilities privately per [`SECURITY.md`](SECURITY.md).

### The extension and OpenAI's terms

The MCP connector uses ChatGPT's documented Developer mode and Secure MCP Tunnel path. The extension is different: it observes ChatGPT's web UI, records rendered conversation state locally, and multi-agent mode opens and types into extra ChatGPT tabs. None of that is a documented public automation API. Depending on your account, OpenAI's [terms and policies](https://openai.com/policies/) on automated access, rate limits and permitted use may apply. Read the agreement that governs your account before using the extension or multi-agent mode, and do not use these features to scrape ChatGPT, evade limits or bypass safety controls.

## Troubleshooting

- **Tools missing or stale after a permission change:** refresh or recreate the custom app in ChatGPT and start a new conversation.
- **Extension says app not found:** recording or multi-agent mode must be on for the bridge to run. Then reopen the popup.
- **Extension version mismatch:** reload the unpacked extension after every app update.
- **`agents` says `UNIDENTIFIED_CALLER`:** use that conversation in the paired browser so the extension can observe its request id. The app will not guess identity from the active tab.
- **`COMPACTION_IN_PROGRESS` in a chat:** that chat is being handed off. Let it write the brief; work continues in the replacement.
- **OS warning about an unverified app:** expected for the unsigned beta. Verify `SHA256SUMS.txt` before overriding.
- **Linux says secure credential storage is unavailable:** unlock GNOME Keyring or KWallet and restart the app.
- **Tunnel unavailable:** point Advanced settings at an explicit `tunnel-client` or `cloudflared`, or use the bundled copy.

## Development

```sh
npm ci
npm run dev        # run the app with hot reload
npm run verify     # typecheck, tests and the privacy gate; the same gate CI runs
```

Read [`AGENTS.md`](AGENTS.md) before changing anything. It is the design record: what each invariant is, which incident produced it, and which test guards it.

## Building

```sh
npm run dist:x64          # Windows x64
npm run dist:arm64        # Windows ARM64
npm run dist:mac:x64      # macOS Intel DMG + ZIP
npm run dist:mac:arm64    # macOS Apple Silicon DMG + ZIP
npm run dist:linux:x64    # Linux x64 AppImage + DEB
npm run dist:linux:arm64  # Linux ARM64 AppImage + DEB
```

Package on the target operating system. The release workflow runs on native Windows, macOS and Linux runners for both CPUs, pins and verifies the tunnel and ripgrep assets, stages matching native dependencies, smoke-tests the packaged runtime, and assembles one release candidate with the extension zip and `SHA256SUMS.txt`. Publishing checks OpenAI's current stable `tunnel-client` release before and after the candidate build and refuses a stale pin, while keeping the tagged build reproducible.

## Contributing

Bug reports, feature requests and PRs are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Release history is in [`CHANGELOG.md`](CHANGELOG.md).

## Licence

MIT. See [`LICENSE`](LICENSE).

Not affiliated with, endorsed by, or connected to OpenAI. "ChatGPT" and "Codex" are trademarks of OpenAI, used here only to describe what this tool works with.
