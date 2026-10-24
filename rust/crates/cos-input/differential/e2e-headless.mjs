#!/usr/bin/env node
// End to end through the real binary, as the unchanged extension (protocol 14) and a control API
// caller talk to it. The first launch records a chat over the bridge, and /v1 queues one message
// to that chat and one that opens a new chat. After a restart, each is claimed, authorized and
// acknowledged over the bridge while the wake socket hears each change; the sent message appears
// in its chat's session, and the new chat's reserved session is bound to the chat its receipt
// names, all read back through /v1.
//
//   node rust/crates/cos-input/differential/e2e-headless.mjs <cos-headless.exe>
//
// The binary runs on a fresh profile under .tmp/input-e2e with CLF_BRIDGE_PORTS=0, so it never
// listens where a real extension looks. Exit 0 when every check holds.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const binary = path.resolve(process.argv[2] ?? path.join(repo, 'rust/target/release/cos-headless.exe'));
const run = path.join(repo, '.tmp', 'input-e2e', `run-${Date.now()}`);
const profile = path.join(run, 'profile');
fs.mkdirSync(profile, { recursive: true });
const CHAT = 'e2e3e2e3-1111-4111-8111-000000000001';
const INPUT = 'e2e3e2e3-2222-4222-8222-000000000002';
const OPENING = 'e2e3e2e3-3333-4333-8333-000000000003';
const NEW_CHAT = 'e2e3e2e3-4444-4444-8444-000000000004';
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

const project = path.join(run, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  roots: [{ name: 'project', path: project }],
  capabilities: { browse: true, search: true, read: true, metadata: true, create: false, edit: false, move: false, deleteFile: false,
    command: false, screen: false, control: false, clipboardRead: false, clipboardWrite: false },
  readOnly: false,
  multiAgent: { enabled: false, allowUnattributedCalls: false },
  tunnel: { kind: 'manual', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '' },
  ui: { minimizeToTray: false, autoConnect: true, language: 'en', lastSeenVersion: '2.1.35', turnNotifications: false,
    keepAwake: false, startAtLogin: false, localAppUsage: false, autoRefreshPlugins: false, autoRefreshPluginsAsked: true },
  controlApi: { enabled: true, allowActions: true }
}, null, 2));

