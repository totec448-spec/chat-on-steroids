# RFC: Web Local first, private browser remote access later

Status: **Design proposal for discussion. No implementation in this PR.**

Tracks: #1956. Related: #1934, #1932, #1324, #482, #1794, #1148.

## Problem and desired outcome

CoS is useful for long-running chat, tool and worker workflows, but the full
Desktop experience is not available in an ordinary browser on the same PC.
Monitoring notifications or opening a remote desktop is not the same as using
the native CoS sessions and controls through a browser.

The requested end state is:

1. **Web Local first:** an explicitly opened browser UI on the computer where
   CoS Desktop is running, connected to that same app's authoritative services,
   sessions, state and permission decisions.
2. **Functional parity:** all relevant Desktop operations are reachable through
   browser-safe UI and command semantics; native-only dialogs have explicit
   alternatives or remain honestly gated until safe.
3. **Private remote later:** a phone or laptop reaches that same CoS backend
   through a tailnet-only Tailscale transport, after local parity and separate
   remote authorization/acceptance have been demonstrated.

Telegram notifications and lightweight approvals remain the separate,
Telegram-first direction in #1934. Web Local is a complementary full UI,
not an expansion of that bot or a replacement for it.

## Constraints and non-goals

- The running CoS main process retains ownership of application state,
  sessions, queueing, worker orchestration and irreversible actions.
- No second agent backend, duplicate durable session store or independent
  control-plane authority for the browser.
- Do not serve Electron `window.api`, generic IPC handlers, arbitrary filesystem
  routes or a Control API bearer token to browser JavaScript.
- A browser-read route must not repair, flush or mutate persisted state as an
  undocumented side effect. Incomplete cache coverage is NOT_READY, not proof
  that no chat/history exists.
- Preserve existing Trust/Block, app ownership, approved roots, run/project
  scopes and provider safety/consent boundaries on every surface.
- A private network is **not** a substitute for application authentication
  and authorization. No public listener, Tailscale Funnel, forced network
  configuration or unrestricted LAN access.
- This RFC does not ship a native iOS/Android app, a standalone headless
  daemon, a new public API stability guarantee, or the stale experimental PoC.

## Architecture alternatives

| Option | Load-bearing assumption | First failure condition |
| --- | --- | --- |
| **A. Recommended:** a narrow typed query/command capability seam inside CoS main, with Desktop IPC and Web as adapters. Keep Web Local loopback-only; add separately authorized Tailscale transport later. | Existing service owners can expose browser-safe operations incrementally without changing their authority or duplicating their state. | Native-only workflows require generic IPC/renderer authority, or command receipts cannot be reconciled safely. |
| **B. Dedicated Web-specific controllers calling owner functions directly.** No new common seam initially. | The browser's operations are few and independent of Desktop orchestration. | The expected full-parity operation count grows and permissions, errors, history and replay semantics drift from Desktop. |
| **C. Extract CoS into a standalone headless daemon first; make Desktop and Web clients.** | Electron/native lifecycle and durable ownership can be separated without regressions. | Broad refactoring becomes a prerequisite and delays any real Web Local capability or breaks existing recovery. |

Option A is the better fit for the current constraints: it shares authoritative
behavior while keeping network identity and UI rendering replaceable. It has
real extraction cost, and its underlying owner-seam assumption must be tested
against current `main` before implementation. The recommended solution is
not a license to invent a large generic message broker in advance: add only
the typed capabilities a proved end-to-end operation requires.

## Proposed boundaries

```text
Desktop renderer -> named, owner-checked native IPC ----+
                                                        |
Browser on host -> local Web adapter (loopback) --------+--> CoS main
                                                        |    authoritative
Remote paired browser -> private Tailscale transport ---+    service owners
                                  (later, gated)              |
                                                        durable state
```

The diagram expresses the desired **logical** ownership, not a ready-made
network topology. In particular, do not simply proxy a loopback activation URL
to remote clients: local Host/Origin, cookie scope and remote principal
verification require their own reviewed contracts.

### Read/query and event contract

Owner-side snapshots should be passive. Session detail and timeline readers
must distinguish fully cached, partially cached and not-ready/needs-repair
content. For cold retained history, a store-owned inspection mode must not
silently repair metadata or flush changes during browser GET requests.

Events/streaming should be bounded, redacted and explicitly scoped. Use owner
sequence/cursors, reconnect gap detection, backpressure and cancellation.
Do not expose prompts, private paths, arbitrary tool arguments/results, bearer
tokens or provider identifiers by default just because Desktop can read them.
An incomplete or stale stream cannot be presented as current truth.

### Mutation and receipt contract

Each operation maps to:

```text
Desktop action -> authoritative service owner -> input schema
               -> capability + identity check -> side effect
               -> durable receipt + failure/UNKNOWN semantics
               -> browser presentation + regression tests
```

Send/new chat and worker spawn/message require stable caller intent IDs,
authoritative host input/broker receipts and reconciliation after lost
responses, restart, reload or reconnect. **UNKNOWN does not authorize a
blind resend.** Stop/Cancel/ACK must target the exact owned turn, input or
broker receipt, not a broad session-wide interruption. A late authorization
or an earlier host generation cannot approve a different action.

### Browser authentication, authorization and resource limits

The proposed local bootstrap is explicit native-owner activation, a
short-lived one-time ticket and a host-scoped, HttpOnly session, with Host,
Origin, fetch-metadata and CSRF defenses applied to the appropriate methods.
Session expiry, logout, concurrent tabs, repeated opens, local process
boundaries and shutdown must have deterministic behavior.

Apply bounded request/response bodies, read concurrency and in-flight
admission, stream limits, cancellation where possible, backpressure and
bounded shutdown. An HTTP read deadline alone does not cancel underlying
owner work.

