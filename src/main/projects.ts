import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rawPromises as fs } from './rawfs.js';
import { readDurable, writeDurableNow } from './durable.js';
import { getConfig } from './config.js';
import { nativePathIdentity, resolvePath } from './sandbox.js';
import { bindSessionProject, findSessionByConversation, getSession } from './session/store.js';
import { normalizeChatGptProjectId, PROJECT_COLORS, type LocalProject, type ProjectColor } from '../shared/projects.js';

const remoteProjectSchema = z.object({
  provider: z.literal('chatgpt'),
  projectId: z.string().refine(value => normalizeChatGptProjectId(value) === value, 'Invalid ChatGPT Project id'),
  // Older pre-landing local catalogs may lack an incarnation. They stay readable but
  // membership checks remain unavailable until a user explicitly Refreshes the link.
  linkId: z.string().uuid().optional(),
  linkedAt: z.number().finite().nonnegative(),
  lastObservedAt: z.number().finite().nonnegative()
}).strict().refine(value => value.lastObservedAt >= value.linkedAt, 'Project observation predates its link');

const projectSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(160), path: z.string().min(1).max(32768),
  color: z.enum(PROJECT_COLORS).optional(),
  createdAt: z.number().finite().nonnegative(), ungrouped: z.boolean().optional(), remote: remoteProjectSchema.optional()
});
const catalogSchema = z.array(projectSchema).max(200);
let mutations: Promise<unknown> = Promise.resolve();
const samePath = (a: string, b: string) => nativePathIdentity(a) === nativePathIdentity(b);

