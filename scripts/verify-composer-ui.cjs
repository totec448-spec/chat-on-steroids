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
  await win.loadURL('http://127.0.0.1:4420'); win.webContents.setZoomFactor(1); await pause(2200);
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
  const capture = async name => { await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); fs.mkdirSync(output, {recursive:true}); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const startDisclosureSample = () => js(`(()=>{window.__composerDisclosureSample=new Promise(resolve=>{const start=performance.now(),frames=[];const sample=()=>{frames.push({time:performance.now()-start,list:document.getElementById('composerModelChoices').getBoundingClientRect().height,popover:document.querySelector('#modelMenu > .composer-popover').getBoundingClientRect().height,chevron:getComputedStyle(document.querySelector('#composerModelToggle .picker-chevron')).transform});if(performance.now()-start>=320)resolve(frames);else requestAnimationFrame(sample)};sample()});return true})()`);
  const sampleDisclosure = () => js(`window.__composerDisclosureSample`);
  // Animation time follows rendered frames, not the hosted runner's wall clock.
  const settleEffortShortcut = () => js(`Promise.all(document.getElementById('composerSpark').getAnimations({subtree:true}).map(animation=>animation.finished)).then(()=>true)`);
  // Exercise both motion preferences explicitly; hosted macOS defaults to reduce.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await check('Renderer selected the fixture session', `document.getElementById('contextMeterCompact').textContent==='38%'`);
  await capture('composer');
  await click('#modelMenu > summary');
  await check('Effort popover initially hides the model list', `document.getElementById('composerModelChoices').hidden&&document.getElementById('composerModelToggle').getAttribute('aria-expanded')==='false'`);
  await capture('effort');
  const closedHeight = await js(`document.querySelector('#modelMenu > .composer-popover').getBoundingClientRect().height`);
  const modelPoint = await js(`(()=>{const r=document.getElementById('composerModelToggle').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  await startDisclosureSample();
  win.webContents.sendInputEvent({type:'mouseMove',...modelPoint});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...modelPoint});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...modelPoint});
  const opening = await sampleDisclosure();
  fs.writeFileSync(path.join(output,'disclosure-frames.json'),JSON.stringify(opening,null,2));
  assert(opening.some(frame=>frame.popover>closedHeight+1&&frame.popover<opening.at(-1).popover-1),'Popover height has intermediate frames while growing');
  assert(opening.some(frame=>frame.chevron!==opening[0].chevron&&frame.chevron!==opening.at(-1).chevron),'Model-name chevron has intermediate rotation frames while opening');
  await check('Native model-name click opens the list without changing the selection', `!document.getElementById('composerModelChoices').hidden&&document.getElementById('composerModelToggle').getAttribute('aria-expanded')==='true'&&document.getElementById('composerModel').value==='gpt-6-sol'`);
  await startDisclosureSample();
  await js(`document.getElementById('composerModelToggle').click()`);
  await check('Closing revokes model-list input immediately', `document.getElementById('composerModelChoices').inert`);
  const closing = await sampleDisclosure();
  assert(closing.some(frame=>frame.popover>closing.at(-1).popover+1&&frame.popover<closing[0].popover-1),'Popover height has intermediate frames while shrinking');
  assert(closing.some(frame=>frame.chevron!==closing[0].chevron&&frame.chevron!==closing.at(-1).chevron),'Model-name chevron has intermediate rotation frames while closing');
  await js(`window.__composerShortcutPair={model:document.getElementById('composerModel').value,effort:document.getElementById('composerReasoning').value};document.getElementById('chatInput').value='Keep this draft';document.getElementById('composerSpark').focus();document.getElementById('composerSpark').click()`);
  await check('Lightning immediately selects the lowest effort and offers maximum effort', `document.getElementById('composerReasoning').value==='low'&&document.getElementById('composerPowerTitle').textContent==='Low'&&document.getElementById('composerSpark').dataset.action==='max'&&document.getElementById('composerSpark').getAttribute('aria-label')==='Use maximum effort: Ultra'&&document.querySelector('#composerPowerChoices input').value==='0'`);
  await check('Effort shortcut preserves model, draft, open picker and button focus', `document.getElementById('composerModel').value===window.__composerShortcutPair.model&&document.getElementById('chatInput').value==='Keep this draft'&&document.getElementById('modelMenu').open&&document.activeElement.id==='composerSpark'&&!document.querySelector('.toast')`);
  await settleEffortShortcut();
  await check('Brain is the settled icon at minimum effort', `getComputedStyle(document.querySelector('.spark-brain')).opacity==='1'&&getComputedStyle(document.querySelector('.spark-lightning')).opacity==='0'&&getComputedStyle(document.querySelector('.spark-brain'),'::before').content!=='none'`);
  await capture('minimum-effort');
  await js(`document.getElementById('composerSpark').click()`);
  await check('Brain selects the highest effort instead of restoring the previous High', `window.__composerShortcutPair.effort==='high'&&document.getElementById('composerReasoning').value==='ultra'&&document.getElementById('composerPowerTitle').textContent==='Ultra'&&document.getElementById('composerSpark').dataset.action==='min'&&document.querySelector('#composerPowerChoices input').value==='5'`);
  await settleEffortShortcut();
  await check('Lightning is the settled icon at maximum effort', `getComputedStyle(document.querySelector('.spark-brain')).opacity==='0'&&getComputedStyle(document.querySelector('.spark-lightning')).opacity==='1'`);
  await capture('maximum-effort');
  await js(`for(let i=0;i<10;i++)document.getElementById('composerSpark').click()`);
  await check('Rapid effort clicks keep at most two animations and land on the correct endpoint', `document.getElementById('composerReasoning').value==='ultra'&&document.getElementById('composerModel').value===window.__composerShortcutPair.model&&document.getElementById('composerSpark').getAnimations({subtree:true}).length<=2`);
  await settleEffortShortcut();
  await check('Effort shortcut settles without background animation', `document.getElementById('composerSpark').getAnimations({subtree:true}).length===0`);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await js(`document.getElementById('composerModelToggle').click();document.getElementById('composerSpark').click()`);
  await check('Reduced motion preserves effort changes without disclosure or spatial icon motion', `matchMedia('(prefers-reduced-motion: reduce)').matches&&getComputedStyle(document.getElementById('composerModelChoices')).transitionDuration==='0s'&&getComputedStyle(document.querySelector('#composerModelToggle .picker-chevron')).transitionDuration==='0s'&&document.getElementById('composerReasoning').value==='low'&&document.getElementById('composerSpark').getAnimations({subtree:true}).every(animation=>animation.effect.getKeyframes().every(frame=>!frame.transform))`);
  await js(`document.getElementById('composerModelToggle').click();document.getElementById('composerReasoning').value=window.__composerShortcutPair.effort;document.getElementById('composerReasoning').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('chatInput').value=''`); await pause(300);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
  await js(`window.__composerSelection={model:document.getElementById('composerModel').value,effort:document.getElementById('composerReasoning').value}`);
  const { result: appearanceWindow } = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'window' });
  for (const width of [1440, 900]) for (const zoom of [1, 1.25]) for (const theme of ['dark', 'light']) for (const language of ['en', 'pt-BR', 'ja']) {
    win.setContentSize(width, 960); win.webContents.setZoomFactor(zoom);
    // CDP arguments carry data without constructing executable code from string values.
    const appearance = await win.webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId: appearanceWindow.objectId, arguments: [{ value: theme }, { value: language }], awaitPromise: true,
      functionDeclaration: `async function(theme, language) {
        window.__composerAppearanceCase = { theme, language };
        const select = document.getElementById('uiLanguage'); select.value = language;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const { data } = await window.api.getState();
        await window.api.saveSettings({ patch: { ui: { ...data.config.ui, theme, language } } });
      }`
    });
    assert(!appearance.exceptionDetails, 'Theme/language fixture update succeeded');
    await pause(100);
    await check('Effort text contrast '+[theme,language].join('/'), `(()=>{const luminance=color=>{const c=color.match(/[\\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return c[0]*.2126+c[1]*.7152+c[2]*.0722},rgb=color=>{const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');canvas.width=canvas.height=1;ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return 'rgb('+[...ctx.getImageData(0,0,1,1).data].slice(0,3).join(',')+')'},background=luminance(rgb(getComputedStyle(document.querySelector('#modelMenu > .composer-popover')).backgroundColor));return ['composerPowerTitle','composerModelToggle'].every(id=>{const ink=luminance(rgb(getComputedStyle(document.getElementById(id)).color));return (Math.max(ink,background)+.05)/(Math.min(ink,background)+.05)>=4.5})})()`);
    await check('Effort layout '+[width,zoom,theme,language].join('/'), `(()=>{const p=document.querySelector('#modelMenu > .composer-popover'),r=p.getBoundingClientRect(),track=document.querySelector('.power-track'),s=track.getBoundingClientRect(),title=document.getElementById('composerPowerTitle'),model=document.getElementById('composerModelToggle');return document.documentElement.lang===window.__composerAppearanceCase.language&&document.documentElement.dataset.theme===window.__composerAppearanceCase.theme&&r.left>=0&&r.right<=innerWidth+.5&&r.top>=0&&r.bottom<=innerHeight&&p.scrollWidth<=p.clientWidth+1&&title.scrollWidth<=title.clientWidth+1&&model.scrollWidth<=model.clientWidth+1&&s.height>=28&&document.getElementById('composerModel').value===window.__composerSelection.model&&document.getElementById('composerReasoning').value===window.__composerSelection.effort})()`);
    if (zoom===1&&width===1440&&language==='en') await capture('effort-'+theme);
    if (zoom===1.25&&width===900&&theme==='dark'&&language==='pt-BR') await capture('effort-narrow-pt-BR');
  }
  await win.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId: appearanceWindow.objectId });
  win.webContents.debugger.detach();
  win.setContentSize(1440, 960); win.webContents.setZoomFactor(1);
  await js(`(async()=>{const language=document.getElementById('uiLanguage');language.value='en';language.dispatchEvent(new Event('change',{bubbles:true}));const {data}=await window.api.getState();await window.api.saveSettings({patch:{ui:{...data.config.ui,theme:'dark',language:'en'}}})})()`); await pause(150);
  await click('#composerModelToggle');
  await check('Model name opens the observed list without changing the selection', `!document.getElementById('composerModelChoices').hidden&&document.getElementById('composerModelToggle').getAttribute('aria-expanded')==='true'&&document.getElementById('composerModel').value==='gpt-6-sol'`);
  await check('Every account model is offered', `document.querySelectorAll('#composerModelChoices .model-choice:not([data-model=""])').length===5`);
  await check('Automatic leads the list, as a choice that switches nothing', `document.querySelector('#composerModelChoices .model-choice')?.dataset.model===''`);
  await click('[data-model="gpt-5.5"]');
  await check('Model click preserves open menu and exact identity', `document.getElementById('modelMenu').open&&document.getElementById('composerModel').value==='gpt-5.5'`);
  await js(`{const input=document.querySelector('#composerPowerChoices input');input.value='0';input.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await check('Effort changes only the selected model', `document.getElementById('composerModel').value==='gpt-5.5'&&document.getElementById('composerReasoning').value==='low'`);
  await check('Header names the chosen model and effort', `document.getElementById('composerPowerTitle').textContent==='Low'&&document.getElementById('composerPowerModel').textContent==='GPT-5.5'`);
  await capture('model');
  await js(`document.querySelector('[data-model="gpt-5.5"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await check('Escape closes list and returns to model name', `document.getElementById('modelMenu').open&&document.getElementById('composerModelChoices').hidden&&document.activeElement.id==='composerModelToggle'`);
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await check('Second Escape closes popover and returns to composer trigger', `!document.getElementById('modelMenu').open&&document.activeElement===document.querySelector('#modelMenu > summary')`);
  await click('#modelMenu > summary');
  await check('Reopening resets the model disclosure', `document.getElementById('composerModelChoices').hidden&&document.getElementById('composerModelToggle').getAttribute('aria-expanded')==='false'`);
  await js(`document.querySelector('#composerPowerChoices input').focus()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'}); await pause(200);
  await check('Native keyboard steps the slider without submitting', `document.getElementById('composerModel').value==='gpt-5.5'&&document.getElementById('composerReasoning').value==='medium'`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Home'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Home'}); await pause(200);
  await check('Native Home restores the first observed effort', `document.getElementById('composerReasoning').value==='low'`);
  await click('#chatInput');
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
  win.setContentSize(900, 960); await pause(250);
  await check('Narrow chat column with the right work panel keeps one action row', `(()=>{const nodes=['attachmentMenu','composerSettings','createPlan','contextMeter','modelMenu','chatSend'].map(id=>document.getElementById(id).getBoundingClientRect()),card=document.querySelector('.card.is-session').getBoundingClientRect();const centers=nodes.map(r=>r.top+r.height/2);return card.width<520&&nodes.every(r=>r.left>=card.left&&r.right<=card.right)&&nodes.every((r,i)=>nodes.every((s,j)=>i===j||r.right<=s.left+.5||s.right<=r.left+.5||r.bottom<=s.top+.5||s.bottom<=r.top+.5))&&Math.max(...centers)-Math.min(...centers)<1})()`);
  await check('Narrow work-dock column compacts labels by column width', `getComputedStyle(document.getElementById('composerModeLabel')).display==='none'&&getComputedStyle(document.querySelector('#createPlan > span')).display==='none'&&getComputedStyle(document.getElementById('contextMeterCompact')).display==='none'`);
  await capture('dock-900');
  await click('#rightDockToggle');
  for (const width of [1440, 900, 700, 640]) {
    win.setContentSize(width, 960); await pause(250);
    await click('#newChat'); await type('');
    const titleTop = await js(`document.getElementById('timelineEmpty').getBoundingClientRect().top`);
    await type(Array.from({length:12}, (_, i) => `Draft line ${i+1}`).join('\n'));
    await check('Welcome remains fixed while draft grows at '+width, `Math.abs(document.getElementById('timelineEmpty').getBoundingClientRect().top-${titleTop})<1`);
    await check('Toolbar fits at '+width, `(()=>{const nodes=['attachmentMenu','composerSettings','createPlan','contextMeter','modelMenu','chatSend'].map(id=>document.getElementById(id).getBoundingClientRect());return nodes.every(r=>r.left>=0&&r.right<=innerWidth)&&nodes.every((r,i)=>nodes.every((s,j)=>i===j||r.right<=s.left+.5||s.right<=r.left+.5||r.bottom<=s.top+.5||s.bottom<=r.top+.5))})()`);
    await check('Composer actions stay on one row at '+width, `(()=>{const centers=['attachmentMenu','composerSettings','createPlan','contextMeter','modelMenu','chatSend'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.top+r.height/2});return Math.max(...centers)-Math.min(...centers)<1})()`);
    if (width <= 700) await check('Narrow composer compacts labels instead of stacking at '+width, `getComputedStyle(document.getElementById('composerModeLabel')).display==='none'&&getComputedStyle(document.querySelector('#createPlan > span')).display==='none'&&getComputedStyle(document.getElementById('contextMeterCompact')).display==='none'`);
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
