/**
 * Proof, kept across restarts, that ChatGPT has really used each connector.
 *
 * The live clocks in the MCP server and kernel answer "has ChatGPT reached this app *since it
 * started*", which is right for status but wrong for Setup: a user whose plugin has worked for
 * weeks would see its step pending, and never the end of setup, after every restart until the
 * next tool call. This keeps the newest evidence per connector together with the tunnel it came
 * through. The plugin in ChatGPT points at that tunnel, so evidence for another tunnel (a new
 * one, or another setup profile) proves nothing about the current one and is not reported.
 *
 * Besides use, it keeps the plain fact that the plugin exists in ChatGPT, read from ChatGPT itself:
 * its plugin list names the Core plugin, and its plugin page let the refresh feature enroll a
 * connector. So Setup is done once the plugin is there, without asking for a test message.
 *
 * A quick Cloudflare tunnel gets a new address every run, so it can carry no lasting proof.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { logWarn } from './logger.js';
import type { Config, SurfaceId } from '../shared/types.js';

type Proof = { tunnel: string; requestAt: number | null; toolCallAt: number | null; installedAt: number | null };

/** Evidence is refreshed on disk at most this often; the live clocks keep the exact time. */
const REFRESH_MS = 10 * 60_000;

let filePath = '';
const proofs = new Map<SurfaceId, Proof>();
const listeners = new Set<() => void>();

export function onConnectorProofChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
let writing: Promise<void> = Promise.resolve();
let pending = false;

/** The tunnel a connector reaches this app through, as ChatGPT knows it; null when it cannot last. */
export function connectorTunnelKey(config: Pick<Config, 'tunnel'>, surface: SurfaceId): string | null {
  const { tunnel } = config;
  const profile = tunnel.profileId ?? 'default';
  if (tunnel.kind === 'openai') {
    const id = (surface === 'desktop' ? tunnel.desktopTunnelId : tunnel.tunnelId)?.trim() ?? '';
    return id ? `openai:${profile}:${id}` : null;
  }
  if (tunnel.kind === 'manual') return `manual:${profile}:${surface}`;
  return null;
}

export function initConnectorProofPath(userDataDir: string): void {
  filePath = path.join(userDataDir, 'connector-proof.json');
}

export async function loadConnectorProof(): Promise<void> {
  proofs.clear();
  if (!filePath) return;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { surfaces?: Record<string, unknown> };
    for (const [surface, value] of Object.entries(parsed.surfaces ?? {})) {
      const proof = value as Partial<Proof>;
      const time = (at: unknown) => (typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null);
      if (typeof proof.tunnel !== 'string' || !proof.tunnel) continue;
      proofs.set(surface as SurfaceId, { tunnel: proof.tunnel, requestAt: time(proof.requestAt), toolCallAt: time(proof.toolCallAt), installedAt: time(proof.installedAt) });
    }
  } catch (error) {
    // Missing on a first run; anything unreadable is only lost evidence, never a wrong answer.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logWarn(`Connector proof unreadable: ${(error as Error).message}`);
  }
}

function persist(): void {
  if (!filePath || pending) return;
  pending = true;
  writing = writing.then(async () => {
    pending = false;
    const surfaces = Object.fromEntries(proofs);
    const temporary = `${filePath}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, surfaces }), 'utf8');
      await fs.rename(temporary, filePath);
    } catch (error) {
      logWarn(`Connector proof not saved: ${(error as Error).message}`);
    }
  });
}

/** Records that ChatGPT reached (`request`) or ran a tool on (`tool`) this connector just now. */
export function noteConnectorUse(surface: SurfaceId, kind: 'request' | 'tool', at = Date.now()): void {
  const tunnel = connectorTunnelKey(getConfig(), surface);
  if (!tunnel) return;
  const known = proofs.get(surface);
  const proof: Proof = known && known.tunnel === tunnel ? { ...known } : { tunnel, requestAt: null, toolCallAt: null, installedAt: null };
  const field = kind === 'request' ? 'requestAt' : 'toolCallAt';
  const before = proof[field];
  proof[field] = at;
  // A tool call is also a request: ChatGPT cannot run one without reaching the connector.
  if (kind === 'tool' && (proof.requestAt === null || proof.requestAt < at)) proof.requestAt = at;
  proofs.set(surface, proof);
  if (before === null || at - before >= REFRESH_MS || known?.tunnel !== tunnel) persist();
  if (before === null || known?.tunnel !== tunnel) for (const listener of listeners) listener();
}

/**
 * Records that ChatGPT has this connector's plugin installed, as ChatGPT itself reported it. Only
 * the first sighting on a tunnel is kept: the plugin's existence, not how often it was seen.
 */
export function notePluginInstalled(surface: SurfaceId, at = Date.now()): void {
  const tunnel = connectorTunnelKey(getConfig(), surface);
  if (!tunnel) return;
  const known = proofs.get(surface);
  if (known && known.tunnel === tunnel && known.installedAt !== null) return;
  const proof: Proof = known && known.tunnel === tunnel ? { ...known } : { tunnel, requestAt: null, toolCallAt: null, installedAt: null };
  proof.installedAt = at;
  proofs.set(surface, proof);
  persist();
  for (const listener of listeners) listener();
}

/**
 * ChatGPT's complete plugins list no longer has this connector's plugin: it was deleted or
 * disconnected there. That outranks everything earlier runs saw, so the proof for the current
 * tunnel goes; a request or tool call in this run records it again.
 */
export function notePluginMissing(surface: SurfaceId): void {
  const tunnel = connectorTunnelKey(getConfig(), surface);
  const known = proofs.get(surface);
  if (!tunnel || !known || known.tunnel !== tunnel) return;
  proofs.delete(surface);
  persist();
  for (const listener of listeners) listener();
}

/** The newest lasting evidence for this connector on the tunnel it uses now, or null. */
export function connectorProof(surface: SurfaceId): { requestAt: number | null; toolCallAt: number | null; installedAt: number | null } | null {
  const proof = proofs.get(surface);
  const tunnel = connectorTunnelKey(getConfig(), surface);
  if (!proof || !tunnel || proof.tunnel !== tunnel) return null;
  return { requestAt: proof.requestAt, toolCallAt: proof.toolCallAt, installedAt: proof.installedAt };
}

/** For tests: wait for the file to settle. */
export function connectorProofWritten(): Promise<void> {
  return writing;
}