export async function listProjects(): Promise<LocalProject[]> {
  const raw = await readDurable<unknown>('projects');
  if (raw === null) return [];
  const parsed = catalogSchema.safeParse(raw);
  const remoteIds = parsed.success ? parsed.data.flatMap(row => row.remote ? [row.remote.projectId] : []) : [];
  if (!parsed.success || new Set(parsed.data.map(row => row.id)).size !== parsed.data.length ||
      new Set(remoteIds).size !== remoteIds.length) throw new Error('Project catalog is invalid');
  return parsed.data;
}
export async function getProject(id: string): Promise<LocalProject | null> {
  return (await listProjects()).find(project => project.id === id) ?? null;
}
/** Folder picker callers approve roots separately; project selection cannot widen them. */
export function addProject(folderPath: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    if (!path.isAbsolute(folderPath)) throw new Error('Choose an absolute local project folder');
    const resolved = await resolvePath(getConfig().roots, folderPath);
    if (!(await fs.stat(resolved.real)).isDirectory()) throw new Error('Choose a project folder');
    const projects = await listProjects();
    const existing = projects.find(project => samePath(project.path, resolved.real));
    if (existing) {
      if (!existing.ungrouped) return existing;
      const { ungrouped: _, ...restored } = existing;
      await writeDurableNow('projects', projects.map(project => project.id === existing.id ? restored : project));
      return restored;
    }
    if (projects.length >= 200) throw new Error('Project catalog limit reached');
    const project: LocalProject = { id: randomUUID(), name: (path.basename(resolved.real) || resolved.real).slice(0, 160), path: resolved.real, createdAt: Date.now() };
    await writeDurableNow('projects', [...projects, project]);
    return project;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

/** Presentation metadata only; changing it never revalidates or alters project workspace authority. */
export function setProjectColor(projectId: string, color: ProjectColor | null): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(projectId);
    const normalized = z.enum(PROJECT_COLORS).nullable().parse(color);
    const projects = await listProjects();
    const project = projects.find(row => row.id === projectId);
    if (!project) throw new Error('Project not found');
    if (project.color === (normalized ?? undefined)) return project;
    const { color: _, ...withoutColor } = project;
    const updated: LocalProject = normalized ? { ...withoutColor, color: normalized } : withoutColor;
    await writeDurableNow('projects', projects.map(row => row.id === projectId ? updated : row));
    return updated;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

function observedProject(value: unknown, observedAt: unknown): { projectId: string; observedAt: number } {
  const projectId = normalizeChatGptProjectId(value);
  if (!projectId) throw new Error('Invalid ChatGPT Project id');
  const at = z.number().finite().nonnegative().parse(observedAt);
  return { projectId, observedAt: at };
}

/**
 * Links provider identity to an already-approved local workspace. The local path/name remain
 * local-owned and a provider Project can belong to at most one LocalProject.
 */
export function linkChatGptProject(projectId: string, remoteProjectId: string, observedAt = Date.now()): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(projectId);
    const observed = observedProject(remoteProjectId, observedAt);
    const projects = await listProjects();
    const project = projects.find(row => row.id === projectId);
    if (!project) throw new Error('Project not found');
    if (project.ungrouped) throw new Error('Project is no longer on the sidebar');
    await resolveProject(project);
    const other = projects.find(row => row.id !== projectId && row.remote?.provider === 'chatgpt' && row.remote.projectId === observed.projectId);
    if (other) throw new Error('ChatGPT Project is already linked to another local project');
    if (project.remote && (project.remote.provider !== 'chatgpt' || project.remote.projectId !== observed.projectId)) {
      throw new Error('Local project is already linked to another ChatGPT Project');
    }
    if (project.remote?.linkId && observed.observedAt <= project.remote.lastObservedAt) return project;
    const remote = project.remote
      ? { ...project.remote, linkId: project.remote.linkId ?? randomUUID(), lastObservedAt: Math.max(observed.observedAt, project.remote.lastObservedAt) }
      : { provider: 'chatgpt' as const, projectId: observed.projectId, linkId: randomUUID(), linkedAt: observed.observedAt, lastObservedAt: observed.observedAt };
    const updated = { ...project, remote };
    await writeDurableNow('projects', projects.map(row => row.id === projectId ? updated : row));
    return updated;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

/** A refresh may update freshness only when the exact stable provider identity still matches. */
export function verifyChatGptProjectLink(projectId: string, remoteProjectId: string, observedAt = Date.now()): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(projectId);
    const observed = observedProject(remoteProjectId, observedAt);
    const projects = await listProjects();
    const project = projects.find(row => row.id === projectId);
    if (!project) throw new Error('Project not found');
    if (project.ungrouped) throw new Error('Project is no longer on the sidebar');
    await resolveProject(project);
    if (!project.remote) throw new Error('Local project is not linked to a ChatGPT Project');
    if (project.remote.provider !== 'chatgpt' || project.remote.projectId !== observed.projectId) {
      throw new Error('Observed ChatGPT Project does not match the linked Project');
    }
    if (project.remote.linkId && observed.observedAt <= project.remote.lastObservedAt) return project;
    const updated = { ...project, remote: {
      ...project.remote, linkId: project.remote.linkId ?? randomUUID(),
      lastObservedAt: Math.max(observed.observedAt, project.remote.lastObservedAt)
    } };
    await writeDurableNow('projects', projects.map(row => row.id === projectId ? updated : row));
    return updated;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

/** Removes only the remote association; local files, workspace authority and sessions are untouched. */
export function unlinkChatGptProject(projectId: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(projectId);
    const projects = await listProjects();
    const project = projects.find(row => row.id === projectId);
    if (!project) throw new Error('Project not found');
    if (!project.remote) return project;
    const { remote: _, ...updated } = project;
    await writeDurableNow('projects', projects.map(row => row.id === projectId ? updated : row));
    return updated;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

/** Remove only the grouping. One catalog commit also covers unloaded sessions and
 * in-flight inputs without rewriting their durable workspace/receipt identities. */
export function removeProject(id: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(id);
    const projects = await listProjects();
    const project = projects.find(row => row.id === id);
    if (!project) throw new Error('Project not found');
    const removed = { ...project, ungrouped: true };
    if (!project.ungrouped) await writeDurableNow('projects', projects.map(row => row.id === id ? removed : row));
    return removed;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}
export async function assignSessionProject(sessionId: string, projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  await resolveProject(project);
  await bindSessionProject(sessionId, project.id);
}
export async function projectWorkspace(projectId: string): Promise<{ virtual: string; real: string }> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  return resolveProject(project);
}
async function resolveProject(project: LocalProject): Promise<{ virtual: string; real: string }> {
  const resolved = await resolvePath(getConfig().roots, project.path);
  if (!samePath(resolved.real, project.path) || !(await fs.stat(resolved.real)).isDirectory()) throw new Error('Project folder changed or is unavailable');
  return { virtual: resolved.virtual, real: resolved.real };
}
/** Null means no project. A broken explicit binding is an error, never permission to guess cwd. */
export async function getSessionProject(sessionId: string): Promise<{ virtual: string; real: string } | null> {
  const session = await getSession(sessionId);
  if (!session?.projectId) return null;
  const project = await getProject(session.projectId);
  if (!project) throw new Error('The session project is unavailable');
  return resolveProject(project);
}
/** The broker supplies an exact prime conversation; unrelated families are never consulted. */
export async function inheritSessionProject(sessionId: string, primeConversationId: string): Promise<void> {
  const prime = await findSessionByConversation(primeConversationId, { requireUnique: true });
  if (prime?.conversationId !== primeConversationId || !prime.projectId) return;
  await assignSessionProject(sessionId, prime.projectId);
}
