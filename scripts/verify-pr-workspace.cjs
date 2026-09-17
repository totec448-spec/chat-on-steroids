// Real Chromium acceptance of the current renderer source through Vite. Backend responses are
// synthetic, and the isolated window never opens a provider, tunnel or the user's app state.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/pr-workspace');
app.setPath('userData', path.join(output, 'runtime'));
fs.mkdirSync(output, { recursive: true });

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  let win;
  let server;
  const results = [];
  try {
    win = new BrowserWindow({ show: false, width: 1500, height: 1000,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    await win.loadURL('data:text/html,' + encodeURIComponent('<h1>Project preview</h1><p>Local synthetic PDF fixture.</p>'));
    const pdf = await win.webContents.printToPDF({ pageSize: 'A5' });
    const fixture = `
      localStorage.clear();
      window.fixtureErrors=[];
      window.addEventListener('error', event => window.fixtureErrors.push(event.message));
      window.addEventListener('unhandledrejection', event => window.fixtureErrors.push(String(event.reason)));
      const config={roots:[{name:'demo',path:'C:/demo'}],readOnly:false,
        capabilities:{browse:true,search:true,read:true,metadata:true,create:true,edit:true,move:true,deleteFile:true,command:true,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
        tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
        ui:{minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark'},
        sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},compaction:{auto:true,autoTokens:300000},
        multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
        goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}};
      const state={config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
        status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
        bridge:{running:true,port:8765,paired:true,present:true,lastSeenAt:Date.now(),extensionVersion:'2.1.13'},
        update:{current:'2.1.13',latest:null,stage:'idle',error:null,checkedAt:null}};
      const projects=[{id:'project-a',name:'Demo workspace',path:'C:/demo',createdAt:1},{id:'project-b',name:'Second project',path:'C:/demo-b',createdAt:1}];
      const rows=projects.map((p,i)=>({id:'task-'+i,title:i?'Second conversation':'Project review',projectId:p.id,
        conversationId:null,chatIds:[],startedAt:1,updatedAt:10-i,endedAt:2,events:2,userMessages:1,toolCalls:0,
        lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,estimatedTokens:0,contextTokens:0,
        lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:'completed',activeTurnId:null,agents:[],origin:{kind:'desktop'}}));
      rows.push({...rows[0],id:'standalone',title:'Standalone chat',projectId:undefined});
      const files={'README.md':'# Demo workspace\\n\\nProject files, local drafts and bounded previews.\\n','example.ts':'export const value = 1;\\r\\n'};
      const ok=data=>Promise.resolve({ok:true,data});
      const info=(projectId,name)=>({projectId,projectName:projects.find(p=>p.id===projectId).name,path:name,name,
        bytes:files[name]?.length??${pdf.length},modifiedAt:new Date(0).toISOString(),revision:'a'.repeat(64),
        binary:name.endsWith('.pdf'),text:files[name]??null,truncated:false,
        ...(name.endsWith('.pdf')?{pdfDataBase64:${JSON.stringify(pdf.toString('base64'))}}:{})});
      window.fixtureSaves=[]; window.fixtureAttached=[];
      const personal={id:'review',name:'Code review',description:'Read the complete change, check behavior and preserve existing work.',path:'/skills/review/SKILL.md',managed:true,scope:'managed',source:'managed',allowImplicitInvocation:true};
      const projectSkill={id:'project-check--repo-fixture',name:'Project checks',description:'Use this project’s build, conventions and verification routes.',path:'/demo/.agents/skills/check/SKILL.md',managed:false,scope:'repo',source:'repo-agents',allowImplicitInvocation:true};
      const diag={capturedAt:Date.now(),status:{connected:true,paired:true,compatible:true,extensionVersion:'2.1.13',extensionProtocol:14,appProtocol:14},
        preferences:{overwrite:true,durations:false},tab:{tab:17,isChat:true,bound:true,recorder:true,conversationId:'fixture-chat',
        page:{events:2,session:'fixture-session',requestId:'fixture-request',trace:[{requestId:'fixture-request',read:true,sent:true,confirmed:true,app:'request_id',tool:'read'}]}}};
      window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),getZoom:()=>ok(1),listProjects:()=>ok(projects),
        listSessions:()=>ok({sessions:rows,total:3,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
        getSession:id=>ok({events:[{seq:1,time:1,source:'extension',kind:'user_message',messageId:'question',message:{text:'Review this project',chars:19,truncated:false}},
          {seq:2,time:2,source:'extension',kind:'assistant_message',messageId:'answer',final:true,state:'final',message:{text:'The project workspace is ready for inspection.',chars:47,truncated:false}}],total:2,nextFrom:3}),
        getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),getChatModels:()=>ok({state:'unknown',models:[]}),
        skillLibrary:()=>ok({skills:[personal,projectSkill],roots:[],errors:[],includeInstructions:true}),
        listSkills:()=>ok([personal]),listInputs:()=>ok([]),getSessionPlan:()=>ok(null),browserPreferences:()=>ok({overwrite:true,durations:false}),
        companionDiagnostics:()=>ok(diag),internalBrowser:undefined,
        listProjectFiles:(id,directory='')=>ok({projectId:id,projectName:'Demo workspace',directory,truncated:false,
          entries:['README.md','example.ts','preview.pdf'].map(name=>({name,path:name,kind:'file',bytes:files[name]?.length??${pdf.length}}))}),
        watchProjectFiles:()=>ok(true),previewProjectFile:(id,name)=>ok(info(id,name)),
        attachProjectFile:(id,name)=>{window.fixtureAttached.push({id,name});return ok({id:'file-1',name,size:12,mimeType:'text/plain'});},
        saveProjectFile:(id,name,text)=>{files[name]=text;window.fixtureSaves.push({id,name,text});return ok({preview:info(id,name)});},
        writeClipboard:()=>ok(true),connect:()=>{state.status.state='connected';return ok(state)},disconnect:()=>{state.status.state='disconnected';return ok(state)}
      },{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:()=>ok(null)});
      await import('/main.ts');
      const {setLanguage,t}=await import('/i18n.ts');
      const {EditorView}=await import('@codemirror/view');
      window.fixture={setLanguage,t,readyConnection(){state.hasApiKey=true;config.tunnel.tunnelId='tunnel_'+'1'.repeat(32);},edit(text){const view=EditorView.findFromDOM(document.querySelector('.file-preview .cm-editor'));
        if(!view)throw new Error('Editor not ready');view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text}});}};
      window.fixtureReady=true;
    `;
    server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
      server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'pr-workspace-fixture', configureServer(vite) {
        vite.middlewares.use('/fixture.html', async (_request, response) => {
          const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace('</body>', '<script type="module">' + fixture + '</script></body>');
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/fixture.html', source));
        });
      } }] });
    await server.listen();
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) {
        const detail = await win.webContents.executeJavaScript('({errors:window.fixtureErrors,buttons:[...document.querySelectorAll(".file-preview button")].map(b=>({title:b.title,text:b.textContent})),preview:document.querySelector(".file-preview")?.textContent.slice(0,1000)})').catch(() => null);
        throw new Error(`Renderer script failed: ${code}\n${JSON.stringify(detail)}\n${error.message}`);
      }
    };
    const until = async expression => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
      throw new Error('Renderer condition timed out: ' + expression + ' ' + JSON.stringify(await js('window.fixtureErrors')));
    };
    const screenshot = async name => {
      await js('document.getAnimations().forEach(animation => { if (animation.effect.getTiming().iterations !== Infinity) animation.finish(); })');
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 120));
      fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    await until('window.fixtureReady && document.querySelectorAll(".sess[data-id]").length===3');
    assert.equal(await js('document.querySelectorAll("#projectList .sess[data-id]").length'),2);
    assert.equal(await js('document.querySelectorAll("#chatList .sess[data-id]").length'),1);
    await js(`document.querySelector('.sess[data-id="task-0"]').click()`);
    await until('!document.getElementById("filePanelToggle").hidden');
    await js(`document.getElementById('filePanelToggle').click()`);
    await until('document.querySelectorAll(".file-tree-row[data-path]").length>=3');
    await js(`document.querySelector('.file-tree-row[data-path="README.md"]').click()`);
    await until('!!document.querySelector(".file-preview-markdown h1")');
    for (const [width, height, zoom, language] of [[1500,1000,1.17,'en'],[1100,850,1,'es'],[820,740,1.17,'es'],[1100,850,1.17,'zh-TW']]) {
      win.setSize(width,height); win.webContents.setZoomFactor(zoom);
      await js(`window.fixture.setLanguage(${JSON.stringify(language)}); new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
      const measured = await js(`(()=>{const r=document.querySelector('.file-panel').getBoundingClientRect();return {
        fits:r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,width:r.width,height:r.height,
        title:document.querySelector('.file-panel').getAttribute('aria-label'),overflow:document.documentElement.scrollWidth>innerWidth};})()`);
      assert.ok(measured.fits && !measured.overflow && measured.width>200,JSON.stringify({width,zoom,measured}));
      results.push({width,height,zoom,language,...measured});
      await screenshot(`files-${language}-${width}`);
    }
    win.setSize(1500,1000); win.webContents.setZoomFactor(1.17);
    await js(`window.fixture.setLanguage('en');document.querySelector('.file-tree-row[data-path="example.ts"]').click()`);
    await until('!!document.querySelector(".file-preview .cm-editor")');
    await js(`document.querySelector('.file-preview [title="Edit"]').click()`);
    await until('!!document.querySelector(".file-editor-save")');
    await js(`window.fixture.edit('export const value = 2;')`);
    await js(`document.querySelector('.sess[data-id="task-1"]').click();document.querySelector('.sess[data-id="task-0"]').click()`);
    await until('!!document.querySelector(".file-editor-save") && document.querySelector(".file-preview .cm-content")?.textContent.includes("value = 2")');
    await js(`document.querySelector('.file-editor-save').click()`);
    await until('window.fixtureSaves.length===1');
    assert.equal(await js('window.fixtureSaves[0].text'),'export const value = 2;');
    await until('!document.querySelector(".file-editor-save")');
    await screenshot('editor-saved');
    await js(`document.querySelector('.file-tree-row[data-path="preview.pdf"]').click()`);
    await until('!!document.querySelector(".file-pdf-canvas:not([hidden])")');
    assert.ok(await js(`(()=>{const c=document.querySelector('.file-pdf-canvas');return c.width*c.height>100&&c.width*c.height<=16*1024*1024;})()`));
    await screenshot('pdf-rendered');
    await js(`document.getElementById('sidebarConnection').click();document.getElementById('connectionAdvanced').open=true`);
    await until('document.getElementById("connectionPipelineWhy").textContent.includes("matched to recorded tool activity")');
    const bounds=await js(`(()=>{const r=document.getElementById('connectionPopover').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,fits:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};})()`);
    assert.equal(bounds.fits,true,JSON.stringify(bounds));
    await screenshot('connection-diagnostics');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await js('document.getElementById("connectionPopover").hidden'),true);
    assert.equal(await js('document.activeElement.id'),'sidebarConnection');
    await js(`document.getElementById('filePanelToggle').click();document.getElementById('sidebarPlugins').click()`);
    assert.equal(await js('document.querySelector(".app").dataset.screen'),'library');
    assert.equal(await js('document.getElementById("sidebarPrimary").hidden'),false);
    await js(`document.querySelector('[data-new-project="project-b"]').click()`);
    await until('document.querySelector(".app").dataset.screen==="chat"');
    assert.ok(await js('document.getElementById("chatInput").placeholder.includes("Second project")'));
    await js(`document.querySelector('.sess[data-id="task-0"]').click()`);
    await until('document.querySelector(".app").dataset.screen==="chat"');
    await js(`(()=>{const input=document.getElementById('chatInput');input.value='/re\\nCheck all changes and keep my draft.';input.setSelectionRange(3,3);input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until('!document.getElementById("skillPicker").hidden && document.querySelector(".skill-choice[data-skill-id=review]")');
    await screenshot('skills-library');
    await js(`document.querySelector('.skill-choice[data-skill-id="review"]').click()`);
    assert.equal(await js('document.querySelectorAll(".composer-selected-skill").length'),1);
    assert.equal(await js('document.getElementById("chatInput").value'),'Check all changes and keep my draft.');
    await js(`document.querySelector('.sess[data-id="task-1"]').click()`);
    await until('document.querySelectorAll(".composer-selected-skill").length===0');
    await js(`document.querySelector('.sess[data-id="task-0"]').click()`);
    await until('document.querySelectorAll(".composer-selected-skill").length===1');
    await js(`(()=>{const i=document.getElementById('chatInput');i.value='/project\\n'+i.value;i.setSelectionRange(8,8);i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until('!document.getElementById("skillPicker").hidden');
    await js(`document.querySelector('.skill-choice[data-skill-id="project-check--repo-fixture"]').click()`);
    assert.equal(await js('document.querySelectorAll(".composer-selected-skill").length'),2);
    const composer = await js(`(()=>{const chip=document.getElementById('composerSelectedSkills').getBoundingClientRect(),input=document.getElementById('chatInput').getBoundingClientRect(),send=document.querySelector('.send-control').getBoundingClientRect();return {chipBottom:chip.bottom,inputTop:input.top,inputBottom:input.bottom,sendTop:send.top,fits:chip.bottom<=input.top+1&&input.bottom<=send.top+1};})()`);
    assert.equal(composer.fits,true,JSON.stringify(composer));
    await screenshot('skills-selected-sidebar');
    for (const language of ['es','zh-TW']) {
      win.setSize(820,740); win.webContents.setZoomFactor(1.17);
      await js(`window.fixture.setLanguage(${JSON.stringify(language)});(()=>{const i=document.getElementById('chatInput');i.value='/';i.setSelectionRange(1,1);i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await until('!document.getElementById("skillPicker").hidden');
      const bounds=await js(`(()=>{const r=document.getElementById('skillPicker').getBoundingClientRect();return {fits:r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
      assert.ok(bounds.fits && !bounds.overflow,JSON.stringify(bounds));
      await screenshot(`skills-${language}-narrow`);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    }
    win.setSize(1500,1000); win.webContents.setZoomFactor(1.17);
    await js(`document.querySelector('[data-tab=appearance]').click();window.fixture.setLanguage('es');document.getElementById('uiLanguage').scrollIntoView({block:'center'})`);
    assert.equal(await js('document.getElementById("uiLanguage").value'),'es');
    await screenshot('spanish-settings');
    await js(`window.fixture.setLanguage('zh-TW')`);
    assert.equal(await js('document.getElementById("uiLanguage").value'),'zh-TW');
    await screenshot('traditional-chinese-settings');
    // Every opening is compact, including when translucency creates a sidebar stacking context.
    await js(`document.documentElement.dataset.translucentSidebar='true';document.getElementById('sidebarConnection').click()`);
    assert.equal(await js('document.getElementById("connectionAdvanced").open'),false);
    assert.equal(await js('document.getElementById("connectionPopoverSettings")'),null);
    assert.equal(await js('document.getElementById("connectionAdvancedOverwrite")'),null);
    await js(`document.getElementById('connectionAdvanced').open=true;document.getElementById('connectionRuntime').open=true;document.getElementById('sidebarConnection').click();document.getElementById('sidebarConnection').click()`);
    assert.equal(await js('document.getElementById("connectionAdvanced").open || document.getElementById("connectionRuntime").open'),false);
    await screenshot('connection-compact');
    await js(`document.getElementById('sidebarConnection').click();document.getElementById('viewMenu').open=true`);
    assert.ok(await js(`(()=>{const n=document.getElementById('zoomIn'),r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`));
    await screenshot('view-menu');
    await js(`document.getElementById('viewMenu').open=false;document.querySelector('[data-tab=appearance]').click();window.fixture.setLanguage('en')`);
    const heights=await js(`['appearanceFont','appearanceSize','setupProfile'].map(id=>{const n=document.getElementById(id).closest('.setting');return n.getBoundingClientRect().height})`);
    assert.ok(Math.max(...heights)-Math.min(...heights)<2,JSON.stringify(heights));
    await screenshot('appearance-aligned');
    await js(`document.querySelector('[data-tab=setup]').click();window.fixture.setLanguage('es')`);
    const setup=await js(`(()=>{const h=document.querySelector('.setup-heading');return {display:getComputedStyle(h).display,columns:getComputedStyle(h).gridTemplateColumns}})()`);
    assert.equal(setup.display,'grid'); await screenshot('setup-spanish-aligned');
    await js(`document.getElementById('backToChat').click();const input=document.getElementById('chatInput');input.value='/';input.setSelectionRange(1,1);input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await until('!document.getElementById("skillPicker").hidden && document.querySelector(".skill-choice")');
    assert.equal(await js('document.getElementById("sidebarSkills")'),null);
    assert.equal(await js('document.querySelector(".skill-add")'),null);
    await screenshot('slash-commands-skills');
    await js(`document.getElementById('composerAddSkill').closest('details').open=true`);
    assert.ok(await js(`(()=>{const n=document.getElementById('composerAddSkill'),r=n.getBoundingClientRect();return r.width>0&&r.height>0&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`));
    await js(`document.getElementById('composerAddSkill').click()`);
    assert.ok(await js('document.getElementById("chatInput").value.startsWith("Please add the following skills to my COS skills:")'));
    await js(`window.fixture.readyConnection();document.getElementById('headerConnect').click()`);
    await until('document.getElementById("headerConnect").hidden && document.getElementById("sidebarConnection").classList.contains("is-connected")');
    const errors=await js('window.fixtureErrors');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({renderer:'current source in Chromium; synthetic backend',results,save:true,draftRoundTrip:true,pdf:true,diagnostics:bounds,skillsDraftRoundTrip:true,sharedLibrary:true,sidebar:true,composer,errors},null,2));
    console.log('PASS: current renderer Files layouts, real editor draft navigation, PDF rendering, diagnostics, Skills chips/shared library, Projects/Chats, Spanish and Traditional Chinese. '+output);
  } finally { win?.destroy(); await server?.close(); }
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});

