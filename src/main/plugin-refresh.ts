import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDurable, writeDurableNow, durableRevision } from './durable.js';
import { wakeBrowserWork } from './browser-wake.js';
import { logInfo, logWarn } from './logger.js';
import { getConfig } from './config.js';
import { notePluginInstalled, connectorTunnelKey } from './connector-proof.js';
import { surfaceDefinition } from './mcp/surfaces.js';
import { APP_VERSION } from './version.js';
import { PLUGIN_MAX_TOOLS } from './plugins/exposure.js';
import type { PluginPublication, PluginRefreshRequest, PluginRefreshStatus, PluginSurface, PluginToolSchema } from '../shared/plugin-refresh.js';

const app = z.string().regex(/^asdk_app_[a-zA-Z0-9_-]{1,160}$/);
const LEGACY_PLUGIN_MAX_TOOLS = 64;
const requestedVersion = z.string().regex(/^\d+\.\d+\.\d+$/).optional();
const rowSchema = z.object({ surface: z.enum(['core', 'desktop', 'plugins']), schemaId: z.string(), id: z.string().uuid(), appId: app.nullable(), completedSchemaId: z.string().nullable(), attempted: z.boolean(), manual: z.boolean().optional().default(false), error: z.string().max(200).optional(), versionId: z.string().max(200).optional(), failures: z.number().int().nonnegative().optional(), parked: z.boolean().optional(), parkedBy: z.string().max(40).optional(), tunnelKey: z.string().optional(), verifiedRun: z.string().optional(), observe: z.boolean().optional().default(false), requestedVersion, requestedFromVersion: requestedVersion }).refine(row => !!row.requestedVersion === !!row.requestedFromVersion);
type Row = z.infer<typeof rowSchema>;
const publications = new Map<PluginSurface, PluginPublication>();
const publicationScopes = new Map<PluginSurface, string>();
const responding = new Map<PluginSurface, PluginPublication>();
const runId = randomUUID();
const scope = (surface: PluginSurface) => connectorTunnelKey(getConfig(), surface) ?? `unbound:${getConfig().tunnel.kind}:${getConfig().tunnel.profileId ?? 'default'}:${surface}`;
function currentPublication(surface: PluginSurface): PluginPublication | undefined {
  return publicationScopes.get(surface) === scope(surface) ? publications.get(surface) : undefined;
}
const listeners = new Set<() => void>();
export function onPluginRefreshChange(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
function changed(): void { for (const listener of listeners) listener(); }
/** Only a successful external call under the same publication and connection can confirm use. */
export function beginPluginToolCall(surface: PluginSurface): () => void {
  const publication = currentPublication(surface), tunnelKey = scope(surface);
  return () => {
    if (!publication || publications.get(surface) !== publication || publicationScopes.get(surface) !== tunnelKey || scope(surface) !== tunnelKey || responding.get(surface) === publication) return;
    responding.set(surface, publication); changed();
  };
}
type SavedRows = { revision: number; value: Promise<Row[]>; rows?: Row[]; failed?: boolean };
let savedCache: SavedRows | null = null;
const settling = new Map<PluginSurface, { schemaId: string; readyAt: number; timer?: ReturnType<typeof setTimeout> }>();
export const PLUGIN_REFRESH_DEBOUNCE_MS = 20_000;
/**
 * How long a surface's tunnel must have been live before its refresh is handed to the browser.
 *
 * Measured 2026-09-27: a Refresh clicked about 4 s after the Desktop tunnel (re)connected never
 * reached this app (no MCP request at all; 3 of 3 app starts), so ChatGPT kept the old tools and
 * the attempt was recorded as clicked. Clicks about 20 s after connecting, and at runtime,
 * arrived every time.
 */
export const PLUGIN_REFRESH_TUNNEL_GRACE_MS = 30_000;
let tunnelGraceMs = PLUGIN_REFRESH_TUNNEL_GRACE_MS;
/**
 * Pre-claim failures one schema may spend before automatic browser maintenance stops.
 *
 * A failure before the claim was treated as free to repeat, and on the newer ChatGPT shell it
 * always repeats: the settings page has no card this build can read. Measured 2026-09-26, one
 * request pending since 07:24 kept its helper page coming back, and every lost owner record
 * (extension restart, reload that dropped the marker) opened another tab. Parking keeps the
 * reason visible; a new schema, an explicit Restart or an app update tries again.
 */
export const PLUGIN_REFRESH_FAILURE_LIMIT = 3;
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> { const result = chain.then(work, work); chain = result.catch(() => undefined); return result; }
async function savedRows(retryFailed = false): Promise<Row[]> {
  const revision = durableRevision('plugin-refresh');
  if (savedCache?.revision !== revision || (retryFailed && savedCache.failed)) {
    const entry: SavedRows = { revision, value: Promise.resolve([]) };
    entry.value = (async () => {
      const result = z.array(rowSchema).max(3).parse(await readDurable('plugin-refresh', { strict: true }) ?? []);
      if (new Set(result.map(row => row.surface)).size !== result.length) throw new Error('Duplicate plugin surface mapping');
      entry.rows = result;
      return result;
    })().catch(error => { entry.failed = true; throw error; });
    savedCache = entry;
  }
  return structuredClone(await savedCache.value);
}
async function save(current: Row[]): Promise<void> {
  await writeDurableNow('plugin-refresh', current);
  const snapshot = structuredClone(current);
  savedCache = { revision: durableRevision('plugin-refresh'), value: Promise.resolve(snapshot), rows: snapshot };
}
async function rows(retryFailed = false): Promise<Row[]> {
  const result = await savedRows(retryFailed);
  // Legacy fail() marked discovery failures as clicks. A real claim always commits a
  // concrete appId, so null proves these rows never crossed the refresh boundary.
  let repaired = false;
  for (const row of result) if (row.attempted && row.appId === null) {
    row.attempted = false; delete row.error; repaired = true;
  }
  // A park records what this build could not do. Every row parked on 2026-09-26/27 failed
  // because the extension could not read ChatGPT's new plugin page, and without a schema change
  // or a manual Restart the update that learned to read it would never have been tried.
  for (const row of result) if (row.parked && row.parkedBy !== APP_VERSION) {
    row.id = randomUUID(); delete row.parked; delete row.parkedBy; delete row.failures; delete row.error; repaired = true;
    logInfo(`plugin refresh unparked surface=${row.surface} for app ${APP_VERSION}`);
  }
  if (repaired) await save(result);
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const declaration = (tools: PluginToolSchema[]) => tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })).sort((a, b) => a.name.localeCompare(b.name));
function recognizable(tools: unknown, surface: PluginSurface = 'core'): tools is PluginToolSchema[] {
  // The registrar can append one local exec tool to the bounded upstream catalog.
  if (!Array.isArray(tools) || (!tools.length && surface !== 'plugins') || tools.length > (surface === 'plugins' ? PLUGIN_MAX_TOOLS + 1 : 16) || JSON.stringify(tools).length > 300000) return false;
  if (tools.some(tool => !tool || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object')) return false;
  return tools.every(tool => tool.inputSchema.type === 'object') && new Set(tools.map(tool => tool.name)).size === tools.length;
}
function enrollable(tools: unknown, publication: PluginPublication): boolean {
  if (!recognizable(tools, publication.surface)) return false;
  const names = (items: PluginToolSchema[]) => canonical(items.map(tool => tool.name).sort());
  if (names(tools) === names(publication.tools)) return true;
  // Older releases could publish only the first 64 external tools even when the
  // complete catalog fit within the byte budget. During first enrollment, accept
  // that stale Plugins subset (plus optional local exec) only when every installed declaration is an exact
  // declaration from the current publication. A foreign or changed tool still
  // fails closed, and completion below still requires the complete new catalog.
  const legacyCount = tools.length === LEGACY_PLUGIN_MAX_TOOLS ||
    (tools.length === LEGACY_PLUGIN_MAX_TOOLS + 1 && tools.some(tool => tool.name === 'exec'));
  if (publication.surface === 'plugins' && legacyCount && publication.tools.length > tools.length) {
    const expected = new Map(publication.tools.map(tool => [tool.name, hash(declaration([tool]))]));
    return tools.every(tool => expected.get(tool.name) === hash(declaration([tool])));
  }
  // Enabling or disabling Core capabilities can change the set before enrollment.
  // Two unchanged full declarations identify the older known surface; names alone
  // do not, and a foreign tool cannot join that evidence through a matching name.
  // Retired names identify an old schema only; they are never registered, and
  // completion still requires the exact current declaration set.
  return publication.surface === 'core' && tools.every(tool => surfaceDefinition('core').tools.includes(tool.name) || tool.name === 'keep_astra_on_forever' || tool.name === 'session') &&
    tools.filter(tool => publication.tools.some(expected => hash(declaration([tool])) === hash(declaration([expected])))).length >= 2;
}
function matches(tools: unknown, expected: PluginToolSchema[], surface: PluginSurface = 'core'): boolean {
  return recognizable(tools, surface) && hash(declaration(tools)) === hash(declaration(expected));
}
/** Refresh can invalidate existing ChatGPT chats. Only a changed visible tool contract warrants it. */
export function publishPluginSurface(surface: PluginSurface, connectorName: string, _version: string, _instructions: string, tools: PluginToolSchema[]): void {
  const candidate = { surface, connectorName, tools, schemaId: hash(declaration(tools)) };
  const existing = publications.get(surface), tunnelKey = scope(surface);
  const restored = !existing || publicationScopes.get(surface) !== tunnelKey;
  const publication = existing?.schemaId === candidate.schemaId && existing.connectorName === connectorName && publicationScopes.get(surface) === tunnelKey ? existing : candidate;
  publicationScopes.set(surface, tunnelKey);
  if (existing !== publication) responding.delete(surface);
  const previous = settling.get(surface);
  const changed = previous?.schemaId !== publication.schemaId;
  publications.set(surface, publication);
  const due = (next: { readyAt: number; timer?: ReturnType<typeof setTimeout> }, delayMs: number) => {
    if (next.timer) clearTimeout(next.timer);
    next.timer = undefined;
    if (delayMs <= 0) { wakeBrowserWork(); return; }
    next.timer = setTimeout(() => {
      next.timer = undefined;
      logInfo(`plugin refresh due surface=${surface} schema=${publication.schemaId.slice(0, 12)} published=${publications.has(surface)}`);
      if (publications.has(surface)) wakeBrowserWork();
    }, delayMs);
    next.timer.unref();
  };
  // A surface that just came live is published at once but handed out only after its tunnel grace.
  const graceUntil = restored ? Date.now() + tunnelGraceMs : 0;
  if (changed) {
    if (previous?.timer) clearTimeout(previous.timer);
    // Changes to an existing declaration wait for the last tool-shape edit, including edits
    // that reconnect the endpoint; initial enrollment waits only for the tunnel grace.
    const readyAt = Math.max(previous ? Date.now() + PLUGIN_REFRESH_DEBOUNCE_MS : 0, graceUntil);
    const next = { schemaId: publication.schemaId, readyAt, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    settling.set(surface, next);
    const delayMs = Math.max(0, readyAt - Date.now());
    logInfo(`plugin refresh scheduled surface=${surface} schema=${publication.schemaId.slice(0, 12)} delayMs=${delayMs}`);
    due(next, delayMs);
  } else if (restored) {
    // A reconnect can outlast the debounce. Its timer intentionally skipped the absent surface;
    // restoring that same declaration must deliver the wake, after the new tunnel's grace.
    previous.readyAt = Math.max(previous.readyAt, graceUntil);
    due(previous, Math.max(0, previous.readyAt - Date.now()));
  }
}
export function unpublishPluginSurface(surface: PluginSurface): void { publications.delete(surface); publicationScopes.delete(surface); responding.delete(surface); }
/** The connectors whose plugin ChatGPT's own plugin page showed this app: they exist in ChatGPT. */
export async function enrolledPluginSurfaces(): Promise<PluginSurface[]> {
  try { return (await rows()).filter(row => row.appId !== null && row.tunnelKey === scope(row.surface)).map(row => row.surface); }
  catch { return []; }
}
export function pluginRefreshPublications(): PluginPublication[] { return structuredClone([...publications.values()].filter(publication => currentPublication(publication.surface) === publication)); }
/** Status hints grant no new work; explicit requests are exact-version and schema scoped. */
export async function authorizedPluginRefreshPublications(automatic: boolean): Promise<PluginPublication[]> {
  if (automatic) return pluginRefreshPublications();
  try {
    const current = await savedRows();
    return pluginRefreshPublications().filter(publication => current.some(row => row.surface === publication.surface &&
      row.tunnelKey === scope(row.surface) && row.requestedVersion === APP_VERSION && (row.schemaId === publication.schemaId || row.requestedFromVersion !== APP_VERSION)));
  } catch { return []; }
}
export async function hasRequestedPluginRefresh(): Promise<boolean> {
  try {
    const current = await savedRows();
    return current.some(row => row.tunnelKey === scope(row.surface) && row.requestedVersion === APP_VERSION && (row.requestedFromVersion !== APP_VERSION || row.observe ||
      (!row.attempted && !row.manual && !row.parked && row.completedSchemaId !== row.schemaId)));
  } catch { return false; }
}
/** Reading update status must not create refresh debt, repair rows or wake a browser. */
export function pluginRefreshStatuses(): Promise<Partial<Record<PluginSurface, PluginRefreshStatus>>> {
  return (async () => {
    let current: Row[] = [];
    try {
      current = await savedRows();
    } catch { /* Unreadable evidence is unknown, never a successful refresh. */ }
    return Object.fromEntries([...publications.values()].map(publication => {
      const row = currentPublication(publication.surface) === publication ? current.find(candidate => candidate.surface === publication.surface && candidate.tunnelKey === scope(publication.surface)) : undefined;
      const state: PluginRefreshStatus['state'] = !row ? 'unknown'
        : row.schemaId !== publication.schemaId ? 'pending'
        : row.manual ? 'manual'
        : row.parked || row.error ? 'failed'
        : row.appId && row.completedSchemaId === publication.schemaId ? (!row.tunnelKey?.startsWith('unbound:') || row.verifiedRun === runId ? 'current' : 'unknown')
        : row.attempted && row.appId ? 'refreshing' : 'pending';
      return [publication.surface, { schemaId: publication.schemaId, state,
        ...(state === 'failed' ? { failure: row?.attempted && row.appId ? 'confirmation' : 'inspection' } : {}),
        ...(responding.get(publication.surface) === publication && publicationScopes.get(publication.surface) === scope(publication.surface) ? { responding: true } : {}) }];
    }));
  })();
}
/** One fresh browser attempt after an explicit Restart, only before any Refresh claim. */
export function rearmPluginRefresh(surface: PluginSurface): Promise<boolean> {
  return serial(async () => {
    const current = await rows(true);
    const publication = currentPublication(surface);
    const row = current.find(candidate => candidate.surface === surface);
    if (!publication || !row || row.tunnelKey !== scope(surface) || row.schemaId !== publication.schemaId || row.attempted || row.manual || row.completedSchemaId === row.schemaId) return false;
    row.id = randomUUID();
    delete row.error;
    delete row.failures;
    delete row.parked;
    delete row.parkedBy;
    await save(current);
    wakeBrowserWork();
    return true;
  });
}
/**
 * Per surface, the declaration ChatGPT confirmed after a refresh click or found already current.
 * Synchronous for state pushes; the first call loads the records once in the background.
 */
export function confirmedPluginSchemas(): Partial<Record<PluginSurface, string>> {
  const revision = durableRevision('plugin-refresh');
  if (savedCache?.revision !== revision) void savedRows().then(changed).catch(() => undefined);
  return Object.fromEntries((savedCache?.rows ?? []).flatMap(row =>
    row.tunnelKey === scope(row.surface) && row.appId && row.completedSchemaId && !row.manual && !row.error && !row.parked &&
    (!row.tunnelKey.startsWith('unbound:') || row.verifiedRun === runId) ? [[row.surface, row.completedSchemaId]] : []));
}
/** App IDs are stable connector identities. The browser must prove current installation. */
function reconcileRows(current: Row[]): boolean {
  let changed = false;
  for (const publication of publications.values()) {
    if (currentPublication(publication.surface) !== publication) continue;
    const stored = current.find(row => row.surface === publication.surface);
    const found = stored?.tunnelKey === scope(publication.surface) ? stored : undefined;
    if (found?.schemaId === publication.schemaId) {
      if (found.requestedVersion === APP_VERSION && found.requestedFromVersion !== APP_VERSION) {
        found.requestedFromVersion = APP_VERSION; changed = true;
      }
      continue;
    }
    // A click for `found` that never confirmed its outcome leaves ChatGPT's schema unknown: it may
    // hold that newer schema, so the older completion no longer says what ChatGPT has. Measured
    // 2026-09-27: 11 -> 8 tools clicked, app quit before completion, back to 11 was then taken
    // as already current while ChatGPT showed 8.
    const unconfirmed = found?.attempted === true && found.completedSchemaId !== found.schemaId;
    const next: Row = { surface: publication.surface, tunnelKey: scope(publication.surface), observe: false, schemaId: publication.schemaId, id: randomUUID(), appId: found?.appId ?? null, completedSchemaId: unconfirmed ? null : found?.completedSchemaId ?? null, verifiedRun: unconfirmed ? undefined : found?.verifiedRun, attempted: false, manual: false };
    // A requested app update may introduce new schemas on restart. Adopt those once; a later
    // settings edit in the same build must not borrow Update all's one-shot authorization.
    if (found?.requestedVersion && (!found.schemaId || found.requestedVersion !== APP_VERSION || found.requestedFromVersion !== APP_VERSION)) {
      next.requestedVersion = found.requestedVersion;
      next.requestedFromVersion = found.requestedVersion === APP_VERSION ? APP_VERSION : found.requestedFromVersion;
    }
    if (stored) current[current.indexOf(stored)] = next; else current.push(next);
    changed = true;
  }
  return changed;
}
/** An explicit round does not enable the automatic preference or retry an ambiguous click. */
export function requestPluginRefreshes(version: string, surfaces: PluginSurface[] = [...publications.keys()]): Promise<void> {
  return serial(async () => {
    const target = requestedVersion.unwrap().parse(version);
    const current = await rows(true);
    reconcileRows(current);
    for (const surface of surfaces) if (!current.some(row => row.surface === surface && row.tunnelKey === scope(surface))) {
      const next: Row = { surface, tunnelKey: scope(surface), observe: false, schemaId: '', id: randomUUID(), appId: null, completedSchemaId: null, attempted: false, manual: false };
      const index = current.findIndex(row => row.surface === surface);
      if (index >= 0) current[index] = next; else current.push(next);
    }
    for (const row of current) {
      if (!surfaces.includes(row.surface)) continue;
      if (target === APP_VERSION && (row.manual || row.attempted || row.completedSchemaId === row.schemaId)) {
        // A fresh explicit observation may open its own helper after the old one was closed.
        // Keep the consumed click/manual flags: a new page identity grants no new Refresh.
        row.id = randomUUID(); row.observe = true; row.requestedVersion = target; row.requestedFromVersion = APP_VERSION; continue;
      }
      row.requestedVersion = target; row.requestedFromVersion = APP_VERSION;
      if (target === APP_VERSION) {
        row.id = randomUUID(); delete row.error; delete row.failures; delete row.parked; delete row.parkedBy;
      }
    }
    await save(current);
    changed();
    if (target === APP_VERSION) wakeBrowserWork();
  });
}
export function pendingPluginRefreshes(automatic = true): Promise<PluginRefreshRequest[]> {
  return serial(async () => {
    if (!automatic && !await hasRequestedPluginRefresh()) return [];
    const current = await rows();
    const changed = reconcileRows(current);
    if (changed) {
      await save(current);
      logInfo(`plugin refresh pending observed ${current.filter(row => !row.manual && row.completedSchemaId !== row.schemaId).map(row => `surface=${row.surface} schema=${row.schemaId.slice(0, 12)} dueInMs=${Math.max(0, (settling.get(row.surface)?.readyAt ?? 0) - Date.now())}`).join(' ')}`);
    }
    return current.flatMap(row => {
      const publication = currentPublication(row.surface);
      return publication && (automatic || row.requestedVersion === APP_VERSION) && (settling.get(row.surface)?.readyAt ?? 0) <= Date.now() && publication.schemaId === row.schemaId && (row.observe || (!row.attempted && !row.manual && !row.parked && row.completedSchemaId !== row.schemaId))
        ? [{ ...structuredClone(publication), id: row.id, appId: row.observe ? null : row.appId, ...(row.observe ? { observeOnly: true } : {}) }] : [];
    });
  });
}
type Identity = { id: string; appId: string };
/**
 * The connector's Secure Tunnel, as ChatGPT's plugin page reports it (`connector.tunnel_id`).
 *
 * First enrollment otherwise needs the installed tool names to equal the published ones, which a
 * stale connector — the one case that needs a refresh — never satisfies. Measured 2026-09-27:
 * Desktop showed 4 of its tools and Plugins none, so neither could ever be enrolled or
 * refreshed. A tunnel id this app itself serves proves the connector is ours, and it is checked
 * by the caller against this app's own configuration, never taken from the page alone.
 */
type Enrollment = { connectorName: string; tools: unknown; tunnelId?: string; ownsTunnel?: (surface: PluginSurface, tunnelId: string) => boolean };
function enrolls(row: Row, publication: PluginPublication, input: Enrollment): boolean {
  if (input.connectorName !== publication.connectorName) return false;
  if (input.tunnelId && input.ownsTunnel && !input.ownsTunnel(row.surface, input.tunnelId)) return false;
  if (enrollable(input.tools, publication)) return true;
  return typeof input.tunnelId === 'string' && input.tunnelId.length > 0 && input.ownsTunnel?.(row.surface, input.tunnelId) === true;
}
function exact(current: Row[], identity: Identity): Row | undefined {
  if (!app.safeParse(identity.appId).success) return;
  return current.find(row => row.id === identity.id && row.tunnelKey === scope(row.surface) && currentPublication(row.surface)?.schemaId === row.schemaId && (settling.get(row.surface)?.readyAt ?? 0) <= Date.now());
}
/** Commit one attempted click before the browser acts. A crash never re-arms it. */
export function claimPluginRefresh(input: Identity & Enrollment & { alreadyCurrent?: boolean }, automatic = true): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = exact(current, input);
    if (!row || (!automatic && row.requestedVersion !== APP_VERSION) || !recognizable(input.tools, row.surface)) return false;
    if (row.observe && input.alreadyCurrent !== true) return false;
    const observation = row.observe;
    if (!observation && (row.attempted || row.manual || row.completedSchemaId === row.schemaId)) return false;
    const publication = publications.get(row.surface)!;
    // Unique-name discovery is initial enrollment only. Stale definitions can still
    // identify the surface; the complete post-refresh declarations must match below.
    if (observation ? !enrolls(row, publication, input) : row.appId ? row.appId !== input.appId : !enrolls(row, publication, input)) return false;
    if (current.some(other => other !== row && other.appId === input.appId)) return false;
    const isCurrent = matches(input.tools, publication.tools, row.surface);
    if (input.alreadyCurrent === true ? !isCurrent : isCurrent) return false;
    row.appId = input.appId; row.attempted = true;
    delete row.error;
    notePluginInstalled(row.surface);
    // Enrollment/migration may find the installed declaration already current. Record
    // that observation without clicking Refresh or manufacturing a new plugin version.
    if (input.alreadyCurrent) { row.verifiedRun = runId; row.completedSchemaId = row.schemaId; row.manual = false; row.observe = false; delete row.parked; delete row.parkedBy; delete row.failures; }
    await save(current); return true;
  });
}
/**
 * Records a changed provider snapshot that this ChatGPT workspace cannot refresh in place.
 *
 * This is intentionally neither a completed refresh nor an attempted click. The same schema stays
 * visible as requiring manual recreation/republishing, but automatic browser maintenance stops
 * reopening its settings page. A later local schema change creates a fresh row and may be tried
 * again normally.
 */
