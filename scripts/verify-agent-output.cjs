// A running agent command's output, read-only, in the Terminal dock (#1920): Output in the
// running-command row, the Agent tab with live output and how it ended, Stop and close.
// Real production renderer with synthetic IPC; no provider or installed app data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const feature = 'agent-output';
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', feature));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 localStorage.setItem('cos.ui.language','en');
 const old=window.api,ok=data=>Promise.resolve({ok:true,data});
 const now=Date.now();
 window.processes=[{processId:4321,incarnation:7,command:'npm run test:e2e -- --project=chromium --workers=2',startedAt:now-252000,tty:true}];
 window.opened=[];window.closedViews=[];window.stopped=[];window.outputListeners=new Set();window.typed=[];
 window.emitOutput=value=>{for(const fn of window.outputListeners)fn(value);};
 const methods={
  markWhatsNewSeen:()=>ok(true),chatGroups:()=>ok({version:1,groups:[],members:{}}),
  runningProcesses:()=>ok(window.processes),onBackgroundProcessesChanged:()=>()=>{},
  agentOutputOpen:(id,sessionId,processId,incarnation)=>{window.opened.push({id,sessionId,processId,incarnation});return Promise.resolve({ok:true,data:true});},
  agentOutputClose:id=>{window.closedViews.push(id);return Promise.resolve({ok:true,data:true});},
  onAgentOutput:fn=>{window.outputListeners.add(fn);return()=>window.outputListeners.delete(fn);},
  stopProcess:(sessionId,processId,incarnation)=>{window.stopped.push({sessionId,processId,incarnation});return ok(true);},
  terminalWrite:(id,data)=>{window.typed.push(data);return ok(true);}
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), cacheDir: path.join(output, 'vite'), logLevel: 'error',
    resolve: { alias: { '@phosphor-icons/web': path.join(root, 'node_modules/@phosphor-icons/web/src') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules/@phosphor-icons/web/src')), fs.realpathSync(path.join(root, 'node_modules'))] } },
    plugins: [{ name: 'agent-output-fixture', transformIndexHtml: html => html.replace('</head>', '<script src="/agent-output-fixture.js"></script></head>'),
      configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== '/agent-output-fixture.js') return next(); res.setHeader('Content-Type', 'text/javascript');
        res.end(fixtureConfigSource() + fs.readFileSync(path.join(root, 'scripts/fixtures/composer-ui.js'), 'utf8') + fixture); }); } }] });
  await server.listen();
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', e => { if (e.level === 'error' && !BENIGN_RENDERER_ERRORS.includes(e.message)) errors.push(e.message); });
  const js = code => win.webContents.executeJavaScript(code).catch(error => { console.error('Renderer expression:', code); throw error; });
  const until = async expression => { for (const deadline = Date.now() + 15000; Date.now() < deadline;) { if (await js(expression)) return; await pause(40); } throw new Error('Timed out: ' + expression); };
  const shot = async name => { await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`); await pause(250);
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  const screen = `(document.querySelector('#workspaceTerminal .terminal-screen.is-agent:not([hidden]) .xterm-rows')?.textContent ?? '')`;
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('#sessionList [data-id="composer-preview"]')`);
  await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);
  await until(`!document.getElementById('backgroundExecStatus').hidden && !!document.querySelector('#backgroundExecStatus .background-exec-output')`);
  const button = await js(`(() => { const b=document.querySelector('#backgroundExecStatus .background-exec-output'); return {text:b.textContent, label:b.getAttribute('aria-label'), next:b.nextElementSibling?.className}; })()`);
  assert.equal(button.text, 'Output');
  assert.match(button.label, /^Show the output of npm run test:e2e .*, read-only$/);
  assert.match(button.next, /background-exec-stop/);
  await shot('row.png');

  await js(`document.querySelector('#backgroundExecStatus .background-exec-output').click()`);
  await until(`window.opened.length===1 && !!document.querySelector('#workspaceTerminal .terminal-tab .terminal-agent-badge')`);
  assert.deepEqual(await js('window.opened[0]'), { id: await js('window.opened[0].id'), sessionId: 'composer-preview', processId: 4321, incarnation: 7 });
  // The bottom dock opened on the agent's tab, and no shell of the person's was started.
  assert.equal(await js(`document.querySelectorAll('#workspaceTerminal .terminal-tab').length`), 1);
  await until(`${screen}.includes('Read-only: the agent')`);
  await js(`emitOutput({id:window.opened[0].id,data:'Running 48 tests using 2 workers\\n  ✓ settings › saves the theme (1.2s)\\n  ✘ devices › waits for the gateway (30.0s)\\n'})`);
  await until(`${screen}.includes('waits for the gateway')`);
  // Nothing can be typed, so no cursor shows, even when the command's output asks for one again.
  await js(`emitOutput({id:window.opened[0].id,data:'\\x1b[?25h'})`); await pause(400);
  // Offscreen xterm draws no cursor element, so the rule is checked on one styled as xterm styles it.
  const cursor = await js(`(() => { const host = document.querySelector('#workspaceTerminal .terminal-screen.is-agent .xterm-rows'); const c = document.createElement('span'); c.className = 'xterm-cursor xterm-cursor-block'; c.style.backgroundColor = 'rgb(255, 255, 255)'; c.style.outline = '1px solid red'; c.textContent = ' '; host.append(c); const s = getComputedStyle(c); const r = { bg: s.backgroundColor, outline: s.outlineStyle }; c.remove(); return r; })()`);
  assert.deepEqual(cursor, { bg: 'rgba(0, 0, 0, 0)', outline: 'none' });
  // Typing does nothing: no write reaches anything.
  await js(`document.querySelector('#workspaceTerminal .terminal-screen.is-agent textarea')?.focus()`);
  await js(`document.querySelector('#workspaceTerminal .terminal-screen.is-agent textarea')?.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}))`);
  assert.deepEqual(await js('window.typed'), []);
  // Output again selects the same tab instead of opening a second.
  await js(`document.querySelector('#backgroundExecStatus .background-exec-output').click()`);
  await pause(200);
  assert.equal(await js('window.opened.length'), 1);
  await shot('running.png');
  // Stop in the tab is the row's Stop.
  await js(`document.querySelector('#workspaceTerminal .terminal-agent-stop').click()`);
  await until('window.stopped.length===1');
  assert.deepEqual(await js('window.stopped[0]'), { sessionId: 'composer-preview', processId: 4321, incarnation: 7 });
  await js(`emitOutput({id:window.opened[0].id,exit:{exitCode:1,seconds:252}})`);
  await until(`${screen}.includes('Exited with 1 after 4 min 12 s') || ${screen}.includes('Exited with 1 after 4m 12s')`);
  await until(`!document.querySelector('#workspaceTerminal .terminal-agent-stop')`);
  await shot('exited.png');
  win.setContentSize(760, 900); await until('innerWidth===760'); await pause(200);
  await shot('exited-narrow.png');
  win.setContentSize(1280, 900); await until('innerWidth===1280');
  // Closing the tab only stops watching.
  await js(`document.querySelector('#workspaceTerminal .terminal-tab .btn[aria-label="Close output"]').click()`);
  await until(`window.closedViews.length===1 && !document.querySelector('#workspaceTerminal .terminal-tab')`);
  assert.equal(await js('window.stopped.length'), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: ' + feature + ' Output button, read-only Agent tab, live output, Stop, exit line, close');
  win.destroy(); await server.close(); app.exit(0);
}).catch(async error => { fs.mkdirSync(output, { recursive: true }); if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); console.error(error); await server?.close(); app.exit(1); });
