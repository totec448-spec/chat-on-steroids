// Setup's access step in the production renderer: isolated Electron, no tunnel, credentials or user data.
// Checks that the step and Workspace share one set of permission switches, and captures its states.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const output = path.join(root, 'outputs/setup-access');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  // Read-only with the historical narrow permissions: what a pre-2.0 config or a recovered settings file loads as.
  const fixture = `
    localStorage.removeItem('cos.ui.language');
    ${fixtureConfigSource()}
    const config = fixtureConfig({
      roots:[{name:'fixture',path:'C:/fixture'}],readOnly:true,
      capabilities:{browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
      tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui:{theme:'dark',autoConnect:false}
    });
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,settingsRecovered:true,
      platform:{family:'windows',desktopAutomation:true},
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      update:{current:'2.1.30',latest:null,stage:'idle',error:null,checkedAt:null}};
    const ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
    window.saves=[];
    window.api = new Proxy({
      getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions:[],total:0,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      getChatModels:()=>ok({state:'unknown',models:[]}),
      saveSettings:patch=>{
        window.saves.push(structuredClone(patch));
        Object.assign(state.config,structuredClone(patch));
        if(!state.config.readOnly) state.settingsRecovered=false;
        return ok(state);
      }
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    window.fixtureReady=true;
  `;
  const server = await createServer({configFile:false,root:path.join(root,'src/renderer'),
    server:{host:'127.0.0.1',port:0},plugins:[{name:'setup-access-fixture',configureServer(vite) {
      vite.middlewares.use('/fixture.html',async (_req,res)=>{
        const html=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
          .replace('</body>','<script type="module">'+fixture+'</script></body>');
        res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/fixture.html',html));
      });
    }}]});
  let win;
  try {
    await server.listen();
    win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,backgroundThrottling:false}});
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    const js=code=>win.webContents.executeJavaScript(code);
    const frame=()=>js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    for(let i=0;i<200 && !(await js('!!window.fixtureReady'));i++) await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(await js('!!window.fixtureReady'),true);
    fs.mkdirSync(output,{recursive:true});
    const capture=async name=>{
      // A hidden window can hold an entrance animation at its first frame, so they are finished here.
      await new Promise(resolve=>setTimeout(resolve,300)); await js('document.getAnimations().forEach(animation=>{if(animation.effect?.getTiming().iterations!==Infinity)animation.finish();})'); await frame();
      fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    };
    const openAccess=`document.querySelector('[data-tab="setup"]').click();document.querySelector('[data-rail-step="access"]').click();document.querySelector('[data-step="access"]').scrollIntoView({block:'start'});`;

    // The assertions read English copy; the fixture otherwise follows this machine's language.
    await js(`document.querySelector('[data-language="en"]').click();${openAccess}`);
    assert.deepEqual(await js(`(() => ({open:document.querySelector('[data-step="access"]').classList.contains('is-open'),
      done:document.querySelector('[data-step="access"]').classList.contains('is-done'),
      chosen:[...document.querySelectorAll('[data-access]')].filter(o=>o.getAttribute('aria-checked')==='true').map(o=>o.dataset.access),
      recovered:!document.getElementById('accessRecovered').hidden}))()`),{open:true,done:true,chosen:['read'],recovered:true});
    // One set of switches, now in Setup: Workspace's own surface, not a copy.
    assert.deepEqual(await js(`(() => ({switches:document.querySelectorAll('[data-cap]').length,
      inSetup:!!document.querySelector('#accessFineSlot > .settings-surface #groups'),
      inWorkspace:!!document.querySelector('.workspace-permissions #groups')}))()`),{switches:13,inSetup:true,inWorkspace:false});
    await capture('read-only-dark');

    // Read-only still finishes the step, and Ready says what is limited and leads back to change it.
    await js(`document.querySelector('[data-rail-step="ready"]').click();document.querySelector('[data-step="ready"]').scrollIntoView({block:'start'})`);
    assert.deepEqual(await js(`(() => ({limited:!document.getElementById('readyLimited').hidden,
      row:document.querySelector('#readyChecks .ready-check.is-limited')?.textContent}))()`),{limited:true,row:'ChatGPT can only read files'});
    await capture('ready-limited-dark');
    await js(`document.getElementById('readyChangeAccess').click()`);
    assert.equal(await js(`document.querySelector('[data-step="access"]').classList.contains('is-open')`),true);

    // The fine control is the Workspace list: turning one switch on saves the same config.
    await js(`document.getElementById('accessFine').open=true;document.getElementById('accessFine').scrollIntoView({block:'start'})`);
    await capture('fine-control-open-dark');

    await js(`document.querySelector('[data-access="full"]').click()`);
    for(let i=0;i<100 && !(await js('window.saves.length'));i++) await new Promise(resolve=>setTimeout(resolve,25));
    const saved=await js('window.saves.at(-1)');
    assert.equal(saved.readOnly,false);
    assert.ok(Object.values(saved.capabilities).every(Boolean),'Full access turns every permission on');
    await frame();
    assert.deepEqual(await js(`(() => ({done:document.querySelector('[data-step="access"]').classList.contains('is-done'),
      chosen:[...document.querySelectorAll('[data-access]')].filter(o=>o.getAttribute('aria-checked')==='true').map(o=>o.dataset.access),
      recovered:!document.getElementById('accessRecovered').hidden,
      command:document.querySelector('[data-cap="command"]').checked}))()`),{done:true,chosen:['full'],recovered:false,command:true});
    await js(`document.querySelector('[data-step="access"]').scrollIntoView({block:'start'})`);
    await capture('full-access-dark');

    // A switch in the fine control is a Workspace edit: Files and terminal minus delete is custom.
    await js(`document.querySelector('[data-access="files"]').click()`);
    await frame();
    await js(`(() => {const box=document.querySelector('[data-cap="deleteFile"]');box.checked=false;box.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await frame();
    assert.deepEqual(await js(`[...document.querySelectorAll('[data-access]')].filter(o=>o.getAttribute('aria-checked')==='true').map(o=>o.dataset.access)`),[]);
    assert.equal(await js(`document.getElementById('accessNote').textContent`),'Custom permissions, set in Workspace.');

    // Back in Workspace, the same switches are there and show the same state.
    await js(`document.querySelector('[data-tab="home"]').click()`);
    assert.deepEqual(await js(`(() => ({switches:document.querySelectorAll('[data-cap]').length,
      inWorkspace:!!document.querySelector('.workspace-permissions > .settings-surface #groups'),
      deleteFile:document.querySelector('[data-cap="deleteFile"]').checked,
      screen:document.querySelector('[data-cap="screen"]').checked}))()`),{switches:13,inWorkspace:true,deleteFile:false,screen:false});
    await capture('workspace-after');

    // Other widths and languages over the read-only state the step exists for.
    await js(`document.querySelector('[data-access="read"]').click()`);
    await frame();
    for (const [name,width,height,language] of [['read-only-pt-BR-800',800,760,'pt-BR'],['read-only-de-640',640,900,'de'],['read-only-ja-1100',1100,900,'ja']]) {
      win.setContentSize(width,height);
      await js(`document.querySelector('[data-language="${language}"]').click();${openAccess}`);
      await capture(name);
    }
    console.log('Setup access passed: read-only reason, one shared set of switches, Full access and custom saves, Workspace round trip.');
  } finally {
    win?.destroy();await server.close();
  }
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
