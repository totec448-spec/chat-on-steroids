// Production renderer and real Chromium layout/input; synthetic conversations only (#1133).
// Pinned chats: Pin moves a chat to the top of its list with a visible mark, pins keep their own order,
// survive a reload (local preference), and Unpin returns the chat to its place.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'chat-pin'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
// Pins are a saved preference: every run starts from an empty profile.
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
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
    plugins:[{name:'chat-pin-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const order=()=>js(`[...document.querySelectorAll('#sessionList .sess[data-id]')].filter(r=>!r.closest('.worker-group')).map(r=>r.dataset.id)`);
  const row=id=>`document.querySelector('#sessionList .sess[data-id="${id}"]')`;
  // Pin is the first item of the row's menu (its "⋯" button, or a right click on the row).
  const openMenu=async id=>{await js(`document.querySelector('.row-menu')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await js(`${row(id)}.querySelector('.row-menu-button').click()`);await until(`!!document.querySelector('.row-menu [data-row-action="pin"]')`);};
  const closeMenu=()=>js(`document.querySelector('.row-menu')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  const pinLabel=async id=>{await openMenu(id);const label=await js(`document.querySelector('.row-menu [data-row-action="pin"]').textContent`);await closeMenu();return label;};
  const pin=async id=>{await openMenu(id);await js(`document.querySelector('.row-menu [data-row-action="pin"]').click()`);await settle();};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!${row('other-chat-3')}?.querySelector('.row-menu-button')`);
  win.show(); win.focus(); win.webContents.focus(); await pause(100);
  const before=await order();
  assert.equal(before.length,4,'Four chats: '+JSON.stringify(before));
  assert.equal(await pinLabel('other-chat-3'),'Pin chat');
  await openMenu('other-chat-3');
  await capture('before-pin.png');
  await closeMenu();
  await js(`document.activeElement.blur()`);

  // Pinning the last chat moves it to the top of its list, with a mark that stays visible.
  await pin('other-chat-3');
  assert.deepEqual(await order(),['other-chat-3',...before.filter(id=>id!=='other-chat-3')]);
  assert.equal(await js(`${row('other-chat-3')}.classList.contains('is-pinned')`),true);
  assert.equal(await js(`document.activeElement===${row('other-chat-3')}.querySelector('.row-menu-button')`),true,'Focus stays on the same chat\'s menu button');
  assert.equal(await pinLabel('other-chat-3'),'Unpin chat');
  // The mark shows when the row is at rest (not hovered or focused).
  await js(`document.activeElement.blur()`); await win.webContents.sendInputEvent({type:'mouseMove',x:900,y:400}); await settle();
  assert.notEqual(await js(`getComputedStyle(${row('other-chat-3')}.querySelector('.sess-pin-mark')).display`),'none','The pin mark is visible at rest');
  assert.equal(await js(`!!${row('other-chat-2')}.querySelector('.sess-pin-mark')`),false,'Unpinned chats have no mark');
  // Both glyphs are in the bundled icon font, not blank boxes.
  const glyph=selector=>js(`getComputedStyle(${row('other-chat-3')}.querySelector('${selector}'),'::before').content`);
  assert.match(await glyph('.sess-pin-mark'),/^"\S"$/u,'A drawn glyph: the pin mark');
  await openMenu('other-chat-3');
  assert.match(await js(`getComputedStyle(document.querySelector('.row-menu [data-row-action="pin"]').querySelector('i'),'::before').content`),/^"\S"$/u,'A drawn glyph: the Unpin item');
  await closeMenu();

  // A second pin joins the pinned group; activity repaints keep both on top.
  await pin('other-chat-1');
  const pinnedTwo=await order();
  assert.deepEqual(pinnedTwo.slice(0,2).sort(),['other-chat-1','other-chat-3']);
  assert.deepEqual(pinnedTwo.slice(2),before.filter(id=>!['other-chat-1','other-chat-3'].includes(id)));
  await js('repaint()'); await settle();
  assert.deepEqual(await order(),pinnedTwo,'A repaint keeps the pinned order');
  for (const theme of ['dark','light']) {
    await js(`setTheme(${JSON.stringify(theme)})`);
    await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    await win.webContents.sendInputEvent({type:'mouseMove',x:900,y:400});
    await capture(`${theme}-pinned.png`);
    await openMenu('other-chat-3'); await settle();
    // Opened without the pointer on the row, the menu still opens beside its button.
    const place=await js(`(()=>{const b=${row('other-chat-3')}.querySelector('.row-menu-button').getBoundingClientRect(),m=document.querySelector('.row-menu').getBoundingClientRect();return {below:Math.abs(m.top-b.bottom-4)<=2,above:Math.abs(b.top-m.bottom-4)<=2,near:Math.abs(m.left-b.left)<=m.width}})()`);
    assert.ok((place.below||place.above)&&place.near,'The menu opens beside its button: '+JSON.stringify(place));
    assert.equal(await js(`getComputedStyle(${row('other-chat-3')}.querySelector('.sess-actions')).display`),'flex');
    await capture(`${theme}-pinned-actions.png`);
    await closeMenu();
  }

  // A local preference: it survives reloading the window.
  await win.webContents.reload();
  await until(`!!${row('other-chat-3')}?.querySelector('.row-menu-button')`); await settle();
  assert.deepEqual(await order(),pinnedTwo,'Pins survive a reload');

  // Unpinning returns each chat to its place in the list.
  await pin('other-chat-3'); await pin('other-chat-1');
  assert.deepEqual(await order(),before,'Unpinned chats go back to their places');
  assert.equal(await js(`document.querySelectorAll('#sessionList .is-pinned').length`),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: pinned chats lead their list with a visible mark, keep order across repaints and reload, and unpin back into place');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
