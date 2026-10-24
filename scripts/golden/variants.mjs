// What the golden recorder captures: launch variants, and per variant the phases and call
// cases. Cases run in the listed order against one fresh fixture, so later cases see the disk
// and session state earlier ones left.
import fs from 'node:fs';
import path from 'node:path';

const FILE_CAPS_OFF = { browse: false, search: false, read: false, metadata: false, create: false, edit: false, move: false, deleteFile: false };
const ALL_OFF = { ...FILE_CAPS_OFF, command: false, screen: false, control: false, clipboardRead: false, clipboardWrite: false };
const SURFACES = ['core', 'desktop', 'plugins'];
const pad = n => String(n).padStart(2, '0');
const patch = body => `*** Begin Patch\n${body}*** End Patch\n`;

// ---------------------------------------------------------------- phases
function surfaces(ids = SURFACES) {
  return async ({ inst, save, mcpSession }) => {
    for (const id of ids) {
      const url = inst.urls[id];
      if (!url) { save(`mcp/${id}/unavailable.json`, { surface: id, published: false }); continue; }
      const session = await mcpSession(url);
      save(`mcp/${id}/initialize.json`, { request: { protocolVersion: '2025-06-18' }, response: session.init });
      save(`mcp/${id}/tools-list.json`, { response: await session.rpc('tools/list', {}) });
    }
  };
}

function calls(surface, cases) {
  return async ctx => {
    const { inst, save, mcpSession, dirs } = ctx;
    ctx.results ??= {};
    const session = await mcpSession(inst.urls[surface]);
    let n = 0;
    for (const c of cases) {
      const args = typeof c.args === 'function' ? c.args(ctx) : c.args;
      const extra = c.requestId ? { 'x-request-id': c.requestId } : {};
      const response = await session.rpc('tools/call', { name: c.tool, arguments: args }, c.timeoutMs, extra);
      ctx.results[c.id] = response.messages[0]?.result;
      const disk = c.disk ? Object.fromEntries(c.disk.map(rel => {
        const file = path.join(dirs.project, rel);
        return [rel, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null];
      })) : undefined;
      const recordedArgs = c.argsNote ? { note: c.argsNote } : args;
      save(`mcp/${surface}/calls/${pad(++n)}-${c.id}.json`, { case: c.id, request: { tool: c.tool, arguments: recordedArgs, ...(c.requestId ? { headers: extra } : {}) }, response, ...(disk ? { disk } : {}) }, { volatileImages: c.volatileImages });
    }
  };
}

/** An HTTP body as stored: event-stream frames, parsed JSON, or text. */
const httpBody = (res, sseFrames, parseBody) =>
  String(res.headers['content-type'] ?? '').includes('event-stream') ? { frames: sseFrames(res.body) } : { body: parseBody(res.body) };

const INIT = version => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'cos-golden', version: '1' } } });
const MCP_ACCEPT = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

