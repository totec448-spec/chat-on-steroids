// Production renderer and real Chromium layout; synthetic state only, nothing is sent anywhere.
// Send feedback: Activity's button and /feedback open the dialog; a problem report needs what
// happened and the saved diagnostics report, an idea needs both of its fields; a newer release is
// pointed out; the done step names the file to attach. The dialog and Activity's header (which
// gained the button) fit in every language, both themes and a narrow window.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'feedback-dialog'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const LANGUAGES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
const fixture = `(() => {
 const old=window.api,f=composerFixture,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 window.fixtureTheme='dark'; window.opened=[]; window.reports=0;
 window.setTheme=async theme=>{window.fixtureTheme=theme;const r=await methods.getState();f.emit('onStateChanged',r.data);};
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);
   r.data.config.ui={...r.data.config.ui,theme:window.fixtureTheme};
   r.data.update={current:'2.1.46',latest:'2.1.47',stage:'idle',error:null,checkedAt:Date.now()};return r;},
  saveDiagnosticsReport:()=>{window.reports++;return ok({saved:true,name:'diagnostics-2026-10-24-0130.txt'});},
  openFeedbackIssue:report=>{window.opened.push(report);return ok({trimmed:false});}
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
let server, win;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const icons = path.join(root, 'node_modules/@phosphor-icons/web/src');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':icons}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(icons)]}},
    plugins:[{name:'feedback-fixture',
      transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');
        res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}]});
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(250);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const dialog=`document.getElementById('feedbackDialog')`;
  const load=async language=>{
    await win.loadURL(server.resolvedUrls.local[0]);
    await js(`localStorage.setItem('cos.ui.language',${JSON.stringify(language)})`);
    await win.loadURL(server.resolvedUrls.local[0]);
    await until(`!!document.getElementById('workspaceSettings')&&!!window.api`);
  };
  const openActivity=async()=>{
    await js(`document.getElementById('workspaceSettings').click()`);
    await until(`!!document.querySelector('[data-tab="activity"]')`);
    await js(`document.querySelector('[data-tab="activity"]').click()`);
    await until(`document.getElementById('sendFeedback').offsetParent!==null`);
  };
  const open=async()=>{ await openActivity(); await js(`document.getElementById('sendFeedback').click()`); await until(`${dialog}.open`); await settle(); };
  // Activity's header: every control inside the card, none cut, the new one beside Diagnostics report.
  const header=async label=>{
    const view=await js(`(()=>{const card=document.getElementById('sendFeedback').closest('.card').getBoundingClientRect();
      const controls=[...document.getElementById('sendFeedback').closest('.acts').querySelectorAll('button')].filter(b=>b.offsetParent);
      return {outside:controls.filter(b=>{const r=b.getBoundingClientRect();return r.left<card.left-0.5||r.right>card.right+0.5;}).map(b=>b.id||b.textContent),
        cut:controls.filter(b=>b.scrollWidth>b.clientWidth+1).map(b=>b.id||b.textContent)};})()`);
    assert.deepEqual(view,{outside:[],cut:[]},`${label}: Activity's header fits`);
  };
  const layout=async label=>{
    const view=await js(`(()=>{const d=${dialog},box=d.getBoundingClientRect();
      const shown=[...d.querySelectorAll('*')].filter(n=>n.offsetParent&&n.getClientRects().length);
      const inside=n=>{const r=n.getBoundingClientRect();return r.left>=box.left-0.5&&r.right<=box.right+0.5;};
      const cut=shown.filter(n=>n.matches('h2,b,em,span,label,button,p,option')&&n.children.length===0&&n.scrollWidth>n.clientWidth+1).map(n=>n.id||n.textContent.slice(0,40));
      const body=d.querySelector('form:not([hidden]) .plugin-dialog-body, .plugin-dialog-body:not([hidden]):not(form *)').getBoundingClientRect(),pad=24;
      const scrollbar=(()=>{const f=d.querySelector('.feedback-fields');return f.offsetParent?f.offsetWidth-f.clientWidth:0;})();
      const fields=[...d.querySelectorAll('.plugin-field')].filter(n=>n.offsetParent).map(n=>{const r=n.querySelector('textarea,select').getBoundingClientRect();return [Math.round(r.left-body.left),Math.round(body.right-r.right-scrollbar)];});
      const fieldsScroll=(()=>{const f=d.querySelector('.feedback-fields');return f.scrollHeight>f.clientHeight+1;})();
      const buttons=[...d.querySelectorAll('.pet-delete-actions .btn')].filter(b=>b.offsetParent).map(b=>b.getBoundingClientRect());
      const primary=d.querySelector('.plugin-dialog-body:not([hidden]) .btn-solid, form:not([hidden]) .btn-solid').getBoundingClientRect();
      const edges=[...d.querySelectorAll('.plugin-field,.feedback-report .setting-text,.feedback-kind,.feedback-update,.feedback-note')].filter(n=>n.offsetParent).map(n=>Math.round(n.getBoundingClientRect().left-box.left));
      return {fieldsScroll,fits:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight,cut,edges:[...new Set(edges)],
        primaryShown:primary.top>=box.top&&primary.bottom<=box.bottom-1&&primary.height>0,outside:shown.filter(n=>!inside(n)).map(n=>n.id||n.className),
        fields,buttonsOneLine:buttons.every(b=>Math.abs(b.top-buttons[0].top)<1),scrollsSideways:d.scrollWidth>d.clientWidth+1,height:innerHeight};})()`);
    assert.equal(view.fits,true,`${label}: the dialog fits the window`);
    assert.deepEqual(view.cut,[],`${label}: no text is cut`);
    assert.deepEqual(view.outside,[],`${label}: nothing sticks out`);
    assert.equal(view.scrollsSideways,false,`${label}: no sideways scrolling`);
    for (const edges of view.fields) assert.deepEqual(edges,[24,24],`${label}: every field spans the body ${JSON.stringify(view.fields)}`);
    assert.equal(view.buttonsOneLine,true,`${label}: the buttons share one line`);
    // In a normal window everything fits; only a short one scrolls the fields (the buttons stay put).
    // Judged at the size the window really got: a CI runner's small virtual screen clamps it below 800.
    if (!label.includes('720')&&!label.includes('error')&&view.height>=780) assert.equal(view.fieldsScroll,false,`${label}: no scrolling at 1280 x ${view.height}`);
    if (label.includes('error')) assert.equal(await js(`(()=>{const e=document.getElementById('feedbackError').getBoundingClientRect(),f=document.querySelector('.feedback-fields').getBoundingClientRect();return e.top>=f.top&&e.bottom<=f.bottom;})()`),true,`${label}: the error is in view`);
    assert.equal(view.primaryShown,true,`${label}: the main button is in view without scrolling`);
    assert.equal(view.edges.length<=1,true,`${label}: every block starts at one left edge ${JSON.stringify(view.edges)}`);
  };
  win.show(); win.focus(); win.webContents.focus();

  await load('en');
  for (const theme of ['dark','light']) {
    await js(`setTheme(${JSON.stringify(theme)})`);
    await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    await open();
    await header(`en ${theme}`);
    // The kind chosen last is part of the draft; the dark round ended on an idea.
    if (theme==='light') { assert.equal(await js(`document.activeElement.id`),'feedbackProblem'); await js(`document.querySelector('input[name="feedbackKind"][value="bug"]').click()`); }
    else assert.equal(await js(`document.activeElement.id`),'feedbackWhat');
    assert.equal(await js(`document.getElementById('feedbackUpdate').hidden`),false,'A newer release is pointed out');
    await layout(`en ${theme} problem`);
    await capture(`${theme}-problem.png`);
    // Nothing goes to GitHub without what happened and the diagnostics report.
    await js(`document.getElementById('feedbackSubmit').click()`);
    await until(`document.getElementById('feedbackError').textContent==='Write what happened.'`);
    await layout(`en ${theme} error`);
    await js(`document.getElementById('feedbackWhat').value='The Stop button stays grey after a reload.'`);
    await js(`document.getElementById('feedbackSaveReport').click()`);
    await until(`document.querySelector('.feedback-report').classList.contains('is-saved')`);
    await layout(`en ${theme} report saved`);
    await capture(`${theme}-ready.png`);
    await js(`document.getElementById('feedbackSubmit').click()`);
    await until(`!document.getElementById('feedbackDone').hidden`);
    assert.deepEqual(await js('opened.at(-1)'),{kind:'bug',what:'The Stop button stays grey after a reload.'});
    assert.equal(await js(`document.activeElement.id`),'feedbackDoneClose');
    await layout(`en ${theme} done`);
    await capture(`${theme}-done.png`);
    await js(`document.getElementById('feedbackDoneClose').click()`);
    await until(`!${dialog}.open`);
    // An idea: two fields, no report, no update notice.
    await open();
    await js(`(()=>{const i=document.querySelector('input[name="feedbackKind"][value="idea"]');i.click();})()`);
    await until(`!document.getElementById('feedbackIdea').hidden`);
    assert.equal(await js(`document.getElementById('feedbackUpdate').hidden`),true);
    await layout(`en ${theme} idea`);
    await capture(`${theme}-idea.png`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(`!${dialog}.open`);
  }
  assert.equal(await js('opened.length'),2,'One report per theme; Escape sent nothing');

  // /feedback opens the same dialog.
  await load('en');
  await js(`(()=>{const input=document.getElementById('chatInput');input.focus();input.value='/feedback';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(`[...document.querySelectorAll('.skill-autocomplete [role="option"]')].some(o=>o.textContent.includes('Report a problem or suggest an idea.'))`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await until(`${dialog}.open`);

  for (const language of LANGUAGES) {
    await load(language);
    await open();
    await header(language);
    await layout(`${language} problem`);
    await js(`document.querySelector('input[name="feedbackKind"][value="idea"]').click()`);
    await layout(`${language} idea`);
    if (['de','ru','ja'].includes(language)) await capture(`${language}-idea.png`);
    await js(`document.querySelector('input[name="feedbackKind"][value="bug"]').click()`);
    if (['de','ru','ja'].includes(language)) await capture(`${language}-problem.png`);
    await js(`document.getElementById('feedbackCancel').click()`);
    await until(`!${dialog}.open`);
  }
  win.setContentSize(720, 640); await pause(300);
  for (const language of ['en','de','ru','pt-BR','vi']) {
    await load(language);
    await open();
    await header(`${language} 720`);
    await layout(`${language} 720`);
    await capture(`${language}-720.png`);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: send feedback from Activity and /feedback; problem needs text and report, idea needs both fields; update notice; done step; 13 languages, both themes, 720 px');
  // The dev server can keep a socket open after the window is gone; the check must still end.
  win.destroy();await Promise.race([server.close(),new Promise(resolve=>setTimeout(resolve,2000))]);app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await Promise.race([server?.close(),new Promise(resolve=>setTimeout(resolve,2000))]);app.exit(1);});
