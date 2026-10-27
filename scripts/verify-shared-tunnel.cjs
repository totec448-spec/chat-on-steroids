// The shared tunnel ID warning (#1340) in the production renderer: isolated Electron, no tunnel,
// credentials or user data. Setup's Core field and the Plugins dialog name the connector that
// shares the ID, while typing, and the warning goes away once each connector has its own.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const output = path.join(root, 'outputs/shared-tunnel');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  // Core and Plugins on one Secure Tunnel ID: the configuration from #1340.
  const fixture = `
    localStorage.removeItem('cos.ui.language');
    ${fixtureConfigSource()}
    const SHARED='tunnel_0123456789abcdef0123456789abcdef';
    const config = fixtureConfig({
      roots:[{name:'fixture',path:'C:/fixture'}],
      tunnel:{kind:'openai',tunnelId:SHARED,desktopTunnelId:'',pluginsTunnelId:SHARED,binaryPath:''},
      ui:{theme:location.hash.slice(1)||'dark',autoConnect:false,lastSeenVersion:'2.1.30'}
    });
    const state = {config,hasApiKey:true,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,settingsRecovered:false,
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
      pluginsSnapshot:()=>ok({plugins:[],catalog:[]}),
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
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules'))]}},plugins:[{name:'shared-tunnel-fixture',configureServer(vite) {
      vite.middlewares.use('/fixture.html',async (_req,res)=>{
        // The page's one script tag, by its exact text: the fixture loads main.ts itself, after the API.
        const entry='<script type="module" src="./main.ts"></script>';
        const page=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8');
        if(!page.includes(entry)) throw new Error('index.html no longer loads main.ts as this check expects');
        const html=page.replace(entry,'').replace('</body>','<script type="module">'+fixture+'</script></body>');
        res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/fixture.html',html));
      });
    }}]});
  let win;
  try {
    await server.listen();
    win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,backgroundThrottling:false}});
    const js=code=>win.webContents.executeJavaScript(code);
    const frame=()=>js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    // The app applies its own theme setting, so each theme is its own page load.
    const load=async theme=>{
      await win.loadURL(server.resolvedUrls.local[0]+'fixture.html#'+theme);
      for(let i=0;i<200 && !(await js('!!window.fixtureReady'));i++) await new Promise(resolve=>setTimeout(resolve,25));
      assert.equal(await js('!!window.fixtureReady'),true);
    };
    fs.mkdirSync(output,{recursive:true});
    const capture=async name=>{
      await new Promise(resolve=>setTimeout(resolve,300)); await js('document.getAnimations().forEach(animation=>{if(animation.effect?.getTiming().iterations!==Infinity)animation.finish();})'); await frame();
      fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    };
    const note=id=>js(`(() => {const n=document.getElementById('${id}'); return n ? {shown:!n.hidden && n.getBoundingClientRect().height>0, text:n.textContent} : null})()`);
    const openTunnel=`document.querySelector('[data-tab="setup"]').click();document.querySelector('[data-rail-step="tunnel"]').click();document.querySelector('[data-step="tunnel"]').scrollIntoView({block:'start'});`;

    for (const theme of ['light','dark']) {
      await load(theme);
      assert.equal(await js(`!!document.querySelector('dialog[open]')`),false,'No dialog covers Setup');
      // The assertions read English copy; the fixture otherwise follows this machine's language.
      await js(`document.querySelector('[data-language="en"]').click();${openTunnel}`);
      await frame();
      const core=await note('tunnelIdShared');
      assert.equal(core?.shown,true,'Setup shows the shared ID under the Core field');
      assert.match(core.text,/also set for Plugins\./);
      assert.match(core.text,/UNKNOWN_TOOL/);
      await capture(`setup-shared-${theme}`);
    }

    // A different draft ID clears the warning while typing, before anything is saved.
    await js(`(() => {const f=document.getElementById('tunnelId'); f.value='tunnel_fedcba9876543210fedcba9876543210'; f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await frame();
    assert.equal((await note('tunnelIdShared'))?.shown,false,'A distinct Core ID clears the warning');
    await capture('setup-distinct-dark');
    await js(`(() => {const f=document.getElementById('tunnelId'); f.value='tunnel_0123456789abcdef0123456789abcdef'; f.dispatchEvent(new Event('input',{bubbles:true}));})()`);

    // The Plugins setup dialog: the same warning under its own field, live as well.
    await js(`document.getElementById('pluginsSetupLink').click()`);
    for(let i=0;i<100 && !(await js(`!!document.getElementById('pluginsTunnelIdShared')`));i++) await new Promise(resolve=>setTimeout(resolve,25));
    const plugins=await note('pluginsTunnelIdShared');
    assert.equal(plugins?.shown,true,'The Plugins dialog shows the shared ID');
    assert.match(plugins.text,/also set for Core\./);
    await capture('plugins-dialog-shared-dark');
    await js(`(() => {const f=document.getElementById('pluginsTunnelId'); f.value='tunnel_fedcba9876543210fedcba9876543210'; f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await frame();
    assert.equal((await note('pluginsTunnelIdShared'))?.shown,false,'A distinct Plugins ID clears the warning');

    // German at a narrow width: the longer text still fits under the field.
    win.setContentSize(640,900);
    await js(`document.getElementById('pluginDialog')?.close();document.querySelector('[data-language="de"]').click();${openTunnel}`);
    await frame();
    assert.match((await note('tunnelIdShared')).text,/auch für Plugins eingetragen/);
    await capture('setup-shared-de-640');

    // #1872: a saved Plugins ID can be turned off again; only that ID is cleared, and the dialog closes.
    win.setContentSize(1100,900);
    await js(`document.querySelector('[data-language="en"]').click();document.querySelector('[data-tab="plugins"]')?.click();document.getElementById('pluginsSetupLink').click()`);
    for(let i=0;i<100 && !(await js(`!!document.getElementById('pluginsTunnelId')`));i++) await new Promise(resolve=>setTimeout(resolve,25));
    const offButton=`[...document.querySelectorAll('#pluginDialog button')].find(node=>node.textContent==='Turn off Plugins connection')`;
    assert.equal(await js(`!!${offButton}`),true,'The Plugins dialog offers to turn off a saved connection');
    await capture('plugins-dialog-turn-off');
    const saved=await js('window.saves.length');
    await js(`${offButton}.click()`);
    for(let i=0;i<100 && (await js('window.saves.length'))===saved;i++) await new Promise(resolve=>setTimeout(resolve,25));
    const patch=await js('window.saves.at(-1)');
    assert.equal(patch.tunnel.pluginsTunnelId,'','Turning off clears the Plugins ID');
    assert.equal(patch.tunnel.tunnelId,'tunnel_0123456789abcdef0123456789abcdef','Core keeps its ID');
    await frame();
    assert.equal(await js(`!!document.getElementById('pluginDialog')`),false,'The dialog closes');
    await js(`document.getElementById('pluginsSetupLink').click()`);
    for(let i=0;i<100 && !(await js(`!!document.getElementById('pluginsTunnelId')`));i++) await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(await js(`!!${offButton}`),false,'Nothing saved, nothing to turn off');
    await capture('plugins-dialog-off');
    console.log('Shared tunnel ID passed: Setup and the Plugins dialog name the other connector, live while typing, in both themes and German; a saved Plugins connection turns off.');
  } finally {
    win?.destroy();await server.close();
  }
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
