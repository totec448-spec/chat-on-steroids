# Capability parity audit sources

Audit date: **2026-10-02**.

This audit is a discovery document for roadmap #482 / the first slice described in #208. It is
not a claim that Chat On Steroids should clone OpenClaw or Hermes Agent, and it does not treat
matching feature names as behavioral parity.

## Exact revisions

| System | Revision | Commit time (UTC) | Role in this audit |
| --- | --- | --- | --- |
| Chat On Steroids | [`e45f95bbfab0768e63e307b91684bb241b9038e7`](https://github.com/totec448-spec/chat-on-steroids/commit/e45f95bbfab0768e63e307b91684bb241b9038e7) | 2026-10-02 16:16:32 | Current CoS owners and invariants |
| OpenClaw | [`af0390499c073d4b6b9410f08b59fa4026a151a2`](https://github.com/openclaw/openclaw/commit/af0390499c073d4b6b9410f08b59fa4026a151a2) | 2026-10-02 16:44:41 | Reference concepts for skills, memory, automations and agent scheduling |
| Hermes Agent | [`54bc5e509c985f37265c3d416bd2c64b10fc77ba`](https://github.com/NousResearch/hermes-agent/commit/54bc5e509c985f37265c3d416bd2c64b10fc77ba) | 2026-10-02 16:29:16 | Reference concepts for memory/context plugins, skills, subagents and cron |

The external projects move quickly. A later audit must pin new revisions rather than silently
treating their current default branches as equivalent to the revisions above.

## Evidence policy

A capability is classified from implementation/docs at the pinned revisions and from CoS's current
owner paths. Marketing copy is not sufficient evidence by itself. The matrix distinguishes:

- **implemented** — the required CoS behavior has a production owner and verification coverage;
- **partial** — useful primitives exist, but the broader capability or invariant is not complete;
- **missing** — no CoS owner implements the capability;
- **planned** — the roadmap already names the capability but production ownership is absent;
- **not applicable** — copying the external concept would not serve CoS's product boundary;
- **rejected** — the concept conflicts with a stated CoS security/architecture invariant.

This is a source audit, not a live cross-product conformance run. “Implemented” therefore means
the CoS side has a concrete production owner and tests; it does not imply identical behavior to an
external project.

## CoS source owners reviewed

- `src/main/agents.ts` — prime-owned worker families, durable spawn/message/finish barriers,
  retained worker histories and exact conversation ownership.
- `src/main/durable.ts` — named atomic durable state with per-file serialization/retry.
- `src/main/session/store.ts`, `session/prompt.ts`, `session/continuation.ts` — durable local
  session identity, bounded prompt composition and exact chat-to-chat continuation.
- `src/main/skills.ts`, `skill-github.ts`, `session/skill-prompt.ts` — bounded managed skills,
  explicit GitHub import/update and selected-skill prompt injection.
- `src/main/plugins/manager.ts` and `src/main/plugins/*` — installed MCP/plugin lifecycle,
  OAuth/secrets, discovery and exposure.
- `src/main/mcp/server.ts`, `mcp/call-context.ts`, `src/shared/capabilities.ts` — connector
  admission, live permissions, request ownership and fail-closed capability boundaries.
- `src/main/control-api.ts`, `control-reads.ts`, `control-actions.ts` — opt-in loopback
  observability/actions projected from existing owners.
- `src/main/runtime-gc.ts` — evidence-based process retention cleanup, not agent liveness.
- `src/main/goal.ts`, `session/finish.ts`, `session/input.ts` — specialized durable
  continuation/Goal/Loop workflows.

## OpenClaw sources reviewed

At the pinned OpenClaw revision:

- `docs/tools/skills.md` — SKILL.md loading, precedence, gating and allowlists.
- `docs/concepts/system-prompt.md` — configured prompt composition, runtime context and skill
  injection.
- `docs/concepts/memory.md` — explicit workspace memory files and bounded session loading.
- `docs/automation/cron-jobs.md` — persisted automations, scheduler, delivery and run history.
- `src/agents/subagents/swarm/swarm-scheduler.ts` — bounded queued swarm launch/capacity ownership.

These are reference designs only. CoS keeps its own browser/session identity, filesystem permission
and durable transaction model.

## Hermes Agent sources reviewed

At the pinned Hermes revision:

- `AGENTS.md` — narrow-core architecture; memory, skills, subagents, scheduled jobs and plugin
  extension principles.
- `agent/AGENTS.md` — AIAgent composition, provider/runtime inputs, context and memory controls.
- `cron/AGENTS.md` — persisted cron jobs, scheduler hardening, skills/model/workdir fields and
  delivery.
- `website/docs/developer-guide/architecture.md` — session store, gateway, plugin, memory/context,
  tool registry and execution-surface map.
- `website/docs/user-guide/features/cron.md` — user/agent cron behavior and scheduler semantics.

## Re-audit rule

Update this file and the matrix together when an external revision materially changes a compared
capability. A new source pin is evidence for a new audit; it must not retroactively rewrite what
the older pin contained.
