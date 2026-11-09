# Unattributed request ownership and fleet recovery

Date: 2026-09-18. Source version: 2.1.14.

## Problem and resulting behavior

An unattributed tool call could execute a command successfully while a plan or agent operation
was refused for missing chat identity. The connector's instructions then reinforced the wrong
conclusion that mutation and terminal tools were unavailable. Earlier request-owned ordinary
tool work existed in a separate checkout and was integrated into this working tree before
completing the agent and handoff behavior.

With Allow unattributed calls enabled, the transport's normalized request ID owns its working
directory, pending plan, terminals and provisional worker family. It is not a model-supplied
credential or a fabricated conversation ID. Enabled edits, commands, Desktop and Plugins keep
working under their existing capability and approved-root checks. Identity notices explicitly
separate attribution from permission and tell the caller not to replay successful operations.
The notice is also emitted when no recovery timer is pending.

Terminals and native observations remain isolated by request until exact evidence names their
session. Another request cannot borrow a process or observation just by naming it. Headerless
ordinary calls retain the separate legacy anonymous behavior; they cannot create a request
plan or worker family without an owner ID. Agent messages and finish reports wait for actual
member proof when the request does not already own the addressed family. Session finish still
requires its actual live session.

## Worker recovery

The existing broker now persists request-origin families in snapshot version 7, retaining
version 4/5/6 migration. Exact request correlation and the durable session's current frontend
reattach provisional fleets automatically. Correlation observations, MCP ingress/completion,
and startup after continuation recovery use the same reconciliation operation. No new timer
or alternate identity registry was introduced.

An existing prime may recover several fleets. Their run IDs, worker conversations, reports and
inboxes remain separate. Parked histories use their last incarnation as the map key, so two
histories belonging to one prime cannot overwrite each other. Status exposes available_runs;
run_id selects a family that already belongs to the caller. Ambiguous mutations are refused
without guessing which worker-1 was intended. A parked fleet's revival returns its new run ID
and publishes the browser revival under that same incarnation.

Ordinary prime results collect their fleets' inboxes under one shared output budget and label
duplicate worker names by run. Only messages actually offered can be acknowledged. Spawn state
remains hidden until its durable acceptance barrier succeeds, including when exact identity
arrives during that barrier; a second spawn cannot duplicate the hidden in-flight fleet.

Late proof can reveal that a provisional prime was already a worker. Its accepted fleet is
entrusted to that worker's actual root prime. The worker keeps its role, cannot control the
descendants, and receives its own inbox even when recovery happens inside the current MCP
call. The result carries a specific worker-ownership correction instead of retaining a false
prime identity.

## Handoffs and plans

Compact & Resume transfers all active and parked fleets of the source prime in the same
transaction. Fleets attributed during an already-open handoff join it, including the durable
commit publication gap. Proof arriving after a completed handoff attaches the fleet to the
current replacement chat. The request correlation itself remains historical: old source
requests never acquire the successor's authority. Blocked and superseded callers cannot consume
inboxes, user input or background output through late result delivery.

Pending request plans are durable and bounded to 256 requests/seven days. The existing rebind
commit records per-source retirement times with the session lineage. A saved plan can cross
later handoffs only when its call and saved acceptance both preceded retirement of its source.
A post-handoff source call is rejected, and an older recovered plan cannot replace a newer
successor plan. Direct updates from retired frontends remain refused.

## Verification

Behavioral regressions were observed failing before their fixes: missing request-family
ownership, multiple-fleet and handoff recovery, historical pending-plan attachment, and a
provisional prime retaining its role after exact worker proof. Focused tests exercise these
paths both through the broker and the real local MCP endpoint, including selected-run messages
and revival publication. Repository contracts in AGENTS.md were updated to match.

Final source review reproduced two further boundary failures before fixing them. An exact
prime's unpublished spawn could recurse between the conversation and caller inbox adapters;
it now returns no inbox until acceptance. A request proved between the durable A-to-B rebind
and broker publication could attach its fleet directly to B and block A's remaining fleets as
a collision. It now joins that same open handoff's source projection until all fleets move
together. The four affected broker, MCP inbox and continuation suites passed 254 tests after
these corrections.

The first full verification found schema/instruction budget overruns and assertions that
combined tool output with the newly added notice. Descriptions were shortened within the
existing limits and result assertions now inspect the actual result block. The Plugin test's
caller-aware inbox seam was preserved. Two Windows tests timed out in that full run and passed
unchanged when run individually; no timeout or budget was increased.
The detached-worker maintenance test also used the wall-clock time of closing its tab as a
work timestamp. Its first sweep could therefore cross the actual silence boundary on a busy
machine. It now reads the worker's actual last-work/activation timestamp, matching production
policy; the targeted test and TypeScript check passed.

Final checks completed on 2026-09-18:

- `npm run verify`: exit 0. Main Vitest run: 209 suites passed, four suites skipped;
  5,167 tests passed and 45 skipped. The separate socket/shutdown run passed all six tests.
  TypeScript, public-history privacy, 153 production-package/seven catalog license notices,
  and 730 pinned native source archives/patches passed their checks in that same command.
- `npm run build`: exit 0. Main, preload and renderer production bundles generated. Vite
  reported mixed static/dynamic import chunk-placement warnings; no build step failed.
- `git diff --check`: exit 0. Existing LF/CRLF conversion notices are not whitespace errors.
- The built main bundle contains request-family reconciliation, retirement-aware plan recovery
  and the explicit Unattributed/Read-only notice. Its SHA-256 is
  `f41d9ae636f35f166ece20c2acaca9f14e2d2c5c0da88304f846c0784434502f`.

Local logs: `.tmp/unattributed-verified-20260918.log` and
`.tmp/unattributed-build-20260918.log`; adjacent `.exit` files both contain `0`.
These checks exercised the shared working tree, including unrelated concurrent changes.

## Delivery scope

This is a source implementation in the shared working tree. Unrelated concurrent changes were
preserved. No installer, app restart, extension reload, commit, push or publication was
performed for this task. A successful source build does not establish behavior in the user's
currently running installed app.
