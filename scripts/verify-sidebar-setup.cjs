// Isolated renderer/Chromium acceptance. No backend, provider, credentials or pairing.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename],
    { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const output = path.join(root, 'outputs/sidebar-setup');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    if (new URL(location.href).searchParams.has('reset')) localStorage.removeItem('chat-on-steroids.sidebar-order');
    localStorage.removeItem('cos.ui.language');
    ${fixtureConfigSource()}
    const config = fixtureConfig({
      roots: [{name:'demo',path:'C:/demo'}], readOnly:true,
      capabilities: {browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
      tunnel: {kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui: {minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark'},
      sessions: {record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000}, compaction:{auto:true,autoTokens:300000},
      multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    });
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      update:{current:'2.0.9',latest:null,stage:'idle',error:null,checkedAt:null}};
    const project = {id:'demo-project',name:'VideoClipper',path:'C:/demo',additionalPaths:['C:/shared'],createdAt:1};
    const projects = [project, {id:'second-project',name:'Documentation',path:'C:/docs',createdAt:2}];
    let chatFolderStates=[]; let chatFolderSerial=0;
    const rows = Array.from({length:22},(_,i)=>({id:'task-'+i,title:'Project chat '+(i+1),projectId:project.id,
      conversationId:'chat-'+i,chatIds:['chat-'+i],startedAt:1,updatedAt:100-i,endedAt:2,events:0,userMessages:0,
      toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,
      estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:null,agents:[],origin:null}));
    rows.push({...rows[0],id:'worker-child',title:'Worker child',conversationId:'worker-chat',chatIds:['worker-chat'],updatedAt:99.5,
      origin:{kind:'worker',fromSessionId:'task-1',agentId:'worker-1',task:'Fixture worker'}});
    const ok=data=>Promise.resolve({ok:true,data});
    window.api = new Proxy({ getState:()=>ok(state),getLog:()=>ok([]),
      listProjects:()=>ok(projects),listProjectChatFolders:()=>ok(chatFolderStates),listSessions:()=>ok({sessions:rows,total:23,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      createProjectChatFolder:(projectId,name)=>{const state={projectId,folders:[{id:'chat-folder-'+(++chatFolderSerial),name,createdAt:Date.now()}],assignments:{}};chatFolderStates=[...chatFolderStates.filter(row=>row.projectId!==projectId),state];return ok(state)},
      renameProjectChatFolder:(projectId,folderId,name)=>{const state=chatFolderStates.find(row=>row.projectId===projectId);state.folders=state.folders.map(folder=>folder.id===folderId?{...folder,name}:folder);return ok({...state,assignments:{...state.assignments}})},
      removeProjectChatFolder:(projectId,folderId)=>{const state=chatFolderStates.find(row=>row.projectId===projectId);state.folders=state.folders.filter(folder=>folder.id!==folderId);state.assignments=Object.fromEntries(Object.entries(state.assignments).filter(([,value])=>value!==folderId));return ok({...state,assignments:{...state.assignments}})},
      setSessionChatFolder:(projectId,sessionId,folderId)=>{const state=chatFolderStates.find(row=>row.projectId===projectId);if(folderId)state.assignments[sessionId]=folderId;else delete state.assignments[sessionId];return ok({...state,assignments:{...state.assignments}})},
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      getChatModels:()=>ok({state:'unknown',models:[]}),
      saveSettings:patch=>{state.config={...state.config,...patch};return ok(state)},
      addSetupProfile:name=>{
        const previous={id:config.tunnel.profileId??'default',name:config.tunnel.profileName??'Default',tunnelId:'',desktopTunnelId:'',pluginsTunnelId:''};
        config.setupProfiles=[...(config.setupProfiles??[]),previous];
        config.tunnel={...config.tunnel,profileId:'fixture-profile',profileName:name,profileEpoch:(config.tunnel.profileEpoch??0)+1};
        return ok(state);
      },
      removeSetupProfile:id=>{config.setupProfiles=config.setupProfiles.filter(p=>p.id!==id);return ok(state)}
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    const still=document.createElement('style'); still.textContent='*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.append(still);
    window.fixtureReady=true;
  `;
  // A worktree may share node_modules through a junction. Serve only these two pinned font
  // files outside the fixture root; do not disable Vite's filesystem boundary or expose a parent.
  const fontFiles = [['regular','Phosphor.woff2'],['fill','Phosphor-Fill.woff2']].map(([family,file]) =>
    fs.realpathSync(path.join(path.dirname(require.resolve('@phosphor-icons/web/'+family)),file)));
  const server = await createServer({ configFile:false, root:path.join(root,'src/renderer'),
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,...fontFiles]}}, plugins:[{ name:'sidebar-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request,response) => {
        const source = fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>', '<script type="module">'+fixture+'</script></body>');
        response.setHeader('Content-Type','text/html'); response.end(await vite.transformIndexHtml('/fixture.html',source));
      });
    }}] });
  let win;
  try {
    await server.listen(); fs.mkdirSync(output,{recursive:true});
    win = new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,backgroundThrottling:false}});
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html?reset=1');
    win.webContents.setZoomFactor(1);
    const js = code=>win.webContents.executeJavaScript(code);
    const screenshot = async name => {
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await new Promise(r=>setTimeout(r,200));
      fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    };
    for(let i=0;i<100 && !(await js('!!window.fixtureReady && document.querySelectorAll(".project-group > .sess").length === 5'));i++) await new Promise(r=>setTimeout(r,25));
    const iconFonts = await js(`(async () => {
      await document.fonts.ready;
      return { faces:[...document.fonts].filter(face=>face.family.includes('CoS Phosphor')).map(face=>({family:face.family,status:face.status})),
        resources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('.woff')).map(entry=>({url:entry.name,status:entry.responseStatus})) };
    })()`);
    assert.ok(iconFonts.faces.length===2 && iconFonts.faces.every(face=>face.status==='loaded'),
      'Sidebar icon font did not load: '+JSON.stringify(iconFonts));
    await js(`window.disclosureEvents=[]; for(const type of ['keydown','keypress','keyup','click']) document.addEventListener(type,e=>window.disclosureEvents.push({type,key:e.key,tag:e.target.tagName,cls:e.target.className,open:document.querySelector('.project-group')?.open}),true)`);
    // Project groups start closed. Exercise native summary activation before the
    // existing visible-row geometry, drag ordering and pagination checks.
    assert.equal(await js(`document.querySelector('.project-group').open`), false);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const headingPoint = await js(`(() => {const r=document.querySelector('.project-heading').getBoundingClientRect();return {x:Math.round(r.left+35),y:Math.round(r.top+r.height/2)}})()`);
    const expectDisclosure = async open => {
      for (let i=0;i<100;i++) {
        if (await js(`document.querySelector('.project-group').open === ${open}`)) return;
        await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(await js(`document.querySelector('.project-group').open`),open,
        JSON.stringify(await js(`({focus:document.activeElement.outerHTML.slice(0,250),events:window.disclosureEvents.slice(-12)})`)));
    };
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...headingPoint});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...headingPoint});
    await expectDisclosure(true);
    const folders = await js(`(() => { const group=document.querySelector('.project-group'); const rows=[...group.querySelectorAll('.project-folder-row')];
      return { paths:rows.map(row=>row.querySelector('.project-folder-path').textContent), roles:rows.map(row=>row.getAttribute('role')),
        primaryRemove:!!rows[0].querySelector('.project-folder-remove'), removeCount:group.querySelectorAll('.project-folder-remove').length,
        removeLabel:group.querySelector('.project-folder-remove')?.getAttribute('aria-label')??'',
        addLabel:group.querySelector('.project-folder-add')?.getAttribute('aria-label')??'' }; })()`);
    assert.deepEqual(folders.paths,['C:/demo','C:/shared'],'Project folder paths: '+JSON.stringify(folders));
    assert.deepEqual(folders.roles,['listitem','listitem'],'Project folder roles: '+JSON.stringify(folders));
    assert.equal(folders.primaryRemove,false); assert.equal(folders.removeCount,1);
    assert.match(folders.removeLabel,/C:\/shared/); assert.match(folders.addLabel,/VideoClipper/);
    await js(`document.querySelector('.project-heading').focus()`);
    for (const keyCode of ['Space','Enter']) {
      win.webContents.sendInputEvent({type:'keyDown',keyCode});
      // Enter's native summary activation uses the character event. Electron's
      // low-level keyDown/keyUp pair does not synthesize that part of typing.
      if (keyCode === 'Enter') win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode});
      await expectDisclosure(keyCode === 'Enter');
    }
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const geometry = await js(`(() => { const group=document.querySelector('.project-group');
      const title=group.querySelector('.project-name').getBoundingClientRect(), chat=group.querySelector('.sess-top b').getBoundingClientRect();
      return {title:title.left,chat:chat.left,count:group.querySelectorAll(':scope > .sess').length,color:getComputedStyle(document.getElementById('newChat')).color,
        icon:[...document.querySelector('#newChat i.ico').classList].find(name => name.startsWith('ph-') && name !== 'ph')}; })()`);
    assert.equal(geometry.count,5); assert.ok(Math.abs(geometry.title-geometry.chat)<1,JSON.stringify(geometry));
    assert.equal(geometry.color,'rgb(255, 255, 255)'); assert.equal(geometry.icon,'ph-pencil-simple');
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await new Promise(r=>setTimeout(r,200));
    const points=await js(`[...document.querySelectorAll('.project-group > .sess')].map(row=>{const r=row.getBoundingClientRect();return {x:Math.round(r.left+35),y:Math.round(r.top+r.height/2)}})`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...points[0]});
    await new Promise(r=>setTimeout(r,25));
    win.webContents.sendInputEvent({type:'mouseMove',...points[2],y:points[2].y+12});
    await new Promise(r=>setTimeout(r,40));
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...points[2],y:points[2].y+12});
    await new Promise(r=>setTimeout(r,40));
    const moved=await js(`[...document.querySelectorAll('.project-group > .sess')].map(row=>row.dataset.id)`);
    assert.deepEqual(moved,['task-1','task-2','task-0','task-3','task-4'],
      'Native chat drag: '+JSON.stringify({moved,points,geometry}));
    assert.equal(await js(`document.querySelector('.sess.is-sel') === null`),true);
    await new Promise(r=>setTimeout(r,200));
    await screenshot('sidebar.png');
    win.webContents.setZoomFactor(1.17);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true);
    await screenshot('sidebar-base-zoom.png');
    win.webContents.setZoomFactor(1);
    await js(`document.querySelector('.project-show-more').click()`);
    assert.equal(await js(`document.querySelectorAll('.project-group > .sess').length`),13);
    await js(`{const button=document.querySelector('.project-chat-folder-add');button.focus();button.click()}`);
    assert.equal(await js(`document.getElementById('chatFolderDialog')?.open`),true);
    await js(`document.querySelector('#chatFolderDialog input').value='Research';document.querySelector('#chatFolderDialog form').requestSubmit()`);
    for(let i=0;i<100 && !(await js(`document.querySelector('.project-chat-folder-name')?.textContent==='Research'`));i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`document.querySelector('.project-chat-folder-name')?.textContent`),'Research');
    assert.equal(await js(`document.activeElement?.dataset.sidebarFocus`),'chat-folder-add:demo-project');
    const moveControl = await js(`(() => { const select=document.querySelector('.project-group > .sess .sess-folder-select'); return {label:select?.getAttribute('aria-label'), options:[...select.options].map(option=>option.textContent)}; })()`);
    assert.match(moveControl.label,/folder/i); assert.deepEqual(moveControl.options,['Project root','Research']);
    await js(`(() => {
      const select=document.querySelector('.project-group > .sess .sess-folder-select');
      select.closest('.sess').querySelector('.sess-top').focus();select.focus();
      if(document.activeElement!==select)throw new Error('Move control must have keyboard focus before the change');
      select.value='chat-folder-1';select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    for(let i=0;i<100 && !(await js(`document.querySelector('.project-chat-folder .sess')?.dataset.id==='task-1'`));i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`document.querySelector('.project-chat-folder .sess')?.dataset.id`),'task-1');
    assert.equal(await js(`document.activeElement?.classList.contains('sess-folder-select')`),true);
    await js(`document.querySelector('.project-chat-folder .worker-toggle').click()`);
    assert.equal(await js(`document.querySelector('.project-chat-folder .worker-group .sess')?.dataset.id`),'worker-child');
    assert.equal(await js(`document.querySelector('.project-chat-folder .worker-group .sess-folder-select')===null`),true);
    const folderRow = await js(`(() => {
      const row=document.querySelector('.project-chat-folder > .sess');
      const title=row.querySelector('.sess-top b'), actions=row.querySelector('.sess-actions');
      const titleBounds=title.getBoundingClientRect(), actionBounds=actions.getBoundingClientRect(), bounds=row.getBoundingClientRect();
      return {titleWidth:title.clientWidth,titleContent:title.scrollWidth,titleBottom:titleBounds.bottom,actionsTop:actionBounds.top,actionsRight:actionBounds.right,rowRight:bounds.right};
    })()`);
    assert.ok(folderRow.titleWidth>=Math.min(folderRow.titleContent,120),'Folder controls must leave the chat title readable: '+JSON.stringify(folderRow));
    assert.ok(folderRow.actionsTop>=folderRow.titleBottom-1,'Folder actions belong below the title');
    assert.ok(folderRow.actionsRight<=folderRow.rowRight+1,'Folder actions must remain inside the row');
    await screenshot('chat-folders.png');
    await js(`{const button=document.querySelector('.project-chat-folder-action');button.focus();button.click()}`);
    await js(`document.querySelector('#chatFolderDialog input').value='Sources';document.querySelector('#chatFolderDialog form').requestSubmit()`);
    for(let i=0;i<100 && !(await js(`document.querySelector('.project-chat-folder-name')?.textContent==='Sources'`));i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`document.querySelector('.project-chat-folder-name')?.textContent`),'Sources');
    assert.match(await js(`document.activeElement?.dataset.sidebarFocus??''`),/^chat-folder-rename:/);
    await js(`(() => {
      const select=document.querySelector('.project-chat-folder .sess-folder-select');
      select.closest('.sess').querySelector('.sess-top').focus();select.focus();
      if(document.activeElement!==select)throw new Error('Move control must have keyboard focus before the change');
      select.value='';select.dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('newChat').focus();
    })()`);
    for(let i=0;i<100 && !(await js(`document.querySelector('.project-group > .sess')?.dataset.id==='task-1'`));i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`document.activeElement?.id`),'newChat');
    await js(`{const button=document.querySelectorAll('.project-chat-folder-action')[1];button.focus();button.click()}`);
    for(let i=0;i<100 && (await js(`document.querySelector('.project-chat-folder')!==null`));i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`document.querySelector('.project-chat-folder')===null`),true);
    assert.equal(await js(`document.activeElement?.dataset.sidebarFocus`),'chat-folder-add:demo-project');
    assert.equal(await js(`document.querySelector('.project-group > .sess')?.dataset.id`),'task-1');
    await js(`document.querySelector('.project-chat-folder-add').click();document.querySelector('#chatFolderDialog input').value='Temporary';document.querySelector('#chatFolderDialog form').requestSubmit()`);
    for(let i=0;i<100 && !(await js(`document.querySelector('.project-chat-folder-name')?.textContent==='Temporary'`));i++) await new Promise(r=>setTimeout(r,10));
    await js(`{const button=document.querySelectorAll('.project-chat-folder-action')[1];button.focus();button.click();document.getElementById('newChat').focus()}`);
    for(let i=0;i<100 && (await js(`document.querySelector('.project-chat-folder')!==null`));i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`document.activeElement?.id`),'newChat');
    await js(`document.querySelector('[data-tab="setup"]').click(); document.getElementById('wizExpand').click()`);
    assert.equal(await js(`document.getElementById('wizard').classList.contains('is-tidy')`),true);
    assert.equal(await js(`document.querySelector('[data-panel="setup"]').classList.contains('is-active')`),true);
    await new Promise(r=>setTimeout(r,200));
    await screenshot('setup-collapsed.png');
    await js(`document.getElementById('wizExpand').click()`);
    assert.equal(await js(`document.getElementById('wizard').classList.contains('is-tidy')`),false);
    assert.equal(await js(`document.querySelector('[data-panel="setup"]').contains(document.getElementById('setupProfile'))`),false);
    await new Promise(r=>setTimeout(r,100));
    await screenshot('setup-clean.png');
    await js(`document.querySelector('[data-tab="appearance"]').click(); document.getElementById('uiLanguage').scrollIntoView({block:'center'});`);
    for(const [width,zoom] of [[1100,1],[800,1],[1100,1.17],[800,1.17],[1100,1.5]]) {
      win.setSize(width,900); win.webContents.setZoomFactor(zoom);
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      await js(`document.getElementById('setupProfile').scrollIntoView({block:'center'});document.getElementById('setupProfile').click()`);
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const profileBounds = await js(`(() => {const r=document.getElementById('setupProfileMenu').getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewport:[innerWidth,innerHeight],open:document.getElementById('setupProfileMenu').matches(':popover-open')}})()`);
      assert.ok(profileBounds.width>0 && profileBounds.right<=profileBounds.viewport[0] && profileBounds.left>=0 && profileBounds.top>=0 && profileBounds.bottom<=profileBounds.viewport[1],JSON.stringify({width,zoom,profileBounds}));
      assert.equal(await js(`document.querySelector('[data-remove-profile-id]').disabled`),true);
      await js(`document.getElementById('setupProfileMenu').hidePopover()`);
    }
    win.setSize(1100,900);win.webContents.setZoomFactor(1);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await js(`document.getElementById('setupProfileAdd').click()`);
    assert.equal(await js(`document.getElementById('setupProfileDialog').open && document.activeElement.id==='setupProfileName'`),true);
    await js(`document.getElementById('setupProfileName').value='Work';document.getElementById('setupProfileForm').requestSubmit()`);
    for(let i=0;i<100 && await js(`document.getElementById('setupProfileDialog').open`);i++) await new Promise(r=>setTimeout(r,25));
    assert.equal(await js(`document.getElementById('setupProfileCurrent').textContent`),'Work');
    await js(`document.getElementById('setupProfile').scrollIntoView({block:'center'});document.getElementById('setupProfile').click()`);
    assert.equal(await js(`document.querySelectorAll('[data-remove-profile-id]:not(:disabled)').length`),2);
    const compactProfiles = await js(`(() => {
      const menu = document.getElementById('setupProfileMenu').getBoundingClientRect();
      const trigger = document.getElementById('setupProfile').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.setup-profile-option')].map(row => {
        const choice = row.firstElementChild.getBoundingClientRect();
        const remove = row.lastElementChild.getBoundingClientRect();
        return {left:choice.left, choiceRight:choice.right, removeLeft:remove.left, removeRight:remove.right};
      });
      return {width:menu.width, right:menu.right, triggerWidth:trigger.width, triggerRight:trigger.right, rows};
    })()`);
    // settings.css sizes the menu at min(260px, 100vw - 32px) since the 2026-09-28 Settings polish.
    assert.ok(compactProfiles.width >= compactProfiles.triggerWidth && compactProfiles.width <= 260, JSON.stringify(compactProfiles));
    assert.ok(Math.abs(compactProfiles.right - compactProfiles.triggerRight) <= 1, JSON.stringify(compactProfiles));
    for (const row of compactProfiles.rows) {
      assert.ok(compactProfiles.right - row.removeRight <= 12, JSON.stringify(compactProfiles));
      assert.ok(Math.abs(row.removeLeft - compactProfiles.rows[0].removeLeft) <= 1, JSON.stringify(compactProfiles));
      assert.ok(row.choiceRight <= row.removeLeft, JSON.stringify(compactProfiles));
    }
    // Wake the hidden fixture's compositor before retaining the final frame.
    await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await new Promise(r=>setTimeout(r,250));
    fs.writeFileSync(path.join(output,'settings-profiles.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    const longProfile = await js(`(() => {
      const choice = document.querySelector('.setup-profile-option > :first-child');
      const text = choice.textContent; choice.textContent = 'Long-profile-'.repeat(6);
      const menu = document.getElementById('setupProfileMenu');
      const bounds = menu.getBoundingClientRect();
      const label = choice.getBoundingClientRect();
      const remove = choice.nextElementSibling.getBoundingClientRect();
      const result = {width:bounds.width, left:bounds.left, right:bounds.right, viewport:innerWidth,
        labelRight:label.right, removeLeft:remove.left, removeRight:remove.right,
        overflow:menu.scrollWidth > menu.clientWidth + 1};
      choice.textContent = text;
      return result;
    })()`);
    assert.ok(longProfile.width <= 260 && longProfile.left >= 0 && longProfile.right <= longProfile.viewport, JSON.stringify(longProfile));
    assert.ok(longProfile.labelRight <= longProfile.removeLeft && !longProfile.overflow, JSON.stringify(longProfile));
    assert.ok(longProfile.right - longProfile.removeRight <= 12, JSON.stringify(longProfile));
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await new Promise(r=>setTimeout(r,50));
    assert.equal(await js(`document.getElementById('setupProfileMenu').matches(':popover-open')`),false);
    await js(`const language=document.getElementById('uiLanguage');language.value='zh-CN';language.dispatchEvent(new Event('change'));document.getElementById('setupProfile').click()`);
    assert.equal(await js(`document.getElementById('setupProfileLabel').textContent`),'连接配置');
    assert.equal(await js(`document.getElementById('setupProfileCurrent').textContent`),'Work');
    assert.equal(await js(`document.querySelector('[data-remove-profile-id="default"]').getAttribute('aria-label')`),'删除配置：Default');
    await js(`document.querySelector('[data-remove-profile-id="default"]').click()`);
    for(let i=0;i<100 && await js(`document.querySelectorAll('[data-remove-profile-id]').length!==1`);i++) await new Promise(r=>setTimeout(r,25));
    assert.equal(await js(`document.querySelector('[data-remove-profile-id]').disabled`),true);
    await js(`document.getElementById('newChat').click(); document.querySelector('[data-project-id="demo-project"] summary').click()`);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const projectPoints = await js(`[...document.querySelectorAll('.project-heading')].map(heading=>{const r=heading.getBoundingClientRect();return {x:Math.round(r.left+35),y:Math.round(r.top+r.height/2)}})`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...projectPoints[1]});
    win.webContents.sendInputEvent({type:'mouseMove',...projectPoints[0],y:projectPoints[0].y-8});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...projectPoints[0],y:projectPoints[0].y-8});
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const projectOrder = `[...document.querySelectorAll('.project-group')].map(group=>group.dataset.projectId)`;
    assert.deepEqual(await js(projectOrder),['second-project','demo-project']);
    assert.equal(await js(`document.querySelectorAll('[data-project-id="demo-project"] > .sess').length`),13);
    assert.equal(await js(`document.querySelector('.sess.is-sel') === null`),true);
    await js(`document.querySelector('[data-project-id="second-project"] summary').focus()`);
    for(const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({type,keyCode:'Down',modifiers:['alt']});
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.deepEqual(await js(projectOrder),['demo-project','second-project']);
    assert.equal(await js(`document.activeElement.closest('.project-group').dataset.projectId`),'second-project');
    for(const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({type,keyCode:'Up',modifiers:['alt']});
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.deepEqual(await js(projectOrder),['second-project','demo-project']);
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    for(let i=0;i<100 && !(await js('!!window.fixtureReady && document.querySelectorAll(".project-group").length === 2'));i++) await new Promise(r=>setTimeout(r,25));
    assert.deepEqual(await js(projectOrder),['second-project','demo-project']);
    await screenshot('project-order-restored.png');
    console.log(JSON.stringify({projectDisclosure:{initiallyCollapsed:true,pointer:true,space:true,enter:true},geometry,drag:moved,projectOrder:{pointer:true,keyboard:true,restored:true},showMore:13,collapse:true,profileLayout:compactProfiles,longProfile,output}));
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error=>{
  // Keep the actual assertion values in the bounded CI summary, which otherwise prints [Array].
  console.error('UI assertion error: '+JSON.stringify({message:error.message,actual:error.actual,expected:error.expected,stack:error.stack?.split('\n').slice(0,4)}));
  app.exit(1);
});
