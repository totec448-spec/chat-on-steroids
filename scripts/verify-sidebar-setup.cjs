// Isolated renderer/Chromium acceptance. No backend, provider, credentials or pairing.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/sidebar-setup');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    localStorage.removeItem('chat-on-steroids.sidebar-order');
    const config = {
      roots: [{name:'demo',path:'C:/demo'}], readOnly:true,
      capabilities: {browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
      tunnel: {kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui: {minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark'},
      sessions: {record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000}, compaction:{auto:true,autoTokens:300000},
      multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    };
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      update:{current:'2.0.9',latest:null,stage:'idle',error:null,checkedAt:null}};
    const project = {id:'demo-project',name:'VideoClipper',path:'C:/demo',createdAt:1};
    const rows = Array.from({length:22},(_,i)=>({id:'task-'+i,title:'Project chat '+(i+1),projectId:project.id,
      conversationId:'chat-'+i,chatIds:['chat-'+i],startedAt:1,updatedAt:100-i,endedAt:2,events:0,userMessages:0,
      toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,
      estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:null,agents:[],origin:null}));
    const ok=data=>Promise.resolve({ok:true,data});
    window.api = new Proxy({ getState:()=>ok(state),getLog:()=>ok([]),
      listProjects:()=>ok([project]),listSessions:()=>ok({sessions:rows,total:22,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
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
  const server = await createServer({ configFile:false, root:path.join(root,'src/renderer'),
    server:{host:'127.0.0.1',port:0}, plugins:[{ name:'sidebar-fixture', configureServer(vite) {
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
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    win.webContents.setZoomFactor(1);
    const js = code=>win.webContents.executeJavaScript(code);
    for(let i=0;i<100 && !(await js('!!window.fixtureReady && document.querySelectorAll(".project-group > .sess").length === 5'));i++) await new Promise(r=>setTimeout(r,25));
    const geometry = await js(`(() => { const group=document.querySelector('.project-group');
      const title=group.querySelector('.project-name').getBoundingClientRect(), chat=group.querySelector('.sess-top b').getBoundingClientRect();
      return {title:title.left,chat:chat.left,count:group.querySelectorAll(':scope > .sess').length,color:getComputedStyle(document.getElementById('newChat')).color,
        icon:document.querySelector('#newChat use').getAttribute('href')}; })()`);
    assert.equal(geometry.count,5); assert.ok(Math.abs(geometry.title-geometry.chat)<1,JSON.stringify(geometry));
    assert.equal(geometry.color,'rgb(255, 255, 255)'); assert.equal(geometry.icon,'#i-pencil');
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
    assert.deepEqual(moved,['task-1','task-2','task-0','task-3','task-4']);
    assert.equal(await js(`document.querySelector('.sess.is-sel') === null`),true);
    await new Promise(r=>setTimeout(r,200));
    fs.writeFileSync(path.join(output,'sidebar.png'),(await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('.project-show-more').click()`);
    assert.equal(await js(`document.querySelectorAll('.project-group > .sess').length`),13);
    await js(`document.querySelector('[data-tab="setup"]').click(); document.getElementById('wizExpand').click()`);
    assert.equal(await js(`document.getElementById('wizard').classList.contains('is-tidy')`),true);
    assert.equal(await js(`document.querySelector('[data-panel="setup"]').classList.contains('is-active')`),true);
    await new Promise(r=>setTimeout(r,200));
    fs.writeFileSync(path.join(output,'setup-collapsed.png'),(await win.webContents.capturePage()).toPNG());
    await js(`document.getElementById('wizExpand').click()`);
    assert.equal(await js(`document.getElementById('wizard').classList.contains('is-tidy')`),false);
    assert.equal(await js(`document.querySelector('[data-panel="setup"]').contains(document.getElementById('setupProfile'))`),false);
    await new Promise(r=>setTimeout(r,100));
    fs.writeFileSync(path.join(output,'setup-clean.png'),(await win.webContents.capturePage()).toPNG());
    await js(`document.getElementById('chatSettingsBtn').click(); document.getElementById('uiLanguage').scrollIntoView({block:'center'});`);
    for(const [width,zoom] of [[1100,1],[800,1],[1100,1.5]]) {
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
    // Wake the hidden fixture's compositor before retaining the final frame.
    await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await new Promise(r=>setTimeout(r,250));
    fs.writeFileSync(path.join(output,'settings-profiles.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
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
    console.log(JSON.stringify({geometry,drag:moved,showMore:13,collapse:true,profileLayout:true,output}));
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error=>{console.error(error);app.exit(1)});
