# Unattributed capability and late-ownership audit

Date: 2026-09-20. Reviewed the shared, already dirty 2.1.14 working tree. This task changes only this report.

## Result

The reviewed implementation permits enabled ordinary tools, request-owned plans, terminals and provisional worker families before exact conversation attribution. Exact request proof subsequently attaches their ownership without replaying the work. No implementation failure was reproduced in the tested ownership transitions.

There is a separate observed tool-contract gap in this ChatGPT conversation: the supplied direct `agents` schema has no `run_id` parameter. Both the current source and the installed main bundle contain that parameter and require it when several recovered families belong to one prime. Thus the direct tool contract supplied to this conversation is older/different from the implemented contract. A successful local HTTP test does not prove that this host-supplied direct schema can select a family. Refreshing/re-discovering the connector contract and checking for `run_id` is the relevant remaining integration check when Multi-Agent is enabled; this audit did not change connection settings.

## Verified behavior

- `src/main/mcp/kernel.ts` applies the same ordinary capability/root checks and preserves exact blocked, retired and superseded restrictions. The opt-in relaxes unknown identity, not those positive restrictions.
- `src/main/session/correlation.ts` accepts the transport request ID joined to native page evidence. Existing conversation/session ownership wins over a conflicting later observation. Neither tool name nor the selected browser tab establishes ownership.
- `src/main/session/request-plans.ts`, `mcp/plan-tool.ts` and `session/store.ts:2676` serialize pending plans and attachment. They retain the newest accepted document, survive restart, and reject older recovery that would replace a successor's newer plan. Pending request plans are bounded to 256 requests/seven days.
- `src/main/codex/ownership.ts` treats a request principal and its subsequently proven durable session as equivalent. Retained command output and an existing process ID can be used after attribution without re-executing the command. Another unresolved request cannot adopt them by knowing the number.
- `src/main/workspace.ts` learns the working directory from approved absolute paths and aliases that state after proof. Request-scoped workers inherit that learned directory. Unknown identity does not prove the selected session's explicit project association; a fresh unresolved request may still need an absolute path.
- `src/main/agents.ts:633` attaches provisional families through the proven session and its current conversation. Families survive snapshots, parked histories, delayed proof and Compact & Resume. A provisional caller later identified as a worker retains its actual worker role; already accepted descendants are entrusted to its real prime.
- Families are not flattened or renumbered. `worker-1` in family A and `worker-1` in family B remain distinct. `agents status` exposes `available_runs`, and `run_id` selects an already owned family. Ambiguous messages are refused before dispatch. Waking a parked family returns its new run incarnation while preserving its worker conversation.
- Real local MCP tests cover provisional spawning, workspace inheritance, worker report delivery/acknowledgement, outsider isolation, delayed attachment beside an existing family, selected-family messaging and revival. Browser launch/provider execution remains a separate evidence level.

## Intentional limits

The opt-in cannot identify which existing session, turn or prior worker family an entirely different unresolved request belongs to. Until proof arrives, existing-chat input injection, `session_finish`, and operations on somebody else's already owned terminal/family cannot guess their target. Headerless calls lack the request key needed for a provisional plan/family. Disabled capabilities remain disabled. Child OS processes do not survive an app restart merely because ownership metadata can survive it.

Worker concurrency is accounted per family. Recovering several independently accepted families retains those families; it does not collapse their workers into one newly numbered pool.

## Local runtime evidence

The current saved settings have `readOnly: false`, `multiAgent.allowUnattributedCalls: true`, `multiAgent.enabled: false` and `multiAgent.maxWorkers: 1`. Multi-Agent being absent from the live code-mode tool catalog is therefore expected. No setting was changed and no real worker was spawned.

The installed `resources/app.asar` declares version 2.1.14. Its main bundle contains `primeRequestId`, `RUN_SELECTION_REQUIRED`, the `run_id` schema description, request-plan acknowledgement and request principal support. Main bundle SHA-256:

`3f96727c93f327337660c1ac73be4b1e0cd8fc15718d2ee3335d177be10a50a2`

This checks installed bytes for the reviewed mechanisms, not whole-file equality with today's dirty source.

The current app log shows this audit's request first filing `update_plan`, reads and commands as Unattributed from 10:30:13 UTC. Exact proof arrives at 10:31:19.031 UTC, followed at 10:31:19.309 UTC by repair of nine calls with zero left unknown in that bucket. The audit's uniquely named plan is present under the corresponding real session. These are 12:30:13 and 12:31:19 Europe/Berlin on September 20.

One of this audit's commands completed before exact attribution. After attribution, its original terminal ID was read through `write_stdin` inside code mode and returned `isError: false`, `output_replayed: true`, `exit_code: 0`. No command was rerun to obtain this evidence.

Other September 20 log episodes also repair their delayed calls. The retained older log contains worker identity refusals from September 14–15; those predate the request-family implementation and are not evidence of a current regression. The inspected logs do not supply a real provisional-worker spawn/recovery demonstration for the current configuration.

## Fresh validation

Both commands finished with exit 0, using the repository's isolated test ports and temporary test state:

```text
npm test -- test/request-agent-ownership.test.ts test/agent-plan.test.ts test/workspace.test.ts test/kernel-run-inbox.test.ts test/code-mode-mcp.test.ts test/kernel-identity-recovery.test.ts test/kernel-desktop-identity.test.ts test/tools-browser.test.ts test/correlation.test.ts test/attribution-repair.test.ts test/exec-completed-results.test.ts test/exec-result-delivery.test.ts
12 suites, 133 tests passed.

npm test -- test/agents.test.ts test/swarm.test.ts test/agent-communication.test.ts test/browser-control.test.ts
4 suites, 189 tests passed.
```

Total: 16 suites, 322 tests passed. No production code was changed; no new build, installer, restart, extension reload, commit, push or release was performed. Live provider execution of a recovered worker family and the corrected direct host schema remain unverified.
