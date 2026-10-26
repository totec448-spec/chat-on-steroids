// A linked project's ChatGPT Project can be changed or unlinked from its menu (Haz on #1757).
// Isolated renderer/Chromium acceptance with synthetic data; no backend, never ChatGPT.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename],
    { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { withoutScripts } = require('./ui-check-page.cjs');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const output = path.join(root, 'outputs/chatgpt-project-menu');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    if (new URL(location.href).searchParams.has('reset')) { localStorage.removeItem('chat-on-steroids.sidebar-order'); localStorage.removeItem('chat-on-steroids.sidebar-pins'); }
    localStorage.removeItem('cos.ui.language');
    ${fixtureConfigSource()}
    const config = fixtureConfig({
      roots: [{name:'demo',path:'C:/demo'}], readOnly:true,
      capabilities: {browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
      tunnel: {kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui: {minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:new URL(location.href).searchParams.get('theme')||'dark'},
      sessions: {record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000}, compaction:{auto:true,autoTokens:300000},
      multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    });
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      update:{current:'2.0.9',latest:null,stage:'idle',error:null,checkedAt:null}};
    const projects = [{id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',name:'Translations',path:'C:/demo',createdAt:1,chatgpt:{state:'linked',id:'g-p-translations',updatedAt:1}},
      {id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2',name:'Documentation',path:'C:/docs',createdAt:2}];
    const rows = ['Glossary','Style guide'].map((title,i)=>({id:'task-'+i,title,projectId:projects[i].id,
      conversationId:'chat-'+i,chatIds:['chat-'+i],startedAt:1,updatedAt:100-i,endedAt:2,events:0,userMessages:0,
      toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,
      estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:null,agents:[],origin:null}));
    const choices = () => [{id:'g-p-translations',name:'Translations',linkedTo:projects[0].chatgpt?.state==='linked'?{id:projects[0].id,name:'Translations'}:null},
      {id:'g-p-research',name:'Research',linkedTo:null}];
    const ok=data=>Promise.resolve({ok:true,data});
    window.linkCalls = [];
    window.api = new Proxy({ getState:()=>ok(state),getLog:()=>ok([]),
      listProjects:()=>ok(projects),
      listSessions:options=>ok({sessions:options?.projectId?[]:rows,total:rows.length,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      getChatModels:()=>ok({state:'unknown',models:[]}),
      chatgptProjectChoices:()=>ok(choices()),
      unlinkChatgptProject:id=>{ window.linkCalls.push(['unlink',id]); const p=projects.find(r=>r.id===id); delete p.chatgpt; return ok({...p}); }
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    const still=document.createElement('style'); still.textContent='*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.append(still);
    window.fixtureReady=true;
  `;
  // A verification worktree may share dependencies through a junction. Permit only the two
  // actual icon assets outside this checkout; never publish a missing-glyph screenshot as proof.
  const iconFiles = ['@phosphor-icons/web/regular/Phosphor.woff2', '@phosphor-icons/web/fill/Phosphor-Fill.woff2']
    .map(file => fs.realpathSync(require.resolve(file)));
  const server = await createServer({ configFile:false, root:path.join(root,'src/renderer'),
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,...iconFiles]}}, plugins:[{ name:'chatgpt-project-menu-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request,response) => {
        const source = withoutScripts(fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8')).replace('</body>', '<script type="module">'+fixture+'</script></body>');
        response.setHeader('Content-Type','text/html'); response.end(await vite.transformIndexHtml('/fixture.html',source));
      });
    }}] });
  let win;
  try {
    await server.listen(); fs.mkdirSync(output,{recursive:true});
    win = new BrowserWindow({show:false,width:1100,height:760,webPreferences:{sandbox:true,backgroundThrottling:false}});
    const js = code=>win.webContents.executeJavaScript(code);
    const until = async (code, message) => {
      for (let i=0;i<200;i++) { if (await js(code)) return; await new Promise(r=>setTimeout(r,15)); }
      assert.fail(message + ' — ' + code);
    };
    const screenshot = async (name, box) => {
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await new Promise(r=>setTimeout(r,200));
      fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(box,{stayHidden:true,stayAwake:true})).toPNG());
    };
    const linked = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1';
    const menuItems = `[...document.querySelectorAll('.row-menu [data-row-action]')].map(i=>i.dataset.rowAction)`;
    const openMenu = async () => {
      await js(`document.querySelector('[data-row-menu="project:${linked}"]').click()`);
      await until(`!!document.querySelector('.row-menu')`, 'project menu opens');
    };
    // The menu and every item: inside the window, one row height, an icon glyph each, labels whole.
    const menuFit = `(() => { const m=document.querySelector('.row-menu'); const r=m.getBoundingClientRect();
      const items=[...m.querySelectorAll('[data-row-action]')];
      return { inside: r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
        heights:[...new Set(items.map(i=>Math.round(i.getBoundingClientRect().height)))],
        glyphs: items.every(i=>{ const ico=i.querySelector('.ico'); return !ico || getComputedStyle(ico,'::before').content!=='none'; }),
        cut: items.some(i=>{ const s=i.querySelector('span:not(.ico)'); return s && s.scrollWidth>s.clientWidth+1; }),
        box:{x:Math.max(0,Math.floor(r.left)-16),y:Math.max(0,Math.floor(r.top)-16),width:Math.ceil(r.width)+32,height:Math.ceil(r.height)+32} }; })()`;
    const results = {};
    for (const theme of ['dark','light']) {
      await win.loadURL(server.resolvedUrls.local[0]+'fixture.html?reset=1&theme='+theme);
      await until('!!window.fixtureReady && document.querySelectorAll(".project-group").length === 2', 'fixture');
      await js(`Promise.all(['CoS Phosphor','CoS Phosphor Fill'].map(name=>document.fonts.load('16px "'+name+'"')))`);
      await openMenu();
      const items = await js(menuItems);
      // A linked project offers changing and unlinking, never "Choose" as if it had none.
      assert.ok(items.includes('chatgpt-change') && items.includes('chatgpt-unlink') && !items.includes('chatgpt-link'), JSON.stringify(items));
      assert.equal(items.indexOf('chatgpt-unlink'), items.indexOf('chatgpt-change') + 1, 'change and unlink sit together');
      const fit = await js(menuFit);
      assert.ok(fit.inside && fit.heights.length === 1 && fit.glyphs && !fit.cut, 'the menu fits, rows one height, icons drawn: ' + JSON.stringify(fit));
      await screenshot(`menu-linked-${theme}.png`, fit.box);
      // Change: the picker anchors to the row, offers a new one, shows the current one chosen.
      await js(`document.querySelector('.row-menu [data-row-action="chatgpt-change"]').click()`);
      await until(`!!document.querySelector('.chatgpt-project-picker')`, 'picker opens');
      const picker = await js(`(() => { const o=[...document.querySelectorAll('.chatgpt-project-picker [role="option"]')];
        const r=document.querySelector('.chatgpt-project-picker').getBoundingClientRect();
        return { options:o.map(x=>x.textContent), selected:o.map(x=>x.getAttribute('aria-selected')==='true'), inside:r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
          box:{x:Math.max(0,Math.floor(r.left)-16),y:Math.max(0,Math.floor(r.top)-16),width:Math.ceil(r.width)+32,height:Math.ceil(r.height)+32} }; })()`);
      assert.deepEqual(picker.options, ['New ChatGPT Project “Translations”', 'Translations', 'Research']);
      assert.deepEqual(picker.selected, [false, true, false]);
      assert.ok(picker.inside);
      await screenshot(`change-picker-${theme}.png`, picker.box);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      await until(`!document.querySelector('.chatgpt-project-picker')`, 'Escape closes the picker');
      // Unlink: the ChatGPT Project stays in ChatGPT, and the menu offers choosing one again.
      await openMenu();
      await js(`document.querySelector('.row-menu [data-row-action="chatgpt-unlink"]').click()`);
      await until(`(document.querySelector('.toast')?.textContent ?? '') === 'Unlinked. The ChatGPT Project stays in ChatGPT.'`, 'unlink toast');
      assert.deepEqual(await js('window.linkCalls'), [['unlink', linked]]);
      await openMenu();
      const after = await js(menuItems);
      assert.ok(after.includes('chatgpt-link') && !after.includes('chatgpt-unlink') && !after.includes('chatgpt-change'), JSON.stringify(after));
      results[theme] = { items, fit, picker: picker.options, after };
    }
    console.log('Passed: a linked project\'s menu offers Change and Unlink (both themes), the picker shows the current Project chosen with a new one first, and Unlink keeps the Project in ChatGPT.');
    fs.writeFileSync(path.join(output,'measurements.json'), JSON.stringify(results,null,2));
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error=>{console.error(error);app.exit(1)});