For remote access, require separate device/user identity binding, revocation,
per-operation permissions and audit traces, in addition to Tailscale's
private networking/ACLs. Remote `Allow`, terminal/filesystem writes and
other high-impact actions need a separately accepted step-up/local-confirmation
policy. Follow the remote-consent concerns raised around #1148 and #1934.

## UI and functional-parity matrix

The UI target is CoS Desktop's information architecture, navigation,
sidebar/Projects/Chats, timeline, composer, model/tools/status and settings
with browser-safe adaptation and responsive phone interactions. Reuse
components, styles and view models when possible, but do not count a
visually similar fixture as genuine backend parity.

| Domain | Expected browser capabilities | Main gate |
| --- | --- | --- |
| Chats and sessions | Real list/detail/timeline, resume, new chat, streaming, model/context | Pure snapshots, authoritative IDs and event coverage |
| Composer and control | Send, queue, exact-turn Stop/Cancel, attachments | Durable intent/receipt, owner checks, no duplicate work |
| Projects | Hierarchy, selection, relevant create/move/edit operations | Project authority and path/permission redaction |
| Workers and agents | Status, spawn, message, ACK, Prime/worker lifecycle | Run ownership, broker receipts and replay safety |
| Goal/Loop/automation | Observe, configure, pause/resume, permitted execution controls | Existing owner policies and explicit transitions |
| Plugins and Skills | Inspect/configure/operate within approved scopes | Trust/Block, capability and installation constraints |
| Settings and diagnostics | Accurate settings, connection/usage/activity state | Secret filtering and write authorization |
| Files, Git and terminal | Approved-root browsing and authorized operations | Exact workspace/host gates and higher-risk confirmation |
| Browser/companion and OS UI | Browser-safe controls, truthful unsupported states | Native-only substitutes and ownership preservation |

Every operation needs its own `owner -> authority -> schema -> receipt ->
failure semantics -> UI -> tests` entry before it is labeled supported.
Full parity is a product goal, **not** a status claimed by this RFC.

## Milestone/acceptance gates

**M0 — RFC agreement and inventory:** maintainer decisions on the owner seam,
UI-reuse strategy, native-only alternatives, operation matrix and security
model. Keep the implementation split into small, focused code PRs.

**M1 — real local reads:** passive models/projects/workers and session detail
and timeline, coverage-aware cold-history behavior, bounded/redacted streams,
read-only browser E2E against an actual installed CoS process.

**M2 — local durable actions:** Send/new chat/Stop/Cancel, worker messages and
ACK with exact identity/receipt semantics; concurrency, crash/reload and
ambiguous-response tests without duplicate dispatch.

**M3 — remaining local functional parity:** Projects, Goal/Loop,
Plugins/Skills, Settings, Files/Git, terminal, companion/browser and
native-specific alternatives; keyboard, accessibility and mobile viewport
acceptance.

**M4 — local installed acceptance:** source/test/build/package/installed
identities align; approved install path; signed-in real desktop/session
integration, no simulated fixtures as proof; supported-platform and security
checks complete.

**M5 — private remote authorization/design:** Tailscale transport selection,
app-level device pairing/permissions/revocation, stream/upload semantics and
sensitive-action confirmation. No remote enablement before local gates.

**M6 — private remote acceptance:** real phone/laptop sessions over tailnet
(including network loss and reconnect), no replay duplicates, correct
ownership, explicit access revocation and no public exposure.

No calendar estimate or completion claim is implied by these milestones.

## Existing experimental progress — not part of this PR

At the 2026-10-31 checkpoint, a separate **uncommitted** PoC worktree was
based on `be61baf`, more than 700 commits behind the freshly fetched
`upstream/main` at `fe58e3e`. Its limited read-only source integrates a
native open action, loopback listener, one-time activation, scoped HttpOnly
cookie, GET allowlist and native-shaped browser shell for status, Projects,
cached session summaries and minimal workers/models.

Recorded source-only checks included 71/71 Node tests, 1/1 owner-integration
Vitest, focused main/preload TypeScript and focused Vite bundling. A later
fail-first lifecycle repair passed focused 2/2 and adjacent 3/3 tests.
The full affected TypeScript gate was not green (including missing `katex`
TS2307 and test typings). Source review also identified owner-read purity,
in-flight work admission and activation-edge cases that require further
attention.

**Unverified:** source compatibility with current main, signed packaging,
installed EXE/app.asar identity, live Web-to-CoS data/commands, complete
functional parity, privileged Tailscale remote identity and phone acceptance.
An earlier synthetic Tailscale fixture is not this implementation. Nothing
from that old PoC is included or proposed for merging in this docs-only PR.

## Open maintainer decisions

1. Is this a separate Web Local track alongside #482 and Telegram #1934?
2. Which existing CoS service owners and internal contracts should be the
   initial query/command seam? Could an owner adapter be introduced narrowly,
   without adding a new independently authorized controller?
3. Should the browser share extracted Desktop UI/state components or build a
   small dedicated shell? What constitutes acceptable visual/functional
   parity on mobile?
4. What is the minimum safe event/receipt contract for concurrent tabs,
   network loss and the pending Send/worker identity?
5. Which high-impact actions need explicit local confirmation or remain
   desktop-only pending remote-security decisions?
6. Should Tailscale setup remain user-managed, with CoS owning only
   app-specific pairing/authorization? Which OSes/browsers form the first
   acceptance matrix?

This RFC seeks agreement on **boundaries and acceptance criteria**. A future
implementation PR must stand on current source, include its own fail-first
tests, full relevant checks, and real installed/live evidence. Neither the
RFC nor a draft PR is permission to deploy remote control.
