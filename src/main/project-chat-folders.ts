import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDurable, writeDurableNow } from './durable.js';
import { getProject } from './projects.js';
import { getSession } from './session/store.js';
import type { ProjectChatFolderState } from '../shared/project-chat-folders.js';

const MAX_FOLDERS_PER_PROJECT = 64;
const MAX_ASSIGNMENTS_PER_PROJECT = 10_000;
const folderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  createdAt: z.number().finite().nonnegative()
}).strict();
const sessionIdSchema = z.string().min(1).max(80);
const assignmentsSchema = z.record(sessionIdSchema, z.string().uuid()).refine(
  value => Object.keys(value).length <= MAX_ASSIGNMENTS_PER_PROJECT,
  'Too many chat-folder assignments'
);
const stateSchema = z.object({
  projectId: z.string().uuid(),
  folders: z.array(folderSchema).max(MAX_FOLDERS_PER_PROJECT),
  assignments: assignmentsSchema
}).strict();
const catalogSchema = z.array(stateSchema).max(200);
let mutations: Promise<unknown> = Promise.resolve();

function copy(state: ProjectChatFolderState): ProjectChatFolderState {
  return { projectId: state.projectId, folders: state.folders.map(folder => ({ ...folder })), assignments: { ...state.assignments } };
}

function nameKey(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('en-US');
}

function parseName(value: string): string {
  return z.string().trim().min(1).max(80).parse(value);
}

function validateCatalog(catalog: ProjectChatFolderState[]): ProjectChatFolderState[] {
  const projects = new Set<string>();
  for (const state of catalog) {
    if (projects.has(state.projectId)) throw new Error('Project chat-folder catalog is invalid');
    projects.add(state.projectId);
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const folder of state.folders) {
      if (ids.has(folder.id) || names.has(nameKey(folder.name))) throw new Error('Project chat-folder catalog is invalid');
      ids.add(folder.id); names.add(nameKey(folder.name));
    }
    if (Object.values(state.assignments).some(folderId => !ids.has(folderId))) {
      throw new Error('Project chat-folder catalog is invalid');
    }
  }
  return catalog.map(copy);
}

function parseCatalog(raw: unknown): ProjectChatFolderState[] {
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Project chat-folder catalog is invalid or exceeds its limits');
  return validateCatalog(parsed.data);
}

async function readCatalog(): Promise<ProjectChatFolderState[]> {
  const raw = await readDurable<unknown>('project-chat-folders');
  return raw === null ? [] : parseCatalog(raw);
}

function empty(projectId: string): ProjectChatFolderState {
  return { projectId, folders: [], assignments: {} };
}

function stateFor(catalog: ProjectChatFolderState[], projectId: string): ProjectChatFolderState {
  return copy(catalog.find(state => state.projectId === projectId) ?? empty(projectId));
}

async function requireGroupedProject(projectId: string): Promise<void> {
  z.string().uuid().parse(projectId);
  const project = await getProject(projectId);
  if (!project || project.ungrouped) throw new Error('Project not found');
}

async function writeState(catalog: ProjectChatFolderState[], state: ProjectChatFolderState): Promise<void> {
  const without = catalog.filter(row => row.projectId !== state.projectId);
  const next = state.folders.length || Object.keys(state.assignments).length ? [...without, copy(state)] : without;
  // The complete candidate must remain readable before it reaches the durable write owner.
  // Rejecting a new assignment/project at capacity must not poison the existing catalog.
  await writeDurableNow('project-chat-folders', parseCatalog(next));
}

function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const work = mutations.then(operation);
  mutations = work.catch(() => undefined);
  return work;
}

export async function listProjectChatFolders(): Promise<ProjectChatFolderState[]> {
  return readCatalog();
}

export function createProjectChatFolder(projectId: string, requestedName: string): Promise<ProjectChatFolderState> {
  return mutate(async () => {
    await requireGroupedProject(projectId);
    const name = parseName(requestedName);
    const catalog = await readCatalog();
    const state = stateFor(catalog, projectId);
    if (state.folders.length >= MAX_FOLDERS_PER_PROJECT) throw new Error('Project chat-folder limit reached');
    if (state.folders.some(folder => nameKey(folder.name) === nameKey(name))) throw new Error('A chat folder with this name already exists');
    state.folders.push({ id: randomUUID(), name, createdAt: Date.now() });
    await writeState(catalog, state);
    return copy(state);
  });
}

export function renameProjectChatFolder(projectId: string, folderId: string, requestedName: string): Promise<ProjectChatFolderState> {
  return mutate(async () => {
    await requireGroupedProject(projectId);
    z.string().uuid().parse(folderId);
    const name = parseName(requestedName);
    const catalog = await readCatalog();
    const state = stateFor(catalog, projectId);
    const folder = state.folders.find(row => row.id === folderId);
    if (!folder) throw new Error('Project chat folder not found');
    if (state.folders.some(row => row.id !== folderId && nameKey(row.name) === nameKey(name))) throw new Error('A chat folder with this name already exists');
    folder.name = name;
    await writeState(catalog, state);
    return copy(state);
  });
}

export function removeProjectChatFolder(projectId: string, folderId: string): Promise<ProjectChatFolderState> {
  return mutate(async () => {
    await requireGroupedProject(projectId);
    z.string().uuid().parse(folderId);
    const catalog = await readCatalog();
    const state = stateFor(catalog, projectId);
    if (!state.folders.some(folder => folder.id === folderId)) throw new Error('Project chat folder not found');
    state.folders = state.folders.filter(folder => folder.id !== folderId);
    state.assignments = Object.fromEntries(Object.entries(state.assignments).filter(([, assigned]) => assigned !== folderId));
    await writeState(catalog, state);
    return copy(state);
  });
}

export function setSessionChatFolder(projectId: string, sessionId: string, folderId: string | null): Promise<ProjectChatFolderState> {
  return mutate(async () => {
    await requireGroupedProject(projectId);
    sessionIdSchema.parse(sessionId);
    if (folderId !== null) z.string().uuid().parse(folderId);
    const session = await getSession(sessionId);
    if (!session || session.projectId !== projectId) throw new Error('Chat does not belong to this project');
    if (session.origin?.kind === 'worker') throw new Error('Sub-agent chats stay with their parent chat');
    const catalog = await readCatalog();
    const state = stateFor(catalog, projectId);
    if (folderId !== null && !state.folders.some(folder => folder.id === folderId)) throw new Error('Project chat folder not found');
    if (folderId === null) delete state.assignments[sessionId];
    else state.assignments[sessionId] = folderId;
    await writeState(catalog, state);
    return copy(state);
  });
}
