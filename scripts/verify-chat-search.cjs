// Production renderer and real Chromium layout/input; synthetic conversations only (#1117, #1120).
// Searching chats in a dialog: one icon beside the app name opens it (as do ⌘K/Ctrl+K and the View
// menu), recent chats show before anything is typed, matches are marked inside two-line snippets, long
// titles stay on one line, the keyboard moves through results, Enter opens one, and Escape or a click
// outside closes the dialog while the sidebar lists never move.
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
  conversationId:'search-conversation-'+n,chatIds:['search-conversation-'+n],updatedAt:f.summary.updatedAt-(n+1)*60000}));
 const found=[
  {id:'search-chat-0',title:'Fix the flaky bridge test',projectId:null,titleMatches:[[14,20]]},
  {id:'search-chat-1',title:'Plan the release notes and a very long title that does not fit in the sidebar at all, nor in the search dialog however wide it gets on this screen',projectId:null,
   snippet:{text:'…first tag the build, then the bridge gets its Windows installer and the macOS bundle is signed again before upload.',matches:[[31,37],[47,54]]}},
  {id:'search-chat-2',title:'Review the dashboard layout',projectId:null,snippet:{text:'The bridge row wraps on narrow windows.',matches:[[4,10],[31,38]]}}
 ];
 const long=[];for(let i=1;i<=240;i++){const user=i%2===1,text=i===37?'Where does the bridge installer go?':'Message number '+i+' of a long chat.';
  long.push({seq:i,time:f.summary.updatedAt-(240-i)*1000,source:'extension',kind:user?'user_message':'assistant_message',messageId:'long-'+i,turnId:'long-turn-'+Math.ceil(i/2),
   message:{text,chars:text.length,truncated:false},...(user?{}:{state:'final',final:true})});}
 const page=(options={})=>{const limit=options.limit||30;
  if(options.before!==undefined)return long.filter(e=>e.seq<options.before).slice(-limit);
  if(options.after!==undefined)return long.filter(e=>e.seq>options.after).slice(0,limit);
  if(options.from!==undefined)return long.filter(e=>e.seq>=options.from).slice(0,limit);
  return long.slice(-limit);};
 window.pages=[];
 window.searches=[];
 window.fixtureTheme='dark';
 window.setTheme=async theme=>{window.fixtureTheme=theme;const r=await methods.getState();f.emit('onStateChanged',r.data);};
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:window.fixtureTheme};return r;},
  listSessions:()=>ok({sessions:[{...f.summary,events:f.events.length},...chats],activeId:null,pressure:[],blocked:[],trusted:[]}),
  getSession:(id,options)=>{if(id!=='search-chat-1')return old.getSession(id,options);window.pages.push(options||{});const events=page(options);
   return ok({summary:{...chats[1],events:long.length},events,total:long.length,nextFrom:(events.at(-1)?.seq??0)+1});},
  locateSearchMatch:(id,query)=>ok(id==='search-chat-1'&&query.toLowerCase().includes('installer')?{seq:37,kind:'user_message',messageId:'long-37',position:37}:null),
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
  const mac = process.platform === 'darwin';
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('#sessionList [data-id="search-chat-0"]')`);
  win.show(); win.focus(); win.webContents.focus(); await pause(100);

  for (const theme of ['dark','light']) {
    await js(`setTheme(${JSON.stringify(theme)})`);
    await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    // No field in the sidebar: one icon at the end of the app name's row.
    const brand=await js(`(()=>{const b=document.getElementById('searchChatsButton').getBoundingClientRect(),r=document.querySelector('.sidebar-brand').getBoundingClientRect(),n=document.querySelector('.sidebar-brand strong').getBoundingClientRect();
      return {inRow:b.top>=r.top-1&&b.bottom<=r.bottom+1,right:r.right-b.right,after:b.left>n.right,center:Math.abs((b.top+b.bottom)/2-(n.top+n.bottom)/2),width:b.width,
        field:!!document.querySelector('.sidebar #chatSearch'),title:document.getElementById('searchChatsButton').title}})()`);
    assert.ok(brand.inRow&&brand.after&&brand.right<=12&&brand.center<=3,'The icon sits at the end of the name row: '+JSON.stringify(brand));
    assert.ok(brand.width<=32,'One small icon: '+JSON.stringify(brand));
    assert.equal(brand.field,false,'No search field in the sidebar');
    assert.equal(brand.title,`Search chats (${mac?'⌘K':'Ctrl+K'})`);
    await capture(`${theme}-idle.png`);
    const listsBefore=await js(`JSON.stringify(document.getElementById('sessionList').getBoundingClientRect())`);
    await js(`document.getElementById('searchChatsButton').click()`);
    await until(`document.getElementById('searchDialog').open&&document.activeElement?.id==='chatSearch'`);
    await js(`(()=>{const f=document.getElementById('chatSearch');f.value='';f.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    // Before anything is typed: the recent chats, newest first.
    await until(`document.querySelector('#searchResults .search-heading')?.textContent==='Recent'`);
    assert.deepEqual(await js(`[...document.querySelectorAll('#searchResults .search-result b')].map(b=>b.textContent)`),
      ['Write a haiku about snow','Fix the flaky bridge test','Plan the release notes','Review the dashboard layout']);
    // A centered dialog near the top, inside the window, with the field on top.
    const box=await js(`(()=>{const d=document.getElementById('searchDialog').getBoundingClientRect(),f=document.getElementById('chatSearch').getBoundingClientRect();
      return {left:d.left,right:innerWidth-d.right,top:d.top,bottom:d.bottom,height:innerHeight,width:d.width,fieldTop:f.top-d.top,placeholder:document.getElementById('chatSearch').placeholder}})()`);
    assert.ok(Math.abs(box.left-box.right)<=2&&box.top>=40&&box.top<=box.height*0.25&&box.bottom<=box.height,'A centered dialog near the top: '+JSON.stringify(box));
    assert.ok(box.width>=480&&box.fieldTop<=24,'Wide enough, field on top: '+JSON.stringify(box));
    assert.equal(box.placeholder,'Search chats');
    await capture(`${theme}-recent.png`);
    const fieldRow=await js(`(()=>{const f=document.querySelector('.search-dialog-field').getBoundingClientRect(),r=document.querySelector('#searchResults .search-result').getBoundingClientRect();return [Math.round(f.height),Math.round(f.bottom),Math.round(r.left),Math.round(r.width)]})()`);
    const steady=await js(`(()=>{const d=document.getElementById('searchDialog').getBoundingClientRect();return [Math.round(d.width),Math.round(d.height),Math.round(d.top)]})()`);
    win.webContents.insertText('bridge');
    await until(`document.querySelectorAll('#searchResults .search-result').length===3&&!document.querySelector('#searchResults .search-heading')`);
    assert.equal(await js(`document.getElementById('sessionList').hidden`),false,'The sidebar lists stay where they are');
    assert.equal(await js(`JSON.stringify(document.getElementById('sessionList').getBoundingClientRect())`),listsBefore,'The sidebar lists do not move');
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
    // Title and snippet marks share the theme's wash: never the browser's own yellow highlight.
    const marks=await js(`[...document.querySelectorAll('#searchResults mark')].map(m=>{const c=getComputedStyle(m);return {text:m.textContent,color:c.color,background:c.backgroundColor}})`);
    assert.ok(marks.length>=5,'Marks are painted: '+JSON.stringify(marks));
    assert.equal(new Set(marks.map(m=>m.background)).size,1,'Every mark has the same background: '+JSON.stringify(marks));
    assert.ok(marks.every(m=>m.background!=='rgb(255, 255, 0)'&&m.color!==m.background),'Marks use the theme, readably: '+JSON.stringify(marks));
    await capture(`${theme}-results.png`);
    // One size whatever the results: the box never grows or shrinks while typing.
    assert.deepEqual(await js(`(()=>{const f=document.querySelector('.search-dialog-field').getBoundingClientRect(),r=document.querySelector('#searchResults .search-result').getBoundingClientRect();return [Math.round(f.height),Math.round(f.bottom),Math.round(r.left),Math.round(r.width)]})()`),fieldRow,'Typing moves neither the line under the field nor the rows sideways');
    assert.deepEqual(await js(`(()=>{const d=document.getElementById('searchDialog').getBoundingClientRect();return [Math.round(d.width),Math.round(d.height),Math.round(d.top)]})()`),steady,'The dialog keeps its size with results');
    await key('Escape');
    // It fades out first, then closes completely: nothing is left half drawn.
    await until(`!document.getElementById('searchDialog').open&&!document.getElementById('searchDialog').classList.contains('is-closing')`);
    // Opened again, the dialog keeps the query, selected so typing replaces it.
    await js(`document.getElementById('searchChatsButton').click()`);
    await until(`document.getElementById('searchDialog').open`);
    assert.deepEqual(await js(`(()=>{const f=document.getElementById('chatSearch');return [f.value,f.selectionStart,f.selectionEnd]})()`),['bridge',0,6]);
    // A click outside the dialog closes it.
    // Near the page's own corner: a macOS window's title bar makes the page shorter than the window.
    const [outsideX,outsideY]=await js(`[innerWidth-20,innerHeight-20]`);
    win.webContents.sendInputEvent({type:'mouseDown',x:outsideX,y:outsideY,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:outsideX,y:outsideY,button:'left',clickCount:1});
    await until(`!document.getElementById('searchDialog').open`);
  }

  // ⌘K (macOS) or Ctrl+K opens the dialog from anywhere, and the View menu names it the same way.
  // A chat's open row menu closes with it: it stayed over the dialog, and open after it (2.1.29 QA).
  await js(`document.querySelector('#sessionList .sess[data-id] [aria-haspopup=menu]').click()`);
  await until(`document.querySelectorAll('.row-menu').length>0`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: [mac ? 'meta' : 'control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: [mac ? 'meta' : 'control'] });
  await until(`document.getElementById('searchDialog').open && document.activeElement?.id === 'chatSearch'`);
  assert.equal(await js(`document.querySelectorAll('.row-menu').length`), 0, 'The search dialog closes an open row menu');
  assert.equal(await js(`document.querySelector('#searchMenuItem kbd').textContent`), mac ? '⌘K' : 'Ctrl+K');
  assert.equal(await js(`document.querySelector('#sidebarMenuToggle kbd').textContent`), mac ? '⌘B' : 'Ctrl+B');
  assert.match(await js(`document.getElementById('sidebarToggle').title`), mac ? /\(⌘B\)$/ : /\(Ctrl\+B\)$/);

  // Keyboard: Down enters the results, Up returns to the field, Enter opens the first match.
  await js(`document.getElementById('chatSearch').select()`);
  win.webContents.insertText('bridge');
  await until(`document.querySelectorAll('#searchResults .search-result').length===3`);
  // The same query typed again repaints after the typing pause; wait it out before moving focus.
  await pause(400);
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
  assert.equal(JSON.stringify(await js(`(()=>{const d=document.getElementById('searchDialog').getBoundingClientRect();return [Math.round(d.width),Math.round(d.height),Math.round(d.top)]})()`)),JSON.stringify(await js(`[Math.round(Math.min(580,innerWidth-40)),Math.round(Math.min(460,innerHeight-140)),Math.round(document.getElementById('searchDialog').getBoundingClientRect().top)]`)),'The dialog keeps its size with no match');
  // Enter opens the first match: the dialog closes and the chat opens.
  await js(`document.getElementById('chatSearch').select()`);
  win.webContents.insertText('dashboard');
  await until(`document.querySelectorAll('#searchResults .search-result').length===1`);
  await key('Return');
  await until(`!document.getElementById('searchDialog').open`);
  await until(`document.querySelector('#sessionList [data-id="search-chat-2"]')?.classList.contains('is-sel')`);
  // A match by what was said opens its chat at that message, even far before the newest page.
  await js(`document.getElementById('searchChatsButton').click()`);
  await until(`document.getElementById('searchDialog').open`);
  await js(`document.getElementById('chatSearch').select()`);
  win.webContents.insertText('installer');
  await until(`document.querySelectorAll('#searchResults .search-result').length===1&&document.querySelector('#searchResults .search-result').dataset.searchId==='search-chat-1'`);
  await pause(300);
  await key('Return');
  await until(`!!document.querySelector('#timeline .is-search-hit')`);
  const hit=await js(`(()=>{const r=document.querySelector('#timeline .is-search-hit'),p=document.getElementById('chatBody').getBoundingClientRect(),b=r.getBoundingClientRect();return {text:r.textContent,inView:b.top>=p.top&&b.bottom<=p.bottom,newest:document.getElementById('timeline').textContent.includes('Message number 240 '),paged:pages.some(o=>o.before!==undefined)}})()`);
  assert.match(hit.text,/Where does the bridge installer go\?/,'The marked row is the matching message: '+JSON.stringify(hit));
  assert.ok(hit.inView,'The matching message is in view: '+JSON.stringify(hit));
  assert.ok(hit.paged&&!hit.newest,'Its page was loaded around it, not the newest page: '+JSON.stringify(hit));
  // The user's own bubble gets a ring and keeps its shape; nothing else in the row is restyled.
  // Read from the applied style, not running animations: a slow runner can finish the 2.6s mark first,
  // and under reduced motion the ring is drawn without one.
  const mark=await js(`(()=>{const b=document.querySelector('#timeline .is-search-hit .user-message-text'),s=b.closest('.said'),bs=getComputedStyle(b),ss=getComputedStyle(s);return {ring:bs.animationName,shadow:bs.boxShadow,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,said:ss.animationName,radius:ss.borderRadius}})()`);
  assert.ok(mark.reduced?mark.shadow!=='none':mark.ring==='search-hit-ring','The bubble is ringed: '+JSON.stringify(mark));
  assert.equal(mark.said,'none','The bubble container is not restyled: '+JSON.stringify(mark));
  await capture('opened-at-match.png');
  // From that page of history, Jump to latest goes straight to the end, not one page at a time.
  await js(`document.getElementById('jumpLatest').click()`);
  await until(`document.getElementById('timeline').textContent.includes('Message number 240 ')`);
  await until(`(()=>{const p=document.getElementById('chatBody');return p.scrollHeight-p.clientHeight-p.scrollTop<=40})()`);
  assert.ok((await js('searches')).length<=12,'Typing is debounced into few searches: '+JSON.stringify(await js('searches')));
  assert.deepEqual(errors,[]);
  console.log('PASS: chat search dialog in both themes: icon beside the app name, recent chats, marked snippets, long titles, ⌘K/Ctrl+K and its labels, keyboard, Enter, word order, no match, Escape, a click outside, opening at the matching message, and Jump to latest from there');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
