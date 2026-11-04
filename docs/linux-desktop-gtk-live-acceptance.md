# Linux Desktop: GNOME/GTK MCP live acceptance (2026-11-04)

Scope: reproducible, opt-in security acceptance for PR #2061. This report
describes **real local MCP HTTP calls and real native GTK input**, not just
mocked tool responses. It does **not** claim a complete review of the Electron
Desktop Ask UI or a human-accepted permission dialog.

## Environment and isolation

- Ubuntu 24.04.5 LTS, GNOME Wayland; Python GTK 3.24 available from Ubuntu.
- Installed `agent-desktop` version **1.0.2**, the only reviewed Linux backend
  version admitted by the adapter.
- Run the opt-in test file `test/linux-desktop-mcp-live.test.ts`. It starts
  independent, loopback-only MCP HTTP with fresh temporary CoS configuration
  and session stores; it does not connect to or reconfigure the running app.
- The test creates exactly two temporary, explicitly named GTK fixture windows:
  `CoS Linux Desktop E2E Fixture` and `CoS Linux Desktop E2E Decoy`. Input
  targets only the first fixture. Both windows and the ephemeral MCP server
  are stopped after testing. No screenshots are requested or persisted.
- The fixture starts with live `screen` and `control` capabilities and the
  dedicated Linux Desktop setting opted in. `desktopAsk: 'off'` is used for
  baseline delivery so automated tests do not impersonate a person clicking
  the production dialog. Selected gate-delay scenarios below substitute a
  **test-controlled** Ask result, never a real user's permission.

## Results

Command (from the worktree, with the real GNOME desktop session active):

```bash
COS_LINUX_DESKTOP_LIVE=1 npx vitest run test/linux-desktop-mcp-live.test.ts --maxWorkers=1
```

**8 passed, 1 intentionally skipped**. The skipped case is the independent,
explicitly opt-in *full-display screenshot* capture
(`COS_LINUX_SCREENSHOT_LIVE=1`); no screenshot consent was invoked by this test.

| Live acceptance check | Result | Evidence / limitation |
| --- | --- | --- |
| Discover native Linux MCP tools over authenticated loopback HTTP | PASS | Both `linux_observe` and `linux_act` registered on the isolated Desktop MCP surface. |
| Deny when Linux Desktop opt-in is off | PASS | Observation and native action return `LINUX_DESKTOP_DISABLED`; fixture unchanged. |
| Screen-only permission cannot authorize Control | PASS | Real GTK snapshot succeeds, `linux_act` returns `TOOL_DISABLED`; no button activation. |
| Revoke Control after observation | PASS | A fresh ref cannot be acted on while Control is revoked; `TOOL_DISABLED`, no input. |
| Reject ref from another chat or arbitrary ref | PASS | Same HTTP surface, different proven chat / foreign ref yields `STALE_OR_FOREIGN_REF`. |
| Reject cross-window ref replay | PASS | Observe real fixture A, then real fixture B; the previous A ref is rejected. Neither window receives input. |
| Revalidate permissions after a delayed Ask result | PASS (controlled gate) | Synthetic delayed approval after live Control revocation is refused before input. **Does not test the human-facing Ask overlay.** |
| Require simulated Ask grant; decline simulated refusal | PASS (controlled gate) | A denied step performs no input; an explicitly released test gate enables actual GTK `set_value` through MCP. **Does not establish that a person can operate the real Ask dialog.** |
| Actual GTK click, text entry and replay protection | PASS | `set_value` succeeds and is verified, old ref replay is refused, new snapshot enables `click`, second click replay is refused, exactly one real fixture callback outputs the expected marker. |

No arbitrary application content, window inventory, screenshot pixels, secret
MCP URLs, input values from other applications, or credentials are saved in
the report. `E2E_RESULT` is a fixed synthetic fixture marker only.

## Remaining acceptance boundary

This validates the **real GNOME/GTK AT-SPI backend, exact-window MCP HTTP
transport, chat-scoped refs, live permission revocation and native semantic
input** on the specified Ubuntu desktop. For a full end-user Desktop Ask
acceptance, a maintainer or person must separately use the packaged app and
its actual Go ahead / Not now dialog, including keyboard/screen-reader path
where required. The delayed approval/refusal above deliberately uses an
in-process test gate, not a human click. The standalone GNOME screenshot
portal prompt was not exercised and is out of scope for PR #2061.

The test never installs/restarts production CoS, changes its persistent
configuration, or targets the person's other running application windows.

## Maintainer-review security follow-up

The stage-3 own-window exclusion (added after this manual GTK fixture session)
rejects native semantic snapshots of Chat On Steroids's own Electron windows
using the main process PID and the application's recognized IDs, including
`com.chatonsteroids.app.desktop`. Unit tests assert that no native snapshot
is invoked for either kind of own window and that post-Ask owner changes to
the CoS process never deliver input. These are **unit regression tests**,
not additional live observations of the person's own CoS window.

Unknown Linux/Wayland system-idle data already resolves to
`{ lastInputAt: null, locked: false }`. In `active` Desktop Ask mode,
`desktopAskDecision` treats this as `ask: true, why: 'unknown'` even when
a previous per-chat grant exists; the shared decision tests verify both cases.
This deliberately does not convert unknown idle state to implicit approval.
Reviewers can decide whether the outstanding real-dialog exercise is required
before merge; this document must not be represented as a blanket security
sign-off for UI consent.
