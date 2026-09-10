import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rawPromises as fs } from './rawfs.js';
import { readDurable, writeDurableNow } from './durable.js';
import { getConfig } from './config.js';
import { resolvePath } from './sandbox.js';
import { bindSessionProject, findSessionByConversation, getSession } from './session/store.js';
import type { LocalProject } from '../shared/projects.js';

const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(160),
  path: z.string().min(1).max(32768),
  createdAt: z.number().finite().nonnegative(),
  hidden: z.boolean().optional()
});
const catalogSchema = z.array(projectSchema).max(200);
let mutations: Promise<unknown> = Promise.resolve();
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export async function listProjects(): Promise<LocalProject[]> {
  const raw = await readDurable<unknown>('projects');
  if (raw === null) return [];
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success || new Set(parsed.data.map(row => row.id)).size !== parsed.data.length) throw new Error('Project catalog is invalid');
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
      if (!existing.hidden) return existing;
      const restored: LocalProject = { id: existing.id, name: existing.name, path: existing.path, createdAt: existing.createdAt };
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

/**
 * Removes a repository from navigation without destroying its stable identity.
 * Sessions bind to project ids for their cwd authority; deleting the catalog row would turn a
 * cosmetic sidebar action into a broken workspace. Re-adding the same folder restores this row.
 */
export function hideProject(id: string): Promise<void> {
  const operation = mutations.then(async () => {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid project id');
    const projects = await listProjects();
    const project = projects.find(candidate => candidate.id === id);
    if (!project) throw new Error('Project not found');
    if (project.hidden) return;
    await writeDurableNow('projects', projects.map(candidate => candidate.id === id ? { ...candidate, hidden: true } : candidate));
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
