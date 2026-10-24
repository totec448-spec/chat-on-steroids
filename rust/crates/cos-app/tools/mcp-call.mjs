// Calls one Core MCP tool on a running app, through the URL in its COS_MCP_URLS_FILE.
// usage: node mcp-call.mjs <mcp-urls.json> <tool> '<arguments json>' [repeat=1]
import fs from 'node:fs';

const [urlsFile, tool, args = '{}', repeat = '1'] = process.argv.slice(2);
const url = JSON.parse(fs.readFileSync(urlsFile, 'utf8')).core;
let session, protocol, next = 0;
async function rpc(method, params, notification = false) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(session ? { 'mcp-session-id': session } : {}), ...(protocol ? { 'mcp-protocol-version': protocol } : {}) };
  const id = notification ? undefined : ++next;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  session ??= res.headers.get('mcp-session-id') ?? undefined;
  const body = await res.text();
  if (res.status >= 400) throw new Error(`${method}: HTTP ${res.status} ${body.slice(0, 200)}`);
  if (notification) return;
  const messages = String(res.headers.get('content-type')).includes('text/event-stream')
    ? body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
    : [JSON.parse(body)];
  return messages.find(m => m.id === id);
}
protocol = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cos-app-drive', version: '1' } })).result.protocolVersion;
await rpc('notifications/initialized', undefined, true);
for (let i = 0; i < Number(repeat); i++) {
  const reply = await rpc('tools/call', { name: tool, arguments: JSON.parse(args) });
  console.log(JSON.stringify(reply).slice(0, 300));
}
