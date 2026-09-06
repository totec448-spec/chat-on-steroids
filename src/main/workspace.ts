/**
 * The folder a chat is currently working in, so it can stop spelling out full paths.
 *
 * A coding session spends its whole life inside one project, and every call was repeating
 * the same prefix: `/project/chat-on-steroids/src/main/patch.ts` where `src/main/patch.ts`
 * would do. That prefix is pure overhead — it costs tokens on every call, and it is the
 * part the model is most likely to get subtly wrong.
 *
 * So a chat's workspace is *learned* from the absolute paths it already uses, and later
 * relative paths resolve against it. An explicit durable session project can initialize
 * this same cwd through the kernel; subsequent learned paths use the same owner. No
 * model-facing tool exists to select another session's workspace.
 *
 * ## Why this is keyed the way it is
 *
 * The hard requirement is that two chats never share a workspace — chat B resolving
 * `src/main/patch.ts` against chat A's project would read, or worse write, the wrong file.
 * The dispatcher now adopts an exact request-id → conversation join before the handler when
 * that evidence is already available. That conversation is stronger than the old
 * sole-generating fallback and must win whenever present.
 *
 * Identity comes only from the request-correlated conversation. Friendly agent names are
 * local to a run and cannot own cwd. When exact identity is absent — Chrome off, late/missing Fiber evidence,
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
  const conversationId = currentCall()?.caller.conversationId;
  return conversationId ? `chat:${conversationId}` : null;
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
  const held = workspaces.get(key) ?? null;
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

/** Run identity is mandatory for temporary inheritance; friendly ids never own cwd. */
function stagedAgentKey(agentId: string, runId?: string | null): string | null {
  return agentId && runId ? `agent:${runId}:${agentId}` : null;
}

export function inheritWorkspace(toAgent: string, primeConversationId: string | null, runId?: string): boolean {
  const key = stagedAgentKey(toAgent, runId);
  if (!key) return false;
  const held = primeWorkspace(primeConversationId);
  if (!held) { workspaces.delete(key); return false; }
  setWorkspaceFor(key, { virtual: held.virtual, real: held.real });
  return true;
}

/** The exact prime chat remains the owner before, during and after its run. */
export function primeWorkspace(primeConversationId: string | null): Workspace | null {
  return workspaceForChat(primeConversationId);
}

/** Ending one run may clear its own staging, never another prime's working directory. */
export function releasePrimeWorkspace(_primeConversationId: string | null, runId?: string): boolean {
  const key = stagedAgentKey('prime', runId);
  return key ? workspaces.delete(key) : false;
}

/** Commit inheritance to the exact conversation at the broker's proven binding. */
export function parkAgentWorkspace(agentId: string, conversationId: string | null, runId?: string): boolean {
  const key = stagedAgentKey(agentId, runId);
  if (!key || !conversationId) return false;
  prune();
  const held = workspaces.get(key);
  // Rebinding a known conversation must not replace work learned by that conversation.
  if (held && !workspaces.has(`chat:${conversationId}`)) {
    setWorkspaceFor(`chat:${conversationId}`, { virtual: held.virtual, real: held.real });
  }
  workspaces.delete(key);
  return Boolean(held);
}

export function bindAgentWorkspace(agentId: string, conversationId: string, runId?: string): boolean {
  return parkAgentWorkspace(agentId, conversationId, runId);
}

/** Optional bootstrap staging for a restored worker; exact chat cwd stays authoritative. */
export function activateAgentWorkspace(agentId: string, conversationId: string | null, runId?: string): boolean {
  const key = stagedAgentKey(agentId, runId);
  if (!key) return false;
  const held = workspaceForChat(conversationId);
  if (!held) { workspaces.delete(key); return false; }
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
