// Production renderer and real Chromium layout; a synthetic conversation only.
// Share as web page: the chat menu opens the dialog, the page is previewed in a frame that runs
// nothing (under the app's own content policy, so a refused frame would fail here), "Hide personal
// details" says how many it hid, and the dialog fits in every language, both themes and a narrow
// window. Save hands over the previewed page's id; Escape and Cancel close without saving.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'share-page'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const LANGUAGES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
// The window's own policy, as main sets it (a meta tag cannot carry frame-ancestors).
const policy = /RENDERER_CONTENT_SECURITY_POLICY =\s*([\s\S]*?);\n/.exec(fs.readFileSync(path.join(root, 'src/main/renderer-csp.ts'), 'utf8'))[1]
  .split('+').map(part => part.trim().replace(/^"|"$/g, '')).join('').replace(/;\s*frame-ancestors 'none'/, '');
// Vite's /@fs/ prefix takes an absolute path; a Windows one (C:/...) has no leading slash of its own.
const fsPath = file => '/@fs/' + path.join(root, file).split(path.sep).join('/').replace(/^\/+/, '');
const fixture = `(() => {
 const old=window.api,f=composerFixture,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 f.summary.updatedAt=Date.now()-3*3600000; f.summary.lastToolCallAt=null; f.summary.activityExpiresAt=null;
 const chat={...f.summary,id:'share-chat-1',title:'Why does the shop build fail?',conversationId:'share-conversation-1',chatIds:['share-conversation-1'],updatedAt:f.summary.updatedAt-60000};
 const messages=[
  {role:'user',text:'The shop build fails on my laptop. The log is in /Users/ana/projects/shop/build.log, can you check it? The registry token is sk-proj-AbCdEfGhIjKlMnOpQrStUvWx12.'},
  {role:'assistant',text:'## What failed\\n\\nThe build stops at **step 3**, when it installs packages:\\n\\n- the lock file names \`sharp 0.34\`\\n- the cache still holds \`0.33\`\\n\\n\`\`\`sh\\nrm -rf node_modules/.cache\\nnpm ci\\n\`\`\`\\n\\nIf it still fails, send the new log to ana@example.com. The [npm docs](https://docs.npmjs.com/cli/commands/npm-ci) explain \`npm ci\`.'},
  {role:'user',text:'That worked, thanks!'},
  {role:'assistant',text:'Glad it works. The cache can go stale again after a major update, so the same two commands are the first thing to try.'}
 ];
 window.fixtureTheme='dark'; window.shares=[];
 window.setTheme=async theme=>{window.fixtureTheme=theme;const r=await methods.getState();f.emit('onStateChanged',r.data);};
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,theme:window.fixtureTheme};return r;},
  listSessions:()=>ok({sessions:[{...f.summary,events:f.events.length},chat],activeId:null,pressure:[],blocked:[],trusted:[]}),
  sharePage:async request=>{
   window.shares.push(request);
   if(request.target==='file')return ok({done:'saved',name:'Why does the shop build fail.html'});
   // The page as main builds it (page-export.ts): the same builder and redaction, labelled through the
   // window's own catalog, which is what main's published translations come from.
   const {transcriptHtml,hiddenCount}=await import(${JSON.stringify(fsPath('src/shared/html-export.ts'))});
   const {redactSecretText,redactPersonalText}=await import(${JSON.stringify(fsPath('src/main/redaction.ts'))});
   const {t}=await import('/i18n.ts');
   const hide=text=>request.hide?redactPersonalText(redactSecretText(text)):redactSecretText(text);
   const html=transcriptHtml(hide(chat.title),messages.map(m=>({role:m.role,text:hide(m.text)})),{user:t('You'),assistant:'ChatGPT'},
    {lang:request.lang,date:new Intl.DateTimeFormat(request.lang,{dateStyle:'long'}).format(new Date(Date.UTC(2026,9,24,12))),
     footer:t('Shared from Chat On Steroids'),hidden:t('hidden')});
   return ok({done:'preview',preview:'00000000-0000-4000-8000-00000000000'+window.shares.length%10,html,hidden:hiddenCount(html)});
  }
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
    plugins:[{name:'share-page-fixture',
      transformIndexHtml:html=>html.replace('</head>',`<meta http-equiv="Content-Security-Policy" content="${policy}"><script src="/timeline-fixture.js"></script></head>`),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');
        res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}]});
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression+' '+JSON.stringify({error:await js(`document.getElementById('sharePageError')?.textContent||''`),errors}));};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(250);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const row=`document.querySelector('#sessionList [data-id="share-chat-1"]')`;
  const dialog=`document.getElementById('sharePageDialog')`;
  const shown=`(${dialog}.open&&document.getElementById('sharePageLoading').hidden&&!document.getElementById('sharePageSave').disabled)`;
  const load=async language=>{
    await win.loadURL(server.resolvedUrls.local[0]);
    await js(`localStorage.setItem('cos.ui.language',${JSON.stringify(language)})`);
    await win.loadURL(server.resolvedUrls.local[0]);
    await until(`!!${row}?.querySelector('.row-menu-button')`);
  };
  const openShare=async()=>{
    await js(`${row}.querySelector('.row-menu-button').click()`);
    await until(`!!document.querySelector('.row-menu [data-row-action="share"]')`);
    await js(`document.querySelector('.row-menu [data-row-action="share"]').click()`);
    await until(shown);
  };
  // Everything in the dialog stays inside it and is shown whole: nothing cut, nothing overflowing.
  const layout=async label=>{
    const view=await js(`(()=>{const d=${dialog},box=d.getBoundingClientRect(),body=document.getElementById('sharePageForm').getBoundingClientRect();
      const inside=n=>{const r=n.getBoundingClientRect();return r.left>=box.left-0.5&&r.right<=box.right+0.5;};
      const cut=[...d.querySelectorAll('h2,.setting-text b,.setting-text em,.pet-delete-actions .btn,p')].filter(n=>n.offsetParent&&(n.scrollWidth>n.clientWidth+1||n.scrollHeight>n.clientHeight+1)).map(n=>n.textContent);
      const preview=document.getElementById('sharePagePreview').getBoundingClientRect(),setting=d.querySelector('.share-page-hide .setting-text').getBoundingClientRect(),toggle=d.querySelector('#sharePageHide').getBoundingClientRect();
      const pad=parseFloat(getComputedStyle(document.getElementById('sharePageForm')).paddingLeft);
      const buttons=[...d.querySelectorAll('.pet-delete-actions .btn')].map(b=>b.getBoundingClientRect());
      const scrolls=[d,document.getElementById('sharePageForm')].filter(n=>n.scrollHeight>n.clientHeight+1).map(n=>n.id||n.className);
      return {fits:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight,cut,scrolls,
        outside:[...d.querySelectorAll('*')].filter(n=>n.offsetParent&&!inside(n)).map(n=>n.id||n.className),
        previewLeft:preview.left-body.left,previewRight:body.right-preview.right,settingLeft:setting.left-body.left,toggleRight:body.right-toggle.right,pad,previewHeight:preview.height,
        buttonsOneLine:buttons.every(b=>Math.abs(b.top-buttons[0].top)<1),buttonsRight:Math.round(box.right-buttons[buttons.length-1].right),
        frame:document.getElementById('sharePageFrame').getBoundingClientRect().height};})()`);
    assert.equal(view.fits,true,`${label}: the dialog fits the window`);
    assert.deepEqual(view.cut,[],`${label}: no text is cut`);
    assert.deepEqual(view.scrolls,[],`${label}: the preview gives way, so the dialog needs no scroll bar`);
    assert.deepEqual(view.outside,[],`${label}: nothing sticks out of the dialog`);
    // The preview and the switch row share the body's left edge; the preview spans the body.
    assert.ok(Math.abs(view.previewLeft-view.pad)<1&&Math.abs(view.previewRight-view.pad)<1,`${label}: preview spans the body ${JSON.stringify(view)}`);
    assert.ok(Math.abs(view.settingLeft-view.pad)<1&&Math.abs(view.toggleRight-view.pad)<1,`${label}: switch row text and switch on the preview's edges ${JSON.stringify(view)}`);
    assert.ok(view.previewHeight>=160&&Math.abs(view.frame-(view.previewHeight-2))<1,`${label}: the frame fills the preview ${JSON.stringify(view)}`);
    assert.equal(view.buttonsOneLine,true,`${label}: Cancel and Save on one line`);
    assert.equal(view.buttonsRight,25,`${label}: buttons keep the dialog's right padding`);
  };
  win.show(); win.focus(); win.webContents.focus();

  // English, both themes: the menu item, the preview, then hiding.
  await load('en');
  for (const theme of ['dark','light']) {
    await js(`setTheme(${JSON.stringify(theme)})`);
    await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    await js(`${row}.querySelector('.row-menu-button').click()`);
    await until(`!!document.querySelector('.row-menu [data-row-action="share"]')`);
    assert.equal(await js(`document.querySelector('.row-menu [data-row-action="share"]').textContent.trim()`),'Share as web page');
    await capture(`${theme}-menu.png`);
    await js(`document.querySelector('.row-menu [data-row-action="share"]').click()`);
    await until(shown);
    assert.deepEqual(await js('shares.at(-1)'),{id:'share-chat-1',target:'preview',hide:true,lang:'en'});
    assert.equal(await js(`document.getElementById('sharePageFrame').getAttribute('sandbox')`),'');
    assert.equal(await js(`document.getElementById('sharePageHide').checked`),true,'Addresses and user names start hidden');
    assert.equal(await js(`document.getElementById('sharePageCount').textContent`),'3 details are hidden on this page.');
    await layout(`en ${theme} hidden`);
    await capture(`${theme}-hidden.png`);
    await js(`(()=>{const h=document.getElementById('sharePageHide');h.click();})()`);
    await until(`document.getElementById('sharePageCount').textContent==='1 detail is hidden on this page.'`);
    await until(shown);
    assert.equal(await js('shares.at(-1).hide'),false,'Shown only when chosen; the key stays hidden');
    await layout(`en ${theme} shown`);
    await capture(`${theme}-preview.png`);
    // Escape closes and saves nothing.
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(`!${dialog}.open`);
    assert.equal(await js(`shares.filter(s=>s.target==='file').length`),0);
  }

  // Save hands over the previewed page, closes and says where it went.
  await openShare();
  const previewId=await js(`shares.length`);
  await js(`document.getElementById('sharePageSave').click()`);
  await until(`!${dialog}.open`);
  assert.deepEqual(await js('shares.at(-1)'),{id:'share-chat-1',target:'file',preview:'00000000-0000-4000-8000-00000000000'+previewId%10});
  await until(`[...document.querySelectorAll('.toast')].some(n=>n.textContent.includes('Saved Why does the shop build fail.html'))`);

  // Every language at full width, and the longest ones in a narrow window.
  for (const language of LANGUAGES) {
    await load(language);
    await openShare();
    await layout(language);
    if (['en','de','ru','ja'].includes(language)) await capture(`${language}-1280.png`);
    await js(`document.getElementById('sharePageCancel').click()`);
    await until(`!${dialog}.open`);
  }
  win.setContentSize(720, 640); await pause(300);
  for (const language of ['en','de','ru','pt-BR','vi']) {
    await load(language);
    await openShare();
    await layout(`${language} 720`);
    await capture(`${language}-720.png`);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: share as web page from the chat menu, sandboxed preview under the app policy, hiding, save, Escape; 13 languages, both themes, 720 px');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
