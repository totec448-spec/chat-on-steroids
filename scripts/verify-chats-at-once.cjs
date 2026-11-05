// "Chats working at once" (#1694): the setting, the app-wide pause with Resume now, and what a chat
// says while its automatic step waits for a slot. Real production renderer with synthetic IPC.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const feature = 'chats-at-once';
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', feature));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 localStorage.setItem('cos.ui.language','en');
 const old=window.api,f=composerFixture,ok=data=>Promise.resolve({ok:true,data});
 window.saved=[];window.resumed=0;window.pauseUntil=null;
 const stateWith=async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.bridge={...r.data.bridge,automaticPauseUntil:window.pauseUntil};return r;};
 window.publishState=async()=>f.emit('onStateChanged',(await stateWith()).data);
 const methods={
  getState:stateWith,
  saveSettings:(patch,base)=>{window.saved.push(patch);return old.saveSettings(patch,base);},
  resumeAutomaticSends:()=>{window.resumed++;window.pauseUntil=null;return ok(true);},
  markWhatsNewSeen:()=>ok(true),chatGroups:()=>ok({version:1,groups:[],members:{}}),
  listInputs:()=>ok(window.inputs??[])
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), cacheDir: path.join(output, 'vite'), logLevel: 'error',
    resolve: { alias: { '@phosphor-icons/web': path.join(root, 'node_modules/@phosphor-icons/web/src') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules/@phosphor-icons/web/src'))] } },
    plugins: [{ name: 'chats-at-once-fixture', transformIndexHtml: html => html.replace('</head>', '<script src="/chats-at-once-fixture.js"></script></head>'),
      configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== '/chats-at-once-fixture.js') return next(); res.setHeader('Content-Type', 'text/javascript');
        res.end(fixtureConfigSource() + fs.readFileSync(path.join(root, 'scripts/fixtures/composer-ui.js'), 'utf8') + fixture); }); } }] });
  await server.listen();
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', e => { if (e.level === 'error' && !BENIGN_RENDERER_ERRORS.includes(e.message)) errors.push(e.message); });
  const js = code => win.webContents.executeJavaScript(code).catch(error => { console.error('Renderer expression:', code); throw error; });
  const until = async expression => { for (const deadline = Date.now() + 15000; Date.now() < deadline;) { if (await js(expression)) return; await pause(40); } throw new Error('Timed out: ' + expression); };
  const shot = async name => { await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`); await pause(150);
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('#sessionList [data-id="composer-preview"]')`);

  // The setting: Off by default, ten choices, saved as a number.
  await js(`document.getElementById('sidebarSettings')?.click() ?? document.querySelector('[data-open-settings], #openSettings')?.click()`);
  await js(`document.querySelector('#tabs [data-tab="agents"]')?.click() ?? [...document.querySelectorAll('#tabs button')].find(b=>/Agents/.test(b.textContent))?.click()`);
  await until(`!!document.getElementById('chatsAtOnce')?.offsetParent`);
  assert.equal(await js(`document.getElementById('chatsAtOnce').value`), '0');
  assert.deepEqual(await js(`[...document.getElementById('chatsAtOnce').options].map(o=>o.textContent)`), ['Off', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  await js(`document.getElementById('chatsAtOnce').scrollIntoView({block:'center'})`);
  await js(`const s=document.getElementById('chatsAtOnce');s.value='3';s.dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(`window.saved.some(p=>(p.patch??p).multiAgent?.chatsAtOnce===3)`);
  await shot('setting.png');

  // The pause: one notice for the whole app, with its time, and Resume now.
  await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);
  await js(`window.pauseUntil=Date.now()+20*60_000;window.publishState()`);
  await until(`!document.getElementById('automaticPause').hidden`);
  const notice = await js(`({text:document.getElementById('automaticPauseText').textContent,title:document.getElementById('resumeAutomaticSends').title})`);
  assert.match(notice.text, /^ChatGPT asked to slow down\. Automatic messages resume at \d/);
  assert.match(notice.title, /may slow them down again/);
  // What the chat says while its next Loop step waits.
  await js(`composerFixture.controls.automation='loop';composerFixture.controls.goalWait={reason:'paused',until:window.pauseUntil};composerFixture.notify()`);
  await until(`/ChatGPT asked to slow down/.test(document.getElementById('goalLifecycle')?.textContent ?? '')`);
  assert.match(await js(`document.getElementById('goalLifecycle')?.textContent ?? ''`), /Resumes in \d+:\d\d/);
  await shot('paused.png');
  await js(`document.getElementById('resumeAutomaticSends').click()`);
  await until(`window.resumed===1 && document.getElementById('automaticPause').hidden`);

  // Waiting for a slot: the Loop row and a queued scheduled run say so.
  await js(`composerFixture.controls.goalWait={reason:'slots'};window.inputs=[{id:'sched-1',sessionId:'composer-preview',text:'Check the open issues',mode:'auto',state:'queued',owner:null,createdAt:Date.now(),dueAt:0,conversationId:'preview-chat',model:null,reasoningEffort:null,scheduled:{scheduleId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',dueAt:Date.now(),late:false},slotWait:'slots'}];composerFixture.notify()`);
  await until(`/Waiting for a free slot \\(Chats working at once\\)/.test(document.getElementById('goalLifecycle')?.textContent ?? '')`);
  await shot('waiting.png');
  win.setContentSize(760, 900); await until('innerWidth===760'); await pause(150);
  assert.equal(await js(`document.getElementById('chatBody').scrollWidth<=document.getElementById('chatBody').clientWidth+1`), true);
  await shot('waiting-narrow.png');
  assert.deepEqual(errors, []);
  console.log('PASS: ' + feature + ' setting, pause notice, Resume now, waiting captions, narrow');
  win.destroy(); await server.close(); app.exit(0);
}).catch(async error => { fs.mkdirSync(output, { recursive: true }); if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); console.error(error); await server?.close(); app.exit(1); });
