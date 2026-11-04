import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { SurfaceId } from './surfaces.js';

/** Host-supplied conversation metadata, never model arguments or the generic sessionId.
 * OpenAI documents openai/session as conversation-scoped. Scope it to the local Setup,
 * connector surface and anonymized subject; only its hash enters the ownership ledger. */
export function providerSessionKey(surface: SurfaceId, profile: string | null,
  headers: IncomingHttpHeaders, body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const meta = (body as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const session = meta['openai/session'], subject = meta['openai/subject'];
  const valid = (value: unknown): value is string => typeof value === 'string' &&
    value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/.test(value);
  if (!valid(session) || !valid(subject)) return null;
  for (const [name, expected] of [['x-openai-session', session], ['x-openai-subject', subject]] as const) {
    const raw = headers[name];
    if (raw !== undefined && (Array.isArray(raw) ? raw.length !== 1 || raw[0] !== expected : raw !== expected)) return null;
  }
  return createHash('sha256').update(JSON.stringify([profile ?? 'default', surface, subject, session])).digest('hex');
}
