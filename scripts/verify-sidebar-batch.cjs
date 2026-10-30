// Full renderer in real Chromium with an isolated in-memory sidebar IPC fixture. No installed COS data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp/sidebar-parity');
const visualPreview = process.env.COS_T3_VISUAL === '1';
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require('./fixtures/app-defaults.cjs');
const { fixtureSidebarShelvesSource } = require('./fixtures/sidebar-shelves.cjs');
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
// A failed assertion may close the only fixture window before its rejection reaches .catch.
// Prevent Electron's automatic last-window quit from hiding the actual test failure.
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let completed = false;
let reportingFailure = false;
app.on('before-quit', event => {
  if (completed || reportingFailure) return;
  event.preventDefault();
  console.error('Unexpected Electron quit before sidebar assertions finished');
  app.exit(1);
});
let server, win;
const fixture = `(() => {
  const old=window.api,f=composerFixture,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
  const visual=${visualPreview ? 'true' : 'false'};
  const projects=visual ? [
    {id:'cos-app',name:'chat-on-steroids',path:'D:/chat/chat-on-steroids',color:'blue',ungrouped:false},
    {id:'inkpad',name:'inkpad',path:'D:/chat/inkpad',color:'green',ungrouped:false},
    {id:'price-compare',name:'price-compare',path:'D:/chat/price-compare',color:'purple',ungrouped:false},
    {id:'tvdoctor',name:'TVDoctor',path:'D:/Tv Docter',color:'amber',ungrouped:false},
    {id:'video-editor',name:'ai-video-editor',path:'D:/chat/ai-video-editor',color:'teal',ungrouped:false},
    {id:'balloon',name:'balloon-dots',path:'D:/chat/balloon-dots',color:'rose',ungrouped:false},
    {id:'kart',name:'kart-royale',path:'D:/chat/kart-royale',color:'blue',ungrouped:false}
  ] : [];
  const titles=visual ? [
    'Rebuild sidebar with T3 layout','Fix release packaging','Review Electron startup',
    'Improve drag and drop','Polish drawing tools','Fix image caption export',
    'Implement persistent drafts','Improve product search','Connect retailer feeds',
    'Profile Android decoder','Review Roku snapshot','Make video streaming faster',
    'Add timeline keyboard shortcuts','Fix native MP4 export',
    'Fix companion connection','Improve desktop window controls',
    'Model kart bonnet geometry','Polish Roblox vehicle meshes',
    'Unfiled support chat'
  ] : ['Investigate navigation','Review sidebar styles','Add keyboard tests','Finish release notes'];
  const visualProject=n=>n<4?'cos-app':n<7?'inkpad':n<9?'price-compare':n<12?'tvdoctor':n<14?'video-editor':n<16?'balloon':n<18?'kart':undefined;
  const rows=Array.from({length:titles.length},(_,n)=>({...f.summary,id:'batch-chat-'+n,title:titles[n],
    projectId:visual ? visualProject(n) : undefined,
    conversationId:'batch-conversation-'+n,chatIds:['batch-conversation-'+n],updatedAt:Date.now()-n*3600000}));
  window.fixtureRows=rows;
  window.fileImports=[];
  const methods={
    ...window.sidebarShelfFixture.methods,
    ...(visual ? {markWhatsNewSeen:()=>ok(undefined), chatGroups:()=>ok({version:1,groups:[],members:{}})} : {}),
    getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:window.fixtureTheme||'dark'};return r;},
    listSessions:()=>ok({sessions:rows,activeId:null,pressure:[],blocked:[],trusted:[]}),
    getSession:async(id)=>ok({summary:rows.find(r=>r.id===id)||rows[0],events:[],total:0,nextFrom:1}),
    getSessionControls:async id=>ok({...f.controls,sessionId:id,conversationId:'batch-conversation-'+id.slice(-1)}),
    dropFiles:async files=>{window.fileImports.push(files.map(file=>file.name));await new Promise(r=>setTimeout(r,40));
      return ok(files.map((file,n)=>({id:'fixture-attached-'+n,name:file.name,mimeType:file.type||'text/plain',size:file.size})));},
    listProjects:()=>ok(projects)
  };
  window.fixtureTheme='dark';
  window.setTheme=async theme=>{window.fixtureTheme=theme;f.emit('onStateChanged',(await methods.getState()).data);};
  window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  fs.mkdirSync(output, { recursive: true });
  fs.rmSync(path.join(output, 'completed.txt'), { force: true });
  fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'sidebar-parity-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/sidebar-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/sidebar-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixtureSidebarShelvesSource()+fixture);});}}] });
  await server.listen();
  // Use T3 Code's 1920x1080 reference viewport for visual parity captures only.
  win = new BrowserWindow({ show:false, width:visualPreview ? 1920 : 1280, height:visualPreview ? 1080 : 850,
    webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false} });
  const errors=[];
  win.webContents.on('console-message', e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(let i=0;i<320;i++){if(await js(expression))return;await pause(35);}throw new Error('Timed out: '+expression+' errors: '+JSON.stringify(errors));};
  const capture=async name=>{await pause(140);fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const id=n=>`batch-chat-${n}`;
  const row=n=>`document.querySelector('#sessionList .sess[data-id="${id(n)}"]')`;
  const selected=()=>js(`[...document.querySelectorAll('#sessionList .sess.is-multi-selected')].map(r=>r.dataset.id)`);
  try {
    await win.loadURL(server.resolvedUrls.local[0]);
    await until(`!!${row(3)}?.querySelector('.sess-top')`);
    win.show();win.focus();win.webContents.focus();await pause(200);
    assert.equal(await js(`document.querySelectorAll('#sessionList .sess[data-id]').length`),visualPreview ? 19 : 4);
    if (visualPreview) {
      await until(`document.querySelectorAll('#sessionList .project-group').length===7`);
      await js(`window.sidebarShelfFixture.methods.setSidebarShelves([
        {id:'batch-chat-2',shelf:'pinned'},
        {id:'batch-chat-8',shelf:'settled'},
        {id:'batch-chat-6',shelf:'snoozed',until:Date.now()+3600000,
          attention:{userMessages:0,errors:0}}
      ],window.sidebarShelfFixture.revision())`);
      await until(`document.querySelector('#sidebarPinned .sess[data-id="batch-chat-2"]') &&
        document.querySelector('#sidebarParking .sidebar-parking-shelf[data-sidebar-shelf-target="settled"]')`);
      await js(`(()=>{for(const id of ['cos-app','inkpad','price-compare','tvdoctor','video-editor','balloon','kart']){
        const row=document.querySelector('.project-group[data-project-id="'+id+'"]');
        if(row&&!row.open)row.querySelector('.project-heading').click();
      }})()`);
      await until(`document.querySelectorAll('#sessionList .project-group[open]').length===7`);
      await capture('t3-rebuild-dark-projects.png');
      await js(`setTheme('light')`);
      await until(`document.documentElement.dataset.theme==='light'`);
      await capture('t3-rebuild-light-projects.png');
      await js(`setTheme('dark')`);
      await until(`document.documentElement.dataset.theme==='dark'`);
      await js(`${row(1)}.querySelector('.sess-top').click()`);
      await until(`!!${row(1)}?.classList.contains('is-sel')`);
      await capture('t3-rebuild-dark-selected.png');
      assert.equal(await js(`document.getElementById('t3SidebarProjects').getAttribute('aria-pressed')`),'true');
      const filterChanges = await js(`(()=>{let count=0;
        document.getElementById('appearanceLayoutInbox').addEventListener('change',()=>count++);
        document.getElementById('t3SidebarInbox').click();
        return {checked:document.getElementById('appearanceLayoutInbox').checked,count};})()`);
      assert.deepEqual(filterChanges,{checked:true,count:1},'Inbox button delegates to the existing persisted Appearance choice');
      await until(`document.getElementById('t3SidebarInbox').getAttribute('aria-pressed')==='true'`);
      assert.equal(await js(`document.getElementById('sessionList').classList.contains('is-inbox')`),true);
      assert.equal(await js(`document.getElementById('sidebarPinned').childElementCount`),0,
        'Inbox must not retain hidden Projects pinned rows in its selection order');
      assert.equal(await js(`(()=>{
        const row=document.querySelector('#chatList .sess-card[data-id="batch-chat-2"]');
        const pin=row?.querySelector('.sess-pin-mark');
        if(!row||!pin)return false;
        const draft=document.createElement('span');draft.className='sess-draft-mark';draft.textContent='Draft';
        row.querySelector('.sess-top').append(draft);
        const a=pin.getBoundingClientRect(),b=draft.getBoundingClientRect();draft.remove();
        return a.width>0&&b.width>0&&(a.right<=b.left||b.right<=a.left);
      })()`),true,'Pin and draft badges cannot overlap on a pinned Inbox row');
      assert.equal(await js(`Math.max(...[...document.querySelectorAll('#sessionList .sess-card')].map(row=>row.getBoundingClientRect().height)) <= 50`),true,
        'Inbox thread rows remain compact in the T3-like layout');
      await capture('t3-rebuild-dark-inbox.png');
      await js(`document.getElementById('t3SidebarProjects').click()`);
      await until(`document.getElementById('t3SidebarProjects').getAttribute('aria-pressed')==='true'`);
      assert.deepEqual(errors,[]);
      completed=true;
      fs.writeFileSync(path.join(output,'completed.txt'),'T3 visual preview captured');
      console.log('PASS: real Chromium dark/light visual previews with grouped projects');
      return;
    }
    // A normal row click navigates; modifier clicks select without changing the active conversation.
    await js(`${row(0)}.querySelector('.sess-top').click()`);
    await until(`!!${row(0)}?.classList.contains('is-sel')`);
    await js(`${row(1)}.querySelector('.sess-top').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
    await js(`${row(2)}.querySelector('.sess-top').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))`);
    assert.deepEqual((await selected()).sort(),[id(1),id(2)]);
    assert.equal(await js(`${row(0)}.classList.contains('is-sel')`),true,'Modifier selection cannot navigate');
    assert.equal(await js(`document.getElementById('sidebarBatch').hidden`),false);
    assert.equal(await js(`document.getElementById('sidebarBatchCount').textContent`),'2 selected');
    await capture('dark-multi-selection.png');
    await js(`document.getElementById('sidebarBatchPin').click()`);
    await until(`window.sidebarShelfFixture.revision()>=1`);
    await until(`${row(1)}?.classList.contains('is-pinned') && ${row(2)}?.classList.contains('is-pinned')`);
    assert.equal(await js(`window.sidebarShelfFixture.revision()`),1,'One revision for the entire batch');
    assert.deepEqual(await js(`window.sidebarShelfFixture.records()`),{[id(1)]:{shelf:'pinned'},[id(2)]:{shelf:'pinned'}});
    await capture('dark-batch-pinned.png');
    await js(`document.getElementById('sidebarUndoButton').click()`);
    await until(`window.sidebarShelfFixture.revision()===2`);
    assert.deepEqual(await js(`window.sidebarShelfFixture.records()`),{},'Undo restores both records atomically');
    assert.equal(await js(`document.getElementById('sidebarUndoButton').textContent`),'Redo');
    await js(`document.getElementById('sidebarUndoButton').click()`);
    await until(`window.sidebarShelfFixture.revision()===3`);
    assert.equal(await js(`${row(1)}?.classList.contains('is-pinned') && ${row(2)}?.classList.contains('is-pinned')`),true);
    // Keyboard roving focus/selection and context menu still work without using the mouse.
    const orderAfterPin = await js(`[...document.querySelectorAll('#sessionList .sess[data-id]')].map(row=>row.dataset.id)`);
    await js(`${row(0)}.querySelector('.sess-top').focus()`);
    await js(`${row(0)}.querySelector('.sess-top').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
    assert.equal(await js(`document.activeElement.closest('.sess')?.dataset.id`),orderAfterPin[orderAfterPin.indexOf(id(0))+1],
      'Down follows the currently rendered order after the batch reordered pinned chats');
    await js(`${row(1)}.querySelector('.sess-top').dispatchEvent(new KeyboardEvent('keydown',{key:' ',ctrlKey:true,bubbles:true}))`);
    assert.equal(await js(`document.getElementById('sidebarBatchCount').textContent`),'1 chat selected');
    await js(`${row(1)}.querySelector('.sess-top').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))`);
    assert.equal(await js(`!!document.querySelector('.row-menu')`),true);
    await js(`document.querySelector('.row-menu')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    // An independent draft creates a unique text owner, and discarding it leaves other chats untouched.
    await js(`document.getElementById('sidebarNewDraft').click()`);
    await js(`(()=>{const field=document.getElementById('chatInput');field.value='Independent draft check';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(`document.querySelector('#sidebarDraftsList .sidebar-draft-open')?.textContent.includes('Independent draft check')`);
    assert.equal(await js(`document.querySelector('#sidebarDraftsList .sidebar-draft-open')?.getAttribute('aria-current')`),'page');
    await capture('dark-draft.png');
    await js(`document.querySelector('#sidebarDraftsList .sidebar-draft-discard').click()`);
    await until(`document.querySelectorAll('#sidebarDraftsList .sidebar-draft-row').length===0`);
    // A real Chromium file DragEvent must attach to the row under the pointer, not the open New Chat.
    await js(`(()=>{const row=${row(3)};const transfer=new DataTransfer();
      transfer.items.add(new File(['from row three'],'row-three.txt',{type:'text/plain'}));
      row.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      if(!row.classList.contains('is-file-drop-target'))throw Error('Missing row drop highlight');
      row.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    })()`);
    await until(`${row(3)}?.classList.contains('is-sel')`);
    await until(`document.querySelector('#composerImages')?.textContent.includes('row-three.txt')`);
    assert.deepEqual(await js(`window.fileImports`),[['row-three.txt']]);
    await capture('dark-file-drop-target.png');
    // The production command palette already owns transcript content search.
    await js(`document.getElementById('searchChatsButton').click()`);
    await until(`document.getElementById('searchDialog').open`);
    await js(`document.getElementById('searchDialog').close()`);
    for(const theme of ['dark','light']) {
      await js(`setTheme(${JSON.stringify(theme)})`);
      await until(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
      await capture(`${theme}-sidebar.png`);
    }
    // Use genuine Chromium pointer input, not jsdom, to expose a live T3-style shelf action preview.
    await js(`document.getElementById('sidebarDraftsShelf').open=false`);
    const rowLocation = await js(`(()=>{const r=${row(0)}.querySelector('.sess-top').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    await win.webContents.sendInputEvent({type:'mouseMove',x:rowLocation.x,y:rowLocation.y});
    await win.webContents.sendInputEvent({type:'mouseDown',x:rowLocation.x,y:rowLocation.y,button:'left',clickCount:1});
    await win.webContents.sendInputEvent({type:'mouseMove',x:rowLocation.x+9,y:rowLocation.y+12,mouseLeave:false,button:'left'});
    await until(`document.getElementById('sidebarDropZones').hidden===false`);
    const zone = await js(`(()=>{const r=document.querySelector('[data-sidebar-shelf-target="settled"]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    await win.webContents.sendInputEvent({type:'mouseMove',x:zone.x,y:zone.y,button:'left'});
    await until(`${row(0)}?.querySelector('.sidebar-row-drag-preview')?.textContent.includes('Settle')`);
    await capture('light-shelf-drag-preview.png');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await win.webContents.sendInputEvent({type:'mouseUp',x:zone.x,y:zone.y,button:'left',clickCount:1});
    assert.equal(await js(`window.sidebarShelfFixture.revision()`),3,'Cancelled drag did not mutate shelves');
    // Commit the internal MIME drop in real Chromium and assert one durable revision.
    await js(`(()=>{const handle=${row(0)}.querySelector('.sidebar-shelf-drag-handle');
      const transfer=new DataTransfer();
      handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      if(!transfer.types.includes('application/x-chat-on-steroids-sidebar-shelf'))throw Error('Internal drag MIME missing');
      const zone=document.querySelector('[data-sidebar-shelf-target="settled"]');
      zone.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      if(!zone.classList.contains('is-shelf-drop-target'))throw Error('Drop target not highlighted');
      zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    })()`);
    await until(`window.sidebarShelfFixture.revision()===4`);
    assert.equal(await js(`window.sidebarShelfFixture.records()['batch-chat-0'].shelf`),'settled');
    await until(`!!document.querySelector('#sidebarParking .sess[data-id="batch-chat-0"]')`);
    await capture('light-settled-shelf.png');
    await js(`document.getElementById('sidebarUndoButton').click()`);
    await until(`window.sidebarShelfFixture.revision()===5`);
    assert.equal(await js(`window.sidebarShelfFixture.records()['batch-chat-0']`),undefined);
    await js(`window.__sidebarBeforeReload = true`);
    const finishedLoading = new Promise((resolve, reject) => {
      const contents = win.webContents;
      const cleanup = () => {
        clearTimeout(timeout);
        contents.removeListener('did-finish-load', success);
        contents.removeListener('did-fail-load', failed);
        contents.removeListener('render-process-gone', crashed);
      };
      const success = () => { cleanup(); resolve(); };
      const failure = reason => { cleanup(); reject(new Error(reason)); };
      const failed = (_event, code, description, _url, isMainFrame) => {
        // A reload can cancel an old navigation; only failures of the new main frame count.
        if (isMainFrame !== false && code !== -3) failure(`Sidebar reload failed (${code}): ${description}`);
      };
      const crashed = (_event, details) => failure(`Sidebar renderer exited during reload: ${details.reason}`);
      const timeout = setTimeout(() => failure('Timed out waiting for sidebar reload'), 20_000);
      contents.once('did-finish-load', success);
      contents.on('did-fail-load', failed);
      contents.once('render-process-gone', crashed);
    });
    win.webContents.reload();
    await finishedLoading;
    await until(`window.__sidebarBeforeReload === undefined && !!${row(2)}?.classList.contains('is-pinned')`);
    assert.equal(await js(`window.sidebarShelfFixture.revision()`),5,'Reload keeps the same persisted group revision');
    assert.deepEqual(errors,[]);
    completed = true;
    fs.writeFileSync(path.join(output, 'completed.txt'), 'All Chromium sidebar assertions passed');
    console.log('PASS: modifier/range selection, one batch revision, atomic Undo/Redo, keyboard focus, draft navigation/discard and persisted shelves in Chromium');
  } catch (error) {
    // The window must still exist when capturing a failed assertion's evidence.
    try { fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG()); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally { win.destroy();await server.close(); }
}).then(()=>{if(completed)app.exit(0);}).catch(async error=>{reportingFailure=true;fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'failure.txt'),String(error?.stack||error));console.error(error);
  if(win&&!win.isDestroyed()){
    fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());win.destroy();
  }await server?.close();app.exit(1);});
