# Linux Desktop integration: implementation contract

This contract describes the Linux feature worktree; it does **not** by itself establish a
finished or live-tested CoS installation. The first
live acceptance target is the particular Ubuntu/GNOME Wayland desktop on which it is
tested. Report its versions; do not infer support for every Ubuntu or Linux desktop.

- Linux native access requires a separate, default-off opt-in and the relevant live CoS
  screen/control grants. Existing browser permissions alone do not grant native access.
- With the existing explicit unattributed Desktop setting, observation may run without
  a known chat. Ref actions require a proven chat/session identity even in that mode.
  A shared anonymous reference namespace is not an identity.
- After every wait, including caller correlation, desktop confirmation and serialization,
  recheck the Linux opt-in, live control permission, read-only mode, owner and target
  immediately before execution. Test revocation while a confirmation is pending.
- Native input confirmations are scoped to the same proven Setup profile, local
  session and ChatGPT conversation as the accessibility ref. Late request-id
  correlation must be forwarded into the confirmation gate itself; a connector
  transport key or a session alone cannot confer a Linux input grant to another
  conversation. Ref expiry is 120 seconds, and a failed pre-input check does
  not count as physical input by the app.
- On Wayland screenshots are display captures, identified as such in the result and
  returned as MCP image content. Window snapshots contain accessibility data, not a
  window screenshot. The portal can wait at least 30 seconds for the person to respond.
- A desktop end-to-end test must use a separate CoS instance, Electron user-data directory,
  ports and connector credentials. Record the tested build commit and endpoint identity;
  a separate source worktree alone does not isolate runtime state.
- Preserve backend delivery and retry evidence. A timeout after launching an action has
  unknown outcome; do not automatically repeat the action or switch to physical input.
- Native browser actions require reliable target identification and are outside the first
  release. Use the existing browser tools; refuse when the target cannot be proven safe,
  including Linux reverse-DNS browser application IDs such as `org.mozilla.firefox`.
