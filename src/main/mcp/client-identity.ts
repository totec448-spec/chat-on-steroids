import type { McpClientIdentity } from '../../shared/session.js';
import type { SurfaceId } from '../../shared/types.js';

const MAX_CLIENT_ENTRIES = 128;
const MAX_LIVE_EXTERNAL_CLIENTS = 32;
const CLIENT_CACHE_TTL_MS = 6 * 60 * 60_000;
const CLIENT_ACTIVITY_NOTIFY_INTERVAL_MS = 15_000;
const CONTROL_AND_BIDI_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

interface KnownClientSpec {
  id: string;
  name: string;
  patterns: RegExp[];
}

/**
 * Recognized non-ChatGPT MCP clients mapped to crisp presentation identities.
 * Keep patterns conservative so generic HTTP stacks (node, curl, Mozilla) stay unattributed
 * unless they explicitly declared a client name in MCP `initialize`.
 */
const KNOWN_EXTERNAL_CLIENTS: KnownClientSpec[] = [
  { id: 'gemini', name: 'Gemini', patterns: [/(?:^|[^a-z0-9])gemini(?:$|[^a-z0-9]|cli\b|mcp\b)/i, /(?:^|[^a-z0-9])google[-_ ]?genai(?:$|[^a-z0-9])/i, /(?:^|[^a-z0-9])google[-_ ]?ai[-_ ]?studio(?:$|[^a-z0-9])/i] },
  { id: 'claude', name: 'Claude', patterns: [/(?:^|[^a-z0-9])claude(?:$|[^a-z0-9]|code\b|desktop\b)/i, /\banthropic\b/i] },
  { id: 'antigravity', name: 'Antigravity', patterns: [/(?:^|[^a-z0-9])antigravity(?:$|[^a-z0-9])/i] },
  { id: 'cursor', name: 'Cursor', patterns: [/(?:^|[^a-z0-9])cursor(?:$|[^a-z0-9])/i] },
  { id: 'windsurf', name: 'Windsurf', patterns: [/(?:^|[^a-z0-9])windsurf(?:$|[^a-z0-9])/i, /\bcodeium\b/i] },
  { id: 'vscode', name: 'VS Code', patterns: [/(?:^|[^a-z0-9])vscode(?:$|[^a-z0-9])/i, /\bvisual studio code\b/i] },
  { id: 'cline', name: 'Cline', patterns: [/(?:^|[^a-z0-9])cline(?:$|[^a-z0-9])/i] },
  { id: 'zed', name: 'Zed', patterns: [/(?:^|[^a-z0-9])zed(?:$|[^a-z0-9])/i] },
  { id: 'opencode', name: 'OpenCode', patterns: [/(?:^|[^a-z0-9])opencode(?:$|[^a-z0-9])/i] },
  { id: 'codex', name: 'Codex', patterns: [/(?:^|[^a-z0-9])codex(?:$|[^a-z0-9])/i] }
];

const IGNORED_RAW_NAMES = new Set([
  'test',
  'test-client',
  'probe',
  'self-test',
  'tunnel-probe',
  'health-check',
  'code-mode-contract-test',
  'unknown',
  'anonymous',
  'none',
  'mcp-client',
  'node',
  'undici',
  'node-fetch',
  'curl',
  'wget',
  'axios',
  'python-requests',
  'python-httpx',
  'aiohttp',
  'go-http-client'
]);

const OPENAI_PATTERNS = [/\bopenai\b/i, /\bchatgpt\b/i, /^wfr_/i];

interface CachedClientEntry {
  identity: McpClientIdentity;
  expiresAt: number;
}

const bySessionKey = new Map<string, CachedClientEntry>();
const byUserAgentKey = new Map<string, CachedClientEntry>();

function cleanText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(CONTROL_AND_BIDI_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' ? raw : '';
  }
  return '';
}

