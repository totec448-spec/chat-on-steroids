import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rawPromises as fs } from './rawfs.js';
import { readDurable, writeDurableNow } from './durable.js';
import { getConfig } from './config.js';
import { nativePathIdentity, resolvePath } from './sandbox.js';
import { bindSessionProject, findSessionByConversation, getSession } from './session/store.js';
import { PROJECT_COLORS, type LocalProject, type ProjectColor } from '../shared/projects.js';

const MAX_ADDITIONAL_FOLDERS = 64;
const projectPathSchema = z.string().min(1).max(32768);
const projectSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(160), path: projectPathSchema,
  additionalPaths: z.array(projectPathSchema).max(MAX_ADDITIONAL_FOLDERS).optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  createdAt: z.number().finite().nonnegative(), ungrouped: z.boolean().optional()
});
const catalogSchema = z.array(projectSchema).max(200);
let mutations: Promise<unknown> = Promise.resolve();
const samePath = (a: string, b: string) => nativePathIdentity(a) === nativePathIdentity(b);
const folders = (project: LocalProject): string[] => [project.path, ...(project.additionalPaths ?? [])];

/**
 * Primary workspace identity is authoritative and therefore must stay unambiguous. Older builds
 * and hand-edited catalogs can, however, leave the same optional member more than once. Reading
 * those rows must not hide every project: all primaries win first, then additional members keep
 * the first stored identity in catalog order. A later mutation naturally rewrites the cleaned
 * projection without adding a second migration owner.
 */
function sanitizeAdditionalFolders(projects: LocalProject[]): LocalProject[] {
  const primary = new Set<string>();
  for (const project of projects) {
    const identity = nativePathIdentity(project.path);
    if (primary.has(identity)) throw new Error('Project catalog is invalid');
    primary.add(identity);
  }
  const claimed = new Set(primary);
  return projects.map(project => {
    if (!project.additionalPaths?.length) return project;
    const kept: string[] = [];
    for (const folder of project.additionalPaths) {
      const identity = nativePathIdentity(folder);
      if (claimed.has(identity)) continue;
      claimed.add(identity);
      kept.push(folder);
    }
    if (kept.length === project.additionalPaths.length && kept.every((folder, index) => folder === project.additionalPaths![index])) return project;
    const { additionalPaths: _, ...primaryOnly } = project;
    return kept.length ? { ...primaryOnly, additionalPaths: kept } : primaryOnly;
  });
}

async function approvedDirectory(folderPath: string, message: string): Promise<string> {
  if (!path.isAbsolute(folderPath)) throw new Error(message);
  const resolved = await resolvePath(getConfig().roots, folderPath);
  if (!(await fs.stat(resolved.real).then(stat => stat.isDirectory(), () => false))) throw new Error(message);
  return resolved.real;
}

async function resolveStoredFolder(folderPath: string): Promise<{ virtual: string; real: string }> {
  const resolved = await resolvePath(getConfig().roots, folderPath);
  if (!samePath(resolved.real, folderPath) || !(await fs.stat(resolved.real).then(stat => stat.isDirectory(), () => false))) {
    throw new Error('Project folder changed or is unavailable');
  }
  return { virtual: resolved.virtual, real: resolved.real };
}

