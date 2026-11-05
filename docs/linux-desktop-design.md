# Linux Desktop integration — screenshot (part 2) and semantic control (part 3)

This document records part 2's read-only screenshot boundary and the part 3
semantic-control extension in the three-PR split requested on #2022.

## Part 2 — read-only screenshot user flow

1. In Linux Settings, choose **Allow native Linux Desktop access**. The switch
   is off for new and upgraded installations. Enable **Screen** permission
   separately; ordinary browser permission is not equivalent.
2. With the CoS window focused, choose **Request screenshot permission**.
   GNOME Wayland may present a portal confirmation. The diagnostic returns
   only success/failure and PNG byte length; screen pixels are discarded.
3. In part 2, the Desktop connector exposed `linux_observe` with only
   `{what:'screenshot',display:0}`. The MCP screenshot tool admits only display 0;
   other display indexes are rejected even though the standalone backend can
   address them. Its answer uses MCP image content and
   explicit **display**, not window, metadata. Part 2 added no click, type,
   control or accessibility snapshot; part 3 extends the observation surface.

## Part 2 — screenshot security and lifecycle

- Screenshot transport is pinned to the reviewed Linux `agent-desktop` 1.0.2
  contract. In part 2, its subprocess adapter had only version and screenshot
  commands; part 3 adds bounded inventory, snapshot and semantic actions.
  Neither stage uses shell execution or generic argument pass-through.
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

Part 2 unit tests exercise invalid envelopes, PNG dimensions, bounded output,
backend version, missing grant, late revocation, and the absence of native
action schemas at that stage. The renderer tests exercise saving, consent,
translations and discarding capture bytes. GNOME portal consent must be accepted by a person
for a true end-to-end screenshot; unit-test data does **not** prove a live grant.
Linux UI/packaging acceptance must run in an isolated app instance.

## Part 3 — current semantic native control extension

The follow-on stage adds app/window/display inventory and accessibility
snapshots. Each snapshot belongs to a proven chat and Setup profile, has a
bounded lifetime and is restricted to an exact nonbrowser window/process.
`linux_act` may click or set a value through a fresh semantic ref under
live Control permission. It revalidates owner, refs, target and permission
after any approval prompt, then consumes the refs.

Unattributed observations, when separately opted into, have ephemeral
non-actionable refs. Physical mouse/keyboard events, coordinates, browser
AT-SPI input and unbounded command execution are never supported.
No capability from part 2 grants native input by itself.
