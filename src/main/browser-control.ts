/** Short-lived browser RPCs. Claims are never replayed, including after response loss. */
import { randomUUID } from 'node:crypto';
import { BROWSER_LIMITS, type BrowserCommand, type BrowserResult, type BrowserTool } from '../shared/browser-control.js';
import { wakeBrowserWork } from './browser-wake.js';

interface Pending {
  browserId: string;
  command: BrowserCommand;
  claimed: boolean;
  claiming: boolean;
  allowed: () => Promise<boolean>;
  finish: (result: BrowserResult) => void;
}
const uuid = /^[a-f\d-]{36}$/i;
const tabHandle = /^([a-f\d-]{36}):(\d+)$/i;

export class BrowserControlBroker {
  private epoch = randomUUID();
  private clients = new Map<string, { name: string; seen: number; enabled: boolean }>();
  private pending = new Map<string, Pending>();

  constructor(private wake = () => wakeBrowserWork('browser-control')) {}

  browsers(): Array<{ id: string; name: string; enabled: boolean }> {
    const now = Date.now();
    return [...this.clients].filter(([, client]) => now - client.seen < BROWSER_LIMITS.presenceMs)
      .map(([id, { name, enabled }]) => ({ id, name, enabled }));
  }

  poll(browserId: string, name: string, enabled: boolean): { epoch: string; requests: string[] } {
    if (!uuid.test(browserId)) throw new Error('Invalid browser identity');
    for (const [id, client] of this.clients) if (Date.now() - client.seen >= BROWSER_LIMITS.presenceMs) this.clients.delete(id);
    if (!this.clients.has(browserId) && this.clients.size >= BROWSER_LIMITS.clients) throw new Error('Too many browser connections');
    this.clients.set(browserId, { name: name.slice(0, 80), seen: Date.now(), enabled });
    return { epoch: this.epoch, requests: enabled ? [...this.pending].filter(([, p]) => p.browserId === browserId && !p.claimed && !p.claiming)
      .map(([id]) => id) : [] };
  }

  async claim(browserId: string, id: string, epoch: string,
    ownerProofs: ReadonlyArray<{ owner: string; sessionId: string }> = []): Promise<BrowserCommand | null> {
    const p = this.pending.get(id);
    if (!p || p.browserId !== browserId || epoch !== this.epoch || p.claimed || p.claiming) return null;
    p.claiming = true;
    const allowed = await p.allowed().catch(() => false);
    // Async policy reads cannot revive an expired/retired request.
    if (this.pending.get(id) !== p || p.command.expiresAt <= Date.now()) return null;
    if (!allowed) { p.finish({ error: 'BROWSER_PERMISSION_REVOKED: request was not dispatched.' }); return null; }
    // Only the bridge supplies these proofs from the canonical request index. A browser's
    // held-owner hints never authorize another session or the legacy anonymous principal.
    const aliases = [...new Set(ownerProofs.slice(0, 32)
      .filter(proof => proof.owner.startsWith('request:') && `session:${proof.sessionId}` === p.command.owner)
      .map(proof => proof.owner))];
    if (aliases.length) p.command.ownerAliases = aliases;
    p.claimed = true;
    return p.command;
  }

  result(browserId: string, id: string, epoch: string, result: BrowserResult): boolean {
    const p = this.pending.get(id);
    if (!p || p.browserId !== browserId || epoch !== this.epoch || !p.claimed) return false;
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > BROWSER_LIMITS.resultBytes) {
      p.finish({ error: 'BROWSER_RESULT_TOO_LARGE: operation may have completed; inspect before repeating it.' });
    } else p.finish(result);
    return true;
  }

  async check(browserId: string, id: string, epoch: string): Promise<boolean> {
    const p = this.pending.get(id);
    if (!p || p.browserId !== browserId || epoch !== this.epoch || !p.claimed) return false;
    const allowed = await p.allowed().catch(() => false);
    return allowed && this.pending.get(id) === p && p.command.expiresAt > Date.now();
  }

  async execute(tool: BrowserTool, input: Record<string, unknown>, owner: string, conversationId: string | null,
    allowed: () => Promise<boolean>): Promise<BrowserResult> {
    const args = { ...input };
    const browsers = this.browsers();
    let browserId = typeof args.browserId === 'string' ? args.browserId : undefined;
    if (typeof args.tabId === 'string') {
      const match = tabHandle.exec(args.tabId);
      if (!match || !Number.isSafeInteger(Number(match[2]))) return { error: 'BROWSER_TAB_INVALID: use a tabId returned by browser_tabs.' };
      browserId = match[1]!;
      args.tabId = Number(match[2]);
    }
    if (!browserId) {
      if (browsers.length !== 1) return tool === 'browser_tabs' && args.action === 'list'
        ? { value: { browsers, tabs: [], message: browsers.length ? 'Choose browserId to list its tabs.' : 'Open Chrome with the companion extension connected.' } }
        : { error: 'BROWSER_REQUIRED: list browsers, then specify the returned browserId.' };
      browserId = browsers[0]!.id;
    }
    const client = browsers.find(b => b.id === browserId);
    if (!client) return { error: 'BROWSER_OFFLINE: this browser incarnation is no longer connected. List browsers again.' };
    if (!client.enabled) return { error: 'BROWSER_EXTENSION_PERMISSION: Chrome must grant the companion its debugger and tabs permissions. Reload/update the extension.' };
    if (this.pending.size >= BROWSER_LIMITS.pending) return { error: 'BROWSER_BUSY: too many pending requests; no operation was dispatched.' };
    delete args.browserId;
    const id = randomUUID();
    const command: BrowserCommand = { id, epoch: this.epoch, owner, conversationId, tool, args, expiresAt: Date.now() + BROWSER_LIMITS.timeoutMs };
    return new Promise(resolve => {
      const timer = setTimeout(() => p.finish({ error: p.claimed
        ? 'BROWSER_RESULT_UNCONFIRMED: the operation was dispatched but its result was not received. Inspect the tab before repeating any action.'
        : 'BROWSER_NOT_DISPATCHED: the extension did not claim this request before its deadline.' }), BROWSER_LIMITS.timeoutMs);
      timer.unref?.();
      const p: Pending = { browserId, command, claimed: false, claiming: false, allowed, finish: result => {
        if (this.pending.get(id) !== p) return;
        this.pending.delete(id); clearTimeout(timer);
        resolve(result);
      } };
      this.pending.set(id, p);
      this.wake();
    });
  }

  reset(): void {
    for (const p of this.pending.values()) p.finish({ error: p.claimed
      ? 'BROWSER_RESULT_UNCONFIRMED: bridge stopped after dispatch. Inspect before repeating the operation.'
      : 'BROWSER_NOT_DISPATCHED: bridge stopped.' });
    this.clients.clear(); this.epoch = randomUUID();
  }
}

export const browserControl = new BrowserControlBroker();
