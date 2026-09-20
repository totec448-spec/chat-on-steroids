// Isolated production renderer. Mock IPC/localStorage models saves; IPC disk persistence
// and Core/Desktop delivery are covered by ipc.test.ts and mcp-user-instructions.test.ts.
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
const output = path.join(root, 'outputs/connector-instructions');
app.setPath('userData', path.join(output, 'runtime'));

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    const config = {
      roots:[],readOnly:true,
      capabilities:{browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
      tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui:{minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark'},
      sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},compaction:{auto:true,autoTokens:300000},
      multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture',objectivePrompt:'Fixture',loopPrompt:'Fixture'},
      mcp:{instructions:localStorage.getItem('fixture.instructions') ?? 'Keep changes focused.'}
    };
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      update:{current:'2.1.14',latest:null,stage:'idle',error:null,checkedAt:null}};
    const ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
    window.api=new Proxy({
      getState:()=>ok(state),getLog:()=>ok([]),
      listSessions:()=>ok({sessions:[],activeId:null,pressure:[]}),
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      saveSettings:patch=>{state.config={...state.config,...patch};localStorage.setItem('fixture.instructions',patch.mcp.instructions);return ok(state)}
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    window.fixtureReady=true;
  `;
  const server = await createServer({ configFile:false, root:path.join(root,'src/renderer'),
    server:{host:'127.0.0.1',port:0}, plugins:[{name:'connector-instructions-fixture',configureServer(vite) {
      vite.middlewares.use('/fixture.html',async (_request,response)=>{
        const source=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
          .replace('</body>','<script type="module">'+fixture+'</script></body>');
        response.setHeader('Content-Type','text/html');
        response.end(await vite.transformIndexHtml('/fixture.html',source));
      });
    }}] });
  let win;
  try {
    await server.listen();
    fs.mkdirSync(output,{recursive:true});
    win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,backgroundThrottling:false}});
    await win.webContents.session.clearStorageData();
    const errors=[];
    win.webContents.on('console-message',event=>{if(event.level==='error') errors.push(event.message);});
    const js=async code=>{
      try { return await win.webContents.executeJavaScript(code,true); }
      catch(error) { throw new Error(code+'; '+errors.join('\n'),{cause:error}); }
    };
    const waitFor=async expression=>{
      for(let i=0;i<200;i++) {
        if(await js(expression)) return;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw new Error('Timed out: '+expression+'; '+errors.join('\n'));
    };
    const settings=async ()=>{
      await waitFor('!!window.fixtureReady');
      await js(`document.querySelector('[data-tab="settings"]').click();document.getElementById('mcpInstructions').scrollIntoView({block:'center'})`);
    };
    const edit=async value=>{
      await js(`(() => {const field=document.getElementById('mcpInstructions');field.focus();field.select()})()`);
      await win.webContents.insertText(value);
      // Native focus transition commits the textarea's change event.
      await js(`document.getElementById('settingsSearch').focus()`);
      await waitFor('localStorage.getItem("fixture.instructions")==='+JSON.stringify(value.trim()));
    };
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    await settings();
    assert.equal(await js('document.getElementById("mcpInstructions").value'),'Keep changes focused.');
    const sample='Keep changes focused.\nRun the relevant tests before reporting success.';
    await edit(sample);
    await waitFor(`document.querySelector('.toast')?.textContent.includes('Instructions saved.')`);
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    await settings();
    assert.equal(await js('document.getElementById("mcpInstructions").value'),sample);
    await js(`(() => {const field=document.getElementById('mcpInstructions');field.focus();field.select()})()`);
    await win.webContents.insertText('x'.repeat(4001));
    assert.equal(await js('document.getElementById("mcpInstructions").value.length'),4000);
    await edit(' ');
    assert.equal(await js('document.getElementById("mcpInstructions").value'),'');
    await waitFor(`document.querySelector('.toast')?.textContent.includes('Instructions saved.')`);
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    await settings();
    assert.equal(await js('document.getElementById("mcpInstructions").value'),'');
    await edit(sample);
    const layouts=[];
    for(const language of ['en','es','zh-CN','zh-TW','ja']) {
      await js(`(() => {const control=document.getElementById('uiLanguage');control.value=${JSON.stringify(language)};control.dispatchEvent(new Event('change'))})()`);
      for(const width of [1100,720]) {
        win.setSize(width,900);
        await js(`document.getElementById('mcpInstructions').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        const geometry=await js(`(() => {
          const field=document.getElementById('mcpInstructions'),r=field.getBoundingClientRect(),pane=field.closest('.pane').getBoundingClientRect();
          return {left:r.left,right:r.right,width:innerWidth,paneLeft:pane.left,paneRight:pane.right,value:field.value,
            label:document.querySelector('label[for="mcpInstructions"]').textContent};
        })()`);
        assert.equal(geometry.value,sample);
        assert.ok(geometry.left>=0 && geometry.right<=geometry.width && geometry.left>=geometry.paneLeft && geometry.right<=geometry.paneRight,JSON.stringify(geometry));
        if(language!=='en') assert.notEqual(geometry.label,'Your own instructions');
        layouts.push({language,width,label:geometry.label});
        if(language==='en' && width===1100) {
          await js(`document.querySelector('.toast')?.remove()`);
          const rect=await js(`(() => {
            const pane=document.getElementById('mcpInstructions').closest('.pane'),heading=pane.previousElementSibling;
            const p=pane.getBoundingClientRect(),h=heading.getBoundingClientRect();
            return {x:Math.floor(p.x),y:Math.floor(h.y),width:Math.ceil(p.width),height:Math.ceil(p.bottom-h.y)};
          })()`);
          await win.webContents.capturePage(rect,{stayHidden:true,stayAwake:true});
          fs.writeFileSync(path.join(output,'connector-instructions.png'),(await win.webContents.capturePage(rect,{stayHidden:true,stayAwake:true})).toPNG());
        }
      }
    }
    console.log(JSON.stringify({edit:true,reload:true,clear:true,notification:true,nativeMaxLength:4000,layouts,output}));
  } finally {win?.destroy();await server.close();app.quit();}
}).catch(error=>{console.error(error);app.exit(1)});
