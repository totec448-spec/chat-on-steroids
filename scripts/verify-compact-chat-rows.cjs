// Real Electron/Chromium coverage for the existing Projects/Chats tree row density.
// Uses synthetic local sessions only; does not touch the installed app or user data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'compact-chat-rows'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.mkdirSync(path.join(output, 'profile'), { recursive: true });
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 const old=window.api, f=composerFixture, ok=data=>Promise.resolve({ok:true,data:structuredClone(data)}), now=Date.now();
 const projectId='11111111-1111-4111-8111-111111111111';
 const groupId='22222222-2222-4222-8222-222222222222';
 const project={id:projectId,name:'Studio project',path:'C:/preview/studio',color:'blue',createdAt:now-86400000};
 const titles=[
  'A very long project conversation title that must truncate cleanly without pushing the menu out of view',
  'Fix the flaky bridge test',
  'Review the sidebar layout',
  'Another long conversation title for narrow windows where there is very little horizontal room',
  'Short chat',
  'Release checklist'
 ];
 const sessions=titles.map((title,index)=>({...f.summary,id:'compact-row-'+index,title,
  conversationId:'compact-conversation-'+index,chatIds:['compact-conversation-'+index],
  projectId:index<3?projectId:null,updatedAt:now-index*60000,startedAt:now-index*120000,agents:[]}));
 sessions[1].agents=['worker-1'];
 sessions.push({...f.summary,id:'compact-worker-1',title:'Worker task',conversationId:'compact-worker-conversation',
  chatIds:['compact-worker-conversation'],projectId,updatedAt:now-30000,startedAt:now-90000,agents:[],
  origin:{kind:'worker',fromSessionId:'compact-row-1',agentId:'worker-1',task:'Review the compact chat rows'}});
 let mode={theme:'dark',highContrast:false,fontSize:14,translucentSidebar:false,sidebarLayout:'projects',sidebarTint:'#1a2129'};
 const appearance=()=>({light:{background:'#f4f4f5',sidebar:'#e9edf2',accent:'#486f9d',contrast:45},
  dark:{background:'#181818',sidebar:mode.sidebarTint,accent:'#b0cbed',contrast:60},font:'system',fontSize:mode.fontSize,
  lineSpacing:100,translucentSidebar:mode.translucentSidebar,sidebarLayout:mode.sidebarLayout,highContrast:mode.highContrast});
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config.ui={...r.data.config.ui,theme:mode.theme,appearance:appearance()};return r;},
  listSessions:options=>ok({sessions:options?.projectId?sessions.filter(s=>s.projectId===options.projectId):sessions,
   activeId:null,pressure:[],blocked:[],approval:[],recoveryStopped:[],trusted:[]}),
  listProjects:()=>ok([project]),
  chatGroups:()=>ok({version:1,groups:[{id:groupId,projectId,name:'Design notes',createdAt:now-7200000}],members:{'compact-row-2':groupId}}),
  markWhatsNewSeen:()=>ok(undefined)
 };
 window.api=new Proxy(methods,{get(target,key){return key in target?target[key]:old[key];}});
 window.setRowMode=async(theme,highContrast=false,fontSize=14,translucentSidebar=false,sidebarLayout='projects',sidebarTint='#1a2129')=>{
  mode={theme,highContrast,fontSize,translucentSidebar,sidebarLayout,sidebarTint};const r=await methods.getState();f.emit('onStateChanged',r.data);
 };
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const iconRoot = fs.realpathSync(path.join(root, 'node_modules/@phosphor-icons/web/src'));
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':iconRoot}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,iconRoot]}},
    plugins:[{name:'compact-chat-rows-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/compact-rows-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/compact-rows-fixture.js')return next();
        res.setHeader('Content-Type','text/javascript');
        res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);
      });}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:820,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(160);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const key=async name=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:name});win.webContents.sendInputEvent({type:'keyUp',keyCode:name});await pause(100);};
  const pointerAway=async()=>{win.webContents.sendInputEvent({type:'mouseMove',x:600,y:300});await pause(180);};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`document.querySelectorAll('#sessionList:not(.is-inbox) .sess[data-id]').length===6`);
  // Open the synthetic project so both project-owned and unfiled chat rows are measured.
  await js(`document.querySelector('#projectList .project-heading')?.click()`);
  await until(`!!document.querySelector('#projectList .project-group > .sess[data-id="compact-row-0"]')`);
  await until(`!!document.querySelector('#projectList .chat-group .sess[data-id="compact-row-2"]')`);
  win.show();win.focus();win.webContents.focus();await pause(100);

  const inspect=()=>js(`(()=>[...document.querySelectorAll('#sessionList:not(.is-inbox) .sess[data-id]')].map(row=>{
    const title=row.querySelector('.sess-top > b'),menu=row.querySelector('.row-menu-button'),worker=row.querySelector(':scope > .worker-toggle'),r=row.getBoundingClientRect(),m=menu.getBoundingClientRect(),s=getComputedStyle(title);
    const top=row.querySelector('.sess-top'),tr=top.getBoundingClientRect();
    return {id:row.dataset.id,height:r.height,topHeight:tr.height,width:r.width,scrollWidth:row.scrollWidth,clientWidth:row.clientWidth,
      titleWidth:title.clientWidth,titleScroll:title.scrollWidth,titleOverflow:title.scrollWidth>title.clientWidth,
      hovered:row.matches(':hover'),focusWithin:row.matches(':focus-within'),
      textOverflow:s.textOverflow,whiteSpace:s.whiteSpace,overflow:s.overflow,lineHeight:s.lineHeight,
      menuWidth:m.width,menuHeight:m.height,workerWidth:worker?.getBoundingClientRect().width??0,workerHeight:worker?.getBoundingClientRect().height??0};
  }))()`);
  const assertRows=async({heightMin=32,heightMax=34,ordinaryMax=32.5,narrow=false}={})=>{
    const rows=await inspect();
    assert.equal(rows.length,6,'All six sample chats remain visible: '+JSON.stringify(rows));
    assert.ok(rows.every(r=>r.height>=heightMin-0.5&&r.height<=heightMax+0.5),'Rows use the intended compact height: '+JSON.stringify(rows));
    assert.ok(rows.filter(r=>r.workerWidth===0).every(r=>r.height<=ordinaryMax),'Ordinary row height stays within the selected text scale: '+JSON.stringify(rows));
    assert.ok(rows.every(r=>r.topHeight>=24),'The focusable row control retains a 24px target: '+JSON.stringify(rows));
    assert.ok(rows.every(r=>r.whiteSpace==='nowrap'&&r.overflow==='hidden'&&(!r.titleOverflow||r.hovered||r.focusWithin||r.textOverflow==='ellipsis')),'Resting overflowing titles use ellipsis; hovered/focused rows may use the intentional action mask: '+JSON.stringify(rows));
    assert.ok(rows.some(r=>r.titleOverflow&&!r.hovered&&!r.focusWithin&&r.textOverflow==='ellipsis'),'At least one deliberately long, resting title is actually ellipsized: '+JSON.stringify(rows));
    assert.ok(rows.every(r=>r.menuWidth>=25&&r.menuHeight>=25),'The existing 26px menu hit target remains intact: '+JSON.stringify(rows));
    assert.ok(rows.filter(r=>r.workerWidth>0).every(r=>r.workerWidth>=24&&r.workerHeight>=26&&r.height>=34),'Worker disclosure keeps its 24×26 target and row clearance: '+JSON.stringify(rows));
    if(narrow)assert.ok(rows.every(r=>r.scrollWidth<=r.clientWidth+1),'No row overflows the narrow sidebar: '+JSON.stringify(rows));
    return rows;
  };

  // Same synthetic data, same viewport: capture the upstream row rhythm before the scoped override.
  await js(`setRowMode('dark',false,14,false)`);
  await until(`document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.highContrast==='false'`);
  await js(`(()=>{const style=document.createElement('style');style.id='compact-rows-before';style.textContent=
    '#sessionList:not(.is-inbox) .sess:not(.sess-card){min-height:36px;margin-block:2px;padding-block:7px}'+
    '#sessionList:not(.is-inbox) .sess:not(.sess-card) .sess-top{min-height:0}'+
    '#sessionList:not(.is-inbox) .sess:not(.sess-card) .sess-top > b{line-height:22px}';document.head.append(style)})()`);
  const before=await inspect();
  assert.ok(before.filter(r=>r.workerWidth===0).every(r=>Math.abs(r.height-36)<0.5),'Baseline ordinary rows are 36px: '+JSON.stringify(before));
  await capture('before-dark-wide.png');
  await js(`document.getElementById('compact-rows-before').remove()`);

  for(const theme of ['dark','light']){
    await js(`setRowMode(${JSON.stringify(theme)},false,14,false)`);
    await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}&&document.documentElement.dataset.highContrast==='false'`);
    const rows=await assertRows();
    // The project tree and the unfiled Chats section both use the compact row, not a one-off variant.
    assert.ok(await js(`!!document.querySelector('#projectList .project-group > .sess[data-id="compact-row-0"]')`),'Project rows are compact too');
    const groupIndent=await js(`(()=>{const project=document.querySelector('#projectList .project-group > .sess[data-id="compact-row-0"]'),group=document.querySelector('#projectList .chat-group .sess[data-id="compact-row-2"]');return group.getBoundingClientRect().left-project.getBoundingClientRect().left})()`);
    assert.ok(groupIndent>=25&&groupIndent<=27,'Chat-group rows retain their 26px nested indent inside the project: '+groupIndent);
    await capture(`${theme}-wide.png`);
    console.log(`PASS ${theme} 1280px: ${rows[0].height}px rows, 26px action target, title ellipsis`);
  }
  await js(`setRowMode('dark',false,14,false)`);
  await until(`document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.highContrast==='false'`);
  const workerToggle=await js(`(()=>{const r=document.querySelector('#projectList .sess[data-id="compact-row-1"]'),b=r?.querySelector(':scope > .worker-toggle'),x=b?.getBoundingClientRect();return x?{width:x.width,height:x.height,rowHeight:r.getBoundingClientRect().height}:null})()`);
  assert.ok(workerToggle&&workerToggle.width===24&&workerToggle.height===26&&workerToggle.rowHeight>=34,'Worker disclosure has full target clearance: '+JSON.stringify(workerToggle));
  await js(`document.querySelector('#projectList .sess[data-id="compact-row-1"] > .worker-toggle').click()`);
  await until(`!!document.querySelector('#projectList .worker-group .sess[data-id="compact-worker-1"]')`);
  const workerRow=await js(`(()=>{const r=document.querySelector('#projectList .worker-group .sess[data-id="compact-worker-1"]');return r?{height:r.getBoundingClientRect().height,title:r.querySelector('.sess-top > b')?.textContent}:null})()`);
  assert.ok(workerRow&&workerRow.height>=32&&workerRow.height<=34,'Expanded worker chat uses the same compact row: '+JSON.stringify(workerRow));
  await capture('dark-worker-expanded.png');
  await js(`document.querySelector('#projectList .sess[data-id="compact-row-1"] > .worker-toggle').click()`);
  await until(`!document.querySelector('#projectList .worker-group .sess[data-id="compact-worker-1"]')`);

  for(const theme of ['dark','light']){
    await js(`setRowMode(${JSON.stringify(theme)},true,14,false)`);
    await until(`document.documentElement.dataset.highContrast==='true'&&document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    await assertRows();
    const contrast=await js(`(()=>{const rgb=s=>s.match(/[\\d.]+/g).slice(0,3).map(Number);const lum=s=>{const c=rgb(s).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]};const a=lum(getComputedStyle(document.querySelector('.sess-top b')).color),b=lum(getComputedStyle(document.querySelector('.sidebar')).backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)})()`);
    assert.ok(contrast>=7,'High-contrast sidebar text remains at least 7:1: '+contrast);
    await capture(`high-contrast-${theme}.png`);
    console.log(`PASS ${theme} high contrast: ${contrast.toFixed(2)}:1 text contrast`);
  }

  // The compact rule must not leak into the separate, deliberately multi-line Inbox cards.
  await js(`setRowMode('dark',false,14,false,'inbox')`);
  await until(`document.getElementById('sessionList').classList.contains('is-inbox')&&document.querySelector('#chatList .sess-card')`);
  const inbox=await js(`(()=>[...document.querySelectorAll('#chatList .sess-card')].map(row=>({height:row.getBoundingClientRect().height,padding:getComputedStyle(row).paddingTop})) )()`);
  assert.ok(inbox.length>=1&&inbox.every(row=>row.height>40&&row.padding==='10px'),'Inbox cards keep their original multi-line spacing: '+JSON.stringify(inbox));
  await capture('inbox-unchanged.png');
  console.log(`PASS Inbox cards remain multi-line and unchanged (${inbox[0].height}px)`);

  // At the narrow breakpoint the sidebar becomes 205px; the title yields space to the menu,
  // rather than widening a row or shrinking its accessible action target.
  win.setSize(820,760);await pause(250);
  await js(`setRowMode('dark',false,14,false)`);
  await until(`document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.highContrast==='false'`);
  const narrow=await assertRows({narrow:true});
  const sidebarWidth=await js(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`);
  assert.ok(sidebarWidth<=220,'Narrow breakpoint uses the compact sidebar: '+sidebarWidth);
  await capture('dark-narrow.png');
  console.log(`PASS narrow 820px: sidebar ${sidebarWidth}px, no row overflow`);

  // Real Chromium pointer drag at the compact row pitch: move the first unfiled chat after the second.
  const dragPoints=await js(`(()=>{const from=document.querySelector('#chatList .sess[data-id="compact-row-3"] .sess-top').getBoundingClientRect(),to=document.querySelector('#chatList .sess[data-id="compact-row-5"]').getBoundingClientRect();return {fromX:from.left+from.width/2,fromY:from.top+from.height/2,toX:to.left+to.width/2,toY:to.top+2}})()`);
  win.webContents.sendInputEvent({type:'mouseDown',x:dragPoints.fromX,y:dragPoints.fromY,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove',x:dragPoints.toX,y:dragPoints.toY,movementX:0,movementY:dragPoints.toY-dragPoints.fromY});
  await pause(60);
  win.webContents.sendInputEvent({type:'mouseUp',x:dragPoints.toX,y:dragPoints.toY,button:'left',clickCount:1});
  await until(`(()=>[...document.querySelectorAll('#chatList > .sess[data-id]')].map(row=>row.dataset.id).join(',')==='compact-row-4,compact-row-3,compact-row-5')()`);
  await pointerAway();
  await assertRows({narrow:true});await capture('dark-narrow-reordered.png');
  console.log('PASS actual pointer reorder at compact 32px row height');

  // The actual resize separator clamps at 180px and exposes the same value to assistive technology.
  await js(`document.getElementById('sidebarResize').focus()`);await key('Home');
  await until(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)===180`);
  const minimumWidth=await js(`({width:Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),aria:document.getElementById('sidebarResize').getAttribute('aria-valuenow')})`);
  assert.equal(minimumWidth.aria,'180','Keyboard Home reports the 180px minimum through aria-valuenow: '+JSON.stringify(minimumWidth));
  const groupCount=await js(`(()=>{const count=document.querySelector('#projectList .chat-group .chat-group-heading .chat-group-count'),sidebar=document.querySelector('.sidebar'),r=count?.getBoundingClientRect(),s=sidebar.getBoundingClientRect(),style=count&&getComputedStyle(count);return count?{text:count.textContent.trim(),display:style.display,width:r.width,height:r.height,left:r.left,right:r.right,sidebarLeft:s.left,sidebarRight:s.right}:null})()`);
  assert.ok(groupCount&&groupCount.text==='1'&&groupCount.display!=='none'&&groupCount.width>0&&groupCount.height>0&&groupCount.left>=groupCount.sidebarLeft&&groupCount.right<=groupCount.sidebarRight+1,'Nested chat-group count remains visible and in bounds at the 180px sidebar minimum: '+JSON.stringify(groupCount));
  await assertRows({narrow:true});await capture('dark-min-width-180.png');
  console.log('PASS actual 180px minimum resize, accessible value, row truncation and visible group count');

  await js(`setRowMode('dark',false,14,false,'projects','#493452')`);
  await until(`document.documentElement.dataset.theme==='dark'&&getComputedStyle(document.querySelector('.sess-top > b')).fontSize==='14px'`);
  const customTint=await js(`getComputedStyle(document.querySelector('.sidebar')).backgroundColor`);
  assert.equal(customTint,'rgb(73, 52, 82)','Custom sidebar tint is preserved: '+customTint);
  await assertRows();await capture('dark-custom-sidebar-tint.png');
  console.log('PASS custom sidebar tint is preserved');

  await js(`setRowMode('dark',false,12,false)`);
  await until(`getComputedStyle(document.querySelector('.sess-top > b')).fontSize==='12px'`);
  await assertRows();await capture('dark-small-text.png');
  console.log('PASS 12px minimum text retains 24px focus target');

  // Larger user-selected text must grow the row rather than clipping glyphs or controls.
  await js(`setRowMode('dark',false,18,true)`);
  await until(`document.documentElement.dataset.translucentSidebar==='true'&&getComputedStyle(document.querySelector('.sess-top > b')).fontSize==='18px'&&!document.getElementById('sessionList').classList.contains('is-inbox')&&document.querySelectorAll('#sessionList:not(.is-inbox) .sess[data-id]').length===6`);
  const large=await assertRows({heightMin:33,heightMax:40,ordinaryMax:40});
  assert.ok(large.every(r=>r.scrollWidth<=r.clientWidth+1),'Large text does not create horizontal row overflow: '+JSON.stringify(large));
  assert.ok(await js(`getComputedStyle(document.querySelector('.sidebar')).backdropFilter.includes('blur')`),'Translucent sidebar appearance remains active');
  await capture('dark-large-text-translucent.png');
  console.log(`PASS 18px text + translucent sidebar: row height ${large[0].height}px`);

  // Focus and menu behavior are unchanged by the smaller row pitch. Choose an unselected row,
  // because opening a different chat intentionally rebuilds the tree and may move focus onward.
  await pointerAway();
  const targetId=await js(`(()=>[...document.querySelectorAll('#chatList .sess[data-id]')].find(row=>!row.classList.contains('is-sel'))?.dataset.id)()`);
  assert.ok(targetId,'The fixture has an unselected chat for keyboard activation');
  const rowSelector=`#chatList .sess[data-id=${JSON.stringify(targetId)}]`;
  await js(`document.activeElement?.blur()`);await key('Tab');
  await js(`document.querySelector(${JSON.stringify(rowSelector+' .sess-top')}).focus()`);
  const ring=await js(`(()=>{const e=document.querySelector(${JSON.stringify(rowSelector+' .sess-top')}),r=e.closest('.sess'),s=getComputedStyle(r);return {matches:e.matches(':focus-visible'),style:s.outlineStyle,width:s.outlineWidth,offset:s.outlineOffset,height:e.getBoundingClientRect().height}})()`);
  assert.ok(ring.matches&&ring.style==='solid'&&ring.width==='2px'&&ring.offset==='-2px'&&ring.height>=24,'Keyboard focus has a visible row ring around a 24px target: '+JSON.stringify(ring));
  await capture('dark-keyboard-focus.png');
  const point=await js(`(()=>{const r=document.querySelector(${JSON.stringify(rowSelector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});await pause(150);
  const hover=await js(`(()=>{const row=document.querySelector(${JSON.stringify(rowSelector)}),actions=row.querySelector('.sess-actions'),top=row.querySelector('.sess-top'),s=getComputedStyle(actions);return {hover:row.matches(':hover'),opacity:s.opacity,pointer:s.pointerEvents,mask:getComputedStyle(top).maskImage}})()`);
  assert.ok(hover.hover&&hover.opacity==='1'&&hover.pointer==='auto'&&hover.mask!=='none','Hover reveals actions while masking the title beneath them: '+JSON.stringify(hover));
  await capture('dark-hover-actions.png');
  await js(`document.querySelector(${JSON.stringify(rowSelector+' .sess-top')}).focus()`);
  await key('Space');
  await until(`document.querySelector(${JSON.stringify(rowSelector)})?.classList.contains('is-sel')`);
  assert.equal(await js(`document.querySelector(${JSON.stringify(rowSelector)})?.classList.contains('is-sel')`),true,'Space selects an unselected chat');
  await js(`document.querySelector(${JSON.stringify(rowSelector+' .row-menu-button')}).click()`);
  await until(`document.querySelector('.row-menu')`);
  assert.equal(await js(`document.querySelector(${JSON.stringify(rowSelector+' .row-menu-button')}).getAttribute('aria-expanded')`),'true');
  assert.deepEqual(errors,[],'No unexpected renderer console errors');
  console.log('PASS visible keyboard focus, hover action reveal, Space selection, row menu, and no renderer console errors');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{
  fs.mkdirSync(output,{recursive:true});
  if(win&&!win.isDestroyed())try{fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());}catch{}
  console.error(error);try{win?.destroy();}catch{}try{await server?.close();}catch{}app.exit(1);
});
