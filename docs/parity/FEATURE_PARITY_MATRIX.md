# Capability parity matrix

Source pins and evidence policy: [UPSTREAM_SOURCES.md](./UPSTREAM_SOURCES.md).

The purpose of this matrix is to make **CoS-native** gaps explicit. External projects are design
references, not target architectures. Existing CoS ownership wins over nominal parity.

## Matrix

| Capability | Status | Current CoS owner | CoS invariant / evidence | Reference concept | Remaining gap and risk | Required verification |
| --- | --- | --- | --- | --- | --- | --- |
| Unified agent/runtime ownership and verification | **partial** | `agents.ts`, request correlation, recorder, durable swarm snapshots | Worker families have exact prime/conversation/incarnation ownership; spawn/message/finish cross durable barriers before publication. | OpenClaw swarm scheduling and Hermes subagent work queues show broader agent-runtime coordination. | CoS ownership is strong for worker families but is not one generic runtime record shared by every background workflow. A second generic state machine would be a regression. | Ownership-conflict tests, restart tests, exact request/conversation attribution, no cross-family adoption. |
| Context composition and cross-session recall | **partial** | `session/prompt.ts`, session store, handoffs, continuation | Project instructions and selected skills are composed into bounded opening prompts; durable history remains owned by the local session, while Compact & Resume carries a stored handoff across ChatGPT chats. | Both references have explicit context/memory composition layers. | CoS has durable history and handoffs, not a general selective recall engine. Any new retrieval must preserve source provenance and prompt budgets. | Deterministic prompt-budget tests, provenance assertions, A→B continuation/restart tests, no unrelated-session leakage. |
| User/project/episodic/working memory | **missing** | No general memory owner; session history is not declared memory | CoS deliberately records session facts but does not silently promote them into durable user memory. | OpenClaw has explicit memory files; Hermes has pluggable memory/context providers. | A large opaque memory store would duplicate session/project truth and risk prompt leakage. Retrieval must be selective and attributable. | Start with read-only retrieval over explicit records; tests for project/user scope, source links, deletion, budget and restart. |
| Reusable/versioned skills | **partial** | `skills.ts`, `skill-github.ts`, `skill-library.ts`, selected-skill prompt injection | Managed skills are bounded, explicit, package-scoped and can carry reviewed GitHub provenance. | OpenClaw gates/overrides SKILL.md sources; Hermes treats skills as a primary extension/learning surface. | CoS does not autonomously rewrite skills after tasks. That is intentional until there is a review/approval transaction with provenance and rollback. | Import/update hash tests, source-boundary tests, explicit approval for generated revisions, rollback/version history before any learning loop. |
| Normalized tool metadata, permission and side-effect model | **partial** | `shared/capabilities.ts`, MCP declarations, sandbox/root checks, command policy | Capability and root checks fail closed; live settings are rechecked at execution. | Reference runtimes expose richer registries/tool availability metadata. | CoS lacks one normalized read-only description of side effects, required roots, attribution and credential class across Core/Desktop/Plugins. Adding metadata must not become new authority. | Projection-only tests first; every tool maps to existing permission owner; unknown tools fail closed; no execution path consults unreviewed labels as permission. |
| Plugins and lifecycle hooks | **partial** | `plugins/manager.ts`, installer/exposure/OAuth, connector refresh | MCP plugins are installed/started through explicit bounded ownership with credentials in secret storage. | Hermes plugins can register tools/hooks; OpenClaw has broader runtime hook/plugin surfaces. | CoS has plugin lifecycle but no general user hook bus for arbitrary before/after events. A hook bus could bypass attribution if it can mutate work. | Begin with read-only lifecycle events; ordering/dedup tests; no hook may widen permissions or invent conversation ownership. |
| Isolated subagents and durable specialist agents | **partial** | `agents.ts`, browser worker placement/wake, durable retained histories | Workers are isolated by exact owner and reusable history; closed tabs do not imply finished work. | Both references support delegated subagents; their schedulers expose broader queues. | CoS workers are ChatGPT-conversation workers, not arbitrary durable specialist services. Generalization must retain exact owner and browser/provider evidence. | Concurrent-family tests, durable restart/wake tests, provider-selection proof, capacity admission without eviction. |
| Dependency-aware task graphs and bounded parallelism | **partial** | staged plans, worker maxWorkers, input/outbox ordering | Independent workers may run concurrently; durable input queues preserve per-owner ordering. | Hermes cron/kanban and OpenClaw swarm scheduling expose richer dependency/work queues. | There is no generic DAG owner joining staged plans and workers. Do not add a second queue beside the outbox/broker. | A graph proposal must map every node to existing input/worker ownership; cycle/refusal tests; dependency completion must be durable before child admission. |
| Durable jobs / scheduler / resumability | **planned** | Specialized Goal/Loop/finish/input durability only | Existing workflows survive restart, but there is no user-owned arbitrary one-shot/recurring job table. | OpenClaw automations and Hermes cron persist schedules and run isolated jobs. | A scheduler is valuable but must reuse existing execution/admission owners and must not manufacture tool authority while the user is absent. | First slice should be one-shot, explicit, durable jobs; restart/idempotency/due-time tests; live capability recheck at run time; cancellation and missed-run policy. |
| MCP discovery, health and credential isolation | **implemented** | `mcp/server.ts`, connection/bridge, secrets, plugin manager, control API projections | Loopback/host/origin/body checks, per-surface tokens, live permissions and secret storage are production owners. | Both references expose gateway/MCP health and discovery concepts. | No parity work is justified merely to rename these owners. Future health fields should project existing state rather than create competing connection state. | Existing admission/security tests plus exact health-projection tests; credentials never enter model-visible diagnostics. |
| Observability, checkpoints and rollback | **partial** | session/activity records, durable transaction barriers, control API, file edit review | CoS records exact activity and uses staged durable commits/rollback in several workflows. | Reference runtimes expose broader work monitors/job history. | There is no universal checkpoint/rollback abstraction, and one would be unsafe for irreversible external effects. | Classify operations as reversible/irreversible before proposing rollback; projection must distinguish observed, committed and ambiguous effects. |
| Provider/model abstraction | **partial** | ChatGPT browser transport plus OpenRouter/custom Goal/Loop provider paths | Model choices are validated from observed/provider metadata; credentials remain main-process-owned. | Hermes is broadly provider-agnostic; OpenClaw has provider runtime abstractions. | CoS's primary product is still ChatGPT-browser execution. A generic provider layer must not erase browser-native identity or pretend provider messages share the same evidence. | Provider-specific identity tests; explicit capability matrices; no fallback from failed browser proof to API proof without a user-visible contract. |
| Multi-platform messaging gateway | **not applicable** | None | CoS is a desktop bridge for ChatGPT plus local connectors; it does not currently promise a Telegram/Discord-style messaging hub. | Hermes/OpenClaw operate broad messaging gateways. | Copying adapters for parity would expand product/security surface without a demonstrated CoS workflow. Revisit only for a concrete roadmap use case. | New surface requires threat model, identity mapping, credential isolation and an end-to-end owner before implementation. |
| Autonomous core-code self-modification | **rejected** | Reviewed repository changes; managed skills/config are separate | Issue #208 explicitly requires reviewed skills/memory/config or explicit code changes rather than uncontrolled core mutation. | Some agent systems emphasize self-improvement loops. | Runtime mutation of trusted core code would bypass review, provenance and rollback boundaries. | Not a test target: retain the prohibition. Any learning feature must publish reviewable data/skill revisions instead. |

