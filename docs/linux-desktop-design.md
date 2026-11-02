# Linux Desktop integration — read-only screenshot stage

This document is the design/acceptance boundary of part 2 in the three-PR
split requested by the upstream maintainer on #2022.

## User flow

1. In Linux Settings, choose **Allow native Linux Desktop access**. The switch
   is off for new and upgraded installations. Enable **Screen** permission
   separately; ordinary browser permission is not equivalent.
2. With the CoS window focused, choose **Request screenshot permission**.
   GNOME Wayland may present a portal confirmation. The diagnostic returns
   only success/failure and PNG byte length; screen pixels are discarded.
3. When authorized, the Desktop connector exposes `linux_observe` with only
   `{what:'screenshot',display:0}`. The MCP tool admits only display 0;
   other display indexes are rejected even though the standalone backend can
   address them. Its answer uses MCP image content and
   explicit **display**, not window, metadata. No click, type, control or
   accessibility snapshot is present in this PR.

## Security and lifecycle

- Screenshot transport is pinned to the reviewed Linux `agent-desktop` 1.0.2
  contract. Its subprocess adapter has just two commands: version and screenshot.
  There is no shell execution or generic argument pass-through.
- The backend output, decoded pixels and MCP wire image are bounded and
  verified. Invalid or refused portal answers never expose private text or
  image bytes in logs or user-facing error messages.
- Live native opt-in and Screen permissions are checked before every portal
  request, after asynchronous waits and again before emitting pixels. Revocation
  invalidates the observation, not just future operations.
- IPC consent is sender-bound to the main window and requires focus. Concurrent
  requests are refused; a denial, timeout or failure is never automatically
  retried. The screenshot itself never reaches the renderer.
- Opt-in changes reset the model-facing Desktop schema cache. A previously
  registered tool cannot remain in discovery with stale permission.
- A command with no proven session/chat cannot read the screen unless the
  separate legacy `ui.desktopUnattributed` opt-in explicitly allows it.

## Validation and staged rollout

The unit tests exercise invalid envelopes, PNG dimensions, bounded output,
backend version, missing grant, late revocation, and the absence of native
action schemas. The renderer tests exercise saving, consent, translations and
discarding capture bytes. GNOME portal consent must be accepted by a person
for a true end-to-end screenshot; unit-test data does **not** prove a live grant.
Linux UI/packaging acceptance must run in an isolated app instance.

Part 3 builds on this reviewed read-only surface and supplies native
accessibility snapshots and semantic control with additional owner/ref
checks. Nothing in part 2 confers that future input permission.
