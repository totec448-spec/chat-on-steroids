// Exercise the compiled shared renderer and real sandboxed preload with isolated IPC fixtures.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig, merge } = require('./fixtures/app-defaults.cjs');
const { resizeWindow } = require('./ui-check-window.cjs');
const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cos-quick-chat-')));
const ok = data => ({ ok: true, data });
const now = Date.now();
const catalog = { state: 'ready', requestedAt: now, observedAt: now, models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['low', 'high'] }] };
const message = text => ({ text, chars: text.length, truncated: false });
const id = 'preview-chat-a', other = 'preview-chat-b';
const summaries = [id, other].map((id, index) => ({
  id, title: index ? 'Other conversation' : 'Review dashboard layout', conversationId: id, chatIds: [id], startedAt: now, updatedAt: now - index, endedAt: null,
  events: index ? 1 : 3, userMessages: 1, toolCalls: index ? 0 : 1, lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
  estimatedTokens: 1800, contextTokens: 1800, lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: 'completed', activeTurnId: null, agents: [], origin: null,
  selectedModel: { conversationId: id, model: 'gpt-6-sol', reasoningEffort: 'high', observedAt: now }
}));
const events = [
  { seq: 1, time: now, source: 'extension', kind: 'user_message', messageId: 'u-1', turnId: 't-1', message: message('Review the dashboard layout.') },
  { seq: 2, time: now+1, source: 'mcp', kind: 'tool_call', turnId: 't-1', call: { callId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', tool: 'read', args: message('{"paths":["src/app.ts"]}'), result: message('Example result'), summary: { kind: 'read', title: 'Read src/app.ts', tone: 'neutral' }, outcome: 'ok', attribution: 'request_id', requestId: 'synthetic-request', conversationId: id, durationMs: 120 } },
  { seq: 3, time: now+2, source: 'extension', kind: 'assistant_message', messageId: 'a-1', turnId: 't-1', message: message('**Example answer**\n\nThe layout can be adjusted while preserving its controls.'), state: 'final', final: true },
  { seq: 4, time: now+3, source: 'extension', kind: 'turn_end', turnId: 't-1', outcome: 'completed' }
];
const attachment = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'preview.png', mimeType: 'image/png', size: 68, preview: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF5sAAAAASUVORK5CYII=' };
let win, workspace, sent, expanded, followed = 0;
const admissions = [];
app.whenReady().then(async () => {
  const config = merge(defaultConfig(), { roots: [{ name: 'fixture', path: root }], ui: { theme: 'dark', language: 'en', autoConnect: false, lastSeenVersion: '2.1.18', defaultChatModel: 'gpt-6-sol', defaultChatReasoning: 'high' } });
  const state = { config, status: { state: 'connected', detail: 'Local preview', publicUrl: null, localUrl: null, handshakeAt: now, lastRequestAt: now, lastToolCallAt: null, health: null, surfaces: [] },
    platform: { family: 'windows', name: 'Windows', desktopAutomation: false }, hasApiKey: false, hasGoalKey: false, resolvedBinary: null, bundledTunnelVersion: null,
    bridge: { running: true, port: 0, paired: true, present: true, lastSeenAt: now }, update: { current: '2.1.18', latest: null, stage: 'idle', error: null, checkedAt: null } };
  const controls = sessionId => ({ sessionId, conversationId: sessionId, automation: 'off', objective: '', activeTurnId: null, finishHeld: false, finishWaiting: false, queueAtFinish: false, canInject: false, canSendDirectly: true, blocked: '', job: null, plan: null });
  const handlers = {
    'state:get': () => state, 'chatModels:get': () => catalog, 'chatModels:request': () => catalog,
    'sessions:list': () => ({ sessions: summaries, activeId: null, pressure: [], blocked: [], approval: [], recoveryStopped: [], trusted: [], total: 2, nextCursor: null }),
    'sessions:events': ({ id: key }) => { const rows = key === id ? events : [{ ...events[0], message: message('Other chat only') }]; return { summary: summaries.find(s => s.id === key), events: rows, total: rows.length, nextFrom: rows.length+1 }; },
    'sessions:controls': ({ id }) => controls(id), 'sessions:traces': () => ({}), 'sessions:turnChanges': () => [],
    'sessions:bookmarks': () => [], 'sessions:runningTools': () => [], 'sessions:runningProcesses': () => [], 'sessions:pausedHelpers': () => [],
    'sessions:outbox': () => admissions, 'sessions:retainDraftAttachments': () => null,
    'sessions:files': () => [attachment], 'sessions:dropFiles': () => [attachment],
    'sessions:send': args => {
      sent = { ...args, sessionId: args.sessionId ?? args.id, conversationId: args.sessionId, state: 'queued', owner: null, createdAt: Date.now() };
      admissions.push(sent);
      return sent;
    },
    'sessions:followTab': () => { followed++; return true; },
    'sessions:search': () => ({ results: [], sessions: [], total: 0 }),
    'projects:list': () => [], 'chatGroups:get': () => ({ version: 1, groups: [], members: {} }),
    'swarm:get': () => ({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    'skills:library': () => ({ skills: [], roots: [], warnings: [] }), 'bridge:extensionPath': () => null, 'handoff:get': () => null, 'schedules:get': () => [], 'log:get': () => [],
    'desktopAsk:pending': () => null, 'ui:stopNoticeTexts': () => null, 'ui:mainTexts': () => null, 'ui:language': () => null,
    'pets:list': () => ({ pets: [] }), 'pets:overlayState': () => ({ visible: false, ready: true, activeCount: 0, activityCount: 0 }),
    'window:getZoom': () => 1, 'plugins:snapshot': () => ({ plugins: [], catalog: [], schemaRevision: 0 }), 'skills:managed': () => [], 'skills:recommended': () => []
  };
  for (const [channel, fn] of Object.entries(handlers)) ipcMain.handle(channel, (_, arg) => ok(fn(arg)));
  ipcMain.handle('quick-chat:pin', (_, value) => value);
  ipcMain.handle('quick-chat:expand', (_, key) => { expanded = key; if (workspace) workspace.webContents.send('session:write', key); return true; });
  ipcMain.handle('quick-chat:open-session', (event, key) => {
    assert.equal(event.sender, workspace.webContents);
    win.webContents.send('session:write', key);
    return ok(true);
  });
  ipcMain.handle('quick-chat:hide', () => {});
  let ready = false;
  ipcMain.handle('quick-chat:ready', () => { ready = true; });
  win = new BrowserWindow({ show: false, frame: false, width: 440, height: 580, webPreferences: {
    preload: path.join(root, 'out/preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
  } });
  win.webContents.on('console-message', (event, _level, text) => { if ((event.level ?? _level) >= 2) console.log('renderer:', event.message ?? text); });
  win.webContents.on('preload-error', (_event, file, error) => console.error('preload:', file, error));
  await win.loadFile(path.join(root, 'out/renderer/quick-chat.html'));
  const js = source => win.webContents.executeJavaScript(source);
  const until = async source => {
    for (let n = 0; n < 150; n++) {
      if (await js(source)) return;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    throw new Error('Timed out: ' + source);
  };
  const select = async key => {
    await js('document.querySelector("#quickSearch").click()');
    await until('!!document.querySelector("[data-search-id=\\\"' + key + '\\\"]")');
    await js('document.querySelector("[data-search-id=\\\"' + key + '\\\"]").click()');
    await until('!document.querySelector("#searchDialog").open');
  };
  await until('!!document.querySelector("#quickSearch") && !!document.querySelector("#chatInput")');
  for (let n=0; !ready && n<100; n++) await new Promise(resolve=>setTimeout(resolve,35));
  assert.equal(ready, true);
  assert.equal(await js('document.querySelector("#timelineEmpty > span").textContent'), 'How can I help?');
  assert.equal(await js('!!document.querySelector("#quickChatSelector")'), false);
  assert.equal(await js('getComputedStyle(document.querySelector(".app-topbar")).borderBottomWidth'), '0px');
  assert.equal(await js('typeof window.require'), 'undefined');
  assert.equal(await js('typeof window.quickChat.capture'), 'undefined');
  assert.equal(await js('!!document.querySelector("#quickContext")'), false);
  win.webContents.send('session:write', id);
  await until('document.body.innerText.includes("Example answer")');
  await js('document.querySelector("#quickSearch").click()');
  await until('document.querySelector("#searchDialog.quick-history-drawer[open] .search-result[aria-current=true]")?.dataset.searchId === ' + JSON.stringify(id));
  assert.equal(await js('document.querySelectorAll("#searchResults [data-search-id]").length'), 2);
  await js('document.querySelector("#chatSearch").value="not a chat"; document.querySelector("#chatSearch").dispatchEvent(new Event("input"))');
  await until('document.querySelector("#searchResults").textContent.includes("No chats match")');
  await js('document.querySelector(".quick-history-close").click()');
  await until('!document.querySelector("#searchDialog").open');
  await js('document.querySelector("#quickSearch").click()');
  await until('document.querySelector("#chatSearch").value === "" && document.querySelectorAll("#searchResults [data-search-id]").length === 2');
  await js('document.querySelector(".quick-history-close").click()');
  await until('!document.querySelector("#searchDialog").open');
  assert.ok(await js('!!document.querySelector(".tool-group, .round-recap, .ev-tool_call")'));
  await js('document.querySelector("#attachmentMenu summary").click(); document.querySelector("#attachImages").click()');
  await until('!document.querySelector("#composerImages").hidden && !!document.querySelector("#composerImages img")');
  await js('document.querySelector("#chatInput").value="Keep this draft"; document.querySelector("#chatInput").dispatchEvent(new Event("input"))');
  await select(other);
  await until('document.body.innerText.includes("Other chat only")');
  await select(id);
  await until('document.querySelector("#chatInput").value === "Keep this draft" && !document.querySelector("#composerImages").hidden');
  const output = path.join(root, 'outputs/quick-chat');
  fs.mkdirSync(output, { recursive: true });
  console.log('Shared timeline, tool calls, attachment preview and draft switching passed.');
  win.showInactive();
  await new Promise(resolve => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(output, 'dark.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  await js('document.querySelector("#chatSend").click()');
  for (let n=0; !sent && n<100; n++) await new Promise(resolve=>setTimeout(resolve,35));
  assert.equal(sent?.sessionId, id);
  assert.equal(sent.model, 'gpt-6-sol'); assert.equal(sent.reasoningEffort, 'high');
  assert.equal(sent.attachments?.[0]?.id, attachment.id);
  assert.equal(sent.attachments?.length, 1);
  assert.equal(followed, 0);
  await js('document.querySelector("#quickPin").click()');
  await until('document.querySelector("#quickPin").getAttribute("aria-pressed") === "false"');
  config.ui.theme = 'light'; win.webContents.send('state:changed', state);
  await until('document.documentElement.dataset.theme === "light"');
  await resizeWindow(win, 360, 380, { content: true });
  await until('window.innerWidth <= 365 && window.innerHeight <= 385');
  await until('document.documentElement.scrollWidth <= window.innerWidth && document.querySelector("#chatSend").getBoundingClientRect().bottom <= window.innerHeight');
  await js('document.querySelector("#quickSearch").click()');
  await until('(()=>{const d=document.querySelector("#searchDialog"); const r=d.getBoundingClientRect(); return d.open && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()');
  await new Promise(resolve => setTimeout(resolve, 180));
  fs.writeFileSync(path.join(output, 'history.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  await js('document.querySelector(".quick-history-close").click()');
  await until('!document.querySelector("#searchDialog").open');
  await new Promise(resolve => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(output, 'light.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  await js('document.querySelector("#quickExpand").click()');
  for (let n=0; !expanded && n<20; n++) await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(expanded, id);
  await js('document.querySelector("#quickSearch").click(); document.querySelector("#quickHistoryNew").click()');
  await until('!document.querySelector("#searchDialog").open && document.querySelector("#chatTitle").textContent === "New chat"');
  // Two actual renderer instances, sharing only the isolated backend fixture.
  workspace = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
    preload: path.join(root, 'out/preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
  } });
  await workspace.loadFile(path.join(root, 'out/renderer/index.html'));
  const ws = source => workspace.webContents.executeJavaScript(source);
  const waitWs = async source => {
    for (let n = 0; n < 150; n++) {
      if (await ws(source)) return;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    throw new Error('Workspace timed out: ' + source);
  };
  workspace.showInactive();
  await waitWs('document.querySelectorAll("#sessionList [data-id]").length === 2');
  workspace.webContents.send('session:write', id);
  await waitWs('document.querySelector("#timeline").textContent.includes("Example answer")');
  const type = text => 'document.querySelector("#chatInput").value=' + JSON.stringify(text) + ';document.querySelector("#chatInput").dispatchEvent(new Event("input"))';
  await ws(type('Workspace draft only'));
  assert.equal(await ws('window.api.openSessionQuickChat(' + JSON.stringify(id) + ').then(result => result.ok)'), true);
  await until('document.querySelector("#timeline").textContent.includes("Example answer")');
  await js(type('Quick Chat draft only'));
  assert.equal(await ws('document.querySelector("#chatInput").value'), 'Workspace draft only');
  await js('document.querySelector("#chatSend").click()');
  await until('document.querySelector("#inputQueue").textContent.includes("Quick Chat draft only")');
  workspace.webContents.send('session:changed');
  await waitWs('document.querySelector("#inputQueue").textContent.includes("Quick Chat draft only")');
  assert.equal(await ws('document.querySelector("#chatInput").value'), 'Workspace draft only');
  await ws('document.querySelector("#chatSend").click()');
  await waitWs('document.querySelector("#inputQueue").textContent.includes("Workspace draft only")');
  win.webContents.send('session:changed');
  await until('document.querySelector("#inputQueue").textContent.includes("Workspace draft only")');
  const paired = admissions.filter(row => ['Workspace draft only', 'Quick Chat draft only'].includes(row.text));
  assert.equal(paired.length, 2);
  assert.equal(new Set(paired.map(row => row.id)).size, 2);
  assert.ok(paired.every(row => row.sessionId === id));
  for (const evalIn of [ws, js]) {
    for (const row of paired) assert.equal(await evalIn('[...document.querySelectorAll("#timeline .said.is-user,#inputQueue .pending-message")].filter(el=>el.textContent.includes(' + JSON.stringify(row.text) + ')).length'), 1);
  }
  // Both panes see the same delayed provider receipt, then the same durable history.
  // Sample the actual paints while the queued rows become recorded user messages.
  const frameProbe = `new Promise((resolve, reject) => {
    const frames = [], texts = ${JSON.stringify(paired.map(row => row.text))};
    const probe = window.__quickChatDeliveryProbe = { frames, done: false };
    const deadline = setTimeout(() => { probe.done = true; reject(new Error('Delivery frame probe timed out')); }, 12000);
    function frame() {
      const rows = [...document.querySelectorAll('#timeline .said.is-user,#inputQueue .pending-message')];
      frames.push({ counts: texts.map(text => rows.filter(row => row.textContent.includes(text)).length),
        previous: document.querySelector('#timeline').textContent.includes('Example answer'),
        welcome: !document.querySelector('#timelineEmpty').hidden });
      if (probe.done && frames.length >= 100) { clearTimeout(deadline); resolve(frames); } else requestAnimationFrame(frame);
    } requestAnimationFrame(frame);
  })`;
  const paints = Promise.all([ws(frameProbe), js(frameProbe)]);
  const bothReached = async count => Promise.all([waitWs, until].map(wait => wait('window.__quickChatDeliveryProbe?.frames.length >= ' + count)));
  const pushBoth = change => { for (const owner of [workspace, win]) owner.webContents.send('session:changed', change); };
  await bothReached(8);
  for (const row of paired) Object.assign(row, { state: 'sent', messageId: 'fixture-' + row.id, deliveredAt: Date.now(), historyAnchored: true, historySeq: events.length + paired.indexOf(row) + 1 });
  pushBoth();
  await bothReached(48);
  for (const row of paired) events.push({ seq: row.historySeq, time: row.deliveredAt, source: 'app', kind: 'user_message', messageId: row.messageId, inputId: row.id, message: message(row.text) });
  Object.assign(summaries[0], { updatedAt: Date.now(), events: events.length, userMessages: 3 });
  pushBoth({ sessionIds: [id] });
  for (const wait of [waitWs, until]) await wait('document.querySelector("#timeline").textContent.includes("Quick Chat draft only") && document.querySelector("#timeline").textContent.includes("Workspace draft only") && ![...document.querySelectorAll("#inputQueue .pending-message")].some(row => /(?:Quick Chat|Workspace) draft only/.test(row.textContent))');
  await Promise.all([ws, js].map(evalIn => evalIn('window.__quickChatDeliveryProbe.done = true')));
  const frameSets = await paints;
  assert.ok(frameSets.every(frames => frames.length >= 100 && frames.every(frame => frame.previous && !frame.welcome && frame.counts.every(count => count === 1))), JSON.stringify(frameSets));
  console.log('Two renderers: ' + frameSets.map(frames => frames.length).join(' and ') + ' delivery frames retained both messages exactly once, through durable history.');
  workspace.webContents.send('session:write', other);
  await waitWs('document.querySelector("#timeline").textContent.includes("Other chat only")');
  assert.ok(await js('document.querySelector("#timeline").textContent.includes("Example answer")'));
  await js('document.querySelector("#quickExpand").click()');
  await waitWs('document.querySelector("#timeline").textContent.includes("Example answer")');
  console.log('Two renderers: independent drafts, exact session routing, shared queued inputs without duplicates passed.');
  console.log('Quick chat: shared transcript and tools, recent chat switching, image draft retention, exact send, pin, theme, narrow layout and expand passed.');
  workspace.destroy(); win.destroy(); app.exit(0);
}).catch(error => { console.error(error); for (const owner of [workspace, win]) if (owner && !owner.isDestroyed()) owner.destroy(); app.exit(1); });
