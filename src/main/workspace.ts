/**
 * The folder a chat is currently working in, so it can stop spelling out full paths.
 *
 * A coding session spends its whole life inside one project, and every call was repeating
 * the same prefix: `/project/chat-on-steroids/src/main/patch.ts` where `src/main/patch.ts`
 * would do. That prefix is pure overhead — it costs tokens on every call, and it is the
 * part the model is most likely to get subtly wrong.
 *
 * So a chat's workspace is *learned* from the absolute paths it already uses, and later
 * relative paths resolve against it. Nothing is declared, there is no workspace id, and no
 * tool exists to set one: the workspace is a consequence of working, which is why an
 * ordinary session gets the benefit without being taught anything.
 *
 * ## Why this is keyed the way it is
 *
 * The hard requirement is that two chats never share a workspace — chat B resolving
 * `src/main/patch.ts` against chat A's project would read, or worse write, the wrong file.
 * The dispatcher now adopts an exact request-id → conversation join before the handler when
 * that evidence is already available. That conversation is stronger than the old
 * sole-generating fallback and must win whenever present.
 *
 * Identity comes only from the request-correlated conversation (or its already-resolved
 * swarm agent). When that exact identity is absent — Chrome off, late/missing Fiber evidence,
 * or a conflicting observation — there
 * is **no workspace**, and a relative path is refused with the absolute form to use instead.
 * That is the whole safety argument: ambiguity costs a retry, never a wrong file. Nothing
 * here ever widens what may be reached; every path still goes through `resolvePath` and
 * every root, containment and symlink check it performs.
 */

import path from 'node:path';
import { rawPromises as fs } from './rawfs.js';
import type { Root } from '../shared/types.js';
import { currentCall } from './mcp/call-context.js';

/** How long a learned workspace survives without being used or renewed. */
const WORKSPACE_TTL_MS = 12 * 60 * 60 * 1000;

/** Enough for every chat and worker plausibly in flight; oldest is evicted first. */
const MAX_WORKSPACES = 64;

/**
 * Files that mean "this directory is the top of a project".
 *
 * The workspace learned from `/project/chat-on-steroids/src/main/patch.ts` should be the
 * repository, not `src/main` — otherwise the next call has to write `../../src/other.ts`
 * and nothing has been saved. Walking up to the nearest marker is what makes a relative
 * path mean the same thing it means in a terminal at the project root.
 */
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];

export interface Workspace {
  /** Virtual path of the folder, e.g. `/project/chat-on-steroids`. */
  virtual: string;
  real: string;
  at: number;
}

const workspaces = new Map<string, Workspace>();

/**
 * Who this call is, for workspace purposes only.
 *
 * Returns null rather than a guess. Callers treat null as "this chat has no workspace",
 * which refuses relative paths; they never fall back to another chat's.
 */
export function workspaceKey(): string | null {
  const call = currentCall();
  // Conversation is the durable identity. Friendly agent ids are reused across prime histories
  // (`prime`, `worker-1`, ...), so once an exact ChatGPT conversation is known it must win over
  // the transient slot name. The agent key remains only as a bootstrap/inheritance staging key
  // before a newly opened worker has reported which conversation it became.
  if (call?.caller.conversationId) return `chat:${call.caller.conversationId}`;
  if (call?.agent) return `agent:${call.agent}`;
  return null;
}

function prune(): void {
  const cutoff = Date.now() - WORKSPACE_TTL_MS;
  for (const [key, held] of workspaces) if (held.at < cutoff) workspaces.delete(key);
  while (workspaces.size > MAX_WORKSPACES) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, held] of workspaces) {
      if (held.at < oldestAt) {
        oldestAt = held.at;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    workspaces.delete(oldestKey);
  }
}

