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
import type { McpClientIdentity } from '../shared/session.js';

type Proof = { tunnel: string; requestAt: number | null; toolCallAt: number | null; installedAt: number | null };
export interface ExternalClientProof {
  id: string;
  name: string;
  version?: string;
  surfaces: SurfaceId[];
  requestAt: number;
  toolCallAt: number | null;
}

/** Evidence is refreshed on disk at most this often; the live clocks keep the exact time. */
const REFRESH_MS = 10 * 60_000;
/** External client reminders expire after 14 days of inactivity. */
const EXTERNAL_CLIENT_TTL_MS = 14 * 24 * 60 * 60_000;
const VALID_SURFACES = new Set<SurfaceId>(['core', 'desktop', 'plugins']);

let filePath = '';
const proofs = new Map<SurfaceId, Proof>();
const externalProofs = new Map<string, ExternalClientProof>();
const listeners = new Set<() => void>();

function validClientId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(value);
}

function validClientName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 48 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validClientVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validSurfaceList(value: unknown): SurfaceId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<SurfaceId>();
  for (const item of value) {
    if (typeof item === 'string' && VALID_SURFACES.has(item as SurfaceId)) seen.add(item as SurfaceId);
  }
  return [...seen];
}

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
    // Each connector has its own Secure Tunnel ID; Plugins never falls back to Core's (connection.ts).
    const id = (surface === 'desktop' ? tunnel.desktopTunnelId : surface === 'plugins' ? tunnel.pluginsTunnelId : tunnel.tunnelId)?.trim() ?? '';
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
  externalProofs.clear();
  if (!filePath) return;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      surfaces?: Record<string, unknown>;
      externalClients?: Record<string, unknown>;
    };
    const time = (at: unknown) => (typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null);
    for (const [surface, value] of Object.entries(parsed.surfaces ?? {})) {
      const proof = value as Partial<Proof>;
      if (typeof proof.tunnel !== 'string' || !proof.tunnel) continue;
      proofs.set(surface as SurfaceId, { tunnel: proof.tunnel, requestAt: time(proof.requestAt), toolCallAt: time(proof.toolCallAt), installedAt: time(proof.installedAt) });
    }
    const cutoff = Date.now() - EXTERNAL_CLIENT_TTL_MS;
    for (const value of Object.values(parsed.externalClients ?? {})) {
      const raw = value as Partial<ExternalClientProof>;
      const requestAt = time(raw.requestAt);
      if (!validClientId(raw.id) || !validClientName(raw.name) || requestAt === null || requestAt < cutoff) continue;
      const version = validClientVersion(raw.version) ? raw.version : undefined;
      const surfaces = validSurfaceList(raw.surfaces);
      externalProofs.set(raw.id, {
        id: raw.id,
        name: raw.name,
        ...(version ? { version } : {}),
        surfaces: surfaces.length ? surfaces : ['core'],
        requestAt,
        toolCallAt: time(raw.toolCallAt)
      });
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
    const externalClients = Object.fromEntries(externalProofs);
    const temporary = `${filePath}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, surfaces, externalClients }), 'utf8');
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

/** Records that a recognized external MCP client (such as Gemini or Claude) reached or called a tool. */
export function noteExternalClientUse(
  identity: McpClientIdentity,
  surface: SurfaceId,
  kind: 'request' | 'tool',
  at = Date.now()
): void {
  if (!validClientId(identity.id) || !validClientName(identity.name)) return;
  const version = validClientVersion(identity.version) ? identity.version : undefined;
  const known = externalProofs.get(identity.id);
  if (!known) {
    while (externalProofs.size >= 32) {
      const oldest = externalProofs.keys().next().value;
      if (oldest === undefined) break;
      externalProofs.delete(oldest);
    }
    externalProofs.set(identity.id, {
      id: identity.id,
      name: identity.name,
      ...(version ? { version } : {}),
      surfaces: [surface],
      requestAt: at,
      toolCallAt: kind === 'tool' ? at : null
    });
    persist();
    for (const listener of listeners) listener();
    return;
  }

  const prevRequest = known.requestAt;
  const prevTool = known.toolCallAt;
  const addedSurface = !known.surfaces.includes(surface);
  const changedVersion = Boolean(version && version !== known.version);
  const surfaces = addedSurface ? [...known.surfaces, surface] : known.surfaces;
  const next: ExternalClientProof = {
    id: identity.id,
    name: identity.name,
    ...(version ?? known.version ? { version: version ?? known.version } : {}),
    surfaces,
    requestAt: Math.max(prevRequest, at),
    toolCallAt: kind === 'tool' ? Math.max(prevTool ?? 0, at) : prevTool
  };
  externalProofs.delete(identity.id);
  externalProofs.set(identity.id, next);
  if (addedSurface || changedVersion || (kind === 'tool' && prevTool === null) || at - prevRequest >= REFRESH_MS) {
    persist();
  }
  if (addedSurface || changedVersion || (kind === 'tool' && prevTool === null)) {
    for (const listener of listeners) listener();
  }
}

/** Remembered external MCP clients seen within the retention window, newest first. */
export function externalClientProofs(now = Date.now()): ExternalClientProof[] {
  const cutoff = now - EXTERNAL_CLIENT_TTL_MS;
  return [...externalProofs.values()]
    .filter((entry) => entry.requestAt >= cutoff)
    .map((entry) => ({ ...entry, surfaces: [...entry.surfaces] }))
    .sort((a, b) => b.requestAt - a.requestAt);
}

/** For tests: wait for the file to settle. */
export function connectorProofWritten(): Promise<void> {
  return writing;
}

/** Clear in-memory connector proofs between unit tests. */
export function resetConnectorProofsForTests(): void {
  proofs.clear();
  externalProofs.clear();
}