export async function listProjects(): Promise<LocalProject[]> {
  const raw = await readDurable<unknown>('projects');
  if (raw === null) return [];
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success || new Set(parsed.data.map(row => row.id)).size !== parsed.data.length) {
    throw new Error('Project catalog is invalid');
  }
  return sanitizeAdditionalFolders(parsed.data);
}
export async function getProject(id: string): Promise<LocalProject | null> {
  return (await listProjects()).find(project => project.id === id) ?? null;
}
/** Folder picker callers approve roots separately; project selection cannot widen them. */
export function addProject(folderPath: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    const real = await approvedDirectory(folderPath, path.isAbsolute(folderPath) ? 'Choose a project folder' : 'Choose an absolute local project folder');
    const projects = await listProjects();
    const owner = projects.find(project => folders(project).some(folder => samePath(folder, real)));
    if (owner) {
      if (!samePath(owner.path, real)) throw new Error('Project folder already belongs to another project');
      if (!owner.ungrouped) return owner;
      const { ungrouped: _, ...restored } = owner;
      await writeDurableNow('projects', projects.map(project => project.id === owner.id ? restored : project));
      return restored;
    }
    if (projects.length >= 200) throw new Error('Project catalog limit reached');
    const project: LocalProject = { id: randomUUID(), name: (path.basename(real) || real).slice(0, 160), path: real, createdAt: Date.now() };
    await writeDurableNow('projects', [...projects, project]);
    return project;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

/** Adds one independently approved folder without changing the project's primary workspace. */
export function addProjectFolder(projectId: string, folderPath: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(projectId);
    const projects = await listProjects();
    const project = projects.find(row => row.id === projectId);
    if (!project) throw new Error('Project not found');
    const real = await approvedDirectory(folderPath, path.isAbsolute(folderPath)
      ? 'Choose an additional project folder' : 'Choose an absolute additional project folder');
    const owner = projects.find(row => folders(row).some(folder => samePath(folder, real)));
    if (owner?.id === project.id) return project;
    if (owner) throw new Error('Project folder already belongs to another project');
    const additionalPaths = [...(project.additionalPaths ?? []), real];
    if (additionalPaths.length > MAX_ADDITIONAL_FOLDERS) throw new Error('Project folder limit reached');
    const updated = { ...project, additionalPaths };
    await writeDurableNow('projects', projects.map(row => row.id === project.id ? updated : row));
    return updated;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

/** Membership removal uses the stored canonical identity, so a revoked/missing folder can still be detached. */
export function removeProjectFolder(projectId: string, folderPath: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(projectId);
    if (!path.isAbsolute(folderPath)) throw new Error('Project folder path must be absolute');
    const projects = await listProjects();
    const project = projects.find(row => row.id === projectId);
    if (!project) throw new Error('Project not found');
    if (samePath(project.path, folderPath)) throw new Error('The primary project folder cannot be removed');
    const additional = project.additionalPaths ?? [];
    const index = additional.findIndex(folder => samePath(folder, folderPath));
    if (index < 0) throw new Error('Project folder not found');
    const remaining = additional.filter((_, at) => at !== index);
    const { additionalPaths: _, ...withoutAdditional } = project;
    const updated: LocalProject = remaining.length ? { ...withoutAdditional, additionalPaths: remaining } : withoutAdditional;
    await writeDurableNow('projects', projects.map(row => row.id === project.id ? updated : row));
    return updated;
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
export async function projectWorkspace(projectId: string, folderPath?: string): Promise<{ virtual: string; real: string }> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  if (folderPath === undefined) return resolveProject(project);
  const requested = await resolvePath(getConfig().roots, folderPath);
  const stored = folders(project).find(folder => samePath(folder, requested.real));
  if (!stored) throw new Error('Folder does not belong to the project');
  const resolved = await resolveStoredFolder(stored);
  const current = await getProject(projectId);
  if (!current || !folders(current).some(folder => samePath(folder, resolved.real))) {
    throw new Error('Folder no longer belongs to the project');
  }
  return resolved;
}
/** Optional members are useful only while their independently approved root still resolves. */
export async function projectAdditionalWorkspaces(projectId: string): Promise<Array<{ virtual: string; real: string }>> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  const resolved: Array<{ virtual: string; real: string }> = [];
  for (const folder of project.additionalPaths ?? []) {
    try { resolved.push(await projectWorkspace(projectId, folder)); }
    catch { /* Membership is retained so the user can detach it; revoked/unavailable folders are not projected. */ }
  }
  return resolved;
}
async function resolveProject(project: LocalProject): Promise<{ virtual: string; real: string }> {
  return resolveStoredFolder(project.path);
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