/** The workspace for the call currently running, or null if it has none. */
export function currentWorkspace(): Workspace | null {
  const key = workspaceKey();
  if (!key) return null;
  prune();
  let held = workspaces.get(key) ?? null;
  // A worker inherits under `agent:worker-N` before its browser bootstrap has a conversation id.
  // On its first exact attributed call, atomically migrate that staging value to the durable
  // conversation key. Never do the reverse: a missing chat workspace must not pick up a friendly
  // id from some other prime history after run turnover.
  const call = currentCall();
  if (!held && key.startsWith('chat:') && call?.agent) {
    const stagedKey = `agent:${call.agent}`;
    const staged = workspaces.get(stagedKey);
    if (staged) {
      held = { virtual: staged.virtual, real: staged.real, at: Date.now() };
      workspaces.set(key, held);
      workspaces.delete(stagedKey);
    }
  }
  if (held) held.at = Date.now();
  return held;
}

/** Sets the workspace for an explicit key. Used by resume and by worker inheritance. */
export function setWorkspaceFor(key: string, workspace: Omit<Workspace, 'at'>): void {
  workspaces.set(key, { ...workspace, at: Date.now() });
  prune();
}

/** Sets the workspace for the call currently running, if it has an identity. */
export function setCurrentWorkspace(workspace: Omit<Workspace, 'at'>): boolean {
  const key = workspaceKey();
  if (!key) return false;
  setWorkspaceFor(key, workspace);
  return true;
}

/**
 * Gives a new worker the prime's workspace to start from.
 *
 * Inheritance is a copy, not a reference: the worker's own use overwrites its own entry and
 * never the prime's, which is what lets a worker be sent off into a different project
 * without dragging its parent along.
 */
export function inheritWorkspace(toAgent: string, primeConversationId: string | null): boolean {
  const held = primeWorkspace(primeConversationId);
  if (!held) {
    // Agent ids are reused by later runs (`worker-1`, `worker-2`, ...). A fresh run whose
    // prime has not learned a workspace yet must therefore actively clear the destination
    // slot instead of leaving whatever the previous incarnation of that worker learned.
    // Otherwise the first relative path in a brand-new worker can resolve inside an old
    // swarm's project, crossing the run boundary without either conversation ever naming it.
    workspaces.delete(`agent:${toAgent}`);
    return false;
  }
  // A copy under the worker's own key. The worker sent into another project overwrites its
  // own entry and never the prime's, which is what lets the two diverge.
  setWorkspaceFor(`agent:${toAgent}`, { virtual: held.virtual, real: held.real });
  return true;
}

/**
 * The prime's workspace, whichever of its two identities is holding it.
 *
 * The prime is the one caller that answers to two keys. Its ordinary path calls carry no
 * agent identity — that is deliberate, see `dispatch` — so what they learn is filed under
 * `chat:<conversation>`; its `agents` calls *are* keyed, so by the second spawn onwards
 * `currentCall().agent` is `prime` and `currentWorkspace()` looks under `agent:prime`, which
 * the ordinary calls never wrote to. Reading only one of the two made inheritance work on the
 * first spawn and quietly stop working on every later one.
 *
 * So try both, and write the answer back to both. After a spawn the two keys agree, and it
 * stops mattering which one the next call arrives under. None of this is visible to a model:
 * there is still no workspace id, and nothing here can be named or set from a tool argument.
 */
export function primeWorkspace(primeConversationId: string | null): Workspace | null {
  prune();
  // Conversation key first, and it wins a tie: it is the one ordinary path calls actually
  // write to, while `agent:prime` is only ever the mirror this function left behind at the
  // last spawn. Newest otherwise, so a prime that has since moved to another project hands
  // over the folder it moved to rather than the one it started in.
  const keys = [...(primeConversationId ? [`chat:${primeConversationId}`] : []), 'agent:prime'];
  let found: Workspace | null = null;
  for (const key of keys) {
    const held = workspaces.get(key);
    if (held && (!found || held.at > found.at)) found = held;
  }
  if (!found) return null;
  for (const key of keys) setWorkspaceFor(key, { virtual: found.virtual, real: found.real });
  return found;
}

/**
 * Collapses the live swarm prime's agent-scoped cwd back into its ordinary chat identity.
 *
 * While a run exists, the kernel resolves prime tool calls as `agent:prime`, so that key is
 * the authority for workspace changes made during the run. Once the run ends those same calls
 * go back to `chat:<conversation>`. Recency comparison is the wrong tool at this boundary: two
 * writes may share one millisecond, and the generic primeWorkspace() tie-break deliberately
 * favours the chat key for inheritance. Ending the run is an explicit identity transition, so
 * copy the agent value when present and then remove the temporary key. Removing it also keeps
 * a later run from inheriting a previous run's prime cwd when the new prime has none yet.
 */
