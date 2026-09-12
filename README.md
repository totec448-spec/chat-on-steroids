<p align="center"><img src="docs/images/readme-hero.svg?v=2" width="960" alt="Turn ChatGPT into Codex without touching Codex limits. Chat On Steroids: Your files. Your terminal. Your ChatGPT plan." /></p>

<p align="center">
  <a href="https://github.com/totec448-spec/chat-on-steroids/releases/latest/download/Chat-On-Steroids-Setup-x64.exe"><img src="docs/images/download-windows.svg" width="208" height="56" alt="Download for Windows x64" /></a>&nbsp;
  <a href="https://github.com/totec448-spec/chat-on-steroids/releases/latest/download/Chat-On-Steroids-macOS-arm64.dmg"><img src="docs/images/download-macos.svg" width="208" height="56" alt="Download for macOS Apple silicon" /></a>&nbsp;
  <a href="https://github.com/totec448-spec/chat-on-steroids/releases/latest/download/Chat-On-Steroids-Linux-x64.deb"><img src="docs/images/download-linux.svg" width="208" height="56" alt="Download for Linux x64" /></a>
</p>

<p align="center"><a href="https://github.com/totec448-spec/chat-on-steroids/releases/latest">All downloads</a></p>

<br />

<p align="center"><a href="docs/images/demo.mp4"><img src="docs/images/demo.gif" width="960" alt="Chat On Steroids in action: model selection, task plans, live tool results and reusable workers" /></a></p>

<p align="center"><a href="#get-started">Get started</a> &nbsp;·&nbsp; <a href="docs/images/demo.mp4">Watch the demo</a> &nbsp;·&nbsp; <a href="CHANGELOG.md">What’s new</a></p>

<br />

<h2 align="center">Code. Delegate. Keep going.</h2>

**Work on the real project.** Let ChatGPT read and edit files, run tests, keep terminals open and use your desktop. Follow the actual tool results as they arrive.

**Give it a team.** Split independent jobs across workers, then bring their results back. Workers keep their context, so the next task can pick up where they left off.

**Stay in control of long tasks.** Send a correction while work runs. Goal follows unfinished work; Loop keeps working within your brief. Compact & Resume carries the session and worker history into a fresh chat.

<p align="center"><strong>Uses your ChatGPT conversation. Does not consume Codex quota.</strong><br /><sub>Your account’s model availability, usage and context limits still apply.</sub></p>

<br />

## Get started

1. **Install CoS** and approve your project folder in **Settings → Workspace**.
2. **Connect Core** through **Settings → Setup** and add it in ChatGPT’s Developer mode. [Tunnel setup →](docs/setup.md#tunnel-setup)
3. **Load the companion extension.** Click **Open extension folder**, then **Load unpacked** in Chrome’s extension settings. Pairing is automatic.
4. **Choose a model, write your task and send.**

<details>
<summary>Requirements &amp; installation notes</summary>

Windows 10/11, **macOS 13 Ventura or newer**, or a current desktop Linux. Chrome 116+ or current Edge, plus a ChatGPT account/workspace with Developer mode and custom MCP apps. [Check account availability](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

- **Unsigned beta:** Windows is not publisher-signed; macOS is unsigned and unnotarized. Verify the package against the release checksums.
- **Linux:** a Secret Service keyring is required. Prefer the DEB; when unprivileged user namespaces are disabled, the AppImage launcher can fall back to <code>--no-sandbox</code>.
- **Permissions:** choose your approved folders and review capabilities before connecting. Fresh installs enable Core capabilities and two workers; Windows also enables Desktop permissions. Shell commands run with your normal user privileges.
- **After updating:** reload the companion extension and refresh the CoS apps in ChatGPT when prompted.

</details>

<details>
<summary>More screenshots</summary>

![Conversation, workers and task plan](docs/images/workspace.png)

![Model and reasoning selection](docs/images/model-picker.png)

![Folder and capability settings](docs/images/settings.png)

</details>

<br />

---

<p align="center"><a href="docs/setup.md">Setup &amp; help</a> &nbsp;·&nbsp; <a href="docs/plugins.md">Plugins</a> &nbsp;·&nbsp; <a href="CONTRIBUTING.md">Contribute</a> &nbsp;·&nbsp; <a href="SECURITY.md">Security</a> &nbsp;·&nbsp; <a href="LICENSE">MIT license</a></p>

<p align="center">Built with our <a href="CONTRIBUTORS.md">community contributors</a>. Thank you to the people behind the code, designs, bug reports and testing.</p>

<p align="center"><sub>Not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.</sub></p>
