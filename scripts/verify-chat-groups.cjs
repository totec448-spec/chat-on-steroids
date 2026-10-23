// Chat groups inside a project (#1038). Isolated renderer/Chromium acceptance; no backend.
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
const output = path.join(root, 'outputs/chat-groups');
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
    const projects = [{id:'demo-project',name:'Translations',path:'C:/demo',createdAt:1},{id:'second-project',name:'Documentation',path:'C:/docs',createdAt:2}];
    const titles = ['Spanish round 1','Spanish Q&A','Italian round 1','Glossary','Style guide','Release notes','Review','Changelog'];
    const rows = titles.map((title,i)=>({id:'task-'+i,title,projectId:'demo-project',
      conversationId:'chat-'+i,chatIds:['chat-'+i],startedAt:1,updatedAt:100-i,endedAt:2,events:0,userMessages:0,
      toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,
      estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:null,agents:[],origin:null}));
    rows.push({...rows[0],id:'other-task',title:'Docs chat',projectId:'second-project',conversationId:'chat-x',chatIds:['chat-x'],updatedAt:10});
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
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,...iconFiles]}}, plugins:[{ name:'chat-groups-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request,response) => {
        const source = withoutScripts(fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8')).replace('</body>', '<script type="module">'+fixture+'</script></body>');
        response.setHeader('Content-Type','text/html'); response.end(await vite.transformIndexHtml('/fixture.html',source));
      });
    }}] });
  let win;
  try {
    await server.listen(); fs.mkdirSync(output,{recursive:true});
    win = new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,backgroundThrottling:false}});
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
    };
    const groupsOf = `[...document.querySelectorAll('[data-project-id="demo-project"] > .chat-group')].map(g=>[g.querySelector('.chat-group-name').textContent,g.querySelector('.chat-group-count').textContent,[...g.querySelectorAll(':scope > .sess')].map(r=>r.dataset.id)])`;
    const loose = `[...document.querySelectorAll('[data-project-id="demo-project"] > .sess')].map(r=>r.dataset.id)`;
    const press = keyCode => { for (const type of ['keyDown','char','keyUp']) if (type!=='char'||keyCode==='Enter') win.webContents.sendInputEvent({type,keyCode:type==='char'?'\r':keyCode}); };
    const menuItems = `[...document.querySelectorAll('.row-menu')].at(-1) ? [...[...document.querySelectorAll('.row-menu')].at(-1).querySelectorAll('[data-row-action]')].map(i=>i.dataset.rowAction) : []`;

    await load('?reset=1');
    // Groups lead the project's list, in their order, with their own chats; the rest follow ungrouped.
    assert.deepEqual(await js(groupsOf), [['Spanish','2',['task-0','task-1']],['Italian','0',[]]]);
    // The project's own list pages as before: five chats, then "Show more" for the rest.
    assert.deepEqual(await js(loose), ['task-2','task-3','task-4','task-5','task-6']);
    assert.equal(await js(`!!document.querySelector('[data-project-id="demo-project"] > .project-show-more')`), true);
    assert.equal(await js(`document.querySelector('[data-group-id="g-italian"] .chat-group-empty')?.textContent`), 'Move a chat here from its menu.');
    // The other project's chat is untouched, and a group never shows outside its project.
    assert.equal(await js(`document.querySelectorAll('[data-project-id="second-project"] .chat-group').length`), 0);
    // A group's chats sit one step further in than the project's own chats.
    const indent = await js(`(() => { const grouped=document.querySelector('[data-group-id="g-spanish"] > .sess').getBoundingClientRect().left; const plain=document.querySelector('[data-project-id="demo-project"] > .sess').getBoundingClientRect().left; return Math.round(grouped-plain); })()`);
    assert.ok(indent >= 20 && indent <= 30, 'grouped chats are indented one step: ' + indent);
    // A grouped chat's title starts under its group's name, and the group's icon is drawn.
    const titles = await js(`(() => { const name=document.querySelector('[data-group-id="g-spanish"] .chat-group-name').getBoundingClientRect().left; const chat=document.querySelector('[data-group-id="g-spanish"] > .sess .sess-top b').getBoundingClientRect().left; const glyph=getComputedStyle(document.querySelector('[data-group-id="g-spanish"] > summary > .ico'),'::before').content; return {offset:Math.round(chat-name), glyph}; })()`);
    assert.equal(Math.abs(titles.offset) <= 1, true, 'grouped chat titles align with the group name: ' + titles.offset);
    assert.notEqual(titles.glyph, 'none', 'the group icon has a glyph');
    await screenshot('groups-open.png');

    // The count gives way to the menu on hover, in the chats' "⋯" column.
    const heading = await js(`(() => { const r=document.querySelector('[data-group-id="g-spanish"] > summary').getBoundingClientRect(); return {x:Math.round(r.left+40),y:Math.round(r.top+r.height/2)}; })()`);
    win.webContents.sendInputEvent({type:'mouseMove',...heading});
    await until(`getComputedStyle(document.querySelector('[data-group-id="g-spanish"] .chat-group-menu')).display === 'grid'`, 'menu shows on hover');
    assert.equal(await js(`getComputedStyle(document.querySelector('[data-group-id="g-spanish"] .chat-group-count')).display`), 'none');
    const columns = await js(`(() => { const menu=document.querySelector('[data-group-id="g-spanish"] .chat-group-menu').getBoundingClientRect(); const chat=document.querySelector('[data-group-id="g-spanish"] > .sess .sess-menu')?.getBoundingClientRect(); return {menu:Math.round(menu.right), chat: chat ? Math.round(chat.right) : null}; })()`);
    await js(`document.querySelector('[data-group-id="g-spanish"] .chat-group-menu').click()`);
    await until(`document.querySelectorAll('.row-menu').length === 1`, 'group menu opens');
    assert.deepEqual(await js(menuItems), ['rename','delete']);
    await screenshot('group-menu.png');

    // Rename through the in-app dialog: an empty name is refused with the reason, then a real one lands.
    await js(`document.querySelector('.row-menu [data-row-action="rename"]').click()`);
    await until(`!!document.querySelector('.file-entry-dialog[open] input')`, 'rename dialog');
    assert.equal(await js(`document.querySelector('.file-entry-dialog input').value`), 'Spanish');
    assert.equal(await js(`document.querySelector('.file-entry-dialog h2').textContent`), 'Rename group');
    await js(`(() => { const i=document.querySelector('.file-entry-dialog input'); i.value='   '; i.form.requestSubmit(); })()`);
    assert.equal(await js(`document.querySelector('.file-entry-dialog input').validationMessage`), 'A group name needs 1 to 60 characters');
    await screenshot('rename-refused.png');
    await js(`(() => { const i=document.querySelector('.file-entry-dialog input'); i.value='  Español  '; i.dispatchEvent(new Event('input')); i.form.requestSubmit(); })()`);
    await until(`document.querySelector('[data-group-id="g-spanish"] .chat-group-name').textContent === 'Español'`, 'renamed');
    assert.equal(await js(`!!document.querySelector('.file-entry-dialog')`), false);
    // Cancel changes nothing and sends nothing.
    const calls = await js(`window.groupCalls.length`);
    await js(`document.querySelector('[data-group-id="g-spanish"] .chat-group-menu').click()`);
    await until(`!!document.querySelector('.row-menu [data-row-action="rename"]')`, 'menu again');
    await js(`document.querySelector('.row-menu [data-row-action="rename"]').click()`);
    await until(`!!document.querySelector('.file-entry-dialog[open]')`, 'dialog again');
    await js(`[...document.querySelectorAll('.file-entry-dialog button')].find(b=>b.textContent==='Cancel').click()`);
    await until(`!document.querySelector('.file-entry-dialog')`, 'dialog closed');
    assert.equal(await js(`window.groupCalls.length`), calls);

    // Move a chat into a group from its menu; the submenu lists only this project's groups.
    await js(`document.querySelector('[data-id="task-2"] .sess-menu').click()`);
    await until(`!!document.querySelector('.row-menu [data-row-action="move-to-group"]')`, 'chat menu has Move to group');
    assert.equal(await js(`!!document.querySelector('.row-menu [data-row-action="remove-from-group"]')`), false, 'an ungrouped chat has nothing to leave');
    await js(`document.querySelector('.row-menu [data-row-action="move-to-group"]').focus()`);
    press('Right');
    await until(`document.querySelectorAll('.row-menu').length === 2`, 'group submenu');
    assert.deepEqual(await js(menuItems), ['group-g-spanish','group-g-italian','group-new']);
    assert.deepEqual(await js(`[...document.querySelectorAll('.row-menu')].map(m=>{const r=m.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})`), [true,true], 'menu and submenu fit');
    await screenshot('move-to-group.png');
    await js(`[...document.querySelectorAll('.row-menu')].at(-1).querySelector('[data-row-action="group-g-italian"]').click()`);
    await until(`document.querySelector('[data-group-id="g-italian"] .chat-group-count').textContent === '1'`, 'moved into Italian');
    assert.deepEqual(await js(groupsOf), [['Español','2',['task-0','task-1']],['Italian','1',['task-2']]]);
    assert.equal(await js(`!!document.querySelector('[data-group-id="g-italian"] .chat-group-empty')`), false);

    // A grouped chat's menu offers to leave the group, which returns it to the project's own list.
    await js(`document.querySelector('[data-id="task-0"] .sess-menu').click()`);
    await until(`!!document.querySelector('.row-menu [data-row-action="remove-from-group"]')`, 'remove from group offered');
    await js(`document.querySelector('.row-menu [data-row-action="remove-from-group"]').click()`);
    await until(`!document.querySelector('[data-group-id="g-spanish"] [data-id="task-0"]')`, 'removed from group');
    assert.equal(await js(`(${loose}).includes('task-0')`), true);

    // A collapsed group stays open while it holds the open chat.
    await js(`document.querySelector('[data-id="task-1"] .sess-top').click()`);
    await until(`document.querySelector('.sess.is-sel')?.dataset.id === 'task-1'`, 'task-1 selected');
    await js(`document.querySelector('[data-group-id="g-spanish"] > summary').click()`);
    await new Promise(r=>setTimeout(r,100));
    assert.equal(await js(`document.querySelector('[data-group-id="g-spanish"]').open`), true, 'the open chat stays visible');
    await js(`document.querySelector('[data-id="task-3"] .sess-top').click()`);
    await until(`document.querySelector('.sess.is-sel')?.dataset.id === 'task-3'`, 'task-3 selected');
    await until(`document.querySelector('[data-group-id="g-spanish"]').open === false`, 'closes once its chat is no longer open');
    await js(`document.querySelector('[data-group-id="g-spanish"] > summary').click()`);
    await until(`document.querySelector('[data-group-id="g-spanish"]').open === true`, 'opens again');

    // Groups order like projects: Alt+Down on a group heading, kept across a reload.
    await js(`document.querySelector('[data-group-id="g-spanish"] > summary').focus()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Down',modifiers:['alt']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Down',modifiers:['alt']});
    await until(`(${groupsOf})[0][0] === 'Italian'`, 'group moved down');
    assert.equal(await js(`document.activeElement === document.querySelector('[data-group-id="g-spanish"] > summary')`), true, 'focus stays on the moved group');

    // A new group from the project menu opens empty, and a long name ends in an ellipsis inside the sidebar.
    await js(`document.querySelector('[data-project-id="demo-project"] .project-menu').click()`);
    await until(`!!document.querySelector('.row-menu [data-row-action="group-new"]')`, 'project menu has New group');
    await js(`document.querySelector('.row-menu [data-row-action="group-new"]').click()`);
    await until(`!!document.querySelector('.file-entry-dialog[open]')`, 'new group dialog');
    assert.equal(await js(`document.querySelector('.file-entry-dialog h2').textContent`), 'New group');
    const long = 'A very long group name that keeps going past the sidebar edge';
    // The name is spelled out in the page code itself: nothing from outside is spliced into code.
    await js(`(() => { const i=document.querySelector('.file-entry-dialog input'); i.value='A very long group name that keeps going past the sidebar edge'.slice(0,60); i.form.requestSubmit(); })()`);
    await until(`document.querySelectorAll('[data-project-id="demo-project"] > .chat-group').length === 3`, 'created');
    // A new group leads its project's groups, like any new item in this sidebar.
    assert.equal(await js(`document.querySelector('[data-project-id="demo-project"] > .chat-group .chat-group-name').textContent`), long.slice(0,60));
    const fit = await js(`(() => { const g=document.querySelector('[data-project-id="demo-project"] > .chat-group'); const n=g.querySelector('.chat-group-name'); const side=document.querySelector('.sidebar').getBoundingClientRect(); const h=g.querySelector('summary').getBoundingClientRect(); return {open:g.open, clipped:n.scrollWidth>n.clientWidth, inside:h.right<=side.right+0.5, empty:!!g.querySelector('.chat-group-empty')}; })()`);
    assert.deepEqual(fit, {open:true, clipped:true, inside:true, empty:true});
    await screenshot('new-long-group.png');

    // Deleting a group keeps its chats in the project, ungrouped.
    await js(`document.querySelector('[data-group-id="g-italian"] .chat-group-menu').click()`);
    await until(`!!document.querySelector('.row-menu [data-row-action="delete"]')`, 'group menu');
    await js(`document.querySelector('.row-menu [data-row-action="delete"]').click()`);
    await until(`!document.querySelector('[data-group-id="g-italian"]')`, 'deleted');
    assert.equal(await js(`(${loose}).includes('task-2')`), true, 'its chat returns to the project list');
    assert.equal(await js(`document.querySelector('.toast')?.textContent ?? ''`), 'Group deleted. Its chats stay in the project.');
    await screenshot('after-delete.png');

    // The fixture starts over on reload; the order the person gave the groups is kept (Alt+Down above).
    await load('?theme=light');
    assert.deepEqual((await js(groupsOf)).map(g=>g[0]), ['Italian', 'Spanish']);
    await screenshot('groups-light.png');
    console.log(JSON.stringify({groups:true,indent,columns,rename:true,cancel:true,move:true,remove:true,selectedStaysOpen:true,order:true,longName:fit,delete:true,output}));
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error=>{console.error(error);app.exit(1)});
