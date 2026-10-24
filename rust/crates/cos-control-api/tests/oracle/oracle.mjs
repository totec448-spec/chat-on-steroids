// Writes tests/fixtures/oracle.json: what the TypeScript control API decides for each input in
// the case lists below, computed with the app's own zod (4.6.5) and Node's URL parser. The
// schema and redaction definitions are copied verbatim from src/main/control-reads.ts,
// src/main/control-actions.ts and src/main/redaction.ts.
//
//   node rust/crates/cos-control-api/tests/oracle/oracle.mjs [<folder holding node_modules>]
//
// Run it from the repository root after `npm ci`. The Rust test `oracle` replays every case.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(path.resolve(process.argv[2] ?? process.cwd()), 'package.json'));
const { z } = require('zod');

class RequestError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}

// ---------------------------------------------------------------- control-reads.ts
const integer = (min, max) =>
  z.string().regex(/^\d{1,16}$/).transform(Number).pipe(z.number().int().min(min).max(max));

function parseQuery(params, shape) {
  const raw = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(raw, key)) throw new RequestError(400, 'invalid_query', 'a parameter was given more than once');
    raw[key] = value;
  }
  const parsed = z.object(shape).strict().safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'query';
    throw new RequestError(400, 'invalid_query', issue?.code === 'unrecognized_keys' ? 'unknown parameter' : where + ' is not valid');
  }
  return parsed.data;
}

function csv(allowed) {
  return z.string().transform((value) => value.split(',')).pipe(z.array(z.enum(allowed)).min(1).max(allowed.length));
}

const EVENT_KINDS = ['session_start', 'user_message', 'assistant_message', 'native_image', 'progress', 'page_tool', 'turn_start', 'turn_end', 'chat_error', 'tool_call', 'note', 'agent_message', 'handoff'];
const INPUT_STATES = ['queued', 'browser', 'tool', 'sent', 'cancelled', 'failed'];
const LOG_LEVELS = ['info', 'warn', 'error'];
const MAX_EVENTS = 100;

const SHAPES = {
  sessions: { limit: integer(1, 50).optional(), cursor: z.string().min(1).max(100).optional() },
  session: { live: z.literal('1').optional() },
  events: {
    from: integer(0, 10_000_000).optional(),
    before: integer(1, 10_000_000).optional(),
    after: integer(0, 10_000_000).optional(),
    limit: integer(1, MAX_EVENTS).optional(),
    kinds: csv(EVENT_KINDS).optional()
  },
  stream: { from: integer(0, 10_000_000).optional(), kinds: csv(EVENT_KINDS).optional() },
  inputs: { state: csv(INPUT_STATES).optional(), limit: integer(1, 500).optional() },
  agents: {},
  log: { limit: integer(1, 500).optional(), since: integer(0, Number.MAX_SAFE_INTEGER).optional(), level: csv(LOG_LEVELS).optional() }
};

function eventsQuery(params) {
  const query = parseQuery(params, SHAPES.events);
  if (query.from !== undefined && (query.before !== undefined || query.after !== undefined)) {
    throw new RequestError(400, 'invalid_query', 'from cannot be combined with before or after');
  }
  return query;
}

function eventStreamQuery(params, lastEventId) {
  const query = parseQuery(params, SHAPES.stream);
  if (lastEventId === undefined) return { from: query.from ?? 0, kinds: query.kinds };
  if (typeof lastEventId !== 'string' || !/^\d{1,8}$/.test(lastEventId)) {
    throw new RequestError(400, 'invalid_query', 'Last-Event-ID is not valid');
  }
  return { from: Number(lastEventId) + 1, kinds: query.kinds };
}

// ---------------------------------------------------------------- control-actions.ts
const MAX_TEXT = 64_000;
const lowerUuid = z.string().uuid().refine((value) => value === value.toLowerCase(), 'id must be lowercase');
const sendBody = z
  .object({
    id: lowerUuid,
    sessionId: z.string().regex(/^[0-9a-z-]{8,64}$/).optional(),
    projectId: lowerUuid.optional(),
    text: z.string().max(MAX_TEXT).refine((value) => value.trim().length > 0, 'text is empty'),
    interrupt: z.boolean().optional()
  })
  .strict()
  .refine((body) => body.sessionId === undefined || body.projectId === undefined, { path: ['projectId'], message: 'a project belongs to a new chat' });
const cancelBody = z.object({}).strict();

function parseBody(schema, body) {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'body';
    throw new RequestError(400, 'invalid_body', issue?.code === 'unrecognized_keys' ? 'unknown field' : where + ' is not valid');
  }
  return parsed.data;
}

