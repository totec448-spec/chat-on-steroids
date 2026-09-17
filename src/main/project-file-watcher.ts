import { watch as watchFs, type FSWatcher } from 'node:fs';
import type { ProjectFilesChanged } from '../shared/project-files.js';
import { projectFileTarget } from './project-files.js';

const MAX_WATCHED_DIRECTORIES = 128;
const CHANGE_DEBOUNCE_MS = 180;

type WatchFactory = (path: string, listener: () => void) => FSWatcher;

interface WatchedDirectory {
  projectId: string;
  directory: string;
  real: string;
  watcher: FSWatcher;
}

/**
 * Keeps a bounded set of non-recursive project-directory watchers.
 *
 * The renderer may name only project ids plus project-relative directories. Every requested
 * watch is re-resolved through the same project sandbox as Files itself before `fs.watch` ever
 * sees a native path. Changes are debounced per directory because compilers, Git and editors
 * commonly emit several rename/change notifications for one logical update.
 */
export class ProjectFileWatchSet {
  private readonly watched = new Map<string, WatchedDirectory>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private generation = 0;
  private projectId: string | null = null;

  constructor(
    private readonly changed: (event: ProjectFilesChanged) => void,
    private readonly watchFactory: WatchFactory = (nativePath, listener) =>
      watchFs(nativePath, { persistent: false }, listener)
  ) {}

  async sync(projectId: string | null, directories: string[]): Promise<void> {
    const generation = ++this.generation;
    if (!projectId) {
      this.projectId = null;
      this.closeAll();
      return;
    }
    const unique = [...new Set(directories)];
    if (unique.length > MAX_WATCHED_DIRECTORIES) throw new Error('Too many project folders are expanded to watch at once');
    this.projectId = projectId;
    const desired = new Set(unique.map(directory => `${projectId}\0${directory}`));

    for (const [key, existing] of this.watched) {
      if (!desired.has(key)) {
        existing.watcher.close();
        this.watched.delete(key);
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.timers.delete(key);
      }
    }

    for (const directory of unique) {
      if (generation !== this.generation || this.projectId !== projectId) return;
      const key = `${projectId}\0${directory}`;
      const existing = this.watched.get(key);
      let target;
      try {
        target = await projectFileTarget(projectId, directory, { allowRoot: true });
      } catch {
        // An expanded folder may disappear between a parent rename event and this resync.
        // The parent listing refresh will prune it; a missing watch is safer than guessing.
        if (existing) { existing.watcher.close(); this.watched.delete(key); }
        continue;
      }
      if (generation !== this.generation || this.projectId !== projectId) return;
      if (target.kind !== 'directory') continue;
      if (existing?.real === target.real) continue;
      if (existing) { existing.watcher.close(); this.watched.delete(key); }

      let watcher: FSWatcher;
      try {
        watcher = this.watchFactory(target.real, () => this.schedule(projectId, directory));
      } catch {
        continue;
      }
      watcher.on('error', () => {
        if (this.watched.get(key)?.watcher !== watcher) return;
        watcher.close();
        this.watched.delete(key);
        this.schedule(projectId, directory);
      });
      if (generation !== this.generation || this.projectId !== projectId || !desired.has(key)) {
        watcher.close();
        continue;
      }
      this.watched.set(key, { projectId, directory, real: target.real, watcher });
    }
  }

  close(): void {
    this.generation++;
    this.projectId = null;
    this.closeAll();
  }

  private schedule(projectId: string, directory: string): void {
    if (this.projectId !== projectId) return;
    const key = `${projectId}\0${directory}`;
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (this.projectId === projectId && this.watched.has(key)) this.changed({ projectId, directory });
    }, CHANGE_DEBOUNCE_MS));
  }

  private closeAll(): void {
    for (const entry of this.watched.values()) entry.watcher.close();
    this.watched.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
