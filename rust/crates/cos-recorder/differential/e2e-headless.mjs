#!/usr/bin/env node
// End to end through the real binary: a page reports a chat and proves a request id over the
// bridge, then a Core MCP call carrying that request id is filed in that chat's session. Then a
// call whose request id no page has proved yet lands in Unattributed activity, and moves to the
// chat once the page proves it (late proof).
//
//   node rust/crates/cos-recorder/differential/e2e-headless.mjs <cos-headless.exe>
//
// The binary runs on a fresh profile under .tmp/recorder-e2e with CLF_BRIDGE_PORTS=0, so it
// never listens where a real extension looks. The requests carry the headers the unchanged
// extension sends (protocol 14). Exit 0 when every check holds.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const binary = path.resolve(process.argv[2] ?? path.join(repo, 'rust/target/release/cos-headless.exe'));
const run = path.join(repo, '.tmp', 'recorder-e2e', `run-${Date.now()}`);
const profile = path.join(run, 'profile');
const project = path.join(run, 'project');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'hello.txt'), 'hello from the recorder end to end\n');
const CHAT = 'e2e0e2e0-1111-4111-8111-000000000001';
const REQUEST = 'wfr_e2e_recorder_1';
const LATE = 'wfr_e2e_recorder_late';
const EXTENSION = { 'x-extension-version': '2.1.35', 'x-extension-protocol': '14', 'content-type': 'application/json' };
const report = { run, checks: {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what, probe, ms = 45_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const value = await probe(); if (value) return value; } catch {}
    await sleep(200);
  }
  throw new Error(`timed out: ${what}`);
};
const log = () => { try { return fs.readFileSync(path.join(profile, 'app.log'), 'utf8'); } catch { return ''; } };
const json = async (response) => {
  const text = await response.text();
  const data = text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5)).join('')
    : text;
  return { status: response.status, body: data ? JSON.parse(data) : null, headers: response.headers };
};

fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  roots: [{ name: 'project', path: project }],
  capabilities: { browse: true, search: true, read: true, metadata: true, create: false, edit: false, move: false, deleteFile: false,
    command: false, screen: false, control: false, clipboardRead: false, clipboardWrite: false },
  readOnly: false,
  multiAgent: { enabled: false, allowUnattributedCalls: false },
  tunnel: { kind: 'manual', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '' },
  ui: { minimizeToTray: false, autoConnect: true, language: 'en', lastSeenVersion: '2.1.35', turnNotifications: false,
    keepAwake: false, startAtLogin: false, localAppUsage: false, autoRefreshPlugins: false, autoRefreshPluginsAsked: true },
  controlApi: { enabled: true, allowActions: false }
}, null, 2));

