# cos-agents

Prime-owned worker families (unit E2.6). It ports the broker of `src/main/agents.ts`, the
`agents` tool of `src/main/mcp/tools-core.ts` and `shared/worker-brief.ts`. `cos-core` builds
one [`Agents`] owner. The kernel serves its tool on Core while multi-agent mode is on, the
control API projects its snapshot as `/v1/agents`, and startup restore reads its ledgers
behind the admission fence.

## State and its one writer

`Agents` is the only writer of the broker, `state/swarm.json` (version 7) and
`state/retired-workers.json`.

- A mutation that a model is told about (`spawn`, `message`, `finish`) goes through
  `Agents::accept`. The owner runs the operation on a copy of the broker, writes the copy's
  snapshot with `write_now`, and then makes the copy the live state. A refused operation or a
  failed write leaves nothing behind. No reader ever sees a revision that the disk has not
  accepted. This replaces the TypeScript staged overlays (`unpublishedAgents`,
  `activeSpawnStages`, `activeFinishStages`) and their rollback paths.
- Browser observations and delivery telemetry (`bind_conversation`, offers and
  acknowledgements, revival claims, sleeps and failures) go through `Agents::update`. They
  change the live broker and queue a coalesced write, as `changed()` does.
- When an operation changes the retired-worker fences, they are written first. An extra fence
  is a temporary refusal. A missing fence is unintended authority.
- `Agents::watch` publishes `SwarmState` after every change.

`Broker` holds no IO, no clock and no lock. Every operation takes the `Policy` that it runs
under, built once from the config snapshot, and the time.

## The tool

`agents` takes four actions: `spawn`, `message`, `status` and `finish`. The caller is the
kernel's attribution, never a model argument. `Tool::refine` ports the schema's
`superRefine`, which allows each field for one action only. The corpus cases
`multi-agent/mcp/core/calls/01` to `06` replay through the real kernel in `tests/golden.rs`.
The prose and the `structuredContent` of every answer are ported verbatim.

## Restore

`restore` reads both files as plain JSON and repairs them the way `restoreSwarm` and
`deserializeAgents` do. It handles these cases:

- A bound worker that is still `invited` becomes `active`.
- A `finished` row that is still revivable is no longer revivable.
- A worker that is `waking` but has no chat goes back to sleep.
- A sleeper that cannot be woken becomes `finished`.
- A malformed model or reasoning value becomes the default.
- A run id that is not a full version 4 UUID gets a new one.
- When two families claim the same conversation, both lose it.
- Parked history older than a week, or beyond the newest sixteen families, is dropped.
- A family with no worker that holds a slot is parked.

When the restored state differs from the file, it is written back. When the feature is off,
everything is parked, as `pauseSwarmForDisable` does. Workers that still need a tab or a
revival are requested again.

## Worktrees

`worktrees::Worktrees` ports the lease manager of `main/worktrees/index.ts`. One proven
broker identity gets one deterministic slot below an approved parent of the repository:
`.chat-on-steroids-worktrees/<repo key>/<run id>/<worker-N>/`. The slot holds `tree`, the
worktree on branch `cos/worktrees/<run>/<worker-N>`, `hooks`, an empty hooks folder that Git
uses instead of the repository's own, and `owner.json`, the marker. The marker is written with
`create_new`, so only one allocation can claim a slot.

A lease is valid only when all of these hold:

- The marker matches the slot.
- The branch and the Git common directory are unchanged.
- The worktree and the project folder are the same directories. Their `dev:ino` identity
  must match, so a copied or swapped folder fails.

`validate` checks these again at a privileged boundary and drops a lease that fails. At
startup, `Agents::restore` passes the broker's `managed_recovery_identities()` to `restore`.
Only checkouts that the durable broker still owns are read from disk. When two slots claim
the same identity, neither is restored. `remove` deletes the checkout and its marker. It keeps
the branch and its commits. It refuses a checkout with local changes unless
`discard_changes` is set. The marker format is the TypeScript one, so either build can read a
slot that the other made. The tests in `tests/worktrees.rs` run real Git in scratch
repositories under the checkout's `.tmp/` folder.

## Ports

- `WorkerBrowser` opens worker chats (`bootstrap`) and reopens sleeping ones (`revive`). It
  is called only after the revision that needs the tab is durable. `cos-core` passes
  `NoWorkerBrowser` until the bridge's worker and revive commands exist (see below).
- `Agents::ownership()` is a synchronous snapshot of every worker chat and the family that
  owns it (`isWorkerConversation`, `workerPrimeOwner`), replaced after every change. It is
  for the policy ports that answer without awaiting the broker.
- `ObservedModels` is the account's model catalog. `cos-core` reads it from the companion's
  `ChatModels`.

## Accepted deviations

- A refused spawn or message to a parked family leaves that family exactly as it was. In this
  case TypeScript parks the family again under the new incarnation id that it gave the family
  to stage the operation.
- A Settings default model that is a display label is not resolved to its family
  (`resolveChatModel`). Only exact ids and aliases match the observed catalog.
- One operation reads the clock once. TypeScript reads `Date.now()` at each step.

## Not ported yet

- Inbox delivery on every tool result (`withInbox`), the acknowledgement at the start of the
  next call, and the quiescent-run release after it (`kernel.ts` `dispatch`). These need a
  kernel port in `cos-tools`. The proposal is in the unit report. The broker side is ready:
  `offer_for_caller`, `acknowledge_for_caller` and `release_quiescent_run`.
- Liveness from tool calls (`noteAgentAlive`), detach and silence sleeps, page-generating
  holds, silent-ceiling recovery, the prime transfer for Compact & Resume (E2.5), and
  request-owner reconciliation (`reconcileAgentRequestOwners`, which needs session lookups).
- Worker fences on ordinary tools (`endedWorkerNotice`, `dormantWorkerNotice`, retired
  leases in the kernel).
- The worker bootstrap and revival browser commands in `cos-input`. `cos-input` still
  retires those rows at restore.
- Workspace inheritance (`inheritWorkspace`, `bindAgentWorkspace`), and allocating worker
  worktrees at spawn, which needs the prime's workspace. With `autoWorktrees` on, a spawn
  says that no workspace is selected. Cleanup previews and their content fingerprint
  (`listOfferedWorkerWorktrees`, `disposeOfferedWorkerWorktree`), worker diffs, and branch
  deletion are not ported.
- `recordAgentMessage`, which files sent and delivered agent messages into sessions.
