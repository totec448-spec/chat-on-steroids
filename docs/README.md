# Chat On Steroids documentation

Start with **[Setup and reference](setup.md)**. It covers installing, connecting ChatGPT, the browser bridge, the Local control API, permissions, notifications and troubleshooting.

## Guides

| Read this | When |
| --- | --- |
| [Setup and reference](setup.md) | First install, connecting, day-to-day settings, fixing problems |
| [Plugins](plugins.md) | Adding Blender, Playwright, Memory or your own MCP servers |
| [Tool reference](tool-surface.md) | What ChatGPT can call: files, terminals, workers, steps for you |
| [Dictation on Windows](windows-dictation.md) | Speaking instead of typing |
| [Release notes](release-notes/) | What changed in each version, in plain words |
| [Changelog](../CHANGELOG.md) | The same, in one file |

## For contributors

- [Contributing](../CONTRIBUTING.md) and the [architecture notes](../AGENTS.md)
- [Recovery inventory](recovery-inventory.md): every way a stuck chat is brought back, in one place
- [ChatGPT turn signals](chatgpt-turn-signals.md) and [usage attribution](usage-model-attribution.md)
- [Linux desktop design](linux-desktop-design.md) and its [live acceptance notes](linux-desktop-gtk-live-acceptance.md)
- [Pet acceptance checklist](pet/ACCEPTANCE.md) and the [feature parity matrix](parity/FEATURE_PARITY_MATRIX.md)
- Third-party notices: [plugin licenses](plugin-licenses.md) and the [plugin notice audit](plugin-notice-audit.md)

## Pictures

The README's screenshots are made from the real app with made-up data, so they can be redone whenever the interface changes:

```
npm run build
npx electron scripts/capture-readme-shots.cjs         # workspace, model picker, settings
node scripts/capture-readme-features.cjs              # step for you, why it is stuck, related folders, phone notifications
npx electron scripts/capture-readme-demo.cjs          # the demo recording (demo.gif and demo.mp4)
```

## Engineering history

The dated audits, bug hunts, triage ledgers and worklogs live in [archive/](archive/README.md). They describe the code on the day they were written and are not kept up to date.