export function releasePrimeWorkspace(primeConversationId: string | null): boolean {
  prune();
  const held = workspaces.get('agent:prime');
  if (!held) return false;
  if (primeConversationId) {
    setWorkspaceFor(`chat:${primeConversationId}`, { virtual: held.virtual, real: held.real });
  }
  workspaces.delete('agent:prime');
  return true;
}

/**
 * Parks one live agent workspace under the exact ChatGPT conversation that owns it.
 *
 * Friendly agent ids are intentionally reused by later runs (`prime`, `worker-1`, ...), so a
 * reusable worker cannot leave its cwd under `agent:worker-1` after its run releases the global
 * execution claim. Another prime may immediately create its own worker-1 and would otherwise
 * inherit or overwrite the first worker's cwd. Conversation ids are the durable identity, so
 * parking copies the live value there and always clears the friendly key.
 */
export function parkAgentWorkspace(agentId: string, conversationId: string | null): boolean {
  if (!agentId) return false;
  prune();
  const key = `agent:${agentId}`;
  const held = workspaces.get(key);
  if (held && conversationId) {
    setWorkspaceFor(`chat:${conversationId}`, { virtual: held.virtual, real: held.real });
  }
  workspaces.delete(key);
  return Boolean(held);
}

/**
 * Finalizes a newly opened worker's temporary inherited workspace under its exact chat id.
 * This is the same map transition as parking, but happens immediately at browser binding so a
 * worker that never calls a local tool still cannot leave `agent:worker-N` behind for another
 * prime's later run to inherit.
 */
export function bindAgentWorkspace(agentId: string, conversationId: string): boolean {
  if (!conversationId) return false;
  return parkAgentWorkspace(agentId, conversationId);
}

/**
 * Rehydrates a parked conversation workspace into the friendly agent id of a new incarnation.
 *
 * Absence is meaningful: the same friendly id may have belonged to another run moments ago, so
 * failing to find a conversation-scoped workspace must actively clear that stale agent key.
 */
export function activateAgentWorkspace(agentId: string, conversationId: string | null): boolean {
  if (!agentId) return false;
  prune();
  const key = `agent:${agentId}`;
  const held = conversationId ? workspaces.get(`chat:${conversationId}`) : undefined;
  if (!held) {
    workspaces.delete(key);
    return false;
  }
  setWorkspaceFor(key, { virtual: held.virtual, real: held.real });
  return true;
}

/** The workspace a named conversation has learned, for code running outside its calls. */
export function workspaceForChat(conversationId: string | null): Workspace | null {
  if (!conversationId) return null;
  prune();
  return workspaces.get(`chat:${conversationId}`) ?? null;
}

/**
 * Moves a chat's learned workspace to the conversation replacing it.
 *
 * Part of the Compact & Resume commit, and deliberately part of it rather than something
 * the handoff carries: the workspace belongs to the durable local session, so it travels
 * with the session's rebind instead of being written into a brief for the model to re-adopt
 * by calling a tool. The old key is dropped, so a stale tab on chat A cannot go on resolving
 * relative paths against a workspace the session has moved on from.
 *
 * Pure map work and total: the commit calls this only after the durable session write has
 * landed, so it must not be able to fail. A chat with nothing learned yet moves nothing,
 * which is the correct outcome rather than an error.
 */
export function moveChatWorkspace(fromConversationId: string, toConversationId: string): boolean {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return false;
  const held = workspaces.get(`chat:${fromConversationId}`);
  if (!held) return false;
  workspaces.set(`chat:${toConversationId}`, { virtual: held.virtual, real: held.real, at: Date.now() });
  workspaces.delete(`chat:${fromConversationId}`);
  return true;
}

/** Drops one conversation-scoped workspace without touching any agent-scoped mirror. */
export function clearChatWorkspace(conversationId: string | null): boolean {
  if (!conversationId) return false;
  return workspaces.delete(`chat:${conversationId}`);
}

