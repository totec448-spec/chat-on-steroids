// Records how the MCP SDK the TypeScript app ships (@modelcontextprotocol/server 2.1.0:
// createMcpHandler, toNodeHandler, McpServer and the localhost guards, behind server.ts's body
// reader) answers JSON-RPC and header edge cases the golden corpus does not cover. The Rust
// endpoint's tests replay sdk-oracle.json. Cases named `modern-*` speak the 2026-07-28 era.
// Regenerate from the repository root after `npm ci`:
//
//   node rust/crates/cos-mcp/oracle/sdk-oracle.mjs > rust/crates/cos-mcp/oracle/sdk-oracle.json
import http from 'node:http';
import fs from 'node:fs';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const MAX = 8 * 1024 * 1024;
const build = () => {
  const server = new McpServer({ name: 'oracle', version: '1' }, { capabilities: { tools: {} }, instructions: 'hi' });
  server.registerTool('echo', { description: 'd', inputSchema: z.object({ text: z.string() }) }, async (args) => ({ content: [{ type: 'text', text: args.text }] }));
  return server;
};
// Wired as server.ts wires it: `onerror` goes to the Node adapter, so createMcpHandler's own
// reportError calls (a 415, a rejected envelope) reach nothing. `reported` records what did.
let reported = [];
const handler = toNodeHandler(createMcpHandler(build), { onerror: (e) => reported.push(e.message) });
const checkHost = localhostHostValidation();
const checkOrigin = localhostOriginValidation();
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []; let total = 0;
    req.on('data', (c) => { total += c.length; if (total > MAX) { resolve({ error: 'payload_too_large' }); req.resume(); return; } chunks.push(c); });
    req.on('end', () => { try { const t = Buffer.concat(chunks).toString('utf8'); resolve({ body: t.length === 0 ? null : JSON.parse(t) }); } catch { resolve({ error: 'invalid_json' }); } });
  });
}
const srv = http.createServer((req, res) => {
  if (!checkHost(req, res)) return;
  if (!checkOrigin(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    readBody(req).then((p) => {
      if (p.error) { res.writeHead(p.error === 'invalid_json' ? 400 : 413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: p.error })); return; }
      handler(req, res, p.body);
    });
    return;
  }
  handler(req, res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const KEPT = ['content-type', 'cache-control', 'allow', 'connection', 'mcp-session-id', 'x-accel-buffering'];
// Keep-alive, as the golden recorder's Node client is, so `connection` reads as it does there.
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
// `firstFrame`: the answer is a stream that stays open (subscriptions/listen), so only its first
// SSE frame is recorded, on a connection of its own that is then dropped.
function send({ method = 'POST', headers = {}, body, firstFrame = false }) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method, headers: h, setHost: !('host' in h), agent: firstFrame ? false : agent }, (res) => {
      const chunks = [];
      const done = () => resolve({
        request: { method, headers: h, body: body ?? null, ...(firstFrame && { firstFrame }) },
        response: { status: res.statusCode, headers: Object.fromEntries(KEPT.filter((k) => res.headers[k] !== undefined).map((k) => [k, res.headers[k]])), body: Buffer.concat(chunks).toString('utf8') }
      });
      res.on('data', (c) => {
        chunks.push(c);
        if (firstFrame && Buffer.concat(chunks).includes('\n\n')) { done(); req.destroy(); }
      });
      res.on('end', done);
    });
    req.on('error', reject);
    req.end(body);
  });
}
const j = (v) => JSON.stringify(v);
const rpc = (method, params, id = 1, extra = {}) => j({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }), ...extra });
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } };
const NOTE = { jsonrpc: '2.0', method: 'notifications/initialized' };
const ping = (id) => ({ jsonrpc: '2.0', id, method: 'ping' });
const P = rpc('ping', {});
const cases = {
  'init-no-params': { body: rpc('initialize') },
  'init-empty-params': { body: rpc('initialize', {}) },
  'init-no-version': { body: rpc('initialize', { ...INIT, clientInfo: { name: 'c' } }) },
  'init-version-number': { body: rpc('initialize', { ...INIT, protocolVersion: 5 }) },
  'init-caps-array': { body: rpc('initialize', { ...INIT, capabilities: [] }) },
  'init-clientinfo-null': { body: rpc('initialize', { ...INIT, clientInfo: null }) },
  'init-bad-header': { headers: { 'mcp-protocol-version': '1999-01-01' }, body: rpc('initialize', INIT) },
  'init-modern-header': { headers: { 'mcp-protocol-version': '2026-07-28' }, body: rpc('initialize', INIT) },
  'call-no-params': { body: rpc('tools/call') },
  'call-name-number': { body: rpc('tools/call', { name: 5 }) },
  'call-args-array': { body: rpc('tools/call', { name: 'echo', arguments: [] }) },
  'call-args-string': { body: rpc('tools/call', { name: 'echo', arguments: 'x' }) },
  'call-args-null': { body: rpc('tools/call', { name: 'echo', arguments: null }) },
  'call-ok': { body: rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }) },
  'call-no-args': { body: rpc('tools/call', { name: 'echo' }) },
  'call-unknown': { body: rpc('tools/call', { name: 'nope', arguments: {} }) },
  'call-name-and-args-bad': { body: rpc('tools/call', { name: 1, arguments: 2 }) },
  'list-cursor-number': { body: rpc('tools/list', { cursor: 5 }) },
  'list-params-null': { body: j({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: null }) },
  'list-params-array': { body: j({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: [] }) },
  'list-no-params': { body: rpc('tools/list') },
  'list-meta-progress': { body: rpc('tools/list', { _meta: { progressToken: 'p' } }) },
  'list-meta-bad-progress': { body: rpc('tools/list', { _meta: { progressToken: {} } }) },
  'ping-no-params': { body: rpc('ping') },
  'id-string': { body: rpc('ping', {}, 'abc') },
  'id-float': { body: rpc('ping', {}, 1.5) },
  'id-float-integral': { body: '{"jsonrpc":"2.0","id":1.0,"method":"ping"}' },
  'id-big': { body: '{"jsonrpc":"2.0","id":100000000000000000000,"method":"ping"}' },
  'id-negative': { body: rpc('ping', {}, -3) },
  'id-null': { body: '{"jsonrpc":"2.0","id":null,"method":"ping"}' },
  'extra-key': { body: rpc('ping', {}, 1, { extra: 1 }) },
  'jsonrpc-1': { body: '{"jsonrpc":"1.0","id":1,"method":"ping"}' },
  'method-number': { body: '{"jsonrpc":"2.0","id":1,"method":5}' },
  'body-number': { body: '123' },
  'body-null': { body: 'null' },
  'body-string': { body: '"x"' },
  'batch-two': { body: j([ping(1), { jsonrpc: '2.0', id: 2, method: 'tools/list' }]) },
  'batch-empty': { body: '[]' },
  'batch-invalid-element': { body: j([ping(1), 5]) },
  'batch-notifications': { body: j([NOTE, { jsonrpc: '2.0', method: 'x' }]) },
  'batch-init-and-notification': { body: j([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }, NOTE]) },
  'batch-bad-init-and-ping': { body: j([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ping(2)]) },
  'batch-101': { body: j(Array.from({ length: 101 }, (_, i) => ping(i))) },
  'batch-with-response': { body: j([{ jsonrpc: '2.0', id: 1, result: {} }, ping(2)]) },
  'batch-dup-id': { body: j([ping(1), ping(1)]) },
  'post-response': { body: j({ jsonrpc: '2.0', id: 1, result: {} }) },
  'post-error-response': { body: j({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'x' } }) },
  'notification-id-null': { body: '{"jsonrpc":"2.0","id":null,"method":"notifications/initialized"}' },
  'list-modern-header': { headers: { 'mcp-protocol-version': '2026-07-28' }, body: rpc('tools/list', {}) },
  'list-header-2024-10-07': { headers: { 'mcp-protocol-version': '2024-10-07' }, body: rpc('tools/list', {}) },
  'list-header-padded': { headers: { 'mcp-protocol-version': ' 2025-06-18 ' }, body: rpc('tools/list', {}) },
  'notification-bad-header': { headers: { 'mcp-protocol-version': '1999-01-01' }, body: j(NOTE) },
  'ct-charset': { headers: { 'content-type': 'application/json; charset=utf-8' }, body: P },
  'ct-upper': { headers: { 'content-type': 'APPLICATION/JSON' }, body: P },
  'ct-semicolon': { headers: { 'content-type': 'application/json;' }, body: P },
  'ct-bad-param-comma': { headers: { 'content-type': 'application/json; a=b, c' }, body: P },
  'ct-missing': { headers: { 'content-type': null }, body: P },
  'ct-plus-json': { headers: { 'content-type': 'application/vnd+json' }, body: P },
  'ct-wrong-invalid-json': { headers: { 'content-type': 'text/plain' }, body: '{' },
  'ct-space': { headers: { 'content-type': ' application/json ' }, body: P },
  'accept-star': { headers: { accept: '*/*' }, body: P },
  'accept-sse-only': { headers: { accept: 'text/event-stream' }, body: P },
  'accept-missing-notification': { headers: { accept: null }, body: j(NOTE) },
  'accept-missing-empty-body': { headers: { accept: null }, body: '' },
  'put': { method: 'PUT', body: P },
  'head': { method: 'HEAD' },
  'patch-no-ct': { method: 'PATCH', headers: { 'content-type': null }, body: '' },
  'get-json-accept': { method: 'GET', headers: { accept: 'application/json' } },
  'options': { method: 'OPTIONS' },
  'host-upper': { headers: { host: 'LOCALHOST:1' }, body: P },
  'host-short-ipv4': { headers: { host: '127.1' }, body: P },
  'host-int-ipv4': { headers: { host: '2130706433' }, body: P },
  'host-hex-ipv4': { headers: { host: '0x7f.0.0.1' }, body: P },
  'host-ipv6': { headers: { host: '[::1]:5' }, body: P },
  'host-ipv6-long': { headers: { host: '[0:0:0:0:0:0:0:1]' }, body: P },
  'host-bad-port': { headers: { host: 'localhost:abc' }, body: P },
  'host-empty-port': { headers: { host: 'localhost:' }, body: P },
  'host-empty': { headers: { host: '' }, body: P },
  'host-userinfo': { headers: { host: 'evil@localhost' }, body: P },
  'host-path': { headers: { host: 'localhost/x' }, body: P },
  'host-percent': { headers: { host: '%6cocalhost' }, body: P },
  'host-dot': { headers: { host: 'localhost.' }, body: P },
  'host-upper-foreign': { headers: { host: 'Evil.Example:80' }, body: P },
  'host-ip-foreign': { headers: { host: '10.0.0.1' }, body: P },
  'host-bad-ipv4': { headers: { host: '1.2.3.4.5' }, body: P },
  'host-bad-ipv4-b': { headers: { host: '1.2.3.256' }, body: P },
  'host-big-port': { headers: { host: 'localhost:70000' }, body: P },
  'host-ipv6-other': { headers: { host: '[::2]' }, body: P },
  'host-ipv6-unclosed': { headers: { host: '[::1' }, body: P },
  'host-space': { headers: { host: 'a b' }, body: P },
  'host-num-label': { headers: { host: 'foo.123' }, body: P },
  'origin-localhost': { headers: { origin: 'http://localhost' }, body: P },
  'origin-file': { headers: { origin: 'file:///x' }, body: P },
  'origin-file-localhost': { headers: { origin: 'file://localhost/x' }, body: P },
  'origin-custom-scheme': { headers: { origin: 'foo://localhost' }, body: P },
  'origin-custom-upper': { headers: { origin: 'foo://LOCALHOST' }, body: P },
  'origin-custom-noslash': { headers: { origin: 'foo:localhost' }, body: P },
  'origin-upper': { headers: { origin: 'HTTP://LOCALHOST:9' }, body: P },
  'origin-ext': { headers: { origin: 'chrome-extension://abcdef' }, body: P },
  'origin-noslash-http': { headers: { origin: 'http:localhost' }, body: P },
  'origin-empty': { headers: { origin: '' }, body: P },
  'origin-ipv6': { headers: { origin: 'http://[::1]:3' }, body: P },
  'origin-https-port': { headers: { origin: 'https://evil.example:8443' }, body: P },
  'origin-garbage': { headers: { origin: 'not a url' }, body: P },
  'origin-path': { headers: { origin: 'http://evil.example/path?q#f' }, body: P },
  'origin-userinfo': { headers: { origin: 'http://u:p@localhost' }, body: P },
  'unknown-method-modern': { body: rpc('server/discover', {}) },
  'completion': { body: rpc('completion/complete', {}) },
  'set-level': { body: rpc('logging/setLevel', { level: 'info' }) },
  'resources-templates': { body: rpc('resources/templates/list', {}) },
  'envelope-claim': { body: rpc('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } }) },
};
// The 2026-07-28 era: every request carries the `_meta` envelope and the standard headers.
const MODERN = '2026-07-28';
const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const INFO = 'io.modelcontextprotocol/clientInfo';
const LOG = 'io.modelcontextprotocol/logLevel';
const ENV = { [PV]: MODERN, [CAPS]: {}, [INFO]: { name: 'openai-mcp', version: '1.0.0' } };
const mh = (method, name) => ({ 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name === undefined ? {} : { 'mcp-name': name }) });
const mrpc = (method, params = {}, meta = {}, id = 1) => rpc(method, { ...params, _meta: { ...ENV, ...meta } }, id);
const without = (key) => Object.fromEntries(Object.entries(ENV).filter(([k]) => k !== key));
const note = (method, params) => j({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
const ECHO = { name: 'echo', arguments: { text: 'hi' } };
const LIST = mh('tools/list');
Object.assign(cases, {
  'modern-discover': { headers: mh('server/discover'), body: mrpc('server/discover') },
  'modern-list': { headers: LIST, body: mrpc('tools/list') },
  'modern-list-id-string': { headers: LIST, body: mrpc('tools/list', {}, {}, 'req-7') },
  'modern-list-cursor': { headers: LIST, body: mrpc('tools/list', { cursor: 'abc' }) },
  'modern-list-cursor-number': { headers: LIST, body: mrpc('tools/list', { cursor: 5 }) },
  'modern-list-progress': { headers: LIST, body: mrpc('tools/list', {}, { progressToken: 'p1' }) },
  'modern-list-extension-meta': { headers: LIST, body: mrpc('tools/list', {}, { 'openai/userAgent': 'x', 'io.modelcontextprotocol/other': 1 }) },
  'modern-list-log-level': { headers: LIST, body: mrpc('tools/list', {}, { [LOG]: 'info' }) },
  'modern-list-no-client-info': { headers: LIST, body: rpc('tools/list', { _meta: without(INFO) }) },
  'modern-list-no-accept': { headers: { ...LIST, accept: null }, body: mrpc('tools/list') },
  'modern-list-accept-json': { headers: { ...LIST, accept: 'application/json' }, body: mrpc('tools/list') },
  'modern-list-headers-padded': { headers: { 'mcp-protocol-version': ' 2026-07-28 ', 'mcp-method': ' tools/list ' }, body: mrpc('tools/list') },
  'modern-list-ct-charset': { headers: { ...LIST, 'content-type': 'application/json; charset=utf-8' }, body: mrpc('tools/list') },
  'modern-list-ct-wrong': { headers: { ...LIST, 'content-type': 'text/plain' }, body: mrpc('tools/list') },
  'modern-call-ok': { headers: mh('tools/call', 'echo'), body: mrpc('tools/call', ECHO) },
  'modern-call-id-string': { headers: mh('tools/call', 'echo'), body: mrpc('tools/call', ECHO, {}, 'call-1') },
  'modern-call-is-error': { headers: mh('tools/call', 'echo'), body: mrpc('tools/call', { name: 'echo', arguments: {} }) },
  'modern-call-no-args': { headers: mh('tools/call', 'echo'), body: mrpc('tools/call', { name: 'echo' }) },
  'modern-call-progress': { headers: mh('tools/call', 'echo'), body: mrpc('tools/call', ECHO, { progressToken: 7 }) },
  'modern-call-unknown': { headers: mh('tools/call', 'nope'), body: mrpc('tools/call', { name: 'nope', arguments: {} }) },
  'modern-call-args-array': { headers: mh('tools/call', 'echo'), body: mrpc('tools/call', { name: 'echo', arguments: [] }) },
  'modern-call-name-number': { headers: mh('tools/call'), body: mrpc('tools/call', { name: 5 }) },
  'modern-call-no-name': { headers: mh('tools/call'), body: mrpc('tools/call', { arguments: {} }) },
  'modern-call-no-name-header': { headers: mh('tools/call'), body: mrpc('tools/call', ECHO) },
  'modern-call-name-mismatch': { headers: mh('tools/call', 'other'), body: mrpc('tools/call', ECHO) },
  'modern-call-name-padded': { headers: mh('tools/call', ' echo '), body: mrpc('tools/call', ECHO) },
  'modern-call-name-base64': { headers: mh('tools/call', '=?base64?ZWNobw==?='), body: mrpc('tools/call', ECHO) },
  'modern-call-name-base64-bad': { headers: mh('tools/call', '=?base64?!!!?='), body: mrpc('tools/call', ECHO) },
  'modern-call-name-base64-mismatch': { headers: mh('tools/call', '=?base64?b3RoZXI=?='), body: mrpc('tools/call', ECHO) },
  'modern-call-name-header-on-list': { headers: mh('tools/list', 'echo'), body: mrpc('tools/list') },
  'modern-initialize': { headers: mh('initialize'), body: mrpc('initialize', INIT) },
  'modern-ping': { headers: mh('ping'), body: mrpc('ping') },
  'modern-set-level': { headers: mh('logging/setLevel'), body: mrpc('logging/setLevel', { level: 'info' }) },
  'modern-completion': { headers: mh('completion/complete'), body: mrpc('completion/complete', { ref: { type: 'ref/prompt', name: 'x' }, argument: { name: 'a', value: 'b' } }) },
  'modern-resources-list': { headers: mh('resources/list'), body: mrpc('resources/list') },
  'modern-prompts-list': { headers: mh('prompts/list'), body: mrpc('prompts/list') },
  'modern-unknown-method': { headers: mh('foo/bar'), body: mrpc('foo/bar') },
  'modern-no-version-header': { headers: { 'mcp-method': 'tools/list' }, body: mrpc('tools/list') },
  'modern-no-method-header': { headers: { 'mcp-protocol-version': MODERN }, body: mrpc('tools/list') },
  'modern-no-headers': { body: mrpc('tools/list') },
  'modern-no-headers-unknown-method': { body: mrpc('foo/bar') },
  'modern-method-header-mismatch': { headers: mh('tools/call'), body: mrpc('tools/list') },
  'modern-version-header-mismatch': { headers: { ...LIST, 'mcp-protocol-version': '2025-06-18' }, body: mrpc('tools/list') },
  'modern-version-header-bogus': { headers: { ...LIST, 'mcp-protocol-version': '1999-01-01' }, body: mrpc('tools/list') },
  'modern-claim-2025': { headers: { ...LIST, 'mcp-protocol-version': '2025-06-18' }, body: mrpc('tools/list', {}, { [PV]: '2025-06-18' }) },
  'modern-claim-future': { headers: { ...LIST, 'mcp-protocol-version': '2027-01-01' }, body: mrpc('tools/list', {}, { [PV]: '2027-01-01' }) },
  'modern-claim-future-no-headers': { body: mrpc('tools/list', {}, { [PV]: '2027-01-01' }) },
  'modern-envelope-version-number': { headers: LIST, body: mrpc('tools/list', {}, { [PV]: 5 }) },
  'modern-envelope-no-caps': { headers: LIST, body: rpc('tools/list', { _meta: without(CAPS) }) },
  'modern-envelope-caps-array': { headers: LIST, body: mrpc('tools/list', {}, { [CAPS]: [] }) },
  'modern-envelope-caps-null': { headers: LIST, body: mrpc('tools/list', {}, { [CAPS]: null }) },
  'modern-envelope-caps-extra': { headers: LIST, body: mrpc('tools/list', {}, { [CAPS]: { experimental: {}, roots: { listChanged: true }, 'openai/x': 1 } }) },
  'modern-envelope-caps-bad-member': { headers: LIST, body: mrpc('tools/list', {}, { [CAPS]: { roots: 5 } }) },
  'modern-envelope-info-null': { headers: LIST, body: mrpc('tools/list', {}, { [INFO]: null }) },
  'modern-envelope-info-no-version': { headers: LIST, body: mrpc('tools/list', {}, { [INFO]: { name: 'x' } }) },
  'modern-envelope-info-string': { headers: LIST, body: mrpc('tools/list', {}, { [INFO]: 'x' }) },
  'modern-envelope-log-level-bad': { headers: LIST, body: mrpc('tools/list', {}, { [LOG]: 'loud' }) },
  'modern-envelope-progress-bad': { headers: LIST, body: mrpc('tools/list', {}, { progressToken: {} }) },
  'modern-envelope-version-null': { headers: LIST, body: mrpc('tools/list', {}, { [PV]: null }) },
  'modern-envelope-log-level-number': { headers: LIST, body: mrpc('tools/list', {}, { [LOG]: 5 }) },
  'modern-envelope-info-and-caps-bad': { headers: LIST, body: mrpc('tools/list', {}, { [INFO]: 5, [CAPS]: 5 }) },
  'modern-envelope-caps-and-log-bad': { headers: LIST, body: mrpc('tools/list', {}, { [CAPS]: 5, [LOG]: 'x' }) },
  ...Object.fromEntries(Object.entries({
    'experimental-number': { experimental: 5 },
    'experimental-member': { experimental: { a: 5 } },
    'experimental-array': { experimental: [] },
    'sampling-number': { sampling: 5 },
    'sampling-tools': { sampling: { tools: 5 } },
    'sampling-context': { sampling: { context: [] } },
    'elicitation-number': { elicitation: 5 },
    'elicitation-empty': { elicitation: {} },
    'elicitation-form': { elicitation: { form: 5 } },
    'elicitation-form-defaults': { elicitation: { form: { applyDefaults: 'x' } } },
    'elicitation-url': { elicitation: { url: [] } },
    'elicitation-extra': { elicitation: { other: 5 } },
    'roots-list-changed': { roots: { listChanged: 'x' } },
    'roots-array': { roots: [] },
    'extensions-member': { extensions: { 'a/b': 'y' } },
    'extensions-null': { extensions: null },
    'tasks': { tasks: 5 },
    'sampling-and-roots': { sampling: 5, roots: 5 },
  }).map(([name, caps]) => [`modern-caps-${name}`, { headers: LIST, body: mrpc('tools/list', {}, { [CAPS]: caps }) }])),
  ...Object.fromEntries(Object.entries({
    'empty': {},
    'name-number': { name: 5, version: '1' },
    'title-number': { name: 'a', title: 5, version: '1' },
    'version-number': { name: 'a', version: 5 },
    'website-number': { name: 'a', version: '1', websiteUrl: 5 },
    'description-number': { name: 'a', version: '1', description: 5 },
    'icons-string': { name: 'a', version: '1', icons: 'x' },
    'icons-number-element': { name: 'a', version: '1', icons: [5] },
    'icons-no-src': { name: 'a', version: '1', icons: [{}] },
    'icons-mime': { name: 'a', version: '1', icons: [{ src: 's', mimeType: 5 }] },
    'icons-sizes': { name: 'a', version: '1', icons: [{ src: 's', sizes: 'x' }] },
    'icons-size-element': { name: 'a', version: '1', icons: [{ src: 's', sizes: ['1', 2] }] },
    'icons-theme': { name: 'a', version: '1', icons: [{ src: 's', theme: 'blue' }] },
    'icons-second': { name: 'a', version: '1', icons: [{ src: 's', theme: 'dark' }, { src: 5 }] },
    'icons-before-version': { name: 'a', icons: 5 },
    'full': { name: 'a', title: 't', version: '1', websiteUrl: 'w', description: 'd', icons: [{ src: 's', mimeType: 'image/png', sizes: ['48x48'], theme: 'light' }], extra: 1 },
  }).map(([name, info]) => [`modern-info-${name}`, { headers: LIST, body: mrpc('tools/list', {}, { [INFO]: info }) }])),
  'modern-call-task-number': { headers: mh('tools/call', 'echo'), body: mrpc('tools/call', { ...ECHO, task: 5 }) },
  'modern-call-extra-param': { headers: mh('tools/call', 'echo'), body: mrpc('tools/call', { ...ECHO, other: 5 }) },
  'modern-discover-extra-param': { headers: mh('server/discover'), body: mrpc('server/discover', { other: 5 }) },
  'modern-list-meta-related-task-bad': { headers: LIST, body: mrpc('tools/list', {}, { 'io.modelcontextprotocol/related-task': 5 }) },
  'modern-id-float-integral': { headers: LIST, body: mrpc('tools/list', {}, {}, 1).replace('"id":1', '"id":1.0') },
  'modern-envelope-only-claim': { headers: LIST, body: rpc('tools/list', { _meta: { [PV]: MODERN } }) },
  'modern-envelope-two-issues': { headers: LIST, body: rpc('tools/list', { _meta: { [PV]: 5 } }) },
  'modern-header-no-meta': { headers: LIST, body: rpc('tools/list', {}) },
  'modern-header-no-params': { headers: LIST, body: rpc('tools/list') },
  'modern-header-partial-meta': { headers: LIST, body: rpc('tools/list', { _meta: { progressToken: 'p' } }) },
  'modern-header-caps-only': { headers: LIST, body: rpc('tools/list', { _meta: { [CAPS]: {} } }) },
  'modern-header-future-no-claim': { headers: { 'mcp-protocol-version': '2027-01-01' }, body: rpc('tools/list', {}) },
  'modern-initialize-claim-2025': { body: rpc('initialize', { ...INIT, _meta: { [PV]: '2025-06-18' } }) },
  'modern-initialize-bad-claim': { headers: mh('initialize'), body: rpc('initialize', { ...INIT, _meta: { [PV]: MODERN } }) },
  'modern-batch': { body: j([JSON.parse(mrpc('tools/list')), ping(2)]) },
  'modern-batch-single': { headers: LIST, body: j([JSON.parse(mrpc('tools/list'))]) },
  'modern-note-header': { headers: mh('notifications/initialized'), body: j(NOTE) },
  'modern-note-cancelled': { headers: mh('notifications/cancelled'), body: note('notifications/cancelled', { requestId: 1 }) },
  'modern-note-claim': { body: note('notifications/cancelled', { requestId: 1, _meta: { [PV]: MODERN } }) },
  'modern-note-claim-2025': { body: note('notifications/initialized', { _meta: { [PV]: '2025-06-18' } }) },
  'modern-note-bad-claim': { body: note('notifications/initialized', { _meta: { [PV]: 1 } }) },
  'modern-note-claim-header-mismatch': { headers: { 'mcp-protocol-version': '2025-06-18' }, body: note('notifications/initialized', { _meta: { [PV]: MODERN } }) },
  'modern-note-method-mismatch': { headers: mh('notifications/progress'), body: j(NOTE) },
  'modern-note-claim-method-mismatch': { headers: { 'mcp-method': 'x' }, body: note('notifications/initialized', { _meta: { [PV]: MODERN } }) },
  'modern-note-future-header': { headers: { 'mcp-protocol-version': '2027-01-01' }, body: j(NOTE) },
  'modern-response-post': { headers: LIST, body: j({ jsonrpc: '2.0', id: 1, result: {} }) },
  'modern-get': { method: 'GET', headers: LIST },
  'modern-delete': { method: 'DELETE', headers: LIST },
  'modern-empty-body': { headers: LIST, body: '' },
  'modern-listen': { headers: mh('subscriptions/listen'), body: mrpc('subscriptions/listen', { notifications: { toolsListChanged: true } }), firstFrame: true },
  'modern-listen-string-id': { headers: mh('subscriptions/listen'), body: mrpc('subscriptions/listen', { notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['file:///x'] } }, {}, 'sub-1'), firstFrame: true },
  'modern-listen-empty-filter': { headers: mh('subscriptions/listen'), body: mrpc('subscriptions/listen', { notifications: {} }), firstFrame: true },
  'modern-listen-no-filter': { headers: mh('subscriptions/listen'), body: mrpc('subscriptions/listen') },
  'modern-listen-bad-filter': { headers: mh('subscriptions/listen'), body: mrpc('subscriptions/listen', { notifications: { toolsListChanged: 'yes' } }) },
});
const only = process.argv[2] ? process.argv[2].split(',') : null;
const out = {};
for (const [name, c] of Object.entries(cases)) {
  if (only && !only.includes(name)) continue;
  reported = [];
  try { out[name] = await send(c); } catch (e) { out[name] = { error: e.message }; }
  out[name].reported = reported;
}
fs.writeFileSync(1, JSON.stringify(out, null, 1) + '\n');
srv.close(); process.exit(0);