/** JSON-RPC and Streamable HTTP behavior of the Core endpoint, outside any tool. */
async function protocol({ inst, save, mcpSession, request, keptHeaders, parseBody, sseFrames }) {
  const url = inst.urls.core;
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07', '2026-07-28', '1999-01-01']) {
    const session = await mcpSession(url, version);
    const result = session.init.messages[0]?.result;
    save(`mcp/core/protocol/initialize-${version}.json`, { request: { protocolVersion: version },
      response: { status: session.init.status, framing: session.init.framing, negotiated: result?.protocolVersion ?? null, error: session.init.messages[0]?.error ?? null } });
  }
  const session = await mcpSession(url);
  const rpcCases = [
    ['ping', 'ping', {}],
    ['unknown-method', 'no/such_method', {}],
    ['resources-list', 'resources/list', {}],
    ['prompts-list', 'prompts/list', {}],
    ['call-unknown-tool', 'tools/call', { name: 'no_such_tool', arguments: {} }],
    ['call-missing-name', 'tools/call', { arguments: {} }],
    ['tools-list-bad-cursor', 'tools/list', { cursor: 'not-a-cursor' }]
  ];
  for (const [id, method, params] of rpcCases) save(`mcp/core/protocol/${id}.json`, { request: { method, params }, response: await session.rpc(method, params) });

  const raw = async (id, init) => {
    const res = await request(url, init);
    save(`mcp/core/protocol/${id}.json`, { request: { method: init.method, headers: init.headers ?? {}, body: init.body === undefined ? null : parseBody(String(init.body)) },
      response: { status: res.status, headers: keptHeaders(res.headers), ...httpBody(res, sseFrames, parseBody) } });
  };
  await raw('http-get', { method: 'GET', headers: { accept: 'text/event-stream' } });
  await raw('http-delete', { method: 'DELETE', headers: {} });
  await raw('http-no-accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(INIT('2025-06-18')) });
  await raw('http-wrong-content-type', { method: 'POST', headers: { 'content-type': 'text/plain', accept: MCP_ACCEPT.accept }, body: JSON.stringify(INIT('2025-06-18')) });
  await raw('http-invalid-json', { method: 'POST', headers: MCP_ACCEPT, body: '{"jsonrpc":' });
  await raw('http-empty-body', { method: 'POST', headers: MCP_ACCEPT, body: '' });
  await raw('http-batch', { method: 'POST', headers: MCP_ACCEPT, body: JSON.stringify([INIT('2025-06-18'), { jsonrpc: '2.0', id: 2, method: 'ping' }]) });
  await raw('http-notification-only', { method: 'POST', headers: { ...MCP_ACCEPT, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  await raw('http-no-jsonrpc-field', { method: 'POST', headers: MCP_ACCEPT, body: JSON.stringify({ id: 1, method: 'ping' }) });
  await raw('http-bad-protocol-header', { method: 'POST', headers: { ...MCP_ACCEPT, 'mcp-protocol-version': '1999-01-01' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  await raw('http-tools-list-without-initialize', { method: 'POST', headers: MCP_ACCEPT, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
}

/** The listener's own guards, before any MCP handling. Bodies are JSON on every path. */
async function guards({ inst, save, request, keptHeaders, parseBody, sseFrames }) {
  const core = new URL(inst.urls.core);
  const origin = `http://127.0.0.1:${core.port}`;
  const prm = `${origin}/.well-known/oauth-protected-resource${core.pathname}`;
  const body = JSON.stringify(INIT('2025-06-18'));
  const huge = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20);
  const cases = [
    ['wrong-token', `${origin}/mcp/core/${'A'.repeat(43)}`, { method: 'POST', headers: MCP_ACCEPT, body }],
    ['wrong-surface-token', `${origin}${core.pathname.replace('/core/', '/desktop/')}`, { method: 'POST', headers: MCP_ACCEPT, body }],
    ['root-path', `${origin}/`, { method: 'GET' }],
    ['mcp-prefix', `${origin}/mcp`, { method: 'POST', headers: MCP_ACCEPT, body }],
    ['token-with-trailing-slash', `${inst.urls.core}/`, { method: 'POST', headers: MCP_ACCEPT, body }],
    ['token-with-query', `${inst.urls.core}?x=1`, { method: 'POST', headers: MCP_ACCEPT, body }],
    ['bad-host', inst.urls.core, { method: 'POST', headers: { ...MCP_ACCEPT, host: 'evil.example' }, body }],
    ['localhost-host', inst.urls.core, { method: 'POST', headers: { ...MCP_ACCEPT, host: `localhost:${core.port}` }, body }],
    ['foreign-origin', inst.urls.core, { method: 'POST', headers: { ...MCP_ACCEPT, origin: 'https://evil.example' }, body }],
    ['loopback-origin', inst.urls.core, { method: 'POST', headers: { ...MCP_ACCEPT, origin }, body }],
    ['null-origin', inst.urls.core, { method: 'POST', headers: { ...MCP_ACCEPT, origin: 'null' }, body }],
    ['body-over-8mib', inst.urls.core, { method: 'POST', headers: MCP_ACCEPT, body: huge, note: '8 MiB + 1 byte with Content-Length' }],
    ['chunked-body-over-8mib', inst.urls.core, { method: 'POST', headers: { ...MCP_ACCEPT, 'transfer-encoding': 'chunked' }, body: huge, note: '8 MiB + 1 byte, chunked' }],
    ['prm', prm, { method: 'GET' }],
    ['prm-bad-host', prm, { method: 'GET', headers: { host: 'evil.example' } }],
    ['prm-foreign-origin', prm, { method: 'GET', headers: { origin: 'https://evil.example' } }],
    ['prm-bare', `${origin}/.well-known/oauth-protected-resource`, { method: 'GET' }],
    ['prm-wrong-token', `${origin}/.well-known/oauth-protected-resource/mcp/core/${'A'.repeat(43)}`, { method: 'GET' }],
    ['prm-desktop', `${origin}/.well-known/oauth-protected-resource${new URL(inst.urls.desktop).pathname}`, { method: 'GET' }]
  ];
  for (const [id, url, init] of cases) {
    const res = await request(url, init);
    const sent = { method: init.method, path: new URL(url).pathname + new URL(url).search, headers: init.headers ?? {},
      body: init.note ?? (init.body === undefined ? null : parseBody(String(init.body))) };
    save(`http/mcp-guards/${id}.json`, { request: sent, response: { status: res.status, headers: keptHeaders(res.headers), ...httpBody(res, sseFrames, parseBody) } });
  }
}

/** Every /v1 route and its refusals. Sessions exist because the call matrix ran first. */
async function api({ inst, dirs, save, request, keptHeaders, parseBody, shapeOf }) {
  const base = `http://127.0.0.1:${inst.port}`;
  const auth = { authorization: `Bearer ${inst.token}` };
  const call = async (id, route, init = {}, { shape = false } = {}) => {
    const res = await request(base + route, { method: init.method ?? 'GET', headers: { ...auth, ...init.headers }, body: init.body });
    const body = parseBody(res.body);
    const shown = { ...init.headers };
    if (shown.authorization) shown.authorization = shown.authorization === auth.authorization ? 'Bearer <CONTROL_TOKEN>' : shown.authorization;
    save(`api/${id}.json`, { request: { method: init.method ?? 'GET', route: init.routeNote ?? route, headers: shown, body: init.body === undefined ? null : parseBody(String(init.body)) },
      response: { status: res.status, headers: keptHeaders(res.headers), ...(shape ? { bodyShape: shapeOf(body) } : { body }), ...(res.transportError ? { transportError: res.transportError } : {}) } });
    return body;
  };
  const controlDir = path.join(dirs.profile, 'control-api');
  const endpointText = fs.readFileSync(path.join(controlDir, 'endpoint.json'), 'utf8');
  save('api/endpoint-files.json', { 'endpoint.json': { text: endpointText, parsed: JSON.parse(endpointText) },
    token: { text: fs.readFileSync(path.join(controlDir, 'token'), 'utf8'), format: /^[A-Za-z0-9_-]{43}$/.test(inst.token) ? '32 random bytes, base64url, 43 characters' : 'other' } });
  await call('health', '/v1/health');
  await call('status', '/v1/status');
  const list = await call('sessions', '/v1/sessions');
  await call('sessions-limit-1', '/v1/sessions?limit=1');
  await call('sessions-bad-limit', '/v1/sessions?limit=0');
  await call('sessions-bad-cursor', '/v1/sessions?cursor=zzz');
  await call('sessions-unknown-param', '/v1/sessions?nope=1');
  await call('sessions-repeated-param', '/v1/sessions?limit=1&limit=2');
  const id = list?.sessions?.[0]?.id;
  if (id) {
    await call('session', `/v1/sessions/${id}`, { routeNote: '/v1/sessions/{unattributed}' });
    await call('session-live', `/v1/sessions/${id}?live=1`, { routeNote: '/v1/sessions/{unattributed}?live=1' });
    await call('session-events', `/v1/sessions/${id}/events`, { routeNote: '/v1/sessions/{unattributed}/events' });
    await call('session-events-limit-2', `/v1/sessions/${id}/events?limit=2`, { routeNote: '/v1/sessions/{unattributed}/events?limit=2' });
    await call('session-events-after-2', `/v1/sessions/${id}/events?after=2&limit=2`, { routeNote: '/v1/sessions/{unattributed}/events?after=2&limit=2' });
    await call('session-events-before-3', `/v1/sessions/${id}/events?before=3`, { routeNote: '/v1/sessions/{unattributed}/events?before=3' });
    await call('session-events-from', `/v1/sessions/${id}/events?from=0&limit=1`, { routeNote: '/v1/sessions/{unattributed}/events?from=0&limit=1' });
    await call('session-events-kinds', `/v1/sessions/${id}/events?kinds=tool_call`, { routeNote: '/v1/sessions/{unattributed}/events?kinds=tool_call' });
    await call('session-events-bad-kind', `/v1/sessions/${id}/events?kinds=nope`, { routeNote: '/v1/sessions/{unattributed}/events?kinds=nope' });
    await call('session-events-from-and-after', `/v1/sessions/${id}/events?from=0&after=1`, { routeNote: '/v1/sessions/{unattributed}/events?from=0&after=1' });
  }
  await call('session-not-found', '/v1/sessions/00000000-0000-4000-8000-000000000000');
  await call('session-events-not-found', '/v1/sessions/00000000-0000-4000-8000-000000000000/events');
  await call('session-bad-id', '/v1/sessions/BAD');
  await call('inputs', '/v1/inputs');
  await call('inputs-state', '/v1/inputs?state=queued&limit=5');
  await call('inputs-bad-state', '/v1/inputs?state=nope');
  await call('agents', '/v1/agents');
  await call('agents-param', '/v1/agents?x=1');
  await call('log', '/v1/log?limit=5', {}, { shape: true });
  await call('log-future', '/v1/log?since=99999999999999');
  await call('log-bad-level', '/v1/log?level=nope');
  await call('unknown-route', '/v1/nope');
  await call('root', '/');
  await call('no-token', '/v1/health', { headers: { authorization: '' } });
  await call('wrong-token', '/v1/health', { headers: { authorization: 'Bearer wrong' } });
  await call('basic-auth', '/v1/health', { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
  await call('origin-header', '/v1/health', { headers: { origin: `http://127.0.0.1:${inst.port}` } });
  await call('origin-null', '/v1/health', { headers: { origin: 'null' } });
  await call('bad-host', '/v1/health', { headers: { host: 'evil.example' } });
  await call('localhost-host', '/v1/health', { headers: { host: `localhost:${inst.port}` } });
  await call('double-slash-target', '//v1/health');
  await call('backslash-target', '/v1\\health');
  await call('post-health', '/v1/health', { method: 'POST' });
  await call('put-inputs', '/v1/inputs', { method: 'PUT' });
  await call('get-cancel', '/v1/inputs/00000000-0000-4000-8000-000000000000/cancel');
  await call('get-with-body', '/v1/health', { headers: { 'content-type': 'application/json' }, body: '{}' });
  // No body: the refusal comes before the body is read, and the server then closes the
  // connection, so a sent body races a reset.
  await call('post-inputs-actions-off', '/v1/inputs', { method: 'POST' });
  await call('post-cancel-actions-off', '/v1/inputs/00000000-0000-4000-8000-000000000000/cancel', { method: 'POST' });
}

/** SSE framing of /v1/sessions/{id}/events/stream, read until quiet and then closed. */
async function sse({ inst, save, request, keptHeaders, parseBody, sseFrames }) {
  const base = `http://127.0.0.1:${inst.port}`;
  const auth = { authorization: `Bearer ${inst.token}` };
  const list = JSON.parse((await request(`${base}/v1/sessions`, { headers: auth })).body);
  const id = list.sessions?.[0]?.id;
  const stream = (route, headers = {}) => new Promise((resolve, reject) => {
    import('node:http').then(({ default: http }) => {
      const req = http.request(base + route, { headers: { ...auth, ...headers } }, res => {
        let text = '';
        let quiet = setTimeout(() => req.destroy(), 1500);
        res.on('data', chunk => { text += chunk; clearTimeout(quiet); quiet = setTimeout(() => req.destroy(), 1500); });
        const done = () => { clearTimeout(quiet); resolve({ status: res.statusCode, headers: res.headers, text }); };
        res.on('end', done);
        res.on('close', done);
      });
      req.on('error', error => (error.code === 'ECONNRESET' ? null : reject(error)));
      req.end();
    });
  });
  const capture = async (caseId, route, headers, note) => {
    const res = await stream(route, headers);
    const sseBody = String(res.headers['content-type'] ?? '').includes('event-stream');
    save(`api/sse/${caseId}.json`, { request: { method: 'GET', route: note, headers }, response: { status: res.status, headers: keptHeaders(res.headers), ...(sseBody ? { frames: sseFrames(res.text) } : { body: parseBody(res.text) }) } });
  };
  if (id) {
    await capture('stream', `/v1/sessions/${id}/events/stream`, {}, '/v1/sessions/{unattributed}/events/stream');
    await capture('stream-last-event-id', `/v1/sessions/${id}/events/stream`, { 'last-event-id': '2' }, '/v1/sessions/{unattributed}/events/stream');
    await capture('stream-from', `/v1/sessions/${id}/events/stream?from=3`, {}, '/v1/sessions/{unattributed}/events/stream?from=3');
    await capture('stream-kinds', `/v1/sessions/${id}/events/stream?kinds=tool_call`, {}, '/v1/sessions/{unattributed}/events/stream?kinds=tool_call');
    await capture('stream-bad-last-event-id', `/v1/sessions/${id}/events/stream`, { 'last-event-id': 'x' }, '/v1/sessions/{unattributed}/events/stream');
  }
  await capture('stream-not-found', '/v1/sessions/00000000-0000-4000-8000-000000000000/events/stream', {}, '/v1/sessions/00000000-0000-4000-8000-000000000000/events/stream');
}

/** 600 requests a minute: the first refusal past the limit. Runs last; it exhausts the window. */
async function rateLimit({ inst, save, request, keptHeaders, parseBody }) {
  const auth = { authorization: `Bearer ${inst.token}` };
  for (let i = 0; i < 700; i++) {
    const res = await request(`http://127.0.0.1:${inst.port}/v1/health`, { headers: auth });
    if (res.status === 429) {
      save('api/rate-limited.json', { request: { method: 'GET', route: '/v1/health', note: 'repeated until the first refusal' }, response: { status: res.status, headers: keptHeaders(res.headers), body: parseBody(res.body) } });
      return;
    }
  }
  save('api/rate-limited.json', { request: { method: 'GET', route: '/v1/health', note: 'repeated 700 times' }, response: { status: 'never refused' } });
}

/** Action routes with "Allow actions" on. Only refusals: a real send needs a browser. */
async function actions({ inst, save, request, keptHeaders, parseBody }) {
  const base = `http://127.0.0.1:${inst.port}`;
  const auth = { authorization: `Bearer ${inst.token}` };
  const sessions = JSON.parse((await request(`${base}/v1/sessions`, { headers: auth })).body);
  const unattributed = sessions.sessions?.[0]?.id;
  const json = { 'content-type': 'application/json' };
  const id = '00000000-0000-4000-8000-000000000000';
  const cases = [
    ['send-not-found-session', '/v1/inputs', { headers: json, body: { id, sessionId: '00000000-0000-4000-8000-0000000000aa', text: 'hello' } }],
    ...(unattributed ? [['send-unattributed-session', '/v1/inputs', { headers: json, body: { id, sessionId: unattributed, text: 'hello' }, note: { id, sessionId: '<unattributed>', text: 'hello' } }]] : []),
    ['send-project-not-found', '/v1/inputs', { headers: json, body: { id, projectId: '00000000-0000-4000-8000-0000000000bb', text: 'hello' } }],
    ['send-empty-text', '/v1/inputs', { headers: json, body: { id, text: '   ' } }],
    ['send-uppercase-id', '/v1/inputs', { headers: json, body: { id: id.toUpperCase().replace('-4000-8000-', '-4000-8000-'), text: 'x' } }],
    ['send-unknown-field', '/v1/inputs', { headers: json, body: { id, text: 'x', extra: 1 } }],
    ['send-session-and-project', '/v1/inputs', { headers: json, body: { id, sessionId: '00000000-0000-4000-8000-0000000000aa', projectId: '00000000-0000-4000-8000-0000000000bb', text: 'x' } }],
    ['send-no-body', '/v1/inputs', { headers: {} }],
    ['send-invalid-json', '/v1/inputs', { headers: json, raw: '{"id":' }],
    ['send-wrong-content-type', '/v1/inputs', { headers: { 'content-type': 'text/plain' }, raw: '{}' }],
    ['send-query-string', '/v1/inputs?x=1', { headers: json, body: { id, text: 'x' } }],
    ['send-too-large', '/v1/inputs', { headers: json, raw: JSON.stringify({ id, text: 'x'.repeat(512 * 1024) }), note: '512 KiB + overhead' }],
    ['send-chunked', '/v1/inputs', { headers: { ...json, 'transfer-encoding': 'chunked' }, body: { id, text: 'x' } }],
    ['cancel-not-found', `/v1/inputs/${id}/cancel`, {}],
    ['cancel-with-body', `/v1/inputs/${id}/cancel`, { headers: json, body: { reason: 'x' } }],
    ['cancel-bad-id', '/v1/inputs/BAD/cancel', {}]
  ];
  for (const [caseId, route, c] of cases) {
    const body = c.raw ?? (c.body === undefined ? undefined : JSON.stringify(c.body));
    const headers = { ...c.headers, ...(body === undefined ? {} : { expect: '100-continue' }) };
    const res = await request(base + route, { method: 'POST', headers: { ...auth, ...headers }, body });
    save(`api/actions/${caseId}.json`, { request: { method: 'POST', route, headers, body: c.note ?? c.body ?? (c.raw ? parseBody(c.raw) : null) },
      response: { status: res.status, headers: keptHeaders(res.headers), body: parseBody(res.body), ...(res.transportError ? { transportError: res.transportError } : {}) } });
  }
  const limited = { request: { method: 'POST', route: `/v1/inputs/${id}/cancel`, note: 'repeated until the first refusal, at most 40 times' }, response: { status: 'never refused' } };
  for (let i = 0; i < 40; i++) {
    const res = await request(`${base}/v1/inputs/${id}/cancel`, { method: 'POST', headers: auth });
    if (res.status !== 429) continue;
    limited.response = { status: res.status, headers: keptHeaders(res.headers), body: parseBody(res.body) };
    break;
  }
  save('api/actions/rate-limited.json', limited);
}

// ---------------------------------------------------------------- call cases
const native = rel => ctx => path.join(ctx.dirs.project, rel);
const CORE_FILES = [
  { id: 'read-file', tool: 'read', args: { paths: ['/project/src/greeting.txt'] } },
  { id: 'read-dir', tool: 'read', args: { paths: ['/project/src'] } },
  { id: 'read-root', tool: 'read', args: { paths: ['/project'] } },
  { id: 'read-glob', tool: 'read', args: { paths: ['/project/src/*.txt'] } },
  { id: 'read-recursive-glob', tool: 'read', args: { paths: ['/project/**/*.md'] } },
  { id: 'read-multi', tool: 'read', args: { paths: ['/project/src/greeting.txt', '/project/src/notes.md'] } },
  { id: 'read-range', tool: 'read', args: { paths: ['/project/src/greeting.txt'], start_line: 2, end_line: 2 } },
  { id: 'read-range-past-end', tool: 'read', args: { paths: ['/project/src/greeting.txt'], start_line: 50 } },
  { id: 'read-max-bytes', tool: 'read', args: { paths: ['/project/src/greeting.txt'], max_bytes: 5 } },
  { id: 'read-large-default-cap', tool: 'read', args: { paths: ['/project/src/large.txt'] } },
  { id: 'read-binary', tool: 'read', args: { paths: ['/project/src/data.bin'] } },
  { id: 'read-image', tool: 'read', args: { paths: ['/project/src/pixel.png'] } },
  { id: 'read-native-inside', tool: 'read', args: ctx => ({ paths: [native('src/greeting.txt')(ctx)] }) },
  { id: 'read-skills-root', tool: 'read', args: { paths: ['/skills'] } },
  { id: 'read-missing', tool: 'read', args: { paths: ['/project/src/missing.txt'] } },
  { id: 'read-traversal', tool: 'read', args: { paths: ['/project/../../../package.json'] } },
  { id: 'read-outside-native', tool: 'read', args: { paths: ['C:/Windows/win.ini'] } },
  { id: 'read-unknown-root', tool: 'read', args: { paths: ['/nowhere/file.txt'] } },
  { id: 'read-relative', tool: 'read', args: { paths: ['src/greeting.txt'] } },
  { id: 'read-empty-paths', tool: 'read', args: { paths: [] } },
  { id: 'read-too-many-paths', tool: 'read', args: { paths: Array.from({ length: 21 }, () => '/project/README.md') } },
  { id: 'read-path-too-long', tool: 'read', args: { paths: [`/project/${'a'.repeat(4100)}`] }, argsNote: '{"paths":["/project/" + 4100 x "a"]}' },
  { id: 'read-max-bytes-over-limit', tool: 'read', args: { paths: ['/project/README.md'], max_bytes: 524289 } },
  { id: 'read-wrong-type', tool: 'read', args: { paths: '/project/README.md' } },
  { id: 'read-extra-field', tool: 'read', args: { paths: ['/project/README.md'], extra: true } },
  { id: 'read-no-args', tool: 'read', args: {} },
  { id: 'view-image', tool: 'view_image', args: { path: '/project/src/pixel.png' } },
  { id: 'view-image-text-file', tool: 'view_image', args: { path: '/project/src/greeting.txt' } },
  { id: 'view-image-missing', tool: 'view_image', args: { path: '/project/src/none.png' } },
  { id: 'view-image-outside', tool: 'view_image', args: { path: 'C:/Windows/win.ini' } },
  { id: 'view-image-no-path', tool: 'view_image', args: {} },
  { id: 'save-image-unattributed', tool: 'save_image', args: { path: '/project/out/generated.png' } },
  { id: 'save-image-bad-nth', tool: 'save_image', args: { path: '/project/out/generated.png', nth: 0 } },
  { id: 'patch-update', tool: 'apply_patch', args: { patch: patch('*** Update File: /project/src/greeting.txt\n@@\n-hello world\n+hello rust\n second line\n') }, disk: ['src/greeting.txt'] },
  { id: 'patch-add', tool: 'apply_patch', args: { patch: patch('*** Add File: /project/src/added.txt\n+added line one\n+added line two\n') }, disk: ['src/added.txt'] },
  { id: 'patch-move', tool: 'apply_patch', args: { patch: patch('*** Update File: /project/src/added.txt\n*** Move to: /project/src/moved.txt\n@@\n-added line one\n+moved line one\n added line two\n') }, disk: ['src/added.txt', 'src/moved.txt'] },
  { id: 'patch-delete', tool: 'apply_patch', args: { patch: patch('*** Delete File: /project/src/moved.txt\n') }, disk: ['src/moved.txt'] },
  { id: 'patch-multi-file', tool: 'apply_patch', args: { patch: patch('*** Add File: /project/src/a.txt\n+a\n*** Add File: /project/src/b.txt\n+b\n') }, disk: ['src/a.txt', 'src/b.txt'] },
  { id: 'patch-context-mismatch', tool: 'apply_patch', args: { patch: patch('*** Update File: /project/src/greeting.txt\n@@\n-this line is absent\n+x\n') }, disk: ['src/greeting.txt'] },
  { id: 'patch-add-existing', tool: 'apply_patch', args: { patch: patch('*** Add File: /project/src/greeting.txt\n+clobber\n') }, disk: ['src/greeting.txt'] },
  { id: 'patch-update-missing', tool: 'apply_patch', args: { patch: patch('*** Update File: /project/src/none.txt\n@@\n-a\n+b\n') } },
  { id: 'patch-delete-missing', tool: 'apply_patch', args: { patch: patch('*** Delete File: /project/src/none.txt\n') } },
  { id: 'patch-outside', tool: 'apply_patch', args: { patch: patch('*** Add File: C:/Windows/Temp/cos-golden.txt\n+x\n') } },
  { id: 'patch-traversal', tool: 'apply_patch', args: { patch: patch('*** Add File: /project/../escape.txt\n+x\n') } },
  { id: 'patch-malformed', tool: 'apply_patch', args: { patch: 'not a patch' } },
  { id: 'patch-no-end', tool: 'apply_patch', args: { patch: '*** Begin Patch\n*** Add File: /project/src/c.txt\n+c\n' } },
  { id: 'patch-empty', tool: 'apply_patch', args: { patch: '' } },
  { id: 'patch-heredoc', tool: 'apply_patch', args: { patch: "apply_patch <<'EOF'\n" + patch('*** Add File: /project/src/heredoc.txt\n+from heredoc\n') + 'EOF\n' }, disk: ['src/heredoc.txt'] },
  { id: 'patch-large-add', tool: 'apply_patch', args: { patch: patch('*** Add File: /project/src/big.txt\n' + Array.from({ length: 20_000 }, (_, i) => `+big ${i}`).join('\n') + '\n') }, argsNote: 'Add File /project/src/big.txt with 20000 lines "+big <i>"' },
  { id: 'patch-no-args', tool: 'apply_patch', args: {} },
  { id: 'read-after-patches', tool: 'read', args: { paths: ['/project/src'] } }
];

const stdinSession = ctx => {
  const sc = ctx.results['exec-stdin-session']?.structuredContent ?? {};
  return sc.session_id ?? sc.completed_session_id ?? -1;
};
const CORE_COMMANDS = [
  { id: 'exec-echo', tool: 'exec_command', args: { cmd: 'Write-Output golden-ok', workdir: '/project' } },
  { id: 'exec-exit-code', tool: 'exec_command', args: { cmd: 'exit 3', workdir: '/project' } },
  { id: 'exec-stderr', tool: 'exec_command', args: { cmd: '[Console]::Error.WriteLine("to-stderr"); Write-Output to-stdout', workdir: '/project' } },
  { id: 'exec-cmds', tool: 'exec_command', args: { cmds: ['Write-Output first', 'exit 2', 'Write-Output third'], workdir: '/project' } },
  { id: 'exec-cmd-and-cmds', tool: 'exec_command', args: { cmd: 'Write-Output a', cmds: ['Write-Output b'], workdir: '/project' } },
  { id: 'exec-neither', tool: 'exec_command', args: { workdir: '/project' } },
  { id: 'exec-git-status', tool: 'exec_command', args: { cmd: 'git status --short', workdir: '/project' } },
  { id: 'exec-rg', tool: 'exec_command', args: { cmd: 'rg -n quartz-lantern .', workdir: '/project' } },
  { id: 'exec-workdir-subfolder', tool: 'exec_command', args: { cmd: 'Get-ChildItem -Name', workdir: '/project/src' } },
  { id: 'exec-workdir-native', tool: 'exec_command', args: ctx => ({ cmd: 'Write-Output native-ok', workdir: ctx.dirs.project }) },
  { id: 'exec-workdir-outside', tool: 'exec_command', args: { cmd: 'Write-Output x', workdir: 'C:/Windows' } },
  { id: 'exec-workdir-traversal', tool: 'exec_command', args: { cmd: 'Write-Output x', workdir: '/project/..' } },
  { id: 'exec-workdir-missing', tool: 'exec_command', args: { cmd: 'Write-Output x', workdir: '/project/none' } },
  { id: 'exec-no-workdir', tool: 'exec_command', args: { cmd: 'Write-Output no-workdir' } },
  { id: 'exec-cmd-shell', tool: 'exec_command', args: { cmd: 'echo from-cmd', shell: 'cmd.exe', workdir: '/project' } },
  { id: 'exec-tty', tool: 'exec_command', args: { cmd: 'Write-Output tty-ok', tty: true, workdir: '/project' } },
  { id: 'exec-pipe-stdin-closed', tool: 'exec_command', args: { cmd: '$line = [Console]::In.ReadLine(); Write-Output "got [$line]"', workdir: '/project' } },
  { id: 'exec-stdin-session', tool: 'exec_command', args: { cmd: '$line = Read-Host; Write-Output "got [$line]"', tty: true, workdir: '/project', yield_time_ms: 3000 } },
  { id: 'stdin-write', tool: 'write_stdin', args: ctx => ({ session_id: stdinSession(ctx), chars: 'golden\r', yield_time_ms: 5000 }) },
  { id: 'stdin-replay-completed', tool: 'write_stdin', args: ctx => ({ session_id: stdinSession(ctx), chars: '' }) },
  { id: 'stdin-write-completed', tool: 'write_stdin', args: ctx => ({ session_id: stdinSession(ctx), chars: 'more\n' }) },
  { id: 'stdin-unknown-session', tool: 'write_stdin', args: { session_id: 987654, chars: '' } },
  { id: 'stdin-bad-type', tool: 'write_stdin', args: { session_id: 'abc' } },
  { id: 'exec-yield-out-of-range', tool: 'exec_command', args: { cmd: 'Write-Output y', workdir: '/project', yield_time_ms: 10 } },
  { id: 'exec-large-output', tool: 'exec_command', args: { cmd: '1..40000 | ForEach-Object { "output line $_" }', workdir: '/project' } },
  { id: 'exec-wrong-type', tool: 'exec_command', args: { cmd: 42 } },
  { id: 'exec-extra-field', tool: 'exec_command', args: { cmd: 'Write-Output x', nope: 1 } }
];

const CORE_PLAN_AND_CODE = [
  { id: 'plan-set', tool: 'update_plan', args: { explanation: 'golden', plan: [{ step: 'First', status: 'completed', details: 'done' }, { step: 'Second', status: 'in_progress' }, { step: 'Third', status: 'pending' }] } },
  { id: 'plan-two-in-progress', tool: 'update_plan', args: { plan: [{ step: 'A', status: 'in_progress' }, { step: 'B', status: 'in_progress' }] } },
  { id: 'plan-too-many', tool: 'update_plan', args: { plan: Array.from({ length: 13 }, (_, i) => ({ step: `S${i}`, status: 'pending' })) } },
  { id: 'plan-bad-status', tool: 'update_plan', args: { plan: [{ step: 'A', status: 'done' }] } },
  { id: 'plan-clear', tool: 'update_plan', args: { plan: [] } },
  { id: 'code-text', tool: 'exec', args: { code: 'text(1 + 1)' } },
  { id: 'code-no-output', tool: 'exec', args: { code: 'const x = 1;' } },
  { id: 'code-call-read', tool: 'exec', args: { code: 'const r = await tools.read({ paths: ["/project/src/notes.md"] }); text({ isError: r.isError ?? false, first: r.content[0].text.split("\\n")[0] });' } },
  { id: 'code-parallel', tool: 'exec', args: { code: 'const rs = await Promise.all([tools.read({ paths: ["/project/README.md"] }), tools.read({ paths: ["/project/none"] })]); text(rs.map(r => r.isError ?? false));' } },
  { id: 'code-unknown-tool', tool: 'exec', args: { code: 'await tools.no_such_tool({});' } },
  { id: 'code-throw', tool: 'exec', args: { code: 'throw new Error("golden failure")' } },
  { id: 'code-syntax-error', tool: 'exec', args: { code: 'let = ;' } },
  { id: 'code-image', tool: 'exec', args: { code: 'const r = await tools.view_image({ path: "/project/src/pixel.png" }); image(r.content.find(c => c.type === "image"));' } },
  { id: 'code-oversized-text', tool: 'exec', args: { code: 'text("x".repeat(50000))' } },
  { id: 'code-empty', tool: 'exec', args: { code: '' } },
  { id: 'code-no-node', tool: 'exec', args: { code: 'text(typeof require + " " + typeof process)' } }
];

const FIND = [
  { id: 'find-content', tool: 'find', args: { query: 'quartz-lantern', path: '/project', mode: 'content' } },
  { id: 'find-name', tool: 'find', args: { query: 'greeting', path: '/project', mode: 'name' } },
  { id: 'find-no-match', tool: 'find', args: { query: 'absent-needle-zz', path: '/project', mode: 'content' } },
  { id: 'find-outside', tool: 'find', args: { query: 'x', path: 'C:/Windows', mode: 'content' } },
  { id: 'find-missing-path', tool: 'find', args: { query: 'x', path: '/project/none' } },
  { id: 'find-bad-mode', tool: 'find', args: { query: 'x', path: '/project', mode: 'nope' } },
  { id: 'find-no-args', tool: 'find', args: {} },
  { id: 'exec-not-listed', tool: 'exec_command', args: { cmd: 'Write-Output x', workdir: '/project' } }
];

const AGENTS = [
  { id: 'agents-status', tool: 'agents', args: { action: 'status' } },
  { id: 'agents-spawn-unattributed', tool: 'agents', args: { action: 'spawn', workers: [{ label: 'Golden', task: 'Say hello.' }] } },
  { id: 'agents-message-unknown', tool: 'agents', args: { action: 'message', to: 'nobody', text: 'hi' } },
  { id: 'agents-finish-unattributed', tool: 'agents', args: { action: 'finish', result: 'RESULT: none' } },
  { id: 'agents-bad-action', tool: 'agents', args: { action: 'explode' } },
  { id: 'agents-bad-run-id', tool: 'agents', args: { action: 'status', run_id: 'not-a-uuid' } }
];

const READ_ONLY = [
  { id: 'read-file', tool: 'read', args: { paths: ['/project/src/greeting.txt'] } },
  { id: 'patch-update', tool: 'apply_patch', args: { patch: patch('*** Update File: /project/src/greeting.txt\n@@\n-hello world\n+hello rust\n second line\n') }, disk: ['src/greeting.txt'] },
  { id: 'patch-add', tool: 'apply_patch', args: { patch: patch('*** Add File: /project/src/added.txt\n+x\n') }, disk: ['src/added.txt'] },
  { id: 'exec-echo', tool: 'exec_command', args: { cmd: 'Write-Output golden-ok', workdir: '/project' } },
  { id: 'exec-write-file', tool: 'exec_command', args: { cmd: 'Set-Content -Path written.txt -Value x', workdir: '/project' }, disk: ['written.txt'] },
  { id: 'save-image', tool: 'save_image', args: { path: '/project/out/generated.png' } },
  { id: 'plan-set', tool: 'update_plan', args: { plan: [{ step: 'A', status: 'pending' }] } },
  { id: 'code-read', tool: 'exec', args: { code: 'const r = await tools.read({ paths: ["/project/src/greeting.txt"] }); text(r.isError ?? false);' } },
  { id: 'code-patch', tool: 'exec', args: { code: 'const r = await tools.apply_patch({ patch: "*** Begin Patch\\n*** Add File: /project/src/code.txt\\n+x\\n*** End Patch\\n" }); text({ isError: r.isError ?? false, text: r.content[0].text });' }, disk: ['src/code.txt'] }
];

const NO_FILES = [
  { id: 'read-file', tool: 'read', args: { paths: ['/project/src/greeting.txt'] } },
  { id: 'patch-add', tool: 'apply_patch', args: { patch: patch('*** Add File: /project/src/added.txt\n+x\n') }, disk: ['src/added.txt'] },
  { id: 'view-image', tool: 'view_image', args: { path: '/project/src/pixel.png' } },
  { id: 'exec-echo', tool: 'exec_command', args: { cmd: 'Write-Output golden-ok', workdir: '/project' } },
  { id: 'exec-read-file', tool: 'exec_command', args: { cmd: 'Get-Content src/greeting.txt', workdir: '/project' } }
];

const NOTHING = [
  { id: 'read-file', tool: 'read', args: { paths: ['/project/src/greeting.txt'] } },
  { id: 'exec-echo', tool: 'exec_command', args: { cmd: 'Write-Output golden-ok', workdir: '/project' } },
  { id: 'plan-set', tool: 'update_plan', args: { plan: [{ step: 'A', status: 'pending' }] } },
  { id: 'code-text', tool: 'exec', args: { code: 'text(1)' } }
];

const TWO_ROOTS = [
  { id: 'read-second-root', tool: 'read', args: { paths: ['/second'] } },
  { id: 'read-second-file', tool: 'read', args: { paths: ['/second/other.txt'] } },
  { id: 'read-both', tool: 'read', args: { paths: ['/project/src/greeting.txt', '/second/other.txt'] } },
  { id: 'read-glob-across', tool: 'read', args: { paths: ['/*/other.txt'] } },
  { id: 'patch-second', tool: 'apply_patch', args: { patch: patch('*** Add File: /second/new.txt\n+second root write\n') } },
  { id: 'patch-across-roots', tool: 'apply_patch', args: { patch: patch('*** Update File: /second/new.txt\n*** Move to: /project/src/from-second.txt\n@@\n-second root write\n+moved across roots\n') }, disk: ['src/from-second.txt'] },
  { id: 'exec-second-workdir', tool: 'exec_command', args: { cmd: 'Get-ChildItem -Name', workdir: '/second' } },
  { id: 'read-outside', tool: 'read', args: { paths: ['C:/Windows/win.ini'] } }
];

const FINISH = [
  { id: 'finish-unattributed', tool: 'session_finish', args: { summary: 'Golden corpus finish.' } },
  { id: 'finish-no-summary', tool: 'session_finish', args: {} },
  { id: 'finish-bad-args', tool: 'session_finish', args: { nope: 1 } }
];

// Desktop: only the recorder's own window, by its handle. No call lists or observes another
// window, reads or writes the clipboard, launches an app, or sends input: input methods are
// called only where the caller-identity guard refuses before any input, or with bad arguments.
const win = ctx => ({ app: ctx.results['get-window']?.structuredContent?.value?.app ?? 'unknown', id: ctx.target.hwnd });
const DESKTOP = [
  { id: 'get-window', tool: 'get_window', args: ctx => ({ id: ctx.target.hwnd }) },
  { id: 'get-window-not-found', tool: 'get_window', args: { id: 1 } },
  { id: 'get-window-bad-args', tool: 'get_window', args: { id: 'x' } },
  { id: 'state-text', tool: 'get_window_state', args: ctx => ({ window: win(ctx), include_screenshot: false, include_text: true }) },
  { id: 'state-query', tool: 'get_window_state', args: ctx => ({ window: win(ctx), include_screenshot: false, query: 'golden-button' }) },
  { id: 'state-screenshot', tool: 'get_window_state', args: ctx => ({ window: win(ctx), include_screenshot: true, include_text: false }), volatileImages: true },
  { id: 'state-not-found', tool: 'get_window_state', args: { window: { app: 'none', id: 1 }, include_screenshot: false, include_text: true } },
  { id: 'state-bad-args', tool: 'get_window_state', args: { window: 'x' } },
  { id: 'click-identity-refused', tool: 'click', args: ctx => ({ window: win(ctx), x: 10, y: 10 }) },
  { id: 'scroll-identity-refused', tool: 'scroll', args: ctx => ({ window: win(ctx), x: 10, y: 10, scrollX: 0, scrollY: 1 }) },
  { id: 'set-value-identity-refused', tool: 'set_value', args: ctx => ({ window: win(ctx), element_index: 1, value: 'x' }) },
  { id: 'drag-identity-refused', tool: 'drag', args: ctx => ({ window: win(ctx), from_x: 1, from_y: 1, to_x: 2, to_y: 2 }) },
  { id: 'secondary-identity-refused', tool: 'perform_secondary_action', args: ctx => ({ window: win(ctx), element_index: 1, action: 'invoke' }) },
  { id: 'press-key-bad-args', tool: 'press_key', args: { key: 42 } },
  { id: 'type-text-bad-args', tool: 'type_text', args: { text: 42 } },
  { id: 'activate-bad-args', tool: 'activate_window', args: { window: 'x' } },
  { id: 'launch-app-bad-args', tool: 'launch_app', args: { app: 42 } },
  { id: 'write-clipboard-bad-args', tool: 'write_clipboard', args: { text: 42 } },
  { id: 'read-clipboard-bad-args', tool: 'read_clipboard', args: { nope: 1 } },
  { id: 'browser-tabs-identity-refused', tool: 'browser_tabs', args: { action: 'list' } },
  { id: 'browser-tabs-bad-args', tool: 'browser_tabs', args: { action: 'attach' } },
  { id: 'browser-snapshot-identity-refused', tool: 'browser_snapshot', args: { tabId: '00000000-0000-4000-8000-000000000000:1' } },
  { id: 'browser-snapshot-bad-tab', tool: 'browser_snapshot', args: { tabId: 'x' } },
  { id: 'browser-screenshot-identity-refused', tool: 'browser_screenshot', args: { tabId: '00000000-0000-4000-8000-000000000000:1' } },
  { id: 'browser-navigate-identity-refused', tool: 'browser_navigate', args: { tabId: '00000000-0000-4000-8000-000000000000:1', pageId: '00000000-0000-4000-8000-000000000001', url: 'https://example.com' } },
  { id: 'browser-navigate-no-url', tool: 'browser_navigate', args: { tabId: '00000000-0000-4000-8000-000000000000:1', pageId: '00000000-0000-4000-8000-000000000001' } },
  { id: 'browser-action-identity-refused', tool: 'browser_action', args: { tabId: '00000000-0000-4000-8000-000000000000:1', pageId: '00000000-0000-4000-8000-000000000001', action: 'click', ref: 'e1' } },
  { id: 'browser-action-missing-ref', tool: 'browser_action', args: { tabId: '00000000-0000-4000-8000-000000000000:1', pageId: '00000000-0000-4000-8000-000000000001', action: 'fill' } },
  { id: 'browser-evaluate-identity-refused', tool: 'browser_evaluate', args: { tabId: '00000000-0000-4000-8000-000000000000:1', pageId: '00000000-0000-4000-8000-000000000001', expression: '1' } },
  { id: 'browser-console-identity-refused', tool: 'browser_console', args: { tabId: '00000000-0000-4000-8000-000000000000:1' } },
  { id: 'browser-network-identity-refused', tool: 'browser_network', args: { tabId: '00000000-0000-4000-8000-000000000000:1' } },
  { id: 'desktop-code-get-window', tool: 'exec', args: ctx => ({ code: `const r = await tools.get_window({ id: ${ctx.target.hwnd} }); text(r.structuredContent.value.title);` }) }
];

export const VARIANTS = [
  { id: 'base', about: 'Files and commands on, Desktop off, read-write, multi-agent off, one root, control actions off.',
    phases: [surfaces(), protocol, calls('core', [...CORE_FILES, ...CORE_COMMANDS, ...CORE_PLAN_AND_CODE]), guards, api, sse, rateLimit] },
  { id: 'no-command', about: 'Command execution off: find replaces exec_command/write_stdin.', caps: { command: false },
    phases: [surfaces(['core']), calls('core', FIND)] },
  { id: 'no-files', about: 'Every file capability off, commands on.', caps: FILE_CAPS_OFF,
    phases: [surfaces(['core']), calls('core', NO_FILES)] },
  { id: 'no-capabilities', about: 'Every capability off.', caps: ALL_OFF,
    phases: [surfaces(), calls('core', NOTHING)] },
  { id: 'read-only', about: 'Read-only mode on with every capability granted.', readOnly: true,
    phases: [surfaces(['core']), calls('core', READ_ONLY)] },
  { id: 'multi-agent', about: 'Multi-agent on (agents tool), unattributed calls not allowed.', multiAgent: true,
    phases: [surfaces(['core']), calls('core', AGENTS)] },
  { id: 'two-roots', about: 'Two approved roots, /project and /second.', secondRoot: true,
    phases: [surfaces(['core']), calls('core', TWO_ROOTS)] },
  { id: 'unattributed', about: 'Allow unattributed calls on: plan and code mode with a request-scoped caller (x-request-id).', allowUnattributed: true,
    phases: [surfaces(['core']), calls('core', CORE_PLAN_AND_CODE.map(c => ({ ...c, requestId: 'golden-request-1' })))] },
  { id: 'finish-tool', about: 'The session_finish tool switched on (ui.finishTool).', finishTool: true,
    phases: [surfaces(['core']), calls('core', FINISH)] },
  { id: 'desktop', about: 'Screen, control and both clipboard permissions on; calls only against the recorder-owned window.',
    caps: { screen: true, control: true, clipboardRead: true, clipboardWrite: true }, desktopTarget: true,
    phases: [surfaces(), calls('desktop', DESKTOP)] },
  { id: 'desktop-screen', about: 'Screen only: Desktop read tools without input or clipboard.', caps: { screen: true },
    phases: [surfaces(['desktop'])] },
  { id: 'actions', about: 'Control API actions allowed; only refusals are recorded.', allowActions: true,
    phases: [calls('core', [{ id: 'read-file', tool: 'read', args: { paths: ['/project/README.md'] } }]), actions] }
];
