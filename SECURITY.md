# Security policy

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem.** Use GitHub's private vulnerability reporting for this repository: **Security → Report a vulnerability**.

Include the smallest useful reproduction, the app version, operating-system version/architecture, and whether the Chrome extension was connected. Redact personal file contents, usernames/paths, conversation text and account/workspace identifiers. Never post live API keys, connector URLs, tunnel tokens or other credentials. Rotate anything accidentally exposed.

This is a solo-maintained beta. There is no bug bounty or guaranteed response window.

Security fixes target the **latest published release**. If you can reproduce an issue safely on
the latest version, include that result in the private report.

## Security model

Chat On Steroids is a permission boundary between ChatGPT and the logged-in OS user running the app:

- Filesystem tools validate paths against folders you explicitly approve.
- Read-only mode disables effective file writes, commands, desktop control and clipboard writes.
- `exec_command` is intentionally **not** confined to approved folders. It starts in an approved working directory, then runs with the normal privileges of your account.
- The optional Allowlist/Denylist command policy controls which simple command invocation may start. Unsupported shell syntax still fails closed. It does not sandbox a permitted executable, its child processes, interactive stdin, build scripts or later filesystem/system effects.
- Screen/control permissions also enable the companion's background browser tools on Chromium hosts. Chrome grants required debugger/tabs and HTTP(S) host permissions; there is no additional per-tab approval dialog. Read-only disables browser input, navigation, tab creation/closure and page JavaScript. Native screen, mouse/keyboard and clipboard remain desktop-wide on supported Windows/macOS hosts, independent of approved folders and macOS OS consent.
- MCP servers bind to loopback and use secret tokenized paths. Public reachability comes only from the tunnel you configure.
- The companion-extension bridge is a separate loopback service and exposes no filesystem, command or settings-mutation route.
- Google sign-in for the built-in browser opens the user's installed Chrome/Edge/Brave with its normal profile. The companion requests optional cookie access only when the user clicks its session-transfer button. It may open its own popup when a login it watched returns to ChatGPT, ChatGPT confirms a signed-in session in that tab, and that transfer is pending; opening the popup reads and sends nothing. It sends only ChatGPT session-token cookies over the paired bridge for an outstanding, expiring sign-in operation; the app writes them to its browser partition without recording or logging their values. Disconnect cancels the operation. Importing a cookie does not prove ChatGPT will accept it, and there is no automatic session synchronization.
- The optional local control API is off by default. When turned on, it is a loopback-only service for a local agent that reads app status, chat history, tool activity, queued messages, workers and the Activity log. A second switch, off by default and off whenever the API is off, also lets it send a message to an existing chat and cancel a message that has not been delivered.
  - Its per-launch token is written to the app's user data folder and never issued over HTTP. Any process that can read that folder can use the API.
  - It refuses any browser Origin.
  - Actions go through the same outbox as the composer, are refused without the second switch before any request body is read, and never resend a message whose delivery is unconfirmed. A send connects the app and opens the chat in your browser as the composer would, and a model that reads the message can act under the permissions you have granted, so treat the token, with that switch on, as the ability to speak in your chats. Turning the API off turns actions off, and turning it on again leaves them off.
  - It never returns MCP paths, tunnel ids, plugin configuration or credentials from the app's own state. Chat, tool and log text has known credential shapes (API keys, common vendor tokens, bearer headers, JWTs, URL passwords, private keys) masked and is length-capped, but anything else you typed into a chat is returned as recorded. Treat the token like access to your history.
- Stored API/bridge credentials use Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, a secure desktop secret store on Linux). Linux `basic_text` is refused; normal Activity logs are redacted, capped and memory-only.
- Session recording is separate durable local history. It is on for fresh installs and can be disabled.

## Provider rules and responsible use

Local permissions control access to your machine; they do not authorize bypassing a provider's safety decision, usage limit or account restriction. Do not route a blocked action through another tool, worker, connector or account. Follow the [responsible-use notice](README.md#responsible-use-and-provider-rules) and the applicable provider terms.

CoS is an independent beta used at your own risk. Its browser automation and local recording are not an OpenAI approval or a guarantee of compliance or continued account access. Review the security model and limitations on this page, supervise tool use and stop workflows that receive a provider restriction or policy warning. Account enforcement questions belong with the provider's support or appeal process; keep private notices and account identifiers out of public reports.

## Expected limitations

These are properties of the current design, not vulnerability reports by themselves:

- **Release binaries are not publisher-signed; macOS builds are also unnotarized.** Apple-silicon Mach-O files may still carry ad-hoc signatures, which do not identify a publisher or establish Gatekeeper trust. Windows SmartScreen, macOS Gatekeeper or browsers can warn. Verify release SHA-256 checksums before running them.
- **The Linux AppImage has a sandbox-availability fallback.** Its electron-builder static launcher can add `--no-sandbox` when the host disables unprivileged user namespaces. On Debian/Ubuntu, prefer the DEB on such restrictive systems if you do not want the portable AppImage to take that fallback.
- **Fresh installs start Core permissions enabled and read-only mode off.** Windows additionally enables Desktop permissions; Linux enables extension browser screen/control, and macOS retains its off default. Existing installs keep their explicit stored choices.
- **Application path checks are not a kernel/VM sandbox.** They substantially constrain the app's filesystem tools, but same-user filesystem races can still exist. Do not treat approved roots as isolation from a hostile local process.
- **Command and Windows Desktop capabilities are powerful by design.** If enabled, they can act wherever your logged-in user can act, subject to normal OS privilege boundaries.
- **Session recording is intentionally detailed and is not encrypted by `safeStorage`.** Recorded conversations/tool activity stay local to this app, but anyone with access to your OS account may be able to read the session files.

## Scope

In scope: this repository's desktop app, MCP surfaces, local browser bridge and `extension/` companion.

Out of scope: ChatGPT/OpenAI infrastructure, Electron/Chromium upstream, `tunnel-client`, `cloudflared`, and other third-party dependencies. Report upstream vulnerabilities to the relevant project as well.
