// Maintainer tool: renders the README screenshots from the production renderer with synthetic
// data only (a demo project, placeholder paths, made-up chat), so they can be redone whenever the
// app changes. Writes docs/images/{workspace,model-picker,settings}.png.
//
//   npx electron scripts/capture-readme-shots.cjs [outDir]
const fs = require('node:fs');
const path = require('node:path');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'docs/images'));
app.setPath('userData', path.join(root, 'outputs/readme-shots-runtime'));

const fixture = `
  addEventListener('error', event => console.error(event.error?.stack || event.message));
  addEventListener('unhandledrejection', event => console.error(event.reason?.stack || event.reason));
  try { localStorage.setItem('cos.ui.language', 'en'); } catch {}
  const T0 = Date.now() - 4 * 60_000;
  const text = text => ({ text, chars: text.length, truncated: false });
  const call = (seq, tool, args, summary, extra = {}) => ({ kind: 'tool_call', source: 'mcp', seq, origin: seq, time: T0 + seq * 9000, turnId: 'turn-1', agent: 'prime',
    call: { callId: 'call-' + seq, tool, attribution: 'request_id', requestId: 'req-' + seq, conversationId: 'demo-chat', attributionMethod: 'request_id',
      args: text(JSON.stringify(args)), result: text('ok'), outcome: 'ok', durationMs: 900 + seq * 37, summary, ...extra } });
  window.rows = [
    { kind: 'turn_start', seq: 1, origin: 1, time: T0, turnId: 'turn-1', source: 'extension' },
    { kind: 'user_message', seq: 2, origin: 2, time: T0 + 1000, turnId: 'turn-1', source: 'extension', messageId: 'ask', inputDelivery: 'confirmed',
      message: text('Add dark mode to the settings page and keep the existing tests green.') },
    call(3, 'read', { path: 'src/settings/theme.ts' }, { title: 'Read src/settings/theme.ts', detail: 'lines 1–120', tone: 'neutral', kind: 'read' }),
    call(4, 'search', { query: 'prefers-color-scheme' }, { title: 'Searched for prefers-color-scheme', metric: '6 matches', tone: 'neutral', kind: 'search' }),
    call(5, 'apply_patch', { path: 'src/settings/theme.ts' }, { title: 'Edited src/settings/theme.ts', metric: '+42 −7', tone: 'good', kind: 'edit' },
      { changes: [{ path: 'src/settings/theme.ts', added: 42, removed: 7, approximate: false }] }),
    call(6, 'apply_patch', { path: 'src/settings/SettingsPage.tsx' }, { title: 'Edited src/settings/SettingsPage.tsx', metric: '+18 −3', tone: 'good', kind: 'edit' },
      { changes: [{ path: 'src/settings/SettingsPage.tsx', added: 18, removed: 3, approximate: false }] }),
    call(7, 'exec_command', { cmd: 'npm test' }, { title: 'Ran npm test', metric: '✓ 6.2s', tone: 'good', kind: 'command' }),
    { kind: 'assistant_message', seq: 8, origin: 8, time: T0 + 80_000, turnId: 'turn-1', source: 'extension', messageId: 'progress', final: false, state: 'streaming',
      message: text('The **Theme** switch is in and the existing tests pass. Two workers are adding tests and updating the docs while I check the contrast of the dark colors.') }
  ];
  ${fixtureConfigSource()}
  const config = fixtureConfig({ roots: [{ name: 'demo-app', path: '/Users/you/Projects/demo-app' }, { name: 'design-tokens', path: '/Users/you/Projects/design-tokens' }],
    tunnel: { kind: 'openai', tunnelId: 'tunnel_0123456789abcdef0123456789abcdef', desktopTunnelId: '', binaryPath: '' },
    ui: { theme: 'dark', autoConnect: false, chatBrowser: 'chrome', defaultChatModel: 'gpt-6', defaultChatReasoning: 'high' }, multiAgent: { enabled: true, maxWorkers: 2 } });
  const surface = (id, connectorName, tools) => ({ id, connectorName, description: connectorName, cardSummary: '', optional: id !== 'core', available: true,
    localUrl: 'http://127.0.0.1:8765/mcp/' + id, publicUrl: null, tools, state: 'live', detail: '', lastRequestAt: Date.now() - 4000, lastToolCallAt: Date.now() - 4000 });
  const state = { config, hasApiKey: true, hasGoalKey: false, resolvedBinary: null,
    status: { state: 'connected', detail: '', publicUrl: null, localUrl: 'http://127.0.0.1:8765', handshakeAt: Date.now() - 60000, lastRequestAt: Date.now() - 4000, lastToolCallAt: Date.now() - 4000, health: null,
      surfaces: [surface('core', 'Chat On Steroids Core', ['read', 'apply_patch', 'exec_command'])] },
    bridge: { running: true, paired: true, present: true, port: 8765, lastSeenAt: Date.now(), extensionVersion: '2.1.36',
      externalExtension: { present: true, version: '2.1.36', lastSeenAt: Date.now(), signedIn: true } },
    update: { current: '2.1.36', latest: null, stage: 'idle', error: null, checkedAt: null } };
  const summary = { id: 'demo', title: 'Dark mode for settings', conversationId: 'demo-chat', chatIds: ['demo-chat'], startedAt: T0, updatedAt: T0 + 81000,
    events: window.rows.length, userMessages: 1, toolCalls: 5, estimatedTokens: 18200, contextTokens: 18200, errors: 0, agents: ['prime'], origin: null,
    selectedModel: { model: 'gpt-6', reasoningEffort: 'high', observedAt: T0 + 1000 } };
  const others = [['Fix flaky upload test', 3], ['Release notes for 1.4', 26], ['Refactor billing client', 51]].map(([title, hours], index) =>
    ({ ...summary, id: 'other-' + index, title, conversationId: 'other-' + index, chatIds: ['other-' + index], startedAt: Date.now() - hours * 3600e3, updatedAt: Date.now() - hours * 3600e3 }));
  const plan = { updatedAt: T0 + 70000, explanation: '', plan: [
    { step: 'Read the current theme handling', status: 'completed' },
    { step: 'Add the Theme switch and store it', status: 'completed' },
    { step: 'Check dark-mode contrast', status: 'in_progress' },
    { step: 'Merge the workers\u2019 tests and docs', status: 'pending' } ] };
  const agent = (id, role, label, task, state, extra = {}) => ({ id, role, label, task, jobTitle: label, runId: 'run-1', reasoningEffort: null, model: null, state,
    createdAt: T0 + 30000, activatedAt: T0 + 32000, finishedAt: null, result: null, pending: 0, awaitingAck: 0, delivered: 1,
    conversationId: id === 'prime' ? 'demo-chat' : id + '-chat', primeConversationId: 'demo-chat', detachedAt: null, ...extra });
  const swarm = { enabled: true, running: true, runId: 'run-1', maxWorkers: 2, pendingReports: 0, agents: [
    agent('prime', 'prime', 'prime', '', 'active'),
    agent('worker-1', 'worker', 'Theme tests', 'Write tests for the Theme switch', 'active'),
    agent('worker-2', 'worker', 'Settings docs', 'Update the settings documentation', 'finished', { finishedAt: T0 + 75000, result: 'Docs updated in docs/settings.md' }) ] };
  // Each worker is its own ChatGPT chat, linked to the chat that started it.
  const workerChats = [['worker-1', 'Theme tests', 'Write tests for the Theme switch'], ['worker-2', 'Settings docs', 'Update the settings documentation']].map(([id, title, task]) =>
    ({ ...summary, id, title, conversationId: id + '-chat', chatIds: [id + '-chat'], agents: [id], toolCalls: 3, estimatedTokens: 6400, contextTokens: 6400,
      startedAt: T0 + 32000, updatedAt: T0 + 76000, origin: { kind: 'worker', fromSessionId: 'demo', agentId: id, task } }));
  // ChatGPT's model list as the app read it on 2026-10-12.
  const models = { state: 'ready', requestedAt: Date.now() - 60000, observedAt: Date.now() - 60000, models: [
    { id: 'gpt-6', label: 'GPT-6', efforts: ['none', 'medium', 'high', 'xhigh'], aliases: ['gpt-6', 'gpt-6-thinking'] },
    { id: 'gpt-5-6', label: 'GPT-5.6', efforts: ['none', 'medium', 'high', 'xhigh'], aliases: ['gpt-5-6-instant', 'gpt-5-6-thinking'] },
    { id: 'gpt-5-5', label: 'GPT-5.5', efforts: ['none', 'medium', 'high', 'xhigh'], aliases: ['gpt-5-5-instant', 'gpt-5-5-thinking'] } ] };
  const ok = data => Promise.resolve({ ok: true, data });
  window.api = new Proxy({
    getState: () => ok(state), getLog: () => ok([]), listProjects: () => ok([]),
    listSessions: () => ok({ sessions: [summary, ...workerChats, ...others], activeId: 'demo', pressure: [], blocked: [] }),
    getSession: () => ok({ summary, events: structuredClone(window.rows), total: window.rows.length, nextFrom: 100 }),
    getSessionControls: () => ok({ automation: 'off', blocked: '', job: null, plan, activeTurnId: 'turn-1' }),
    listInputs: () => ok([]), runningTools: () => ok([]), listPausedHelpers: () => ok([]),
    onSessionChanged: fn => { window.changed = fn; return () => {}; }, onStateChanged: fn => { window.pushState = fn; return () => {}; },
    getSwarm: () => ok(swarm), onSwarmChanged: () => () => {}, getChatModels: () => ok(models)
  }, { get: (target, key) => key in target ? target[key] : () => ok(null) });
  await import('/main.ts');
  // A running app repaints on every state update; one more paint settles first-paint badges.
  window.pushState?.(state);
  window.ready = true;
`;

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: false, logLevel: 'error', root: path.join(root, 'src/renderer'), server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{ name: 'readme-fixture', configureServer(vite) { vite.middlewares.use('/fixture.html', async (_req, res) => {
      // The production page without its entry script, which the fixture replaces.
      const entry = '<script type="module" src="./main.ts"></script>';
      const page = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
      if (page.split(entry).length !== 2) throw new Error('index.html has exactly one entry script');
      const html = page.replace(entry, '').replace('</body>', '<script type="module">' + fixture + '</script></body>');
      res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/fixture.html', html));
    }); } }] });
  let win;
  try {
    fs.mkdirSync(output, { recursive: true });
    await server.listen();
    win = new BrowserWindow({ show: false, width: 1440, height: 940, webPreferences: { sandbox: true, backgroundThrottling: false, zoomFactor: 1 } });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('renderer:', event.message); });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    const js = code => win.webContents.executeJavaScript(code);
    const until = async (predicate, what) => { for (let i = 0; i < 300; i++) { if (await js(predicate)) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('timed out: ' + what); };
    const settle = () => js('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))))');
    const shot = async (name, rect) => { await settle(); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(rect, { stayHidden: true, stayAwake: true })).toPNG()); console.log('wrote', name); };

    await until('window.ready && document.querySelector("#sessionList [data-id=\\"demo\\"]")', 'session list');
    await js('document.querySelector("#sessionList [data-id=\\"demo\\"]").click()');
    await until('document.querySelector(".said.is-user") && document.querySelector(".ev-assistant_message")', 'chat');
    // The work as a person would open it: the tool calls, the plan and the workers beside the chat.
    await js(`(() => { const group = document.querySelector('#timeline details.tool-group'); if (group) group.open = true;
      const plan = document.querySelector('.agent-plan-shell'); if (plan) plan.open = true; })()`);
    await js(`document.getElementById('rightDockToggle').click()`);
    await new Promise(r => setTimeout(r, 600));
    await js(`[...document.querySelectorAll('button, [role=button]')].find(node => node.getClientRects().length && /^Sub-agents/.test(node.textContent.trim()))?.click()`);
    await new Promise(r => setTimeout(r, 600));
    await js(`document.getElementById('chatBody').scrollTop = 0`);
    await shot('workspace.png');

    // The model picker, open above the composer.
    await js(`document.getElementById('rightDockToggle').click(); const plan = document.querySelector('.agent-plan'); if (plan) plan.hidden = true;`);
    await new Promise(r => setTimeout(r, 400));
    await js(`document.querySelector('#modelMenu > summary').click()`);
    await until('document.getElementById("modelMenu").open && document.querySelector("#modelMenu .composer-popover").getClientRects().length', 'model picker');
    await settle();
    const picker = await js(`(() => { const a = document.getElementById('composer').getBoundingClientRect(), b = document.querySelector('#modelMenu .composer-popover').getBoundingClientRect();
      const x = Math.min(a.left, b.left) - 16, y = Math.min(a.top, b.top) - 16, right = Math.max(a.right, b.right) + 16, bottom = Math.max(a.bottom, b.bottom) + 16;
      return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), width: Math.round(right - x), height: Math.round(bottom - y) }; })()`);
    await shot('model-picker.png', picker);
    await js(`document.querySelector('#modelMenu > summary').click()`);

    // Settings: the folders ChatGPT may use and what it may do there.
    await js(`document.getElementById('workspaceSettings').click()`);
    await until('document.querySelector(".app").dataset.screen === "settings"', 'settings');
    await js(`document.querySelector('[data-tab="home"]')?.click()`);
    await settle();
    // Permissions and folders; the Health box below them is live status, not a setting.
    const settingsHeight = await js(`(() => { const health = [...document.querySelectorAll('.panel.is-active h2, .panel.is-active h3')].find(node => node.textContent.trim() === 'Health');
      return health ? Math.round(health.getBoundingClientRect().top - 28) : innerHeight; })()`);
    await shot('settings.png', { x: 0, y: 0, width: 1440, height: settingsHeight });
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
