// Exercise the compiled shared renderer and real sandboxed preload with isolated IPC fixtures.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { defaultConfig, merge } = require('./fixtures/app-defaults.cjs');
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
const textAttachment = { id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'selected-text.txt', mimeType: 'text/plain', size: 18, preview: null };
const contextAttachment = { ...textAttachment, id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'window-context.txt' };
const screenshotAttachment = { ...attachment, id: 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'window-screenshot.png' };
let win, sent, expanded, followed = 0, captured = [], stagedText, replacement, copiedSelection = false, autoCalls = [], staged = [];
app.whenReady().then(async () => {
  const config = merge(defaultConfig(), { ui: { theme: 'dark', language: 'en', autoConnect: false, defaultChatModel: 'gpt-6-sol', defaultChatReasoning: 'high' } });
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
    'sessions:outbox': () => sent ? [sent] : [], 'sessions:retainDraftAttachments': () => null,
    'sessions:files': () => [attachment], 'sessions:dropFiles': ({ files }) => files.map(file => {
      const template = file.name.startsWith('window-context-') ? contextAttachment : file.name.startsWith('window-screenshot-') ? screenshotAttachment : file.name.startsWith('selected-text-') ? textAttachment : attachment;
      if (template === attachment) return attachment;
      const result = { ...template, id: randomUUID(), name: file.name };
      staged.push(result);
      if (template === textAttachment) stagedText = Buffer.from(file.bytes).toString('utf8');
      return result;
    }), 'sessions:attachText': ({ text }) => { stagedText = text; return textAttachment; },
    'sessions:send': args => (sent = { ...args, sessionId: args.sessionId ?? args.id, conversationId: args.sessionId, state: 'queued', owner: null, createdAt: now }),
    'sessions:followTab': () => { followed++; return true; },
    'sessions:search': () => ({ results: [], sessions: [], total: 0 }),
    'projects:list': () => [], 'chatGroups:get': () => ({ version: 1, groups: [], members: {} }),
    'swarm:get': () => ({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    'skills:library': () => ({ skills: [], roots: [], warnings: [] }), 'bridge:extensionPath': () => null, 'handoff:get': () => null, 'schedules:get': () => []
  };
  for (const [channel, fn] of Object.entries(handlers)) ipcMain.handle(channel, (_, arg) => ok(fn(arg)));
  ipcMain.handle('quick-chat:pin', (_, value) => value);
  ipcMain.handle('quick-chat:expand', (_, key) => { expanded = key; return true; });
  ipcMain.handle('quick-chat:hide', () => {});
  let ready = false;
  ipcMain.handle('quick-chat:ready', () => { ready = true; });
  const windowContext = { kind: 'screenshot', title: 'Fixture window', application: 'fixture', text: 'Application: fixture\nVisible document text: Example', base64: attachment.preview.split(',')[1] };
  ipcMain.handle('quick-chat:capture', (_, kind) => { captured.push(kind); return kind === 'selection' ? { kind, title: 'Fixture selection', application: 'fixture', text: 'Synthetic context', source: 'Application: fixture', replacementAvailable: !copiedSelection } : windowContext; });
  ipcMain.handle('quick-chat:automatic', (_, epoch) => { autoCalls.push(epoch); return windowContext; });
  ipcMain.handle('quick-chat:answer', (_, ref) => { assert.equal(ref.id, id); return { text: 'Proposed replacement', epoch: 7, source: { title: 'Fixture window', selection: 'Synthetic context' } }; });
  ipcMain.handle('quick-chat:replace', (_, value) => { replacement = value; });
  win = new BrowserWindow({ show: false, frame: false, width: 440, height: 580, webPreferences: {
    preload: path.join(root, 'out/preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
  } });
  win.webContents.on('console-message', (event, _level, text) => { if ((event.level ?? _level) >= 2) console.log('renderer:', event.message ?? text); });
  win.webContents.on('preload-error', (_event, file, error) => console.error('preload:', file, error));
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { query: { surface: 'quick-chat' } });
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
  assert.deepEqual(captured, []);
  await js('window.entryAnimations = 0; const app = document.querySelector(".app"); const original = app.animate.bind(app); app.animate = (...args) => { window.entryAnimations++; return original(...args); }; void 0;');
  win.webContents.send('quick-chat:shown', 1, true);
  await until('document.querySelector(".composer-context-card")?.textContent.includes("Fixture window")');
  assert.deepEqual(autoCalls, [1]);
  assert.equal(await js('window.entryAnimations'), 0);
  assert.ok(await js('!!document.querySelector(".composer-context-card img")'));
  await js('document.querySelector(".composer-context-card summary").click()');
  assert.ok(await js('document.querySelector(".composer-context-card details[open] pre").textContent.includes("Visible document text: Example")'));
  win.webContents.send('quick-chat:shown', 1, true);
  assert.deepEqual(autoCalls, [1]);
  await js('document.querySelector(".composer-context-card .image-remove").click()');
  await until('!document.querySelector(".composer-context-card") && !!document.querySelector("#composerImages img")');
  await js('document.querySelector("#quickContext summary").click(); document.querySelector("#quickRewrite").click()');
  await until('document.querySelector("#chatInput").value.startsWith("Rewrite the attached text") && document.querySelector("#chatInput").value.includes("Keep this draft")');
  assert.equal(stagedText, 'Application: fixture\n\nSelected text (verbatim):\nSynthetic context');
  assert.deepEqual(captured, ['selection']);
  assert.ok(await js('document.querySelector(".composer-context-card").textContent.includes("Fixture selection")'));
  const firstSelection = staged.find(file => file.name.startsWith('selected-text-'));
  await until('!!document.querySelector(".quick-replace-answer")');
  await js('document.querySelector(".quick-replace-answer").click()');
  await until('!!document.querySelector(".quick-replace-dialog[open]")');
  assert.equal(await js('document.querySelector(".quick-replace-dialog textarea").value'), 'Proposed replacement');
  await js('document.querySelector(".quick-replace-dialog textarea").value="Edited replacement"; document.querySelector(".quick-replace-actions button:last-child").click()');
  await until('!document.querySelector(".quick-replace-dialog[open]")');
  assert.deepEqual(replacement, { text: 'Edited replacement', epoch: 7 });
  copiedSelection = true;
  await js('document.querySelector("#quickContext summary").click(); document.querySelector("#quickCaptureSelection").click()');
  await until('!document.querySelector("#quickContext").hasAttribute("aria-busy") && !document.body.classList.contains("quick-selection-ready")');
  assert.equal(await js('document.body.classList.contains("quick-selection-ready")'), false);
  await js('document.querySelector("#quickContext summary").click(); document.querySelector("#quickCaptureWindow").click()');
  await until('document.querySelector("#composerImages").textContent.includes("Fixture window")');
  assert.deepEqual(captured, ['selection', 'selection', 'screenshot']);
  const oldWindowIds = staged.filter(file => file.name.startsWith('window-')).slice(-2).map(file => file.id);
  win.webContents.send('quick-chat:shown', 2, true);
  await until('document.querySelectorAll(".composer-context-card").length === 3 && !document.querySelector("#quickContext").hasAttribute("aria-busy")');
  assert.deepEqual(autoCalls, [1, 2]);
  config.ui.quickChatAutoCapture = false; win.webContents.send('state:changed', state);
  win.webContents.send('quick-chat:shown', 3, false);
  await until('document.querySelectorAll(".composer-context-card").length === 2 && !document.querySelector("#quickRefreshContext").disabled');
  assert.deepEqual(autoCalls, [1, 2]);
  await js('document.querySelector("#quickRefreshContext").click()');
  await until('document.querySelectorAll(".composer-context-card").length === 3 && !document.querySelector("#quickRefreshContext").disabled');
  const manualWindowIds = staged.filter(file => file.name.startsWith('window-')).slice(-2).map(file => file.id);
  win.webContents.send('quick-chat:shown', 4, false);
  await until('document.querySelectorAll(".composer-context-card").length === 3 && !document.querySelector("#quickRefreshContext").disabled');
  await js('document.querySelector("#quickRefreshContext").click()');
  await until('!document.querySelector("#quickRefreshContext").disabled');
  assert.equal(await js('document.querySelectorAll(".composer-context-card").length'), 3);
  assert.deepEqual(captured, ['selection', 'selection', 'screenshot', 'screenshot', 'screenshot']);
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
  assert.equal(sent.attachments?.[1]?.id, firstSelection.id);
  assert.equal(sent.attachments?.length, 5);
  assert.ok(!sent.attachments.some(file => oldWindowIds.includes(file.id)));
  assert.ok(!sent.attachments.some(file => manualWindowIds.includes(file.id)));
  assert.equal(followed, 0);
  await js('document.querySelector("#quickPin").click()');
  await until('document.querySelector("#quickPin").getAttribute("aria-pressed") === "false"');
  config.ui.theme = 'light'; win.webContents.send('state:changed', state);
  await until('document.documentElement.dataset.theme === "light"');
  win.setContentSize(360, 380);
  await until('window.innerWidth <= 365 && window.innerHeight <= 385');
  await until('document.documentElement.scrollWidth <= window.innerWidth && document.querySelector("#chatSend").getBoundingClientRect().bottom <= window.innerHeight');
  await js('document.querySelector("#quickSearch").click()');
  await until('(()=>{const d=document.querySelector("#searchDialog"); const r=d.getBoundingClientRect(); return d.open && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()');
  await new Promise(resolve => setTimeout(resolve, 180));
  fs.writeFileSync(path.join(output, 'history.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  await js('document.querySelector(".quick-history-close").click()');
  await until('!document.querySelector("#searchDialog").open');
  await js('document.querySelector("#quickContext summary").click()');
  await until('(()=>{const menu=document.querySelector("#quickContext");const r=menu.querySelector(".composer-popover").getBoundingClientRect();return menu.open && r.width>0 && r.left>=0 && r.right<=window.innerWidth && r.top>=0 && r.bottom<=window.innerHeight})()');
  await js('document.querySelector("#quickContext summary").click()');
  await new Promise(resolve => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(output, 'light.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  await js('document.querySelector("#quickExpand").click()');
  for (let n=0; !expanded && n<20; n++) await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(expanded, id);
  await js('document.querySelector("#quickSearch").click(); document.querySelector("#quickHistoryNew").click()');
  await until('!document.querySelector("#searchDialog").open && document.querySelector("#chatTitle").textContent === "New chat"');
  console.log('Quick chat: shared transcript and tools, recent chat switching, image draft retention, exact send, pin, theme, narrow layout and expand passed.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
