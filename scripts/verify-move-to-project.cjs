// Move a chat to a project, by its menu or by dragging, with Undo, and date headings in the chat lists (#1919).
// Isolated renderer/Chromium acceptance; no backend.
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
const output = path.join(root, 'outputs/move-to-project');
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
    const projects = [{id:'demo-project',name:'Translations',path:'C:/demo',createdAt:1,chatgpt:{state:'linked',id:'g-p-'+'d'.repeat(32),updatedAt:1}},{id:'second-project',name:'Documentation',path:'C:/docs',createdAt:2}];
    // Few project chats: every drag below must fit on a CI screen, whatever its height.
    const titles = ['Spanish round 1','Spanish Q&A','Italian round 1'];
    const rows = titles.map((title,i)=>({id:'task-'+i,title,projectId:'demo-project',
      conversationId:'chat-'+i,chatIds:['chat-'+i],startedAt:1,updatedAt:Date.now()-i*9*3600000,endedAt:2,events:0,userMessages:0,
      toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,
      estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:null,agents:[],origin:null}));
    rows.push({...rows[0],id:'other-task',title:'Docs chat',projectId:'second-project',conversationId:'chat-x',chatIds:['chat-x'],updatedAt:Date.now()-45*86400000});
    // Chats outside any project, from today back to last year.
    const day = 86400000, now = Date.now();
    for (const [i,[title,age]] of [['Plan the trip',60000],['Grocery list',3600000],['Fix the printer',day+60000],['Tax questions',3*day],['Recipe ideas',12*day],['Old notes',400*day]].entries())
      rows.push({...rows[0],id:'loose-'+i,title,projectId:undefined,conversationId:'loose-chat-'+i,chatIds:['loose-chat-'+i],updatedAt:now-age});
    window.moveCalls = [];
    // The app's chat groups, with main's own rules: a chat only into its own project's group.
    const groups = {version:1,groups:[{id:'g-spanish',projectId:'demo-project',name:'Spanish',createdAt:1},{id:'g-italian',projectId:'demo-project',name:'Italian',createdAt:2}],members:{'task-0':'g-spanish','task-1':'g-spanish'}};
    const copy = () => JSON.parse(JSON.stringify(groups));
    const named = value => { const name = value.replace(/\\s+/g,' ').trim(); return name && [...name].length <= 60 ? name : null; };
    let next = 1;
    const ok=data=>Promise.resolve({ok:true,data});
    const fail=error=>Promise.resolve({ok:false,error});
    window.groupCalls = [];
    window.api = new Proxy({ getState:()=>ok(state),getLog:()=>ok([]),
      listProjects:()=>ok(projects),
      listSessions:options=>ok({sessions:options?.projectId?[]:rows,total:rows.length,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      getChatModels:()=>ok({state:'unknown',models:[]}),
      chatGroups:()=>ok(copy()),
      createChatGroup:(projectId,name)=>{ window.groupCalls.push(['create',projectId,name]); const clean=named(name); if(!clean) return fail('A group name needs 1 to 60 characters');
        const group={id:'g-new-'+(next++),projectId,name:clean,createdAt:Date.now()}; groups.groups.push(group); return ok({group:{...group},state:copy()}); },
      renameChatGroup:(id,name)=>{ window.groupCalls.push(['rename',id,name]); const group=groups.groups.find(g=>g.id===id); const clean=named(name); if(!group) return fail('This group no longer exists'); if(!clean) return fail('A group name needs 1 to 60 characters'); group.name=clean; return ok(copy()); },
      deleteChatGroup:id=>{ window.groupCalls.push(['delete',id]); groups.groups=groups.groups.filter(g=>g.id!==id); for(const [s,g] of Object.entries(groups.members)) if(g===id) delete groups.members[s]; return ok(copy()); },
      // Main's rules for a move (#1919): the chat leaves its old group; a group only in its new project.
      moveChatProject:(sessionId,projectId,groupId)=>{ window.moveCalls.push([sessionId,projectId,groupId??null]); const row=rows.find(r=>r.id===sessionId);
        if(!row) return fail('This chat no longer exists'); const from=row.projectId??null, fromGroup=groups.members[sessionId]??null;
        const group=groupId?groups.groups.find(g=>g.id===groupId):null; if(groupId&&(!group||group.projectId!==projectId)) return fail("This chat is not in that group's project");
        row.projectId=projectId??undefined; if(group) groups.members[sessionId]=groupId; else if(from!==projectId) delete groups.members[sessionId];
        return ok({from,fromGroup,groups:copy()}); },
      assignChatGroup:(sessionId,groupId)=>{ window.groupCalls.push(['assign',sessionId,groupId]); const row=rows.find(r=>r.id===sessionId); const group=groups.groups.find(g=>g.id===groupId);
        if(!row) return fail('This chat no longer exists'); if(groupId===null){delete groups.members[sessionId];return ok(copy());}
        if(!group) return fail('This group no longer exists'); if(group.projectId!==row.projectId) return fail("This chat is not in that group's project");
        groups.members[sessionId]=groupId; return ok(copy()); }
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
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,...iconFiles]}}, plugins:[{ name:'move-to-project-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request,response) => {
        const source = withoutScripts(fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8')).replace('</body>', '<script type="module">'+fixture+'</script></body>');
        response.setHeader('Content-Type','text/html'); response.end(await vite.transformIndexHtml('/fixture.html',source));
      });
    }}] });
  let win;
  try {
    await server.listen(); fs.mkdirSync(output,{recursive:true});
    // Tall enough that a dragged chat and the project it goes into are both on screen.
    win = new BrowserWindow({show:false,width:1100,height:1300,webPreferences:{sandbox:true,backgroundThrottling:false}});
    const js = code=>win.webContents.executeJavaScript(code);
    const until = async (code, message) => {
      for (let i=0;i<200;i++) { if (await js(code)) return; await new Promise(r=>setTimeout(r,15)); }
      assert.fail(message + ' — ' + code);
    };
    const screenshot = async name => {
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await new Promise(r=>setTimeout(r,200));
      fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    };
    const load = async query => {
      await win.loadURL(server.resolvedUrls.local[0]+'fixture.html'+query);
      win.webContents.setZoomFactor(1);
      await until('!!window.fixtureReady && document.querySelectorAll(".project-group").length === 2', 'fixture');
      await js(`Promise.all(['CoS Phosphor','CoS Phosphor Fill'].map(name=>document.fonts.load('16px "'+name+'"')))`);
      await js(`document.querySelector('[data-project-id="demo-project"] > summary').click()`);
      await until(`document.querySelectorAll('[data-project-id="demo-project"] > .chat-group').length === 2`, 'groups render in the open project');
      await js(`document.querySelector('[data-project-id="second-project"] > summary').click()`);
    };
    const groupsOf = `[...document.querySelectorAll('[data-project-id="demo-project"] > .chat-group')].map(g=>[g.querySelector('.chat-group-name').textContent,g.querySelector('.chat-group-count').textContent,[...g.querySelectorAll(':scope > .sess')].map(r=>r.dataset.id)])`;
    const loose = `[...document.querySelectorAll('[data-project-id="demo-project"] > .sess')].map(r=>r.dataset.id)`;
    const press = keyCode => { for (const type of ['keyDown','char','keyUp']) if (type!=='char'||keyCode==='Enter') win.webContents.sendInputEvent({type,keyCode:type==='char'?'\r':keyCode}); };
    const menuItems = `[...document.querySelectorAll('.row-menu')].at(-1) ? [...[...document.querySelectorAll('.row-menu')].at(-1).querySelectorAll('[data-row-action]')].map(i=>i.dataset.rowAction) : []`;

    const chats = `[...document.getElementById('chatList').children].map(n=>n.dataset.id ?? '# '+n.textContent)`;
    const toast = `document.querySelector('.toast')?.firstChild?.textContent ?? ''`;
    const place = id => `(() => { const row=document.querySelector('[data-id="${id}"]'); return row.closest('.chat-group')?.dataset.groupId ?? row.closest('.project-group')?.dataset.projectId ?? 'chats'; })()`;
    const year = String(new Date(Date.now()-400*86400000).getFullYear());
    // The Documentation chat is 45 days old: its month, or its year when that month was last year.
    const docsDate = new Date(Date.now()-45*86400000);
    const docsSection = docsDate.getFullYear() === new Date().getFullYear() ? docsDate.toLocaleString('en-US',{month:'long'}) : String(docsDate.getFullYear());
    await load('?reset=1');

    // Date headings: quiet text between the chats, oldest last, none for an empty span.
    assert.deepEqual(await js(chats), ['# Today','loose-0','loose-1','# Yesterday','loose-2','# Previous 7 days','loose-3','# Previous 30 days','loose-4','# '+year,'loose-5']);
    const look = await js(`(() => { const h=document.querySelector('#chatList .chat-date-section'), row=document.querySelector('#chatList .sess'), title=row.querySelector('.sess-top b');
      const s=getComputedStyle(h); return {left:Math.round(h.firstChild ? (()=>{const r=document.createRange();r.selectNodeContents(h);return r.getBoundingClientRect().left;})() : 0), title:Math.round(title.getBoundingClientRect().left), size:s.fontSize, weight:s.fontWeight, role:h.getAttribute('role')}; })()`);
    assert.ok(Math.abs(look.left-look.title) <= 1, 'headings align with the chat titles: '+JSON.stringify(look));
    assert.equal(look.role, 'heading');
    const inProject = await js(`(() => { const g=document.querySelector('[data-project-id="demo-project"]'), h=g.querySelector(':scope > .chat-date-section'), r=document.createRange(); r.selectNodeContents(h);
      return [Math.round(r.getBoundingClientRect().left), Math.round(g.querySelector(':scope > .sess .sess-top b').getBoundingClientRect().left)]; })()`);
    assert.ok(Math.abs(inProject[0]-inProject[1]) <= 1, 'project headings align with its chat titles: '+inProject);
    await js(`document.getElementById('chatList').scrollIntoView({block:'end'})`);
    await screenshot('date-sections.png');

    // Move to project from the chat's menu: the listed projects, then No project (checked here).
    await js(`document.querySelector('[data-id="loose-1"] .sess-menu').click()`);
    await until(`!!document.querySelector('.row-menu [data-row-action="move-to-project"]')`, 'chat menu has Move to project');
    await js(`document.querySelector('.row-menu [data-row-action="move-to-project"]').focus()`);
    press('Right');
    await until(`document.querySelectorAll('.row-menu').length === 2`, 'project submenu');
    assert.deepEqual(await js(menuItems), ['project-demo-project','project-second-project','project-none']);
    assert.equal(await js(`document.querySelector('[data-row-action="project-none"]').getAttribute('aria-checked')`), 'true');
    assert.deepEqual(await js(`[...document.querySelectorAll('.row-menu')].map(m=>{const r=m.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})`), [true,true], 'menu and submenu fit');
    await screenshot('move-to-project-menu.png');
    await js(`document.querySelector('[data-row-action="project-demo-project"]').click()`);
    await until(`${place('loose-1')} === 'demo-project'`, 'moved into Translations');
    await until(`(${toast}).startsWith('Moved to Translations')`, 'toast');
    assert.equal(await js(toast), 'Moved to Translations. ChatGPT keeps it where it was.');
    assert.equal(await js(`document.querySelector('.toast .toast-action')?.textContent`), 'Undo');
    const fits = await js(`(() => { const t=document.querySelector('.toast').getBoundingClientRect(), b=document.querySelector('.toast-action').getBoundingClientRect(); return t.left>=0&&t.right<=innerWidth&&b.right<=t.right&&b.top>=t.top&&b.bottom<=t.bottom; })()`);
    assert.equal(fits, true, 'the toast and its Undo fit');
    await screenshot('moved-toast.png');
    // Undo puts it back, under its date again.
    await js(`document.querySelector('.toast .toast-action').click()`);
    await until(`${place('loose-1')} === 'chats'`, 'undone');
    assert.equal(await js(toast), 'Move undone');
    assert.deepEqual(await js('window.moveCalls'), [['loose-1','demo-project',null],['loose-1',null,null]]);
    assert.deepEqual((await js(chats)).slice(0,3), ['# Today','loose-0','loose-1']);

    // Dragging a chat onto a project row moves it there; the row lights up while it would take it.
    await js(`document.querySelector('[data-project-id="demo-project"] > summary').click()`);
    // The window is only as tall as the screen (smaller on CI): the sidebar is scrolled so the middle
    // of a drag sits in the middle of the window, away from the edges that scroll it during a drag.
    const frame = (a, b) => js(`(() => { const one=document.querySelector('${a}').getBoundingClientRect(), two=document.querySelector('${b}').getBoundingClientRect();
      const list=document.querySelector('${a}').closest('.scroll'); list.scrollTop += (one.top+two.top)/2 - innerHeight/2; })()`)
      .then(() => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'));
    const at = sel => js(`(() => { const r=document.querySelector('${sel}').getBoundingClientRect(); return {x:Math.round(r.left+40),y:Math.round(r.top+r.height/2)}; })()`);
    await frame('[data-id="loose-0"] .sess-top', '[data-project-id="second-project"] > summary');
    const from = await at('[data-id="loose-0"] .sess-top'), onto = await at('[data-project-id="second-project"] > summary');
    assert.ok(from.y < await js('innerHeight') - 40 && onto.y > 40, 'both ends of the drag are on screen: '+JSON.stringify({from,onto}));
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...from});
    await new Promise(r=>setTimeout(r,25));
    win.webContents.sendInputEvent({type:'mouseMove',x:from.x,y:from.y-12});
    await new Promise(r=>setTimeout(r,25));
    win.webContents.sendInputEvent({type:'mouseMove',...onto});
    await until(`document.querySelector('[data-project-id="second-project"] > summary').classList.contains('is-drop-target')`, 'project row highlighted');
    assert.equal(await js(`document.querySelectorAll('.sort-before, .sort-after').length`), 0, 'no reorder marker while over a project');
    await screenshot('drag-onto-project.png');
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...onto});
    await until(`${place('loose-0')} === 'second-project'`, 'dropped into Documentation');
    assert.equal(await js(toast), 'Moved to Documentation');
    assert.equal(await js(`document.querySelectorAll('.is-drop-target').length`), 0);
    // A project's own chats are headed too: the moved chat is today's, the other one is old.
    assert.deepEqual(await js(`[...document.querySelectorAll('[data-project-id="second-project"] > .chat-date-section')].map(h=>h.textContent)`), ['Today', docsSection]);

    // Onto a group of another project: into that project and that group (the window is only as
    // tall as the screen, so the chat dragged is the one now near the top, in Documentation).
    // The drop's own click is swallowed for one frame (so it never opens the chat): wait it out.
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await js(`document.querySelector('[data-project-id="demo-project"] > summary').click()`);
    await until(`document.querySelector('[data-project-id="demo-project"]').open`, 'project open again');
    await frame('[data-id="loose-0"] .sess-top', '[data-group-id="g-italian"] > summary');
    const chat = await at('[data-id="loose-0"] .sess-top'), group = await at('[data-group-id="g-italian"] > summary');
    assert.ok(chat.y < await js('innerHeight') - 40 && group.y > 40, 'both ends of the drag are on screen: '+JSON.stringify({chat,group}));
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...chat});
    await new Promise(r=>setTimeout(r,25));
    win.webContents.sendInputEvent({type:'mouseMove',x:chat.x,y:chat.y-12});
    await new Promise(r=>setTimeout(r,25));
    win.webContents.sendInputEvent({type:'mouseMove',...group});
    await until(`document.querySelector('[data-group-id="g-italian"] > summary').classList.contains('is-drop-target')`, 'group highlighted');
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...group});
    await until(`${place('loose-0')} === 'g-italian'`, 'dropped into Italian');
    assert.deepEqual((await js('window.moveCalls')).at(-1), ['loose-0','demo-project','g-italian']);
    // Escape during a drag over a project drops nothing.
    const calls = (await js('window.moveCalls')).length;
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    // Translations folded, so the drag is short.
    await js(`document.querySelector('[data-project-id="demo-project"] > summary').click()`);
    await until(`!document.querySelector('[data-project-id="demo-project"]').open`, 'Translations folded');
    await frame('[data-id="other-task"] .sess-top', '[data-project-id="demo-project"] > summary');
    const third = await at('[data-id="other-task"] .sess-top');
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...third});
    await new Promise(r=>setTimeout(r,25));
    win.webContents.sendInputEvent({type:'mouseMove',x:third.x,y:third.y-12});
    await new Promise(r=>setTimeout(r,25));
    win.webContents.sendInputEvent({type:'mouseMove',...(await at('[data-project-id="demo-project"] > summary'))});
    await until(`document.querySelectorAll('.is-drop-target').length === 1`, 'highlighted before Escape');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(`document.querySelectorAll('.is-drop-target').length === 0`, 'highlight cleared');
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...(await at('[data-project-id="demo-project"] > summary'))});
    await new Promise(r=>setTimeout(r,100));
    assert.equal((await js('window.moveCalls')).length, calls, 'Escape cancels the drop');
    assert.equal(await js(place('other-task')), 'second-project');

    // The + on a project's row is labelled New chat.
    assert.equal(await js(`document.querySelector('[data-project-id="demo-project"] .project-new').getAttribute('aria-label')`), 'New chat in this project');
    assert.equal(await js(`[...document.querySelector('[data-project-id="demo-project"] .project-new i').classList].includes('ph-plus')`), true);
    await screenshot('sidebar-after-moves.png');

    await load('?reset=1&theme=light');
    await screenshot('date-sections-light.png');
    console.log(JSON.stringify({headings:true,menu:true,toast:true,undo:true,dragProject:true,dragGroup:true,escape:true,output}));
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error=>{console.error(error);app.exit(1)});
