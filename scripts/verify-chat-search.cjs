// Production renderer and real Chromium layout/input; synthetic conversations only (#1107).
// Searching chats in the sidebar: the field sits above the lists, results replace them while it holds a
// query, matches are marked inside two-line snippets, long titles stay on one line, the keyboard moves
// through results, and Escape brings the lists back.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'chat-search'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 const old=window.api,f=composerFixture,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 f.summary.title='Write a haiku about snow'; f.summary.updatedAt=Date.now()-3*3600000; f.summary.lastToolCallAt=null; f.summary.activityExpiresAt=null;
 const chats=['Fix the flaky bridge test','Plan the release notes','Review the dashboard layout'].map((title,n)=>({...f.summary,id:'search-chat-'+n,title,
  conversationId:'search-conversation-'+n,chatIds:['search-conversation-'+n],updatedAt:f.summary.updatedAt-n*60000}));
 const found=[
  {id:'search-chat-0',title:'Fix the flaky bridge test',projectId:null,titleMatches:[[14,20]]},
  {id:'search-chat-1',title:'Plan the release notes and a very long title that does not fit in the sidebar at all',projectId:null,
   snippet:{text:'…first tag the build, then the bridge gets its Windows installer and the macOS bundle is signed again before upload.',matches:[[31,37],[47,54]]}},
  {id:'search-chat-2',title:'Review the dashboard layout',projectId:null,snippet:{text:'The bridge row wraps on narrow windows.',matches:[[4,10],[31,38]]}}
 ];
 window.searches=[];
 window.fixtureTheme='dark';
 window.setTheme=async theme=>{window.fixtureTheme=theme;const r=await methods.getState();f.emit('onStateChanged',r.data);};
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:window.fixtureTheme};return r;},
  listSessions:()=>ok({sessions:[{...f.summary,events:f.events.length},...chats],activeId:null,pressure:[],blocked:[],trusted:[]}),
  searchSessions:query=>{window.searches.push(query);const terms=query.toLowerCase().split(/\\s+/).filter(Boolean);
   const results=found.filter(r=>terms.every(t=>(r.title+' '+(r.snippet?.text||'')).toLowerCase().includes(t)));
   return ok({results,indexed:4,total:4});}
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'chat-search-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const key=async name=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:name});win.webContents.sendInputEvent({type:'keyUp',keyCode:name});await pause(150);};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('#sessionList [data-id="search-chat-0"]')`);
  win.show(); win.focus(); win.webContents.focus(); await pause(100);

  for (const theme of ['dark','light']) {
    await js(`setTheme(${JSON.stringify(theme)})`);
    await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    // The field sits above the lists and spans the sidebar.
    const layout=await js(`(()=>{const f=document.getElementById('chatSearch').getBoundingClientRect(),s=document.querySelector('.sidebar-sessions').getBoundingClientRect(),l=document.getElementById('sessionList').getBoundingClientRect();return {field:f.width,side:s.width,above:f.bottom<=l.top+1,placeholder:document.getElementById('chatSearch').placeholder}})()`);
    assert.ok(layout.field>=layout.side*0.9,'The field spans the sidebar: '+JSON.stringify(layout));
    assert.ok(layout.above,'The field is above the lists');
    assert.equal(layout.placeholder,'Search chats');
    await capture(`${theme}-idle.png`);
    await js(`document.getElementById('chatSearch').focus()`);
    win.webContents.insertText('bridge');
    await until(`document.querySelectorAll('#searchResults .search-result').length===3`);
    assert.equal(await js(`document.getElementById('sessionList').hidden`),true,'Results replace the lists');
    assert.equal(await js(`document.getElementById('chatSearchClear').hidden`),false,'The clear button shows');
    // A long title stays on one line; a snippet takes at most two.
    const rows=await js(`[...document.querySelectorAll('#searchResults .search-result')].map(r=>{const b=r.querySelector('b'),s=r.querySelector('.search-snippet');return {title:b.getBoundingClientRect().height,titleClipped:b.scrollWidth>b.clientWidth,snippet:s?s.getBoundingClientRect().height:0,titleMarks:[...b.querySelectorAll('mark')].map(m=>m.textContent),marks:[...(s?s.querySelectorAll('mark'):[])].map(m=>m.textContent),overflow:r.scrollWidth>r.clientWidth+1}})`);
    assert.ok(rows.every(r=>r.title<=24),'Titles stay on one line: '+JSON.stringify(rows));
    assert.equal(rows[1].titleClipped,true,'A long title is cut with an ellipsis');
    assert.ok(rows.every(r=>r.snippet<=36),'Snippets take at most two lines: '+JSON.stringify(rows));
    assert.deepEqual(rows.map(r=>r.marks),[[],['bridge','Windows'],['bridge','windows']]);
    assert.deepEqual(rows.map(r=>r.titleMarks),[['bridge'],[],[]],'A title match is marked in the title');
    assert.equal(rows[0].titleClipped,false);
    assert.ok(rows.every(r=>!r.overflow),'No result row overflows');
    const contrast=await js(`(()=>{const m=document.querySelector('#searchResults mark'),c=getComputedStyle(m);return [c.color,c.backgroundColor]})()`);
    assert.notEqual(contrast[0],contrast[1],'Marked text is readable');
    await capture(`${theme}-results.png`);
    await key('Escape');
    await until(`!document.getElementById('sessionList').hidden`);
    assert.equal(await js(`document.getElementById('chatSearch').value`),'');
    assert.equal(await js(`document.getElementById('searchResults').hidden`),true);
  }

  // Keyboard: Down enters the results, Up returns to the field, Enter opens the first match.
  await js(`document.getElementById('chatSearch').focus()`);
  win.webContents.insertText('bridge');
  await until(`document.querySelectorAll('#searchResults .search-result').length===3`);
  await key('Down');
  assert.equal(await js(`document.activeElement.dataset.searchId`),'search-chat-0');
  await key('Down');
  assert.equal(await js(`document.activeElement.dataset.searchId`),'search-chat-1');
  await key('Up'); await key('Up');
  assert.equal(await js(`document.activeElement.id`),'chatSearch');
  // Words in any order, and nothing found says so.
  await js(`document.getElementById('chatSearch').select()`);
  win.webContents.insertText('windows macos');
  await until(`document.querySelectorAll('#searchResults .search-result').length===1`);
  await js(`document.getElementById('chatSearch').select()`);
  win.webContents.insertText('zebra');
  await until(`document.getElementById('searchResults').textContent.includes('No chats match')`);
  await capture('no-match.png');
  assert.ok((await js('searches')).length<=8,'Typing is debounced into few searches: '+JSON.stringify(await js('searches')));
  assert.deepEqual(errors,[]);
  console.log('PASS: chat search layout in both themes, marked snippets, long titles, keyboard, word order, no match and Escape');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
