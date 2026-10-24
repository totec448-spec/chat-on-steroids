// Proves the GPUI models follow the Core live, through the UI driver alone. A real cos-app runs on
// a fresh profile under .tmp/cos-app-binding with CLF_BRIDGE_PORTS=0 and a dead proxy. Chats are
// recorded over the bridge with the extension's headers, as the extension records them (the
// control API cannot create a chat yet: POST /v1/inputs needs the outbox). The control API is the
// oracle: what the window shows must equal what /v1 reports. Each step saves a UIA tree dump and
// a WGC screenshot. Exit 0 when every check passes.
// usage (from the repository root):
//   node rust/crates/cos-app/tools/binding-proof.mjs [--exe <cos-app.exe>] [--driver <ui-driver.exe>]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const exe = path.resolve(repo, opt('exe', 'rust/target/release/cos-app.exe'));
const driverExe = path.resolve(repo, opt('driver', 'rust/target/release/examples/ui-driver.exe'));
const out = path.join(repo, '.tmp', 'cos-app-binding');
fs.rmSync(out, { recursive: true, force: true });
const profile = path.join(out, 'profile');
const project = path.join(out, 'project');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(project, { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  roots: [{ name: 'project', path: project }],
  capabilities: { browse: true, search: true, read: true, metadata: true, create: false, edit: false, move: false,
    deleteFile: false, command: false, screen: false, control: false, clipboardRead: false, clipboardWrite: false },
  readOnly: false,
  tunnel: { kind: 'manual', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '', binaryPath: '' },
  ui: { minimizeToTray: false, autoConnect: true, language: 'en', lastSeenVersion: version, turnNotifications: false,
    keepAwake: false, startAtLogin: false, localAppUsage: false, autoRefreshPlugins: false, autoRefreshPluginsAsked: true },
  controlApi: { enabled: true, allowActions: false },
}, null, 2));
const env = { ...process.env, CLF_BRIDGE_PORTS: '0', COS_MCP_URLS_FILE: path.join(out, 'mcp-urls.json'),
  HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
const until = async (probe, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch {}
    if (Date.now() > end) return null;
    await pause(100);
  }
};

const child = spawn(exe, [`--user-data-dir=${profile}`], { env, stdio: 'ignore' });
const pid = child.pid;
const driver = (...args) => {
  const run = spawnSync(driverExe, ['--pid', String(pid), ...args], { encoding: 'utf8' });
  try { return JSON.parse(run.stdout); } catch { return { ok: false, error: { code: 'NO_JSON', message: run.stdout + run.stderr } }; }
};
const named = id => {
  const found = driver('wait', id, '--timeout', '1');
  return found.ok ? found.element.name : null;
};
const settle = async (id, expected, ms = 10_000) => (await until(() => named(id) === expected, ms)) ? expected : named(id);
let step = 0;
const evidence = label => {
  step += 1;
  const tree = driver('tree');
  const lines = (tree.windows ?? []).flatMap(window => [`${window.class} "${window.title}" truncated=${window.truncated}`,
    ...window.elements.map(e => `${'  '.repeat(e.depth)}${e.role} name=${JSON.stringify(e.name)}${e.automationId ? ` id=${e.automationId}` : ''}${e.actions.length ? ` [${e.actions.join(',')}]` : ''}`)]);
  fs.writeFileSync(path.join(out, `${step}-${label}.tree.txt`), lines.join('\n') + '\n');
  const shot = driver('shot', path.join(out, `${step}-${label}.png`));
  console.log(`  evidence ${step}-${label}: ${lines.length} tree lines, ${shot.ok ? `${shot.bytes} PNG bytes` : JSON.stringify(shot.error)}`);
};
const log = () => { try { return fs.readFileSync(path.join(profile, 'app.log'), 'utf8'); } catch { return ''; } };