## Issue-ready follow-up units

These are deliberately small enough to review independently. They are **not** new state-machine
owners unless the invariant below explicitly requires one. Separate GitHub issues can be opened
after this audit is accepted; keeping them here first avoids creating a speculative issue backlog.

### P1 — Read-only tool-effect registry projection

**Goal:** describe each existing tool's current permission owner, filesystem-root requirement,
credential class, attribution requirement and coarse side-effect class.

**Invariant:** metadata is a projection only. Unknown/unclassified tools fail closed and metadata
never grants execution.

**Minimum verification:** complete-catalog test; every published tool maps to an existing
capability/permission owner; a new tool without classification fails the registry check; changing
metadata cannot make a denied call succeed.

### P2 — Read-only lifecycle event stream

**Goal:** expose bounded events for already-owned transitions such as request admitted, tool
started/settled, worker state changed, input committed and plugin connected/disconnected.

**Invariant:** events observe existing owners; they cannot acknowledge work, trigger retries or
change permissions.

**Minimum verification:** deterministic ordering, bounded retention, restart behavior where
appropriate, no duplicate authority and no credential/tool-body leakage.

### P3 — Provenance-bounded memory retrieval

**Goal:** retrieve a small set of explicit durable facts from user/project/session sources without
injecting the whole store.

**Invariant:** every returned memory item names its source scope and revision; deletion/revocation
at the source removes retrieval authority.

**Minimum verification:** user/project isolation, source deletion, bounded token/row count,
deterministic ranking inputs, no cross-session leakage and no background write without explicit
reviewed ownership.

### P4 — Dependency-aware plan admission on existing owners

**Goal:** allow a staged plan to express dependencies while retaining the outbox/broker as the
actual delivery and worker-admission owners.

**Invariant:** dependency completion must be durable before a dependent node can be admitted;
independent nodes may run concurrently within existing worker limits.

**Minimum verification:** cycle rejection, crash/restart between parent completion and child
admission, cancellation propagation, duplicate completion, and no second delivery queue.

### P5 — Durable one-shot job record

**Goal:** first scheduler slice: an explicitly created one-shot job with a due time and one existing
CoS action/input target.

**Invariant:** scheduling is not standing tool permission. At fire time the job rechecks live
capabilities, project/root ownership and target identity.

**Minimum verification:** restart before/after due time, exactly-once admission, cancel/edit race,
clock skew bounds, unavailable target, permission revoked before fire, and ambiguous external
effect remains ambiguous rather than retried.

### P6 — Provider capability projection

**Goal:** describe which execution identities, reasoning levels and features are proven for the
currently selected browser/API provider without pretending the transports are interchangeable.

**Invariant:** browser evidence and API evidence remain distinct; no fallback silently changes the
execution owner.

**Minimum verification:** stale catalogue, provider switch, missing credential, unavailable model,
browser selection mismatch and exact recorded provider identity.

## Decisions from this audit

- Extend an existing CoS owner before adding a watcher, queue, scheduler or durable file.
- Prefer read-only projections before action surfaces.
- Treat memory as bounded retrieval with provenance, not as automatic prompt accumulation.
- Keep reviewed skill revisions separate from trusted core code.
- Do not pursue messaging-gateway parity without a concrete CoS workflow.
- Do not use external feature count as a release criterion. The verification target is the CoS
  invariant in each row.
