<p align="center"><img src="docs/images/readme-hero.svg?v=2" width="960" alt="Turn ChatGPT into Codex-style local coding. Chat On Steroids: Your files. Your terminal. Your ChatGPT plan." /></p>

<p align="center">
  <a href="https://github.com/totec448-spec/chat-on-steroids/releases/latest/download/Chat-On-Steroids-Setup-x64.exe"><img src="docs/images/download-windows.svg" width="208" height="56" alt="Download for Windows x64" /></a>&nbsp;
  <a href="https://github.com/totec448-spec/chat-on-steroids/releases/latest/download/Chat-On-Steroids-macOS-arm64.dmg"><img src="docs/images/download-macos.svg" width="208" height="56" alt="Download for macOS Apple silicon" /></a>&nbsp;
  <a href="https://github.com/totec448-spec/chat-on-steroids/releases/latest/download/Chat-On-Steroids-Linux-x64.deb"><img src="docs/images/download-linux.svg" width="208" height="56" alt="Download for Linux x64" /></a>
</p>

<p align="center"><a href="https://github.com/totec448-spec/chat-on-steroids/releases/latest">All downloads</a></p>

<p align="center"><sub>Independent beta. Use at your own risk and within your provider's rules. <a href="#responsible-use-and-provider-rules">Read the usage notice</a> before connecting.</sub></p>

<br />

<p align="center"><a href="docs/images/demo.mp4"><img src="docs/images/demo.gif" width="960" alt="Chat On Steroids in action: model selection, task plans, live tool results and reusable workers" /></a></p>

<p align="center"><a href="#get-started">Get started</a> &nbsp;·&nbsp; <a href="docs/images/demo.mp4">Watch the demo</a> &nbsp;·&nbsp; <a href="CHANGELOG.md">What’s new</a></p>

<br />

<h2 align="center">Code. Delegate. Keep going.</h2>

**Work on the real project.** Let ChatGPT read and edit files, run tests, keep terminals open and use your desktop. Follow the actual tool results as they arrive.

**Give it a team.** Split independent jobs across workers, then bring their results back. Workers keep their context, so the next task can pick up where they left off.

**Stay in control of long tasks.** Send a correction while work runs. Goal follows unfinished work; Loop keeps working within your brief. Compact & Resume carries the session and worker history into a fresh chat.

<p align="center"><strong>Uses your ChatGPT conversation rather than invoking Codex directly.</strong><br /><sub>ChatGPT Work and Codex share usage limits. Your account’s model availability, usage and context limits still apply. <a href="https://learn.chatgpt.com/docs/pricing">OpenAI usage details →</a></sub></p>

## Responsible use and provider rules

Chat On Steroids is an independent, open-source workspace for coding and other authorized tasks with your own files and tools. It is intended to support productive work within the rules of the services you use. **It is not intended to bypass usage limits, account restrictions or safety controls.**

Use CoS in accordance with OpenAI's applicable [Terms of Use](https://openai.com/policies/terms-of-use/) ([Europe Terms](https://openai.com/policies/eu-terms-of-use/) for the EEA, Switzerland and UK), [Usage Policies](https://openai.com/policies/usage-policies/) and [Service Terms](https://openai.com/policies/service-terms/), plus your workspace's rules and any connected service's terms.

- **Respect limits and access decisions.** Workers, Goal/Loop, Compact & Resume and finish checkpoints organize work; they do not grant extra quota or model access and must not be used to evade rate limits, usage caps or account restrictions. Do not switch accounts, chats, connectors or tunnels to evade a restriction.
- **Respect safety decisions.** Do not use local tools, browser control, plugins or another worker to carry out an action that the provider blocked for safety. A local permission or an enabled MCP connector is not permission to override a provider refusal.
- **Understand the integration.** CoS connects local tools through MCP. Its companion also observes and automates the ChatGPT browser UI and records conversation content locally. This browser integration is not a public ChatGPT automation API. MCP availability does not establish permission for every form of browser automation or recording; OpenAI's terms also restrict automated or programmatic extraction of data or output.
- **Use at your own risk.** Review the rules for your account and intended workflow before connecting, supervise automation and review tool actions and outputs. CoS cannot guarantee policy compliance, continued service access or protection from account warnings, restrictions or suspension. If a workflow is restricted or receives a policy warning, stop that workflow and seek clarification through the provider's support or appeal process.

This notice states the project's intended use; it does not certify compliance or change provider rules. CoS is not affiliated with, endorsed by or approved by OpenAI. The software is provided as-is under the [MIT license](LICENSE); applicable statutory rights remain unaffected. See [Security](SECURITY.md) for local permissions and risks.

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

<p align="center"><a href="docs/setup.md">Setup &amp; help</a> &nbsp;·&nbsp; <a href="docs/plugins.md">Plugins</a> &nbsp;·&nbsp; <a href="docs/build.md">Build &amp; test</a> &nbsp;·&nbsp; <a href="CONTRIBUTING.md">Contribute</a> &nbsp;·&nbsp; <a href="SECURITY.md">Security</a> &nbsp;·&nbsp; <a href="LICENSE">MIT license</a></p>

<p align="center">Built with our <a href="CONTRIBUTORS.md">community contributors</a>. Thank you to the people behind the code, designs, bug reports and testing.</p>

<p align="center"><sub>Not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.</sub></p>
