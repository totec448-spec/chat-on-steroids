/**
 * The app's link to the companion extension's service worker inside the CoS browser.
 *
 * Three Chrome behaviours the companion depends on are not Electron's, and this module supplies
 * them:
 *   · Chrome keeps an extension worker alive while its WebSocket is active. The companion's wake
 *     channel is such a socket, but Electron stops an idle worker after 30 seconds anyway, which
 *     closed that channel and left new chats waiting. The link holds every running worker alive
 *     and starts a stopped one again.
 *   · Chrome wakes a stopped worker to deliver its events. The link queues events while no worker
 *     can take them, starts one, and delivers in order once its script has run (only then do its
 *     listeners exist).
 *   · Chrome fires `runtime.onStartup` when the browser starts; the host sends it through here.
 *
 * Nothing here imports Electron: the worker and its registry are the small interfaces below.
 */

export interface WorkerLike {
  readonly scope: string;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  startTask(): { end(): void };
  readonly ipc: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
    removeHandler(channel: string): void;
  };
}

export interface WorkerRegistry {
  getWorkerFromVersionID(versionId: number): WorkerLike | undefined;
  getAllRunning(): Record<number, unknown>;
  startWorkerForScope(scope: string): Promise<unknown>;
}

export type WorkerStatus = 'starting' | 'running' | 'stopping' | 'stopped';

export const EVENT_CHANNEL = 'cos-browser:event';
export const API_CHANNEL = 'cos-browser:api';
/** Events waiting for a worker. A worker that never comes back must not grow memory without bound. */
export const PENDING_EVENT_LIMIT = 1000;
const WAKE_RETRY_MS = 1000;

export class ExtensionWorkerLink {
  private readonly workers = new Map<number, WorkerLike>();
  private readonly ready = new Set<number>();
  private readonly keepAlive = new Map<number, { end(): void }>();
  private readonly pending: Array<[string, unknown[]]> = [];
  private dropped = 0;
  private closed = false;

  constructor(
    private readonly registry: WorkerRegistry,
    /** `chrome-extension://<id>/`: only this extension's worker is ever linked. */
    private readonly scope: string,
    private readonly answer: (name: string, args: unknown) => Promise<unknown>,
    private readonly warn: (message: string) => void
  ) {
    for (const versionId of Object.keys(registry.getAllRunning())) this.statusChanged(Number(versionId), 'running');
  }

  statusChanged(versionId: number, status: WorkerStatus): void {
    if (this.closed) return;
    if (status === 'starting' || status === 'running') { this.attach(versionId, status === 'running'); return; }
    // A stopping worker takes no more events; it stays linked until it has stopped.
    this.ready.delete(versionId);
    this.keepAlive.delete(versionId);
    if (status === 'stopping') return;
    // A running browser keeps its extension running.
    if (this.workers.delete(versionId)) this.wake();
  }

  /** Delivers an extension event now, or as soon as a worker can take it. */
  send(name: string, args: unknown[]): void {
    if (this.closed) return;
    const live = this.live();
    if (live.length > 0 && this.pending.length === 0) {
      for (const worker of live) worker.send(EVENT_CHANNEL, name, args);
      return;
    }
    if (this.pending.length < PENDING_EVENT_LIMIT) this.pending.push([name, args]);
    else if (this.dropped++ === 0) this.warn(`cos browser: the extension worker is not taking events; dropping ${name} and later ones until it does`);
    if (this.workers.size === 0) this.wake();
  }

  /** Releases every worker the link holds alive. The browser is stopping. */
  close(): void {
    this.closed = true;
    for (const task of this.keepAlive.values()) {
      try { task.end(); } catch { /* the worker is already gone */ }
    }
    this.keepAlive.clear();
    this.workers.clear();
    this.ready.clear();
    this.pending.length = 0;
  }

  private attach(versionId: number, running: boolean): void {
    const worker = this.registry.getWorkerFromVersionID(versionId);
    if (!worker || worker.isDestroyed() || worker.scope !== this.scope) return;
    if (this.workers.get(versionId) !== worker) {
      this.workers.set(versionId, worker);
      // A worker that outlived an earlier link still holds that link's handler.
      worker.ipc.removeHandler(API_CHANNEL);
      worker.ipc.handle(API_CHANNEL, (_event, name, args) => this.answer(String(name), args));
    }
    if (!running) return;
    if (!this.keepAlive.has(versionId)) {
      try { this.keepAlive.set(versionId, worker.startTask()); }
      catch (error) { this.warn(`cos browser: could not keep the extension worker alive: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.ready.add(versionId);
    this.flush();
  }

  private live(): WorkerLike[] {
    return [...this.workers].filter(([id, worker]) => this.ready.has(id) && !worker.isDestroyed()).map(([, worker]) => worker);
  }

  private flush(): void {
    const live = this.live();
    if (live.length === 0 || this.pending.length === 0) return;
    if (this.dropped > 0) { this.warn(`cos browser: the extension worker is back; ${this.dropped} event(s) were dropped meanwhile`); this.dropped = 0; }
    for (const [name, args] of this.pending.splice(0)) for (const worker of live) worker.send(EVENT_CHANNEL, name, args);
  }

  /**
   * Starts the worker. A start that races Electron's own (right after the extension loads) is
   * refused although a worker is on its way, so a refusal only counts once a second attempt,
   * made while still no worker has appeared, fails too.
   */
  private wake(retried = false): void {
    void this.registry.startWorkerForScope(this.scope).catch(error => {
      if (this.closed || this.workers.size > 0) return;
      if (!retried) { setTimeout(() => { if (!this.closed && this.workers.size === 0) this.wake(true); }, WAKE_RETRY_MS); return; }
      this.warn(`cos browser: could not start the extension worker: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
