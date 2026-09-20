# Shell request attribution and worker messaging, 20 September 2026

This follow-up addresses the new native-shell evidence for issue #311. It extends
the adapter originally contributed by @ehkogh in #318 and uses @redzrush101's
additional private captures and transport retests. The publication branch starts
from public main `04c6a298`; it excludes the shared checkout's private ancestry,
reporter exports, and unrelated local shutdown, translation and usage changes.

## Evidence and failure boundaries

The latest saved worker page contains three exchanges: an initial assignment, a
follow-up, and a wake instruction. Their displayed replies report that direct
`agents message` and `agents finish` could not identify an agent family. This
supports separating browser delivery from outgoing MCP request attribution. A
captured final report reaching the prime is not proof of direct two-way messaging.

The captures were parsed as inert data. Their inline application/session material
was not executed, published or copied into fixtures. The Default NetLog contains
network metadata but not the complete application payloads needed to independently
reconstruct request ownership. The reported intermittent success rate is not a
measurement made by this investigation. No live session ledger was edited.

## Changes

1. A witnessed native Send can trigger the first shell scan without an app-managed
   Send promise. Shell slots do not expose provider message IDs until that scan.
   The existing receipt is rechecked after the scan and consumed once; no new
   poller, reload policy, or guessed conversation identity is introduced.
2. A provisional shell exchange can expose its exact live mapping before the
   local/server conversation relation hydrates. It now carries
   `requestOwnerRequired`. Both correlation and tool-evidence publication require
   the existing exact owner confirmation. An unrelated mounted provisional
   exchange without a Send or accepted Resume owner cannot borrow the route.
3. A typed MCP item can retain its original `callId` while its selected source is
   replaced by the result. The reader validates that explicit invocation/result
   relation, connector, tool and nonconflicting metadata before extracting IDs.
   A mounted native `dynamic-tool-call` for `functions.exec` likewise permits
   reading the named invocation's request metadata, never its code or an invented
   result receipt.
4. Late prime attribution fills an already-recorded worker's missing parent
   session before publishing the family attachment. Active and sleeping workers
   keep their history, reports, titles and task text. Existing parents are not
   overwritten, and the recorder publishes its normal change notification.
5. The current shell keeps a marked prompt and its running response in one
   exchange. Resume handling retains that exact relation before the final exists.
   Editor readiness waits for writable state before native insertion, including
   after model selection. Failed insertion retains its concrete predicate.

The public-preamble and native status-row repairs already present locally are
included with their regressions. Only explicitly public commentary is retained;
private analysis and other hidden message classes remain excluded. Helper,
recorder and restoration versions are all **20**. App and extension release
labels remain **2.1.14**, so the commit and matched companion matter.

## Regression and real-browser verification

The added native-Send and source-boundary regressions failed before their repairs.
The initial focused run then passed 235 tests. After the version synchronization,
the expanded recorder, bridge and agent run passed 1,498 tests. These are checks
of the shared source before the separate public candidate's final verification.

`test/shell-agent-roundtrip.test.ts` exercises production page-helper and isolated
recorder code through the actual request registry and HTTP MCP handlers. It
checks prime-to-worker delivery, acknowledgment on the next invocation, the
worker's direct reply, explicit finish, subsequent wake under a new request,
exactly-once recorded deliveries, and refusal of an unrelated caller. Chrome
transport and the bootstrap receipt are simulated; this is not a signed-in
affected-account acceptance test.

The Chromium fixture initially stopped on a cached request-origin replay from
its earlier stream-observer case. Its diagnostic showed that replay rather than
the native Send's request. The check now waits for the exact expected request
and verifies its turn-owned tool evidence. All 14 native Chromium checks passed,
including cold picker hydration, literal insertion, three Send/final receipts,
paired sources, native manual Send and Code Mode metadata.

The only signed-in tab available for inspection was the current protected coding
conversation. It was inspected without changing it. No claim is made that this
session reproduced the reporter's Brave/NixOS account or measured its success
rate after installing this revision.

## Publication gate

The isolated public candidate must pass full verification, production build,
native Chromium checks and the public-history/privacy guard. Its PR must pass
all required Windows, macOS and Linux checks before merge; the merged commit's
CI is checked separately. Publication receipts retain the exact commits and
results. Source verification does not imply installation or a new binary release.

## Public-candidate results

Full `npm run verify` exited 0 on the isolated publication candidate: 5,716 tests
passed and 45 opt-in/platform tests skipped in the main run, followed by all six
separately executed MCP shutdown tests passing. Total: **5,722 passed, 45 skipped**.
The dependency/resource checks, notices, typechecking and Electron resolution
within that command passed. The new worker round-trip test is included in this run.

`npm run build`, all 14 checks in `node scripts/verify-shell-runtime.cjs`,
`git diff --cached --check` and the staged public-history/privacy guard also
passed. The Chromium fixture uses native browser APIs and synthetic provider
objects; the reporter's account remains a separate retest boundary.

The only change after those runtime checks is this results paragraph. Commit,
PR and post-merge CI receipts are retained separately so the document does not
claim publication before it occurs.
