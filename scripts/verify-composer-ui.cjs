// Production renderer and styles, with in-memory IPC only. No account or user data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp/composer-ui');
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    cacheDir: path.join(output, 'vite'), logLevel: 'error',
    resolve: { alias: { '@phosphor-icons/web': path.join(root, 'node_modules/@phosphor-icons/web/src') } },
    server: { host: '127.0.0.1', port: 4420, strictPort: true, fs: { allow: [root] } },
    plugins: [{ name: 'ipc-fixture', transformIndexHtml(html) {
      return html.replace('</head>', '<script src="/composer-fixture.js"></script></head>');
    }, configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url !== '/composer-fixture.js') return next();
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fs.readFileSync(path.join(__dirname, 'fixtures/composer-ui.js')));
    }); } }]
  });
  await server.listen();
  const win = new BrowserWindow({ show: false, width: 1440, height: 960,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await win.loadURL('http://127.0.0.1:4420'); await pause(2200);
  await win.webContents.executeJavaScript(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`);
  await pause(500);
  const js = source => win.webContents.executeJavaScript(source);
  const checks = [];
  const check = async (name, source) => {
    const passed = await js(source);
    if (!passed) { await capture('failure'); console.error(await js(`({menuOpen:document.getElementById('composerSettings').open,menuClass:document.getElementById('composerSettings').className,controlsHidden:document.getElementById('sessionControls').hidden,objectiveDisabled:document.getElementById('sessionObjective').disabled,objectiveRect:document.getElementById('sessionObjective').getBoundingClientRect().toJSON()})`)); }
    if (!passed) console.error(await js(`({dock:document.getElementById('composerDock').getBoundingClientRect().toJSON(),children:[...document.querySelector('.composer-dock-body').children].map(e=>({id:e.id,hidden:e.hidden,height:e.getBoundingClientRect().height,text:e.textContent})),planHidden:document.getElementById('agentPlan').hidden,goalHidden:document.getElementById('activeGoalRow').hidden,queued:document.querySelectorAll('#finishQueue .queued-input').length,context:getComputedStyle(document.getElementById('contextMeterInfo')).display,focus:document.activeElement.id})`));
    assert.equal(passed, true, name); checks.push(name);
  };
  // A fixture scenario reaches the renderer through its asynchronous session reload. Poll for
  // the expected state instead of sleeping a fixed time, which lost that race on slow runners.
  const until = async (source, timeout = 5000) => {
    for (const end = Date.now() + timeout; Date.now() < end && !(await js(source));) await pause(100);
  };
  const click = async selector => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await pause(200); };
  const type = async text => { await js(`(() => { const input = document.getElementById('chatInput'); input.value=${JSON.stringify(text)}; input.focus(); input.dispatchEvent(new Event('input', {bubbles:true})); })()`); await pause(260); };
  const capture = async name => { fs.mkdirSync(output, {recursive:true}); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  await check('Renderer selected the fixture session', `document.getElementById('contextMeterCompact').textContent==='38%'`);
  await capture('composer');
  await click('#modelMenu > summary');
  await check('Every account model is offered', `document.querySelectorAll('#composerModelChoices .model-choice').length===5`);
  await click('[data-model="gpt-5.5"]');
  await check('Model click preserves open menu and exact identity', `document.getElementById('modelMenu').open&&document.getElementById('composerModel').value==='gpt-5.5'`);
  await js(`{const input=document.querySelector('#composerPowerChoices input');input.value='0';input.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await check('Effort changes only the selected model', `document.getElementById('composerModel').value==='gpt-5.5'&&document.getElementById('composerReasoning').value==='low'`);
  await capture('model'); await click('#chatInput');
  await click('#composerSettings > summary'); await capture('modes');
  await click('[data-mode="goal"]'); await pause(350);
  await check('Goal uses native controller and appears in dock', `composerFixture.controls.automation==='goal'&&!document.getElementById('activeGoalRow').hidden&&!document.getElementById('composerSettings').open`);
  await click('#composerSettings > summary'); await click('[data-mode="off"]');
  await click('#contextMeterButton'); await capture('context');
  await click('#contextDisplay');
  await check('Context values toggle in the original meter', `document.getElementById('contextMeterCompact').textContent==='152K / 400K'`);
  await js(`document.getElementById('contextDisplay').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await pause(180);
  await check('Escape closes context and restores focus', `getComputedStyle(document.getElementById('contextMeterInfo')).display==='none'&&document.activeElement.id==='contextMeterButton'`);
  await click('#contextMeterButton'); await click('#compactSession'); await pause(350);
  await check('Compact reaches native controller', `composerFixture.controls.job?.phase==='requesting'`);
  await click('#contextMeterButton'); await click('#cancelCompaction'); await pause(300);
  await check('Cancel reaches native controller', `composerFixture.controls.job===null`);
  await click('#attachmentMenu > summary'); await capture('add');
  await click('#composerSkills');
  await check('Slash commands and skills use original picker', `!document.getElementById('skillPicker').hidden&&document.querySelectorAll('.slash-menu-option').length>=7`);
  await click('[data-skill-id="frontend-design"]');
  await check('Skill pill remains aligned', `(()=>{const p=document.querySelector('.composer-selected-skill'); const centers=[...p.children].map(e=>{const r=e.getBoundingClientRect();return r.y+r.height/2});return Math.max(...centers)-Math.min(...centers)<1})()`);
  await click('#attachmentMenu > summary'); await click('#attachImages'); await pause(260);
  await check('Attachments and skills occupy separate rows above the draft', `(()=>{const skills=document.getElementById('composerSelectedSkills').getBoundingClientRect(),files=document.getElementById('composerImages').getBoundingClientRect(),input=document.getElementById('chatInput').getBoundingClientRect();return skills.height>0&&files.height>0&&skills.bottom<=files.top&&files.bottom<=input.top})()`);
  await click('#composerImages .image-remove');
  await type('Review the layout.'); await click('.composer-selected-skill-remove');
  await check('Removing a skill preserves the draft', `document.getElementById('chatInput').value==='Review the layout.'`);
  await click('#chatSend'); await pause(350);
  await check('Send retains selected model and effort', `(async()=>{const result=await window.api.listInputs();return result.data.some(entry=>entry.text==='Review the layout.'&&entry.model==='gpt-5.5'&&entry.reasoningEffort==='low')})()`);
  await js(`composerFixture.scenario('empty')`); await pause(400);
  await click('#createPlan');
  await check('Plan toggles native send behavior', `document.getElementById('createPlan').getAttribute('aria-pressed')==='true'&&document.getElementById('chatSend').getAttribute('aria-label')==='Generate plan'`);
  await click('#createPlan');
  await js(`composerFixture.scenario('queue')`); await until(`!document.getElementById('agentPlan').hidden&&!document.getElementById('activeGoalRow').hidden&&document.querySelectorAll('#finishQueue .queued-input').length===1`);
  await check('Plan, Goal and queue coexist', `!document.getElementById('agentPlan').hidden&&!document.getElementById('activeGoalRow').hidden&&document.querySelectorAll('#finishQueue .queued-input').length===1`);
  await capture('dock');
  await js(`composerFixture.scenario('complete')`);
  for (let attempt = 0; attempt < 25; attempt++) {
    await pause(200);
    if (await js(`document.getElementById('agentPlan').hidden`)) break;
  }
  await check('Completion removes plan while preserving queue and Goal', `document.getElementById('agentPlan').hidden&&!document.getElementById('activeGoalRow').hidden&&document.querySelectorAll('#finishQueue .queued-input').length===1`);
  await js(`composerFixture.scenario('empty')`); await until(`document.getElementById('composerDock').getBoundingClientRect().height===0`);
  await check('Empty dock leaves no strip', `document.getElementById('composerDock').getBoundingClientRect().height===0`);
  await js(`composerFixture.scenario('hold')`); await until(`document.getElementById('chatSend').dataset.action==='stop'`);
  await check('Stop is available during finish hold', `document.getElementById('chatSend').dataset.action==='stop'`);
  await click('#chatSend'); await pause(350);
  await check('Stop reaches native controller', `composerFixture.controls.activeTurnId===null`);
  await js(`composerFixture.scenario('empty')`); await pause(400);
  await click('#rightDockToggle'); await pause(300);
  await check('Composer controls fit with the right work panel open', `(()=>{const composer=document.getElementById('composer').getBoundingClientRect();const mode=document.getElementById('createPlan').getBoundingClientRect(),context=document.getElementById('contextMeter').getBoundingClientRect(),send=document.getElementById('chatSend').getBoundingClientRect();return mode.right<=context.left||mode.bottom<=context.top})()`);
  await click('#rightDockToggle');
  for (const width of [1440, 900]) {
    win.setContentSize(width, 960); await pause(250);
    await click('#newChat'); await type('');
    const titleTop = await js(`document.getElementById('timelineEmpty').getBoundingClientRect().top`);
    await type(Array.from({length:12}, (_, i) => `Draft line ${i+1}`).join('\n'));
    await check('Welcome remains fixed while draft grows at '+width, `Math.abs(document.getElementById('timelineEmpty').getBoundingClientRect().top-${titleTop})<1`);
    await check('Toolbar fits at '+width, `(()=>{const nodes=['attachmentMenu','composerSettings','createPlan','contextMeter','modelMenu','chatSend'].map(id=>document.getElementById(id).getBoundingClientRect());return nodes.every(r=>r.left>=0&&r.right<=innerWidth)&&nodes.every((r,i)=>nodes.every((s,j)=>i===j||r.right<=s.left+.5||s.right<=r.left+.5||r.bottom<=s.top+.5||s.bottom<=r.top+.5))})()`);
    await type(''); await capture('empty-'+width);
  }
  await click('#composerSettings > summary'); await click('[data-mode="goal"]');
  await click('#activeGoalRow button:last-child');
  await check('New-chat Goal still exposes the original objective editor', `document.getElementById('composerSettings').open&&!document.getElementById('sessionControls').hidden&&document.activeElement.id==='sessionObjective'`);
  await click('#chatInput');
  await click('#composerSettings > summary');
  await check('Reopening the mode menu cannot flash compaction or the editor', `document.getElementById('composerSettings').classList.contains('mode-picker')&&getComputedStyle(document.getElementById('sessionControls')).display==='none'&&!document.getElementById('composerSettings').contains(document.getElementById('compactSession'))`);
  await capture('modes-goal');
  await click('[data-edit-mode="loop"]');
  await check('Mode menu pencil opens the Loop editor without switching automation', `document.getElementById('chatAutomation').value==='goal'&&document.getElementById('sessionObjectiveMode').value==='loop'&&document.getElementById('composerSettings').open&&!document.getElementById('composerSettings').classList.contains('mode-picker')&&document.activeElement.id==='sessionObjective'`);
  await capture('editor');
  await js(`(()=>{const field=document.getElementById('sessionObjective');field.value='Keep refining the dashboard until every panel passes review.';field.dispatchEvent(new Event('input',{bubbles:true}))})()`); await pause(150);
  await capture('editor-filled');
  // The incumbent height observer also produces this Chromium notification when
  // a draft grows (reproduced against the frozen approved preview). Report it,
  // while keeping actual renderer exceptions fatal.
  const resizeNotifications = errors.filter(message => message === 'ResizeObserver loop completed with undelivered notifications.');
  assert.deepEqual(errors.filter(message => !resizeNotifications.includes(message)), [], 'renderer console errors');
  console.log(JSON.stringify({passed:checks.length,checks,resizeNotifications:resizeNotifications.length,captures:output},null,2));
  win.destroy(); await server.close(); app.quit();
}).catch(async error => { console.error(error); await server?.close(); app.exit(1); });
