// A step handed to the person (#1695): its card in the timeline, the line above the composer, Copy,
// Mark as done and Skip. Real production renderer with synthetic IPC; no provider or installed app data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const feature = 'user-requests';
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', feature));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 localStorage.setItem('cos.ui.language','en');
 const old=window.api,f=composerFixture,now=Date.now(),ok=data=>Promise.resolve({ok:true,data});
 const stored=text=>({text,chars:text.length,truncated:false});
 const command='cd firmware && make flash PORT=/dev/tty.usbserial-0001';
 const request=(id,extra)=>({id,command,folder:'/Users/you/projects/thermostat',remote:false,purpose:'Flash the new firmware onto the board. It needs the USB cable and the reset button, so the agent cannot do it.',
  expected:[{path:'firmware/build/flash.log',real:'/Users/you/projects/thermostat/firmware/build/flash.log'},{path:'firmware/build/checksum.txt',real:'/Users/you/projects/thermostat/firmware/build/checksum.txt'}],
  constraints:'Takes about 2 minutes. Run it once.',state:'open',createdAt:now-120000,conversationId:'preview-chat',
  found:[{path:'firmware/build/flash.log',state:'found',size:18432,modifiedAt:now-60000},{path:'firmware/build/checksum.txt',state:'missing'}],...extra});
 window.requests=[request('ur_firmware0001'),{...request('ur_sensortest01'),command:'python3 tools/calibrate.py --sensor bme280',purpose:'Calibrate the sensor while you hold it at room temperature.',expected:[],found:[],constraints:undefined,from:{sessionId:'worker-session',title:'Sensor calibration'}}];
 f.controls.userRequests=window.requests;
 f.events.splice(1,0,{seq:2,time:now+2,source:'mcp',kind:'tool_call',turnId:'t-1',call:{callId:'00000000-0000-4000-8000-000000000002',tool:'ask_user_to_run',
  args:stored(JSON.stringify({command,purpose:'Flash the new firmware'})),result:stored('Step recorded for the person: ur_firmware0001. It is shown in their app with the command, the folder and its purpose. The app does not run it.'),
  summary:{kind:'session',title:'Asked you to run a step',tone:'neutral'},outcome:'ok',attribution:'request_id',requestId:'synthetic-request',conversationId:'preview-chat',durationMs:12}});
 f.events.at(-1).seq=3;
 window.answers=[];window.capturedClipboard=null;
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config={...fixtureMerge(fixtureDefaults,r.data.config),readOnly:false};return r;},
  writeClipboard:value=>{window.capturedClipboard=value;return ok(true);},
  markWhatsNewSeen:()=>ok(true),chatGroups:()=>ok({version:1,groups:[],members:{}}),
  answerUserRequest:(sessionId,requestId,answer)=>{window.answers.push([sessionId,requestId,answer]);
   window.requests=window.requests.map(row=>row.id===requestId?{...row,state:answer,answeredAt:Date.now(),found:[]}:row);f.controls.userRequests=window.requests;
   return ok(window.requests.filter(row=>!row.from));}
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), cacheDir: path.join(output, 'vite'), logLevel: 'error',
    resolve: { alias: { '@phosphor-icons/web': path.join(root, 'node_modules/@phosphor-icons/web/src') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules/@phosphor-icons/web/src'))] } },
    plugins: [{ name: 'user-request-fixture', transformIndexHtml: html => html.replace('</head>', '<script src="/user-request-fixture.js"></script></head>'),
      configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== '/user-request-fixture.js') return next(); res.setHeader('Content-Type', 'text/javascript');
        res.end(fixtureConfigSource() + fs.readFileSync(path.join(root, 'scripts/fixtures/composer-ui.js'), 'utf8') + fixture); }); } }] });
  await server.listen();
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', e => { if (e.level === 'error' && !BENIGN_RENDERER_ERRORS.includes(e.message)) errors.push(e.message); });
  const js = code => win.webContents.executeJavaScript(code).catch(error => { console.error('Renderer expression:', code); throw error; });
  const until = async expression => { for (const deadline = Date.now() + 15000; Date.now() < deadline;) { if (await js(expression)) return; await pause(40); } throw new Error('Timed out: ' + expression); };
  const settle = async () => { await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`); await pause(150); };
  const shot = async name => { await settle(); fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('#sessionList [data-id="composer-preview"]')`);
  await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);
  await until(`!!document.querySelector('#timeline .user-request[data-request-id="ur_firmware0001"]')`);

  // The card is the row: shown whole, never folded into a closed round, with no verdict about the command.
  const card = await js(`(() => { const c=document.querySelector('#timeline .user-request'); const r=c.getBoundingClientRect();
    return {visible:r.height>100&&!!c.offsetParent, pre:c.querySelector('pre').textContent, summaryHidden:getComputedStyle(c.closest('.tool').querySelector('summary')).display==='none',
      text:c.textContent, buttons:[...c.querySelectorAll('.user-request-actions button')].map(b=>b.textContent)}; })()`);
  // Lined up with the messages around it, not outdented like an open call.
  const edges = await js(`(() => { const c=document.querySelector('#timeline .user-request').getBoundingClientRect(), m=document.querySelector('#timeline .msg.rich').getBoundingClientRect(); return [c.left-m.left, c.right-m.right]; })()`);
  assert.ok(Math.abs(edges[0]) <= 1 && Math.abs(edges[1]) <= 1, 'Card edges align with the answer: ' + edges);
  assert.equal(card.visible, true, 'The step card is shown in the timeline');
  assert.equal(card.summaryHidden, true, 'The card replaces the tool row headline');
  assert.equal(card.pre, 'cd firmware && make flash PORT=/dev/tty.usbserial-0001');
  assert.match(card.text, /Run it yourself, in your own terminal: Chat On Steroids does not run or check it\./);
  assert.doesNotMatch(card.text.toLowerCase(), /\bsafe\b|verified/);
  assert.deepEqual(card.buttons, ['Mark as done', 'Skip']);
  assert.match(card.text, /found, 18 kB, /); assert.match(card.text, /not there yet/);

  // The line above the composer counts the chat's own and its sub-agent's open steps.
  await until(`!document.getElementById('userRequests').hidden`);
  assert.equal(await js(`document.querySelector('.user-requests-title').textContent`), '2 steps waiting for you');
  await shot('timeline-dark.png');
  // Long details fold into one line under the folder (Haz on #2049); opening it shows the files.
  const folded = await js(`(() => { const d=document.querySelector('#timeline .user-request details.user-request-more'); return d ? { open: d.open, summary: d.querySelector('summary').textContent } : null; })()`);
  if (folded) {
    assert.equal(folded.open, false);
    await js(`document.querySelector('#timeline .user-request details.user-request-more > summary').click()`);
    await until(`document.querySelector('#timeline .user-request details.user-request-more').open`);
    await shot('timeline-details-open.png');
    await js(`document.querySelector('#timeline .user-request details.user-request-more > summary').click()`);
  }
  await js(`document.querySelector('.user-requests-shell').open=true`);
  await until(`document.querySelectorAll('#userRequests .user-request').length===2`);
  assert.match(await js(`document.querySelectorAll('#userRequests .user-request')[1].textContent`), /From the sub-agent “Sensor calibration”/);
  // A card's own "expected files" line looks the same in the dock as in the timeline: the dock's
  // header styles (its chevron, padding and height) stay on the dock's header (2.1.51 polish pass).
  const LOOK = `const c=getComputedStyle(s), a=getComputedStyle(s,'::after'); return { after: a.content, height: Math.round(s.getBoundingClientRect().height), padding: c.padding };`;
  const inDock = await js(`(() => { const s=document.querySelector('#userRequests .user-request details.user-request-more > summary'); ${LOOK} })()`);
  const inTimeline = await js(`(() => { const s=document.querySelector('#timeline .user-request details.user-request-more > summary'); ${LOOK} })()`);
  assert.equal(inDock.after, 'none', 'the dock header chevron leaked onto a card summary');
  assert.deepEqual(inDock, inTimeline);
  await shot('dock-open-dark.png');
  await js(`document.querySelector('.user-requests-shell').open=false`);

  await js(`document.querySelector('#timeline .user-request .tool-copy').click()`);
  await until(`window.capturedClipboard!==null`);
  assert.equal(await js('window.capturedClipboard'), 'cd firmware && make flash PORT=/dev/tty.usbserial-0001');
  assert.equal(await js(`getComputedStyle(document.querySelector('#timeline .user-request .tool-copy')).opacity`), '1', 'Copy shows without hover');

  // Narrow window: nothing spills sideways.
  win.setContentSize(760, 900); await until('innerWidth===760'); await pause(150);
  assert.equal(await js(`document.getElementById('chatBody').scrollWidth<=document.getElementById('chatBody').clientWidth+1`), true, 'The card stays inside a narrow chat');
  await shot('timeline-narrow.png');
  win.setContentSize(1280, 900); await until('innerWidth===1280');

  // Mark as done: the card answers in place, the line counts one step less.
  await js(`document.querySelector('#timeline .user-request .user-request-actions .btn-solid').click()`);
  await until(`document.querySelector('#timeline .user-request').dataset.state==='done'`);
  assert.deepEqual(await js('window.answers'), [['composer-preview', 'ur_firmware0001', 'done']]);
  assert.equal(await js(`!!document.querySelector('#timeline .user-request .user-request-actions')`), false);
  await until(`document.querySelector('.user-requests-title')?.textContent==='1 step waiting for you'`);
  // A sub-agent's step is answered in its own chat.
  await js(`document.querySelector('.user-requests-shell').open=true`);
  await until(`!!document.querySelector('#userRequests .user-request .btn:not(.btn-solid)')`);
  await js(`document.querySelector('#userRequests .user-request .btn:not(.btn-solid)').click()`);
  await until('window.answers.length===2');
  assert.deepEqual(await js('window.answers[1]'), ['worker-session', 'ur_sensortest01', 'skipped']);
  await until(`document.getElementById('userRequests').hidden`);
  await shot('answered-dark.png');

  await js(`const theme=document.getElementById('appearanceTheme');theme.value='light';theme.dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(`document.documentElement.dataset.theme==='light'`);
  await shot('answered-light.png');
  assert.equal(await js(`!!document.querySelector('.toast')`), false, 'No fixture toast in the captures');
  assert.deepEqual(errors, []);
  console.log('PASS: ' + feature + ' card, composer line, copy, answers, narrow and light');
  win.destroy(); await server.close(); app.exit(0);
}).catch(async error => { fs.mkdirSync(output, { recursive: true }); if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); console.error(error); await server?.close(); app.exit(1); });