let child = null;
const launch = () => {
  fs.rmSync(path.join(profile, 'app.log'), { force: true });
  child = spawn(binary, [`--user-data-dir=${profile}`], {
    env: { ...process.env, CLF_BRIDGE_PORTS: '0', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' },
    stdio: 'ignore', windowsHide: true
  });
};
const kill = () => { if (child) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); child = null; };
const connect = async () => {
  const port = Number(await until('the bridge listens', () => /bridge listening on 127\.0\.0\.1:(\d+)/.exec(log())?.[1]));
  const call = (route, body, token) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { ...EXTENSION, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const token = await until('pairing', async () => (await call('/pair', {})).body?.token);
  const bridge = (route, body) => until(`admission for ${route}`, async () => {
    const answer = await call(route, body, token);
    return answer.status === 503 && answer.body?.error === 'bridge_recovering' ? null : answer;
  });
  const endpoint = await until('the control API', () => JSON.parse(fs.readFileSync(path.join(profile, 'control-api', 'endpoint.json'), 'utf8')));
  const control = fs.readFileSync(path.join(profile, 'control-api', 'token'), 'utf8').trim();
  const v1 = (route, body) => fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${control}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  return { port, token, bridge, v1 };
};

try {
  launch();
  let { bridge, v1 } = await connect();
  const events = await bridge('/events', { conversationId: CHAT, events: [
    { kind: 'conversation_title', text: 'Outbox end to end', time: Date.now() - 5_000 },
    { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() - 5_000 },
    { kind: 'user_message', messageId: 'e2e-question', text: 'Hello', time: Date.now() - 4_000, authoredNow: true },
    { kind: 'turn_start', turnId: 'e2e-turn', time: Date.now() - 3_900 },
    { kind: 'assistant_message', messageId: 'e2e-answer', turnId: 'e2e-turn', text: 'Hi', state: 'final', final: true, time: Date.now() - 3_000 },
    { kind: 'turn_end', turnId: 'e2e-turn', outcome: 'completed', time: Date.now() - 2_900 }
  ] });
  report.checks.events = events.body;
  const session = events.body.sessionId;
  const queued = await v1('/v1/inputs', { id: INPUT, sessionId: session, text: 'Read the notes again' });
  const opened = await v1('/v1/inputs', { id: OPENING, text: 'Open a new chat' });
  report.checks.queued = { status: queued.status, state: queued.body.input?.state, conversationId: queued.body.input?.conversationId };
  report.checks.opened = { status: opened.status, sessionId: opened.body.input?.sessionId, state: opened.body.input?.state };
  // Let the session store finish its coalesced writes before the hard stop.
  await sleep(1_500);
  kill();

  launch();
  const connected = await connect();
  bridge = connected.bridge;
  v1 = connected.v1;
  const wakes = [];
  const socket = new WebSocket(`ws://127.0.0.1:${connected.port}/wake?host=browser`);
  socket.addEventListener('message', (event) => wakes.push(String(event.data)));
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  socket.send(connected.token);
  await until('the authenticated wake', () => wakes.length >= 1);
  const claim = (body) => bridge('/input/claim', { id: INPUT, owner: 'e2e-page', conversationId: CHAT, ...body });
  const claimed = await claim({ requiresAuthorization: true });
  report.checks.claim = { status: claimed.status, owner: claimed.body.input?.owner, text: claimed.body.input?.text };
  await until('a wake after the claim', () => wakes.length >= 2);
  const onDisk = JSON.parse(fs.readFileSync(path.join(profile, 'state', 'session-input.json'), 'utf8')).find((row) => row.id === INPUT);
  report.checks.claimOnDisk = { state: onDisk.state, owner: onDisk.owner };
  const authorized = await claim({ authorize: true });
  report.checks.authorize = authorized.body;
  const acked = await bridge('/input/ack', { id: INPUT, owner: 'e2e-page', conversationId: CHAT, messageId: 'e2e-sent' });
  report.checks.ack = acked.body;
  const opening = (route, body) => bridge(route, { id: OPENING, owner: 'e2e-new-tab', ...body });
  const openClaim = await opening('/input/claim', { conversationId: null, requiresAuthorization: true });
  const openAuthorized = await opening('/input/claim', { conversationId: null, authorize: true });
  const openAcked = await opening('/input/ack', { conversationId: NEW_CHAT, messageId: 'e2e-opened' });
  report.checks.opening = { claim: openClaim.body.input?.state, authorize: openAuthorized.body, ack: openAcked.body };
  report.checks.wakes = wakes.length;
  socket.close();

  const sent = await until('the sent message is in the chat session', async () => {
    const page = (await v1(`/v1/sessions/${session}/events?limit=50`)).body;
    return page.events?.find((event) => event.kind === 'user_message' && event.messageId === 'e2e-sent');
  });
  report.checks.session = { kind: sent.kind, messageId: sent.messageId, text: sent.text ?? sent.message?.text ?? null };
  const newChat = (await v1(`/v1/sessions/${OPENING}`)).body.session;
  report.checks.newChat = { conversationId: newChat?.conversationId, origin: newChat?.origin?.kind };
  const listed = (await v1('/v1/inputs?state=sent')).body;
  report.checks.inputs = listed.inputs?.map((input) => ({ id: input.id, delivery: input.delivery, sessionId: input.sessionId, conversationId: input.conversationId }));
  const ledger = JSON.parse(fs.readFileSync(path.join(profile, 'state', 'session-input.json'), 'utf8')).find((row) => row.id === INPUT);
  report.checks.ledger = { state: ledger.state, messageId: ledger.messageId, historyRecorded: ledger.historyRecorded };

  const ok = typeof session === 'string' && queued.status === 202 && opened.status === 202 && opened.body.input?.sessionId === OPENING &&
    claimed.status === 200 && report.checks.claim.owner === 'e2e-page' &&
    report.checks.claimOnDisk.state === 'browser' && report.checks.claimOnDisk.owner === 'e2e-page' &&
    authorized.body.ok === true && acked.body.ok === true && report.checks.wakes >= 3 &&
    ledger.state === 'sent' && ledger.messageId === 'e2e-sent' && ledger.historyRecorded === true &&
    openAuthorized.body.ok === true && openAcked.body.ok === true &&
    newChat?.conversationId === NEW_CHAT && newChat?.origin?.kind === 'desktop' &&
    listed.total === 2 && listed.inputs.every((input) => input.delivery === 'sent');
  report.result = ok ? 'pass' : 'fail';
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  report.result = `error: ${error.message}`;
  report.log = log().split(/\r?\n/).slice(-40);
  process.exitCode = 1;
} finally {
  kill();
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