// ---------------------------------------------------------------- redaction.ts
function redactCredentialText(text) {
  return text.replace(/\bsk-(?:or-v1-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}
const SECRET_SHAPES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, '[redacted]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[redacted]'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]'],
  [/\b(Authorization:\s*(?:Basic|Bearer|Token))\s+[^\s"']+/gi, '$1 [redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer [redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [/(\/mcp\/[a-z0-9-]+\/)[A-Za-z0-9_-]{20,}/g, '$1[redacted]']
];
function redactSecretText(text) {
  let out = redactCredentialText(text);
  for (const [pattern, replacement] of SECRET_SHAPES) out = out.replace(pattern, replacement);
  return out;
}

// ---------------------------------------------------------------- control-api.ts target check
function target(raw) {
  if (!/^\/[^\\]*$/.test(raw) || raw.startsWith('//')) return { invalid: true };
  const url = new URL(raw, 'http://127.0.0.1');
  return { pathname: url.pathname, search: url.search, params: [...url.searchParams] };
}

// ---------------------------------------------------------------- cases
const outcome = (run) => {
  try { return { ok: run() }; } catch (error) {
    if (error instanceof RequestError) return { status: error.status, error: error.code, ...(error.detail ? { detail: error.detail } : {}) };
    throw error;
  }
};
const queries = {
  sessions: ['', 'limit=1', 'limit=50', 'limit=0', 'limit=51', 'limit=abc', 'limit=01', 'limit=', 'limit=1&limit=2', 'nope=1', 'verbose=1',
    'cursor=zzz', 'cursor=', `cursor=${'x'.repeat(100)}`, `cursor=${'x'.repeat(101)}`, '__proto__=1', 'constructor=1', 'toString=1',
    'limit=0&nope=1', 'nope=1&limit=0', 'limit=1&cursor=', 'cursor=&limit=0', 'limit=+1', 'limit=%31', 'li%6dit=2', 'limit=1.5', 'limit=-1',
    'limit=1&', '&&limit=2', '=1', 'limit', 'limit=12345678901234567', 'limit=1234567890123456'],
  session: ['', 'live=1', 'live=yes', 'live=', 'live=1&live=1', 'x=1', 'live=0'],
  events: ['', 'from=0', 'from=0&limit=1', 'after=2&limit=2', 'before=3', 'before=0', 'kinds=tool_call', 'kinds=nope', 'kinds=', 'kinds=user_message,bogus',
    'kinds=tool_call,tool_call', 'kinds=bogus,user_message', `kinds=${[...EVENT_KINDS, 'note'].join(',')}`, `kinds=${[...EVENT_KINDS, 'nope'].join(',')}`,
    `kinds=${EVENT_KINDS.join(',')}`, 'from=0&after=1', 'from=1&before=5', 'from=1&after=0', 'limit=101', 'limit=100', 'from=10000000', 'from=10000001',
    'limit=0&kinds=nope', 'kinds=nope&limit=0', 'from=x&after=1', 'kinds=tool_call&kinds=note', 'kinds=tool_call%2Cnote', 'kinds=tool_call,'],
  stream: ['', 'from=3', 'kinds=tool_call', 'before=3', 'from=x', 'kinds=nope'],
  inputs: ['', 'state=queued&limit=5', 'state=nope', 'state=deleted', 'state=decision', 'limit=501', 'limit=500', 'limit=0', 'state=queued,sent', `state=${[...INPUT_STATES, 'sent'].join(',')}`],
  agents: ['', 'x=1', 'x=1&x=2'],
  log: ['', 'limit=5', 'since=99999999999999', 'since=-1', 'level=nope', 'level=debug', 'level=warn,error', `since=${Number.MAX_SAFE_INTEGER}`,
    `since=${Number.MAX_SAFE_INTEGER + 2}`, 'since=9999999999999999', 'limit=500&level=info']
};
const query = {};
for (const [route, list] of Object.entries(queries)) {
  query[route] = list.map((text) => ({
    query: text,
    ...outcome(() => {
      const params = new URLSearchParams(text);
      if (route === 'events') return eventsQuery(params);
      if (route === 'stream') return eventStreamQuery(params, undefined);
      return parseQuery(params, SHAPES[route]);
    })
  }));
}
const lastEventId = ['2', '0', 'x', '', '123456789', '12345678', '-1', ' 2', '2 '].map((header) => ({
  header, ...outcome(() => eventStreamQuery(new URLSearchParams('from=5'), header))
}));

const id = '00000000-0000-4000-8000-000000000000';
const bodies = [
  undefined, null, {}, [], 'text', 1, true,
  { id, text: 'hello' }, { id, text: '   ' }, { id, text: '' }, { id: id.toUpperCase(), text: 'x' },
  { id: 'ABCDEF00-0000-4000-8000-000000000000', text: 'x' }, { id: 'abcdef00-0000-4000-8000-000000000000', text: 'x' },
  { id, text: 'x', extra: 1 }, { extra: 1 }, { id, sessionId: '00000000-0000-4000-8000-0000000000aa', projectId: '00000000-0000-4000-8000-0000000000bb', text: 'x' },
  { id, sessionId: '00000000-0000-4000-8000-0000000000aa', text: 'hello' }, { id, projectId: '00000000-0000-4000-8000-0000000000bb', text: 'hello' },
  { id, sessionId: 'BAD', text: 'x' }, { id, sessionId: 'short', text: 'x' }, { id, sessionId: '2026-10-20-1a2b3c4d', text: 'x' },
  { id, projectId: 'nope', text: 'x' }, { id, text: 'x', interrupt: 'yes' }, { id, text: 'x', interrupt: true }, { id, text: 5 },
  { id, text: 'x'.repeat(64_000) }, { id, text: 'x'.repeat(64_001) }, { id: 'not-a-uuid', text: 'x' }, { id: 5, text: 'x' },
  { text: 'x' }, { id }, { id, text: 'x', sessionId: null }, { id, text: '   x' }, { id, text: '﻿' }, { id, text: '　\t\n' },
  { id: '00000000-0000-0000-0000-000000000000', text: 'x' }, { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', text: 'x' },
  { id: '00000000-0000-6000-8000-000000000000', text: 'x' }, { id: '00000000-0000-4000-c000-000000000000', text: 'x' },
  { id: '00000000-0000-9000-8000-000000000000', text: 'x' }, { id: '00000000-0000-4000-7000-000000000000', text: 'x' },
  { id: '{00000000-0000-4000-8000-000000000000}', text: 'x' }, { id: '000000000000400080000000000000000', text: 'x' },
  { extra: 1, id: 'bad' }, { id: 'bad', extra: 1 }, { id, text: '', extra: 1 }, { reason: 'x' }
];
const send = bodies.map((body) => ({ body: body === undefined ? '<undefined>' : body, ...outcome(() => parseBody(sendBody, body)) }));
const cancel = [undefined, null, {}, { reason: 'x' }, [], 'x'].map((body) => ({ body: body === undefined ? '<undefined>' : body, ...outcome(() => parseBody(cancelBody, body)) }));

const k = 'k'.repeat(43);
const texts = [
  'plain prose', `ghp_${'aB3'.repeat(12)}`, `github_pat_${'aB3'.repeat(16)}`, `xoxb-${'1234567890-'.repeat(3)}abc`, `AKIA${'Q'.repeat(16)}`,
  `AIza${'x'.repeat(35)}`, `sk_live_${'a1'.repeat(12)}`, `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`,
  `curl -H "Authorization: Bearer ${k}" -H 'authorization: basic ZHVtbXk6ZHVtbXk='`, `Bearer ${k}`, 'postgres://admin:hunter2@db.internal:5432/app',
  `https://tunnel.example/mcp/core/${k}`, 'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy\n-----END RSA PRIVATE KEY-----\ndone',
  '-----BEGIN PRIVATE KEY-----\nMIIBOgIBAAJB', '9fceb02d0ae598e95dc970b74767f19372d61af8', 'Basic configuration is described in the implementation-details section',
  'The bearer of this note should read src/main/control-reads.ts', 'https://example.test/docs/mcp/overview', 'user@example.test',
  `retry with Authorization: Bearer ${'t'.repeat(30)}`, `sk-${'a'.repeat(24)}`, `sk-proj-${'b'.repeat(30)} and sk-short`, `x sk-or-v1-${'c'.repeat(21)}y`,
  `éAKIA${'Q'.repeat(16)}é`, `AUTHORIZATION:   TOKEN abc`, 'http://a:b@c and HTTPS://d:e@f', `/mcp/desktop/${'Z'.repeat(20)}/x`
];
// Base64, so the credential-shaped samples do not read as leaked keys to secret scanners.
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const redaction = texts.map((text) => ({ text: b64(text), redacted: b64(redactSecretText(text)) }));

const targets = ['/', '/v1/health', '//v1/health', '/v1\\health', '/v1/health?', '/v1/health?a=1&b=%20x+y', '/v1/./health', '/v1/x/../health',
  '/v1/health/.', '/v1/health/..', '/..', '/v1/%2e/health', '/v1/%2E%2e/v1/health', '/v1/health#frag', '/v1/health?x=1#frag', '/v1/sessions/..%2F..%2Fconfig',
  '/v1/health?q=%zz', '/v1/health?q=%E2%82%AC', '/v1/health?q=%FF', '/v1/health?&&', '/v1/health?a', '/v1/health?=b', '/v1/inputs?', '/v1/health?a=1?b=2'];
const target_cases = targets.map((raw) => ({ raw, ...target(raw) }));

const out = { zod: require('zod/package.json').version, node: process.version, query, lastEventId, send, cancel, redaction, targets: target_cases };
const file = path.join(here, '..', 'fixtures', 'oracle.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${path.relative(process.cwd(), file)}`);