function isIgnoredOrOpenAi(text: string): boolean {
  const lower = text.toLowerCase();
  if (IGNORED_RAW_NAMES.has(lower)) return true;
  return OPENAI_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizeKnownClient(raw: string, version?: string): McpClientIdentity | null {
  for (const spec of KNOWN_EXTERNAL_CLIENTS) {
    if (spec.patterns.some((pattern) => pattern.test(raw))) {
      return version ? { id: spec.id, name: spec.name, version } : { id: spec.id, name: spec.name };
    }
  }
  return null;
}

function formatCustomDisplayName(raw: string): string {
  // Capitalize single lowercase slug identifiers (for example "goose" -> "Goose") while keeping mixed case intact.
  if (/^[a-z][a-z0-9_-]{1,39}$/.test(raw)) {
    return raw.slice(0, 1).toUpperCase() + raw.slice(1);
  }
  return raw;
}

function setBounded(map: Map<string, CachedClientEntry>, key: string, identity: McpClientIdentity): void {
  if (map.has(key)) map.delete(key);
  while (map.size >= MAX_CLIENT_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, { identity, expiresAt: Date.now() + CLIENT_CACHE_TTL_MS });
}

function getBounded(map: Map<string, CachedClientEntry>, key: string): McpClientIdentity | null {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  // Refresh insertion order for LRU eviction.
  map.delete(key);
  map.set(key, entry);
  return entry.identity;
}

function jsonRpcMessages(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  }
  return body && typeof body === 'object' ? [body as Record<string, unknown>] : [];
}

function hasOpenAiMetadata(messages: Array<Record<string, unknown>>): boolean {
  for (const msg of messages) {
    const params = msg.params;
    if (!params || typeof params !== 'object') continue;
    const meta = (params as { _meta?: unknown })._meta;
    if (!meta || typeof meta !== 'object') continue;
    if (Object.keys(meta as Record<string, unknown>).some((key) => key.startsWith('openai/'))) {
      return true;
    }
  }
  return false;
}

function normalizedUserAgent(headers: Record<string, string | string[] | undefined>): string {
  const raw = cleanText(headerValue(headers, 'user-agent'), 160);
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower === 'node' || lower.startsWith('node/') || lower.startsWith('undici') || lower.startsWith('mozilla/')) {
    // Allow Mozilla headers only if they carry an unmistakable known external client token.
    return normalizeKnownClient(raw) ? raw : '';
  }
  return raw;
}

/**
 * Parse and validate an MCP `clientInfo` object into a safe presentation identity.
 * Returns null for missing values, ChatGPT/OpenAI callers, and internal test stubs.
 */
export function parseClientInfoObject(raw: unknown): McpClientIdentity | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { name?: unknown; title?: unknown; version?: unknown };
  const rawName = cleanText(obj.name, 48) || cleanText(obj.title, 48);
  const rawTitle = cleanText(obj.title, 48);
  if (!rawName) return null;
  if (isIgnoredOrOpenAi(rawName) || (rawTitle && isIgnoredOrOpenAi(rawTitle))) return null;

  const version = cleanText(obj.version, 32) || undefined;
  const known = normalizeKnownClient(rawName, version) ?? (rawTitle ? normalizeKnownClient(rawTitle, version) : null);
  if (known) return known;

  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!slug || isIgnoredOrOpenAi(slug)) return null;

  const displayName = cleanText(rawTitle || formatCustomDisplayName(rawName), 48);
  if (!displayName) return null;
  return version ? { id: slug, name: displayName, version } : { id: slug, name: displayName };
}

/** Extract sanitized MCP session header when supplied by an HTTP client. */
export function extractMcpSessionId(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = cleanText(headerValue(headers, 'mcp-session-id'), 128);
  return raw || null;
}

/**
 * Inspect an inbound `initialize` payload and remember its self-reported client identity
 * by `(surface, mcpSessionId)` and `(surface, userAgent)` so subsequent stateless requests
 * from the same external client can be grouped under a named session card.
 */
function hasOpenAiRequestId(headers: Record<string, string | string[] | undefined>): boolean {
  const raw = headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('wfr_');
}

