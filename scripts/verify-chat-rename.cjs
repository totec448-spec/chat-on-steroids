// Production renderer and real Chromium layout/input; synthetic conversations only (#1107).
// Naming a chat in the sidebar: the field takes the row (the hover actions step aside), survives the
// sidebar's activity repaints as the same node, and Enter, Escape and an empty name do what they say.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'chat-rename'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 const old=window.api,f=composerFixture,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 f.summary.title='Write a haiku about snow. Do not use any tools.';
 f.summary.updatedAt=Date.now()-3*3600000; f.summary.lastToolCallAt=null; f.summary.activityExpiresAt=null;
 const others=[1,2,3].map(n=>({...f.summary,id:'other-chat-'+n,title:['Fix the flaky bridge test','Plan the release notes','Review the dashboard layout'][n-1],
  conversationId:'other-conversation-'+n,chatIds:['other-conversation-'+n],updatedAt:f.summary.updatedAt-n*60000}));
 window.renames=[];
 window.fixtureTheme='dark';
 window.setTheme=async theme=>{window.fixtureTheme=theme;const r=await methods.getState();f.emit('onStateChanged',r.data);};
 window.repaint=()=>{f.summary.updatedAt++;f.emit('onSessionChanged',{allTranscripts:true});};
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:window.fixtureTheme};return r;},
  listSessions:()=>ok({sessions:[{...f.summary,events:f.events.length},...others],activeId:null,pressure:[],blocked:[],trusted:[]}),
  renameSession:(id,title)=>{window.renames.push([id,title]);const row=id===f.summary.id?f.summary:others.find(o=>o.id===id);
   if(row){if(title){row.autoTitle=row.autoTitle||{title:row.title,source:'fallback'};row.title=title;row.titleSource='manual';}
   else if(row.autoTitle){row.title=row.autoTitle.title;delete row.autoTitle;row.titleSource='fallback';}}
   return ok(true);}
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'chat-rename-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const row=`document.querySelector('#sessionList [data-id="other-chat-1"]')`;
  const field=`document.querySelector('.sess-rename')`;
  const key=async name=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:name});win.webContents.sendInputEvent({type:'keyUp',keyCode:name});await pause(120);};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!${row}?.querySelector('button.sess-name')`);
  win.show(); win.focus(); win.webContents.focus(); await pause(100);

  for (const theme of ['dark','light']) {
    await js(`setTheme(${JSON.stringify(theme)})`);
    await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    // The pencil sits among the row's hover actions.
    await js(`${row}.querySelector('.sess-top').focus()`);
    await settle();
    assert.equal(await js(`getComputedStyle(${row}.querySelector('.sess-actions')).display`),'flex');
    await capture(`${theme}-actions.png`);
    await js(`${row}.querySelector('button.sess-name').click()`);
    await until(`!!${field}`);
    await settle();
    // The field takes the row: the actions step aside instead of squeezing it.
    assert.equal(await js(`getComputedStyle(${row}.querySelector('.sess-actions')).display`),'none','Actions hide while naming');
    const widths=await js(`({field:${field}.getBoundingClientRect().width,row:${row}.getBoundingClientRect().width})`);
    assert.ok(widths.field>=widths.row*0.8,'The field spans the row: '+JSON.stringify(widths));
    assert.equal(await js(`document.activeElement===${field}`),true,'The field has focus');
    assert.equal(await js(`${field}.value`),'Fix the flaky bridge test');
    assert.deepEqual(await js(`[${field}.selectionStart,${field}.selectionEnd]`),[0,25],'The whole old name is selected');
    await capture(`${theme}-editing.png`);
    await key('Escape');
    await until(`!${field}`);
    assert.equal(await js(`${row}.querySelector('.sess-top b').textContent`),'Fix the flaky bridge test');
  }
  assert.deepEqual(await js('renames'),[],'Escape saves nothing');

  // Real typing while the sidebar repaints: the same node, its text and its caret survive.
  await js(`${row}.querySelector('.sess-top b').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await until(`!!${field}`);
  const editing=await js(`(window.editingField=${field}, true)`);
  assert.equal(editing,true);
  await js(`${field}.select()`);
  win.webContents.insertText('Bridge');
  await js('repaint()'); await pause(150);
  win.webContents.insertText(' work');
  await js('repaint()'); await pause(150);
  assert.equal(await js(`${field}===window.editingField`),true,'Repaints keep the same field');
  assert.equal(await js(`${field}.value`),'Bridge work');
  await key('Enter');
  await until(`renames.length===1`);
  assert.deepEqual(await js('renames[0]'),['other-chat-1','Bridge work']);
  await until(`${row}.querySelector('.sess-top b')?.textContent==='Bridge work'`);
  await capture('renamed.png');

  // An empty name hands the title back to ChatGPT's.
  await js(`${row}.querySelector('button.sess-name').click()`);
  await until(`!!${field}`);
  await js(`${field}.select()`);
  await key('Backspace');
  await key('Enter');
  await until(`renames.length===2`);
  assert.deepEqual(await js('renames[1]'),['other-chat-1',null]);
  await until(`${row}.querySelector('.sess-top b')?.textContent==='Fix the flaky bridge test'`);
  assert.deepEqual(errors,[]);
  console.log('PASS: chat naming field layout in both themes, Escape, repaints during typing, Enter and clearing');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