try {
  check('the window opens', !!(await until(() => driver('wait', 'sidebarConnection', '--timeout', '1').ok, 20_000)));
  const endpoint = await until(() => JSON.parse(fs.readFileSync(path.join(profile, 'control-api', 'endpoint.json'), 'utf8')));
  const token = fs.readFileSync(path.join(profile, 'control-api', 'token'), 'utf8').trim();
  const v1 = route => fetch(`http://127.0.0.1:${endpoint.port}${route}`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
  const bridgePort = Number(await until(() => /bridge listening on 127\.0\.0\.1:(\d+)/.exec(log())?.[1]));
  const status = await v1('/v1/status');
  check('the bridge listens on its own port, not the extension\'s', bridgePort > 0 && status.bridge.port === bridgePort, `port ${bridgePort}`);
  const browserWords = bridge => bridge.present ? 'Connected' : bridge.paired ? 'Paired · not active' : 'Not connected';
  const expectBrowser = bridge => `Browser · ${browserWords(bridge)} · bridge on port ${bridge.port}`;

  const sessionsAgree = async label => {
    const total = (await v1('/v1/sessions?limit=50')).total;
    const shown = await settle('coreSessions', `${total} chats`);
    check(`${label}: the window counts the chats /v1/sessions lists`, shown === `${total} chats`, `${shown}; api total ${total}`);
    return total;
  };
  check('restore ends with an empty list', !!(await until(() => named('No chats outside projects yet.'))));
  await sessionsAgree('empty profile');
  check('the connection line follows the Core', (await settle('coreConnection', 'Connection · Connected')) === 'Connection · Connected');
  check('the browser line matches /v1/status', (await settle('coreBrowser', expectBrowser(status.bridge))) === expectBrowser(status.bridge), named('coreBrowser'));
  evidence('empty');

  const EXTENSION = { 'x-extension-version': '2.1.35', 'x-extension-protocol': '14', 'content-type': 'application/json' };
  const call = (route, body, bearer) => fetch(`http://127.0.0.1:${bridgePort}${route}`, {
    method: 'POST', headers: { ...EXTENSION, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
  }).then(async response => ({ status: response.status, body: await response.json() }));
  const pairing = await until(async () => (await call('/pair', {})).body?.token);
  check('the bridge pairs', !!pairing);
  const record = (conversation, events) => until(async () => {
    const answer = await call('/events', { conversationId: conversation, events }, pairing);
    return answer.status === 503 ? null : answer;
  });
  const turn = (n, title, now = Date.now()) => [
    ...(title ? [{ kind: 'conversation_title', text: title, time: now - 5_000 }] : []),
    { kind: 'user_message', messageId: `q-${n}`, text: `Question ${n}`, time: now - 4_000, authoredNow: true },
    { kind: 'turn_start', turnId: `t-${n}`, time: now - 3_900 },
    { kind: 'assistant_message', messageId: `a-${n}`, turnId: `t-${n}`, text: `Answer ${n}`, state: 'final', final: true, time: now - 3_000 },
    { kind: 'turn_end', turnId: `t-${n}`, outcome: 'completed', time: now - 2_900 },
  ];
  const chats = ['b1d1e001-1111-4111-8111-000000000001', 'b1d1e001-1111-4111-8111-000000000002', 'b1d1e001-1111-4111-8111-000000000003'];
  const first = await record(chats[0], turn(1, 'Binding proof one'));
  check('the bridge records the first chat', first?.status === 200 && typeof first.body.sessionId === 'string', JSON.stringify(first?.body).slice(0, 120));
  await sessionsAgree('one chat recorded');
  const paired = (await v1('/v1/status')).bridge;
  check('pairing reaches the browser line', (await settle('coreBrowser', expectBrowser(paired))) === expectBrowser(paired), named('coreBrowser'));
  evidence('one-chat');

  await record(chats[1], turn(2, 'Binding proof two'));
  await record(chats[2], turn(3, 'Binding proof three'));
  const total = await sessionsAgree('three chats recorded');
  check('three chats exist', total === 3, `api total ${total}`);
  const listed = await until(() => {
    const tree = driver('tree', '--role', 'listitem');
    const rows = tree.windows?.flatMap(window => window.elements) ?? [];
    return rows.length === 3 ? rows : null;
  });
  check('the sidebar lists a row per chat, newest first', listed?.[0]?.name.startsWith('Binding proof three'), listed?.map(row => row.name).join(' | '));
  evidence('three-chats');

  const session = first.body.sessionId;
  const picked = driver('act', 'invoke', `session-${session}`);
  check('a session row takes UIA Invoke', picked.ok && picked.result?.route === 'uia', JSON.stringify(picked.error ?? picked.result));
  const page = await v1(`/v1/sessions/${session}/events?limit=30`);
  const lastKind = page.events.at(-1)?.kind;
  const expectTimeline = (n, shownOnPage, kind) => `Binding proof one · ${n} events, ${shownOnPage} on this page, last ${kind}`;
  const opened = expectTimeline(page.total, page.events.length, lastKind);
  check('the picked chat opens its newest page', (await settle('coreTimeline', opened)) === opened, named('coreTimeline'));
  evidence('picked');

  await record(chats[0], turn(4));
  const grown = await v1(`/v1/sessions/${session}/events?limit=30`);
  const live = expectTimeline(grown.total, page.events.length + (grown.total - page.total), grown.events.at(-1)?.kind);
  check('appends reach the open timeline without another pick', (await settle('coreTimeline', live)) === live, `${named('coreTimeline')}; api total ${grown.total}`);
  await sessionsAgree('after appending to an existing chat');
  evidence('live-append');

  driver('act', 'invoke', 'sidebarConnection');
  const toggle = await until(() => driver('wait', 'connectionPopoverToggle', '--timeout', '1').ok ? driver('act', 'invoke', 'connectionPopoverToggle') : null);
  check('Disconnect goes through UIA Invoke', !!toggle?.ok, JSON.stringify(toggle?.error ?? ''));
  const stopped = await until(async () => (await v1('/v1/status')).connection.state === 'disconnected' && 'disconnected');
  check('the Core disconnects', stopped === 'disconnected');
  check('the connection line follows the Core', (await settle('coreConnection', 'Connection · Not connected')) === 'Connection · Not connected', named('coreConnection'));
  evidence('disconnected');

  const front = driver('windows').foregroundIsOurs;
  const keys = driver('key', 'escape');
  check('a key is sent only while our window is in front', front ? keys.ok : keys.error?.code === 'NOT_FOREGROUND',
    `ours in front: ${front}; ${JSON.stringify(keys.error ?? keys)}`);
} finally {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; evidence in ${out}`);
process.exit(results.every(Boolean) ? 0 : 1);