function queryClientHint(requestUrl?: string): McpClientIdentity | null {
  if (!requestUrl) return null;
  const queryStart = requestUrl.indexOf('?');
  if (queryStart < 0) return null;
  try {
    const rawClient = new URLSearchParams(requestUrl.slice(queryStart + 1)).get('client')?.trim();
    if (!rawClient || rawClient.length > 64 || /[\r\n\x00-\x1f\x7f]/.test(rawClient)) return null;
    // Only known external client markers (e.g. gemini, claude) may come from a URL query hint.
    return normalizeKnownClient(rawClient);
  } catch {
    return null;
  }
}

export function observeMcpInitialize(
  surface: string,
  headers: Record<string, string | string[] | undefined>,
  body: unknown
): McpClientIdentity | null {
  const sessionId = extractMcpSessionId(headers);
  const ua = normalizedUserAgent(headers);
  const uaKey = ua ? `${surface}\n${ua}` : '';
  const sessKey = sessionId ? `${surface}\n${sessionId}` : '';

  for (const msg of jsonRpcMessages(body)) {
    if (msg.method !== 'initialize') continue;
    const params = msg.params;
    const clientInfo = params && typeof params === 'object' ? (params as { clientInfo?: unknown }).clientInfo : undefined;
    const identity = parseClientInfoObject(clientInfo);
    if (!identity) {
      // Explicitly clear any stale mapping when an OpenAI or test stub initializes on the same key.
      if (sessKey) bySessionKey.delete(sessKey);
      if (uaKey) byUserAgentKey.delete(uaKey);
      return null;
    }
    if (sessKey) setBounded(bySessionKey, sessKey, identity);
    if (uaKey) setBounded(byUserAgentKey, uaKey, identity);
    return identity;
  }
  return null;
}

/**
 * Resolve presentation-only client identity for an inbound MCP HTTP request.
 * Priority: explicit OpenAI opt-out -> per-call `_meta['io.modelcontextprotocol/clientInfo']`
 * -> cached `mcp-session-id` -> cached `(surface, userAgent)` -> known client token in User-Agent.
 */
export function resolveInboundMcpClient(
  surface: string,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
  requestUrl?: string
): { clientIdentity: McpClientIdentity | null; mcpSessionId: string | null } {
  const mcpSessionId = extractMcpSessionId(headers);
  const messages = jsonRpcMessages(body);

  if (hasOpenAiMetadata(messages) || hasOpenAiRequestId(headers)) {
    return { clientIdentity: null, mcpSessionId };
  }

  const direct = resolveDirectMcpClient(surface, headers, mcpSessionId, messages);
  const fromQuery = queryClientHint(requestUrl);
  if (fromQuery && (!direct.clientIdentity || !normalizeKnownClient(direct.clientIdentity.id))) {
    return {
      clientIdentity: direct.clientIdentity?.version
        ? { ...fromQuery, version: direct.clientIdentity.version }
        : fromQuery,
      mcpSessionId: direct.mcpSessionId
    };
  }
  return direct;
}

function resolveDirectMcpClient(
  surface: string,
  headers: Record<string, string | string[] | undefined>,
  mcpSessionId: string | null,
  messages: ReturnType<typeof jsonRpcMessages>
): { clientIdentity: McpClientIdentity | null; mcpSessionId: string | null } {

  for (const msg of messages) {
    const params = msg.params;
    if (!params || typeof params !== 'object') continue;
    const p = params as { clientInfo?: unknown; _meta?: unknown };
    const metaClient = p._meta && typeof p._meta === 'object'
      ? (p._meta as Record<string, unknown>)['io.modelcontextprotocol/clientInfo']
      : undefined;
    const explicit = parseClientInfoObject(metaClient ?? p.clientInfo);
    if (explicit) {
      return { clientIdentity: explicit, mcpSessionId };
    }
  }

  if (mcpSessionId) {
    const fromSession = getBounded(bySessionKey, `${surface}\n${mcpSessionId}`);
    if (fromSession) return { clientIdentity: fromSession, mcpSessionId };
  }

  const ua = normalizedUserAgent(headers);
  if (ua) {
    const fromUaCache = getBounded(byUserAgentKey, `${surface}\n${ua}`);
    if (fromUaCache) return { clientIdentity: fromUaCache, mcpSessionId };
    const knownFromUa = normalizeKnownClient(ua);
    if (knownFromUa) return { clientIdentity: knownFromUa, mcpSessionId };
  }

  return { clientIdentity: null, mcpSessionId };
}