const child = spawn(binary, [`--user-data-dir=${profile}`], {
  env: { ...process.env, CLF_BRIDGE_PORTS: '0', COS_MCP_URLS_FILE: path.join(profile, 'mcp-urls.json'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' },
  stdio: 'ignore', windowsHide: true
});
try {
  const port = Number(await until('the bridge listens', () => /bridge listening on 127\.0\.0\.1:(\d+)/.exec(log())?.[1]));
  const bridge = (route, body, token) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { ...EXTENSION, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
  }).then(json);
  const token = await until('pairing', async () => (await bridge('/pair', {})).body?.token);
  const events = await until('admission', async () => {
    const answer = await bridge('/events', { conversationId: CHAT, events: [
      { kind: 'conversation_title', text: 'Recorder end to end', time: Date.now() },
      { kind: 'user_message', messageId: 'e2e-question', text: 'Read the file please', time: Date.now(), authoredNow: true },
      { kind: 'turn_start', turnId: 'e2e-turn', time: Date.now() }
    ] }, token);
    return answer.status === 200 ? answer : null;
  });
  report.checks.events = events.body;
  const correlated = await bridge('/correlations', { conversationId: CHAT, calls: [{ requestId: REQUEST, messageId: null }] }, token);
  report.checks.correlations = correlated.body;

  const urls = await until('MCP URLs', () => JSON.parse(fs.readFileSync(path.join(profile, 'mcp-urls.json'), 'utf8')));
  const mcp = (body, extra = {}) => fetch(urls.core, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...extra },
    body: JSON.stringify(body)
  }).then(json);
  await until('Core MCP', async () => (await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cos-recorder-e2e', version: '1' } } })).status === 200);
  const call = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { paths: ['/project/hello.txt'] } } },
    { 'x-request-id': `${REQUEST}/attempt-1` });
  const text = (call.body?.result?.content ?? []).map((part) => part.text ?? '').join('\n');
  report.checks.identityNotice = text.includes('Identity notice');

  const endpoint = JSON.parse(fs.readFileSync(path.join(profile, 'control-api', 'endpoint.json'), 'utf8'));
  const control = fs.readFileSync(path.join(profile, 'control-api', 'token'), 'utf8').trim();
  const v1 = (route) => fetch(`http://127.0.0.1:${endpoint.port}${route}`, { headers: { authorization: `Bearer ${control}` } }).then(json);
  const listed = await until('the chat session is listed', async () => {
    const page = await v1('/v1/sessions?limit=20');
    return page.body?.sessions?.find((session) => session.conversationId === CHAT);
  });
  report.checks.session = { id: listed.id, title: listed.title, conversationId: listed.conversationId };
  const filed = await until('the call is in the chat session', async () => {
    const page = await v1(`/v1/sessions/${listed.id}/events?limit=50`);
    return page.body?.events?.find((event) => event.kind === 'tool_call');
  });
  report.checks.toolCall = { name: filed.tool?.name, attribution: filed.tool?.attribution, summary: filed.tool?.summary?.title };
  const ledger = JSON.parse(fs.readFileSync(path.join(profile, 'state', 'request-correlations.json'), 'utf8'));
  report.checks.ledger = ledger.entries.find((entry) => entry.requestId === REQUEST) ?? null;

  const late = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read', arguments: { paths: ['/project/hello.txt'] } } },
    { 'x-request-id': LATE });
  report.checks.lateAnswered = late.status === 200 && !late.body?.result?.isError;
  const bucket = await until('the unproven call is in Unattributed activity', async () => {
    const page = await v1('/v1/sessions?limit=20');
    const found = page.body?.sessions?.find((session) => session.title === 'Unattributed activity' && session.conversationId === null);
    if (!found) return null;
    const calls = (await v1(`/v1/sessions/${found.id}/events?limit=50`)).body?.events?.filter((event) => event.kind === 'tool_call') ?? [];
    return calls.length === 1 ? { id: found.id, call: calls[0] } : null;
  });
  report.checks.unattributed = { session: bucket.id, callId: bucket.call.tool?.callId, attribution: bucket.call.tool?.attribution };
  const proved = await bridge('/correlations', { conversationId: CHAT, calls: [{ requestId: LATE, messageId: 'e2e-late' }] }, token);
  report.checks.lateCorrelations = proved.body;
  const moved = await until('the late call moved to the chat', async () => {
    const calls = (await v1(`/v1/sessions/${listed.id}/events?limit=50`)).body?.events?.filter((event) => event.kind === 'tool_call') ?? [];
    return calls.find((event) => event.tool?.callId === bucket.call.tool?.callId);
  });
  const left = (await v1(`/v1/sessions/${bucket.id}/events?limit=50`)).body?.events?.filter((event) => event.kind === 'tool_call') ?? [];
  report.checks.lateMoved = { callId: moved.tool?.callId, attribution: moved.tool?.attribution, leftInUnattributed: left.length };

  const ok = events.body.sessionId === listed.id && events.body.stored === 3 &&
    report.checks.lateAnswered && report.checks.unattributed.attribution === 'unattributed' &&
    proved.body?.complete === true && report.checks.lateMoved.attribution === 'request_id' &&
    report.checks.lateMoved.leftInUnattributed === 0 &&
    correlated.body.complete === true && correlated.body.sessionId === listed.id &&
    listed.title === 'Recorder end to end' && report.checks.identityNotice === false &&
    report.checks.toolCall.name === 'read' && report.checks.toolCall.attribution === 'request_id' &&
    report.checks.ledger?.sessionId === listed.id;
  report.result = ok ? 'pass' : 'fail';
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  report.result = `error: ${error.message}`;
  report.log = log().split(/\r?\n/).slice(-40);
  process.exitCode = 1;
} finally {
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