export function requireManualPluginRefresh(input: Identity & Enrollment & { error: string }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = exact(current, input);
    if (!row || row.observe || row.attempted || row.manual || row.completedSchemaId === row.schemaId || !recognizable(input.tools, row.surface)) return false;
    const publication = publications.get(row.surface)!;
    if (row.appId ? row.appId !== input.appId : !enrolls(row, publication, input)) return false;
    if (current.some(other => other !== row && other.appId === input.appId) || matches(input.tools, publication.tools, row.surface)) return false;
    row.appId = input.appId;
    row.manual = true;
    notePluginInstalled(row.surface);
    row.error = input.error.slice(0, 200);
    await save(current);
    logWarn(`plugin refresh requires manual action surface=${row.surface}: ${row.error}`);
    return true;
  });
}
export function completePluginRefresh(input: Identity & { tools: unknown; versionId?: string }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = exact(current, input);
    if (!row || row.manual || !row.attempted || row.appId !== input.appId || !matches(input.tools, publications.get(row.surface)!.tools, row.surface)) return false;
    row.completedSchemaId = row.schemaId; row.verifiedRun = runId; row.observe = false; delete row.error;
    if (input.versionId) row.versionId = input.versionId.slice(0, 200);
    await save(current); return true;
  });
}
export function failPluginRefresh(input: { id: string; error: string }): Promise<boolean> {
  return serial(async () => {
    const current = await rows(); const row = current.find(row => row.id === input.id);
    if (!row || row.tunnelKey !== scope(row.surface) || currentPublication(row.surface)?.schemaId !== row.schemaId || (row.completedSchemaId === row.schemaId && !row.observe)) return false;
    // Only claimPluginRefresh records an attempted click. Pre-claim failures remain
    // diagnostic errors, distinct from an ambiguous post-click outcome. Existing
    // maintenance may reobserve the same owned page until a claim actually succeeds.
    row.observe = false;
    row.error = input.error.slice(0, 200);
    row.failures = (row.failures ?? 0) + 1;
    if (row.failures >= PLUGIN_REFRESH_FAILURE_LIMIT && !row.parked) {
      row.parked = true; row.parkedBy = APP_VERSION;
      logWarn(`plugin refresh parked surface=${row.surface} after ${row.failures} failed attempts: ${row.error}`);
    }
    await save(current); return true;
  });
}
/** Tests that are not about tunnel timing publish surfaces as if their tunnel were long live. */
export function setPluginRefreshTunnelGraceForTests(ms: number): void { tunnelGraceMs = ms; }
export function resetPluginRefreshForTests(): void { for (const row of settling.values()) if (row.timer) clearTimeout(row.timer); settling.clear(); publications.clear(); publicationScopes.clear(); responding.clear(); savedCache = null; chain = Promise.resolve(); }
