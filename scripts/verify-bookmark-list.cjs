// Production renderer and real Chromium layout/input; synthetic conversations only (#1133).
// A chat with many bookmarks (#1719, up to 200): the header's list stays inside the window and
// scrolls, scrolling it keeps it open, and keyboard focus brings the item it moves to into view.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'bookmark-list'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 const old=window.api,f=composerFixture,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 f.summary.title='Plan the release';
 const marks=Array.from({length:200},(_,n)=>({messageId:'answer-'+n,excerpt:'Saved answer number '+(n+1)+': the plan, the decision and what came out of it.',messageTime:Date.now()-n*60000,at:Date.now()-n*1000}));
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:'dark'};return r;},
  listSessions:()=>ok({sessions:[{...f.summary,events:f.events.length}],activeId:null,pressure:[],blocked:[],trusted:[]}),
  listBookmarks:()=>ok(marks),
  locateMessage:()=>ok(null)
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'bookmark-list-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  const chatRow=`document.querySelector('#sessionList .sess[data-id]')`;
  await until(`!!${chatRow}`);
  win.show(); win.focus(); win.webContents.focus(); await pause(100);
  await js(`${chatRow}.click()`);
  await until(`!document.getElementById('chatBookmarks').hidden`); await settle();
  const menuBox=`(()=>{const m=document.querySelector('.row-menu');if(!m)return null;const r=m.getBoundingClientRect();return {top:r.top,bottom:r.bottom,innerHeight,scrollHeight:m.scrollHeight,clientHeight:m.clientHeight,items:m.querySelectorAll('[data-row-action="bookmark"]').length}})()`;
  const focusedVisible=`(()=>{const m=document.querySelector('.row-menu'),f=document.activeElement;if(!m||!m.contains(f))return 'focus not in menu';const a=m.getBoundingClientRect(),b=f.getBoundingClientRect();return b.top>=a.top-1&&b.bottom<=a.bottom+1?true:'item '+Math.round(b.top)+'..'+Math.round(b.bottom)+' outside menu '+Math.round(a.top)+'..'+Math.round(a.bottom)})()`;
  for (const height of [800, 520]) {
    win.setContentSize(1280, height); await pause(300);
    await js(`document.getElementById('chatBookmarks').click()`); await settle();
    const box=await js(menuBox);
    assert.ok(box,'The bookmark list opens');
    assert.equal(box.items,200,'Every bookmark is listed');
    assert.ok(box.top>=7.5&&box.bottom<=box.innerHeight-7.5,`The list stays inside the window at ${height}px: `+JSON.stringify(box));
    assert.ok(box.scrollHeight>box.clientHeight+50,'The list scrolls: '+JSON.stringify(box));
    await capture(`bookmarks-${height}.png`);
    // Scrolling the list itself keeps it open.
    await js(`(()=>{const m=document.querySelector('.row-menu');m.scrollTop=600;m.dispatchEvent(new Event('scroll'));})()`); await pause(150);
    assert.ok(await js(`!!document.querySelector('.row-menu')`),'Scrolling the list keeps it open');
    // The keyboard reaches the far end and back, with the focused item in view each time.
    for (const key of ['End', 'Home', 'ArrowUp', 'ArrowDown']) {
      await win.webContents.sendInputEvent({type:'keyDown',keyCode:key}); await win.webContents.sendInputEvent({type:'keyUp',keyCode:key}); await pause(120);
      assert.equal(await js(focusedVisible),true,`After ${key} the focused bookmark is in view`);
    }
    await js(`document.querySelector('.row-menu')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await settle();
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: a long bookmark list stays inside the window, scrolls, stays open while scrolled, and keeps the focused bookmark in view');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
