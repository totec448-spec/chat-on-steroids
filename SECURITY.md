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
- Screen, mouse/keyboard and clipboard permissions are desktop-wide capabilities on Windows and macOS, not folder permissions. On macOS they start off and also require the OS's own Screen Recording and Accessibility grants.
- MCP servers bind to loopback and use secret tokenized paths. Public reachability comes only from the tunnel you configure.
- The companion-extension bridge is a separate loopback service and exposes no filesystem, command or settings-mutation route.
- Stored API/bridge credentials use Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, a secure desktop secret store on Linux). Linux `basic_text` is refused; normal Activity logs are redacted, capped and memory-only.
- Session recording is separate durable local history. It is on for fresh installs and can be disabled.

## Expected limitations

These are properties of the current design, not vulnerability reports by themselves:

- **Release binaries are not publisher-signed; macOS builds are also unnotarized.** Apple-silicon Mach-O files may still carry ad-hoc signatures, which do not identify a publisher or establish Gatekeeper trust. Windows SmartScreen, macOS Gatekeeper or browsers can warn. Verify release SHA-256 checksums before running them.
- **The Linux AppImage has a sandbox-availability fallback.** Its electron-builder static launcher can add `--no-sandbox` when the host disables unprivileged user namespaces. On Debian/Ubuntu, prefer the DEB on such restrictive systems if you do not want the portable AppImage to take that fallback.
- **Fresh installs start Core permissions enabled and read-only mode off.** Windows additionally enables Desktop permissions; Desktop is unavailable on macOS/Linux. Review permissions before connecting ChatGPT. Existing installs keep their explicit stored choices.
- **Application path checks are not a kernel/VM sandbox.** They substantially constrain the app's filesystem tools, but same-user filesystem races can still exist. Do not treat approved roots as isolation from a hostile local process.
- **Command and Windows Desktop capabilities are powerful by design.** If enabled, they can act wherever your logged-in user can act, subject to normal OS privilege boundaries.
- **Session recording is intentionally detailed and is not encrypted by `safeStorage`.** Recorded conversations/tool activity stay local to this app, but anyone with access to your OS account may be able to read the session files.

## Scope

In scope: this repository's desktop app, MCP surfaces, local browser bridge and `extension/` companion.

Out of scope: ChatGPT/OpenAI infrastructure, Electron/Chromium upstream, `tunnel-client`, `cloudflared`, and other third-party dependencies. Report upstream vulnerabilities to the relevant project as well.