/** Snapshot of an external MCP client seen on the currently running local endpoint. */
export interface LiveExternalClient {
  id: string;
  name: string;
  version?: string;
  surfaces: SurfaceId[];
  lastRequestAt: number;
  lastToolCallAt: number | null;
}

interface LiveExternalClientRecord {
  id: string;
  name: string;
  version?: string;
  surfaces: Set<SurfaceId>;
  lastRequestAt: number;
  lastToolCallAt: number | null;
  lastNotifiedAt: number;
}

const liveExternalClients = new Map<string, LiveExternalClientRecord>();
const externalClientListeners = new Set<() => void>();

function emitExternalMcpClientsChange(): void {
  for (const listener of externalClientListeners) listener();
}

/** Subscribe to live external MCP client activity changes for the current endpoint run. */
export function onExternalMcpClientsChange(listener: () => void): () => void {
  externalClientListeners.add(listener);
  return () => externalClientListeners.delete(listener);
}

/** Records a validated external MCP client request on the currently running server. */
export function noteExternalMcpClientActivity(
  surface: SurfaceId,
  identity: McpClientIdentity,
  rpcMethod?: string | null,
  at = Date.now()
): void {
  const existing = liveExternalClients.get(identity.id);
  const isToolCall = rpcMethod === 'tools/call';
  if (!existing) {
    while (liveExternalClients.size >= MAX_LIVE_EXTERNAL_CLIENTS) {
      const oldest = liveExternalClients.keys().next().value;
      if (oldest === undefined) break;
      liveExternalClients.delete(oldest);
    }
    liveExternalClients.set(identity.id, {
      id: identity.id,
      name: identity.name,
      ...(identity.version ? { version: identity.version } : {}),
      surfaces: new Set([surface]),
      lastRequestAt: at,
      lastToolCallAt: isToolCall ? at : null,
      lastNotifiedAt: at
    });
    emitExternalMcpClientsChange();
    return;
  }

  const changedSurface = !existing.surfaces.has(surface);
  const changedVersion = Boolean(identity.version && identity.version !== existing.version);
  const firstToolCall = isToolCall && existing.lastToolCallAt === null;
  existing.name = identity.name;
  if (identity.version) existing.version = identity.version;
  existing.surfaces.add(surface);
  existing.lastRequestAt = Math.max(existing.lastRequestAt, at);
  if (isToolCall) existing.lastToolCallAt = Math.max(existing.lastToolCallAt ?? 0, at);

  // Refresh LRU order and notify on structural transitions or throttled request heartbeats.
  liveExternalClients.delete(identity.id);
  liveExternalClients.set(identity.id, existing);
  if (changedSurface || changedVersion || firstToolCall || at - existing.lastNotifiedAt >= CLIENT_ACTIVITY_NOTIFY_INTERVAL_MS) {
    existing.lastNotifiedAt = at;
    emitExternalMcpClientsChange();
  }
}

/** External MCP clients seen on the currently running endpoint, newest first. */
export function listLiveExternalMcpClients(): LiveExternalClient[] {
  return [...liveExternalClients.values()]
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      ...(entry.version ? { version: entry.version } : {}),
      surfaces: [...entry.surfaces],
      lastRequestAt: entry.lastRequestAt,
      lastToolCallAt: entry.lastToolCallAt
    }))
    .sort((a, b) => b.lastRequestAt - a.lastRequestAt);
}

/** Clears live external MCP client sightings when the local endpoint starts or stops. */
export function resetLiveExternalMcpClients(notify = false): void {
  const had = liveExternalClients.size > 0;
  liveExternalClients.clear();
  if (notify && had) emitExternalMcpClientsChange();
}

/** Clear cached initialize/session client identities between unit tests. */
export function resetMcpClientIdentityForTests(): void {
  bySessionKey.clear();
  byUserAgentKey.clear();
  liveExternalClients.clear();
}