/** Forgets everything. Tests, and a full disconnect. */
export function resetWorkspaces(): void {
  workspaces.clear();
}

/**
 * Moves every learned workspace when the user renames one approved virtual root.
 *
 * Workspaces cache the model-facing virtual path as well as the real directory. Renaming only
 * config would leave every live chat pointing at the old namespace until it happened to use an
 * absolute path again. The real directory is unchanged, so this is a pure namespace rewrite.
 */
export function renameWorkspaceRoot(fromName: string, toName: string): number {
  if (!fromName || !toName || fromName === toName) return 0;
  const from = `/${fromName}`;
  const to = `/${toName}`;
  let changed = 0;
  for (const held of workspaces.values()) {
    if (held.virtual !== from && !held.virtual.startsWith(`${from}/`)) continue;
    held.virtual = `${to}${held.virtual.slice(from.length)}`;
    held.at = Date.now();
    changed += 1;
  }
  return changed;
}

/** Drops learned workspaces whose approved virtual root has just been removed. */
export function forgetWorkspaceRoot(name: string): number {
  if (!name) return 0;
  const root = `/${name}`;
  let removed = 0;
  for (const [key, held] of workspaces) {
    if (held.virtual !== root && !held.virtual.startsWith(`${root}/`)) continue;
    workspaces.delete(key);
    removed += 1;
  }
  return removed;
}

/** Test seam: what is currently held, for assertions. */
export function workspaceEntries(): Array<{ key: string; virtual: string }> {
  return [...workspaces.entries()].map(([key, held]) => ({ key, virtual: held.virtual }));
}

async function isDirectory(real: string): Promise<boolean> {
  try {
    return (await fs.stat(real)).isDirectory();
  } catch {
    return false;
  }
}

async function hasMarker(real: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    try {
      await fs.lstat(path.join(real, marker));
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/**
 * The project a resolved path belongs to, as a folder to remember.
 *
 * Walks up from the path towards its approved root looking for a project marker, and stops
 * at the root: the search never leaves the folder the user approved, so a stray `.git` in a
 * parent directory outside the sandbox cannot pull the workspace out of it.
 */
export async function projectFolderOf(
  resolved: { real: string; virtual: string },
  rootReal: string
): Promise<{ real: string; virtual: string }> {
  const startReal = (await isDirectory(resolved.real)) ? resolved.real : path.dirname(resolved.real);
  const depth = path.posix.normalize(resolved.virtual).split('/').filter(Boolean).length;
  const startVirtual = (await isDirectory(resolved.real))
    ? path.posix.normalize(resolved.virtual)
    : path.posix.dirname(path.posix.normalize(resolved.virtual));

  let currentReal = startReal;
  let currentVirtual = startVirtual;
  // Bounded by the virtual depth, so a malformed pair can never spin.
  for (let step = 0; step <= depth; step++) {
    // Never above the approved root: containment is the boundary, here as everywhere.
    const relative = path.relative(rootReal, currentReal);
    if (relative.startsWith('..') || path.isAbsolute(relative)) break;
    if (await hasMarker(currentReal)) return { real: currentReal, virtual: currentVirtual };
    const parentReal = path.dirname(currentReal);
    if (parentReal === currentReal) break;
    currentReal = parentReal;
    currentVirtual = path.posix.dirname(currentVirtual);
  }
  return { real: startReal, virtual: startVirtual };
}

/**
 * Records where a successful call was working, so the next one can be brief.
 *
 * Deliberately learned from *absolute* paths only. A workspace inferred from a relative
 * path would be circular — it would let one loose resolution define where the next loose
 * resolution points — and a workspace can then only ever name somewhere the chat has
 * already proven it can reach.
 */
export async function learnWorkspace(resolved: { real: string; virtual: string; root: Root }): Promise<void> {
  if (!workspaceKey()) return;
  let rootReal: string;
  try {
    rootReal = await fs.realpath(resolved.root.path);
  } catch {
    return;
  }
  const folder = await projectFolderOf(resolved, rootReal);
  setCurrentWorkspace(folder);
}
