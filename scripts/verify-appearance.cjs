// Isolated renderer/Chromium acceptance. No backend, provider, credentials or pairing.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/appearance');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    localStorage.removeItem('chat-on-steroids.sidebar-order');
    localStorage.removeItem('cos.ui.language');
    const config = {
      roots: [{name:'demo',path:'C:/demo'}], readOnly:true,
      capabilities: {browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
      tunnel: {kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui: {minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark',tabsToKeepOpen:7,finishAction:'notify'},
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
      onStateChanged:callback=>{window.pushState=()=>callback(structuredClone(state));},
      saveSettings:async patch=>{if(window.rejectSave) {window.rejectSave=false;return {ok:false,error:'Fixture save rejected'};} window.savedPatches=(window.savedPatches??[]).concat([structuredClone(patch)]); if(window.holdSave) await new Promise(resolve=>window.releaseSave=resolve); state.config={...state.config,...patch};return {ok:true,data:structuredClone(state)}},
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
    window.fixtureState=state; window.fixtureReady=true;
  `;
  const server = await createServer({ configFile:false, root:path.join(root,'src/renderer'),
    server:{host:'127.0.0.1',port:0}, plugins:[{ name:'appearance-fixture', configureServer(vite) {
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
    const screenshot = async name => {
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await new Promise(r=>setTimeout(r,200));
      fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    };
    for(let i=0;i<100 && !(await js('!!window.fixtureReady && document.querySelectorAll(".project-group > .sess").length === 5'));i++) await new Promise(r=>setTimeout(r,25));
    assert.equal(await js('!!window.fixtureReady'),true);
    const change = async (id,value) => {
      await js(`(() => {const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await js('new Promise(r=>setTimeout(r,40))');
    };
    await js(`document.querySelector('[data-tab="appearance"]').click()`);
    assert.equal(await js(`document.getElementById('appearancePanel').classList.contains('is-active')`),true);
    await screenshot('default-dark.png');
    await change('appearance-accent-hex','#a855f7');
    await change('appearance-sidebar-hex','#35234c');
    await change('appearance-background-hex','#19151f');
    assert.equal(await js(`window.fixtureState.config.ui.appearance.dark.sidebar`),'#35234c');
    assert.equal(await js(`window.fixtureState.config.ui.tabsToKeepOpen`),7);
    assert.equal(await js(`window.fixtureState.config.ui.finishAction`),'notify');
    await screenshot('custom-purple.png');
    await change('appearanceTheme','light');
    assert.equal(await js(`document.getElementById('appearance-sidebar-hex').value`),'#E9EDF2');
    await change('appearance-sidebar-hex','#eec4df');
    await change('appearance-accent-hex','#8b2676');
    await screenshot('custom-light.png');
    await change('appearanceTheme','dark');
    assert.equal(await js(`document.getElementById('appearance-sidebar-hex').value`),'#35234C');
    await js(`document.getElementById('appearanceTranslucent').click()`);
    assert.equal(await js(`getComputedStyle(document.querySelector('.sidebar')).backdropFilter`),'none');
    await js(`document.getElementById('appearanceTranslucent').click()`);
    assert.ok((await js(`getComputedStyle(document.querySelector('.sidebar')).backdropFilter`)).includes('blur'));
    // Dirty HEX edits survive status pushes; invalid text cannot reach storage.
    await js(`window.countBefore=window.savedPatches.length;const hex=document.getElementById('appearance-sidebar-hex');hex.focus();hex.value='#12';hex.dispatchEvent(new Event('input',{bubbles:true}));window.pushState()`);
    assert.equal(await js(`document.getElementById('appearance-sidebar-hex').value`),'#12');
    assert.equal(await js(`window.savedPatches.length===window.countBefore`),true);
    await js(`document.getElementById('appearance-sidebar-hex').dispatchEvent(new Event('change',{bubbles:true}))`);
    assert.equal(await js(`document.getElementById('appearance-sidebar-hex').value`),'#35234C');
    // Two queued edits plus a stale push retain the latest request and save both colors.
    await js('window.holdSave=true');
    await change('appearance-accent-hex','#72ea34');
    await change('appearance-sidebar-hex','#23454e');
    await js('window.pushState()');
    assert.equal(await js(`document.documentElement.style.getPropertyValue('--accent-fill')`),'#72ea34');
    assert.equal(await js(`document.getElementById('appearance-sidebar-hex').value.toUpperCase()`),'#23454E');
    await js('window.holdSave=false;window.releaseSave()');
    await js('new Promise(r=>setTimeout(r,100))');
    assert.deepEqual(await js(`window.fixtureState.config.ui.appearance.dark`),{background:'#19151f',sidebar:'#23454e',accent:'#72ea34',contrast:60});
    await js('window.rejectSave=true');
    await change('appearance-sidebar-hex','#ff00ff');
    assert.equal(await js("window.fixtureState.config.ui.appearance.dark.sidebar"),'#23454e');
    assert.equal(await js("document.documentElement.style.getPropertyValue('--sidebar-color')"),'#23454e');
    await change('appearanceFont','serif');
    assert.ok((await js(`getComputedStyle(document.body).fontFamily`)).includes('Georgia'));
    await change('appearanceSize','18');
    assert.equal(await js(`Math.round(parseFloat(getComputedStyle(document.body).fontSize))`),18);
    const layout=[];
    for(const [width,zoom] of [[1100,1],[800,1.17],[1100,1.5],[640,1]]) {
      win.setSize(width,900); win.webContents.setZoomFactor(zoom);
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const geometry=await js(`(() => {const panel=document.getElementById('appearancePanel');return {viewport:innerWidth,scroll:panel.scrollWidth,width:panel.clientWidth,body:document.documentElement.scrollWidth};})()`);
      assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify({width,zoom,geometry}));
      assert.ok(geometry.body<=geometry.viewport+1,JSON.stringify(geometry));
      layout.push({windowWidth:width,zoom,...geometry});
    }
    await screenshot('large-text-narrow.png');
    win.setSize(1100,900);win.webContents.setZoomFactor(1);
    await js(`document.getElementById('appearanceReset').click()`);
    await js('new Promise(r=>setTimeout(r,100))');
    assert.equal(await js(`window.fixtureState.config.ui.appearance.fontSize`),14);
    assert.equal(await js(`window.fixtureState.config.ui.appearance.dark.sidebar`),'#1a2129');
    assert.equal(await js(`window.fixtureState.config.ui.appearance.light.sidebar`),'#e9edf2');
    // Reload the production renderer with the same saved settings snapshot.
    await js(`window.savedUi=structuredClone(window.fixtureState.config.ui);window.pushState()`);
    await change('appearance-sidebar-hex','#331155');
    const savedUi = await js('window.fixtureState.config.ui');
    await win.reload();
    for(let i=0;i<100 && !(await js('!!window.fixtureReady'));i++) await new Promise(r=>setTimeout(r,25));
    await js(`window.fixtureState.config.ui=${JSON.stringify(savedUi)};window.pushState();document.querySelector('[data-tab="appearance"]').click()`);
    assert.equal(await js(`document.getElementById('appearance-sidebar-hex').value`),'#331155');
    await change('uiLanguage','zh-CN');
    assert.equal(await js(`document.getElementById('appearanceTitle').textContent`),'外观');
    await screenshot('chinese.png');
    await change('uiLanguage','en');
    await js(`document.getElementById('backToChat').click();document.getElementById('chatInput').value='A workspace in your colors.'`);
    await screenshot('chat.png');
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({arbitraryColors:true,separateThemes:true,translucency:true,dirtyPush:true,queuedSave:true,saveFailureRollback:true,reload:true,reset:true,layout},null,2));
    console.log('Appearance Electron checks passed. '+output);
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error=>{console.error(error);app.exit(1)});
