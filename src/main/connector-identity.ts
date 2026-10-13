/**
 * Which ChatGPT apps are this install's own connectors, learned only from proof.
 *
 * ChatGPT keeps an app's ID when the user renames it (asdk_app_… and link_… unchanged; measured
 * 2026-10-11 on a renamed Core). The MCP request carries no app ID, but the page's stored result row
 * does, next to the request ID that reached us. A sighting teaches an identity only when that request
 * ID was served by this app's own endpoint, so another computer's connectors, another person's apps
 * and history from before a restart can never be learned.
 */
import { readDurable, writeDurableSoon } from './durable.js';
import type { SurfaceId } from './mcp/surfaces.js';

export type AppSighting = { requestId: string; appId: string; linkId: string | null; appName: string | null };
/** `nameAt`: when the conversation that showed `name` started; ChatGPT freezes an app's name per chat. */
export type LearnedApp = { appId: string; linkId: string | null; name: string | null; seenAt: number; nameAt: number };

const STATE = 'connector-identity';
const SERVED_MAX = 4096;
const SERVED_TTL_MS = 24 * 3600_000;
const APPS_PER_SURFACE = 4;
const SURFACES: readonly SurfaceId[] = ['core', 'desktop', 'plugins'];
const APP_ID = /^asdk_app_[A-Za-z0-9_-]{1,160}$/;
const LINK_ID = /^link_[A-Za-z0-9_-]{1,160}$/;

const served = new Map<string, { surface: SurfaceId; at: number }>();
let learned: Record<SurfaceId, LearnedApp[]> = { core: [], desktop: [], plugins: [] };

/** One printable line of at most 64 characters, or null. */
export function cleanAppName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length > 0 && name.length <= 64 ? name : null;
}

/**
 * When a ChatGPT conversation was created, from its id: the first eight hex digits are that second
 * (chat 6acb3e79-… was created 2026-10-11 07:44:57 UTC). Null for anything outside ChatGPT's
 * lifetime, so a fixture or another id format never claims to be newest.
 */
export function conversationCreatedAt(conversationId: string, now = Date.now()): number | null {
  const match = /^([0-9a-f]{8})-[0-9a-f]{4}-/i.exec(conversationId);
  if (!match) return null;
  const at = parseInt(match[1]!, 16) * 1000;
  return at >= Date.UTC(2022, 10, 30) && at <= now + 86_400_000 ? at : null;
}

export function noteServedRequest(requestId: string | null, surface: SurfaceId, at = Date.now()): void {
  if (!requestId) return;
  served.delete(requestId);
  served.set(requestId, { surface, at });
  while (served.size > SERVED_MAX) served.delete(served.keys().next().value!);
}

/**
 * `nameAt` is when the reporting conversation started: a chat keeps the app name it began with
 * (measured 2026-10-11), so a name only replaces one taught by a chat that started no later.
 */
export function noteAppSightings(sightings: readonly AppSighting[], at = Date.now(), nameAt = at): boolean {
  const byRequest = new Map<string, AppSighting | null>();
  for (const sighting of sightings) {
    if (!sighting || !APP_ID.test(sighting.appId) || (sighting.linkId !== null && !LINK_ID.test(sighting.linkId))) continue;
    const prior = byRequest.get(sighting.requestId);
    byRequest.set(sighting.requestId, prior === undefined || (prior && prior.appId === sighting.appId) ? sighting : null);
  }
  let changed = false;
  for (const [requestId, sighting] of byRequest) {
    const proof = served.get(requestId);
    if (!sighting || !proof || at - proof.at > SERVED_TTL_MS) continue;
    const list = learned[proof.surface];
    const prior = list.find(app => app.appId === sighting.appId);
    const name = cleanAppName(sighting.appName);
    const keepPrior = prior && prior.name !== null && (name === null || prior.nameAt > nameAt);
    const entry: LearnedApp = { appId: sighting.appId, linkId: sighting.linkId ?? prior?.linkId ?? null,
      name: keepPrior ? prior.name : name, seenAt: at, nameAt: keepPrior ? prior.nameAt : nameAt };
    const rest = list.filter(app => app.appId !== entry.appId);
    const next = [entry, ...rest].slice(0, APPS_PER_SURFACE);
    const shape = (apps: LearnedApp[]) => JSON.stringify(apps.map(app => [app.appId, app.linkId, app.name]));
    if (shape(next) !== shape(list)) changed = true;
    learned = { ...learned, [proof.surface]: next };
  }
  if (changed) writeDurableSoon(STATE, learned);
  return changed;
}

export function connectorApps(): Record<SurfaceId, LearnedApp[]> {
  return { core: [...learned.core], desktop: [...learned.desktop], plugins: [...learned.plugins] };
}

/** The name ChatGPT currently shows for this surface's most recently proven app, if known. */
export function learnedConnectorName(surface: SurfaceId): string | null {
  return learned[surface][0]?.name ?? null;
}

export async function loadConnectorIdentity(): Promise<void> {
  const raw = await readDurable<Record<string, unknown>>(STATE);
  const next: Record<SurfaceId, LearnedApp[]> = { core: [], desktop: [], plugins: [] };
  for (const surface of SURFACES) {
    const list = Array.isArray(raw?.[surface]) ? raw![surface] as unknown[] : [];
    for (const item of list.slice(0, APPS_PER_SURFACE)) {
      const app = item as Partial<LearnedApp>;
      if (typeof app?.appId !== 'string' || !APP_ID.test(app.appId)) continue;
      next[surface].push({
        appId: app.appId,
        linkId: typeof app.linkId === 'string' && LINK_ID.test(app.linkId) ? app.linkId : null,
        name: cleanAppName(app.name),
        seenAt: Number.isFinite(app.seenAt) ? Number(app.seenAt) : 0,
        nameAt: Number.isFinite(app.nameAt) ? Number(app.nameAt) : 0
      });
    }
  }
  learned = next;
}

export function resetConnectorIdentityForTests(): void {
  served.clear();
  learned = { core: [], desktop: [], plugins: [] };
}
